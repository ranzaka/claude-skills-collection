#!/usr/bin/env node
// Renders a self-contained Retention Risk Report HTML and prints it to PDF.
//
// The report is a client-side-rendered "bundled" artifact: a stack of
// <section> elements, each sized 816x1056px (US Letter at 96dpi). It ships
// with NO @page / page-break CSS, so a naive print overflows to 5+ ragged
// pages. This driver waits for the JS bundle to render, injects pagination
// CSS (one section == one Letter page), then prints via CDP Page.printToPDF.
//
// No npm dependencies: drives the system Google Chrome over the DevTools
// protocol using Node's built-in WebSocket (Node >= 22).
//
// Usage: node driver.mjs <input.html> <output.pdf> [--png <shot.png>]

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const [inArg, outArg, ...rest] = process.argv.slice(2);
if (!inArg || !outArg) {
  console.error('Usage: node driver.mjs <input.html> <output.pdf> [--png <shot.png>]');
  process.exit(2);
}
const input = resolve(inArg);
const output = resolve(outArg);
const pngIdx = rest.indexOf('--png');
const pngOut = pngIdx >= 0 ? resolve(rest[pngIdx + 1]) : null;

const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'rrr-chrome-'));

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// ---- tiny CDP client over the built-in WebSocket ----
async function getWsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  // sessionId routes commands to an attached page target (flattened protocol).
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    const frame = { id: mid, method, params };
    if (sessionId) frame.sessionId = sessionId;
    ws.send(JSON.stringify(frame));
  });
  return { ready, send, close: () => ws.close() };
}

// One report section == one Letter page. Two problems to solve:
//   1. The sections sit in a flex parent with gap+padding that spills phantom
//      pages — so we flatten the parent.
//   2. A data-filled section can be TALLER than one Letter page (1056px). Rather
//      than clip it, we wrap each section in a fixed 816x1056 page box and
//      scale-to-fit any section that overflows (measured in the browser). A
//      section that already fits (e.g. the cover) is left at scale 1.
const PRINT_CSS = `
  @page { size: 816px 1056px; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  #__bundler_loading, #__bundler_thumbnail, #__bundler_err { display: none !important; }
  .__pdfpage {
    width: 816px !important; height: 1056px !important; overflow: hidden !important;
    background: #fff !important; margin: 0 !important; padding: 0 !important;
    break-after: page; page-break-after: always; break-inside: avoid;
    display: block !important;
  }
  .__pdfpage:last-of-type { break-after: auto; page-break-after: auto; }
  .__pdfpage > section[data-screen-label] {
    margin: 0 !important; box-shadow: none !important; border-radius: 0 !important;
  }
`;
// Runs in the page: flatten the flex wrapper, then wrap+scale each section.
const PAGINATE_JS = `
  (function(){
    var secs = document.querySelectorAll('section[data-screen-label]');
    if (secs.length && secs[0].parentElement) {
      var p = secs[0].parentElement;
      p.style.setProperty('display','block','important');
      p.style.setProperty('gap','0','important');
      p.style.setProperty('padding','0','important');
      p.style.setProperty('margin','0','important');
      p.style.setProperty('background','#fff','important');
    }
    secs.forEach(function(sec){
      // true content height — take the largest metric, guard against 0
      var natural = Math.max(sec.scrollHeight, sec.offsetHeight, Math.ceil(sec.getBoundingClientRect().height));
      // The cover is a full-bleed design: never scale it (clip a stray px instead
      // of leaving white margins around the dark background).
      var isCover = /cover/i.test(sec.getAttribute('data-screen-label') || '');
      var scale = (!isCover && natural > 1056) ? 1056 / natural : 1;
      var page = document.createElement('div');
      page.className = '__pdfpage';
      sec.parentNode.insertBefore(page, sec);
      page.appendChild(sec);
      if (scale < 1) {
        sec.style.transformOrigin = 'top center';
        sec.style.transform = 'scale(' + scale + ')';
      }
    });
    return secs.length;
  })()
`;

(async () => {
  const cdp = connect(await getWsUrl());
  await cdp.ready;

  // Attach to a fresh page target and drive it via its session.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');

  const url = 'file://' + input.split('/').map(encodeURIComponent).join('/');
  await s('Page.navigate', { url });

  // Wait for the bundle to render real content: the sections must exist.
  let rendered = false;
  for (let i = 0; i < 150; i++) {
    const { result } = await s('Runtime.evaluate', {
      expression: `document.querySelectorAll('section[data-screen-label]').length`,
      returnByValue: true,
    });
    if (result.value >= 1) { rendered = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!rendered) throw new Error('Report never rendered its sections (JS bundle failed?)');
  await new Promise(r => setTimeout(r, 800)); // let fonts/charts settle

  const { result: nSec } = await s('Runtime.evaluate', {
    expression: `document.querySelectorAll('section[data-screen-label]').length`,
    returnByValue: true,
  });

  await s('Runtime.evaluate', {
    expression: `{ const st=document.createElement('style'); st.textContent=${JSON.stringify(PRINT_CSS)}; document.head.appendChild(st); }`,
  });
  await s('Runtime.evaluate', { expression: PAGINATE_JS });

  if (pngOut) {
    const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(pngOut, Buffer.from(data, 'base64'));
  }

  const { data } = await s('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    paperWidth: 8.5, paperHeight: 11,
  });
  writeFileSync(output, Buffer.from(data, 'base64'));
  cdp.close();
  console.log(`OK: ${nSec.value} report sections -> ${output}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
