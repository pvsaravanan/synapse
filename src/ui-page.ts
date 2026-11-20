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
.dactions { flex: none; display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 18px 14px 26px; border-top: 1px solid var(--line); background: var(--panel); }
.dactions:empty { display: none; }
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
.kv { display: grid; grid-template-columns: 84px 1fr; gap: 6px 14px; font-size: 13px; margin: 0; padding: 12px 14px; background: var(--soft); border-radius: 14px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.md { font-size: 15px; line-height: 1.62; }
.md p, .md ul, .md ol, .md pre, .md h4 { margin: 0 0 12px; }
.md ul, .md ol { padding-left: 20px; }
.md h4 { font-family: var(--serif); font-weight: 400; font-size: 20px; margin-top: 18px; }
.md .lead { font-family: var(--serif); font-size: 19px; line-height: 1.4; margin-bottom: 14px; }
.md h5 { font-size: 11.5px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin: 18px 0 4px; }
.md h5 + p, .md h5 + ul { margin-top: 0; }
.md ol.enum { padding-left: 0; list-style: none; counter-reset: enum; }
.md ol.enum li { counter-increment: enum; position: relative; padding: 9px 0 9px 34px; border-top: 1px solid var(--line); }
.md ol.enum li:first-child { border-top: 0; }
.md ol.enum li::before { content: counter(enum); position: absolute; left: 0; top: 9px; width: 22px; height: 22px; border-radius: 50%; background: var(--lav-soft); color: var(--ink); font-size: 12px; font-weight: 600; display: grid; place-items: center; }
.md li + li { margin-top: 4px; }
.md pre.out { max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
.md pre.cmdblock { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--green); color: var(--on-green); }
.dflags { margin: -6px 0 14px; }
.md code { background: var(--soft); border-radius: 5px; padding: 1px 5px; }
.md pre { background: var(--soft); border-radius: 12px; padding: 12px 14px; overflow-x: auto; white-space: pre; }
.md pre code { background: none; padding: 0; }
.section { margin-top: 22px; }
.md > .section:first-child { margin-top: 0; }
.section h3 { font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; font-weight: 500; }
.section ul { margin: 0; padding-left: 18px; }
.files { list-style: none; padding: 0 !important; display: flex; flex-wrap: wrap; gap: 6px; }
.files li { font-family: var(--mono); font-size: 12.5px; background: var(--soft); border-radius: 8px; padding: 3px 9px; max-width: 100%; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }

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
/* Graph view */
.gwrap { position: relative; background: var(--panel); border: 1.5px solid var(--line); border-radius: 22px; overflow: hidden; height: max(460px, calc(100vh - var(--top) - 190px)); }
.gwrap canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.gwrap canvas.over { cursor: pointer; }
.gwrap canvas.dragging { cursor: grabbing; }
.gtools { position: absolute; right: 12px; top: 12px; display: flex; gap: 6px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin: 0 0 12px; font-size: 12.5px; color: var(--muted); }
.legend .k { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend .sw { width: 11px; height: 11px; border-radius: 50%; display: inline-block; flex: none; }
.legend .sw.ent { width: 13px; height: 13px; background: var(--green); }
.legend .sw.file { background: var(--panel); border: 1.5px solid var(--faint); border-radius: 3px; }
.legend .sw.con { background: var(--lav); border: 1.5px solid #a98bd0; }
.legend .sw.cand { background: var(--panel); border: 2px solid var(--muted); }
.legend .chip { display: inline-flex; align-items: center; gap: 6px; border: 1.5px solid var(--line); background: var(--panel); border-radius: 999px; padding: 2px 10px 2px 8px; font-size: 12.5px; color: var(--ink); cursor: pointer; transition: opacity .15s, border-color .15s; }
.legend .chip:hover { border-color: var(--faint); }
.legend .chip.off { opacity: 0.45; }
.legend .chip.off > :not(.n) { text-decoration: line-through; }
.legend .chip .n { color: var(--muted); font-variant-numeric: tabular-nums; }
.legend .note { color: var(--muted); }
.gtools .btn { min-width: 34px; background: color-mix(in srgb, var(--panel) 92%, transparent); }
.gtools .btn.on { background: var(--lav); }
.gtip { position: absolute; z-index: 2; pointer-events: none; max-width: 300px; background: var(--panel); border: 1.5px solid var(--line); border-radius: 12px; padding: 8px 12px; box-shadow: 0 6px 20px rgb(0 0 0 / 10%); font-size: 13px; line-height: 1.4; }
.gtip[hidden], .gforces[hidden], .glocal[hidden] { display: none; }
.gtip .t { font-weight: 600; overflow-wrap: anywhere; margin: 2px 0; }
.gtip .t .cmd { font-size: 12.5px; }
.gtip .m { color: var(--muted); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gforces { position: absolute; right: 12px; top: 50px; z-index: 2; background: var(--panel); border: 1.5px solid var(--line); border-radius: 14px; padding: 12px 14px; display: grid; grid-template-columns: auto 130px; gap: 8px 12px; align-items: center; font-size: 13px; box-shadow: 0 6px 20px rgb(0 0 0 / 8%); }
.gforces input[type=range] { accent-color: var(--green); width: 130px; margin: 0; }
.gforces .btn { justify-self: end; }
.glocal { position: absolute; left: 12px; bottom: 12px; z-index: 2; display: flex; align-items: center; gap: 8px; background: var(--lav-soft); border: 1.5px solid color-mix(in srgb, var(--lav) 70%, var(--line)); border-radius: 999px; padding: 4px 5px 4px 14px; font-size: 13px; max-width: calc(100% - 24px); }
.glocal b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 240px; }
.glocal .depth { display: flex; gap: 2px; background: var(--pill); border-radius: 999px; padding: 2px; flex: none; }
.glocal .depth button { border: 0; background: none; border-radius: 999px; padding: 1px 9px; cursor: pointer; font-size: 12.5px; }
.glocal .depth button.on { background: var(--panel); box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
.glocal .btn { flex: none; border-radius: 999px; }
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
@media (prefers-reduced-motion: reduce) { .toast, .loading, .stat, .rail button, .legend .chip { transition: none; } }

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
  <aside class="detail"><div class="detail-body" id="detail"></div><div class="dactions" id="dactions"></div></aside>
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
  // Pasting a new run's link into this tab only changes the hash, which doesn't reload the page; reload to pick up its token.
  addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).get('t')) location.reload(); });
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
  // Code-like words in plain text (file paths, fn(), ENV_VARS, --flags, camelCase names) render as code.
  const AUTO = /((?:~|\.[\w-]+)?\/?(?:[\w.@-]+\/)*[\w@-][\w@.-]*\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|sh|py|ya?ml|toml|txt|db|html|css|sql|lock|log)\b|~\/[\w.\/-]+|\.(?:npmrc|env|gitignore|synapseignore)\b|\b[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\(\)|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|(?<![\w-])--[a-z][\w-]+|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:[a-z]\w*\.)*[a-z]+[A-Z][A-Za-z0-9]*(?:\.[a-z]\w*)*\b)/;
  const NOT_CODE = /^(macOS|iOS|iPadOS|iPhone|iPad|eBay)$/;
  const autoCode = (t) => t.split(AUTO).map((p, i) => (i % 2 && !NOT_CODE.test(p) ? h('code', {}, p) : p)).filter((p) => p !== '');
  const inline = (t) => t.split(/(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/).filter(Boolean).flatMap((p) =>
    p.length > 2 && p[0] === '\x60' && p.endsWith('\x60') ? [h('code', {}, p.slice(1, -1))]
      : p.length > 4 && p.startsWith('**') && p.endsWith('**') ? [h('strong', {}, p.slice(2, -2))] : autoCode(p));

  // Memories are often one dense paragraph. Split it into sentences (not at "e.g." or inside version numbers), lift the
  // first into a summary line, turn "Label: ..." sentences into small headings, "(1) ... (2) ..." into a numbered list and
  // three or more "; "-separated items under a label into bullets.
  function sentences(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const re = /[.!?]["')\]]?\s+(?=[A-Z(\x22'\x60~])/g;
      let start = 0, m;
      while ((m = re.exec(line))) {
        if (/(\be\.g|\bi\.e|\betc|\bvs|\bcf)\.$/i.test(line.slice(Math.max(0, m.index - 4), m.index + 1))) continue;
        out.push(line.slice(start, m.index + m[0].length).trim());
        start = m.index + m[0].length;
      }
      if (line.slice(start).trim()) out.push(line.slice(start).trim());
    }
    return out;
  }
  // "; " splits outside parentheses and quotes only, so "(a; b)" stays in one item.
  function splitTop(text) {
    const out = [];
    let depth = 0, quote = '', start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === '\x60') quote = c;
      else if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth) depth--;
      else if (c === ';' && !depth && text[i + 1] === ' ') { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }
  const LABEL = /^([A-Z][A-Za-z0-9 /&+-]{0,28}?):\s+(\S[\s\S]*)$/;
  function prose(text, lede) {
    const parts = String(text).split(/\s*\((\d{1,2})\)\s+/);
    let intro = String(text), items = null;
    if (parts.length >= 5 && parts[1] === '1' && parts[3] === '2') {
      intro = parts[0];
      items = [];
      for (let i = 1; i + 1 < parts.length; i += 2) items.push(parts[i + 1].trim().replace(/;$/, '.'));
    }
    const out = [], sents = sentences(intro);
    let i = 0, plain = [];
    if (lede && (sents.length > 1 || (items && sents.length))) out.push(h('p', { class: 'lead' }, inline(sents[i++])));
    const flush = () => { if (plain.length) out.push(h('p', {}, inline(plain.join(' ')))); plain = []; };
    for (; i < sents.length; i++) {
      const m = LABEL.exec(sents[i]);
      if (m && m[1].trim().split(/\s+/).length <= 4) {
        flush();
        out.push(h('h5', {}, m[1]));
        const bits = splitTop(m[2]);
        if (bits.length >= 3) out.push(h('ul', {}, ...bits.map((b) => h('li', {}, inline(b.replace(/\.$/, ''))))));
        else plain.push(m[2]);
        continue;
      }
      plain.push(sents[i]);
      if (plain.length >= 3) flush();
    }
    flush();
    if (items) out.push(h('ol', { class: 'enum' }, ...items.map((t) => h('li', {}, inline(t)))));
    return out;
  }
  function md(text, opts) {
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
      out.push(...prose(buf.join('\n'), opts && opts.lede && !out.length));
    }
    return out;
  }

  // Hook records: "$ command", a blank line, then its output; or "Latest change excerpt:" and the changed lines.
  function hookBody(text) {
    const lines = String(text).split('\n'), cmd = [];
    let i = 0;
    while (i < lines.length && lines[i].trim() !== '') cmd.push(lines[i++]);
    const output = lines.slice(i).join('\n').trim();
    return [h('div', { class: 'section' }, h('h3', {}, 'Command'), h('pre', { class: 'cmdblock' }, h('code', {}, cmd.join('\n').replace(/^\$\s*/, '')))),
      output ? h('div', { class: 'section' }, h('h3', {}, 'Output'), h('pre', { class: 'out' }, h('code', {}, output))) : null];
  }
  function excerptBody(text) {
    return [h('div', { class: 'section' }, h('h3', {}, 'Change excerpt'), h('pre', { class: 'out' }, h('code', {}, String(text).replace(/^Latest change excerpt:\n/, ''))))];
  }
  const narrative = (t) => !t ? [h('p', { class: 'small' }, 'No narrative.')]
    : /^\$ /.test(t) ? hookBody(t) : /^Latest change excerpt:\n/.test(t) ? excerptBody(t) : md(t, { lede: true });

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
  const VIEWS = [['memories', 'Memories'], ['graph', 'Graph'], ['changed', 'Changed'], ['candidates', 'Candidates'], ['sessions', 'Sessions'], ['longterm', 'Long-term']];
  const LIST_VIEWS = ['memories', 'changed', 'candidates'];

  function go(view, opts) {
    S.view = view; S.type = ''; S.selected = null; S.picked.clear(); G.focus = null;
    if (opts && 'curated' in opts) S.curated = opts.curated;
    renderDetail(); load();
    if (opts?.scroll) $('work').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function renderKeys() {
    fill($('keys'), h('p', { class: 'eyebrow' }, 'Keyboard'),
      h('kbd', {}, '/'), 'Search', h('kbd', {}, 'j  k'), 'Next / previous', h('kbd', {}, 'x'), 'Pick a candidate',
      h('kbd', {}, 'Esc'), 'Close or clear', h('kbd', {}, '?'), 'Show these keys',
      h('p', { class: 'eyebrow' }, 'Graph'), h('kbd', {}, 'Enter'), 'Jump to the next match', h('kbd', {}, 'f'), 'Fit the map',
      h('kbd', {}, '+  −'), 'Zoom in / out', h('kbd', {}, 'l'), 'Local graph of the open node', h('kbd', {}, 'dbl-click'), 'Local graph of a node');
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
    fill($('dactions'));
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

  // Graph view: memories linked to their components, files and (optionally) concepts, laid out by a small force
  // simulation on a canvas. Positions, zoom, hidden kinds, the local graph and the forces survive a rebuild.
  const FORCES = { repel: 150, dist: 1, gravity: 0.06 };
  const G = { files: true, concepts: false, q: '', qi: -1, pos: new Map(), T: null, focus: null, byId: new Map(), nodes: null,
    hidden: new Set(), local: null, forces: { ...FORCES }, showForces: false,
    // Hooks the live graph sets; each checks its canvas is still on the page.
    redraw: null, reveal: null, peek: null, keys: null, escape: null, find: null };
  const TYPE_VAR = { decision: '--t-decision', 'trade-off': '--t-decision', reasoning: '--t-decision', gotcha: '--t-gotcha', 'problem-solution': '--t-fix',
    'how-it-works': '--t-how', 'why-it-exists': '--t-how', 'what-changed': '--t-change', 'session-request': '--t-change' };
  const KIND_NAME = { entity: 'Component', file: 'File', concept: 'Concept' };
  const hash = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619); return (x >>> 0) / 4294967296; };
  const shortLabel = (n) => {
    let t = n.label;
    const m = /^(Ran|Command failed): ([\s\S]*)$/.exec(t);
    if (m) t = (m[1] === 'Ran' ? '' : 'Failed: ') + m[2].replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(;|&&)\s*/, '');
    if (n.kind === 'file') t = t.split('/').slice(-2).join('/');
    return t.length > 46 ? t.slice(0, 45) + '…' : t;
  };

  function graphToolbar() {
    const check = (label, on, set) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => { set(e.target.checked); load(); } }), label);
    return h('div', { class: 'toolbar' },
      h('input', { type: 'search', id: 'q', placeholder: 'Find a node, Enter to jump…', value: G.q, 'aria-label': 'Find a node',
        oninput: (e) => { G.q = e.target.value; G.qi = -1; if (G.redraw) G.redraw(); },
        onkeydown: (e) => { if (e.key === 'Enter' && G.find) { e.preventDefault(); G.find(e.shiftKey ? -1 : 1); } } }),
      h('select', { 'aria-label': 'Status', onchange: (e) => { S.status = e.target.value; load(); } },
        ...[['active', 'Active'], ['resolved', 'Resolved'], ['archived', 'Archived'], ['all', 'Any status']].map(([v, l]) => h('option', { value: v, selected: v === S.status }, l))),
      check('Files', G.files, (v) => (G.files = v)),
      check('Concepts', G.concepts, (v) => (G.concepts = v)),
      check('Candidates', !S.curated, (v) => { S.curated = !v; renderNav(); }));
  }

  function showNode(n) {
    fill($('dactions'));
    const linked = [...n.nb].filter((x) => x.m).map((x) => x.m).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    fill($('detail'),
      h('div', { class: 'dhead' }, h('span', { class: 'eyebrow' }, KIND_NAME[n.kind]),
        h('button', { class: 'btn small idbtn', title: 'Show only this node and its neighbours (l)', onclick: () => G.local0 && G.local0(n) }, 'Local graph')),
      h('h2', {}, n.kind === 'file' ? h('span', { class: 'cmd' }, n.label) : n.label),
      h('div', { class: 'section' }, h('h3', {}, plural(linked.length, 'memory', 'memories')),
        linked.length ? h('div', { class: 'list' }, ...linked.map((m) => memoryRow(m))) : h('p', { class: 'small' }, 'None.')));
    $('detail').scrollTop = 0;
    revealDetail();
  }

  async function loadGraph() {
    const res = await api('/api/graph', { project: S.project, status: S.status, candidates: S.curated ? '' : 1, files: G.files ? '' : 0, concepts: G.concepts ? 1 : '' });
    S.items = [];
    if (G.nodes) for (const n of G.nodes) G.pos.set(n.id, { x: n.x, y: n.y });
    const mems = new Map(res.memories.map((m) => [m.id, m]));
    const typeCounts = {}, kindCounts = {};
    for (const m of res.memories) typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
    for (const n of res.nodes) kindCounts[n.kind] = (kindCounts[n.kind] || 0) + 1;

    const legendEl = h('div', { class: 'legend', role: 'group', 'aria-label': 'Show or hide kinds of node' });
    const hintEl = h('p', { class: 'hint' });
    const canvas = h('canvas', { role: 'img', 'aria-label': 'Map of memories and the components and files they link to' });
    const tip = h('div', { class: 'gtip', hidden: true });
    const forcesEl = h('div', { class: 'gforces', hidden: !G.showForces });
    const localEl = h('div', { class: 'glocal', hidden: true });
    const forcesBtn = h('button', { class: 'btn small' + (G.showForces ? ' on' : ''), 'aria-expanded': String(G.showForces), title: 'Tune the layout',
      onclick: () => { G.showForces = !G.showForces; forcesEl.hidden = !G.showForces; forcesBtn.classList.toggle('on', G.showForces); forcesBtn.setAttribute('aria-expanded', String(G.showForces)); } }, 'Forces');
    const tools = h('div', { class: 'gtools' },
      h('button', { class: 'btn small', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.4) }, '−'),
      h('button', { class: 'btn small', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.4) }, '+'),
      h('button', { class: 'btn small', title: 'Fit the map in view (f)', onclick: () => fitView(true) }, 'Fit'),
      forcesBtn);
    fill($('main'), graphToolbar(), legendEl, hintEl,
      res.nodes.length ? h('div', { class: 'gwrap' }, canvas, tools, forcesEl, localEl, tip) : h('p', { class: 'small' }, 'Nothing to map.'));
    if (!res.nodes.length) {
      G.nodes = null; G.byId = new Map(); G.redraw = G.reveal = G.peek = G.keys = G.escape = G.find = G.local0 = null;
      return;
    }

    const css = getComputedStyle(document.documentElement), cv = (v) => css.getPropertyValue(v).trim();
    const C = { line: cv('--line'), faint: cv('--faint'), muted: cv('--muted'), ink: cv('--ink'), panel: cv('--panel'), green: cv('--green'), lav: cv('--lav'), coral: cv('--coral'), warn: cv('--warn') };
    const spread = Math.sqrt(res.nodes.length) * 28;
    let cached = 0;
    const nodes = res.nodes.map((n) => {
      const p = G.pos.get(n.id);
      if (p) cached++;
      const a = hash(n.id) * Math.PI * 2, r = Math.sqrt(hash(n.id + '#')) * spread;
      const m = n.memoryId ? mems.get(n.memoryId) : null;
      return { ...n, m, x: p ? p.x : Math.cos(a) * r, y: p ? p.y : Math.sin(a) * r, vx: 0, vy: 0, fixed: false, nb: new Set(), vd: 0,
        r: n.kind === 'memory' ? 5.5 : n.kind === 'entity' ? 7 + Math.sqrt(n.degree) * 2.2 : n.kind === 'concept' ? 4 + Math.sqrt(n.degree) * 1.5 : 3.5 + Math.sqrt(n.degree) * 1.1,
        color: m ? cv(TYPE_VAR[m.type] || '--t-note') : null };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = res.links.map((l) => ({ s: byId.get(l.source), t: byId.get(l.target), kind: l.kind })).filter((l) => l.s && l.t);
    for (const l of links) { l.s.nb.add(l.t); l.t.nb.add(l.s); l.len = l.kind === 'file' ? 42 : l.kind === 'related' ? 80 : 55; }
    G.nodes = nodes; G.byId = byId;
    if (G.focus) G.focus = byId.get(G.focus.id) || null;
    if (S.selected) G.focus = byId.get('m:' + S.selected) || G.focus;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    const fresh = cached <= nodes.length / 2;
    let alpha = fresh ? 1 : 0.3, target = 0, raf = 0, fly = 0, W = 0, H = 0;
    let hover = null, peekNode = null, drag = null, pinch = null, touched = false, fitPending = fresh;
    let vn = nodes, vl = links;
    const pts = new Map();

    // Which nodes show: not a hidden type or kind, inside the local graph if one is open, and (for components, files
    // and concepts) still linked to a shown memory.
    function refilter() {
      const set = new Set(nodes.filter((n) => (n.m ? !G.hidden.has('type:' + n.m.type) : !G.hidden.has('kind:' + n.kind))));
      let root = G.local ? byId.get(G.local.id) : null;
      if (!root || !set.has(root)) { root = null; G.local = null; }
      if (root) {
        const keep = new Set([root]);
        let frontier = [root];
        for (let d = 0; d < G.local.depth; d++) {
          const next = [];
          for (const n of frontier) for (const x of n.nb) if (set.has(x) && !keep.has(x)) { keep.add(x); next.push(x); }
          frontier = next;
        }
        for (const n of [...set]) if (!keep.has(n)) set.delete(n);
      }
      for (const n of [...set]) if (!n.m && n !== root && ![...n.nb].some((x) => x.m && set.has(x))) set.delete(n);
      vn = nodes.filter((n) => set.has(n));
      vl = links.filter((l) => set.has(l.s) && set.has(l.t));
      for (const n of nodes) n.vd = 0;
      for (const l of vl) { l.s.vd++; l.t.vd++; }
      if (G.focus && !set.has(G.focus)) G.focus = null;
      if (hover && !set.has(hover)) { hover = null; showTip(null); }
      renderLegend(); renderLocal(); renderHint();
    }

    function renderHint() {
      const c = (k) => vn.filter((n) => n.kind === k).length;
      hintEl.textContent = plural(c('memory'), 'memory', 'memories') + (res.truncated ? ' (the most recent)' : '') + ', ' + plural(c('entity'), 'component', 'components')
        + (G.files ? ', ' + plural(c('file'), 'file', 'files') : '') + (G.concepts ? ', ' + plural(c('concept'), 'concept', 'concepts') : '')
        + (vn.length < nodes.length ? ' shown of ' + nodes.length + ' nodes' : '') + '. Hover for details, double-click a node for its local graph.';
    }

    function renderLegend() {
      const chip = (key, sw, label, n) => {
        const off = G.hidden.has(key);
        return h('button', { class: 'chip' + (off ? ' off' : ''), 'aria-pressed': off ? 'false' : 'true', title: (off ? 'Show ' : 'Hide ') + label,
          onclick: () => { if (off) G.hidden.delete(key); else G.hidden.add(key); refilter(); reheat(0.3); } }, sw, label, h('span', { class: 'n' }, n));
      };
      fill(legendEl,
        ...Object.keys(typeCounts).sort().map((t) => chip('type:' + t, h('span', { class: 'sw dot t-' + t }), typeLabel(t).replace(/-/g, ' '), typeCounts[t])),
        chip('kind:entity', h('span', { class: 'sw ent' }), 'components', kindCounts.entity || 0),
        G.files && kindCounts.file ? chip('kind:file', h('span', { class: 'sw file' }), 'files', kindCounts.file) : null,
        G.concepts && kindCounts.concept ? chip('kind:concept', h('span', { class: 'sw con' }), 'concepts', kindCounts.concept) : null,
        S.curated ? null : h('span', { class: 'k note' }, h('span', { class: 'sw cand' }), 'hollow = candidate'));
    }

    function renderLocal() {
      const root = G.local && byId.get(G.local.id);
      localEl.hidden = !root;
      if (!root) return;
      fill(localEl, h('span', {}, 'Local graph of'), h('b', { title: root.label }, shortLabel(root)),
        h('span', { class: 'depth', role: 'group', 'aria-label': 'Depth' }, ...[1, 2, 3].map((d) => h('button', {
          class: G.local.depth === d ? 'on' : '', 'aria-pressed': String(G.local.depth === d), title: plural(d, 'step', 'steps') + ' out', onclick: () => setLocal(root, d) }, String(d)))),
        h('button', { class: 'btn small', title: 'Back to the whole map (Esc)', onclick: () => setLocal(null) }, 'Show all'));
    }

    function renderForces() {
      const slider = (label, key, min, max, stepv) => [h('label', { for: 'gf-' + key }, label),
        h('input', { type: 'range', id: 'gf-' + key, min, max, step: stepv, value: G.forces[key], oninput: (e) => { G.forces[key] = Number(e.target.value); reheat(0.35); } })];
      fill(forcesEl, ...slider('Repel', 'repel', 30, 500, 10), ...slider('Link length', 'dist', 0.4, 2.5, 0.1), ...slider('Gravity', 'gravity', 0, 0.2, 0.01),
        h('span'), h('button', { class: 'btn small', onclick: () => { G.forces = { ...FORCES }; renderForces(); reheat(0.5); } }, 'Reset'));
    }

    function setLocal(n, depth) {
      G.local = n ? { id: n.id, depth: depth || (G.local && G.local.depth) || 2 } : null;
      if (n) G.focus = n;
      refilter();
      touched = false; fitPending = true;
      fitView(true);
      reheat(0.5);
    }

    function step() {
      if (alpha < 0.004 && !target) return;
      const F = G.forces, n = vn.length;
      for (let i = 0; i < n; i++) {
        const a = vn[i];
        for (let j = i + 1; j < n; j++) {
          const b = vn[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 > 160000) continue;
          if (d2 < 1) { dx = hash(a.id + b.id) - 0.5; dy = hash(b.id + a.id) - 0.5; d2 = 1; }
          const f = F.repel * alpha / d2;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
      }
      for (const l of vl) {
        const dx = l.t.x + l.t.vx - l.s.x - l.s.vx, dy = l.t.y + l.t.vy - l.s.y - l.s.vy, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - l.len * F.dist) / d * alpha / Math.min(l.s.vd, l.t.vd), bias = l.s.vd / (l.s.vd + l.t.vd);
        l.t.vx -= dx * f * bias; l.t.vy -= dy * f * bias; l.s.vx += dx * f * (1 - bias); l.s.vy += dy * f * (1 - bias);
      }
      for (const a of vn) {
        a.vx -= a.x * F.gravity * alpha; a.vy -= a.y * F.gravity * alpha;
        if (a.fixed) { a.vx = a.vy = 0; continue; }
        a.vx *= 0.6; a.vy *= 0.6; a.x += a.vx; a.y += a.vy;
      }
      alpha += (target - alpha) * 0.0228;
    }
    const running = () => alpha >= 0.004 || target > 0;

    // Camera: every change goes through setCam, which can ease from the current view to the new one.
    function setCam(to, animate) {
      cancelAnimationFrame(fly); fly = 0;
      showTip(null); // it would point at where the node used to be
      if (!animate || reduce || !G.T) { G.T = to; draw(); return; }
      const from = { ...G.T }, t0 = performance.now();
      const ease = (now) => {
        const p = Math.min(1, (now - t0) / 380), e = 1 - Math.pow(1 - p, 3);
        G.T = { k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
        draw();
        fly = p < 1 && canvas.isConnected ? requestAnimationFrame(ease) : 0;
      };
      fly = requestAnimationFrame(ease);
    }
    const stopFly = () => { cancelAnimationFrame(fly); fly = 0; };
    const clampK = (k) => Math.max(0.15, Math.min(6, k));
    function fitView(animate) {
      if (!W || !H || !vn.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of vn) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
      // Labels sit to the right of their nodes, so leave room for them on that side.
      const k = Math.min(2, (W - 150) / Math.max(1, x1 - x0), (H - 60) / Math.max(1, y1 - y0));
      setCam({ k, x: (W - 90) / 2 - (x0 + x1) / 2 * k, y: H / 2 - (y0 + y1) / 2 * k }, animate);
    }
    function zoomBy(f, px, py) {
      if (!G.T) return;
      const T = G.T, k = clampK(T.k * f), cx = px ?? W / 2, cy = py ?? H / 2;
      setCam({ k, x: cx - (cx - T.x) * (k / T.k), y: cy - (cy - T.y) * (k / T.k) }, true);
    }
    function centerOn(n, minK) {
      const k = Math.max(G.T.k, minK || 1.4);
      setCam({ k, x: W / 2 - n.x * k, y: H / 2 - n.y * k }, true);
    }
    function reveal(n) {
      const sx = n.x * G.T.k + G.T.x, sy = n.y * G.T.k + G.T.y;
      if (sx < 40 || sx > W - 40 || sy < 40 || sy > H - 40) centerOn(n, G.T.k);
    }

    function reheat(a) {
      alpha = Math.max(alpha, a);
      if (reduce) {
        while (running()) step();
        if (fitPending) { fitPending = false; fitView(); }
        draw();
      } else kick();
    }

    function draw() {
      if (!W || !H) return;
      const T = G.T || { k: 1, x: W / 2, y: H / 2 }, k = T.k;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * T.x, dpr * T.y);
      const focus = hover || peekNode || G.focus;
      const near = focus ? new Set([focus, ...focus.nb]) : null;
      const q = G.q.trim().toLowerCase();
      const hit = (n) => !q || n.label.toLowerCase().includes(q);
      const lit = (n) => (!near || near.has(n)) && hit(n);
      for (const l of vl) {
        const on = focus && (l.s === focus || l.t === focus);
        ctx.globalAlpha = on ? 0.9 : lit(l.s) && lit(l.t) ? 0.75 : 0.12;
        ctx.strokeStyle = on ? C.muted : C.line;
        ctx.lineWidth = (on ? 1.6 : 1) / k;
        ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      }
      for (const n of vn) {
        ctx.globalAlpha = lit(n) ? 1 : 0.15;
        ctx.beginPath();
        if (n.kind === 'file') ctx.roundRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2, n.r * 0.4);
        else ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        const cand = n.m && n.m.admission === 'candidate';
        ctx.fillStyle = n.kind === 'memory' ? (cand ? C.panel : n.color) : n.kind === 'entity' ? C.green : n.kind === 'concept' ? C.lav : C.panel;
        ctx.fill();
        ctx.lineWidth = (cand ? 2 : 1.2) / k;
        ctx.strokeStyle = n.kind === 'file' ? C.faint : n.kind === 'concept' ? '#a98bd0' : cand ? n.color : C.panel;
        ctx.stroke();
        if (n.m && n.m.changes.length) { ctx.beginPath(); ctx.arc(n.x + n.r * 0.8, n.y - n.r * 0.8, 2.4, 0, Math.PI * 2); ctx.fillStyle = C.warn; ctx.fill(); }
        if (n === G.focus || n === hover || n === peekNode) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3.5 / k, 0, Math.PI * 2); ctx.lineWidth = 2.2 / k; ctx.strokeStyle = C.coral; ctx.stroke(); }
      }
      ctx.font = '500 ' + (12 / k) + 'px ' + cv('--sans');
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const few = vn.length <= 40;
      for (const n of vn) {
        const show = (near && near.has(n)) || (q && hit(n)) || (!near && (n.kind === 'entity' || few || (n.kind === 'concept' && k > 1.1) || (n.kind === 'file' && k > 1.5) || k > 2));
        if (!show || !lit(n)) continue;
        const t = shortLabel(n), x = n.x + n.r + 4 / k;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3.5 / k; ctx.strokeStyle = C.panel; ctx.strokeText(t, x, n.y);
        ctx.fillStyle = n.kind === 'entity' || n === focus ? C.ink : C.muted; ctx.fillText(t, x, n.y);
      }
      ctx.globalAlpha = 1;
    }

    function frame() {
      raf = 0;
      if (!canvas.isConnected) return;
      step(); step();
      if (!running() && fitPending) { fitPending = false; if (!touched) fitView(true); } // the layout drifted since the first fit
      draw();
      if (running()) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && canvas.isConnected) raf = requestAnimationFrame(frame); };

    function showTip(n, px, py) {
      if (!n || drag || pinch) { tip.hidden = true; tip.node = null; return; }
      if (tip.node !== n) {
        tip.node = n;
        if (n.m) {
          fill(tip, h('div', { class: 'm' }, typeTag(n.m.type), h('span', {}, n.m.entity), h('span', {}, when(n.m.updatedAt || n.m.createdAt))),
            h('div', { class: 't' }, prettyTitle(n.m.title)),
            n.m.admission === 'candidate' || n.m.changes.length || n.m.status !== 'active'
              ? h('div', { class: 'm' }, n.m.admission === 'candidate' ? h('span', { class: 'flag' }, 'candidate') : null,
                  n.m.status !== 'active' ? h('span', { class: 'flag' }, n.m.status) : null,
                  n.m.changes.length ? h('span', { class: 'flag warn' }, 'changed since') : null)
              : null);
        } else {
          const count = [...n.nb].filter((x) => x.m).length;
          fill(tip, h('div', { class: 'm' }, KIND_NAME[n.kind]), h('div', { class: 't' + (n.kind === 'file' ? ' mono' : '') }, n.label), h('div', { class: 'm' }, plural(count, 'memory', 'memories')));
        }
      }
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(px + 14, W - tw - 8)) + 'px';
      tip.style.top = (py + 18 + th > H ? Math.max(8, py - th - 12) : py + 18) + 'px';
    }

    const live = () => canvas.isConnected;
    G.redraw = () => { if (live() && !raf) draw(); };
    G.reveal = (id) => { const n = byId.get('m:' + id); if (live() && n && vn.includes(n) && G.T) reveal(n); };
    G.peek = (id) => { if (!live()) return; const n = id ? byId.get('m:' + id) || null : null; if (n !== peekNode) { peekNode = n; G.redraw(); } };
    G.local0 = (n) => { if (live()) setLocal(byId.get(n.id) || null); };
    G.escape = () => { if (!live() || !G.local) return false; setLocal(null); return true; };
    G.find = (dir) => {
      const q = G.q.trim().toLowerCase();
      if (!live() || !q) return;
      // Exact names first, then names that start with the term, then the best-connected.
      const rank = (n) => { const l = n.label.toLowerCase(); return l === q ? 0 : l.startsWith(q) || l.endsWith('/' + q) ? 1 : 2; };
      const matches = vn.filter((n) => n.label.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b) || b.vd - a.vd);
      if (!matches.length) { toast('No node matches "' + G.q.trim() + '"'); return; }
      G.qi = (G.qi + dir + matches.length) % matches.length;
      const n = matches[G.qi];
      if (n.m) select(n.m.id); else { S.selected = null; G.focus = n; showNode(n); }
      G.focus = n;
      centerOn(n, 1.6);
      if (matches.length > 1) toast((G.qi + 1) + ' of ' + matches.length + ' matches');
    };
    G.keys = (e) => {
      if (!live()) return false;
      if (e.key === 'f') fitView(true);
      else if (e.key === '+' || e.key === '=') zoomBy(1.4);
      else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
      else if (e.key === 'l' && G.focus) setLocal(G.focus);
      else return false;
      return true;
    };

    refilter();
    renderForces();

    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (!G.T) fitView(); else draw();
    };
    const ro = new ResizeObserver(() => { if (!live()) { ro.disconnect(); return; } size(); });
    ro.observe(canvas);

    // Settle most of the layout before the first paint, so the map opens in place instead of exploding outwards.
    let warm = reduce ? 600 : fresh ? 220 : 0;
    while (warm-- > 0 && running()) step();
    size();
    if (!G.T || fresh) fitView();
    if (reduce) { alpha = 0; fitPending = false; draw(); } else kick();

    const at = (e) => { const r = canvas.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; };
    const world = (px, py) => { const T = G.T; return { x: (px - T.x) / T.k, y: (py - T.y) / T.k }; };
    const pick = (px, py) => {
      const w = world(px, py), pad = 4 / G.T.k;
      for (let i = vn.length - 1; i >= 0; i--) { const n = vn[i], dx = n.x - w.x, dy = n.y - w.y; if (dx * dx + dy * dy <= (n.r + pad) * (n.r + pad)) return n; }
      return null;
    };
    const release = () => { if (drag && drag.n) { drag.n.fixed = false; target = 0; } drag = null; canvas.classList.remove('dragging'); };
    canvas.addEventListener('pointerdown', (e) => {
      if (!G.T) return;
      const p = at(e);
      pts.set(e.pointerId, p);
      canvas.setPointerCapture(e.pointerId);
      stopFly(); touched = true; fitPending = false; showTip(null);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        release();
        pinch = { d: Math.hypot(a.px - b.px, a.py - b.py) || 1, mx: (a.px + b.px) / 2, my: (a.py + b.py) / 2, T: { ...G.T } };
        showTip(null);
        return;
      }
      drag = { n: pick(p.px, p.py), px: p.px, py: p.py, x: G.T.x, y: G.T.y, moved: false };
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!G.T) return;
      const { px, py } = at(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { px, py });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], P = pinch.T;
        const k = clampK(P.k * (Math.hypot(a.px - b.px, a.py - b.py) || 1) / pinch.d), mx = (a.px + b.px) / 2, my = (a.py + b.py) / 2;
        const wx = (pinch.mx - P.x) / P.k, wy = (pinch.my - P.y) / P.k;
        G.T = { k, x: mx - wx * k, y: my - wy * k };
        draw();
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(px - drag.px, py - drag.py) < 4) return;
        if (!drag.moved) { showTip(null); if (drag.n && !reduce) { drag.n.fixed = true; target = 0.25; if (alpha < 0.25) alpha = 0.25; kick(); } }
        drag.moved = true;
        if (drag.n) { const w = world(px, py); drag.n.x = w.x; drag.n.y = w.y; if (reduce) draw(); }
        else { G.T.x = drag.x + px - drag.px; G.T.y = drag.y + py - drag.py; draw(); }
        return;
      }
      const n = pick(px, py);
      if (n !== hover) { hover = n; canvas.classList.toggle('over', !!n); G.redraw(); }
      showTip(n, px, py);
    });
    canvas.addEventListener('pointerup', (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (!drag) return;
      const d = drag;
      release();
      if (d.moved) return;
      if (!d.n) { if (G.focus || S.selected) { G.focus = null; S.selected = null; renderDetail(); G.redraw(); } return; }
      if (d.n.m) select(d.n.m.id);
      else { S.selected = null; G.focus = d.n; G.redraw(); showNode(d.n); }
    });
    canvas.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; release(); });
    canvas.addEventListener('pointerleave', () => { if (!drag) { showTip(null); if (hover) { hover = null; canvas.classList.remove('over'); G.redraw(); } } });
    canvas.addEventListener('dblclick', (e) => {
      const { px, py } = at(e), n = pick(px, py);
      if (n) setLocal(n); else zoomBy(1.8, px, py);
    });
    canvas.addEventListener('wheel', (e) => {
      if (!G.T) return;
      e.preventDefault();
      stopFly(); touched = true; fitPending = false; showTip(null);
      const { px, py } = at(e), T = G.T, k = clampK(T.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
      T.x = px - (px - T.x) * (k / T.k); T.y = py - (py - T.y) * (k / T.k); T.k = k;
      draw();
    }, { passive: false });
  }

  const narrow = () => matchMedia('(max-width: 1150px)').matches;
  function revealDetail() { if (narrow()) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  async function select(id, fromKeys) {
    S.selected = id;
    markSelected();
    if (G.redraw) { G.focus = G.byId.get('m:' + id) || null; G.redraw(); if (G.reveal) G.reveal(id); }
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
      fill($('dactions'));
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
    const flags = [m.status !== 'active' ? h('span', { class: 'flag' }, m.status) : null, m.admission === 'candidate' ? h('span', { class: 'flag' }, 'candidate') : null,
      m.source !== 'agent' ? h('span', { class: 'flag' }, m.source === 'hook' ? 'captured by a hook' : 'from git') : null, h('span', { class: 'flag' }, m.entity)].filter(Boolean);
    const copyId = h('button', { class: 'btn small idbtn mono', title: 'Copy the id', onclick: async () => {
      try { await navigator.clipboard.writeText(String(m.id)); toast('Copied #' + m.id); } catch { toast('#' + m.id); }
    } }, '#' + m.id);
    fill(d,
      h('div', { class: 'dhead' }, h('span', { class: 'dot t-' + m.type }), h('span', { class: 'type t-' + m.type }, m.type), copyId),
      h('h2', {}, prettyTitle(m.title)),
      h('div', { class: 'chips dflags' }, ...flags),
      m.changes.length ? h('p', {}, h('span', { class: 'flag warn' }, 'Changed since stored: ' + m.changes.map((c) => c.file + ' (' + c.change + ')').join(', ')), ' ', h('span', { class: 'small' }, 'Check the current code, then mark it.')) : null,
      h('div', { class: 'md' }, narrative(m.narrative)),
      list('Facts', m.facts),
      m.files && m.files.length ? h('div', { class: 'section' }, h('h3', {}, 'Files'), h('ul', { class: 'files' }, ...m.files.map((f) => h('li', {}, f)))) : null,
      m.concepts && m.concepts.length ? h('div', { class: 'section' }, h('h3', {}, 'Concepts'), h('div', { class: 'chips' }, ...m.concepts.map((c) => h('span', { class: 'flag' }, c)))) : null,
      m.replacedBy ? h('div', { class: 'section' }, h('h3', {}, 'Replaced by'), h('button', { class: 'link', onclick: () => select(m.replacedBy.id) }, '#' + m.replacedBy.id + ' ' + m.replacedBy.title)) : null,
      m.replaces.length ? h('div', { class: 'section' }, h('h3', {}, 'Replaces'), h('ul', {}, ...m.replaces.map((r) => h('li', {}, h('button', { class: 'link', onclick: () => select(r.id) }, '#' + r.id + ' ' + r.title))))) : null,
      list('Feedback', m.feedback.map((f) => f.signal + ' · ' + when(f.createdAt) + (f.note ? ' · ' + f.note : ''))),
      h('div', { class: 'section' }, h('h3', {}, 'About'), h('dl', { class: 'kv' }, ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))));
    fill($('dactions'), ...actions);
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
      else if (S.view === 'graph') await loadGraph();
      else if (S.view === 'sessions') await loadSessions();
      else if (S.view === 'longterm') await loadLongTerm();
      renderNav();
      loadStats().catch(() => {});
    } catch (e) {
      fill($('main'), h('p', { class: 'err' }, e.message));
    }
  }

  $('help').onclick = () => toggleKeys();
  $('detail').addEventListener('mouseover', (e) => { if (S.view === 'graph' && G.peek) { const r = e.target.closest('.row'); G.peek(r ? Number(r.dataset.id) : null); } });
  $('detail').addEventListener('mouseleave', () => { if (G.peek) G.peek(null); });
  document.addEventListener('click', (e) => { if (!$('keys').hidden && !e.target.closest('#keys, #help')) toggleKeys(false); });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'checkbox';
    if (e.key === 'Escape') {
      if (!$('keys').hidden) { toggleKeys(false); return; }
      if (typing) { if (e.target.id === 'q' && e.target.value) return; e.target.blur(); return; }
      if (S.view === 'graph' && G.escape && G.escape()) return;
      if (S.selected || G.focus) { S.selected = null; G.focus = null; markSelected(); renderDetail(); if (G.redraw) G.redraw(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { toggleKeys(); return; }
    if (e.key === '/') { const q = $('q'); if (q) { e.preventDefault(); q.focus(); q.select(); } return; }
    if (S.view === 'graph' && G.keys && G.keys(e)) { e.preventDefault(); return; }
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
    $('project').onchange = (e) => { S.project = e.target.value; G.pos.clear(); G.T = null; G.local = null; go(S.view); };
    await load();
  }
  init();
})();
</script>
</body>
</html>`;
