"""
backend - the monitoring API layer.

Sits on top of the synthetic_data layer: reads pipeline_executions (monitor.db)
and pipeline_config (pipeline_config.db), detects violations, computes KPIs, and
serves everything over a small FastAPI REST API that the frontend polls.

Owns its own database: data/governance.db (violations + audit_log). The two data
DBs are only ever READ here - the simulator remains their sole writer.
"""
