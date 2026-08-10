# Pipeline Catalog — Synthetic Fleet
## Capstone Project: Data Freshness Monitoring & Insights Agent

A fleet of **7 pharma commercial-analytics pipelines**, chosen for variety across
**category**, **cadence** (hourly → daily), and **criticality**.

---

## Table A — `pipeline_config` (the 8 fields stored in the DB)

> These are the only fields the monitoring agent is allowed to read.

| # | pipeline_name | category | criticality | owner_team | interval (min) | sla_min | fresh_hrs | description |
|---|---|---|---|---|---|---|---|---|
| 1 | `hcp_prescriber_data_sync` | CRM | **HIGH** | CRM Data Team | 1440 (daily) | 120 | 24 | Syncs HCP prescriber profiles & prescribing activity from Veeva CRM |
| 2 | `rx_claims_daily_load` | Claims | **HIGH** | Claims Data Team | 1440 (daily) | 180 | 26 | Daily retail-pharmacy prescription claims from IQVIA / payer feeds |
| 3 | `formulary_coverage_update` | Compliance | **HIGH** | Market Access | 720 (12h) | 90 | 24 | Updates plan / formulary drug-coverage & tier data |
| 4 | `sample_distribution_compliance` | Compliance | **HIGH** | Compliance | 1440 (daily) | 120 | 24 | Drug-sample distribution tracking for PDMA compliance |
| 5 | `field_force_call_activity` | Sales | MEDIUM | Sales Ops | 60 (hourly) | 45 | 4 | Field-rep call / visit & sample activity from CRM |
| 6 | `patient_adherence_refresh` | Patient | MEDIUM | Patient Analytics | 1440 (daily) | 150 | 24 | De-identified patient adherence & persistence metrics (HIPAA-safe) |
| 7 | `digital_engagement_etl` | Marketing | LOW | Digital Marketing | 360 (6h) | 120 | 24 | HCP digital engagement (email, web, rep-triggered) events |

**Distribution:** criticality **HIGH×4 / MEDIUM×2 / LOW×1**; categories CRM, Claims,
Compliance×2, Sales, Patient, Marketing; cadences hourly → daily.
The hourly `field_force_call_activity` keeps the live feed active; the daily
pipelines exercise freshness/SLA logic over longer windows.

---

## Table B — Generator-only parameters (simulator internals — NOT in the DB)

> The "true" typical duration/volume the simulator uses to produce realistic
> numbers. The agent must **not** see these — it *learns* volume baselines from
> history. Normal `duration` always sits under `sla_min` (positive headroom), so
> ordinary runs pass and only injected slow-runs/late-starts breach SLA.

| pipeline_name | duration (min) mean ± std | rows/run mean ± std | fragility* | SLA headroom |
|---|---|---|---|---|
| `hcp_prescriber_data_sync` | 45 ± 12 | 120k ± 25k | 1.2 | 75 min |
| `rx_claims_daily_load` | 90 ± 20 | 2.5M ± 300k | 1.0 | 90 min |
| `formulary_coverage_update` | 35 ± 10 | 80k ± 15k | 0.8 | 55 min |
| `sample_distribution_compliance` | 40 ± 12 | 30k ± 8k | 0.7 | 80 min |
| `field_force_call_activity` | 20 ± 6 | 40k ± 10k | 1.0 | 25 min |
| `patient_adherence_refresh` | 70 ± 18 | 900k ± 120k | 1.1 | 80 min |
| `digital_engagement_etl` | 50 ± 20 | 250k ± 60k | 1.5 | 70 min |

---

## Table C — Error codes by category

> On a failure, the generator picks a code from the pipeline's category pool and
> fills `error_code` + a matching `error_message`.

| category | error codes |
|---|---|
| CRM | `AUTH_FAIL`, `API_TIMEOUT`, `NULL_REF`, `DUPLICATE_KEY` |
| Claims | `FILE_NOT_FOUND`, `SCHEMA_MISMATCH`, `DB_TIMEOUT`, `PARSE_ERROR` |
| Compliance | `VALIDATION_ERROR`, `MISSING_REFERENCE`, `DB_TIMEOUT` |
| Sales | `API_TIMEOUT`, `RATE_LIMIT`, `NULL_REF` |
| Patient | `API_TIMEOUT`, `RATE_LIMIT`, `CONNECTION_RESET`, `HIPAA_MASK_FAIL` |
| Marketing | `RATE_LIMIT`, `HTTP_503`, `TOKEN_EXPIRED` |

---