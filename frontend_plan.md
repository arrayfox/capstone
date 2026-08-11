# Frontend Plan — Pipeline Monitoring Dashboard

Status: **approved, ready to build**. Backend is complete; this plans the UI on top of it.
Guiding constraints (from discussion): **granular updates (no full-page reload),
smooth & fast, uncluttered, professional/restrained visuals, few but useful pages.**

Locked decisions: **React 19 (latest)** · **light theme** · **separate full pages**
(Overview, Pipelines, Executions, Violations, Audit) — pipeline detail is its own
page, not a drawer · **no Settings page** (auto-refresh lives in the top bar).

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 19 (latest) + Vite + TypeScript** | reactive → only changed values re-render (no page reload); type-safe against the API |
| Data fetching | **TanStack Query** (react-query) | background polling, cache, "re-render only what changed"; `refetchInterval` = auto-refresh |
| Charts | **Recharts** | clean, declarative, professional defaults, low chartjunk |
| Routing | **React Router** | 5 pages + `/pipelines/:name` detail |
| State (global filters) | **Zustand** | tiny store for the shared top-bar controls |
| Styling | **CSS variables + lightweight utility CSS** (no heavy UI kit) | full control over the restrained look; small/fast bundle |
| Icons | **lucide-react** | minimal, consistent line icons |

CORS on the API already allows `http://localhost:5173` (Vite default).

---

## 2. Visual system (light, professional, not colorful)

- **Light theme.** App background `#f7f8fa`, cards white `#ffffff` with subtle `#e5e7eb` borders, text `#111827` / muted `#6b7280`.
- **One accent:** muted indigo `#4f5bd5`, for interactive/selected states only.
- **Semantic colors used *only* for status/severity**, never decoration:
  - success `#16a34a` · failed `#dc2626` · warning/amber `#d97706` · neutral gray
  - severity: CRITICAL red · HIGH amber · MEDIUM slate · LOW gray
- Status shown as **small dots/badges**, not big color blocks.
- Generous whitespace, one font (Inter/system), 2 weights, tabular numerals for metrics.
- Subtle borders over drop-shadows; no gradients.

---

## 3. Global layout & the "no reload" mechanism

- **Left sidebar nav** (5 items) + **top bar** with global controls:
  - Time range, Pipeline category, Criticality, Status — each with an **"All"** option
  - **Auto-refresh toggle + interval** (replaces a Settings page); default from `POLL_SECONDS` (5s)
  - "Last updated" indicator + manual refresh button
- Global controls live in a small Zustand store and feed every query's params.
- **Granular updates:** TanStack Query polls in the background at the chosen interval;
  React reconciles so only changed numbers/rows/segments update — the page never reloads.

---

## 4. Pages (5 full pages)

### A. Overview  *(decluttered — 2 charts max here)*
- **Top:** global filters (category / criticality / status / time range, all with "All") + auto-refresh.
- **KPI strip** (`/kpis`): Total pipelines, Health score, SLA compliance, Failure rate, Open violations.
- **Chart 1 — SLA compliance trend** (line, `/trends` → `sla_compliance`).
- **Chart 2 — Run status over time** (stacked bar, `/trends` → `successes`/`failures`).
  - Note: only **SUCCESS/FAILED** exist (verified). No "skipped" status. "Missing loads"
    are surfaced separately as a **MISSING_LOAD** stat/violation, not mixed into this bar.
- **Top 5 risky pipelines** (`/pipelines` sorted by open violations + criticality) → "View all" → Pipelines.
- **Recent violations** (`/violations?status=open&limit=5`) → "View all" → Violations.
- **AI insights panel:** present but **disabled/"on hold"** placeholder (LLM deferred).
- *Moved off Overview to reduce clutter:* avg-duration chart → Pipeline detail.

### B. Pipelines  *(list page → its own detail page at `/pipelines/:name`)*
- **List:** all 7 pipelines as a sortable/filterable table (status dot, category, criticality,
  freshness, SLA breaches, open violations). Feeds from `/pipelines`.
- **Detail page** (`/pipelines/{name}` + `/trends?pipeline=`):
  - KPIs: health, freshness (hours since success), SLA.
  - **Error distribution pie** (from that pipeline's recent runs' `error_code` — 9 codes verified).
  - **Failure trend** (line, `/trends?pipeline=` → failures).
  - **Avg duration trend** (line, `/trends?pipeline=` → avg_duration).  ← moved here from Overview.
  - Recent executions, recent open violations, and **Pipeline information** (config block).
  - LLM report area = disabled placeholder for now.

### C. Executions  *(the run log, for investigation)*
- Filters: pipeline, category, status, date range + **pagination** (`/runs` with `limit`/`offset`/`total`).
- Columns: pipeline, category, scheduled/start/end, status badge, rows processed, duration, error code+message.
- Row click → run detail (its config context + any violations from that `run_id`).
- A compact "live tail" of newest runs (`/runs/recent`) that streams in via polling.

### D. Violations  *(the governance workspace — core value)*
- Filters: pipeline, category, type, severity, status (default `open`).
- Table with restrained severity badges; shows details, detected_at, current status.
- **Inline actions: approve / dismiss / escalate** (+ optional note) → `POST /violations/{id}/review`.
  - Row updates **in place** (optimistic update, then revalidate) — no reload.
  - Each action writes to the audit trail automatically (backend does this).

### E. Audit  *(compliance record)*
- Read-only trail of every review action (`/audit`), filters: actor, action, entity, date range.
- Columns: timestamp, actor, action (review:approve/dismiss/escalate), entity, details.

---

## 5. API usage map (all endpoints already exist & verified)

| UI element | Endpoint |
|---|---|
| KPI strip | `GET /kpis?window_days` |
| Trend charts (SLA/status/duration/failures) | `GET /trends?window_days&category&criticality&pipeline` |
| Pipelines list + Top-5 | `GET /pipelines?category&criticality` |
| Pipeline detail | `GET /pipelines/{name}` |
| Executions table + live tail | `GET /runs?...` , `GET /runs/recent` |
| Violations table | `GET /violations?...` |
| Review action | `POST /violations/{id}/review` |
| Audit table | `GET /audit?...` |
| (deferred) AI report | `GET /report/{name}` (stub) |

---

## 6. Deferred
- **AI insights / LLM report** — UI slot reserved and visibly "on hold" until a Gemini key exists.
- Auth — none (single-user local tool). If ever exposed, add before deploying.

---

## 7. Build order
1. Scaffold Vite + React 19 + TS, install deps, design tokens + layout shell (sidebar/top bar + global filters/auto-refresh).
2. API client + typed hooks + polling.
3. Overview (KPIs + 2 charts + top-5 + recent violations).
4. Violations (table + inline review) — highest value.
5. Executions (table + filters + pagination + live tail).
6. Pipelines (list → detail page with pie + trends).
7. Audit.
8. Polish: empty/loading/error states, responsive, a11y (labels, contrast, keyboard).
