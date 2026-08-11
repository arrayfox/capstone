"""
db.py - the two SQLite databases and all persistence helpers.

Responsibilities:
  * create/open both DB files with WAL pragmas (writer never blocks readers),
  * hold the schema (DDL) for pipeline_config and pipeline_executions,
  * seed_config()  - idempotently write the 7 static config rows,
  * insert_run()   - append one execution, DERIVING duration_minutes + run_date,
  * prune_old()    - drop executions older than the retention window.

Design note: the simulator emits only RAW facts. The two derived columns
(duration_minutes, run_date) are computed HERE at insert time - never generated.

Two module-level connections are opened by init() and reused, so the rest of
the package can just call db.insert_run(run) etc. Single-threaded use for now;
a later FastAPI phase can revisit connection handling.
"""

import os
import sqlite3
from datetime import datetime, timedelta

from . import config
from . import catalog

# Timestamps are stored as ISO-like strings 'YYYY-MM-DD HH:MM:SS'. This format
# sorts lexicographically the same as chronologically, so string comparisons in
# WHERE clauses (e.g. pruning) are correct.
_TS_FORMAT = "%Y-%m-%d %H:%M:%S"

# Module-level connections, set by init().
_config_conn: sqlite3.Connection | None = None
_monitor_conn: sqlite3.Connection | None = None


# ---------------------------------------------------------------------------
# Schema (DDL)
# ---------------------------------------------------------------------------
_DDL_CONFIG = """
CREATE TABLE IF NOT EXISTS pipeline_config (
    pipeline_name              TEXT PRIMARY KEY,
    pipeline_category          TEXT NOT NULL,
    criticality                TEXT NOT NULL,
    owner_team                 TEXT NOT NULL,
    schedule_interval_minutes  INTEGER NOT NULL,
    sla_minutes                INTEGER NOT NULL,
    freshness_threshold_hours  INTEGER NOT NULL,
    description                TEXT NOT NULL
);
"""

_DDL_EXECUTIONS = """
CREATE TABLE IF NOT EXISTS pipeline_executions (
    run_id             TEXT PRIMARY KEY,
    pipeline_name      TEXT NOT NULL,
    scheduled_time     TEXT NOT NULL,
    actual_start_time  TEXT,
    end_time           TEXT,
    status             TEXT NOT NULL,
    rows_processed     INTEGER,
    error_code         TEXT,
    error_message      TEXT,
    -- derived at ingest, stored alongside:
    duration_minutes   REAL,
    run_date           TEXT NOT NULL
);

-- main lookup pattern: a pipeline's runs in time order
CREATE INDEX IF NOT EXISTS idx_exec_pipeline_sched
    ON pipeline_executions (pipeline_name, scheduled_time);

-- supports retention pruning by scheduled_time
CREATE INDEX IF NOT EXISTS idx_exec_sched
    ON pipeline_executions (scheduled_time);
"""


# ---------------------------------------------------------------------------
# Connection setup
# ---------------------------------------------------------------------------
def _connect(db_path: str) -> sqlite3.Connection:
    """Open one SQLite DB (creating its folder), applying the WAL pragmas."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    # WAL lets the writer and readers work concurrently (needed once the
    # detector / dashboard read while the simulator writes).
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")   # auto-retry brief lock collisions
    conn.execute("PRAGMA synchronous = NORMAL;")  # fast + safe enough for this use
    return conn


def init() -> None:
    """Open both DBs and create the schema. Call once before anything else."""
    global _config_conn, _monitor_conn
    _config_conn = _connect(config.CONFIG_DB_PATH)
    _config_conn.executescript(_DDL_CONFIG)
    _config_conn.commit()

    _monitor_conn = _connect(config.MONITOR_DB_PATH)
    _monitor_conn.executescript(_DDL_EXECUTIONS)
    _monitor_conn.commit()


def close() -> None:
    """Close both connections (optional; nice for a clean shutdown)."""
    if _config_conn is not None:
        _config_conn.close()
    if _monitor_conn is not None:
        _monitor_conn.close()


# ---------------------------------------------------------------------------
# Config DB - seed the 7 static rows (idempotent)
# ---------------------------------------------------------------------------
def seed_config() -> None:
    """
    Upsert the 7 pipeline_config rows from catalog.py. Idempotent: safe to run
    on every startup - existing rows are updated, not duplicated.
    """
    rows = catalog.get_pipeline_config_rows()
    _config_conn.executemany(
        """
        INSERT INTO pipeline_config (
            pipeline_name, pipeline_category, criticality, owner_team,
            schedule_interval_minutes, sla_minutes, freshness_threshold_hours,
            description
        ) VALUES (
            :pipeline_name, :pipeline_category, :criticality, :owner_team,
            :schedule_interval_minutes, :sla_minutes, :freshness_threshold_hours,
            :description
        )
        ON CONFLICT(pipeline_name) DO UPDATE SET
            pipeline_category         = excluded.pipeline_category,
            criticality               = excluded.criticality,
            owner_team                = excluded.owner_team,
            schedule_interval_minutes = excluded.schedule_interval_minutes,
            sla_minutes               = excluded.sla_minutes,
            freshness_threshold_hours = excluded.freshness_threshold_hours,
            description               = excluded.description
        """,
        rows,
    )
    _config_conn.commit()


# ---------------------------------------------------------------------------
# Monitor DB - inserting runs (with derived fields) + pruning
# ---------------------------------------------------------------------------
def _fmt_ts(value) -> str | None:
    """Format a datetime as the stored string form; pass through None."""
    if value is None:
        return None
    return value.strftime(_TS_FORMAT)


def _run_to_row(run: dict) -> tuple:
    """
    Turn a raw run dict (the 9 emitted fields) into the 11-column DB tuple,
    computing the two derived fields here at ingest:
      * duration_minutes = end_time - actual_start_time (None while RUNNING)
      * run_date         = date(scheduled_time)
    """
    scheduled_time = run["scheduled_time"]
    actual_start_time = run["actual_start_time"]
    end_time = run["end_time"]

    # duration only makes sense once the run has finished
    if end_time is not None and actual_start_time is not None:
        duration_minutes = round((end_time - actual_start_time).total_seconds() / 60.0, 2)
    else:
        duration_minutes = None

    run_date = scheduled_time.strftime("%Y-%m-%d")

    return (
        run["run_id"],
        run["pipeline_name"],
        _fmt_ts(scheduled_time),
        _fmt_ts(actual_start_time),
        _fmt_ts(end_time),
        run["status"],
        run["rows_processed"],
        run["error_code"],
        run["error_message"],
        duration_minutes,
        run_date,
    )


_INSERT_SQL = """
INSERT OR IGNORE INTO pipeline_executions (
    run_id, pipeline_name, scheduled_time, actual_start_time, end_time,
    status, rows_processed, error_code, error_message,
    duration_minutes, run_date
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def insert_run(run: dict) -> None:
    """Insert a single run. OR IGNORE keeps re-runs idempotent on run_id."""
    _monitor_conn.execute(_INSERT_SQL, _run_to_row(run))
    _monitor_conn.commit()


def insert_runs(runs: list) -> None:
    """Bulk-insert many runs in one transaction (used by the instant backfill)."""
    rows = [_run_to_row(r) for r in runs]
    _monitor_conn.executemany(_INSERT_SQL, rows)
    _monitor_conn.commit()


def prune_old(sim_now: datetime) -> int:
    """
    Delete executions older than the retention window, relative to sim-time.
    Returns how many rows were removed (handy for logging). Runs once per
    simulated day from the simulator - cheap and keeps the DB bounded.
    """
    cutoff = sim_now - timedelta(days=config.RETENTION_DAYS)
    cur = _monitor_conn.execute(
        "DELETE FROM pipeline_executions WHERE scheduled_time < ?",
        (_fmt_ts(cutoff),),
    )
    _monitor_conn.commit()
    return cur.rowcount


def reset_executions() -> None:
    """
    Empty the execution log so a session starts from a clean 30-day backfill.

    Why: each launch backfills "the last BACKFILL_DAYS up to now". Re-running
    without a reset would stack a second overlapping backfill on top of the
    first (same logical days, a slightly different clock anchor -> different
    run_ids that INSERT OR IGNORE can't dedupe), doubling runs per day and
    breaking cadence. Clearing first keeps the dataset clean and reproducible.

    The static pipeline_config DB is deliberately NOT touched (it's idempotently
    re-seeded via seed_config()).
    """
    _monitor_conn.execute("DELETE FROM pipeline_executions")
    _monitor_conn.commit()



# ---------------------------------------------------------------------------
# Small read helpers (handy for the verification step / __main__)
# ---------------------------------------------------------------------------
def execution_count() -> int:
    """Total rows currently in pipeline_executions."""
    return _monitor_conn.execute("SELECT COUNT(*) FROM pipeline_executions").fetchone()[0]


def config_count() -> int:
    """Total rows in pipeline_config (should be 7)."""
    return _config_conn.execute("SELECT COUNT(*) FROM pipeline_config").fetchone()[0]
