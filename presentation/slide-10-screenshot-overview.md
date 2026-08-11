# Slide 10 — SCREENSHOT: Overview Dashboard
**Page type:** SCREENSHOT (full page) · **Layout:** one large image + thin caption

> This entire page is a single screenshot. Minimal chrome — let the product speak.

---

## [ON SLIDE]
- **Full-bleed screenshot:** `screenshots/shot-overview.png`
- Thin caption strip (top or bottom): **Overview — fleet health at a glance**
- Optional 2-3 tiny callout labels pointing at: *Health Score card*, *trend chart*, *top-risky pipelines*
- No paragraphs. Caption + callouts only.

## [SCREENSHOT — capture spec]
- **Page:** Overview (landing page)
- **State:** live generator running so KPIs/charts are populated; global window = **7 days**
- **Must be visible:** KPI strip (incl. Health Score), the two trend charts, top-5 risky pipelines,
  recent violations panel
- **Resolution:** 1920×1080, high-DPI; light theme; browser chrome cropped
- **Save as:** `presentation/screenshots/shot-overview.png`

## [SPEAKER NOTES]
- "This is the landing view. Top row is the health KPIs; the charts show 7-day trends for runs and
  SLA compliance."
- Point to top-risky pipelines: "The agent ranks pipelines by risk so DataOps knows where to look first."
- Point to recent violations: "And the newest detected issues stream in here."
- Keep it to pointing, not reading — ~30-40s. Then transition to governance.
