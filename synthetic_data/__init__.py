"""
synthetic_data - data layer of the Data Freshness Monitoring & Insights Agent.

Generates realistic synthetic pipeline-execution logs and stores them in
SQLite. Package layout (each module is one responsibility):

    config.py     - every tunable knob (probabilities, magnitudes, clock, paths)
    catalog.py    - the 7-pipeline fleet: config fields + generator-only params
    db.py         - create/seed both DBs, insert runs, prune old history
    generator.py  - generate_run(): one dynamic run (two-layer randomness)
    simulator.py  - clock engine: backfill + live loop + periodic prune
    __main__.py   - entry point: python -m synthetic_data
"""
