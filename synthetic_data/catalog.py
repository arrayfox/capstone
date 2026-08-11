"""
catalog.py - the synthetic pipeline fleet (7 pharma-analytics pipelines).

Each Pipeline carries TWO kinds of data:
  1. 8 DB-visible config fields -> seeded into pipeline_config.db and readable
     by the monitoring agent (exposed via db_config()).
  2. generator-only params (mean/std duration, mean/std rows, fragility) ->
     used ONLY by generator.py to produce realistic numbers. These NEVER enter
     any database, because the agent is supposed to LEARN volume baselines from
     history rather than read them.

Also defines the per-category error pools (weighted) and their messages, used
when a run fails.

Run directly (`python synthetic_data/catalog.py`) to print a quick sanity check
of the fleet distribution + SLA headroom. This file imports nothing from the
package on purpose, so it stays runnable standalone.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Pipeline:
    # --- 8 DB-visible config fields (the only fields the agent may read) ---
    pipeline_name: str
    pipeline_category: str
    criticality: str
    owner_team: str
    schedule_interval_minutes: int
    sla_minutes: int
    freshness_threshold_hours: int
    description: str

    # --- generator-only params (simulator internals, never stored in a DB) ---
    mean_duration: float   # typical run length in minutes
    std_duration: float    # spread of run length
    mean_rows: float       # typical rows processed
    std_rows: float        # spread of rows processed
    fragility: float       # multiplier applied to every anomaly probability

    def db_config(self) -> dict:
        """Return ONLY the 8 DB-visible fields (drops the generator params)."""
        return {
            "pipeline_name": self.pipeline_name,
            "pipeline_category": self.pipeline_category,
            "criticality": self.criticality,
            "owner_team": self.owner_team,
            "schedule_interval_minutes": self.schedule_interval_minutes,
            "sla_minutes": self.sla_minutes,
            "freshness_threshold_hours": self.freshness_threshold_hours,
            "description": self.description,
        }


# ---------------------------------------------------------------------------
# The fleet - 7 pipelines. Fields follow the two catalog tables in the docs:
# first the 8 config fields, then the generator-only params (kept as keywords
# for readability).
# ---------------------------------------------------------------------------
PIPELINES = [
    Pipeline(
        "hcp_prescriber_data_sync", "CRM", "HIGH", "CRM Data Team",
        1440, 120, 24,
        "Syncs HCP prescriber profiles & prescribing activity from Veeva CRM",
        mean_duration=45, std_duration=12, mean_rows=120_000, std_rows=25_000, fragility=1.2,
    ),
    Pipeline(
        "rx_claims_daily_load", "Claims", "HIGH", "Claims Data Team",
        1440, 180, 26,
        "Daily retail-pharmacy prescription claims from IQVIA / payer feeds",
        mean_duration=90, std_duration=20, mean_rows=2_500_000, std_rows=300_000, fragility=1.0,
    ),
    Pipeline(
        "formulary_coverage_update", "Compliance", "HIGH", "Market Access",
        720, 90, 24,
        "Updates plan / formulary drug-coverage & tier data",
        mean_duration=35, std_duration=10, mean_rows=80_000, std_rows=15_000, fragility=0.8,
    ),
    Pipeline(
        "sample_distribution_compliance", "Compliance", "HIGH", "Compliance",
        1440, 120, 24,
        "Drug-sample distribution tracking for PDMA compliance",
        mean_duration=40, std_duration=12, mean_rows=30_000, std_rows=8_000, fragility=0.7,
    ),
    Pipeline(
        "field_force_call_activity", "Sales", "MEDIUM", "Sales Ops",
        60, 45, 4,
        "Field-rep call / visit & sample activity from CRM",
        mean_duration=20, std_duration=6, mean_rows=40_000, std_rows=10_000, fragility=1.0,
    ),
    Pipeline(
        "patient_adherence_refresh", "Patient", "MEDIUM", "Patient Analytics",
        1440, 150, 24,
        "De-identified patient adherence & persistence metrics (HIPAA-safe)",
        mean_duration=70, std_duration=18, mean_rows=900_000, std_rows=120_000, fragility=1.1,
    ),
    Pipeline(
        "digital_engagement_etl", "Marketing", "LOW", "Digital Marketing",
        360, 120, 24,
        "HCP digital engagement (email, web, rep-triggered) events",
        mean_duration=50, std_duration=20, mean_rows=250_000, std_rows=60_000, fragility=1.5,
    ),
]


# ---------------------------------------------------------------------------
# Error pools per category - {error_code: weight}. On failure the generator
# does a WEIGHTED draw from the pipeline's category pool (bigger weight = more
# common), so failures are contextually plausible. Weights are relative, not %.
# ---------------------------------------------------------------------------
ERROR_POOLS = {
    "CRM":        {"AUTH_FAIL": 30, "API_TIMEOUT": 40, "NULL_REF": 20, "DUPLICATE_KEY": 10},
    "Claims":     {"FILE_NOT_FOUND": 50, "SCHEMA_MISMATCH": 30, "DB_TIMEOUT": 15, "PARSE_ERROR": 5},
    "Compliance": {"VALIDATION_ERROR": 50, "MISSING_REFERENCE": 30, "DB_TIMEOUT": 20},
    "Sales":      {"API_TIMEOUT": 50, "RATE_LIMIT": 35, "NULL_REF": 15},
    "Patient":    {"API_TIMEOUT": 35, "RATE_LIMIT": 30, "CONNECTION_RESET": 20, "HIPAA_MASK_FAIL": 15},
    "Marketing":  {"RATE_LIMIT": 45, "HTTP_503": 35, "TOKEN_EXPIRED": 20},
}

# ---------------------------------------------------------------------------
# One human-readable message per error code (fills error_message on failure).
# ---------------------------------------------------------------------------
ERROR_MESSAGES = {
    "AUTH_FAIL":         "Authentication failed against source system",
    "API_TIMEOUT":       "Upstream API request timed out",
    "NULL_REF":          "Null reference encountered during transform",
    "DUPLICATE_KEY":     "Duplicate primary key detected during load",
    "FILE_NOT_FOUND":    "Expected source file was not found",
    "SCHEMA_MISMATCH":   "Source schema does not match the expected layout",
    "DB_TIMEOUT":        "Database connection pool exhausted / timed out",
    "PARSE_ERROR":       "Failed to parse a source record",
    "VALIDATION_ERROR":  "Record failed data-validation rules",
    "MISSING_REFERENCE": "Referenced lookup value is missing",
    "RATE_LIMIT":        "Rate limit exceeded on source API",
    "CONNECTION_RESET":  "Connection reset by peer",
    "HIPAA_MASK_FAIL":   "PII masking step failed",
    "HTTP_503":          "Source service unavailable (HTTP 503)",
    "TOKEN_EXPIRED":     "OAuth access token expired",
}


def get_pipeline_config_rows() -> list:
    """Return the 7 config rows (8 fields each) used to seed pipeline_config.db."""
    return [p.db_config() for p in PIPELINES]


# ---------------------------------------------------------------------------
# Quick sanity check when run directly: fleet distribution + SLA headroom.
# (SLA headroom = sla_minutes - mean_duration; it must stay positive so normal
#  runs comfortably pass and only injected slow-runs breach the SLA.)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    from collections import Counter

    print(f"Fleet: {len(PIPELINES)} pipelines\n")

    crit = Counter(p.criticality for p in PIPELINES)
    cats = Counter(p.pipeline_category for p in PIPELINES)
    print("Criticality:", dict(crit))
    print("Categories :", dict(cats))
    print()

    print(f"{'pipeline':32} {'mean_dur':>8} {'sla_min':>7} {'headroom':>8}")
    for p in PIPELINES:
        headroom = p.sla_minutes - p.mean_duration
        flag = "" if headroom > 0 else "   <-- WARNING: no SLA headroom!"
        print(f"{p.pipeline_name:32} {p.mean_duration:8} {p.sla_minutes:7} {headroom:8}{flag}")
