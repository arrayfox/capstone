# LLM Report + Observability Implementation Plan
## Capstone Project: Data Freshness Monitoring & Insights Agent

> **Status today:** `GET /report/{name}` is a **stub** in `backend/main.py`. The
> frontend already has the plumbing (a `useReport()` hook and a reserved
> "AI insights — on hold" slot). The data contract is already designed in
> `data_schema_design.md`, and the `audit_log` already reserves a
> `REPORT_GENERATED` event.
>
> **Two concerns, kept separate:**
> 1. **The product** — generate a natural-language report/summary for a pipeline.
> 2. **The observability layer** — persist *every step* the LLM takes (input data,
>    prompt, context, parameters, raw output, tokens, timing, and any error at any
>    stage) so a failed run can be debugged after the fact.
>
> Concern #2 is the priority. It is built as a **generic LLM-run tracer** so it
> works for the report today and for any future LLM feature (root-cause analysis,
> recommendations, chat) without change. Report generation is simply the first
> *caller* of the traced client.

---

## 1. Guiding principles

- **Everything is logged, always.** The trace record is created *before* the call
  and finalized whether the call succeeds or throws. Even a crash mid-flow leaves
  a complete diagnostic record. Call it "create-early, update-always."
- **AI drafts, human approves.** A generated report is a draft that flows through
  the same governance gate as violations, and a human-readable `REPORT_GENERATED`
  entry still goes to the `audit_log`. The detailed technical trace lives in a
  *separate* place so the audit log stays clean and business-readable.
- **Send numbers, not raw rows.** The backend builds a compact **structured**
  context (aggregated facts), and the LLM turns those numbers into prose. That
  exact context is stored so any run can be reproduced or debugged.
- **Graceful fallback.** No API key, or an API error, returns the existing stub
  response shape so the UI never breaks — while the failure is still fully
  recorded for debugging.

---

## 2. Provider: Anthropic with a custom base URL

- Use the Anthropic SDK, configured entirely through environment variables so no
  secret is ever committed: an API key, a **custom base URL** (to point at your
  gateway/proxy instead of the default endpoint), the model name, and a couple of
  generation knobs (max tokens, temperature).
- A single derived flag — "LLM enabled" — is simply "is an API key present?".
  That one flag is what the endpoint checks to decide between the real call and
  the stub.
- The custom base URL is a first-class setting on the client, so pointing at a
  proxy is just configuration, not code changes.
- **Structured output with Claude:** unlike some providers, Anthropic has no
  "respond with this JSON schema" switch. The reliable pattern is **tool-use**:
  define a single tool whose input schema *is* our report structure and require
  the model to "call" it. The model then returns the report as the tool call's
  structured input, which is dependable to parse. (Fallback if needed: instruct
  "JSON only" and parse the text.)
- Document the environment variable names in `.env.example` and the README —
  names only, never values.

---

## 3. The observability layer — `llm_runs` (the centerpiece)

A durable table in `governance.db` that captures the **full lifecycle** of every
LLM invocation: one row per invocation, updated as it moves through the flow.

**What each row records, grouped by purpose:**

- **Identity:** a unique run id (also returned to the caller/UI), the entity type
  (`report` today; `rca`/`chat` later), and the entity id (e.g. the pipeline
  name).
- **Progress:** a status (`started` / `success` / `error`) and the **stage** last
  reached — this is what tells you *where* a failure happened.
- **Request detail:** provider, model, the exact base URL that was hit, the
  generation parameters, the **structured context** we built, and the **system
  and user prompts** actually sent.
- **Response detail:** the **raw provider response**, the **parsed output**
  (the report sections), token counts (prompt/completion/total), and the stop
  reason.
- **Failure diagnostics:** error type, error message, and the **full traceback**.
- **Timing:** started-at, finished-at, and total duration in milliseconds.

Add indexes on entity, status, and time so the debug views are fast.

**The stages** (stored so a failure points to a specific step):
`build_context` → `render_prompt` → `call_llm` → `parse_output` → `persist` →
`done`.

> **Optional agentic future:** if a run ever becomes multi-step, add a child
> "steps" table (one row per step, each with its own input/output/timing/error).
> The single `llm_runs` table fully covers today's single-call flow; the steps
> table is a clean extension when the agent grows beyond one call.

**The tracer (a thin, reusable helper module):** exposes four small operations —
*start* (insert the row before anything happens), *update* (attach the context,
prompts, response, tokens, etc. as each stage completes), *finish* (mark
success + timing), and *fail* (mark error, capture the stage + traceback). Every
LLM feature uses these same four operations, so logging is consistent everywhere.

---

## 4. Report generation module — wrapped in the tracer

A new backend module owns two responsibilities:

1. **Build context (deterministic, no LLM).** Assemble the compact structured
   input by *reusing existing queries*: the pipeline's config, its per-pipeline
   health rollup (already computed in `kpis.py`), its open violations grouped by
   type with counts and a sample detail, and its 7-day / 30-day trends. This
   returns a plain data structure — and it is exactly what gets stored in the
   trace, so there is no new SQL to maintain and the stored context matches what
   the model saw.

2. **Generate (the traced LLM call).** The flow, start to finish:
   - Start a trace row (status `started`, stage `build_context`).
   - Build the context, render the prompts, and record all of it (stage
     `render_prompt`).
   - Call the model with the tool-use structured-output setup (stage `call_llm`).
   - Record the raw response, tokens, and stop reason (stage `parse_output`),
     then extract the structured report from the tool call.
   - Finalize the trace as success (stage `done`) and return the report to the
     caller.
   - If **anything** throws, the `except` path records the error and the stage it
     died at, then returns the safe stub so the UI still renders.

**Why this matters:** because the row is written at start, updated at every stage,
and finalized on success *or* failure, a broken run still leaves behind the stored
context, the exact prompts, the parameters, the stage it failed at, and the full
traceback — enough to debug without reproducing the failure.

The **stub** (used when the LLM is disabled or a call fails) returns the same
response shape the frontend already expects: a "not generated" flag, a reason, the
current open-violation count, and a short placeholder message.

---

## 5. Endpoint wiring (`backend/main.py`)

- Keep `GET /report/{name}` as the single report entry point, but replace the stub
  body with a branch: if the LLM is disabled, return the stub; otherwise check the
  cache, and on a miss run the traced generation.
- On a successful generation, store it in the cache and write the human-readable
  `REPORT_GENERATED` entry to the `audit_log` (referencing the run id, which links
  the business event to the technical trace).
- **New debug/observability endpoints:**
  - a **list** endpoint for traces (filterable by entity and status), and
  - a **detail** endpoint for a single run id (context, prompts, output, error).
- These make the logs inspectable directly from the API docs and, optionally, a
  small "LLM Runs" admin page — which doubles as a strong demo of the agent's
  transparency.
- Optionally add a "regenerate" action to force a fresh report on demand.

---

## 6. Caching (avoid needless cost and latency)

- The frontend polls, and LLM calls cost money and add latency, so results are
  cached **per pipeline**, keyed by a **fingerprint** of the input (for example
  the data horizon plus the open-violation count / newest detection time).
- Serve the cached report until the underlying data actually changes; only
  generate on a cache miss or an explicit regenerate. This way a 5-second poll
  never triggers an API call on its own.
- Every *actual* generation still writes its own trace row; cache hits do not.

---

## 7. Governance vs. observability (two logs, on purpose)

The two logs answer different questions and serve different audiences:

- **`audit_log` (already exists)** — the business/compliance record. Coarse:
  one line such as "REPORT_GENERATED by AGENT" with actor, action, entity, and a
  short summary. Never pruned (compliance).
- **`llm_runs` (new)** — the engineering/debugging record. Fine-grained: the full
  technical trace (context, prompts, parameters, raw output, tokens, timing, and
  error + traceback). Can be rotated/pruned if it grows.

They complement each other: the audit log answers *"who did what,"* while
`llm_runs` answers *"exactly what happened inside the AI step, and why did it
fail."* Keeping them separate stops the compliance log from filling with
low-level technical detail.

---

## 8. Frontend (small changes)

- The `useReport()` hook and its API call already exist and already hit
  `/report/{name}`.
- When the response says "generated," render the report's sections (executive
  summary, root-cause indicators, risk assessment, recommended actions) in place
  of the current placeholder; when it says "not generated," keep the placeholder
  and optionally show a small "diagnostics" link to the run id.
- Optional **"LLM Runs" page:** a table backed by the list endpoint, each row
  opening the single-run detail (prompt / context / output / error). This is the
  most compelling way to *show* the observability story in a demo.

---

## 9. Build order

1. Add the Anthropic SDK dependency; add the environment variable names to
   `.env.example` and the README.
2. Add the `llm_runs` table to the database schema (and a small write helper if
   one isn't already available).
3. Build the tracer helper module (start / update / finish / fail).
4. Build the report module (build-context, generate, stub) with tracing wired in
   at every stage.
5. Swap the `/report/{name}` stub to branch on the enabled flag; add the two
   `llm-runs` debug endpoints; add the `REPORT_GENERATED` audit write.
6. Add caching (in-memory with a fingerprint key to start).
7. Test with the real key and custom base URL from the API docs: force one
   success, then force a failure (e.g. a bad model name) and confirm the error
   trace is captured with the correct stage and traceback.
8. Update the frontend to render the sections; optionally add the LLM Runs page.
9. Flip the docs from "stubbed" to "live behind a key."

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| No key / API down / bad base URL | Enabled-flag gate + try/except returns the stub shape; the failure is fully captured in `llm_runs` with the stage and traceback |
| Custom gateway quirks (auth, path) | Base URL is configurable and the exact base URL is stored per run, so you can tell which endpoint was actually hit |
| Cost / rate limits | Fingerprint cache; generate only on a miss or explicit regenerate |
| Hallucinated numbers | Structured facts in, tool-use structured output, low temperature, and a "do not invent numbers" instruction |
| Secret leakage | Keys only via environment variables; `.env.example` documents names, never values |
| Sensitive data in logs | The stored context is our own aggregated data (no secrets); if ever needed, redact parameters/headers before storing |
| Log table growth | Indexed; add a retention/rotation step if volume grows |
