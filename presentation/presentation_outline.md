# Presentation Outline — Data Freshness Monitoring & Insights Agent

**Target length:** 12 slides (easily trimmed to 10 — see note at the end).
**Two slides are the required deep-dives:** ⭐ Architecture and ⭐ Data Model.

---

## Key presentation decisions
- **Screenshots only — no live demo.** The app has many moving parts (generator + API + React); a live run risks a bug/port issue on stage. Curated screenshots show each page in its best state and keep the narrative controlled.
- **Governance is a story, not a button list.** Frame it as *AI proposes, human disposes* + an immutable audit trail — this also sets up the future LLM.
- **No code slides.** The panel cares about the idea and implementation, not source. Keep the tech stack to a tiny caption; spend the closing on future scope.

---

## Slide 1 — Title
- **Title:** Data Freshness Monitoring & Insights Agent
- **Capstone Project — Group 6** (no date)
- One-line tagline: *Proactive governance for a pharma commercial-analytics data platform*

## Slide 2 — The Problem / Business Challenge
- Stale, failed, and incomplete data loads go unnoticed **until business users complain** → operational inefficiency + loss of trust in the data platform
- Traditional monitoring = manual log-reading, purely reactive
- (Straight from the capstone brief)

## Slide 3 — Solution Overview
- What we built: a **real-time dashboard** that watches 7 pipelines, auto-detects violations, scores fleet health, and adds a **human-in-the-loop review + audit** workflow
- The value proposition in one line: *detect early, quantify health, act with governance*
- *(Presenter note: everything shown from here on is via screenshots — no live demo)*

## Slide 4 — ⭐ System Architecture *(required)*
- 3 independent components:
  - **synthetic_data/** (the world) → **backend/ FastAPI + detection agent** → **frontend/ React dashboard**
- They communicate **only** through 3 SQLite files + a REST API (HTTP polling, no message bus)
- Load-bearing rule: **one writer per database file** + WAL mode = zero write contention
- Runtime: 3 processes (generator, uvicorn API, Vite dev server)
- *Small footer caption only (not a code slide): Built with Python · FastAPI · SQLite · React + TypeScript · Recharts*

## Slide 5 — ⭐ Data Model *(required)*
- 3 SQLite databases:
  - `pipeline_config.db` → `pipeline_config` (static reference, 8 fields)
  - `monitor.db` → `pipeline_executions` (high-churn run log, 9 emitted + 2 derived)
  - `governance.db` → `violations` + `audit_log` (owned by backend)
- Key fields + join keys (`pipeline_name`, `run_id`)
- Philosophy: simulator emits **raw facts only**; `duration_minutes`/`run_date` are **derived at ingest**; volume baselines are **learned from history**
- *(Best shown as an ERD-style graphic)*

## Slide 6 — The 7-Pipeline Fleet
- The catalog table: category, criticality, cadence, SLA, freshness threshold
- Realistic pharma domain (CRM, Claims, Compliance, Sales, Patient, Marketing)
- Deliberate variety: cadence (hourly → daily), criticality (HIGH ×4 / MEDIUM ×2 / LOW ×1)

## Slide 7 — Synthetic Data Generation
- How "the world" is simulated:
  - **Two-layer randomness:** normal wobble (always on) vs. injected anomalies (rare)
  - **SLA headroom** so normal runs never breach by accident
  - **Failure clustering** so recurring failures emerge naturally
  - **Backfill (instant history) + compressed live phase** (~3600× → ~1,017 seeded runs)

## Slide 8 — The Detection Agent (7 Rules)
- SLA_BREACH · DELAYED_START · VOLUME_ANOMALY · FAILURE · RECURRING_FAILURE · MISSING_LOAD · FRESHNESS
- Rule-based today (the non-LLM "agent")
- Severity ladder (LOW < MEDIUM < HIGH < CRITICAL), bumped by pipeline criticality
- Deterministic `dedupe_key` → idempotent re-scans; background loop every 1s

## Slide 9 — KPIs, Analytics & Trends
- Headline KPIs: **health_score**, success rate, failure rate, SLA compliance, open violations
- Per-pipeline health rollup; daily trend time-series (successes/failures, SLA %, avg duration)
- All computed on-demand (always as fresh as your poll)
- *(Screenshot: Overview KPI strip + a trend chart)*

## Slide 10 — Dashboard Walkthrough (Screenshots)
- Curated **screenshots** of the 6 pages: Overview, Pipelines, Pipeline Detail, Executions, Violations, Audit
- Point out global filters + the live-polling design (described, shown via before/after stills — not demoed live)

## Slide 11 — Governance & Trust (Human-in-the-Loop)
- **Why it matters:** automated detection surfaces *candidates*; a human validates before anything is treated as truth → *AI proposes, human disposes* (this is also the foundation for the future LLM layer)
- **Violation lifecycle:** `open → reviewed | dismissed | escalated` (plus batch review of many at once)
- **Immutable audit trail:** every decision recorded (who / what / when), never pruned → accountability + compliance (critical in a regulated pharma context)
- *(Screenshot: Violations review action + the Audit log page)*

## Slide 12 — Future Scope & Roadmap
- **LLM / GenAI insights (headline):** natural-language executive summaries, root-cause indicators, risk assessment, recommended actions — the data contract is already designed; slots into the governance flow (AI drafts, human approves)
- **Scaling & real-time delivery:** connect to real orchestrators instead of synthetic data; production DB (e.g. Postgres) beyond SQLite; more pipelines / higher volume
  - *Polling vs. push (a deliberate trade-off):* polling was chosen on purpose — stateless, simple, self-healing. **First scaling lever = server-side caching** of the shared KPI/trend aggregates (all users see the same numbers) + horizontal scaling of stateless workers; this absorbs many users cheaply. If **low-latency push** becomes a requirement, **SSE fits better than WebSocket** (dashboard is read-mostly / one-directional; reviews stay plain POSTs). SSE only pays off with a data layer that has native change-notification (e.g., **Postgres LISTEN/NOTIFY**), since SQLite has no push mechanism — so it pairs with the data-layer upgrade above.
- **Roles & access control:** authentication, multi-user, RBAC (viewer / analyst / admin), per-team pipeline scoping
- **Enterprise integrations:** Airflow / Databricks / Azure Data Factory / Informatica connectors (the reusable-agent goal from the brief)
- **Proactive alerting:** email / Slack / PagerDuty on CRITICAL violations

---

### How to compress to 10 slides
- Merge **Slide 6 (Fleet)** into **Slide 7 (Data Generation)**
- Merge **Slide 9 (KPIs)** into **Slide 10 (Dashboard Walkthrough)**

### Design tips
- Keep the two ⭐ slides visually rich: redraw the ASCII architecture as clean boxes; render the data model as an ERD-style diagram
- **Screenshots only — no live demo.** Capture each page in a healthy, populated state; consider one "before/after review" pair to imply the live workflow without running it
- Position the LLM piece confidently as a **designed, planned next phase**, not as "missing"
- Use real numbers from the shipped snapshot (7 pipelines, ~1,017 runs, 907 SUCCESS / 110 FAILED) for credibility

### Anticipated panel questions (be ready)
- **"Why polling instead of WebSocket/SSE?"** → Stateless + self-healing at demo scale; the real scaling lever is caching shared aggregates + horizontal workers. SSE (not WebSocket) is the right push option later, and only once the data layer has native change-notification (Postgres LISTEN/NOTIFY) — SQLite can't push.
- **"Why SQLite?"** → Right-sized for the scope; WAL + one-writer-per-file removes contention. Clear migration path to Postgres for scale.
- **"Is the 'agent' really AI?"** → Today it's a deterministic rule engine (explainable, testable); the GenAI/LLM layer is the designed next phase and slots into the same human-in-the-loop flow.
- **"Isn't the data synthetic?"** → Yes, by design — it lets us reproduce every violation type on demand; the detection/KPIs/governance run identically on real orchestrator logs.

