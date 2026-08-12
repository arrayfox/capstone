# Frontend Modification Plan — LLM Report + Observability
## Capstone Project: Data Freshness Monitoring & Insights Agent

> **Companion to** `llm_report_plan.md` (the backend/observability plan). This
> document lists only the **frontend** changes needed to surface the LLM report
> and its run-trace observability.
>
> **Current state (verified, unchanged):** the frontend has thin plumbing only —
> `api.report(name)`, a `useReport()` hook (defined but **not used by any page**),
> and a `ReportStub` type that models only the *stub* shape. The "AI insights /
> AI report" areas on Overview and Pipeline Detail are **static "On hold"
> banners**. There is **no** support for a generated report's contents and **no**
> observability (LLM-runs) surface at all.
>
> The work splits into two tracks: **(A) show the report** and **(B) show the
> run traces**. Track A is small; track B is the larger, more valuable piece.

---

## 1. Guiding principles

- **Backward-compatible rendering.** The report area must handle three states
  from the same endpoint: *generating/loading*, *generated* (show the sections),
  and *not generated* (keep today's "On hold"/placeholder banner). The stub shape
  stays valid, so nothing breaks when the LLM is disabled.
- **Reuse existing patterns.** Follow the app's established conventions — the
  typed `request()` client, TanStack Query hooks bound to the shared poll
  interval, the `Card` / `EmptyState` / `ErrorState` / badge UI primitives, and
  the existing filter/store wiring — so the new screens look and behave like the
  rest of the dashboard.
- **Observability is a first-class page.** The LLM-runs viewer isn't an
  afterthought; it's the most compelling demonstration that the agent is
  transparent and debuggable. Treat it like the Audit page in structure.
- **Don't over-poll the LLM.** The report call should not ride the aggressive
  5-second poll the way live metrics do; it changes rarely and (on the backend)
  is cached. Refresh it gently, or on demand via a regenerate action.

---

## 2. Types to add (`frontend/src/lib/types.ts`)

- **Generated report type.** Extend the report contract so it can represent a
  *real* report, not just the stub: add the four content sections (executive
  summary, root-cause indicators as a list, risk assessment, recommended actions
  as a list), plus metadata the backend returns (a generated flag, the run id,
  a generated-at timestamp, and the model name). Keep the existing stub fields so
  the "not generated" branch still type-checks. Model it as a discriminated shape
  keyed on the "generated" flag so the UI can switch cleanly.
- **LLM-run summary type** (for the list view): run id, entity type, entity id,
  status, stage, model, token totals, duration, and start time.
- **LLM-run detail type** (for the single-run view): everything in the summary
  plus the stored context, system/user prompts, raw response, parsed output, stop
  reason, and the failure fields (error type, message, traceback).
- **List response wrappers** mirroring the existing pattern (a count/items shape
  like the audit and violations responses).

---

## 3. API client changes (`frontend/src/lib/api.ts`)

- **Update the report wrapper's return type** to the new report type (generated
  or stub), keeping the same call.
- **Add a regenerate call** (optional): a POST to force a fresh report.
- **Add the observability calls:** a list call for LLM runs (with filters for
  entity and status and a limit) and a detail call for a single run id.
- Add a matching **filters interface** for the runs list (entity, status, limit),
  consistent with the existing filter interfaces.

---

## 4. Hooks (`frontend/src/lib/hooks.ts`)

- **Rework `useReport`.** It exists but isn't used. Keep it, but give it a gentle
  refresh cadence (not the aggressive live-metrics interval) so a freshly
  generated report appears without hammering the API.
- **Add a regenerate mutation** (optional): on success, invalidate the report
  query for that pipeline (and, since generating writes an audit entry, invalidate
  the audit query too so the trail updates).
- **Add observability hooks:** one for the LLM-runs list (bound to the shared poll
  interval like the other tables) and one for a single run detail (enabled only
  when an id is selected, matching the `usePipeline`/`useReport` enabled pattern).

---

## 5. Report slot changes (Pipeline Detail + Overview)

- **Wire the slot to the hook.** Replace the hardcoded "On hold" banner in the
  Pipeline Detail "AI report" card with a component that calls `useReport(name)`
  and renders by state:
  - *Loading:* the existing skeleton/loading treatment.
  - *Generated:* render the four sections — a short executive summary paragraph,
    a bulleted root-cause indicators list, a risk-assessment line/badge, and a
    recommended-actions list — inside the existing `Card`, plus small metadata
    (generated-at, model) and, if exposed, a **Regenerate** button.
  - *Not generated / disabled / error:* keep today's "On hold" placeholder
    (optionally with a small "diagnostics" link to the run id when one exists).
- **Overview banner:** apply the same treatment, or intentionally keep it as a
  lighter teaser that links to the per-pipeline report. Decide one behavior and
  keep it consistent.
- **New presentational pieces** (in the shared components): a compact "report
  sections" renderer and, optionally, a small status/stage badge reused by the
  observability page. Keep them dumb/presentational so they're easy to test.

---

## 6. Observability: the "LLM Runs" page (new, the centerpiece)

Model it closely on the existing **Audit** page so it inherits the app's look and
filter behavior.

- **Routing & navigation:** add a new route and a sidebar/nav entry (e.g. under an
  "Agent" or "System" grouping). Consider gating its visibility on whether the
  feature is enabled, but it's also fine to always show it (empty state when no
  runs exist).
- **List view:** a filterable table (by entity and status, with a limit), one row
  per run showing status, stage, pipeline/entity, model, tokens, duration, and
  time. Failed runs should be visually distinct (a red status badge) so problems
  stand out at a glance. Rows are clickable.
- **Detail view:** opening a run shows the **full trace** — the stored context,
  the system and user prompts, the parsed output (or the placeholder if none), the
  raw response, token/timing metadata, and, for failures, the error type, message,
  and full traceback. Use collapsible sections and monospace/preformatted blocks
  for the long JSON/traceback fields so it's readable.
- **States:** reuse the existing loading (skeleton), empty ("no runs yet"), and
  error components for consistency.

---

## 7. Cross-cutting / consistency

- **Formatting:** reuse the existing formatters for timestamps and durations;
  add a small token-count formatter if desired. Keep the "parse timestamps as
  stored, no timezone shift" convention the app already follows.
- **Labels/constants:** add any new status/stage labels to the shared constants
  file rather than hardcoding strings in components.
- **Error handling:** rely on the shared `ApiError` path so an unreachable API or
  a 404 (unknown pipeline / unknown run id) renders through the standard
  `ErrorState`.
- **No secrets client-side.** The frontend only ever reads what the backend
  returns; it never handles the API key or base URL.

---

## 8. Build order

1. **Types** — add the generated-report type, the LLM-run summary/detail types,
   and their list wrappers.
2. **API client** — update the report return type; add regenerate (optional) and
   the two LLM-runs calls plus their filters.
3. **Hooks** — rework `useReport` (gentle refresh), add the regenerate mutation
   (optional), and add the LLM-runs list/detail hooks.
4. **Report slot** — wire Pipeline Detail (and Overview) to render loading /
   generated / not-generated, with the sections renderer and optional Regenerate.
5. **Observability page** — add the route + nav entry, the filterable list, and
   the run-detail view (built like the Audit page).
6. **Polish** — labels/constants, formatters, empty/error states, and a quick
   pass to match the existing visual language.

---

## 9. Scope notes & options

- **Minimum viable (Track A only):** wire the report slot to `useReport` and add
  the generated-report type/rendering. This makes the headline feature visible
  with the least work; the observability page can follow.
- **Full plan (Track A + B):** add the LLM-runs page for the transparency/debug
  story — recommended, since durable run tracing is the stated priority and this
  page is what makes it visible in a demo.
- **Optional niceties:** a Regenerate button; a "diagnostics" link from a failed
  report straight to its run detail; a small per-pipeline "last generated" hint.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Report area breaks when LLM is disabled | Keep the stub branch; render three explicit states (loading / generated / not-generated) |
| Over-polling the LLM endpoint | Gentle refresh for the report query; rely on backend caching; regenerate on demand |
| Long JSON/traceback fields overwhelm the UI | Collapsible sections + preformatted/scrollable blocks on the run-detail view |
| New page drifts from app conventions | Mirror the Audit page's structure, filters, and shared UI primitives |
| Type drift between backend and UI | Keep the hand-written types narrow and matched to the documented response shapes; update both together |
