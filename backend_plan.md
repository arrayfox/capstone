# Backend Implementation Plan
## Capstone Project: Data Freshness Monitoring & Insights Agent

> Plan for the **backend layer** that sits on top of the completed data layer:
> detect violations, compute KPIs, and expose a REST API the frontend polls.
> The **LLM summary is ON HOLD** (no Gemini API key yet) — its endpoint is stubbed.
>
> References: [`data_generation_design.md`](data_generation_design.md),
> [`data_generation_plan.md`](data_generation_plan.md),
> [`data_schema_design.md`](data_schema_design.md).

---

## 0. Recommended decisions (locked)

Given the goals + time constraint, these are the choices this plan builds on. Each has a
one-line rationale; details are in the referenced section.

| # | Decision | Why (short) | Ref |
|---|---|---|---|
| R1 | **Separate `data/governance.db`** for `violations` + `audit_log` | one writer per DB file → **zero cross-process write contention** | §3, §6 |
| R2 | **Two processes**: `python -m synthetic_data` (writer) + `uvicorn` (API) | fits existing single-thread data layer with **zero changes**; lowest risk | §6 |
| R3 | **Single uvicorn worker** | avoids duplicate detector loops / double violation writes | §6 |
| R4 | **Lightweight background detector** (timer inside FastAPI) — not detect-on-read | gives violations **stable IDs** for the audit trail; still ~one function | §4 |
| R5 | **Reuse `import synthetic_data.config`** for DB paths; **run both from project root** | identical paths, no duplication, no drift | §6 |
| R6 | **Dashboard pages = filter params on GET** (`WHERE` + `limit`/`offset`) | filtered logs / violations / audit are **not new subsystems** | §3 |
| R7 | **Cross-DB category filter via SQLite `ATTACH`** | join `monitor.db` runs to `pipeline_config` category cleanly | §3 |
| R8 | **REST + polling** (no SSE/WebSocket); refresh ~`POLL_SECONDS` (5s) | simplest live-enough feed; self-healing | §5 |
| R9 | **LLM report endpoint stubbed** (`/report`) until a Gemini key exists | unblocks the whole backend now | §2, §7 |

> Deferred alternative (post-deadline): fold the simulator into FastAPI `lifespan` as a
> background thread for a **single-command** launch. Not now — 2 processes is lower-risk.

---

## 1. Where we are


```
✅ DATA LAYER (done)
  synthetic_data/  → writes to  data/monitor.db          (pipeline_executions, 11 cols)
                                 data/pipeline_config.db  (pipeline_config, 7 rows, 8 cols)
  run:  python -m synthetic_data   (backfill 30d, then live compressed-time feed)
```

The generator emits only **raw facts**. Everything "smart" — detecting problems,
computing KPIs, serving the UI — is the backend, built next.

### Existing schema (for reference)
- `pipeline_config`: `pipeline_name(PK), pipeline_category, criticality, owner_team,
  schedule_interval_minutes, sla_minutes, freshness_threshold_hours, description`
- `pipeline_executions`: `run_id(PK), pipeline_name, scheduled_time, actual_start_time,
  end_time, status, rows_processed, error_code, error_message, duration_minutes, run_date`
- **WAL** enabled → writer never blocks readers (safe concurrent read/write).

---

## 2. What the backend adds (the gap)

| Piece | Purpose | LLM? |
|---|---|---|
| **`violations` + `audit_log` tables** | store detected problems + human actions | no |
| **Detection engine** | scan executions → find the 6 violation types → write `violations` | no |
| **KPI queries** | aggregate health / SLA / freshness / failure numbers | no |
| **FastAPI app** | REST endpoints the frontend calls | no |
| **Review + audit** | approve / dismiss / escalate a violation → log to `audit_log` | no |
| **LLM summary** | natural-language incident report | ⏸️ **ON HOLD** (stub endpoint) |

So the backend = **detection + KPIs + API + review**, LLM stubbed until a key exists.

---

## 3. Backend structure

```
backend/
├── main.py          # FastAPI app: CORS, routers, startup lifespan (detector loop)
├── database.py      # OWN read connections to both DBs (WAL, per-request/thread)
│                    #   — separate from synthetic_data/db.py to keep processes decoupled
├── detection.py     # the "agent" core: 6 rules → upsert into violations
├── kpis.py          # aggregate SELECTs → KPI dict
├── models.py        # Pydantic request/response shapes
└── routers/
    ├── pipelines.py   # GET /pipelines(+filters), GET /pipelines/{name}
    ├── runs.py        # GET /runs(+filters), GET /runs/recent
    ├── kpis.py        # GET /kpis
    ├── violations.py  # GET /violations(+filters), POST /violations/{id}/review
    ├── audit.py       # GET /audit(+filters)
    └── report.py      # GET /report/{...}  → STUB now (LLM later)
```

### Full endpoint catalog (dashboard pages = filters on GET; actions = POST)
Filtering is just SQL `WHERE`; pagination is `limit`/`offset`. Filtering runs/violations
**by category** joins to `pipeline_config` via SQLite `ATTACH` (or a small in-memory lookup).

| Page / action | Endpoint | Filters (query params) |
|---|---|---|
| Pipeline list | `GET /pipelines` | `?category=&criticality=` |
| Pipeline detail | `GET /pipelines/{name}` | — |
| **Filtered run logs** | `GET /runs` | `?pipeline=&category=&status=&date_from=&date_to=&limit=&offset=` |
| Live runs table | `GET /runs/recent` | `?limit=` |
| Dashboard cards | `GET /kpis` | `?window=7d` |
| **Filtered violations** | `GET /violations` | `?pipeline=&category=&type=&severity=&status=&date_from=&date_to=` |
| **Review action** | `POST /violations/{id}/review` | body: `action, reviewed_by, note` → updates violation **+ writes `audit_log`** |
| **Audit-log page** | `GET /audit` | `?actor=&action=&entity=&date_from=&date_to=` |
| Report (stub) | `GET /report/{pipeline}` | — |

### Two new tables → in a **separate `data/governance.db`** (recommended)
Keeping these out of `monitor.db` means **each DB file has exactly one writer process**
(simulator → `monitor.db`; API → `governance.db`) → **zero cross-process write
contention** (see §6). The API still *reads* `monitor.db` concurrently under WAL.

- **`violations`**: `id(PK), pipeline_name, run_id, violation_type, severity,
  detected_at, details, status(open/reviewed/dismissed/escalated),
  reviewed_by, reviewed_at, note`
  - dedupe on `(run_id, violation_type)` so a re-scan doesn't duplicate.
- **`audit_log`**: `id(PK), timestamp, actor, action, entity_type, entity_id, details`
  - **exempt from pruning** (governance / compliance trail; tiny).


---

## 4. Backend workflow — two loops + a request path

```
 (1) WRITER — the simulator (separate process)
     python -m synthetic_data ──INSERT──► monitor.db (pipeline_executions)

 (2) DETECTOR — periodic loop inside FastAPI (every few seconds)
     scan newest executions ──apply 6 rules──► INSERT/UPDATE violations
                                   ▲
 (3) API — on each frontend request:                │ (reads executions,
     GET /kpis        ─ aggregate SELECTs ───────────┤  config, violations
     GET /runs/recent ─ SELECT newest rows           │  concurrently — WAL)
     GET /violations  ─ SELECT open violations        │
     POST /violations/{id}/review ─ UPDATE + INSERT audit_log
                              │
                              ▼
                         JSON response ──► Frontend
```

- **WAL** makes it safe: simulator writes, API reads, detector writes violations — no blocking.
- The **detector is the non-LLM "agent"** — pure rules over the data.

### The 6 detection rules (map 1:1 to injected anomalies)
| Violation | Rule (over `pipeline_executions` + `pipeline_config`) |
|---|---|
| `SLA_BREACH` | `duration_minutes > sla_minutes` |
| `DELAYED_START` | `actual_start_time − scheduled_time` > threshold |
| `VOLUME_ANOMALY` | `rows_processed` outside `mean ± k·std` of last N runs (learned) |
| `MISSING_LOAD` | a scheduled slot has no row within its window |
| `FAILURE` / `RECURRING_FAILURE` | `status='FAILED'` (recurring if ≥N in window, same error) |
| `FRESHNESS` | latest SUCCESS older than `freshness_threshold_hours` |

### KPIs (simple aggregates)
- overall health %, SLA-compliance %, failure rate,
- # pipelines with open violations, freshness status, avg-duration trend.

---

## 5. How it connects to the frontend

**REST + polling** (the model locked in the design doc — no SSE/WebSocket).

- Frontend re-fetches every `POLL_SECONDS` (5s) via `setInterval` for `/kpis` and
  `/runs/recent`; other calls (history, violations) on demand.
- **CORS**: `main.py` adds `CORSMiddleware` allowing the frontend origin
  (e.g. `http://localhost:5173`).
- **Contract**: Pydantic models define JSON shapes; FastAPI auto-docs at `/docs`
  serve as the frontend's API reference.
- **Actions** (approve/dismiss/escalate) are `POST`s → update `violations` + append `audit_log`.

```
 Frontend (:5173)  ──poll every 5s──►  FastAPI (:8000)  ──►  SQLite (WAL)
   dashboard cards   GET /kpis
   live runs table   GET /runs/recent
   violations panel  GET /violations
   review buttons    POST /violations/{id}/review
```

---

## 6. How to start / run the server (processes, directory, GIL)

### Same project root — `synthetic_data/` and `backend/` are siblings
```
/home/flux/Documents/capstone_project/          ← RUN BOTH COMMANDS FROM HERE
├── synthetic_data/         ← data layer (writer)
├── backend/                ← API layer (reader + detector)
└── data/                   ← monitor.db + pipeline_config.db + governance.db  (shared)
```
`config.py` uses **relative** DB paths (`"data/monitor.db"`), so both processes must be
launched from the project root or they'd hit different files. The backend simply
`import synthetic_data.config` to reuse the **exact same paths** — no duplication.
*(If launching-from-root is ever a risk, switch config to absolute paths — 1-line change.)*

### How many processes? → **2** (plus the frontend dev server later)
```
Process 1:  python -m synthetic_data      → writes monitor.db            (the writer)
Process 2:  uvicorn backend.main:app      → serves API + runs detector   (single worker)
            ├─ async event loop  → handles all HTTP requests (I/O-bound SELECTs)
            └─ 1 background task  → detector, every few seconds → writes governance.db
```
Run **one uvicorn worker** (default): multiple workers = multiple detector loops =
duplicated violation writes. One worker is both correct and simpler here.

### Does Python's GIL cause conflicts? → No, at this scale
- **Across the 2 processes:** the GIL is **irrelevant** — separate interpreters, separate
  GILs, true OS-level parallelism. They meet only at the **database**, handled by
  **WAL + `busy_timeout`** (writer never blocks readers).
- **Inside the API process:** the GIL applies but doesn't hurt — the work is
  **I/O-bound**, and Python's `sqlite3` **releases the GIL during the C-level DB calls**,
  so request `SELECT`s and the detector interleave freely. Requests are milliseconds; the
  detector runs briefly every few seconds.

### The one real conflict — designed out via `governance.db`
Two *writers* to the **same file** serialize on WAL's single-writer lock. So we split by
writer, one file per writer:
- `monitor.db`     → written **only** by the simulator; **read** by the API (WAL, no conflict).
- `governance.db`  → written **only** by the API (detector + reviews).
- `pipeline_config.db` → seeded once, effectively read-only thereafter.

Result: **no cross-process write contention at all**, GIL a non-issue.

### Commands
```bash
# 0) one-time deps
pip install fastapi "uvicorn[standard]" pydantic

# 1) Terminal A (from /home/flux/Documents/capstone_project) — keep generating data (writer)
python -m synthetic_data

# 2) Terminal B (from /home/flux/Documents/capstone_project) — run the API (readers + detector)
uvicorn backend.main:app --reload --port 8000
#   → API at   http://localhost:8000
#   → docs at  http://localhost:8000/docs   ← test everything here first

# 3) later — Terminal C — frontend dev server
#   npm run dev   → http://localhost:5173  (calls the API on :8000)
```
- `--reload` = auto-restart on code changes (dev).
- Verify the whole backend with **just `/docs`** — no frontend needed yet.
- *Alternative (later):* fold the simulator into FastAPI's `lifespan` as a background
  thread for a single-command launch. Kept as 2 processes now to fit existing code with
  zero changes — and it's the lower-risk choice when short on time.


---

## 7. Suggested build order

1. `violations` + `audit_log` tables + `backend/database.py` (read connections).
2. `detection.py` — the 6 rules → populate `violations`.
3. `kpis.py` — aggregate queries.
4. `main.py` + routers — expose `/pipelines`, `/runs`, `/kpis`, `/violations`.
5. Review + `audit_log` wiring (`POST /violations/{id}/review`).
6. `/report` **stub** (placeholder JSON; swap in Gemini later).
7. Test via `/docs`, then move to the frontend.

---

## 8. Out of scope (this phase)

- Gemini / LLM natural-language reports (endpoint stubbed; wired later with a key).
- The frontend itself (separate phase; this API is designed to feed it).
- Auth / multi-user (single-user demo assumed).
