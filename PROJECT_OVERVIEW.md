# Project Overview — Data Freshness Monitoring & Insights Agent

> A single, comprehensive walkthrough of the whole capstone project: what it does,
> how it is built, the data model, the architecture, and how the pieces fit
> together. This document is derived directly from the code and the shipped
> databases, and is meant as the one-stop map of the repository.
>
> Companion design docs (deeper dives into individual decisions):
> [`project_details.md`](project_details.md) · [`data_schema_design.md`](data_schema_design.md) ·
> [`pipeline_catalog.md`](pipeline_catalog.md) · [`data_generation_design.md`](data_generation_design.md) ·
> [`data_generation_plan.md`](data_generation_plan.md) · [`backend_plan.md`](backend_plan.md) ·
> [`README.md`](README.md) · [`backend/README.md`](backend/README.md)

---

## 1. What this project is

A **data-pipeline governance dashboard** for a fictional pharma commercial-analytics
data platform. It continuously watches a fleet of **7 data pipelines**, detects
**freshness / SLA / operational violations**, computes **health KPIs**, and presents
everything in a live, filterable **web dashboard** with a **human-in-the-loop review
workflow** and an immutable **audit trail**.

The end-goal (per [`project_details.md`](project_details.md)) is an *AI-powered Data
Freshness Monitoring Agent* that proactively surfaces data-delivery risk for DataOps
teams and eventually produces natural-language executive summaries. Today the
**detection agent is rule-based** and the **LLM-summary layer is intentionally stubbed**
(no Gemini key yet) — everything around it is fully implemented.

### The business problem it models
Organizations only notice stale/failed data loads *after* business users complain.
Traditional monitoring is manual log-reading. This project simulates that world and
builds the intelligent monitoring layer on top of it: detect problems early, quantify
fleet health, and give humans a governed workflow to act on findings.

---

## 2. High-level architecture

Three independent components communicate **only through SQLite files** (the single
source of truth) and one **REST API**. There is no message bus, no SSE/WebSocket —
just writes to SQLite and HTTP polling.

```
┌─────────────────────────┐        ┌──────────────────────────────┐        ┌────────────────────────┐
│  synthetic_data/         │        │  backend/  (FastAPI)          │        │  frontend/  (React+Vite)│
│  "the world"             │        │  "the agent + API"            │        │  "the dashboard"        │
│                          │ writes │                               │  HTTP  │                         │
│  simulates 7 pipelines,  │───────▶│  • detects 7 violation types  │◀──────▶│  polls every ~5s,       │
│  emits raw run logs      │        │  • computes KPIs / trends     │  poll  │  renders KPIs, charts,  │
│                          │        │  • REST endpoints             │        │  tables, review UI      │
│  (stdlib only)           │        │  • review → audit trail       │        │                         │
└───────────┬──────────────┘        └───────┬───────────────┬───────┘        └────────────────────────┘
            │ writes                          │ reads          │ writes
            ▼                                 ▼                ▼
   ┌──────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐
   │ monitor.db       │   │ pipeline_config.db     │   │ governance.db          │
   │ pipeline_        │   │ pipeline_config        │   │ violations + audit_log │
   │ executions       │   │ (7 static rows)        │   │ (owned by the backend) │
   │ (high-churn log) │   │                        │   │                        │
   └──────────────────┘   └────────────────────────┘   └────────────────────────┘
        writer: simulator       writer: simulator (seed)      writer: backend only
        reader: backend         reader: backend               reader: backend
```

### The key architectural rule: one writer per database file
This is the load-bearing design decision (see [`backend_plan.md`](backend_plan.md) §6).
Splitting storage into **three SQLite files** guarantees each file has exactly **one
writer process**, which eliminates cross-process write contention entirely:

| DB file | Table(s) | Written by | Read by |
|---|---|---|---|
| `data/monitor.db` | `pipeline_executions` | **simulator only** | backend |
| `data/pipeline_config.db` | `pipeline_config` | **simulator only** (seeded once) | backend |
| `data/governance.db` | `violations`, `audit_log` | **backend only** | backend |

All connections use **SQLite WAL mode** (`journal_mode=WAL`, `busy_timeout=5000`,
`synchronous=NORMAL`) so a writer never blocks readers. The backend opens
`governance.db` and `ATTACH`es the other two read-only, so a **single SQL query can
join across all three files** (e.g. filter runs by the category that lives in
`pipeline_config`).

### Processes at runtime
```
Process 1:  python -m synthetic_data     → writes monitor.db          (the data generator/writer)
Process 2:  uvicorn backend.main:app     → serves REST + runs detector (single worker)
Process 3:  npm run dev  (Vite)          → serves the dashboard on :5173
```

### Technology stack
| Layer | Tech |
|---|---|
| Data generator | **Python 3.11+ standard library only** (`sqlite3`, `random`, `datetime`) |
| Backend API | **FastAPI**, **Uvicorn**, **Pydantic v2**, stdlib `sqlite3` |
| Storage | **SQLite** (3 files, WAL mode) |
| Frontend | **React 19** + **TypeScript** + **Vite 6** |
| Data fetching | **TanStack Query v5** (polling) |
| State | **Zustand** (global filters + UI) |
| Charts | **Recharts** |
| Routing | **React Router v7** |
| Icons | **lucide-react** |

---

## 3. Component 1 — Synthetic data generator (`synthetic_data/`)

The generator is "the world": it fabricates realistic pipeline-execution history and
then streams new runs live. It emits **only raw facts** — anything derivable or
learnable is left for the backend agent to compute. It is deliberately dependency-free
(standard library only).

### Module layout
| File | Responsibility |
|---|---|
| `config.py` | Every tunable knob: anomaly rates, magnitudes, clock/backfill/retention params, DB paths, RNG seed |
| `catalog.py` | The 7-pipeline fleet: DB-visible config **+** generator-only params, weighted error pools, error messages |
| `db.py` | Opens both DBs (WAL), holds the DDL, `seed_config()`, `insert_run()` (derives fields), `prune_old()`, `reset_executions()` |
| `generator.py` | `generate_run(...)` — a **pure function** that samples one realistic run |
| `simulator.py` | The schedule-driven **simulated clock**: backfill phase + live phase + pruning |
| `__main__.py` | Entry point (`python -m synthetic_data`): init → seed → reset → backfill → go live |

### The two-layer randomness model
Every run is sampled from probability distributions at runtime (nothing is hardcoded),
using **two separate layers** so ordinary noise never masquerades as a real incident:

```
                generate_run(pipeline, scheduled_time, last_status, last_error)
                                     │
        ┌────────────────────────────┴────────────────────────────┐
  LAYER 1: NORMAL WOBBLE (always on)          LAYER 2: ANOMALY ROLLS (rare, injected)
  duration ~ Normal(mean, std)                fail? slow? volume dip/spike? delayed start? skip?
  rows     ~ Normal(mean, std)                each probability × pipeline.fragility
  start jitter ~ small Normal(2, 2)           → these produce the violations to detect
```

- **Layer 1** gives each healthy run slight, realistic variation (tight spread, clamped
  to ±3σ with a sane floor).
- **Layer 2** injects the anomalies the agent must catch. Crucially, normal duration
  always sits **under** the SLA (positive "SLA headroom"), so an ordinary run never
  breaches SLA by itself — only an injected slow run does. This keeps detection signals
  clean and explainable.

### Anomaly injection (`config.py` knobs, `generator.py` logic)
| Roll | Base prob | Effect | Violation it creates |
|---|---|---|---|
| Fail? | `BASE_FAIL_RATE` 5% | `status=FAILED`, weighted error code, ~0 rows, partial duration | `FAILURE` / `RECURRING_FAILURE` |
| Slow run? | `SLOW_RUN_PROB` 8% | `duration ×= Uniform(1.8, 3.5)` | `SLA_BREACH` |
| Volume anomaly? | `VOLUME_ANOMALY_PROB` 5% | dip `×(0.2–0.4)` or spike `×(2.0–3.0)` | `VOLUME_ANOMALY` |
| Delayed start? | `DELAYED_START_PROB` 10% | start jitter `= Uniform(30, 120)` min | `DELAYED_START` |
| Skip run? | `MISSING_LOAD_PROB` 2% | scheduler emits nothing this cycle | `MISSING_LOAD` |

Each base rate is multiplied by the pipeline's **`fragility`** — a per-pipeline
"personality" multiplier. A flaky marketing ETL (`fragility=1.5`) racks up ~2× the
incidents of a tightly-controlled compliance pipeline (`fragility=0.7`), *consistently*,
giving the agent a genuine per-pipeline pattern to surface.

### Failure clustering (makes recurring failures emerge naturally)
Real outages last several runs and share one root cause, so failures aren't independent:

```
if previous run FAILED:
    p_fail = CLUSTER_FAIL_PROB (0.50)      # outage persists
    error_code = previous run's error_code  # SAME code (one root cause)
else:
    p_fail = BASE_FAIL_RATE × fragility
    error_code = weighted_draw(category pool)  # fresh, biased draw
```

Error codes are drawn from the pipeline's **own category pool** with realistic weights
(e.g. Claims fails mostly with `FILE_NOT_FOUND`), so `RECURRING_FAILURE` ("failed 4× this
week with `DB_TIMEOUT`") arises organically instead of being scripted.

### Two phases: backfill then live (`simulator.py`)
1. **Backfill (instant):** set the sim-clock to `now − BACKFILL_DAYS` (30) and walk it to
   `now` with no waiting, bulk-inserting every due run. This seeds instant history — the
   agent needs it immediately for volume baselines (~20+ runs each) and 7d/30d trends.
   The shipped DB holds **~1,017 runs** across the fleet this way.
2. **Live (compressed real-time):** advance the clock by `TIME_COMPRESSION` sim-seconds
   every `TICK_SECONDS`. Shipped default is **3600×** (1 real second ≈ 1 simulated hour),
   so new runs trickle in fast enough that the dashboard visibly moves on each poll.

Each session calls `reset_executions()` first, so re-running doesn't stack overlapping
backfills (which would double runs/day and break cadence). The static config DB is left
intact and idempotently re-seeded.

### Retention
Once per **simulated day**, `prune_old()` deletes executions older than
`RETENTION_DAYS` (60), keeping the DB bounded. `RETENTION_DAYS` is deliberately ≥ the
longest analysis window (30-day trends) so pruning never breaks detection. The
`audit_log` is **exempt** — it is the compliance trail and must persist.

---

## 4. Component 2 — Backend API & detection agent (`backend/`)

The backend is the "smart" layer: it turns raw runs into violations, computes health
metrics, and exposes the REST surface the dashboard polls. It **never writes**
`monitor.db` / `pipeline_config.db`; it **owns and writes** `governance.db`.

### Module layout
| File | Responsibility |
|---|---|
| `database.py` | Connections; creates `governance.db`; `ATTACH`es monitor + config read-only; write helpers (`upsert_violation`, `record_audit`) |
| `detection.py` | The rule-based **agent**: 7 checks → deduped `violations` |
| `kpis.py` | Read-only aggregate SELECTs: headline KPIs, per-pipeline health, trends, violation stats |
| `main.py` | FastAPI app: all endpoints, CORS, review→audit, `/report` stub, background detector loop |

### The detection agent — 7 rules (`detection.py`)
The detector is the **non-LLM "agent"**: pure rules over the data. Each check maps 1:1 to
an injected anomaly. Every violation carries a deterministic **`dedupe_key`** so re-scans
are idempotent (`INSERT OR IGNORE` on a UNIQUE key). Thresholds are tunable at the top of
the module.

| # | Violation type | Rule | Notes |
|---|---|---|---|
| 1 | `SLA_BREACH` | `duration_minutes > sla_minutes` | one per breaching run |
| 2 | `DELAYED_START` | `actual_start − scheduled > 15 min` | normal jitter is ~2 min |
| 3 | `VOLUME_ANOMALY` | `rows` outside `mean ± 3·std` of last N successful runs | **baseline LEARNED from history**, not read from config; needs ≥8 priors |
| 4 | `FAILURE` | `status = 'FAILED'` | one per failed run |
| 5 | `RECURRING_FAILURE` | ≥3 failures for a pipeline within a rolling 7-day window | rolled up to one violation citing the dominant error code |
| 6 | `MISSING_LOAD` | a gap between consecutive scheduled runs > `interval × 1.5` | enumerates each skipped slot; `run_id` is NULL |
| 7 | `FRESHNESS` | newest successful load older than `freshness_threshold_hours` | `run_id` is NULL |

**"Data now" is a high-water mark, not wall-clock.** For absence/staleness checks
(`MISSING_LOAD`, `FRESHNESS`) and for the KPI window, "now" is the newest
`scheduled_time` in the dataset. This makes results sensible even when the simulator is
paused (a static DB doesn't suddenly look infinitely stale).

**Severity** starts from a per-type base (`_BASE_SEVERITY`) and is bumped **up** for
HIGH-criticality pipelines / **down** for LOW, across the ladder
`LOW < MEDIUM < HIGH < CRITICAL`.

### KPIs & analytics (`kpis.py`)
All pure read-only SELECTs, scoped to a rolling window (default 7 days) measured from
"data now":

- **`get_kpis()`** — headline cards: `total_runs`, `success_rate`, `failure_rate`,
  `sla_compliance`, **`health_score`** (share of in-window runs that were *clean* =
  SUCCESS **and** within SLA), `healthy_pipelines` vs `pipelines_with_issues`,
  `open_violations` (+ by severity).
- **`get_pipeline_health()`** — per-pipeline rollup: run/success/failure counts, SLA
  breaches, last-success freshness, open-violation count, `healthy|issues` status.
- **`get_trends()`** — daily time-series (successes/failures, SLA %, avg duration) with
  optional category/criticality/pipeline filters, for the charts.
- **`get_violation_stats()`** / **`get_violation_trends()`** — violation totals broken
  down by type & severity, plus a daily detection-count series for the Violations page.

### Background detector loop (`main.py`)
On startup (`lifespan`), the app creates `governance.db`, runs one detection pass, then
starts a **daemon thread** that re-scans every `DETECT_INTERVAL_SECONDS` (**1s**,
deliberately below the frontend's 5s poll) so violations are always ready before the next
dashboard fetch. A **single uvicorn worker** guarantees exactly one detector loop (no
duplicate violation writes). A full rescan of ~1k rows takes only a few ms, so the tight
loop is cheap. `POST /detect` forces an immediate scan.

**Live vs detected:** `/runs`, `/runs/recent`, `/kpis`, `/pipelines`, `/trends` are
computed **on-demand** from the DB (always as fresh as your poll). Only *violations* are
produced by the background detector.

### Human-in-the-loop review → audit
`POST /violations/{id}/review` with `{action: approve|dismiss|escalate, reviewed_by, note}`
updates the violation's status (`reviewed|dismissed|escalated`) **and** appends a row to
`audit_log` in the same operation. This is the governance workflow: every human decision
is recorded immutably.

### Full REST surface (`main.py`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (`{"status":"ok"}`) |
| GET | `/kpis?window_days=7` | headline dashboard cards |
| GET | `/trends?window_days=&category=&criticality=&pipeline=` | daily trend series |
| GET | `/pipelines?category=&criticality=&window_days=` | fleet + per-pipeline health |
| GET | `/pipelines/{name}?runs_limit=` | one pipeline: config + recent runs + open violations |
| GET | `/runs?pipeline=&category=&status=&date_from=&date_to=&limit=&offset=` | filtered execution log |
| GET | `/runs/recent?limit=` | newest runs across the fleet |
| GET | `/violations?pipeline=&category=&type=&severity=&status=&date_from=&date_to=&limit=&offset=` | filtered violations |
| GET | `/violations/stats?...` | violation totals by type & severity |
| GET | `/violations/trends?...` | daily violation-detection counts |
| POST | `/violations/{id}/review` | approve/dismiss/escalate → updates + audit |
| GET | `/audit?actor=&action=&entity=&date_from=&date_to=&limit=` | audit trail |
| POST | `/detect` | trigger a detection scan immediately |
| GET | `/report/{name}` | **STUB** — LLM summary on hold (no Gemini key) |

CORS allows the Vite dev origin (`http://localhost:5173`). Interactive docs at
`http://localhost:8000/docs`.

---

## 5. Component 3 — Frontend dashboard (`frontend/`)

A React + TypeScript SPA (Vite) that polls the REST API and renders the live dashboard.
It holds no business logic — it is a typed, reactive view over the backend.

### Structure
```
frontend/src/
├── App.tsx                 # route table
├── main.tsx                # React root + QueryClient provider
├── components/
│   ├── layout.tsx          # app shell: sidebar nav + sticky top bar (global filters, auto-refresh)
│   ├── charts.tsx          # Recharts wrappers (TrendLine, StatusStackedBar, ErrorPie, CountTrend, ...)
│   └── ui.tsx              # Card, Kpi, badges, Select, Skeletons, Empty/Error states
├── lib/
│   ├── api.ts              # typed fetch client (one request() wrapper, query-string builder)
│   ├── types.ts            # TS interfaces mirroring every backend payload
│   ├── hooks.ts            # TanStack Query hooks (+ review mutations w/ invalidation)
│   ├── store.ts            # Zustand: global filters + auto-refresh + sidebar
│   ├── constants.ts        # enum values driving dropdowns (categories, severities, ...)
│   └── format.ts           # number/date/percent formatting helpers
└── pages/
    ├── Overview.tsx        # landing: KPI strip + 2 trend charts + top-5 risky + recent violations
    ├── Pipelines.tsx       # sortable/filterable fleet list, each row → detail page
    ├── PipelineDetail.tsx  # one pipeline: KPIs, error donut, trends, runs, violations, config, report slot
    ├── Executions.tsx      # paginated run log; rows expand for config + error detail
    ├── Violations.tsx      # governance workspace: KPIs, charts, filterable table, batch review actions
    ├── Audit.tsx           # read-only compliance record of review actions
    └── NotFound.tsx        # 404
```

### How the frontend stays "live"
- **Global filters in Zustand** (`store.ts`): time-range window, category, criticality,
  status, plus auto-refresh on/off and cadence. Every query reads these, so changing one
  control in the top bar **re-scopes the entire dashboard at once**.
- **Polling via TanStack Query** (`hooks.ts`): each read hook subscribes to the shared
  poll interval (`usePollInterval()` → default 5s, or `false` when auto-refresh is off).
  At 3600× compressed sim-time, new runs land every few seconds, so the tables and charts
  visibly move.
- **Review invalidation:** a review mutation invalidates everything it touches
  (violations, violation-stats/trends, kpis, pipelines, pipeline detail, audit), so a
  single approve/dismiss/escalate ripples through the whole UI with no reload. A batch
  variant applies one action to many selected violations (one audit row each).
- **Typed contract:** `types.ts` mirrors the backend payloads field-for-field and
  `api.ts` funnels every call through one `request()` wrapper (uniform error handling,
  `"all"`/empty filter stripping). `API_BASE` defaults to `http://localhost:8000`,
  overridable via `VITE_API_BASE`.

### The deliberately-disabled AI slot
Both the Overview and Pipeline Detail pages render an **"AI insights — on hold"** banner
where the LLM report will go, and `useReport()` calls the stubbed `/report/{name}`. This
keeps the UI honest about the one deferred feature while everything else is functional.

---

## 6. Data model (the shipped databases)

Three SQLite files under `data/`. Verified contents of the shipped snapshot:
`pipeline_config` = **7 rows**; `pipeline_executions` = **1,017 runs** (907 SUCCESS /
110 FAILED).

### `pipeline_config.db` → `pipeline_config` (static reference, 8 fields)
The only fields the monitoring agent is allowed to read. Defines what "good" looks like.

| Field | Type | Meaning |
|---|---|---|
| `pipeline_name` | TEXT PK | join key to executions |
| `pipeline_category` | TEXT | CRM / Claims / Compliance / Sales / Patient / Marketing |
| `criticality` | TEXT | HIGH / MEDIUM / LOW → drives severity |
| `owner_team` | TEXT | who to notify |
| `schedule_interval_minutes` | INT | cadence → missing-load & freshness math |
| `sla_minutes` | INT | run must finish within N min of `scheduled_time` |
| `freshness_threshold_hours` | INT | max acceptable data age |
| `description` | TEXT | plain-English purpose (future LLM context) |

### `monitor.db` → `pipeline_executions` (high-churn run log, 9 emitted + 2 derived)
One row per pipeline run. The simulator emits 9 raw fields; `db.insert_run()` derives 2
more at ingest.

| Field | Type | Origin | Meaning |
|---|---|---|---|
| `run_id` | TEXT PK | emitted | `RUN_<ts>_<pipeline>` |
| `pipeline_name` | TEXT | emitted | join key |
| `scheduled_time` | TEXT | emitted | when it should have started |
| `actual_start_time` | TEXT | emitted | when it actually started → delayed-start signal |
| `end_time` | TEXT | emitted | finish moment (set even on FAILED; NULL only if RUNNING) |
| `status` | TEXT | emitted | SUCCESS / FAILED |
| `rows_processed` | INT | emitted | volume delivered → volume anomalies |
| `error_code` | TEXT | emitted | categorized error (NULL on success) |
| `error_message` | TEXT | emitted | free-text detail (NULL on success) |
| `duration_minutes` | REAL | **derived** | `end − actual_start` (NULL while RUNNING) |
| `run_date` | TEXT | **derived** | `date(scheduled_time)` for grouping |

Indexes: `(pipeline_name, scheduled_time)` and `(scheduled_time)`.

### `governance.db` → `violations` + `audit_log` (owned by the backend)
**`violations`** — append-only detected issues; only `status`/`reviewed_*`/`note` mutate
(via review).

| Field | Type | Meaning |
|---|---|---|
| `id` | INT PK | autoincrement |
| `dedupe_key` | TEXT UNIQUE | deterministic — makes re-scans idempotent |
| `pipeline_name` | TEXT | which pipeline |
| `run_id` | TEXT (nullable) | related run (NULL for MISSING_LOAD / FRESHNESS) |
| `violation_type` | TEXT | one of the 7 types |
| `severity` | TEXT | LOW / MEDIUM / HIGH / CRITICAL |
| `detected_at` | TEXT | when the agent flagged it |
| `details` | TEXT | human-readable description |
| `status` | TEXT | `open` / `reviewed` / `dismissed` / `escalated` |
| `reviewed_by`, `reviewed_at`, `note` | TEXT | human-in-the-loop fields |

**`audit_log`** — immutable "who did what, when" (never pruned).

| Field | Type | Meaning |
|---|---|---|
| `id` | INT PK | autoincrement |
| `timestamp` | TEXT | when |
| `actor` | TEXT | who (e.g. `analyst`) |
| `action` | TEXT | e.g. `review:approve` |
| `entity_type` | TEXT | e.g. `violation` |
| `entity_id` | TEXT | which entity |
| `details` | TEXT | summary of the change |

---

## 7. The 7-pipeline fleet (`catalog.py`)

Chosen for variety across category, cadence (hourly → daily), and criticality
(HIGH×4 / MEDIUM×2 / LOW×1).

| # | pipeline_name | category | crit. | interval | sla_min | fresh_hrs | fragility* |
|---|---|---|---|---|---|---|---|
| 1 | `hcp_prescriber_data_sync` | CRM | HIGH | daily | 120 | 24 | 1.2 |
| 2 | `rx_claims_daily_load` | Claims | HIGH | daily | 180 | 26 | 1.0 |
| 3 | `formulary_coverage_update` | Compliance | HIGH | 12h | 90 | 24 | 0.8 |
| 4 | `sample_distribution_compliance` | Compliance | HIGH | daily | 120 | 24 | 0.7 |
| 5 | `field_force_call_activity` | Sales | MEDIUM | hourly | 45 | 4 | 1.0 |
| 6 | `patient_adherence_refresh` | Patient | MEDIUM | daily | 150 | 24 | 1.1 |
| 7 | `digital_engagement_etl` | Marketing | LOW | 6h | 120 | 24 | 1.5 |

*\* `fragility` and the mean/std duration & rows are **generator-only** — they never
enter any DB, precisely so the agent must **learn** volume baselines from observed
history rather than read them.* The hourly Sales pipeline keeps the live feed active;
daily pipelines exercise freshness/SLA logic over longer windows.

---

## 8. End-to-end data flow

```
 (1) WRITER — simulator (Process 1)
     generate_run() ──INSERT──► monitor.db (pipeline_executions)
                                      │
 (2) DETECTOR — background thread inside FastAPI (Process 2, every 1s)
     scan executions + config ──7 rules──► INSERT/IGNORE governance.db (violations)
                                      │
 (3) API — on each dashboard request (Process 2)
     GET /kpis, /trends, /runs, /pipelines  ── aggregate SELECTs (on-demand)
     GET /violations, /audit                ── filtered SELECTs
     POST /violations/{id}/review           ── UPDATE violation + INSERT audit_log
                                      │
                                      ▼  JSON
 (4) DASHBOARD — React (Process 3), polls every ~5s
     re-renders KPIs, charts, tables; review buttons post back up
```

WAL makes (1), (2), (3) safe concurrently: the simulator writes `monitor.db`, the backend
reads it and writes `governance.db`, and dashboard reads interleave freely. Because Python
releases the GIL during C-level SQLite calls and the work is I/O-bound, request SELECTs and
the detector coexist without contention. The only true conflict (two writers to one file)
is designed out by the one-writer-per-file split.

---

## 9. How to run

All commands run from the **project root** (`capstone_project/`), because
`config.py` uses relative DB paths and the backend imports `synthetic_data.config` to
reuse the exact same paths. Requires Python 3.11+ and Node 20+.

```bash
# 0) one-time backend setup
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # fastapi, uvicorn[standard], pydantic

# 1) Terminal A — API + detector (reads monitor.db, owns governance.db)
.venv/bin/uvicorn backend.main:app --reload --port 8000
#    API:  http://localhost:8000    docs: http://localhost:8000/docs

# 2) Terminal B — data generator (ONLY needed for LIVE updates; writes monitor.db)
.venv/bin/python -m synthetic_data

# 3) Terminal C — frontend
cd frontend && npm install && npm run dev         # http://localhost:5173
```

> The repo ships populated `data/*.db`, so the dashboard shows content immediately after
> cloning. **That snapshot is static** — the backend only reads it. If the numbers never
> change, it's because the **generator (step 2) isn't running**: it is the only component
> that writes new runs. Start it to see the dashboard update live.

### Standalone sanity checks (no server needed, from project root)
```bash
.venv/bin/python -m backend.database    # governance schema + cross-DB ATTACH check
.venv/bin/python -m backend.detection   # run the 7 checks, print violation counts
.venv/bin/python -m backend.kpis        # print KPIs + per-pipeline health
python synthetic_data/catalog.py        # print fleet distribution + SLA-headroom check
```

---

## 10. Design decisions & their rationale

| Decision | Why |
|---|---|
| **3 SQLite files, one writer each** | Eliminates cross-process write contention entirely; WAL then makes reads free. |
| **Simulator emits only raw facts** | Keeps the agent honest — it must *derive* (duration, run_date) and *learn* (volume baselines) rather than read answers. |
| **Two-layer randomness + SLA headroom** | Normal runs never breach by accident, so every detected anomaly is a labeled, explainable signal. |
| **Failure clustering** | Makes `RECURRING_FAILURE` (multi-run, one root cause) emerge naturally instead of being scripted. |
| **"Data now" = newest scheduled_time** | Freshness/missing-load/KPIs stay sensible when the simulator is paused (static DB ≠ infinitely stale). |
| **Deterministic `dedupe_key` per violation** | Re-scans every second are idempotent; violations get stable IDs for the audit trail. |
| **Background detector at 1s (< 5s poll)** | Violations are always ready before the dashboard fetches, without coupling to the frontend cadence. |
| **REST + polling (no SSE/WebSocket)** | Runs are *stored*, not *streamed*; polling is self-healing and needs no push plumbing. |
| **Single uvicorn worker** | Exactly one detector loop → no duplicate violation writes. |
| **Two processes (not folded into one)** | Fits the existing single-thread data layer with zero changes; lowest-risk for the build timeline. |

---

## 11. Status: what's done vs deferred

**Fully implemented**
- Dynamic synthetic data generation (backfill + live, retention, seedable).
- All 7 detection rules with dedupe + severity logic.
- KPIs, per-pipeline health, trends, violation analytics.
- Complete REST API (filters, pagination, cross-DB joins).
- Human-in-the-loop review → immutable audit trail.
- Full React dashboard: Overview, Pipelines, Pipeline Detail, Executions, Violations,
  Audit — live polling, global filters, batch review.

**Deferred (intentionally)**
- **LLM / Gemini natural-language reports** — `/report/{name}` is a stub; the UI shows an
  "on hold" slot. The data contract for it (compact structured KPI + violation summary) is
  already designed in [`data_schema_design.md`](data_schema_design.md) §"What to Send to
  Gemini".
- **Auth / multi-user** — single-user demo assumed (reviewer defaults to `analyst`).
- **Enterprise integrations** (Airflow / Databricks / ADF / Informatica) — the agent
  framework is designed to be reusable toward these later.

---

## 12. Repository map

```
capstone_project/
├── PROJECT_OVERVIEW.md          ← this document
├── README.md                    ← setup & run (Windows-oriented) + troubleshooting
├── project_details.md           ← the capstone brief / objectives
├── data_schema_design.md        ← table/field design (v3 lean model)
├── pipeline_catalog.md          ← the 7 pipelines + generator params + error pools
├── data_generation_design.md    ← the math of run generation & streaming
├── data_generation_plan.md      ← data-layer build plan
├── backend_plan.md              ← backend architecture & locked decisions
├── requirements.txt             ← fastapi, uvicorn[standard], pydantic (sqlite3 = stdlib)
│
├── synthetic_data/              ← Component 1: data generator (stdlib only)
│   ├── config.py  catalog.py  db.py  generator.py  simulator.py  __main__.py
│
├── backend/                     ← Component 2: FastAPI + detection agent
│   ├── database.py  detection.py  kpis.py  main.py  README.md
│
├── frontend/                    ← Component 3: React + Vite dashboard
│   ├── src/App.tsx  main.tsx
│   ├── src/components/  (layout, charts, ui)
│   ├── src/lib/        (api, types, hooks, store, constants, format)
│   └── src/pages/      (Overview, Pipelines, PipelineDetail, Executions, Violations, Audit, NotFound)
│
└── data/                        ← the 3 SQLite files (shipped populated)
    ├── monitor.db  pipeline_config.db  governance.db
```
