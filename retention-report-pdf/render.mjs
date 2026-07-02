#!/usr/bin/env node
// render.mjs — turn a Retention Risk Report data bundle into a fully-populated,
// self-contained static HTML report (no JS, no external assets).
//
// It fills report-template.html:
//   * deterministic parts (KPIs, the 4 tables, the chart) are computed straight
//     from the MCP `fetch_retention_report_data` payload, porting the exact
//     color / bar-height rules from the original artifact.
//   * narrative parts (Critical Alert, Recommended / Priority Actions, Critical
//     Concern, subtitles) come from the `narrative` object in the data file —
//     authored by Claude for the specific report.
//
// Usage: node render.mjs <data.json> <out.html>
//   data.json = the MCP payload (executive_summary, high_risk_employees, ...)
//   PLUS: { "meta": {domainName, coveragePeriod},
//           "highRiskThreshold": 20, "rolesLimit": 9,
//           "narrative": { criticalAlert1, criticalAlert2, execActions[],
//                          roleActions[], criticalConcern, highRiskSubtitle,
//                          page4Subtitle, worstGapRole?, signals?{} } }

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const [dataArg, outArg] = process.argv.slice(2);
if (!dataArg || !outArg) {
  console.error('Usage: node render.mjs <data.json|-> <out.html>');
  console.error('  Pass "-" to read the JSON payload from stdin (preferred: keeps');
  console.error('  customer data off disk and avoids reusing a stale per-tenant file).');
  process.exit(2);
}

// Read from stdin when the data arg is "-", otherwise from the given path.
const rawData = dataArg === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(dataArg), 'utf8');
const d = JSON.parse(rawData);
const tpl = readFileSync(join(HERE, 'report-template.html'), 'utf8');
const meta = d.meta || {};
const narr = d.narrative || {};
const THRESH = d.highRiskThreshold ?? 20;
const ROLES_LIMIT = d.rolesLimit ?? 9;

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const num = s => parseFloat(String(s).replace(/[^0-9.\-]/g,'')) || 0;
const round1 = n => Math.round(n * 10) / 10;

// ── lucide icons (inline SVG so the output is self-contained) ──────────────
const L = (paths, size, extra='') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${extra}">${paths}</svg>`;
const ICONS = {
  users: L('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 15, 'flex-shrink:0'),
  userX: L('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>', 15, 'flex-shrink:0'),
  gauge: L('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>', 15, 'flex-shrink:0'),
  trendingDown: L('<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>', 12),
  trendingUp: L('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>', 12),
  arrowDown: L('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>', 12),
  arrowUp: L('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', 12),
  alertTriangle: L('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 20, 'color:var(--color-red-700);flex-shrink:0;margin-top:1px'),
  alertOctagon: L('<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>', 20, 'color:var(--color-red-700);flex-shrink:0;margin-top:1px'),
};

const churnColor = v => v >= 45 ? '#DF2A23' : v >= 35 ? '#F1433C' : '#FA746F';
const ANALYSIS_COLOR = {
  'Critical Concern': '#DF2A23', 'High Concern': '#F1433C',
  'Replacement Hiring': '#8A5A00', 'Healthy Growth': '#0B8A4C', 'Stable': '#1068B9',
  'No Movement': '#6D6D6D',
};
// The MCP query labels every gap==0 role "Replacement Hiring", but that only
// makes sense when the role actually churned (add>0 AND turn>0). A role with
// zero additions AND zero turnover had no movement at all — relabel it.
function classifyAnalysis(r) {
  if (r.net_addition === 0 && r.turnover === 0) return 'No Movement';
  return r.analysis;
}

// ── time helpers for behavioral "signal" column ────────────────────────────
function toMinutes(t) {
  const m = String(t).match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[1]; const min = +m[2];
  if (m[3]) { const pm = /pm/i.test(m[3]); if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0; }
  return h * 60 + min;
}

// ═══════════════════ derive the deterministic data ═══════════════════════
const es = d.executive_summary || {};
const headcount = es.current_headcount ?? 0;

// High-risk cohort = employees at/above the churn threshold.
const emps = (d.high_risk_employees || []).map(e => ({ ...e, _c: num(e.churn_probability) }));
const cohort = emps.filter(e => e._c >= THRESH);
const highRiskCount = cohort.length;
const highRiskPct = headcount ? round1(highRiskCount / headcount * 100) + '%' : '0%';

// High-Risk Employees table = top 10 by churn probability.
const highRisk = emps.slice(0, 10).map(e => {
  const score = Math.round(e.prodoscore);
  return {
    n: e.rank_num, name: esc(e.employee), role: esc(e.role), score,
    scoreColor: score < 35 ? '#DF2A23' : '#0D2744',
    churn: esc(e.churn_probability), churnW: e._c + '%', churnColor: churnColor(e._c),
  };
});

// Role breakdown — worst gaps first, non-zero prioritised, capped to fit the page.
const rb = (d.role_turnover_breakdown || []).slice().sort((a, b) => a.gap - b.gap);
const rolesAll = [...rb.filter(r => r.gap !== 0), ...rb.filter(r => r.gap === 0)];
const rolesShown = rolesAll.slice(0, ROLES_LIMIT);
const roles = rolesShown.map(r => {
  let gapBg = 'var(--color-neutral-100)', gapFg = '#5D5D5D';
  if (r.gap < 0) { gapBg = 'var(--color-red-100)'; gapFg = '#BB201A'; }
  else if (r.gap > 0) { gapBg = 'var(--color-green-100)'; gapFg = '#0B8A4C'; }
  const analysis = classifyAnalysis(r);
  return {
    role: esc(r.role_title), add: r.net_addition, turn: r.turnover,
    gap: r.gap > 0 ? '+' + r.gap : String(r.gap), gapBg, gapFg,
    analysis: esc(analysis), aColor: ANALYSIS_COLOR[analysis] || '#5D5D5D',
  };
});

// Page-3 at-a-glance stats.
const worst = rb.length ? rb.reduce((a, b) => (b.gap < a.gap ? b : a)) : { gap: 0, role_title: '—' };
const maxTurn = rb.reduce((m, r) => Math.max(m, r.turnover), 0);
const rolesNeedingAction = rb.filter(r => r.gap <= 0).length;

// ── behavioral & timing table ──────────────────────────────────────────────
const btByMetric = Object.fromEntries((d.behavioral_and_timing_metrics || []).map(m => [m.Metric, m]));
const BT_ORDER = ['Prodoscore', 'Active Time (hrs/day)', 'Gap Time (hrs/day)', 'Start Time', 'End Time'];
function timingSignal(metric, hi, no) {
  const override = (narr.signals || {})[metric];
  if (override) return esc(override);
  if (/Start Time|End Time/.test(metric)) {
    const a = toMinutes(hi), b = toMinutes(no);
    if (a == null || b == null) return '';
    const diff = a - b;
    if (diff === 0) return 'same as peers';
    return Math.abs(diff) + ' min ' + (diff > 0 ? 'later' : 'earlier');
  }
  const h = num(hi), n = num(no);
  if (!n) return '';
  const pct = Math.abs(Math.round((h - n) / n * 100));
  if (/Gap Time/.test(metric)) return pct + '% ' + (h > n ? 'more gap' : 'less gap');
  return pct + '% ' + (h < n ? 'below peers' : 'above peers');
}
const behaviorTiming = BT_ORDER.filter(k => btByMetric[k]).map(k => {
  const m = btByMetric[k];
  return { metric: esc(k), domain: esc(m.domain_90_day_avg), high: esc(m.high_risk_current),
           not: esc(m.not_at_risk_current), signal: timingSignal(k, m.high_risk_current, m.not_at_risk_current) };
});

// ── product engagement table + chart (dedupe by cleaned label) ──────────────
const cleanLabel = s => String(s).replace(/\s*\((actions|mins)\/day\)\s*/i, '').trim();
const seenPE = new Set();
const peRows = [];
for (const m of (d.product_engagement_metrics || [])) {
  const label = cleanLabel(m.Metric);
  if (seenPE.has(label)) continue;
  seenPE.add(label);
  peRows.push({ label, domain: num(m.domain_90_day_avg), high: num(m.high_risk_current), not: num(m.not_at_risk_current) });
}
const behaviorEngage = peRows.slice(0, 5).map(m => {
  const override = (narr.signals || {})[m.label];
  const pct = m.not ? Math.abs(Math.round((m.high - m.not) / m.not * 100)) : 0;
  return { metric: esc(m.label), domain: esc(m.domain), high: esc(m.high), not: esc(m.not),
           signal: override ? esc(override) : (pct + '% ' + (m.high < m.not ? 'below peers' : 'above peers')) };
});

// Chart — up to 5 categories, dynamic y-axis rounded to a nice maximum.
const chartRows = peRows.slice(0, 5);
const rawMax = Math.max(1, ...chartRows.flatMap(r => [r.domain, r.high, r.not]));
function niceCeil(x) {
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * pow >= x) return f * pow;
  return 10 * pow;
}
const niceMax = niceCeil(rawMax);
const H = 220;
const px = v => (v / niceMax * H) + 'px';
const chart = chartRows.map(r => ({ label: esc(r.label), h1: px(r.domain), h2: px(r.high), h3: px(r.not) }));
const STEPS = 5;
const yTicks = Array.from({ length: STEPS + 1 }, (_, i) => {
  const v = niceMax / STEPS * i;
  return { v: Number.isInteger(v) ? v : round1(v), pos: (v / niceMax * H) + 'px' };
});

// ── badges (color + icon depend on the numbers) ─────────────────────────────
function badge(color, bg, icon, text) {
  return `<div style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${color};background:${bg};padding:4px 9px;border-radius:9999px;">${icon}${esc(text)}</div>`;
}
const yoy = es.headcount_yoy_pct ?? 0;
const yoyBadge = yoy < 0
  ? badge('var(--color-red-700)', 'var(--color-red-100)', ICONS.trendingDown, `${Math.abs(yoy)}% decrease YoY`)
  : badge('var(--color-green-800)', 'var(--color-green-100)', ICONS.trendingUp, `${yoy}% increase YoY`);
const belowBench = (es.average_prodoscore ?? 0) < (es.global_benchmark ?? 0);
const benchmarkBadge = belowBench
  ? badge('#8A5A00', '#FFF4D6', ICONS.arrowDown, `Below Benchmark (${es.global_benchmark})`)
  : badge('var(--color-green-800)', 'var(--color-green-100)', ICONS.arrowUp, `Above Benchmark (${es.global_benchmark})`);

// ═══════════════════ assemble & substitute ═══════════════════════════════
const lists = { highRisk, roles, behaviorTiming, behaviorEngage, chart, yTicks,
  execActions: (narr.execActions || []).map((t, i) => ({ n: i + 1, text: esc(t) })),
  roleActions: (narr.roleActions || []).map((t, i) => ({ n: i + 1, text: esc(t) })) };

const scalars = {
  domainName: esc(meta.domainName || `Domain ${d.metadata?.domain_id ?? ''}`),
  coveragePeriod: esc(meta.coveragePeriod || d.metadata?.report_date || ''),
  headcount, avgProdoscore: es.average_prodoscore,
  yoyBadge, benchmarkBadge,
  highRiskCount, highRiskPct,
  highRiskPctText: `${highRiskPct} of Workforce`,
  highRiskOfTotal: `${highRiskCount} of ${headcount} Employees`,
  highRiskSubtitle: esc(narr.highRiskSubtitle || `Top ${highRisk.length} employees by churn probability — prioritize outreach here.`),
  criticalAlert1: esc(narr.criticalAlert1 || ''),
  criticalAlert2: esc(narr.criticalAlert2 || ''),
  criticalConcern: esc(narr.criticalConcern || ''),
  page4Subtitle: esc(narr.page4Subtitle || ''),
  worstGapValue: worst.gap > 0 ? '+' + worst.gap : String(worst.gap),
  worstGapRole: esc(narr.worstGapRole || worst.role_title),
  mostDepartures: maxTurn,
  mostDeparturesSub: headcount ? `${round1(maxTurn / headcount * 100)}% of Workforce` : '',
  rolesNeedingAction,
  chartAxisLabel: esc(d.chartAxisLabel || 'Daily Avg'),
  iconUsers: ICONS.users, iconUserX: ICONS.userX, iconGauge: ICONS.gauge,
  iconAlertTriangle: ICONS.alertTriangle, iconAlertOctagon: ICONS.alertOctagon,
};

let html = tpl;
// 1) expand FOR loops
html = html.replace(/<!--FOR (\w+) (\w+)-->([\s\S]*?)<!--ENDFOR-->/g, (_, listName, itemVar, inner) => {
  const arr = lists[listName] || [];
  return arr.map(item =>
    inner.replace(new RegExp('\\{\\{\\s*' + itemVar + '\\.(\\w+)\\s*\\}\\}', 'g'), (_, f) => item[f] ?? '')
  ).join('');
});
// 2) scalars
const missing = new Set();
html = html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
  if (key in scalars) return scalars[key] ?? '';
  missing.add(key); return '';
});

writeFileSync(resolve(outArg), html);
console.log(`OK -> ${outArg}`);
console.log(`  headcount=${headcount}  highRisk(>=${THRESH}%)=${highRiskCount}  topTable=${highRisk.length}  roles=${roles.length}/${rb.length}  chart=${chart.length} (max→${niceMax})`);
if (rolesAll.length > ROLES_LIMIT) console.log(`  NOTE: role table truncated to ${ROLES_LIMIT} of ${rolesAll.length} roles (worst gaps kept).`);
if (missing.size) console.log(`  WARN unfilled placeholders: ${[...missing].join(', ')}`);
