# Presentation Build Kit — Data Freshness Monitoring & Insights Agent
**Capstone Project — Group 6**

This folder contains one markdown file per slide. Each file is a **build spec**, not final prose:
it says what goes on the slide, gives a **draft diagram (Mermaid)** to be rebuilt as a clean graphic,
marks where **screenshots** go, and ends with **short speaker notes**.

> Design intent: **professional, minimal, diagram-led. No clutter.** Text on slides is terse;
> the reasoning lives in speaker notes.

---

## Page map (14 pages)

| # | File | Type | Title |
|---|------|------|-------|
| 1 | `slide-01-title.md` | Content | Title |
| 2 | `slide-02-problem.md` | Content | The Problem & Motivation |
| 3 | `slide-03-solution-overview.md` | Content | Solution Overview |
| 4 | `slide-04-architecture.md` | Content ⭐ | System Architecture |
| 5 | `slide-05-data-model.md` | Content ⭐ | Data Model |
| 6 | `slide-06-pipeline-fleet.md` | Content | The 7-Pipeline Fleet |
| 7 | `slide-07-synthetic-data.md` | Content | Synthetic Data Generation |
| 8 | `slide-08-detection-agent.md` | Content | The Detection Agent (7 Rules) |
| 9 | `slide-09-kpis-analytics.md` | Content | KPIs, Analytics & Trends |
| 10 | `slide-10-screenshot-overview.md` | **Screenshot** | Overview Dashboard |
| 11 | `slide-11-governance.md` | Content | Governance & Trust (Human-in-the-Loop) |
| 12 | `slide-12-screenshot-violations.md` | **Screenshot** | Violations & Review Workspace |
| 13 | `slide-13-screenshot-audit.md` | **Screenshot** | Audit Trail |
| 14 | `slide-14-future-scope.md` | Content | Future Scope & Roadmap |

⭐ = the two required deep-dive slides (Architecture, Data Model).

**Trim to 12:** drop the Audit screenshot (13) and merge Fleet (6) into Synthetic Data (7).
**Optional extra screenshot pages** (appendix, only if time allows): Pipelines list, Pipeline Detail, Executions.

---

## Conventions used in every slide file
- **[ON SLIDE]** — exactly what the audience sees (headline + terse bullets + which visual).
- **[VISUAL / DIAGRAM DRAFT]** — a Mermaid draft to **rebuild as a clean PowerPoint / draw.io graphic**.
- **[SCREENSHOT]** — where a screenshot page belongs (screenshots always get their **own page**).
- **[SPEAKER NOTES]** — short talking points (what to say, not read aloud).

---

## Design system (keep consistent across all slides)
- **Aspect ratio:** 16:9.
- **Fonts:** one sans-serif family — headings **Inter/Segoe UI Semibold**, body **Inter/Segoe UI Regular**.
- **Palette:**
  - Ink / headings: `#0F172A` (slate-900)
  - Primary accent: `#2563EB` (blue-600)
  - Secondary accent: `#0EA5E9` (sky-500)
  - Success: `#16A34A` · Warning/Medium: `#F59E0B` · Critical/Failure: `#DC2626`
  - Surfaces: white `#FFFFFF` / light gray `#F1F5F9`
- **Text rule:** ≤ 6 bullets per slide, ≤ ~7 words per bullet. One idea per slide.
- **Icons:** use a single set (lucide-style) to match the product; no clip-art mix.
- **Footer:** small, on every content slide — `Data Freshness Monitoring & Insights Agent · Group 6 · <page>`.
- **Diagrams:** rebuild every Mermaid draft as a native vector graphic (PowerPoint shapes / SmartArt / draw.io export). Use palette colors above; consistent box style; arrows left→right or top→down.

---

## Screenshot capture checklist (do this BEFORE the presentation)
Screenshots must look **populated and healthy** — capture with the live generator running.

1. Start all three processes (from project root):
   - API: `.venv/bin/uvicorn backend.main:app --reload --port 8000`
   - Generator (writes data): `.venv/bin/python -m synthetic_data`
   - Frontend: `cd frontend && npm run dev` → open `http://localhost:5173`
2. Let the generator run a bit so KPIs/charts are full; set the global time window consistently (e.g. **7 days**).
3. Browser: light theme, hide bookmarks bar, 1920×1080, high-DPI/retina capture, clean URL.
4. Capture these pages (one screenshot = one deck page):
   - **Overview** (KPI strip + trend charts + top-risky) → page 10
   - **Violations** (workspace: filters + table + a review action) → page 12
   - **Audit** (the immutable trail) → page 13
   - *Optional appendix:* Pipelines, Pipeline Detail, Executions
5. Crop out OS chrome; keep a little padding; export PNG. Name them `shot-overview.png`, `shot-violations.png`, `shot-audit.png` and drop them in `presentation/screenshots/`.

> Tip: capture a **before/after** pair on Violations (open → reviewed) to *imply* the live workflow without a live demo.
