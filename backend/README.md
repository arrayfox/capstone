# Backend — Pipeline Monitoring API

FastAPI service that reads the synthetic data (`monitor.db`, `pipeline_config.db`),
detects violations, computes KPIs, and serves a REST API for the dashboard.
It owns `data/governance.db` (violations + audit_log). See `../backend_plan.md`.

## Modules
| File | Role |
|---|---|
| `database.py` | connections; creates `governance.db`; ATTACHes monitor + config (read-only) |
| `detection.py` | the rule "agent": 6 checks → upsert deduped violations |
| `kpis.py` | dashboard aggregates (headline cards + per-pipeline health) |
| `main.py` | FastAPI app: routers, CORS, review→audit, `/report` stub, background detector |

## Setup (once)
```bash
cd /home/flux/Documents/capstone_project
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run (two processes, both from the project root)
```bash
# Terminal A — data generator (writer)
.venv/bin/python -m synthetic_data

# Terminal B — API (reader + detector)
.venv/bin/uvicorn backend.main:app --reload --port 8000
```
- API:  http://localhost:8000
- Interactive docs (test everything here):  http://localhost:8000/docs

> Terminal A is optional if `data/monitor.db` already has data — the API reads
> whatever is there. Run A to keep new runs streaming in live.

## Verify each module standalone (no server needed)
```bash
.venv/bin/python -m backend.database    # governance schema + ATTACH check
.venv/bin/python -m backend.detection   # run the 6 checks, print violation counts
.venv/bin/python -m backend.kpis        # print KPIs + per-pipeline health
```

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/kpis?window_days=7` | headline dashboard cards |
| GET | `/pipelines?category=&criticality=` | fleet + per-pipeline health |
| GET | `/pipelines/{name}` | config + recent runs + open violations |
| GET | `/runs?pipeline=&category=&status=&date_from=&date_to=&limit=&offset=` | filtered run log |
| GET | `/runs/recent?limit=20` | newest runs across the fleet |
| GET | `/violations?pipeline=&category=&type=&severity=&status=&date_from=&date_to=&limit=&offset=` | filtered violations |
| POST | `/violations/{id}/review` | `{action: approve\|dismiss\|escalate, reviewed_by, note}` → updates + audit |
| GET | `/audit?actor=&action=&entity=&date_from=&date_to=&limit=` | audit trail |
| POST | `/detect` | trigger a detection scan now |
| GET | `/report/{name}` | **STUB** — LLM on hold (no Gemini key) |

## Configuration & tuning (where every knob lives)

All parameters are centralized — nothing important is buried in code.

**Simulation / data layer → `synthetic_data/config.py`**
| Knob | Meaning |
|---|---|
| `TIME_COMPRESSION` | live speed: sim-seconds advanced per real-second (60 = 1s→1min) |
| `TICK_SECONDS` | real-seconds between live clock ticks |
| `BACKFILL_DAYS` | how much history to generate instantly at startup |
| `RETENTION_DAYS` | how long runs are kept before pruning |
| `POLL_SECONDS` | frontend refresh cadence (the detector runs faster — see `main.py`) |
| `BASE_FAIL_RATE`, `SLOW_RUN_PROB`, `VOLUME_ANOMALY_PROB`, `DELAYED_START_PROB`, `MISSING_LOAD_PROB`, `CLUSTER_FAIL_PROB` | anomaly injection rates |
| `SLOW_FACTOR`, `DIP_FACTOR`, `SPIKE_FACTOR`, `PARTIAL_FAIL_FACTOR`, `START_JITTER_*`, `DELAYED_START_RANGE` | anomaly magnitudes / jitter |
| `SEED` | RNG seed for reproducible datasets |
| `CONFIG_DB_PATH`, `MONITOR_DB_PATH` | DB file locations |


**Detection sensitivity → top of `backend/detection.py`**
`DELAYED_START_THRESHOLD_MIN`, `VOLUME_BASELINE_N`, `VOLUME_MIN_HISTORY`,
`VOLUME_K`, `RECURRING_FAILURE_MIN`, `RECURRING_WINDOW_DAYS`, `MISSING_LOAD_GAP_FACTOR`.

**API layer → `backend/main.py`:** `DETECT_INTERVAL_SECONDS` (own knob, default `1`s — deliberately below `POLL_SECONDS`), CORS origins.
**KPI window → `backend/kpis.py`:** default `window_days` (7).

## Notes
- **LLM report is intentionally stubbed** (`/report`) until a Gemini key is added.
- **Detector vs polling:** `/runs`, `/runs/recent`, `/kpis`, `/pipelines` are computed
  **on-demand** from the DB, so they're always as fresh as your poll. Only *violations*
  are produced by the background detector, which runs every `DETECT_INTERVAL_SECONDS`
  (default **1s**, its own knob kept below `POLL_SECONDS`) so violations are ready even
  if the user refreshes before the next poll tick. `POST /detect` forces an immediate scan.

- Frontend origin allowed by CORS: `http://localhost:5173` (Vite default) — edit in `main.py`.

