import { FONT_DATA_URI } from './ui-font.js';
import { LOGO_DATA_URI } from './ui-logo.js';

/**
 * The single page `synapse ui` serves. Self-contained (no external requests: the Plus Jakarta Sans font and the logo are data URIs);
 * all memory text is inserted with textContent, never as HTML, including the small Markdown renderer for narratives.
 */
export const UI_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse</title>
<link rel="icon" href="${LOGO_DATA_URI}">
<style>
@font-face { font-family: "Plus Jakarta Sans"; font-style: normal; font-weight: 200 800; font-display: swap; src: url("${FONT_DATA_URI}") format("woff2"); }
:root {
  --bg: #fdfcf0; --panel: #fffef8; --ink: #1a1a17; --muted: #6f6d62; --faint: #a3a194; --line: #e6e4d4; --soft: #f3f1e2; --pill: #e9e7d7;
  --green: #21504a; --green-2: #2a5f57; --on-green: #fdfcf0; --on-green-muted: #b9cbc5;
  --lav: #ead6fb; --lav-soft: #f5ecfd; --coral: #ef6a4c; --mark: #fbe7a1;
  --warn: #a85c00; --warn-bg: #fdf0d8; --ok: #2f7a4f; --ok-bg: #e4f2e8; --bad: #b8321f; --bad-bg: #fbe6e1;
  --t-decision: #6a4bc4; --t-gotcha: #c2412d; --t-fix: #2f7a4f; --t-how: #21504a; --t-change: #6f6d62; --t-note: #94700a;
  --serif: "Hoefler Text", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: "Plus Jakarta Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --top: 92px;
  color-scheme: light only;
}
* { box-sizing: border-box; }
html { scroll-padding-top: var(--top); }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
code, pre, kbd, .mono { font-family: var(--mono); font-size: 0.88em; }
:focus-visible { outline: 2px solid var(--coral); outline-offset: 2px; }
.eyebrow { font-size: 12.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 0; }

/* Floating top bar */
.top { position: sticky; top: 0; z-index: 4; padding: 14px 24px 10px; background: linear-gradient(var(--bg) 70%, transparent); }
.bar { max-width: 1320px; margin: 0 auto; display: flex; align-items: center; gap: 18px; padding: 9px 10px 9px 18px; background: var(--panel); border: 2px solid var(--line); border-radius: 18px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 20px; letter-spacing: -0.02em; white-space: nowrap; }
.brand img { width: 30px; height: 30px; }
.seg { display: flex; gap: 2px; background: var(--pill); border-radius: 999px; padding: 4px; overflow-x: auto; scrollbar-width: none; }
.seg button { border: 0; background: none; border-radius: 999px; padding: 6px 16px; cursor: pointer; white-space: nowrap; color: var(--ink); display: inline-flex; align-items: center; gap: 7px; }
.seg button:hover { background: color-mix(in srgb, var(--panel) 55%, transparent); }
.seg button.on { background: var(--panel); box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
.seg .count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.seg .count.warn { color: var(--coral); font-weight: 600; }
.bar .right { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
/* One style for every text field and dropdown: pill, same border, height and focus ring; dropdowns get the same chevron. */
select, input[type=search], input[type=text] { background-color: var(--panel); border: 1.5px solid var(--line); border-radius: 999px; padding: 0 16px; height: 38px; font-size: 14px; transition: border-color .15s, background-color .15s; }
input[type=search]:hover, input[type=text]:hover, select:hover { border-color: var(--faint); }
select:focus-visible, input:focus-visible { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lav) 70%, transparent); }
select { appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 36px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
  background-image: var(--chev); background-repeat: no-repeat; background-position: right 14px center; background-size: 10px 6px; }
select option { background: var(--panel); color: var(--ink); }
:root { --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236f6d62' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
#project { max-width: 260px; font-weight: 550; }

/* Hero */
.hero { max-width: 1320px; margin: 0 auto; padding: 44px 24px 28px; text-align: center; }
.hero h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(40px, 6vw, 72px); line-height: 1.02; letter-spacing: -0.02em; margin: 14px 0 14px; }
.hero h1 em { font-style: italic; }
.lede { max-width: 620px; margin: 0 auto; font-size: 17px; color: var(--ink); }
.lede b { font-weight: 600; }
.band { margin: 34px auto 0; background: var(--green); color: var(--on-green); border-radius: 32px; padding: 26px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; text-align: center; }
.stat { border: 1.5px solid color-mix(in srgb, var(--on-green) 14%, transparent); border-radius: 22px; padding: 18px 10px 16px; background: none; color: inherit; cursor: pointer; transition: background .15s; }
.stat:hover { background: var(--green-2); }
.stat.static { cursor: default; }
.stat.static:hover { background: none; }
.stat .label { font-size: 14px; color: var(--on-green-muted); }
.stat .num { font-family: var(--serif); font-size: clamp(36px, 4.4vw, 56px); line-height: 1.05; font-variant-numeric: lining-nums tabular-nums; }
.stat .num small { font-size: 0.45em; font-style: italic; color: var(--on-green-muted); margin-left: 4px; }
.stat.alert .num { color: #ffb8a6; }

/* Workspace */
.work { max-width: 1320px; margin: 0 auto; padding: 8px 24px 80px; display: grid; grid-template-columns: 190px minmax(0, 1fr) minmax(0, 420px); gap: 28px; align-items: start; }
.work.norail { grid-template-columns: minmax(0, 1fr) minmax(0, 420px); }
.work.norail .rail { display: none; }
.rail, .detail { position: sticky; top: var(--top); }
/* The panel is a fixed rounded shell; an inner area scrolls, inset from the edges so its scrollbar stays inside the border. */
.detail { max-height: calc(100vh - var(--top) - 16px); display: flex; flex-direction: column; overflow: hidden; }
.detail-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 10px 6px 10px 0; padding: 14px 18px 16px 26px; }
.detail-body, .md pre, .rail { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--ink) 22%, transparent) transparent; }
.rail { padding-top: 6px; }
.rail .eyebrow { margin: 0 0 12px 22px; font-size: 11.5px; }
.rail ul { list-style: none; margin: 0; padding: 0; border-left: 3px solid var(--line); }
.rail button { position: relative; display: flex; width: 100%; justify-content: space-between; align-items: baseline; gap: 10px; border: 0; background: none; text-align: left; cursor: pointer;
  padding: 5px 0 5px 19px; font-family: var(--serif); font-size: 19px; color: var(--faint); transition: color .15s; }
.rail button:hover { color: var(--ink); }
.rail button.on { color: var(--ink); }
.rail button.on::before { content: ""; position: absolute; left: -3px; top: 4px; bottom: 4px; width: 3px; background: var(--coral); border-radius: 2px; }
.rail button span { font-family: var(--sans); font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

main { min-width: 0; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.toolbar input[type=search] { flex: 1 1 240px; min-width: 0; padding-left: 18px; }
.toolbar select { flex: none; }
.row:focus-visible { outline: none; background: var(--soft); }
.toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 14px; cursor: pointer; user-select: none; white-space: nowrap; }

.hint { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
.bulk { display: flex; gap: 10px; align-items: center; padding: 8px 8px 8px 20px; margin-bottom: 10px; background: var(--panel); border: 1.5px solid var(--line); border-radius: 999px; font-size: 14px; transition: background .15s, border-color .15s; }
.bulk.on { background: var(--lav-soft); border-color: color-mix(in srgb, var(--lav) 70%, var(--line)); }
.bulk .n { color: var(--muted); margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bulk.on .n { color: var(--ink); font-weight: 550; }
.bulk .btn { border-radius: 999px; }

.list { background: var(--panel); border: 1.5px solid var(--line); border-radius: 22px; overflow: hidden; }
.day { padding: 16px 20px 6px; font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.row { position: relative; padding: 12px 20px 13px; cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 14px; align-items: baseline; border-top: 1px solid var(--line); }
.day + .row, .list > .row:first-child { border-top: 0; }
.row.bulkrow { grid-template-columns: auto minmax(0, 1fr) auto; }
.row.bulkrow .meta { grid-column: 2 / 4; }
.row input[type=checkbox] { align-self: center; grid-row: span 2; }
.row input[type=checkbox], .bulk input[type=checkbox], .toggle input[type=checkbox] { appearance: none; -webkit-appearance: none; margin: 0; width: 18px; height: 18px; flex: none; border: 1.5px solid var(--faint); border-radius: 6px;
  background: transparent; cursor: pointer; display: inline-grid; place-content: center; transition: background .12s, border-color .12s; }
.row input[type=checkbox]:hover, .bulk input[type=checkbox]:hover, .toggle input[type=checkbox]:hover { border-color: var(--ink); }
.row input[type=checkbox]:checked, .bulk input[type=checkbox]:checked, .toggle input[type=checkbox]:checked { background: var(--green); border-color: var(--green); }
.row input[type=checkbox]:checked::after, .bulk input[type=checkbox]:checked::after, .toggle input[type=checkbox]:checked::after { content: ""; width: 9px; height: 5px; border: 2px solid var(--on-green); border-top: 0; border-right: 0; transform: translateY(-1px) rotate(-45deg); }
.row.picked { background: var(--lav-soft); }
.tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink); white-space: nowrap; }
.tag .dot { width: 7px; height: 7px; }
.cmd { font-family: var(--mono); font-size: 13.5px; font-weight: 450; }
.verb { display: inline-block; font-family: var(--sans); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--pill); border-radius: 6px; padding: 1px 6px; margin-right: 8px; vertical-align: 1px; }
.verb.bad { color: var(--bad); background: var(--bad-bg); }
.detail h2 .cmd { font-size: 17px; line-height: 1.45; display: block; margin-top: 6px; }
.row:hover { background: var(--soft); }
.row.sel { background: var(--soft); }
.row.sel::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; background: var(--coral); border-radius: 0 2px 2px 0; }
.row .title { font-weight: 550; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.row .meta { grid-column: 1 / 3; color: var(--muted); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.row .date { color: var(--muted); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
.type { font-size: 11px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--t-note); white-space: nowrap; }
.t-decision, .t-trade-off, .t-reasoning { --tc: var(--t-decision); }
.t-gotcha { --tc: var(--t-gotcha); }
.t-problem-solution { --tc: var(--t-fix); }
.t-how-it-works, .t-why-it-exists { --tc: var(--t-how); }
.t-what-changed, .t-session-request { --tc: var(--t-change); }
.type[class*=t-] { color: var(--tc, var(--t-note)); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--tc, var(--t-note)); }
.flag { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; background: var(--pill); color: var(--muted); white-space: nowrap; }
.flag.warn { background: var(--warn-bg); color: var(--warn); }
.flag.ok { background: var(--ok-bg); color: var(--ok); }

.detail { background: var(--panel); border: 1.5px solid var(--line); border-radius: 26px; min-width: 0; overflow-wrap: anywhere; }
.detail h2 { font-family: var(--serif); font-weight: 400; font-size: 30px; line-height: 1.12; letter-spacing: -0.015em; margin: 10px 0 16px; }
.dhead { display: flex; align-items: center; gap: 8px; }
.dhead .idbtn { margin-left: auto; }
.empty { color: var(--muted); text-align: center; padding: 36px 10px; }
.empty img { width: 64px; height: 64px; margin-bottom: 12px; }
.empty h2 { margin: 0 0 6px; color: var(--ink); }
.empty h2 em { font-style: italic; }
.kv { display: grid; grid-template-columns: 92px 1fr; gap: 6px 14px; font-size: 13.5px; margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.md { font-size: 15px; line-height: 1.62; }
.md p, .md ul, .md ol, .md pre, .md h4 { margin: 0 0 12px; }
.md ul, .md ol { padding-left: 20px; }
.md h4 { font-family: var(--serif); font-weight: 400; font-size: 20px; margin-top: 18px; }
.md code { background: var(--soft); border-radius: 5px; padding: 1px 5px; }
.md pre { background: var(--soft); border-radius: 12px; padding: 12px 14px; overflow-x: auto; white-space: pre; }
.md pre code { background: none; padding: 0; }
.section { margin-top: 18px; }
.section h3 { font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; font-weight: 500; }
.section ul { margin: 0; padding-left: 18px; }
.files { list-style: none; padding: 0 !important; display: flex; flex-wrap: wrap; gap: 6px; }
.files li { font-family: var(--mono); font-size: 12.5px; background: var(--soft); border-radius: 8px; padding: 3px 9px; max-width: 100%; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 22px; }

.btn { border: 1.5px solid var(--line); background: var(--panel); border-radius: 11px; padding: 6px 14px; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--lav); border: 2px solid var(--ink); color: #1a1a17; font-weight: 550; }
.btn.primary:hover { filter: brightness(0.97); }
.btn.danger { color: var(--bad); }
.btn.small { padding: 3px 10px; font-size: 13px; }
.btn:disabled { opacity: 0.4; cursor: default; }
.card { background: var(--panel); border: 1.5px solid var(--line); border-radius: 22px; padding: 18px 20px; margin-bottom: 12px; }
.card .head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.card .head .title { font-family: var(--serif); font-size: 22px; }
.card p { margin: 8px 0; }
.small { font-size: 13px; color: var(--muted); }
.review { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.review input { flex: 1 1 200px; min-width: 0; }
.link { color: var(--green); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; background: none; border: 0; padding: 0; text-align: left; font-weight: 550; }

/* Help button and shortcuts */
.help { position: fixed; left: 24px; bottom: 24px; width: 52px; height: 52px; border-radius: 50%; border: 0; background: var(--lav); color: #1a1a17; font-family: var(--serif); font-size: 24px; cursor: pointer; z-index: 5; box-shadow: 0 4px 14px rgb(0 0 0 / 10%); }
.help:hover { filter: brightness(0.97); }
.keys { position: fixed; left: 24px; bottom: 88px; z-index: 5; background: var(--panel); border: 1.5px solid var(--line); border-radius: 18px; padding: 16px 18px; box-shadow: 0 10px 30px rgb(0 0 0 / 12%);
  display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; font-size: 14px; }
.keys[hidden] { display: none; }
.keys .eyebrow { grid-column: 1 / -1; font-size: 11.5px; }
kbd { background: var(--soft); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 6px; padding: 1px 7px; font-size: 12px; white-space: nowrap; justify-self: start; }

.toast { position: fixed; bottom: 30px; left: 50%; transform: translate(-50%, 8px); background: var(--green); color: var(--on-green); padding: 10px 18px; border-radius: 999px; font-size: 14px; opacity: 0; transition: opacity .18s, transform .18s; pointer-events: none; z-index: 6; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.err { color: var(--bad); }
.loading { opacity: 0.55; transition: opacity .15s; }
@media (prefers-reduced-motion: reduce) { .toast, .loading, .stat, .rail button { transition: none; } }

@media (max-width: 1150px) {
  .work, .work.norail { grid-template-columns: 190px minmax(0, 1fr); }
  .work.norail { grid-template-columns: minmax(0, 1fr); }
  .detail { grid-column: 1 / -1; position: static; max-height: none; }
  .detail-body { overflow: visible; }
}
@media (max-width: 820px) {
  :root { --top: 0px; }
  .top { position: static; padding: 12px 16px 4px; }
  .bar { flex-wrap: wrap; gap: 10px; padding: 10px 12px; }
  .seg { order: 3; width: 100%; }
  .hero { padding: 26px 16px 18px; }
  .band { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 14px; border-radius: 24px; gap: 10px; }
  .work, .work.norail { grid-template-columns: minmax(0, 1fr); padding: 4px 16px 90px; gap: 18px; }
  .rail { position: static; max-height: none; overflow-x: auto; }
  .rail .eyebrow { display: none; }
  .rail ul { display: flex; gap: 6px; border: 0; }
  .rail button { font-size: 16px; padding: 4px 12px; border-radius: 999px; background: var(--soft); white-space: nowrap; }
  .rail button.on { background: var(--lav); color: #1a1a17; }
  .rail button.on::before { display: none; }
  .detail { border-radius: 20px; }
  .detail-body { margin: 0; padding: 18px; }
  .help { left: 16px; bottom: 16px; width: 46px; height: 46px; }
  .keys { left: 16px; bottom: 74px; }
}
</style>
</head>
<body>
<header class="top">
  <div class="bar">
    <div class="brand"><img src="${LOGO_DATA_URI}" alt="">Synapse</div>
    <nav class="seg" id="views" aria-label="Views"></nav>
    <div class="right"><select id="project" aria-label="Project"></select></div>
  </div>
</header>
<section class="hero">
  <p class="eyebrow" id="eyebrow">Synapse memory</p>
  <h1>What your agents <em>remember.</em></h1>
  <p class="lede" id="lede">&nbsp;</p>
  <div class="band" id="band"></div>
</section>
<div class="work" id="work">
  <aside class="rail" id="rail" aria-label="Types"></aside>
  <main id="main" aria-live="polite"></main>
  <aside class="detail"><div class="detail-body" id="detail"></div></aside>
</div>
<button class="help" id="help" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="keys">?</button>
<div class="keys" id="keys" hidden></div>
<div class="toast" id="toast" role="status"></div>
<script>
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  let token = params.get('t');
  try {
    if (token) sessionStorage.setItem('synapse-token', token);
    else token = sessionStorage.getItem('synapse-token');
  } catch {}
  if (params.get('t')) history.replaceState(null, '', location.pathname); // keep the token out of the address bar
  const LOGO = document.querySelector('.brand img').src;

  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };
  // replaceChildren turns null into the text "null"; drop empty entries first.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); };
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), days = (Date.now() - d) / 864e5;
    if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const dayLabel = (iso) => {
    const d = new Date(iso), start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const typeLabel = (t) => t === 'problem-solution' ? 'fix' : t;
  const typeName = (t) => { const s = typeLabel(t).replace(/-/g, ' '); return s[0].toUpperCase() + s.slice(1); };
  const typeTag = (t) => h('span', { class: 'tag', title: t }, h('span', { class: 'dot t-' + t }), typeLabel(t).replace(/-/g, ' '));
  // Hook titles like "Ran: cd /repo; npm test" read better as a verb plus the command, without the cd into the project.
  function prettyTitle(title, hl) {
    const m = /^(Ran|Command failed): ([\s\S]*)$/.exec(title);
    if (!m) return hl ? marked(title) : [title];
    const cmd = m[2].replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(;|&&)\s*/, '');
    return [h('span', { class: 'verb' + (m[1] === 'Ran' ? '' : ' bad') }, m[1] === 'Ran' ? 'Ran' : 'Failed'), h('span', { class: 'cmd' }, hl ? marked(cmd) : cmd)];
  }

  // Search terms wrapped in <mark>, built from text nodes only.
  const marked = (text) => {
    const terms = S.q.split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^$|()[\]\\{}]/g, '\\$&'));
    if (!terms.length) return [text];
    const re = new RegExp('(' + terms.join('|') + ')', 'ig');
    return String(text).split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
  };

  // A small Markdown subset (fences, lists, headings, inline code, bold) rendered as DOM nodes, never as HTML.
  const FENCE = /^\s*\x60\x60\x60/, BULLET = /^\s*[-*]\s+/, NUM = /^\s*\d+[.)]\s+/, HEAD = /^#{1,6}\s/;
  const inline = (t) => t.split(/(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/).filter(Boolean).map((p) =>
    p.length > 2 && p[0] === '\x60' && p.endsWith('\x60') ? h('code', {}, p.slice(1, -1))
      : p.length > 4 && p.startsWith('**') && p.endsWith('**') ? h('strong', {}, p.slice(2, -2)) : p);
  function md(text) {
    const out = [], lines = String(text || '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (FENCE.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(h('pre', {}, h('code', {}, buf.join('\n')))); continue;
      }
      const list = BULLET.test(line) ? BULLET : NUM.test(line) ? NUM : null;
      if (list) {
        const items = [];
        while (i < lines.length && list.test(lines[i])) items.push(lines[i++].replace(list, ''));
        out.push(h(list === NUM ? 'ol' : 'ul', {}, ...items.map((t) => h('li', {}, inline(t))))); continue;
      }
      if (HEAD.test(line)) { out.push(h('h4', {}, inline(line.replace(/^#+\s*/, '')))); i++; continue; }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !BULLET.test(lines[i]) && !NUM.test(lines[i]) && !HEAD.test(lines[i])) buf.push(lines[i++]);
      out.push(h('p', {}, inline(buf.join('\n'))));
    }
    return out;
  }

  async function api(path, query, post) {
    const url = path + (query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)) : '');
    const res = await fetch(url, post
      ? { method: 'POST', headers: { 'x-synapse-token': token || '', 'content-type': 'application/json' }, body: JSON.stringify(post) }
      : { headers: { 'x-synapse-token': token || '' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const S = { meta: null, stats: null, project: '', view: 'memories', q: '', type: '', status: 'active', source: '', curated: true,
    ltState: 'proposed', selected: null, items: [], picked: new Set(), seq: 0 };
  const VIEWS = [['memories', 'Memories'], ['changed', 'Changed'], ['candidates', 'Candidates'], ['sessions', 'Sessions'], ['longterm', 'Long-term']];
  const LIST_VIEWS = ['memories', 'changed', 'candidates'];

  function go(view, opts) {
    S.view = view; S.type = ''; S.selected = null; S.picked.clear();
    if (opts && 'curated' in opts) S.curated = opts.curated;
    renderDetail(); load();
    if (opts?.scroll) $('work').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function renderKeys() {
    fill($('keys'), h('p', { class: 'eyebrow' }, 'Keyboard'),
      h('kbd', {}, '/'), 'Search', h('kbd', {}, 'j  k'), 'Next / previous', h('kbd', {}, 'x'), 'Pick a candidate',
      h('kbd', {}, 'Esc'), 'Close or clear', h('kbd', {}, '?'), 'Show these keys');
  }
  function toggleKeys(open) {
    const k = $('keys'), show = open ?? k.hidden;
    k.hidden = !show; $('help').setAttribute('aria-expanded', String(show));
  }

  function renderNav() {
    const s = S.stats;
    const active = s?.byStatus?.active;
    const counts = { memories: active == null ? null : (S.curated ? active - (s.candidates || 0) : active), changed: s?.stale, candidates: s?.candidates };
    fill($('views'), ...VIEWS.map(([id, label]) => h('button', {
      class: S.view === id ? 'on' : '', 'aria-current': S.view === id ? 'page' : null,
      onclick: () => { if (S.view !== id) go(id); },
    }, label, counts[id] != null ? h('span', { class: 'count' + (id === 'changed' && counts[id] ? ' warn' : '') }, counts[id]) : null)));
  }

  function renderHero() {
    const s = S.stats;
    if (!s) return;
    const active = s.byStatus.active || 0, curated = active - (s.candidates || 0);
    $('eyebrow').textContent = 'Synapse  ·  ' + S.project;
    const lede = [h('b', {}, plural(curated, 'curated memory', 'curated memories')), ' and ', h('b', {}, plural(s.candidates, 'candidate', 'candidates')), ' waiting for review'];
    if (s.stale) lede.push('. ', h('b', {}, String(s.stale)), (s.stale === 1 ? ' names a file' : ' name files') + ' edited since, worth a check.');
    else lede.push('.');
    fill($('lede'), lede);
    const stat = (label, num, onclick, cls, sub) => h(onclick ? 'button' : 'div', { class: 'stat' + (onclick ? '' : ' static') + (cls ? ' ' + cls : ''), onclick },
      h('div', { class: 'label' }, label), h('div', { class: 'num' }, num == null ? '–' : String(num), sub ? h('small', {}, sub) : null));
    fill($('band'),
      stat('Curated', curated, () => go('memories', { curated: true, scroll: true })),
      stat('Candidates', s.candidates, () => go('candidates', { scroll: true })),
      stat('Changed since', s.stale, s.stale == null ? null : () => go('changed', { scroll: true }), s.stale ? 'alert' : ''),
      stat('Sessions', s.sessions ?? 0, () => go('sessions', { scroll: true })));
  }

  async function loadStats() {
    S.stats = await api('/api/stats', { project: S.project });
    renderNav();
    renderHero();
  }

  function markSelected() {
    document.querySelectorAll('.row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.id) === S.selected));
  }

  function memoryRow(m, opts) {
    const bulk = opts?.bulk;
    const flags = [];
    if (m.changes.length) flags.push(h('span', { class: 'flag warn', title: m.changes.map((c) => c.file + ' ' + c.change).join(', ') }, 'changed since: ' + m.changes.map((c) => c.file).slice(0, 2).join(', ') + (m.changes.length > 2 ? ' +' + (m.changes.length - 2) : '')));
    if (m.admission === 'candidate' && S.view !== 'candidates') flags.push(h('span', { class: 'flag' }, 'candidate'));
    if (m.status !== 'active') flags.push(h('span', { class: 'flag' }, m.status));
    if (m.source !== 'agent' && !(S.view === 'candidates' && m.source === 'hook')) flags.push(h('span', { class: 'flag' }, m.source));
    return h('div', { class: 'row' + (bulk ? ' bulkrow' : '') + (bulk && S.picked.has(m.id) ? ' picked' : '') + (S.selected === m.id ? ' sel' : ''), 'data-id': m.id, tabindex: 0, role: 'button',
      onclick: () => select(m.id), onkeydown: (e) => { if (e.key === 'Enter') select(m.id); } },
      bulk ? h('input', { type: 'checkbox', 'aria-label': 'Pick #' + m.id, checked: S.picked.has(m.id),
        onclick: (e) => e.stopPropagation(), onchange: (e) => togglePick(m.id, e.target.checked) }) : null,
      h('span', { class: 'title' }, prettyTitle(m.title, true)),
      h('span', { class: 'date' }, when(m.updatedAt || m.createdAt)),
      h('div', { class: 'meta' }, typeTag(m.type), h('span', {}, m.entity), h('span', { class: 'mono' }, '#' + m.id), ...flags));
  }

  function rowsByDay(items, opts) {
    const out = [];
    let last = '';
    for (const m of items) {
      const label = dayLabel(m.updatedAt || m.createdAt);
      if (label !== last && !S.q) { out.push(h('div', { class: 'day' }, label)); last = label; }
      out.push(memoryRow(m, opts));
    }
    return out;
  }

  function toolbar() {
    const sel = (value, opts, on, label) => h('select', { 'aria-label': label, onchange: (e) => { on(e.target.value); load(true); } },
      ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    let timer;
    return h('div', { class: 'toolbar' },
      h('input', { type: 'search', id: 'q', placeholder: 'Search memories…', value: S.q, 'aria-label': 'Search',
        oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { S.q = e.target.value; load(true); }, 180); } }),
      sel(S.status, [['active', 'Active'], ['resolved', 'Resolved'], ['archived', 'Archived'], ['all', 'Any status']], (v) => (S.status = v), 'Status'),
      sel(S.source, [['', 'Any source'], ['agent', 'Stored by agents'], ['hook', 'Captured by hooks'], ['git', 'From git']], (v) => (S.source = v), 'Source'),
      S.view === 'memories' ? h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !S.curated,
        onchange: (e) => { S.curated = !e.target.checked; renderNav(); load(true); } }), 'Include candidates') : null);
  }

  function renderRail(byType) {
    const entries = Object.entries(byType || {}).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((n, [, c]) => n + c, 0);
    if (S.type && !byType[S.type]) entries.push([S.type, 0]);
    const item = (type, label, n) => h('li', {}, h('button', { class: S.type === type ? 'on' : '', 'aria-pressed': S.type === type ? 'true' : 'false',
      onclick: () => { S.type = S.type === type ? '' : type; load(true); } }, label, h('span', {}, n)));
    fill($('rail'), h('p', { class: 'eyebrow' }, 'Types'), h('ul', {}, item('', 'Everything', total), ...entries.map(([t, n]) => item(t, typeName(t), n))));
  }

  function renderBulk() {
    const el = $('bulk');
    if (!el) return;
    const shown = S.items.map((m) => m.id), n = S.picked.size, all = shown.length > 0 && shown.every((id) => S.picked.has(id));
    const run = async (path, body, done) => {
      const ids = [...S.picked];
      let failed = 0;
      for (const id of ids) { try { await api(path, null, { id, ...body }); } catch { failed++; } }
      S.picked.clear();
      toast(done(ids.length - failed) + (failed ? ', ' + failed + ' failed' : ''));
      await refresh(S.selected && ids.includes(S.selected) ? S.selected : null);
    };
    el.classList.toggle('on', n > 0);
    fill(el,
      h('input', { type: 'checkbox', checked: all, disabled: !shown.length, 'aria-label': all ? 'Unpick all shown' : 'Pick all shown', title: 'Pick all shown',
        onchange: (e) => { shown.forEach((id) => (e.target.checked ? S.picked.add(id) : S.picked.delete(id))); syncPicks(); } }),
      h('span', { class: 'n' }, n ? n + ' of ' + shown.length + ' picked' : 'Select all, or tick rows (x)'),
      h('button', { class: 'btn primary small', disabled: !n, onclick: () => run('/api/memory/qualify', {}, (k) => 'Kept ' + plural(k, 'candidate', 'candidates')) }, 'Keep'),
      h('button', { class: 'btn danger small', disabled: !n, onclick: () => run('/api/memory/status', { status: 'archived' }, (k) => 'Archived ' + k) }, 'Archive'));
  }

  function togglePick(id, on) {
    if (on ?? !S.picked.has(id)) S.picked.add(id); else S.picked.delete(id);
    syncPicks();
  }
  function syncPicks() {
    document.querySelectorAll('.row.bulkrow').forEach((r) => {
      const on = S.picked.has(Number(r.dataset.id)), c = r.querySelector('input');
      if (c) c.checked = on;
      r.classList.toggle('picked', on);
    });
    renderBulk();
  }

  async function loadMemories(extra, hint) {
    const main = $('main');
    if (!main.querySelector('.toolbar')) {
      fill(main, toolbar(), S.view === 'candidates' ? h('div', { class: 'bulk', id: 'bulk' }) : null, h('p', { class: 'hint', id: 'hint' }), h('div', { id: 'results' }));
    }
    $('results').classList.add('loading');
    const seq = ++S.seq;
    const res = await api('/api/memories', { project: S.project, q: S.q, type: S.type, status: S.status, source: S.source, limit: 200, ...extra });
    if (seq !== S.seq) return;
    S.items = res.items;
    const ids = new Set(res.items.map((m) => m.id));
    for (const id of [...S.picked]) if (!ids.has(id)) S.picked.delete(id);
    $('hint').textContent = hint ? hint(res)
      : plural(res.total, 'memory', 'memories') + (res.total > res.items.length ? ', showing ' + res.items.length : '') + (S.q ? ' matching "' + S.q + '"' : '') + (S.curated && S.view === 'memories' ? ' (candidates hidden)' : '');
    renderRail(res.byType);
    renderBulk();
    const results = $('results');
    results.classList.remove('loading');
    fill(results, res.items.length ? h('div', { class: 'list' }, rowsByDay(res.items, { bulk: S.view === 'candidates' })) : h('p', { class: 'small' }, S.q ? 'No matches.' : 'Nothing here.'));
  }

  async function loadSessions() {
    const sessions = await api('/api/sessions', { project: S.project });
    S.items = [];
    const span = (s) => {
      if (!s.endedAt) return '';
      const min = Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 6e4);
      return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
    };
    fill($('main'), h('p', { class: 'hint' }, plural(sessions.length, 'recent session', 'recent sessions') + ', newest first.'),
      ...sessions.map((s) => h('div', { class: 'card' },
        h('div', { class: 'head' },
          h('span', { class: 'title' }, s.agent || 'session'),
          h('span', { class: 'flag' + (s.status === 'active' ? ' ok' : '') }, s.status),
          h('span', { class: 'small' }, when(s.startedAt) + (s.endedAt ? ' → ' + when(s.endedAt) : '') + (span(s) ? ' · ' + span(s) : '')),
          h('span', { class: 'small' }, plural(s.memories, 'record', 'records'))),
        s.summary ? h('p', {}, s.summary) : h('p', { class: 'small' }, 'No summary yet.'),
        s.checkpoints.length ? h('p', { class: 'small' }, plural(s.checkpoints.length, 'checkpoint', 'checkpoints') + ': ' + s.checkpoints[0].text.slice(0, 160)) : null,
        s.memories ? h('button', { class: 'link', onclick: () => showSession(s) }, 'Show its records') : null)));
  }

  async function showSession(s) {
    const { items } = await api('/api/session', { id: s.id });
    S.selected = null;
    fill($('detail'), h('div', { class: 'dhead' }, h('span', { class: 'eyebrow mono' }, 'Session ' + s.id.slice(0, 8))), h('h2', {}, s.agent || 'session'),
      s.summary ? h('div', { class: 'md' }, md(s.summary)) : null,
      h('div', { class: 'section' }, h('h3', {}, plural(items.length, 'record', 'records')),
        items.length ? h('div', { class: 'list' }, ...items.map((m) => memoryRow(m))) : h('p', { class: 'small' }, 'None.')));
    revealDetail();
  }

  async function loadLongTerm() {
    const items = await api('/api/longterm', { project: S.project, state: S.ltState });
    S.items = [];
    const tabs = h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'State', onchange: (e) => { S.ltState = e.target.value; load(); } },
      ...[...S.meta.ltStates, 'all'].map((v) => h('option', { value: v, selected: v === S.ltState }, v === 'all' ? 'Any state' : v[0].toUpperCase() + v.slice(1)))));
    const hint = S.ltState === 'proposed'
      ? 'Proposals wait for your review. Approved items reach every brief; give a reason either way.'
      : plural(items.length, S.ltState + ' item', S.ltState + ' items') + '.';
    fill($('main'), tabs, h('p', { class: 'hint' }, hint), ...(items.length ? items.map(ltCard) : [h('p', { class: 'small' }, 'Nothing here.')]));
  }

  function ltCard(i) {
    const reason = h('input', { type: 'text', placeholder: 'Reason (required)', 'aria-label': 'Reason' });
    const review = async (action) => {
      if (!reason.value.trim()) { reason.focus(); toast('Add a reason first'); return; }
      try { await api('/api/longterm/review', null, { project: S.project, id: i.id, action, reason: reason.value }); toast(action === 'approve' ? 'Approved' : 'Archived'); load(); }
      catch (e) { toast(e.message); }
    };
    return h('div', { class: 'card' },
      h('div', { class: 'head' }, h('span', { class: 'type' }, i.kind), h('span', { class: 'title' }, i.title),
        h('span', { class: 'flag' }, i.scope === 'user' ? 'all projects' : 'this project'), h('span', { class: 'small' }, 'LT' + i.id + ' · ' + when(i.createdAt))),
      h('div', { class: 'md' }, md(i.body)),
      i.applicability ? h('p', { class: 'small' }, 'Applies ' + i.applicability) : null,
      i.evidence.length ? h('p', { class: 'small' }, 'Evidence: ' + i.evidence.join(', ')) : null,
      i.reason ? h('p', { class: 'small' }, 'Last review: ' + i.reason) : null,
      i.state === 'proposed' || i.state === 'approved'
        ? h('div', { class: 'review' }, reason,
            i.state === 'proposed' ? h('button', { class: 'btn primary', onclick: () => review('approve') }, 'Approve') : null,
            h('button', { class: 'btn danger', onclick: () => review('archive') }, i.state === 'proposed' ? 'Reject' : 'Retire'))
        : null);
  }

  const narrow = () => matchMedia('(max-width: 1150px)').matches;
  function revealDetail() { if (narrow()) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  async function select(id, fromKeys) {
    S.selected = id;
    markSelected();
    const row = document.querySelector('.row[data-id="' + id + '"]');
    if (fromKeys && row) { row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true }); }
    const seq = (select.seq = (select.seq || 0) + 1);
    const m = await api('/api/memory', { id });
    if (seq !== select.seq) return;
    renderDetail(m);
    if (!fromKeys) revealDetail();
  }

  function renderDetail(m) {
    const d = $('detail');
    if (!m) {
      fill(d, h('div', { class: 'empty' }, h('img', { src: LOGO, alt: '' }), h('h2', {}, 'Pick a memory, ', h('em', {}, 'read it whole.')),
        h('p', {}, 'Choose one from the list, or press j to start at the top.')));
      return;
    }
    const act = (label, path, body, cls, done) => h('button', { class: 'btn ' + (cls || ''), onclick: async () => {
      try { await api(path, null, { id: m.id, ...body }); toast(done); await refresh(m.id); } catch (e) { toast(e.message); }
    } }, label);
    const actions = [];
    if (m.changes.length) actions.push(act('Still true (verified)', '/api/memory/feedback', { signal: 'verified' }, 'primary', 'Marked verified'), act('Outdated', '/api/memory/feedback', { signal: 'outdated' }, 'danger', 'Marked outdated and resolved'));
    if (m.admission === 'candidate') actions.push(act('Keep (qualify)', '/api/memory/qualify', {}, m.changes.length ? '' : 'primary', 'Qualified'));
    if (m.status === 'active') actions.push(act('Resolve', '/api/memory/status', { status: 'resolved' }, '', 'Resolved'), act('Archive', '/api/memory/status', { status: 'archived' }, 'danger', 'Archived'));
    else actions.push(act('Reopen', '/api/memory/status', { status: 'active' }, '', 'Reopened'));
    if (!m.changes.length && m.status === 'active') actions.push(act('Helpful', '/api/memory/feedback', { signal: 'helpful' }, '', 'Thanks, noted'));
    const kv = [
      ['Area', m.entity], ['Status', m.status + (m.admission === 'candidate' ? ' · candidate' : '')], ['Source', m.source],
      ['Created', new Date(m.createdAt).toLocaleString()], m.updatedAt ? ['Updated', new Date(m.updatedAt).toLocaleString() + (m.revisionCount > 1 ? ' · revision ' + m.revisionCount : '')] : null,
      m.topicKey ? ['Topic', h('span', { class: 'mono' }, m.topicKey)] : null, m.sessionId ? ['Session', h('span', { class: 'mono' }, m.sessionId.slice(0, 8))] : null,
      m.commitHash ? ['Commit', h('span', { class: 'mono' }, m.commitHash.slice(0, 10))] : null, m.access ? ['Read', plural(m.access.accessCount, 'time', 'times')] : null,
    ].filter(Boolean);
    const list = (title, items) => items && items.length ? h('div', { class: 'section' }, h('h3', {}, title), h('ul', {}, ...items.map((x) => h('li', {}, inline(x))))) : null;
    const copyId = h('button', { class: 'btn small idbtn mono', title: 'Copy the id', onclick: async () => {
      try { await navigator.clipboard.writeText(String(m.id)); toast('Copied #' + m.id); } catch { toast('#' + m.id); }
    } }, '#' + m.id);
    fill(d,
      h('div', { class: 'dhead' }, h('span', { class: 'dot t-' + m.type }), h('span', { class: 'type t-' + m.type }, m.type), copyId),
      h('h2', {}, prettyTitle(m.title)),
      m.changes.length ? h('p', {}, h('span', { class: 'flag warn' }, 'Changed since stored: ' + m.changes.map((c) => c.file + ' (' + c.change + ')').join(', ')), ' ', h('span', { class: 'small' }, 'Check the current code, then mark it.')) : null,
      h('div', { class: 'md' }, m.narrative ? md(m.narrative) : h('p', { class: 'small' }, 'No narrative.')),
      list('Facts', m.facts),
      m.files && m.files.length ? h('div', { class: 'section' }, h('h3', {}, 'Files'), h('ul', { class: 'files' }, ...m.files.map((f) => h('li', {}, f)))) : null,
      m.concepts && m.concepts.length ? h('div', { class: 'section' }, h('h3', {}, 'Concepts'), h('div', { class: 'chips' }, ...m.concepts.map((c) => h('span', { class: 'flag' }, c)))) : null,
      m.replacedBy ? h('div', { class: 'section' }, h('h3', {}, 'Replaced by'), h('button', { class: 'link', onclick: () => select(m.replacedBy.id) }, '#' + m.replacedBy.id + ' ' + m.replacedBy.title)) : null,
      m.replaces.length ? h('div', { class: 'section' }, h('h3', {}, 'Replaces'), h('ul', {}, ...m.replaces.map((r) => h('li', {}, h('button', { class: 'link', onclick: () => select(r.id) }, '#' + r.id + ' ' + r.title))))) : null,
      list('Feedback', m.feedback.map((f) => f.signal + ' · ' + when(f.createdAt) + (f.note ? ' · ' + f.note : ''))),
      h('div', { class: 'actions' }, ...actions),
      h('dl', { class: 'kv' }, ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    d.scrollTop = 0;
  }

  async function refresh(id) {
    await Promise.all([loadStats(), load(true)]);
    if (id) {
      const m = await api('/api/memory', { id }).catch(() => null);
      renderDetail(m);
    }
  }

  async function load(keepToolbar) {
    try {
      $('work').classList.toggle('norail', !LIST_VIEWS.includes(S.view));
      if (!keepToolbar || !LIST_VIEWS.includes(S.view)) $('main').replaceChildren();
      if (S.view === 'memories') await loadMemories(S.curated ? { admission: 'qualified' } : {});
      else if (S.view === 'changed') {
        if (S.project !== S.meta.current) { S.items = []; $('work').classList.add('norail'); fill($('main'), h('p', { class: 'hint' }, 'File freshness can only be checked for the project synapse ui was started in (' + S.meta.current + ').')); return; }
        await loadMemories({ changed: 1 }, (r) => r.total + ' memor' + (r.total === 1 ? 'y names' : 'ies name') + ' files edited after it was stored. Check current code, then mark each verified or outdated.');
      } else if (S.view === 'candidates') await loadMemories({ admission: 'candidate' }, (r) => plural(r.total, 'auto-captured candidate', 'auto-captured candidates') + ' · keep the useful ones, the rest rank lower');
      else if (S.view === 'sessions') await loadSessions();
      else if (S.view === 'longterm') await loadLongTerm();
      renderNav();
      loadStats().catch(() => {});
    } catch (e) {
      fill($('main'), h('p', { class: 'err' }, e.message));
    }
  }

  $('help').onclick = () => toggleKeys();
  document.addEventListener('click', (e) => { if (!$('keys').hidden && !e.target.closest('#keys, #help')) toggleKeys(false); });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'checkbox';
    if (e.key === 'Escape') {
      if (!$('keys').hidden) { toggleKeys(false); return; }
      if (typing) { if (e.target.id === 'q' && e.target.value) return; e.target.blur(); return; }
      if (S.selected) { S.selected = null; markSelected(); renderDetail(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { toggleKeys(); return; }
    if (e.key === '/') { const q = $('q'); if (q) { e.preventDefault(); q.focus(); q.select(); } return; }
    if (!LIST_VIEWS.includes(S.view) || !S.items.length) return;
    const down = e.key === 'j' || e.key === 'ArrowDown', up = e.key === 'k' || e.key === 'ArrowUp';
    if (down || up) {
      e.preventDefault();
      const i = S.items.findIndex((m) => m.id === S.selected);
      const next = i < 0 ? 0 : Math.max(0, Math.min(S.items.length - 1, i + (down ? 1 : -1)));
      if (S.items[next].id !== S.selected) select(S.items[next].id, true);
    } else if (e.key === 'x' && S.view === 'candidates' && S.selected) togglePick(S.selected);
  });

  async function init() {
    renderKeys();
    renderDetail();
    if (!token) { fill($('main'), h('p', { class: 'err' }, 'Open the URL printed by "synapse ui" (it carries an access token).')); return; }
    try { S.meta = await api('/api/state'); } catch (e) { fill($('main'), h('p', { class: 'err' }, e.message)); return; }
    S.project = S.meta.current;
    const ids = new Set(S.meta.projects.map((p) => p.projectId));
    const options = [...(ids.has(S.meta.current) ? [] : [{ projectId: S.meta.current, count: 0 }]), ...S.meta.projects];
    $('project').replaceChildren(...options.map((p) => h('option', { value: p.projectId, selected: p.projectId === S.project }, p.projectId + ' (' + p.count + ')')));
    $('project').onchange = (e) => { S.project = e.target.value; go(S.view); };
    await load();
  }
  init();
})();
</script>
</body>
</html>`;
