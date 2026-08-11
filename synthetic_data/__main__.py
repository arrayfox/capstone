"""
__main__.py - entry point for the data layer.

Run with:  python -m synthetic_data

Sequence:
  1. open + create both SQLite databases (db.init),
  2. seed the 7 static pipeline_config rows (db.seed_config),
  3. backfill BACKFILL_DAYS of history instantly,
  4. stream live runs in compressed time until Ctrl-C.

This is intentionally thin - all real work lives in the modules. Later phases
(FastAPI etc.) can import Simulator and run backfill()/run_live() themselves
instead of going through this script.
"""

from . import db
from .simulator import Simulator


def main():
    # 1 + 2: databases ready and config seeded before any run is generated.
    db.init()
    db.seed_config()

    # Start each session from a clean execution log. The backfill below always
    # covers "the last BACKFILL_DAYS up to now", so keeping a previous run's
    # rows would stack an overlapping history and double the runs per day.
    db.reset_executions()
    print(f"Databases ready. pipeline_config rows: {db.config_count()}. "
          f"Execution log cleared for a fresh backfill.\n")

    sim = Simulator()

    # 3: instant history.
    sim.backfill()


    # 4: live feed (blocks until Ctrl-C).
    print()
    sim.run_live()

    db.close()


if __name__ == "__main__":
    main()
