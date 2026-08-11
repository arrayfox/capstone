# Implementation Plan — Synthetic Data Generation & Storage
## Capstone Project: Data Freshness Monitoring & Insights Agent

> Build plan for the **data layer only**: generate synthetic pipeline-execution logs
> per our discussed logic, store them in SQLite with retention pruning, and maintain a
> separate database of static pipeline configuration.
>
> Design references: [`data_schema_design.md`](data_schema_design.md),
> [`pipeline_catalog.md`](pipeline_catalog.md),
> [`data_generation_design.md`](data_generation_design.md).

---

## Scope

**In scope**
- Two SQLite databases (execution logs + pipeline config).
- Dynamic run generation (two-layer randomness, fragility, clustering, weighted errors).
- Backfill (instant history) + live (compressed-time) generation.
- Retention pruning of old executions.

**Out of scope (deferred to later phases)**
- Violations detection, `audit_log`, KPI computation.
- FastAPI endpoints, polling dashboard, GenAI/LLM reporting.

---

## Two databases

| DB file | Table(s) | Nature | Written by |
|---|---|---|---|
| `data/pipeline_config.db` | `pipeline_config` (8 fields × 7 rows) | **static reference**, seeded once | seeded from `catalog.py` at startup |
| `data/monitor.db` | `pipeline_executions` (9 raw + 2 derived) | **high-churn**: append + prune | the generator / simulator |

> The config DB receives **only the 8 DB-visible fields** (via `Pipeline.db_config()`).
> The generator-only params (mean/std duration, mean/std rows, fragility, error
> weights) live in `catalog.py` and **never enter any DB** — preserving the principle
> that the agent must *learn* volume baselines from history, not read them.
>
> Later phases that need both (e.g. joining runs to their SLA) use SQLite `ATTACH` or
> app-level joins across the two DB files.

---

## Module layout — `synthetic_data/`

```
synthetic_data/
├── config.py      # all tunable knobs (probabilities, magnitudes, sim params, retention, DB paths, seed)
├── catalog.py     # 7 pipelines: config fields + generator-only params + weighted error pools + messages
├── db.py          # create both DBs, WAL pragmas, schema DDL, seed_config(), insert_run(), prune_old()
├── generator.py   # generate_run(pipeline, scheduled_time, last_status, last_error) -> run dict
├── simulator.py   # clock engine: seed config, backfill, live loop, periodic prune
└── __main__.py    # entry point: `python -m synthetic_data`
```

---

## Build steps

### 1. `config.py` — central knobs
```python
# anomaly base rates (per run, × fragility)
BASE_FAIL_RATE=0.05  SLOW_RUN_PROB=0.08  VOLUME_ANOMALY_PROB=0.05
DELAYED_START_PROB=0.10  MISSING_LOAD_PROB=0.02  CLUSTER_FAIL_PROB=0.50
# magnitudes
SLOW_FACTOR=(1.8,3.5)  DIP_FACTOR=(0.2,0.4)  SPIKE_FACTOR=(2.0,3.0)
# simulation
BACKFILL_DAYS=30  RETENTION_DAYS=60  TIME_COMPRESSION=60  TICK_SECONDS=1  SEED=42
# storage
CONFIG_DB_PATH="data/pipeline_config.db"  MONITOR_DB_PATH="data/monitor.db"
```

### 2. `catalog.py` — the fleet (rebuild)
- 7 `Pipeline` dataclasses: 8 config fields + generator-only params.
- Per-category **weighted** error pools `{code: weight}` + `error_code → error_message` map.
- `db_config()` → the 8 DB-visible fields; `get_pipeline_config_rows()` → seed rows.

### 3. `db.py` — databases + persistence helpers
- Open both DBs with `PRAGMA journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL`.
- DDL:
  - `pipeline_config(pipeline_name PK, pipeline_category, criticality, owner_team,
    schedule_interval_minutes, sla_minutes, freshness_threshold_hours, description)`
  - `pipeline_executions(run_id PK, pipeline_name, scheduled_time, actual_start_time,
    end_time, status, rows_processed, error_code, error_message,
    duration_minutes, run_date)` + indexes on `(pipeline_name, scheduled_time)`.
- `seed_config()` — idempotent upsert of the 7 config rows.
- `insert_run(run)` — derives `duration_minutes` (`end−actual_start`) + `run_date`
  (`date(scheduled_time)`) on write.
- `prune_old(sim_now)` — `DELETE FROM pipeline_executions WHERE scheduled_time <
  sim_now − RETENTION_DAYS`.

### 4. `generator.py` — one dynamic run
`generate_run(pipeline, scheduled_time, last_status, last_error)` implements the
two-layer model:
- **Start jitter** — normal small jitter, or `Uniform(30,120)` if DELAYED_START rolls.
- **Failure decision w/ clustering** — `p_fail = CLUSTER_FAIL_PROB` if last run failed
  (reuse same `error_code`), else `BASE_FAIL_RATE × fragility` (weighted draw).
- **Duration** — `Normal(mean,std)` clamped; `× Uniform(1.8,3.5)` if SLOW_RUN rolls.
- **Volume** — `Normal(mean,std)` clamped; `× dip/spike` if VOLUME_ANOMALY rolls.
- Pure function → returns the 9 raw fields as a dict.

### 5. `simulator.py` — the clock engine
- `Simulator` tracks per-pipeline `next_run`, `last_status`, `last_error`.
- On start: `seed_config()`.
- **Phase 1 — backfill:** `sim_time = now − BACKFILL_DAYS` → walk to `now` with no
  waiting, generating + bulk-inserting every due run.
- **Phase 2 — live:** each `TICK_SECONDS`, advance `sim_time` by `TIME_COMPRESSION`;
  fire due runs; roll `MISSING_LOAD_PROB` to skip a run.
- **Prune once per simulated day** via `prune_old(sim_now)`.

### 6. Entry point + verification
- `python -m synthetic_data` → builds both DBs, backfills, then streams live.
- Verify with `sqlite3` (see checklist).

---

## Data flow

```
catalog.py ──seed──► pipeline_config.db   (static, 7 rows)
     │
     ▼ (in-memory params: mean/std/fragility/error-weights — never persisted)
generator.generate_run() ──► simulator (clock) ──insert──► monitor.db / pipeline_executions
                                        └── once per sim-day ──► prune_old() (drop > 60d)
```

---

## Verification checklist

- [ ] Both DB files created under `data/`; `pipeline_config` has exactly 7 rows.
- [ ] `pipeline_executions` populated after backfill (~a few thousand rows).
- [ ] Cadence correct — hourly pipeline ≈ 24 runs/day, daily ≈ 1/day.
- [ ] Failures present; consecutive failures **cluster** with the same `error_code`.
- [ ] SLA-breaching slow runs and volume dips/spikes appear in the data.
- [ ] `duration_minutes` + `run_date` correctly derived on insert.
- [ ] After pruning, oldest `scheduled_time` stays within ~`RETENTION_DAYS` (60) of sim-now.

---

## Build order

```
config.py → catalog.py → db.py → generator.py → simulator.py → __main__.py → verify
```
