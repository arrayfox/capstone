"""
database.py - the backend's data access layer.

Three SQLite files are involved (all under data/):
  * monitor.db          - pipeline_executions   (READ ONLY here; simulator owns writes)
  * pipeline_config.db  - pipeline_config        (READ ONLY here; seeded by data layer)
  * governance.db       - violations + audit_log (this layer OWNS + writes these)

Design (see backend_plan.md R1/R2/R5):
  * The backend never writes monitor.db / pipeline_config.db, so there is exactly
    one writer per file across the two processes -> no cross-process write contention.
  * Every connection opens governance.db and ATTACHes the other two as `monitor`
    and `config`, so a single query can join across all three (e.g. filter runs by
    category, which lives in pipeline_config).
  * One fresh connection per request / per operation (SQLite connections aren't
    meant to be shared across threads); WAL makes concurrent reads cheap.

Paths are resolved to ABSOLUTE at import time (from this file's location), so the
API works regardless of the process's current working directory.
"""

import os
import sqlite3
from datetime import datetime

from synthetic_data import config as sd_config

# ---------------------------------------------------------------------------
# Absolute DB paths (CWD-independent). Project root = parent of this package.
# ---------------------------------------------------------------------------
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _abs(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(_PROJECT_ROOT, path)


MONITOR_DB_PATH = _abs(sd_config.MONITOR_DB_PATH)          # read-only here
CONFIG_DB_PATH = _abs(sd_config.CONFIG_DB_PATH)            # read-only here
GOVERNANCE_DB_PATH = _abs("data/governance.db")           # owned + written here

_TS_FORMAT = "%Y-%m-%d %H:%M:%S"   # matches the format stored in monitor.db


# ---------------------------------------------------------------------------
# Schema (DDL) for the governance DB
# ---------------------------------------------------------------------------
_DDL_GOVERNANCE = """
CREATE TABLE IF NOT EXISTS violations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key      TEXT NOT NULL UNIQUE,   -- deterministic: stops re-scans duplicating
    pipeline_name   TEXT NOT NULL,
    run_id          TEXT,                   -- nullable: MISSING_LOAD / FRESHNESS have no run
    violation_type  TEXT NOT NULL,
    severity        TEXT NOT NULL,
    detected_at     TEXT NOT NULL,
    details         TEXT,
    status          TEXT NOT NULL DEFAULT 'open',   -- open|reviewed|dismissed|escalated
    reviewed_by     TEXT,
    reviewed_at     TEXT,
    note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_viol_status   ON violations (status);
CREATE INDEX IF NOT EXISTS idx_viol_pipeline ON violations (pipeline_name);
CREATE INDEX IF NOT EXISTS idx_viol_type     ON violations (violation_type);
CREATE INDEX IF NOT EXISTS idx_viol_detected ON violations (detected_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    TEXT NOT NULL,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT,
    details      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
"""


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
def connect() -> sqlite3.Connection:
    """
    Open a fresh connection to governance.db with monitor.db + pipeline_config.db
    ATTACHed. Query names:
        violations, audit_log          (governance.db, read/write)
        monitor.pipeline_executions    (monitor.db, read here)
        config.pipeline_config         (pipeline_config.db, read here)
    Rows come back as sqlite3.Row (dict-like). Caller must close() it.
    """
    os.makedirs(os.path.dirname(GOVERNANCE_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(GOVERNANCE_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("ATTACH DATABASE ? AS monitor", (MONITOR_DB_PATH,))
    conn.execute("ATTACH DATABASE ? AS config", (CONFIG_DB_PATH,))
    return conn


def init_governance() -> None:
    """Create governance.db + its schema (idempotent). Call once at startup."""
    conn = connect()
    try:
        conn.executescript(_DDL_GOVERNANCE)
        conn.commit()
    finally:
        conn.close()


def get_db():
    """FastAPI dependency: yields a connection and always closes it."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Generic query helpers (each manages its own short-lived connection)
# ---------------------------------------------------------------------------
def fetch_all(sql: str, params=()) -> list[dict]:
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def fetch_one(sql: str, params=()):
    conn = connect()
    try:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Write helpers for governance data (used by the detector + review actions)
# ---------------------------------------------------------------------------
def now_iso() -> str:
    """Wall-clock 'now' in the stored string format."""
    return datetime.now().strftime(_TS_FORMAT)


def upsert_violation(v: dict) -> bool:
    """
    Insert a violation if its dedupe_key is new. Returns True if a new row was
    written, False if it already existed (INSERT OR IGNORE on the UNIQUE key).

    Required keys: dedupe_key, pipeline_name, violation_type, severity.
    Optional: run_id, detected_at (defaults to now), details.
    """
    conn = connect()
    try:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO violations (
                dedupe_key, pipeline_name, run_id, violation_type,
                severity, detected_at, details, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
            """,
            (
                v["dedupe_key"],
                v["pipeline_name"],
                v.get("run_id"),
                v["violation_type"],
                v["severity"],
                v.get("detected_at") or now_iso(),
                v.get("details"),
            ),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def record_audit(actor: str, action: str, entity_type: str,
                 entity_id: str | None = None, details: str | None = None) -> None:
    """Append one row to the audit trail (never pruned)."""
    conn = connect()
    try:
        conn.execute(
            """
            INSERT INTO audit_log (timestamp, actor, action, entity_type, entity_id, details)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (now_iso(), actor, action, entity_type, entity_id, details),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Self-test: python -m backend.database
#   Verifies the governance schema is created and the ATTACHed data DBs are
#   readable through the same connection (the cross-DB join path).
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("Paths:")
    print("  governance:", GOVERNANCE_DB_PATH)
    print("  monitor   :", MONITOR_DB_PATH)
    print("  config    :", CONFIG_DB_PATH)

    init_governance()
    conn = connect()
    try:
        tables = [r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )]
        print("\ngovernance tables:", tables)

        runs = conn.execute("SELECT COUNT(*) FROM monitor.pipeline_executions").fetchone()[0]
        cfgs = conn.execute("SELECT COUNT(*) FROM config.pipeline_config").fetchone()[0]
        print(f"ATTACH check -> monitor.pipeline_executions rows: {runs}, "
              f"config.pipeline_config rows: {cfgs}")

        # cross-DB join smoke test: runs joined to their category
        sample = conn.execute(
            """
            SELECT c.pipeline_category, COUNT(*) AS n
            FROM monitor.pipeline_executions e
            JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
            GROUP BY c.pipeline_category ORDER BY n DESC
            """
        ).fetchall()
        print("runs per category (cross-DB join):",
              {r["pipeline_category"]: r["n"] for r in sample})
    finally:
        conn.close()

    print("\nOK: governance.db ready and data DBs readable via ATTACH.")
