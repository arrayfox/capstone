"""
config.py - central tunable knobs for synthetic data generation.

Everything that controls HOW the fake pipeline runs behave lives here, so the
whole simulation can be re-tuned from one place (no code changes elsewhere).
These values are read by generator.py (anomaly rolls / magnitudes) and
simulator.py (backfill / retention / clock), plus the DB paths used by db.py.

NOTE: this is only the "data layer" of a larger project. Later phases
(violation detection, FastAPI, dashboard, LLM reporting) will add their own
config; keep new knobs grouped and commented the same way.
"""

# ---------------------------------------------------------------------------
# Anomaly base rates - probability per run that an anomaly is injected.
# Each rate is multiplied by the pipeline's `fragility` at roll time, so a
# fragile pipeline sees proportionally more incidents. (0.05 = 5% chance.)
# ---------------------------------------------------------------------------
BASE_FAIL_RATE      = 0.05   # run fails outright
SLOW_RUN_PROB       = 0.08   # run takes much longer than usual (-> SLA breach)
VOLUME_ANOMALY_PROB = 0.05   # rows dip or spike vs the norm
DELAYED_START_PROB  = 0.10   # run starts well after its scheduled time
MISSING_LOAD_PROB   = 0.02   # scheduler skips firing this cycle (no run at all)
CLUSTER_FAIL_PROB   = 0.50   # fail chance if the PREVIOUS run failed (outage persists)

# ---------------------------------------------------------------------------
# Anomaly magnitudes - how big the injected effect is, as a (min, max) range
# drawn uniformly at roll time.
# ---------------------------------------------------------------------------
SLOW_FACTOR         = (1.8, 3.5)   # multiply duration by this for a slow run
DIP_FACTOR          = (0.2, 0.4)   # multiply rows by this for a volume dip
SPIKE_FACTOR        = (2.0, 3.0)   # multiply rows by this for a volume spike
PARTIAL_FAIL_FACTOR = (0.2, 0.6)   # fraction of normal duration a failed run got through

# ---------------------------------------------------------------------------
# Start-time jitter - real jobs rarely start exactly on schedule.
# ---------------------------------------------------------------------------
START_JITTER_MEAN   = 2            # minutes: mean of the small "normal" jitter
START_JITTER_STD    = 2            # minutes: std of that jitter
DELAYED_START_RANGE = (30, 120)    # minutes: jitter range when DELAYED_START hits

# ---------------------------------------------------------------------------
# Simulation clock & history.
# ---------------------------------------------------------------------------
BACKFILL_DAYS       = 30    # how much history to instantly generate at startup
RETENTION_DAYS      = 60    # keep ~2 months of runs; older ones get pruned
TIME_COMPRESSION    = 3600  # live mode: sim-seconds advanced per real-second
                            # (3600 = 1 real sec -> 1 sim hour, so the dashboard
                            #  visibly updates on each poll; was 60 = 1s->1min)
TICK_SECONDS        = 1     # live mode: real-seconds between clock ticks
POLL_SECONDS        = 5     # (frontend, later phase) dashboard refresh cadence
SEED                = 42    # single RNG seed -> reproducible datasets

# ---------------------------------------------------------------------------
# Storage - the two SQLite database files (created under data/).
# ---------------------------------------------------------------------------
CONFIG_DB_PATH      = "data/pipeline_config.db"   # static pipeline config (7 rows)
MONITOR_DB_PATH     = "data/monitor.db"           # high-churn execution logs
