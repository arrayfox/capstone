"""
generator.py - produce ONE dynamic pipeline run.

generate_run() is a pure function: given a pipeline + when it was scheduled +
how the previous run went, it samples one realistic run and returns the 9 raw
fields as a dict. It stores nothing and tracks no state (the simulator owns the
schedule and the last-status memory).

Two layers of randomness (see data_generation_design.md):
  * LAYER 1 - normal wobble: every healthy run is slightly different
              (Gaussian duration / rows / small start jitter).
  * LAYER 2 - injected anomalies: rare dice rolls that create the violations the
              agent must later detect (fail / slow / volume dip-spike / delayed
              start). Each roll's probability is scaled by pipeline.fragility.

Failures also CLUSTER: if the previous run failed, this one is much more likely
to fail too and reuses the SAME error_code - so multi-run outages with one root
cause emerge naturally (that's what "RECURRING_FAILURE" is built from).

Randomness uses the standard `random` module; seed it once (the simulator does
this from config.SEED) for reproducible datasets.
"""

import random
from datetime import timedelta

from . import config
from . import catalog


# ---------------------------------------------------------------------------
# Tiny random helpers - thin wrappers so the main logic reads like the design.
# ---------------------------------------------------------------------------
def _roll(prob: float) -> bool:
    """Return True with probability `prob` (a biased coin flip)."""
    return random.random() < prob


def _clamp(value: float, low: float, high: float) -> float:
    """Keep a sampled value inside [low, high] so no absurd outliers slip in."""
    return max(low, min(high, value))


def _normal_clamped(mean: float, std: float) -> float:
    """Draw Normal(mean, std), clamped to [0.30*mean, mean+3*std]."""
    return _clamp(random.gauss(mean, std), 0.30 * mean, mean + 3 * std)


def _weighted_error(category: str) -> str:
    """Pick an error_code from the category's pool, biased by its weights."""
    pool = catalog.ERROR_POOLS[category]
    return random.choices(list(pool.keys()), weights=list(pool.values()), k=1)[0]


# ---------------------------------------------------------------------------
# The one public function: build a single run.
# ---------------------------------------------------------------------------
def generate_run(pipeline, scheduled_time, last_status, last_error) -> dict:
    """
    Generate one run for `pipeline` scheduled at `scheduled_time`.

    last_status / last_error describe the PREVIOUS run of this same pipeline
    (None on the very first run) and drive failure clustering.

    Returns a dict with the 9 emitted fields. `duration_minutes` and `run_date`
    are intentionally NOT here - db.insert_run() derives those at ingest.
    """
    frag = pipeline.fragility

    # run_id: unique per (pipeline, scheduled_time) and sorts by time. This
    # avoids needing a shared global counter while staying human-readable.
    run_id = f"RUN_{scheduled_time:%Y%m%d_%H%M%S}_{pipeline.pipeline_name}"

    # -- ① START TIMING ------------------------------------------------------
    # Usually a small jitter; occasionally a big DELAYED_START (Layer 2).
    if _roll(config.DELAYED_START_PROB * frag):
        jitter = random.uniform(*config.DELAYED_START_RANGE)   # 30-120 min late
    else:
        jitter = max(0, random.gauss(config.START_JITTER_MEAN, config.START_JITTER_STD))
    actual_start = scheduled_time + timedelta(minutes=jitter)

    # -- ② FAILURE DECISION (with clustering) --------------------------------
    # If the previous run failed, assume the outage persists: much higher fail
    # chance AND reuse the same error_code (one root cause across the cluster).
    if last_status == "FAILED":
        p_fail = config.CLUSTER_FAIL_PROB
    else:
        p_fail = config.BASE_FAIL_RATE * frag

    if _roll(p_fail):
        if last_status == "FAILED" and last_error:
            error_code = last_error                                # cause persists
        else:
            error_code = _weighted_error(pipeline.pipeline_category)  # fresh draw
        # A failed run ran partway, then died -> only a fraction of normal time.
        partial = _normal_clamped(pipeline.mean_duration, pipeline.std_duration)
        partial *= random.uniform(*config.PARTIAL_FAIL_FACTOR)
        return {
            "run_id": run_id,
            "pipeline_name": pipeline.pipeline_name,
            "scheduled_time": scheduled_time,
            "actual_start_time": actual_start,
            "end_time": actual_start + timedelta(minutes=partial),
            "status": "FAILED",
            "rows_processed": 0,                       # nothing delivered
            "error_code": error_code,
            "error_message": catalog.ERROR_MESSAGES[error_code],
        }

    # -- ③ SUCCESS: DURATION (maybe a slow run) ------------------------------
    duration = _normal_clamped(pipeline.mean_duration, pipeline.std_duration)
    if _roll(config.SLOW_RUN_PROB * frag):
        duration *= random.uniform(*config.SLOW_FACTOR)   # 1.8-3.5x -> may breach SLA

    # -- ④ SUCCESS: VOLUME (maybe a dip or spike) ----------------------------
    rows = _normal_clamped(pipeline.mean_rows, pipeline.std_rows)
    if _roll(config.VOLUME_ANOMALY_PROB * frag):
        if random.random() < 0.5:
            rows *= random.uniform(*config.DIP_FACTOR)     # upstream data missing?
        else:
            rows *= random.uniform(*config.SPIKE_FACTOR)   # duplicate / spike?

    return {
        "run_id": run_id,
        "pipeline_name": pipeline.pipeline_name,
        "scheduled_time": scheduled_time,
        "actual_start_time": actual_start,
        "end_time": actual_start + timedelta(minutes=duration),
        "status": "SUCCESS",
        "rows_processed": int(rows),
        "error_code": None,
        "error_message": None,
    }


# ---------------------------------------------------------------------------
# Standalone demo: generate a handful of runs for one pipeline and print them.
# `python -m synthetic_data.generator`
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    from datetime import datetime

    random.seed(config.SEED)
    pipe = catalog.PIPELINES[0]           # hcp_prescriber_data_sync
    sched = datetime(2026, 8, 1, 6, 0, 0)
    last_status, last_error = None, None

    print(f"Sample runs for {pipe.pipeline_name} (sla={pipe.sla_minutes} min):\n")
    for _ in range(10):
        run = generate_run(pipe, sched, last_status, last_error)
        dur = (run["end_time"] - run["actual_start_time"]).total_seconds() / 60
        print(f"  {run['scheduled_time']:%Y-%m-%d}  {run['status']:7}  "
              f"dur={dur:6.1f}m  rows={run['rows_processed']:>9}  "
              f"{run['error_code'] or ''}")
        last_status, last_error = run["status"], run["error_code"]
        sched += timedelta(minutes=pipe.schedule_interval_minutes)
