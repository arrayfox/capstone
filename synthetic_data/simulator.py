"""
simulator.py - the schedule-driven simulated clock.

This is the engine that turns single runs (generator.generate_run) into a full
stream of history + live data landing in SQLite. It owns:
  * per-pipeline state: next_run time, last_status, last_error (for clustering),
  * the sim-clock and the two phases (backfill then live),
  * skipping runs (MISSING_LOAD) and pruning old rows once per sim-day.

Two phases (see data_generation_design.md):
  Phase 1 - BACKFILL: start the clock BACKFILL_DAYS in the past and walk it to
            "now" with no waiting, generating every due run -> instant history.
  Phase 2 - LIVE: from now on, advance the clock by TIME_COMPRESSION each real
            TICK_SECONDS and fire due runs at a watchable pace.

Time model: everything uses naive datetimes. "real now" is only read once at
construction to anchor the timeline; after that the sim-clock drives everything.
"""

import random
import time
from datetime import datetime, timedelta

from . import config
from . import catalog
from . import db
from .generator import generate_run


class Simulator:
    def __init__(self):
        # Anchor the whole timeline to a single "now" and seed the RNG once so
        # a run of the simulator is reproducible.
        random.seed(config.SEED)
        self.real_start = datetime.now().replace(microsecond=0)

        # Per-pipeline state. next_run starts BACKFILL_DAYS in the past so the
        # backfill loop has history to walk through.
        backfill_start = self.real_start - timedelta(days=config.BACKFILL_DAYS)
        self.state = {}
        for p in catalog.PIPELINES:
            self.state[p.pipeline_name] = {
                "next_run": backfill_start,
                "last_status": None,
                "last_error": None,
            }

        # Track the sim-day we last pruned on, so we prune exactly once per day.
        self._last_prune_day = backfill_start.date()

    # ------------------------------------------------------------------
    # Firing due runs
    # ------------------------------------------------------------------
    def _fire_due_runs(self, pipeline, sim_now, collect=None):
        """
        Fire every run for one pipeline that is due at/before sim_now, advancing
        its schedule as we go. If `collect` (a list) is given, runs are appended
        to it for a later bulk insert (backfill); otherwise each run is inserted
        immediately (live).
        """
        st = self.state[pipeline.pipeline_name]
        interval = timedelta(minutes=pipeline.schedule_interval_minutes)

        while st["next_run"] <= sim_now:
            scheduled = st["next_run"]

            # MISSING_LOAD: sometimes the scheduler just doesn't fire this cycle.
            # We still advance next_run, so the run is genuinely absent (a gap
            # the agent can later detect) - and we don't touch last_status.
            if random.random() < config.MISSING_LOAD_PROB * pipeline.fragility:
                st["next_run"] += interval
                continue

            run = generate_run(pipeline, scheduled, st["last_status"], st["last_error"])
            if collect is not None:
                collect.append(run)
            else:
                db.insert_run(run)

            # Remember outcome for the next run's clustering decision.
            st["last_status"] = run["status"]
            st["last_error"] = run["error_code"]
            st["next_run"] += interval

    def _maybe_prune(self, sim_now):
        """Prune old executions once per simulated day (cheap + natural)."""
        if sim_now.date() > self._last_prune_day:
            removed = db.prune_old(sim_now)
            self._last_prune_day = sim_now.date()
            if removed:
                print(f"  [prune] removed {removed} rows older than "
                      f"{config.RETENTION_DAYS} days (sim {sim_now:%Y-%m-%d})")

    # ------------------------------------------------------------------
    # Phase 1 - backfill (instant)
    # ------------------------------------------------------------------
    def backfill(self):
        """
        Generate all history from BACKFILL_DAYS ago up to real_start, with no
        waiting, and bulk-insert it in one go. Gives the agent instant history.
        """
        print(f"Backfilling {config.BACKFILL_DAYS} days of history "
              f"(up to {self.real_start:%Y-%m-%d %H:%M})...")

        runs = []
        for p in catalog.PIPELINES:
            # Walk this pipeline's schedule all the way to now in one shot.
            self._fire_due_runs(p, self.real_start, collect=runs)

        # Insert in time order so the table reads naturally / ids sort sensibly.
        runs.sort(key=lambda r: r["scheduled_time"])
        db.insert_runs(runs)
        print(f"Backfill complete: inserted {len(runs)} runs "
              f"(total in DB: {db.execution_count()}).")

    # ------------------------------------------------------------------
    # Phase 2 - live (compressed real-time)
    # ------------------------------------------------------------------
    def run_live(self):
        """
        Advance the sim-clock by TIME_COMPRESSION every TICK_SECONDS and fire due
        runs as time passes. Runs until interrupted (Ctrl-C).
        """
        print(f"Going live: 1 real sec = {config.TIME_COMPRESSION} sim sec. "
              f"Ctrl-C to stop.\n")
        sim_now = self.real_start
        try:
            while True:
                time.sleep(config.TICK_SECONDS)
                sim_now += timedelta(seconds=config.TIME_COMPRESSION * config.TICK_SECONDS)

                for p in catalog.PIPELINES:
                    self._fire_due_runs(p, sim_now)   # insert immediately

                self._maybe_prune(sim_now)
        except KeyboardInterrupt:
            print(f"\nStopped at sim-time {sim_now:%Y-%m-%d %H:%M}. "
                  f"Total runs in DB: {db.execution_count()}.")
