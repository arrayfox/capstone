# Synthetic Data Schema Design (v3 — lean)
## Capstone Project: Data Freshness Monitoring & Insights Agent

> **v3 = the trimmed model** we agreed on for the 3-4 day build. It still powers
> every project requirement, with ~40% fewer fields than v2.
>
> **Guiding principle:** the simulator emits only **raw facts**. Anything
> derivable (`duration_minutes`, `run_date`) is computed **at ingest** and stored.
> Anything learnable (volume baselines) is computed **from history** by the agent —
> not hardcoded in config.
>
> **Changed from v2 → v3**
> - **Dropped from the log:** `rows_failed`, `triggered_by`, `environment`
>   (decorative / not core), and `pipeline_category` (moved to config where it
>   belongs).
> - **`run_date` & `duration_minutes`:** no longer *emitted* — derived at ingest.
> - **Dropped from config:** `expected_frequency` (redundant with
>   `schedule_interval_minutes`), `sla_deadline` (absolute time), `max_duration_minutes`
>   (overlapped with SLA), and all `expected_rows_min/max/avg`.
> - **Volume baseline is now learned from history** (last N runs), not stored.
> - **SLA simplified to ONE rule:** `end_time > scheduled_time + sla_minutes`.
> - **`violations`** slimmed to an append-only event log; pipeline state / KPIs are
>   computed at query time.

---

## How Requirements Map to Data

| Project Requirement | What Powers It |
|---------------------|----------------|
| Detect freshness violations | last successful `end_time` + `freshness_threshold_hours` |
| Identify delayed loads | `scheduled_time` vs `actual_start_time` |
| Identify missing loads | no run within `schedule_interval_minutes` window |
| Analyze historical patterns | `duration_minutes` over time per pipeline |
| Recognize recurring issues | `error_code` repeated over time |
| SLA compliance | `end_time` vs (`scheduled_time` + `sla_minutes`) |
| Volume anomalies | `rows_processed` vs **learned** rolling baseline |
| Trend analysis | `duration_minutes` + `failure_rate` over weeks |
| Historical comparisons | `run_date` grouping (7d vs 30d) |
| Executive summaries (LLM) | aggregated KPIs + active violations |
| Root-cause indicators | `error_code`, `error_message` patterns |
| Human-in-the-loop | `is_reviewed`, `reviewer_action` in `violations` |
| Audit logs | `audit_log` table |
| Dashboard health cards | KPIs (`success_rate`, `sla_rate`, `freshness_rate`, `health_score`) |

---

## Table 1: `pipeline_executions` (raw log — the ONLY thing the simulator emits)

> One row = one pipeline run.

### Emitted by the simulator (9 fields)

| Field | Type | Example | What It Does |
|-------|------|---------|--------------|
| `run_id` | string | `RUN_20260806_001` | Unique ID per execution (primary key) |
| `pipeline_name` | string | `hcp_prescriber_data_sync` | Which pipeline ran (join key to config) |
| `scheduled_time` | datetime | `2026-08-06 06:00:00` | When it was supposed to start |
| `actual_start_time` | datetime | `2026-08-06 06:45:00` | When it actually started → delayed-load signal |
| `end_time` | datetime | `2026-08-06 07:52:00` | When it finished. **Always set, even on FAILED** (the failure moment). NULL only if `RUNNING`. |
| `status` | string | `SUCCESS`, `FAILED` | Core outcome (`SKIPPED`, `RUNNING` optional) |
| `rows_processed` | int | `84500` | How many records the run delivered → volume anomalies |
| `error_code` | string | `DB_TIMEOUT`, `NULL_REF`, `AUTH_FAIL` | Categorized error → powers recurring-issue detection (NULL if SUCCESS) |
| `error_message` | string | `"Connection pool exhausted"` | Free-text detail → GenAI root-cause (NULL if SUCCESS) |

### Derived at ingest and stored alongside (NOT emitted)

| Field | Type | How Computed |
|-------|------|-------------|
| `duration_minutes` | float | `end_time − actual_start_time` (NULL while RUNNING) |
| `run_date` | date | `date(scheduled_time)` — for easy grouping |

---

## Table 2: `pipeline_config` (static reference — one row per pipeline)

> Defines what "good" looks like. Lives in the DB from the start; never streamed.

| Field | Type | Example | What It Does |
|-------|------|---------|--------------|
| `pipeline_name` | string | `hcp_prescriber_data_sync` | Links to executions |
| `pipeline_category` | string | `CRM`, `Claims`, `Compliance`, `Reporting` | Group pipelines on dashboard |
| `criticality` | string | `HIGH`, `MEDIUM`, `LOW` | Prioritize alerts; drives `severity`; LLM context |
| `owner_team` | string | `DataOps`, `CRM Team` | Who to notify (recommendations) |
| `schedule_interval_minutes` | int | `1440` (daily), `60`, `15` | Cadence → missing-load + freshness math |
| `sla_minutes` | int | `120` | **The SLA rule**: run must finish within N min of `scheduled_time` |
| `freshness_threshold_hours` | int | `24` | Max acceptable data age |
| `description` | string | `Syncs HCP prescriber data from source CRM` | Plain-English purpose → GenAI context |

> **Volume baseline is NOT stored here** — the agent learns it from each pipeline's
> recent `rows_processed` history (see below).

---

## The SLA check (one simple rule)

```
deadline   = scheduled_time + sla_minutes
sla_missed = end_time > deadline          # FAILED or MISSING runs = auto-missed
breach_min = max(0, end_time - deadline)  # how late, in minutes
```

Example — `scheduled_time = 06:00`, `sla_minutes = 120` → **deadline 08:00**:

| Run | end_time | Result |
|---|---|---|
| A | 07:45 | ✅ met (15 min spare) |
| B | 08:30 | ❌ missed by 30 min |
| C | FAILED | ❌ missed (no data delivered) |
| D | never ran | ❌ missed (missing load) |

Works for every cadence (hourly / daily / 15-min) — no absolute deadline needed.

---

## Volume anomaly (learned baseline, no config field)

```
recent        = last ~20 runs of this pipeline
baseline_mean = avg(recent.rows_processed)
if rows_processed < 0.5 * baseline_mean → LOW_VOLUME   (upstream data missing?)
if rows_processed > 2.0 * baseline_mean → HIGH_VOLUME  (duplicate / spike?)
```

Mirrors how real data-observability tools baseline volume from history. (Needs a
short warm-up before it's meaningful — fine, since we seed some history first.)

---

## Table 3: `violations` (append-only event log — what the agent detected)

> One row per detected issue. `is_reviewed` / `reviewer_action` are the only fields
> that get updated (by the human-in-the-loop). Pipeline state & KPIs are computed
> at query time, not stored here.

| Field | Type | What It Does |
|-------|------|--------------|
| `violation_id` | int | Primary key |
| `pipeline_name` | string | Which pipeline |
| `run_id` | string | Related run (NULL for freshness / missing-load) |
| `violation_type` | string | `FRESHNESS`, `SLA_BREACH`, `MISSING_LOAD`, `DELAYED_START`, `RECURRING_FAILURE`, `VOLUME_ANOMALY` |
| `severity` | string | `HIGH` / `MEDIUM` / `LOW` (from `criticality` + type) |
| `detail` | string | Human/LLM-readable description |
| `detected_at` | datetime | When the agent flagged it (sim-clock) |
| `is_reviewed` | bool | Human-in-the-loop (default False) |
| `reviewer_action` | string | `APPROVED` / `DISMISSED` / `ESCALATED` (NULL until reviewed) |

### Computed at query time (NOT stored)

| Value | How Computed | Powers |
|-------|-------------|--------|
| `data_age_hours` | `now − last_success_end_time` | Freshness card |
| `freshness_status` | `data_age_hours > freshness_threshold_hours` | Freshness alert |
| `start_delay_minutes` | `actual_start_time − scheduled_time` | Delayed-load signal |
| `is_missing_load` | no run within `schedule_interval_minutes` | Missing-load alert |
| `failure_rate` | failed ÷ total (window) | Reliability KPI |
| `duration_trend` | avg duration 7d vs 30d | Degradation detection |

---

## Table 4: `audit_log` (governance — immutable "who did what, when")

> Append-only. Every AI report and every human review action is recorded.

| Field | Type | Purpose |
|-------|------|---------|
| `log_id` | int | Unique ID |
| `event_type` | string | `REPORT_GENERATED`, `FINDING_APPROVED`, `FINDING_DISMISSED`, `FINDING_ESCALATED` |
| `triggered_by` | string | `AGENT` or `USER` |
| `entity_id` | string | Which violation or report this relates to |
| `summary` | string | Brief description of what happened |
| `timestamp` | datetime | When it happened |

Example:

| log_id | event_type | triggered_by | entity_id | summary | timestamp |
|---|---|---|---|---|---|
| 1 | `REPORT_GENERATED` | `AGENT` | `report_2026-08-07` | Weekly exec summary, 10 pipelines | 2026-08-07 08:00 |
| 2 | `FINDING_APPROVED` | `USER` | `violation_42` | Confirmed SLA breach on prescriber sync | 2026-08-07 09:15 |
| 3 | `FINDING_DISMISSED` | `USER` | `violation_43` | Volume dip — known holiday | 2026-08-07 09:20 |

---

## KPIs (computed on the fly — dashboard hero + LLM context)

Rolling window (e.g. last 24h / 7d of sim-time):

- `success_rate` — successes ÷ scheduled (missing loads count against it)
- `sla_compliance_rate` — runs finishing within `sla_minutes`
- `freshness_compliance_rate` — pipelines within their freshness threshold
- `failure_count`, `avg_duration`
- `health_score` (0–100) — weighted blend → one headline number

---

## What to Send to Gemini (LLM context — NOT raw rows)

> A compact structured summary keeps it fast, cheap, and focused.

```json
{
  "period": "Aug 1 - Aug 7, 2026",
  "total_pipelines": 10,
  "total_runs": 68,
  "health_score": 74,
  "overall_success_rate": "78%",
  "sla_compliance_rate": "71%",
  "freshness_compliance_rate": "80%",

  "active_violations": [
    {
      "pipeline": "hcp_prescriber_data_sync",
      "category": "CRM",
      "criticality": "HIGH",
      "violation_type": "SLA_BREACH",
      "detail": "Finished 135 min after its 120-min SLA.",
      "occurrences_this_week": 3
    },
    {
      "pipeline": "rx_claims_daily_load",
      "category": "Claims",
      "criticality": "HIGH",
      "violation_type": "MISSING_LOAD",
      "detail": "No successful run in 38 hours (threshold 24h)."
    },
    {
      "pipeline": "formulary_compliance_update",
      "category": "Compliance",
      "criticality": "MEDIUM",
      "violation_type": "RECURRING_FAILURE",
      "detail": "Failed 4 times this week with DB_TIMEOUT.",
      "error_code": "DB_TIMEOUT"
    }
  ],

  "performance_trends": {
    "pipelines_getting_slower": [
      { "pipeline": "patient_segmentation_refresh", "avg_7d": "52m", "avg_30d": "28m", "change": "+85%" }
    ],
    "failure_rate_trend": "12% → 22% over last 7 days"
  },

  "pipeline_descriptions": {
    "hcp_prescriber_data_sync": "Syncs healthcare professional prescribing data from CRM",
    "rx_claims_daily_load": "Daily load of prescription claims from payer feeds"
  }
}
```

> Gemini returns: executive summary, root-cause indicators, risk assessment, and
> recommended actions.

---

## Frontend Dashboard Needs

| Component | Fields It Uses |
|-----------|----------------|
| **Health Overview Cards** | `success_rate`, `sla_compliance_rate`, `freshness_compliance_rate`, `health_score`, `total_violations` |
| **Live Log Feed** (SSE/WebSocket) | streaming `pipeline_executions` rows as they arrive |
| **Violations Table** | `pipeline_name`, `violation_type`, `severity`, `detected_at`, `detail`, `is_reviewed` |
| **SLA Trend Chart** | `run_date`, SLA status grouped by date |
| **Duration Trend Chart** | `run_date`, `pipeline_name`, `duration_minutes` |
| **Failure Rate Chart** | `run_date`, `status` |
| **Pipeline Detail View** | full run history of one pipeline |
| **AI Report Page** | Gemini output + `generated_at` + `period` |
| **Audit Log Page** | `event_type`, `entity_id`, `summary`, `timestamp`, `triggered_by` |
| **Human Review Panel** | violations where `is_reviewed = False` → approve / dismiss / escalate |

---

## Summary: the minimum the simulator emits

```
run_id, pipeline_name, scheduled_time, actual_start_time,
end_time, status, rows_processed, error_code, error_message
```

Ingest derives `duration_minutes` + `run_date`. `pipeline_config` supplies the
SLA / freshness / schedule thresholds. Everything else — violations, freshness,
trends, volume baselines, KPIs — is **computed by the agent**.
