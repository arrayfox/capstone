"""
detection.py - the rule-based "agent" that turns raw runs into violations.

Reads (never writes) monitor.pipeline_executions + config.pipeline_config through
the ATTACHed connection in database.py, applies six checks, and upserts the
results into governance.db (deduped, so re-scans are idempotent).

The six checks map 1:1 to what the generator injects (see backend_plan.md §4):

  1. SLA_BREACH        duration_minutes  > sla_minutes
  2. DELAYED_START     actual_start - scheduled > DELAYED_START_THRESHOLD_MIN
  3. VOLUME_ANOMALY    rows outside mean ± K*std of the last N successful runs
                       (baseline is LEARNED from history, not read from config)
  4. FAILURE           status = 'FAILED'
  5. RECURRING_FAILURE >= N failures for a pipeline within a rolling window
  6. MISSING_LOAD      a scheduled slot has no row (gap between consecutive runs)
  7. FRESHNESS         newest success older than freshness_threshold_hours

"data now" for absence/staleness checks (MISSING_LOAD, FRESHNESS) is the newest
scheduled_time in the dataset (a "high-water mark"), not wall-clock - so the
checks behave sensibly even when the simulator is paused.

Run standalone to see a summary:  python -m backend.detection
"""

import statistics
from collections import Counter
from datetime import datetime, timedelta

from . import database as db

# ---------------------------------------------------------------------------
# Tunable thresholds (kept here so detection can be re-tuned in one place).
# ---------------------------------------------------------------------------
DELAYED_START_THRESHOLD_MIN = 15    # normal jitter ~N(2,2); injected delays are 30-120
VOLUME_BASELINE_N           = 20    # how many prior successful runs form the baseline
VOLUME_MIN_HISTORY          = 8     # need at least this many priors to judge
VOLUME_K                    = 3.0   # flag if |rows - mean| > K * std
RECURRING_FAILURE_MIN       = 3     # >= this many fails in the window -> recurring
RECURRING_WINDOW_DAYS       = 7
MISSING_LOAD_GAP_FACTOR     = 1.5   # a gap > interval*this means a slot was skipped

_TS = "%Y-%m-%d %H:%M:%S"
_SEV_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]

# Base severity per violation type, before adjusting for pipeline criticality.
_BASE_SEVERITY = {
    "SLA_BREACH": "MEDIUM",
    "DELAYED_START": "LOW",
    "VOLUME_ANOMALY": "MEDIUM",
    "FAILURE": "HIGH",
    "RECURRING_FAILURE": "HIGH",
    "MISSING_LOAD": "HIGH",
    "FRESHNESS": "MEDIUM",
}


def _dt(value):
    """Parse a stored timestamp string into a datetime (None-safe)."""
    if not value:
        return None
    return datetime.strptime(value, _TS)


def _severity(vtype: str, criticality: str) -> str:
    """Base severity bumped up for HIGH-criticality pipelines, down for LOW."""
    idx = _SEV_ORDER.index(_BASE_SEVERITY[vtype])
    if criticality == "HIGH":
        idx += 1
    elif criticality == "LOW":
        idx -= 1
    idx = max(0, min(len(_SEV_ORDER) - 1, idx))
    return _SEV_ORDER[idx]


# ---------------------------------------------------------------------------
# Load everything the checks need, once.
# ---------------------------------------------------------------------------
def _load():
    """Return (configs, executions, data_now)."""
    configs = {
        c["pipeline_name"]: c
        for c in db.fetch_all("SELECT * FROM config.pipeline_config")
    }
    executions = db.fetch_all(
        """
        SELECT run_id, pipeline_name, scheduled_time, actual_start_time, end_time,
               status, rows_processed, error_code, error_message,
               duration_minutes, run_date
        FROM monitor.pipeline_executions
        ORDER BY pipeline_name, scheduled_time
        """
    )
    hw = db.fetch_one("SELECT MAX(scheduled_time) AS m FROM monitor.pipeline_executions")
    data_now = _dt(hw["m"]) if hw and hw["m"] else datetime.now()
    return configs, executions, data_now


def _by_pipeline(executions):
    """Group the already-sorted executions by pipeline_name."""
    groups: dict[str, list] = {}
    for e in executions:
        groups.setdefault(e["pipeline_name"], []).append(e)
    return groups


# ---------------------------------------------------------------------------
# The individual checks - each returns a list of violation dicts.
# ---------------------------------------------------------------------------
def _check_sla(executions, configs):
    out = []
    for e in executions:
        cfg = configs.get(e["pipeline_name"])
        dur = e["duration_minutes"]
        if not cfg or dur is None:
            continue
        if dur > cfg["sla_minutes"]:
            out.append({
                "dedupe_key": f"SLA_BREACH:{e['run_id']}",
                "pipeline_name": e["pipeline_name"],
                "run_id": e["run_id"],
                "violation_type": "SLA_BREACH",
                "severity": _severity("SLA_BREACH", cfg["criticality"]),
                "detected_at": e["end_time"] or e["scheduled_time"],
                "details": f"Ran {dur:.0f} min vs SLA {cfg['sla_minutes']} min",
            })
    return out


def _check_delayed_start(executions, configs):
    out = []
    for e in executions:
        cfg = configs.get(e["pipeline_name"])
        start, sched = _dt(e["actual_start_time"]), _dt(e["scheduled_time"])
        if not cfg or start is None or sched is None:
            continue
        delay = (start - sched).total_seconds() / 60.0
        if delay > DELAYED_START_THRESHOLD_MIN:
            out.append({
                "dedupe_key": f"DELAYED_START:{e['run_id']}",
                "pipeline_name": e["pipeline_name"],
                "run_id": e["run_id"],
                "violation_type": "DELAYED_START",
                "severity": _severity("DELAYED_START", cfg["criticality"]),
                "detected_at": e["actual_start_time"],
                "details": f"Started {delay:.0f} min after schedule",
            })
    return out


def _check_volume(groups, configs):
    """Learned baseline: mean +/- K*std over the last N successful runs."""
    out = []
    for name, runs in groups.items():
        cfg = configs.get(name)
        if not cfg:
            continue
        history: list[float] = []   # prior successful volumes, in time order
        for e in runs:
            if e["status"] != "SUCCESS" or e["rows_processed"] is None:
                continue
            rows = float(e["rows_processed"])
            if len(history) >= VOLUME_MIN_HISTORY:
                window = history[-VOLUME_BASELINE_N:]
                mean = statistics.fmean(window)
                std = statistics.pstdev(window)
                if std > 0 and abs(rows - mean) > VOLUME_K * std:
                    direction = "dip" if rows < mean else "spike"
                    out.append({
                        "dedupe_key": f"VOLUME_ANOMALY:{e['run_id']}",
                        "pipeline_name": name,
                        "run_id": e["run_id"],
                        "violation_type": "VOLUME_ANOMALY",
                        "severity": _severity("VOLUME_ANOMALY", cfg["criticality"]),
                        "detected_at": e["end_time"] or e["scheduled_time"],
                        "details": (f"Volume {direction}: {int(rows):,} rows vs "
                                    f"baseline ~{int(mean):,} (+/-{int(std):,})"),
                    })
            history.append(rows)
    return out


def _check_failures(executions, configs):
    out = []
    for e in executions:
        cfg = configs.get(e["pipeline_name"])
        if not cfg or e["status"] != "FAILED":
            continue
        code = e["error_code"] or "UNKNOWN"
        msg = e["error_message"] or ""
        out.append({
            "dedupe_key": f"FAILURE:{e['run_id']}",
            "pipeline_name": e["pipeline_name"],
            "run_id": e["run_id"],
            "violation_type": "FAILURE",
            "severity": _severity("FAILURE", cfg["criticality"]),
            "detected_at": e["end_time"] or e["scheduled_time"],
            "details": f"{code}: {msg}" if msg else code,
        })
    return out


def _check_recurring(groups, configs, data_now):
    """>= N failures for one pipeline within the rolling window -> one rollup."""
    out = []
    window_start = data_now - timedelta(days=RECURRING_WINDOW_DAYS)
    for name, runs in groups.items():
        cfg = configs.get(name)
        if not cfg:
            continue
        fails = [e for e in runs
                 if e["status"] == "FAILED" and _dt(e["scheduled_time"]) >= window_start]
        if len(fails) < RECURRING_FAILURE_MIN:
            continue
        codes = Counter(e["error_code"] or "UNKNOWN" for e in fails)
        top_code, top_n = codes.most_common(1)[0]
        latest = max(fails, key=lambda e: e["scheduled_time"])
        out.append({
            "dedupe_key": f"RECURRING_FAILURE:{name}:{latest['run_date']}",
            "pipeline_name": name,
            "run_id": latest["run_id"],
            "violation_type": "RECURRING_FAILURE",
            "severity": _severity("RECURRING_FAILURE", cfg["criticality"]),
            "detected_at": latest["end_time"] or latest["scheduled_time"],
            "details": (f"{len(fails)} failures in {RECURRING_WINDOW_DAYS}d; "
                        f"mostly {top_code} ({top_n})"),
        })
    return out


def _check_missing_load(groups, configs):
    """A gap between consecutive scheduled runs bigger than one interval."""
    out = []
    for name, runs in groups.items():
        cfg = configs.get(name)
        if not cfg:
            continue
        interval = timedelta(minutes=cfg["schedule_interval_minutes"])
        threshold = interval * MISSING_LOAD_GAP_FACTOR
        prev = None
        for e in runs:
            sched = _dt(e["scheduled_time"])
            if prev is not None and sched - prev > threshold:
                # enumerate each skipped slot between prev and this run
                slot = prev + interval
                while slot < sched - (interval / 2):
                    out.append({
                        "dedupe_key": f"MISSING_LOAD:{name}:{slot.strftime(_TS)}",
                        "pipeline_name": name,
                        "run_id": None,
                        "violation_type": "MISSING_LOAD",
                        "severity": _severity("MISSING_LOAD", cfg["criticality"]),
                        "detected_at": slot.strftime(_TS),
                        "details": f"No run for scheduled slot {slot:%Y-%m-%d %H:%M}",
                    })
                    slot += interval
            prev = sched
    return out


def _check_freshness(groups, configs, data_now):
    """Newest successful load older than the pipeline's freshness threshold."""
    out = []
    for name, runs in groups.items():
        cfg = configs.get(name)
        if not cfg:
            continue
        successes = [e for e in runs if e["status"] == "SUCCESS"]
        if not successes:
            continue
        latest = max(successes, key=lambda e: e["scheduled_time"])
        ref = _dt(latest["end_time"]) or _dt(latest["scheduled_time"])
        stale_h = (data_now - ref).total_seconds() / 3600.0
        if stale_h > cfg["freshness_threshold_hours"]:
            out.append({
                "dedupe_key": f"FRESHNESS:{name}:{latest['run_id']}",
                "pipeline_name": name,
                "run_id": latest["run_id"],
                "violation_type": "FRESHNESS",
                "severity": _severity("FRESHNESS", cfg["criticality"]),
                "detected_at": data_now.strftime(_TS),
                "details": (f"Last successful load {stale_h:.0f}h ago vs "
                            f"{cfg['freshness_threshold_hours']}h threshold"),
            })
    return out


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def detect_all() -> dict:
    """
    Run every check and upsert results. Returns a summary:
      {"scanned": <runs>, "new": <newly inserted>, "by_type": {type: new_count}}
    Idempotent: dedupe_key means re-running only inserts genuinely new violations.
    """
    configs, executions, data_now = _load()
    groups = _by_pipeline(executions)

    found = []
    found += _check_sla(executions, configs)
    found += _check_delayed_start(executions, configs)
    found += _check_volume(groups, configs)
    found += _check_failures(executions, configs)
    found += _check_recurring(groups, configs, data_now)
    found += _check_missing_load(groups, configs)
    found += _check_freshness(groups, configs, data_now)

    new_by_type: Counter = Counter()
    for v in found:
        if db.upsert_violation(v):
            new_by_type[v["violation_type"]] += 1

    return {
        "scanned": len(executions),
        "found": len(found),
        "new": sum(new_by_type.values()),
        "by_type": dict(new_by_type),
    }


if __name__ == "__main__":
    db.init_governance()
    summary = detect_all()
    print("Detection run complete:")
    print(f"  runs scanned : {summary['scanned']}")
    print(f"  matches found: {summary['found']}")
    print(f"  new inserted : {summary['new']}")
    print(f"  new by type  : {summary['by_type']}")

    total = db.fetch_one("SELECT COUNT(*) AS n FROM violations")["n"]
    dist = db.fetch_all(
        "SELECT violation_type, severity, COUNT(*) AS n FROM violations "
        "GROUP BY violation_type, severity ORDER BY n DESC"
    )
    print(f"\nviolations table now holds {total} rows:")
    for r in dist:
        print(f"  {r['violation_type']:18} {r['severity']:9} {r['n']}")
