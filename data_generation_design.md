# Data Generation & Streaming — Design & Mathematics
## Capstone Project: Data Freshness Monitoring & Insights Agent

> How synthetic pipeline-execution logs are **generated dynamically** and **streamed**
> into SQLite so the monitoring agent has realistic, live data to analyze.
>
> Companion docs: [`data_schema_design.md`](data_schema_design.md) (tables/fields),
> [`pipeline_catalog.md`](pipeline_catalog.md) (the 7 pipelines + params).

---

## 1. Goals & principles

- **Dynamic, not static:** every run is sampled from probability distributions at
  runtime — no fixed CSV, no hardcoded values. No two runs (or sessions) are identical.
- **Realistic:** runs respect each pipeline's schedule; timestamps + `run_id`s are
  sequential; failures cluster like real outages; volume moves around a learnable
  baseline; most runs are healthy.
- **Constrained:** normal runtime always sits *under* the SLA, so ordinary runs pass
  and only *injected* anomalies breach — keeping detection signals clean.
- **Seedable:** all randomness derives from one seed → reproducible datasets.
- **Storage:** written **directly to SQLite** (no intermediate file). SQLite is the
  single source of truth for pipeline config + execution logs + violations + audit.

---

## 2. Two layers of randomness

The central design idea: separate the everyday *wobble* from the injected *problems*.

```
                    generate_run(pipeline, scheduled_time)
                                    │
     ┌───────────────────────────────┴───────────────────────────────┐
LAYER 1: NORMAL WOBBLE                       LAYER 2: ANOMALY ROLLS
(Gaussian — small, always on)               (dice — rare, injected)
duration ~ Normal(mean, std)                 fail? slow? volume dip/spike?
rows     ~ Normal(mean, std)                 delayed start? skipped run?
start jitter ~ small                         each probability × FRAGILITY
```

- **Layer 1** makes each *healthy* run slightly different (realistic noise).
- **Layer 2** injects the *violations* the agent must detect.
- Layer 1's spread is kept **tight** so large excursions come from **labeled**
  anomalies (detectable/explainable), not random Gaussian tails.

---

## 3. Layer 1 — normal wobble (the mathematics)

### 3.1 Duration
```
duration_minutes ~ Normal(mean_duration, std_duration)
clamp to [0.30 × mean, mean + 3σ]      # floor + cap: no absurd values
```
By the empirical rule, ~68% of runs fall within ±1σ, ~95% within ±2σ:

| pipeline | mean ± std | ~68% band (±1σ) | ~95% band (±2σ) |
|---|---|---|---|
| `hcp_prescriber_data_sync` | 45 ± 12 | 33–57 min | 21–69 min |
| `rx_claims_daily_load` | 90 ± 20 | 70–110 min | 50–130 min |
| `field_force_call_activity` | 20 ± 6 | 14–26 min | 8–32 min |

### 3.2 Volume
```
rows_processed ~ Normal(mean_rows, std_rows)
clamp to [0, mean + 3σ]
```
e.g. `hcp_prescriber_data_sync`: 120k ± 25k → normal band ~95k–145k rows.

### 3.3 Start jitter
```
normal_jitter ~ max(0, Normal(2 min, 2))     # jobs rarely start exactly on time
actual_start_time = scheduled_time + normal_jitter
```

### 3.4 Guardrails
- Clamp every Gaussian draw to **±3σ** and a sane floor.
- Because `mean_duration < sla_minutes` (positive **SLA headroom**, see catalog),
  **a normal run never breaches SLA by itself** — only a Layer-2 slow run does.

---

## 4. Layer 2 — anomaly rolls (the mathematics)

Each run makes independent probability rolls. Each base rate is multiplied by the
pipeline's `fragility`:

```
effective_prob = base_prob × pipeline.fragility
```

| Roll | Base prob | Effect if hit | Violation produced |
|---|---|---|---|
| **Fail?** | 5% | status=FAILED, pick error_code, rows≈0/partial | (RECURRING_)FAILURE |
| **Slow run?** | 8% | `duration ×= Uniform(1.8, 3.5)` | SLA_BREACH |
| **Volume anomaly?** | 5% | dip `×Uniform(0.2,0.4)` or spike `×Uniform(2.0,3.0)` | VOLUME_ANOMALY |
| **Delayed start?** | 10% | `jitter = Uniform(30, 120) min` | DELAYED_START |
| **Skip run?** | 2% | emit nothing this cycle | MISSING_LOAD |

**Example (SLA breach):** `hcp_prescriber_data_sync` normal 45 min × 3.0 = **135 min
> 120-min SLA → breach.** The 1.8–3.5× band is chosen so slow runs reliably cross
the SLA line without being cartoonish.

---

## 5. Fragility — the pipeline's "personality"

A single multiplier on **every** Layer-2 probability, giving each pipeline a stable
character instead of uniform randomness.

| pipeline | fragility | fail prob (base 5%) | meaning |
|---|---|---|---|
| `digital_engagement_etl` | **1.5** | 7.5% | flaky 3rd-party marketing APIs |
| `hcp_prescriber_data_sync` | 1.2 | 6.0% | slightly unreliable |
| `field_force_call_activity` | 1.0 | 5.0% | baseline |
| `sample_distribution_compliance` | **0.7** | 3.5% | rock-solid, tightly controlled |

Over a month, `digital_engagement_etl` racks up ~2× the incidents of
`sample_distribution_compliance` — *consistently*. That consistency is realistic and
gives the agent a genuine per-pipeline pattern to surface.

---

## 6. Failures & error codes — "random, but weighted"

Error selection is a **biased** random draw, not a fair coin.

### 6.1 Weighted draw from the pipeline's category pool
```python
random.choices(error_codes, weights=weights, k=1)[0]
```
Example — Claims pool:

| Error | Weight | Why this frequency |
|---|---|---|
| `FILE_NOT_FOUND` | 50 | missing payer file = the everyday claims failure |
| `SCHEMA_MISMATCH` | 30 | vendors change formats fairly often |
| `DB_TIMEOUT` | 15 | occasional; pool usually copes |
| `PARSE_ERROR` | 5 | rare — loads almost always parse |

Errors are drawn from the pipeline's **own category pool** so they're contextually
plausible (a file load fails with `FILE_NOT_FOUND`; an API feed with `RATE_LIMIT`).
Each `error_code` maps to a matching `error_message`.

### 6.2 Clustering (the non-random part)
Real outages last several runs and share **one root cause**, so:
```
if previous_run_failed:
    p_fail     = CLUSTER_FAIL_PROB      # e.g. 0.50 — outage persists
    error_code = previous_run.error_code    # SAME code (persistent cause)
else:
    p_fail     = BASE_FAIL_RATE × fragility
    error_code = weighted_draw(pool)        # fresh, unbiased draw
```
This is what makes **RECURRING_FAILURE emerge naturally** ("failed 4× this week with
DB_TIMEOUT") instead of being scripted.

```
fail roll hits
   ├─ previous run failed? ──YES──► reuse SAME code (outage)
   └─ NO ──► weighted draw:
        FILE_NOT_FOUND 50 ██████████████████
        SCHEMA_MISMATCH 30 ██████████
        DB_TIMEOUT      15 █████
        PARSE_ERROR      5 ██
```

So three different "randomnesses": **random for variety, weighted for realism,
clustered for persistence.**

---

## 7. Failed-run field values

| field | on SUCCESS | on FAILED |
|---|---|---|
| `status` | `SUCCESS` | `FAILED` |
| `end_time` | actual_start + full duration | actual_start + *partial* duration (ran, then died) |
| `rows_processed` | sampled volume | 0 (or partial) |
| `error_code` | NULL | weighted/clustered draw |
| `error_message` | NULL | mapped from error_code |

---

## 8. Generating ONE run (pseudocode)

```python
def generate_run(pipeline, scheduled_time, last_status, last_error):
    # ① start timing
    if roll(DELAYED_START_PROB × fragility):
        jitter = Uniform(30, 120)          # minutes → DELAYED_START
    else:
        jitter = max(0, Normal(2, 2))
    actual_start = scheduled_time + jitter

    # ② failure decision (with clustering)
    p_fail = CLUSTER_FAIL_PROB if last_status == FAILED else BASE_FAIL_RATE × fragility
    if roll(p_fail):
        error_code = last_error if last_status == FAILED else weighted_draw(pool)
        duration   = Normal(mean, std) × Uniform(0.2, 0.6)   # partial before dying
        return Run(status=FAILED, actual_start, end=actual_start+duration,
                   rows=0, error_code, error_message=MSG[error_code])

    # ③ success path — duration (maybe slow)
    duration = clamp(Normal(mean_duration, std_duration))
    if roll(SLOW_RUN_PROB × fragility):
        duration *= Uniform(1.8, 3.5)      # → possible SLA_BREACH

    # ④ volume (maybe dip/spike)
    rows = clamp(Normal(mean_rows, std_rows))
    if roll(VOLUME_ANOMALY_PROB × fragility):
        rows *= choice(Uniform(0.2,0.4), Uniform(2.0,3.0))   # → VOLUME_ANOMALY

    return Run(status=SUCCESS, actual_start, end=actual_start+duration,
               rows=rows, error_code=None, error_message=None)

# MISSING_LOAD: with prob MISSING_LOAD_PROB the scheduler skips firing this cycle.
```

Every `Normal(...)`, `Uniform(...)`, `roll(...)` is re-evaluated per run → the dynamism.

---

## 9. The engine: a schedule-driven simulated clock

Real pipelines emit runs as time passes; we move time faster. Each pipeline tracks a
**next-run time**; the clock walks forward and fires a run whenever it's due.

```
sim_time = start
loop:
    for pipeline in pipelines:
        while pipeline.next_run <= sim_time:
            maybe_skip = roll(MISSING_LOAD_PROB × fragility)   # → MISSING_LOAD
            if not maybe_skip:
                run = generate_run(pipeline, pipeline.next_run, last_status, last_error)
                store(run)                                     # INSERT into SQLite
            pipeline.next_run += pipeline.schedule_interval_minutes
    advance sim_time
```

This yields a correct cadence automatically: hourly → 24 runs/sim-day, daily → 1.

---

## 10. Two phases

### Phase 1 — Backfill (instant, at startup)
- Set `sim_time = now − BACKFILL_DAYS` and run the loop **with no waiting** up to `now`.
- ~7 pipelines × 30 days ≈ a few thousand runs → **bulk-inserted in <1s**.
- **Why:** the agent needs history *immediately* — volume baselines (~20+ runs each),
  7d/30d trends, and a non-empty violations backlog.

### Phase 2 — Live (compressed real-time)
- From `now` onward, advance the clock by a **compression ratio** and sleep between ticks:
```
TIME_COMPRESSION = 60     # 1 real second = 60 sim-seconds
TICK_SECONDS     = 1      # wake each real second, advance 60 sim-seconds, fire due runs
```
- Runs trickle out at a watchable pace → the dashboard's **live feed**.
- Tune `TIME_COMPRESSION` up for a faster demo.

---

## 11. Store → stream path (per live run)

```
generate ──► INSERT (SQLite, derive duration_minutes + run_date) ──► notify ──► SSE event ──► dashboard appends row
```

1. INSERT the run into `pipeline_executions`.
2. Notify the API layer (in-process event/queue) that a new run landed.
3. Push it over an open **SSE** connection (`GET /stream`) to the dashboard.
4. Dashboard appends to the live feed — no polling.

### Concurrency (WAL)
While the generator writes, KPI queries, the detector, and chart queries **read the
same DB concurrently**. SQLite in **WAL mode** makes this safe (writer never blocks
readers). Enabled once at startup:
```
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;   # auto-retry rare write collisions
PRAGMA synchronous  = NORMAL;
```
Writes are tiny (a few INSERTs/sec) — far below SQLite's throughput — so the demo stays smooth.

### Runtime model
The simulator loop runs as a **background task inside the FastAPI app** (one process
to launch); modular enough to split into a separate process later (WAL is
multi-process-safe).

---

## 12. Tunable knobs (one place)

```python
# --- anomaly base rates (per run, × fragility) ---
BASE_FAIL_RATE      = 0.05
SLOW_RUN_PROB       = 0.08
VOLUME_ANOMALY_PROB = 0.05
DELAYED_START_PROB  = 0.10
MISSING_LOAD_PROB   = 0.02
CLUSTER_FAIL_PROB   = 0.50    # fail chance if previous run failed (outage)

# --- magnitudes ---
SLOW_FACTOR   = (1.8, 3.5)
DIP_FACTOR    = (0.2, 0.4)
SPIKE_FACTOR  = (2.0, 3.0)

# --- simulation ---
BACKFILL_DAYS    = 30
TIME_COMPRESSION = 60
TICK_SECONDS     = 1
SEED             = 42
```

Turn these dials to make the fleet healthier or more chaotic — no code changes.

---