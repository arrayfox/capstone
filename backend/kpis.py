"""
kpis.py - dashboard aggregate metrics.

Pure read-only SELECTs over the ATTACHed DBs (monitor + config + governance).
Everything is scoped to a rolling window (default 7 days) measured from the
newest scheduled_time in the data ("data now"), so numbers stay stable when the
simulator is paused.

Exposes:
  * get_kpis(window_days)      - the headline cards (health, SLA%, failure%, ...)
  * get_pipeline_health()      - per-pipeline status roll-up for a table/heatmap

Run standalone:  python -m backend.kpis
"""

from datetime import datetime, timedelta

from . import database as db

_TS = "%Y-%m-%d %H:%M:%S"


def _data_now() -> datetime:
    row = db.fetch_one("SELECT MAX(scheduled_time) AS m FROM monitor.pipeline_executions")
    return datetime.strptime(row["m"], _TS) if row and row["m"] else datetime.now()


def _window_start(window_days: int) -> str:
    return (_data_now() - timedelta(days=window_days)).strftime(_TS)


def get_kpis(window_days: int = 7) -> dict:
    """Headline KPI cards over the last `window_days` of data."""
    since = _window_start(window_days)

    totals = db.fetch_one(
        """
        SELECT
            COUNT(*)                                             AS total_runs,
            SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END)    AS successes,
            SUM(CASE WHEN status='FAILED'  THEN 1 ELSE 0 END)    AS failures
        FROM monitor.pipeline_executions
        WHERE scheduled_time >= ?
        """,
        (since,),
    )
    total = totals["total_runs"] or 0
    successes = totals["successes"] or 0
    failures = totals["failures"] or 0

    # SLA compliance + "clean run" rate among finished runs in-window.
    # A clean run = SUCCESS and within SLA -> the basis for health_score.
    sla = db.fetch_one(
        """
        SELECT
            COUNT(*)                                                       AS finished,
            SUM(CASE WHEN e.duration_minutes <= c.sla_minutes THEN 1 ELSE 0 END) AS within_sla,
            SUM(CASE WHEN e.status='SUCCESS' AND e.duration_minutes <= c.sla_minutes
                     THEN 1 ELSE 0 END)                                    AS clean_runs
        FROM monitor.pipeline_executions e
        JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
        WHERE e.scheduled_time >= ? AND e.duration_minutes IS NOT NULL
        """,
        (since,),
    )
    finished = sla["finished"] or 0
    within_sla = sla["within_sla"] or 0
    clean_runs = sla["clean_runs"] or 0

    # Open violations backlog (all-time) - the current review queue.
    open_viol = db.fetch_one(
        "SELECT COUNT(*) AS n FROM violations WHERE status='open'"
    )["n"]
    open_by_sev = {
        r["severity"]: r["n"]
        for r in db.fetch_all(
            "SELECT severity, COUNT(*) AS n FROM violations "
            "WHERE status='open' GROUP BY severity"
        )
    }
    # "Pipelines with issues" is scoped to the window (recent problems), so it
    # reflects current health rather than the full-history backlog.
    pipelines_with_issues = db.fetch_one(
        "SELECT COUNT(DISTINCT pipeline_name) AS n FROM violations "
        "WHERE status='open' AND detected_at >= ?",
        (since,),
    )["n"]
    total_pipelines = db.fetch_one(
        "SELECT COUNT(*) AS n FROM config.pipeline_config"
    )["n"]

    success_rate = round(100.0 * successes / total, 1) if total else 100.0
    failure_rate = round(100.0 * failures / total, 1) if total else 0.0
    sla_compliance = round(100.0 * within_sla / finished, 1) if finished else 100.0
    healthy_pipelines = total_pipelines - pipelines_with_issues
    # Health = share of in-window runs that were clean (succeeded AND met SLA).
    # Always meaningful and never stuck at 0 the way an all-time count would be.
    health_score = round(100.0 * clean_runs / finished, 1) if finished else 100.0


    return {
        "window_days": window_days,
        "data_now": _data_now().strftime(_TS),
        "total_runs": total,
        "success_rate": success_rate,
        "failure_rate": failure_rate,
        "sla_compliance": sla_compliance,
        "health_score": health_score,
        "total_pipelines": total_pipelines,
        "healthy_pipelines": healthy_pipelines,
        "pipelines_with_issues": pipelines_with_issues,
        "open_violations": open_viol,
        "open_violations_by_severity": open_by_sev,
    }


def get_pipeline_health(window_days: int = 7) -> list[dict]:
    """Per-pipeline roll-up: run counts, SLA, freshness, open-violation count."""
    since = _window_start(window_days)
    data_now = _data_now()

    rows = db.fetch_all(
        """
        SELECT
            c.pipeline_name, c.pipeline_category, c.criticality, c.sla_minutes,
            c.freshness_threshold_hours,
            COUNT(e.run_id)                                                   AS runs,
            SUM(CASE WHEN e.status='SUCCESS' THEN 1 ELSE 0 END)               AS successes,
            SUM(CASE WHEN e.status='FAILED'  THEN 1 ELSE 0 END)               AS failures,
            SUM(CASE WHEN e.duration_minutes > c.sla_minutes THEN 1 ELSE 0 END) AS sla_breaches,
            MAX(CASE WHEN e.status='SUCCESS' THEN e.end_time END)             AS last_success
        FROM config.pipeline_config c
        LEFT JOIN monitor.pipeline_executions e
               ON e.pipeline_name = c.pipeline_name AND e.scheduled_time >= ?
        GROUP BY c.pipeline_name
        ORDER BY c.pipeline_name
        """,
        (since,),
    )

    open_counts = {
        r["pipeline_name"]: r["n"]
        for r in db.fetch_all(
            "SELECT pipeline_name, COUNT(*) AS n FROM violations "
            "WHERE status='open' GROUP BY pipeline_name"
        )
    }

    out = []
    for r in rows:
        last_success = r["last_success"]
        stale_h = None
        if last_success:
            stale_h = round(
                (data_now - datetime.strptime(last_success, _TS)).total_seconds() / 3600.0, 1
            )
        is_fresh = (stale_h is not None) and (stale_h <= r["freshness_threshold_hours"])
        open_n = open_counts.get(r["pipeline_name"], 0)

        out.append({
            "pipeline_name": r["pipeline_name"],
            "pipeline_category": r["pipeline_category"],
            "criticality": r["criticality"],
            "runs": r["runs"] or 0,
            "successes": r["successes"] or 0,
            "failures": r["failures"] or 0,
            "sla_breaches": r["sla_breaches"] or 0,
            "last_success": last_success,
            "hours_since_success": stale_h,
            "is_fresh": is_fresh,
            "open_violations": open_n,
            "status": "healthy" if open_n == 0 else "issues",
        })
    return out


def get_trends(
    window_days: int = 30,
    category: str | None = None,
    criticality: str | None = None,
    pipeline: str | None = None,
) -> dict:
    """Daily time-series for the Overview/Pipelines charts.

    One row per calendar day in-window, carrying every aggregate the trend
    charts need: run counts (successes/failures -> stacked bar), SLA compliance
    % (line), and average duration (line). The optional filters mirror the
    dashboard's top controls; omit them (or pass "all") for the whole fleet.
    Days with no runs simply don't appear - the frontend can gap-fill if wanted.
    """
    since = _window_start(window_days)
    conds = ["e.scheduled_time >= ?"]
    params: list = [since]
    if category and category.lower() != "all":
        conds.append("c.pipeline_category = ?"); params.append(category)
    if criticality and criticality.lower() != "all":
        conds.append("c.criticality = ?"); params.append(criticality)
    if pipeline and pipeline.lower() != "all":
        conds.append("e.pipeline_name = ?"); params.append(pipeline)

    rows = db.fetch_all(
        f"""
        SELECT
            date(e.scheduled_time)                                          AS day,
            COUNT(*)                                                        AS total,
            SUM(CASE WHEN e.status='SUCCESS' THEN 1 ELSE 0 END)             AS successes,
            SUM(CASE WHEN e.status='FAILED'  THEN 1 ELSE 0 END)             AS failures,
            SUM(CASE WHEN e.duration_minutes IS NOT NULL THEN 1 ELSE 0 END) AS finished,
            SUM(CASE WHEN e.duration_minutes IS NOT NULL
                     AND e.duration_minutes <= c.sla_minutes
                     THEN 1 ELSE 0 END)                                     AS within_sla,
            AVG(e.duration_minutes)                                         AS avg_duration
        FROM monitor.pipeline_executions e
        JOIN config.pipeline_config c ON c.pipeline_name = e.pipeline_name
        WHERE {' AND '.join(conds)}
        GROUP BY day
        ORDER BY day
        """,
        tuple(params),
    )

    series = []
    for r in rows:
        finished = r["finished"] or 0
        series.append({
            "date": r["day"],
            "total": r["total"] or 0,
            "successes": r["successes"] or 0,
            "failures": r["failures"] or 0,
            "sla_compliance": round(100.0 * r["within_sla"] / finished, 1) if finished else None,
            "avg_duration": round(r["avg_duration"], 1) if r["avg_duration"] is not None else None,
        })
    return {"window_days": window_days, "bucket": "day", "series": series}


def get_violation_stats(
    pipeline: str | None = None,
    category: str | None = None,
    status: str | None = None,
    window_days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict:
    """Aggregate violation counts for the Violations page KPIs + by-type pie.

    Scoped by pipeline / category / status / time, then broken down BY type and
    BY severity. The `type`/`severity` page filters are intentionally NOT applied
    here so the breakdown always stays complete (a type pie that hides types
    would be meaningless). Returns a total plus both breakdowns as dicts.
    """
    conds = ["1=1"]
    params: list = []
    if window_days:
        conds.append("v.detected_at >= ?"); params.append(_window_start(window_days))
    if date_from:
        conds.append("v.detected_at >= ?"); params.append(date_from)
    if date_to:
        conds.append("v.detected_at <= ?"); params.append(date_to)
    if pipeline and pipeline.lower() != "all":
        conds.append("v.pipeline_name = ?"); params.append(pipeline)
    if category and category.lower() != "all":
        conds.append("c.pipeline_category = ?"); params.append(category)
    if status and status.lower() != "all":
        conds.append("v.status = ?"); params.append(status)

    base_from = (
        " FROM violations v "
        " JOIN config.pipeline_config c ON c.pipeline_name = v.pipeline_name "
        " WHERE " + " AND ".join(conds)
    )

    total = db.fetch_one(f"SELECT COUNT(*) AS n {base_from}", tuple(params))["n"]
    by_type = {
        r["violation_type"]: r["n"]
        for r in db.fetch_all(
            f"SELECT v.violation_type, COUNT(*) AS n {base_from} GROUP BY v.violation_type",
            tuple(params),
        )
    }
    by_severity = {
        r["severity"]: r["n"]
        for r in db.fetch_all(
            f"SELECT v.severity, COUNT(*) AS n {base_from} GROUP BY v.severity",
            tuple(params),
        )
    }
    return {"total": total or 0, "by_type": by_type, "by_severity": by_severity}


def get_violation_trends(
    window_days: int = 30,
    pipeline: str | None = None,
    category: str | None = None,
    type: str | None = None,
    severity: str | None = None,
    status: str | None = None,
) -> dict:
    """Daily count of violations detected, honoring all Violations page filters.

    One row per calendar day in-window with the number of violations detected
    that day. Unlike get_violation_stats this DOES honor type/severity/status,
    because the trend chart is meant to reflect exactly what the table shows.
    """
    since = _window_start(window_days)
    conds = ["v.detected_at >= ?"]
    params: list = [since]
    if pipeline and pipeline.lower() != "all":
        conds.append("v.pipeline_name = ?"); params.append(pipeline)
    if category and category.lower() != "all":
        conds.append("c.pipeline_category = ?"); params.append(category)
    if type and type.lower() != "all":
        conds.append("v.violation_type = ?"); params.append(type)
    if severity and severity.lower() != "all":
        conds.append("v.severity = ?"); params.append(severity)
    if status and status.lower() != "all":
        conds.append("v.status = ?"); params.append(status)

    rows = db.fetch_all(
        f"""
        SELECT date(v.detected_at) AS day, COUNT(*) AS count
        FROM violations v
        JOIN config.pipeline_config c ON c.pipeline_name = v.pipeline_name
        WHERE {' AND '.join(conds)}
        GROUP BY day
        ORDER BY day
        """,
        tuple(params),
    )
    series = [{"date": r["day"], "count": r["count"] or 0} for r in rows]
    return {"window_days": window_days, "bucket": "day", "series": series}


if __name__ == "__main__":


    db.init_governance()
    print("KPIs (7-day window):")
    for k, v in get_kpis().items():
        print(f"  {k:28} {v}")

    print("\nPer-pipeline health:")
    hdr = f"  {'pipeline':32} {'runs':>4} {'ok':>4} {'fail':>4} {'sla_brk':>7} {'fresh':>5} {'open':>4}"
    print(hdr)
    for p in get_pipeline_health():
        print(f"  {p['pipeline_name']:32} {p['runs']:4} {p['successes']:4} "
              f"{p['failures']:4} {p['sla_breaches']:7} {str(p['is_fresh']):>5} "
              f"{p['open_violations']:4}")
