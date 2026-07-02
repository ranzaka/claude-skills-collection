---
name: retention-report-pdf
description: Generate a Prodoscore Retention Risk Report PDF from scratch for a given domain and date. Fetches data from the retention-risk MCP server, fills the branded 4-page report (top-10 high-risk employees, role turnover, behavioral comparison, chart) with Claude-authored narrative, and prints to PDF. Use for "create/generate the retention risk report", "retention report PDF for domain X", "run the retention report".
---

# Retention Risk Report → PDF (generate from scratch)

Builds the branded 4-page **Prodoscore Retention Risk Report** for one domain + report
date, entirely from live data:

1. **Fetch** — the `prodoscore-retention` MCP tool `fetch_retention_report_data(domain_id,
   report_date)` returns the org metrics (executive summary, top high-risk employees, role
   turnover, behavioral/timing, product engagement).
2. **Author narrative** — *you* (Claude) read that data and write the interpretive prose
   (Critical Alert, Recommended Actions, Priority Actions, Critical Concern, subtitles).
3. **Render** — `render.mjs` merges data + narrative into `report-template.html`, computing
   every table, KPI, color and chart bar deterministically → a self-contained static HTML.
4. **PDF** — `driver.mjs` renders that HTML in headless Chrome and prints a clean 4-page
   US-Letter PDF (auto-scaling each page to fit).

All paths below are relative to this app dir (`retention-report-mcp/`).

## Prerequisites

- **Google Chrome** at `/Applications/Google Chrome.app` (override: `CHROME_BIN=…`).
- **Node ≥ 22** (built-in `WebSocket`; no npm install). Verified on v24.3.0.
- The **`prodoscore-retention` MCP server** connected in this session (it runs
  `uv run server.py` and needs Google Cloud / BigQuery auth for project
  `prodoscore-prodolab-live`).

## ⚠️ Tenant data isolation — read first

The report payload contains customer PII (employee names, scores). To avoid leaking one
tenant's data into another tenant's report, this pipeline **never writes the payload to a
shared file**:

- The JSON payload is piped to `render.mjs` on **stdin** (`-`), assembled fresh in a heredoc
  each run. There is no `data.json` to reuse, append to, or forget to delete.
- The intermediate HTML (also full PII) is written into a **per-run `mktemp -d`** and removed
  by a `trap` on exit — even if a step fails. Only the finished **PDF** persists, at the path
  you choose.
- **Never** reuse or hand-edit a payload file across domains; always build the whole payload
  from scratch for each report. `example-data.json` is a **synthetic sample only** — never
  paste real MCP data into a committed file.

## Generate a report (the pipeline)

**Step 1 — fetch the data.** Call the MCP tool
`mcp__prodoscore-retention__fetch_retention_report_data(domain_id, report_date)`. It returns a
JSON string (often wrapped in `{"result": "…"}`); use the *inner* payload object. Keep it in
context — do **not** save it to a file.

> Reporting month: metrics are for the month of `report_date`. Use a date in the **last
> complete month** — a month that has barely started returns near-empty current-month data
> (headcount 0, ~100% turnover), which is a calendar artifact, not reality.

**Step 2 — author the narrative from the actual numbers.** Name the worst-gap role, cite real
counts and the benchmark delta, and describe what the behavioral table actually shows (don't
assume "disengagement" — a high-risk cohort that is *more* active points to overload/burnout).
This is why the narrative is authored per run, not templated. The keys you add:

```jsonc
{
  // ── the MCP payload object (metadata, executive_summary, high_risk_employees,
  //    role_turnover_breakdown, behavioral_and_timing_metrics, product_engagement_metrics) ──
  "meta":  { "domainName": "Acme Corp", "coveragePeriod": "June 2026" },
  "highRiskThreshold": 40,      // churn % that counts as "high risk" (KPI + page-4). default 20
  "rolesLimit": 10,             // max rows in the role-breakdown table (worst gaps kept). default 9
  "narrative": {
    "criticalAlert1": "…", "criticalAlert2": "…",   // page-2 alert, two short paragraphs
    "highRiskSubtitle": "…",                          // optional; defaults to "Top N by churn…"
    "execActions":  ["…", "…", "…"],                  // page-2 Recommended Actions (2–4)
    "roleActions":  ["…", "…", "…"],                  // page-3 Immediate Priority Actions (2–4)
    "page4Subtitle": "…",                             // label under the page-4 high-risk stat
    "criticalConcern": "…",                           // page-4 Critical Concern paragraph
    "worstGapRole": "…",                              // optional; overrides the computed worst-gap role label
    "signals": { "Prodoscore": "…", "Email": "…" }    // optional; override any auto-computed signal cell
  }
}
```

**Step 3 — render + print, in one isolated block.** Pipe the assembled JSON straight into
`render.mjs` via a heredoc; keep the intermediate HTML in a throwaway temp dir that a `trap`
wipes. Substitute your real payload+narrative for the `{ … }`:

```bash
S=".claude/skills/retention-report-pdf"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT      # HTML (PII) removed on exit, even on error

node "$S/render.mjs" - "$work/r.html" <<'JSON'
{ ...MCP payload + meta + highRiskThreshold + rolesLimit + narrative... }
JSON

node "$S/driver.mjs" "$work/r.html" "Retention Risk Report - Acme June 2026.pdf"
# => OK: 4 report sections -> …/Retention Risk Report - Acme June 2026.pdf
```

`render.mjs` prints a summary, e.g. `headcount=223  highRisk(>=40%)=25  topTable=10
roles=10/10  chart=4`, and warns if the role table was truncated or a placeholder went
unfilled. Only the named PDF survives; the temp dir (and the PII-bearing HTML in it) is gone.

**Inspect** (macOS, no poppler needed): `open "Retention Risk Report - Acme June 2026.pdf"`.
To eyeball all 4 pages as one image, add `--png "$work/all.png"` to the driver call and view
it *before* the block exits (it's inside the temp dir).

## What render.mjs computes for you (don't hand-author these)

- **KPIs**: headcount, YoY badge (color + arrow by sign), high-risk count & % (from
  `highRiskThreshold`), average Prodoscore, above/below-benchmark badge.
- **High-Risk Employees table**: top 10 by churn; churn-bar width + color (`≥45`→dark red,
  `≥35`→red, else salmon), Prodoscore red when `<35`. (Ported from the original artifact.)
- **Role Breakdown**: sorted worst-gap first, non-zero gaps prioritized, capped to
  `rolesLimit`; gap pill red/green/neutral; analysis dot colored by category.
- **At-a-glance stats**: worst gap + role, most departures, roles with gap ≤ 0.
- **Behavioral & Product tables**: canonical metric order; the "High-Risk Signal" cell is
  auto-computed (`% below/above peers`, `N min earlier/later`, `% more/less gap`) — override
  any cell via `narrative.signals`.
- **Chart**: up to 5 product categories, y-axis auto-scaled to a "nice" max, bar heights.

## Gotchas

- **The report renders via JS in a browser — never point a static HTML→PDF tool at it.**
  `render.mjs` produces a *fully static* HTML (no JS, inline SVG icons), so `driver.mjs` just
  needs Chrome to paint and print it.
- **The exact brand fonts are embedded.** `report-template.html` inlines the Linotte OTFs and
  Inter woff2s (from the original artifact bundle) as `data:` URIs — that's why it's ~2.2 MB.
  The big title uses Switzer, still loaded via a fontshare `@import` (needs network; falls back
  to Linotte offline) exactly as the original did. To make Switzer offline-exact, inline it too.
- **`fetch_retention_report_data` may return `high_risk_count: 0`** — that field uses a strict
  ≥70% churn threshold. The report's "high risk" cohort is defined by `highRiskThreshold`
  (default 20%), independent of that field. Set it to match how the business defines risk.
- **Pages auto-scale to fit.** A data-heavy page (e.g. 10 employees + 3 actions ≈ 1400px) is
  uniformly scaled down to one Letter page rather than clipped — so denser pages render at
  slightly smaller text. The cover is never scaled. Trim `rolesLimit` or shorten narrative if
  you want less scaling.
- **Zero-activity roles are relabeled.** The MCP query tags every gap-0 role "Replacement
  Hiring", but a role with 0 additions AND 0 turnover had no movement — `render.mjs` relabels
  those to **"No Movement"** (neutral). Genuine replacement hiring (add>0 & turn>0, net 0)
  keeps its label. `rolesLimit` keeps the worst gaps and drops the tail (render.mjs logs how many).
- **`example-data.json` is a SYNTHETIC sample** (fake names/domain) — copy its shape, never
  paste real MCP data into it or any other committed file.
- **The template is the design source of truth.** `report-template.html` was derived from the
  original Prodoscore artifact; `<!--FOR list item-->…<!--ENDFOR-->` marks a repeated block and
  `{{ scalar }}` / `{{ item.field }}` are the substitution points render.mjs fills.

## Troubleshooting

| Symptom | Fix |
|---|---|
| MCP tool missing / errors | Confirm `prodoscore-retention` is connected and BigQuery auth works (`uv run server.py`). It hits project `prodoscore-prodolab-live`. |
| `render.mjs` WARN unfilled placeholders | A `{{ key }}` had no value — usually a missing `narrative` field. Add it to the piped payload. |
| PDF has >4 pages | A section didn't get wrapped/scaled — check the HTML still has 4 `section[data-screen-label]` at `816px` width and `driver.mjs`'s pagination JS is intact. |
| `'Page.enable' wasn't found` | Attach to a page session, not the browser endpoint — the driver already uses `Target.attachToTarget {flatten:true}`; keep the `sessionId` plumbing. |
| `Report never rendered its sections` | HTML didn't paint. Confirm `render.mjs` wrote a non-empty file; increase the settle wait in `driver.mjs`. |
| Title font looks generic | Switzer loads over the network (fontshare `@import`); offline it falls back to the embedded Linotte. Linotte + Inter are embedded, so body/numbers are always exact. |
| Cover (page 1) looks shrunk with white margins | The driver never scales the cover (`data-screen-label` contains "Cover"); if you renamed it, restore that label so it stays full-bleed. |

## Files

- `render.mjs` — data + narrative → static HTML (all deterministic computation). Reads the
  payload from a file path or from stdin (`-`).
- `report-template.html` — the branded 4-page template (loops + placeholders).
- `driver.mjs` — static HTML → paginated 4-page PDF via headless Chrome (CDP).
- `example-data.json` — a **synthetic** worked input (fake names) showing the payload shape.
