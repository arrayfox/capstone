"""
main.py - the FastAPI application (the whole REST surface in one place).

Endpoints (all read the ATTACHed DBs; writes only ever touch governance.db):
  GET  /health                      liveness
  GET  /kpis                        headline dashboard cards           ?window_days
  GET  /pipelines                   fleet + health rollup              ?category&criticality
  GET  /pipelines/{name}            one pipeline: config + recent runs + open violations
  GET  /runs                        filtered execution log             ?pipeline&category&status&date_from&date_to&limit&offset
  GET  /runs/recent                 newest runs across the fleet       ?limit
  GET  /violations                  filtered violations                ?pipeline&category&type&severity&status&date_from&date_to&limit&offset
  POST /violations/{id}/review      approve|dismiss|escalate -> audit  body: {action, reviewed_by, note}
  GET  /audit                       audit trail                        ?actor&action&entity&date_from&date_to&limit
  POST /detect                      manually trigger a detection scan
  GET  /report/{name}               STUB (LLM on hold - no Gemini key yet)

Lifespan: create governance.db, run one detection pass, then keep a background
thread re-scanning every DETECT_INTERVAL_SECONDS so violations stay current while
the simulator writes new runs. Single uvicorn worker => exactly one detector loop.
"""

import threading
from contextlib import asynccontextmanager


from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import database as db
from . import detection
from . import kpis

# How often the background detector re-scans for new violations.
# Kept intentionally LOWER than the frontend's POLL_SECONDS (its own knob, not
# tied to it): a user may refresh before the next poll tick, so the detector
# should always be a step ahead - this way violations are ready no matter when
# the dashboard fetches. The live /runs, /kpis and /pipelines endpoints don't
# depend on this at all (they compute on-demand). A full rescan of ~1k rows
# takes only a few ms, so a tight 1s loop is cheap.
DETECT_INTERVAL_SECONDS = 1


ALLOWED_REVIEW_ACTIONS = {"approve", "dismiss", "escalate"}
# review action -> resulting violation status
_ACTION_STATUS = {"approve": "reviewed", "dismiss": "dismissed", "escalate": "escalated"}


# ---------------------------------------------------------------------------
# Background detector loop
# ---------------------------------------------------------------------------
_stop = threading.Event()


def _detector_loop():
    while not _stop.is_set():
        try:
            detection.detect_all()
        except Exception as exc:  # never let the loop die silently
            print(f"[detector] error: {exc}")
        _stop.wait(DETECT_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_governance()
    summary = detection.detect_all()
    print(f"[startup] detection: {summary['new']} new violations "
          f"(scanned {summary['scanned']} runs)")
    thread = threading.Thread(target=_detector_loop, daemon=True, name="detector")
    thread.start()
    print(f"[startup] background detector every {DETECT_INTERVAL_SECONDS}s")
    yield
    _stop.set()
    print("[shutdown] detector stopped")


app = FastAPI(title="Pipeline Monitoring API", version="0.1.0", lifespan=lifespan)

# CORS: allow the frontend dev server (Vite default) to call us from the browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Small helper for building "WHERE a AND b" clauses from optional filters
# ---------------------------------------------------------------------------
def _where(conditions: list[str]) -> str:
    return (" WHERE " + " AND ".join(conditions)) if conditions else ""


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "service": "pipeline-monitoring-api"}


# ---------------------------------------------------------------------------
# KPIs
# ---------------------------------------------------------------------------
@app.get("/kpis")
def read_kpis(window_days: int = Query(7, ge=1, le=90)):
    return kpis.get_kpis(window_days)


# ---------------------------------------------------------------------------
# Trends (daily time-series for the Overview / Pipelines charts)
# ---------------------------------------------------------------------------
@app.get("/trends")
def read_trends(
    window_days: int = Query(30, ge=1, le=90),
    category: str | None = None,
    criticality: str | None = None,
    pipeline: str | None = None,
):
    return kpis.get_trends(window_days, category, criticality, pipeline)


# ---------------------------------------------------------------------------
# Violation analytics (KPIs + by-type pie + detection trend for the Violations page)
# ---------------------------------------------------------------------------
@app.get("/violations/stats")
def read_violation_stats(
    pipeline: str | None = None,
    category: str | None = None,
    status: str | None = None,
    window_days: int | None = Query(None, ge=1, le=90),
    date_from: str | None = None,
    date_to: str | None = None,
):
    return kpis.get_violation_stats(
        pipeline, category, status, window_days, date_from, date_to
    )


@app.get("/violations/trends")
def read_violation_trends(
    window_days: int = Query(30, ge=1, le=90),
    pipeline: str | None = None,
    category: str | None = None,
    type: str | None = None,
    severity: str | None = None,
    status: str | None = None,
):
    return kpis.get_violation_trends(
        window_days, pipeline, category, type, severity, status
    )



# ---------------------------------------------------------------------------
# Pipelines
# ---------------------------------------------------------------------------
@app.get("/pipelines")
def list_pipelines(
    category: str | None = None,
    criticality: str | None = None,
    window_days: int = Query(7, ge=1, le=90),
):
    health = kpis.get_pipeline_health(window_days)
    if category:
        health = [p for p in health if p["pipeline_category"] == category]
    if criticality:
        health = [p for p in health if p["criticality"] == criticality]
    return {"count": len(health), "items": health}


@app.get("/pipelines/{name}")
def get_pipeline(name: str, runs_limit: int = Query(20, ge=1, le=200)):
    cfg = db.fetch_one(
        "SELECT * FROM config.pipeline_config WHERE pipeline_name = ?", (name,)
    )
    if not cfg:
        raise HTTPException(status_code=404, detail=f"Unknown pipeline: {name}")
    recent = db.fetch_all(
        """
        SELECT run_id, scheduled_time, actual_start_time, end_time, status,
               rows_processed, error_code, error_message, duration_minutes
        FROM monitor.pipeline_executions
        WHERE pipeline_name = ?
        ORDER BY scheduled_time DESC LIMIT ?
        """,
        (name, runs_limit),
    )
    open_violations = db.fetch_all(
        """
        SELECT id, run_id, violation_type, severity, detected_at, details, status
        FROM violations
        WHERE pipeline_name = ? AND status = 'open'
        ORDER BY detected_at DESC
        """,
        (name,),
    )
    return {"config": cfg, "recent_runs": recent, "open_violations": open_violations}


# ---------------------------------------------------------------------------
# Runs (filtered execution log)
# ---------------------------------------------------------------------------
@app.get("/runs")
def list_runs(
    pipeline: str | None = None,
    category: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    conds, params = [], []
    if pipeline:
        conds.append("e.pipeline_name = ?"); params.append(pipeline)
    if category:
        conds.append("c.pipeline_category = ?"); params.append(category)
    if status:
        conds.append("e.status = ?"); params.append(status)
    if date_from:
        conds.append("e.scheduled_time >= ?"); params.append(date_from)
    if date_to:
        conds.append("e.scheduled_time <= ?"); params.append(date_to)

    total = db.fetch_one(
        f"""
        SELECT COUNT(*) AS n
        FROM monitor.pipeline_executions e
        JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
        {_where(conds)}
        """,
        tuple(params),
    )["n"]

    items = db.fetch_all(
        f"""
        SELECT e.run_id, e.pipeline_name, c.pipeline_category, e.scheduled_time,
               e.actual_start_time, e.end_time, e.status, e.rows_processed,
               e.error_code, e.error_message, e.duration_minutes
        FROM monitor.pipeline_executions e
        JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
        {_where(conds)}
        ORDER BY e.scheduled_time DESC
        LIMIT ? OFFSET ?
        """,
        tuple(params) + (limit, offset),
    )
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@app.get("/runs/recent")
def recent_runs(limit: int = Query(20, ge=1, le=200)):
    items = db.fetch_all(
        """
        SELECT e.run_id, e.pipeline_name, c.pipeline_category, e.scheduled_time,
               e.actual_start_time, e.end_time, e.status, e.rows_processed,
               e.error_code, e.duration_minutes
        FROM monitor.pipeline_executions e
        JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
        ORDER BY e.scheduled_time DESC LIMIT ?
        """,
        (limit,),
    )
    return {"count": len(items), "items": items}


# ---------------------------------------------------------------------------
# Violations (filtered) + review action
# ---------------------------------------------------------------------------
@app.get("/violations")
def list_violations(
    pipeline: str | None = None,
    category: str | None = None,
    type: str | None = None,
    severity: str | None = None,
    status: str | None = "open",
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    conds, params = [], []
    if pipeline:
        conds.append("v.pipeline_name = ?"); params.append(pipeline)
    if category:
        conds.append("c.pipeline_category = ?"); params.append(category)
    if type:
        conds.append("v.violation_type = ?"); params.append(type)
    if severity:
        conds.append("v.severity = ?"); params.append(severity)
    if status:
        conds.append("v.status = ?"); params.append(status)
    if date_from:
        conds.append("v.detected_at >= ?"); params.append(date_from)
    if date_to:
        conds.append("v.detected_at <= ?"); params.append(date_to)

    total = db.fetch_one(
        f"""
        SELECT COUNT(*) AS n
        FROM violations v
        JOIN config.pipeline_config c ON c.pipeline_name = v.pipeline_name
        {_where(conds)}
        """,
        tuple(params),
    )["n"]

    items = db.fetch_all(
        f"""
        SELECT v.id, v.pipeline_name, c.pipeline_category, c.criticality,
               v.run_id, v.violation_type, v.severity, v.detected_at, v.details,
               v.status, v.reviewed_by, v.reviewed_at, v.note
        FROM violations v
        JOIN config.pipeline_config c ON c.pipeline_name = v.pipeline_name
        {_where(conds)}
        ORDER BY v.detected_at DESC
        LIMIT ? OFFSET ?
        """,
        tuple(params) + (limit, offset),
    )
    return {"total": total, "limit": limit, "offset": offset, "items": items}


class ReviewRequest(BaseModel):
    action: str = Field(..., description="approve | dismiss | escalate")
    reviewed_by: str = Field("analyst", description="who performed the review")
    note: str | None = Field(None, description="optional reviewer note")


@app.post("/violations/{violation_id}/review")
def review_violation(violation_id: int, body: ReviewRequest):
    if body.action not in ALLOWED_REVIEW_ACTIONS:
        raise HTTPException(
            status_code=422,
            detail=f"action must be one of {sorted(ALLOWED_REVIEW_ACTIONS)}",
        )
    existing = db.fetch_one("SELECT * FROM violations WHERE id = ?", (violation_id,))
    if not existing:
        raise HTTPException(status_code=404, detail=f"No violation with id {violation_id}")

    new_status = _ACTION_STATUS[body.action]
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE violations SET status=?, reviewed_by=?, reviewed_at=?, note=? WHERE id=?",
            (new_status, body.reviewed_by, db.now_iso(), body.note, violation_id),
        )
        conn.commit()
    finally:
        conn.close()

    db.record_audit(
        actor=body.reviewed_by,
        action=f"review:{body.action}",
        entity_type="violation",
        entity_id=str(violation_id),
        details=(f"{existing['violation_type']} on {existing['pipeline_name']} "
                 f"-> {new_status}" + (f"; note: {body.note}" if body.note else "")),
    )
    return {"id": violation_id, "status": new_status, "reviewed_by": body.reviewed_by}


# ---------------------------------------------------------------------------
# Audit trail
# ---------------------------------------------------------------------------
@app.get("/audit")
def list_audit(
    actor: str | None = None,
    action: str | None = None,
    entity: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    conds, params = [], []
    if actor:
        conds.append("actor = ?"); params.append(actor)
    if action:
        conds.append("action LIKE ?"); params.append(f"%{action}%")
    if entity:
        conds.append("entity_type = ?"); params.append(entity)
    if date_from:
        conds.append("timestamp >= ?"); params.append(date_from)
    if date_to:
        conds.append("timestamp <= ?"); params.append(date_to)

    items = db.fetch_all(
        f"""
        SELECT id, timestamp, actor, action, entity_type, entity_id, details
        FROM audit_log
        {_where(conds)}
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
        """,
        tuple(params) + (limit,),
    )
    return {"count": len(items), "items": items}


# ---------------------------------------------------------------------------
# Manual detection trigger (handy for demos / tests)
# ---------------------------------------------------------------------------
@app.post("/detect")
def trigger_detection():
    return detection.detect_all()


# ---------------------------------------------------------------------------
# Report - STUB (LLM on hold until a Gemini API key is available)
# ---------------------------------------------------------------------------
@app.get("/report/{name}")
def get_report(name: str):
    cfg = db.fetch_one(
        "SELECT pipeline_name FROM config.pipeline_config WHERE pipeline_name = ?", (name,)
    )
    if not cfg:
        raise HTTPException(status_code=404, detail=f"Unknown pipeline: {name}")
    open_n = db.fetch_one(
        "SELECT COUNT(*) AS n FROM violations WHERE pipeline_name=? AND status='open'",
        (name,),
    )["n"]
    return {
        "pipeline_name": name,
        "generated": False,
        "reason": "LLM summarization is on hold (no Gemini API key configured).",
        "open_violations": open_n,
        "placeholder": (f"[LLM report pending] {name} currently has {open_n} open "
                        f"violation(s). A natural-language summary will appear here "
                        f"once the LLM step is enabled."),
    }
