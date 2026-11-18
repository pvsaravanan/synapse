/**
 * The single page `synapse ui` serves. Self-contained (no external requests); all memory text is inserted with
 * textContent, never as HTML.
 */
export const UI_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse</title>
<style>
:root {
  --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e4e2dc; --soft: #efede8;
  --accent: #2f5bd3; --accent-ink: #ffffff; --warn: #a85c00; --warn-bg: #fff4e2; --ok: #1f7a4d; --ok-bg: #e6f4ec;
  --bad: #b3261e; --bad-bg: #fdecea; --chip: #ecebe6;
  --t-decision: #6a4bc4; --t-gotcha: #b3261e; --t-fix: #1f7a4d; --t-how: #2f5bd3; --t-change: #6b6a66; --t-note: #8a6d00;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --panel: #1d1d1b; --ink: #ecebe6; --muted: #9c9a94; --line: #2e2d2a; --soft: #252522;
    --accent: #7c9cff; --accent-ink: #10131d; --warn: #f0b35a; --warn-bg: #2f2410; --ok: #6fd19e; --ok-bg: #12291d;
    --bad: #ff8a80; --bad-bg: #331614; --chip: #2a2a27;
    --t-decision: #b49bff; --t-gotcha: #ff8a80; --t-fix: #6fd19e; --t-how: #7c9cff; --t-change: #9c9a94; --t-note: #e8c75a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
.brand { font-weight: 650; letter-spacing: -0.01em; font-size: 16px; display: flex; align-items: center; gap: 8px; }
.brand i { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); display: inline-block; }
select, input[type=search], textarea, input[type=text] { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
select:focus, input:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.stat { background: var(--soft); border-radius: 999px; padding: 3px 10px; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.stat b { color: var(--ink); font-weight: 600; }
.layout { display: grid; grid-template-columns: 190px minmax(0, 1fr) minmax(0, 440px); min-height: calc(100vh - 57px); }
nav { border-right: 1px solid var(--line); padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; }
nav button { text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--muted); display: flex; justify-content: space-between; }
nav button:hover { background: var(--soft); color: var(--ink); }
nav button.on { background: var(--soft); color: var(--ink); font-weight: 600; }
nav .count { font-variant-numeric: tabular-nums; font-size: 12px; }
main { padding: 16px 20px; min-width: 0; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.toolbar input[type=search] { flex: 1 1 240px; min-width: 0; }
.hint { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
.list { display: flex; flex-direction: column; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.row { background: var(--panel); padding: 10px 12px; cursor: pointer; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: baseline; }
.row:hover { background: var(--soft); }
.row.sel { box-shadow: inset 3px 0 0 var(--accent); background: var(--soft); }
.row .title { font-weight: 550; overflow-wrap: anywhere; }
.row .meta { grid-column: 2 / 4; color: var(--muted); font-size: 12.5px; display: flex; gap: 8px; flex-wrap: wrap; }
.row .date { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.type { font-size: 11px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; color: var(--t-note); white-space: nowrap; }
.type.decision, .type.trade-off, .type.reasoning { color: var(--t-decision); }
.type.gotcha { color: var(--t-gotcha); }
.type.problem-solution { color: var(--t-fix); }
.type.how-it-works, .type.why-it-exists { color: var(--t-how); }
.type.what-changed, .type.session-request { color: var(--t-change); }
.flag { font-size: 11.5px; border-radius: 6px; padding: 0 6px; background: var(--chip); color: var(--muted); }
.flag.warn { background: var(--warn-bg); color: var(--warn); }
.flag.ok { background: var(--ok-bg); color: var(--ok); }
.flag.bad { background: var(--bad-bg); color: var(--bad); }
aside { border-left: 1px solid var(--line); background: var(--panel); padding: 18px 20px; min-width: 0; overflow-wrap: anywhere; }
aside h2 { margin: 6px 0 10px; font-size: 18px; line-height: 1.3; letter-spacing: -0.01em; }
aside .empty { color: var(--muted); margin-top: 40px; text-align: center; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; font-size: 13px; margin: 12px 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.narrative { white-space: pre-wrap; background: var(--soft); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; }
.section { margin-top: 16px; }
.section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 6px; }
.section ul { margin: 0; padding-left: 18px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }
.btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 5px 11px; cursor: pointer; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.danger { color: var(--bad); }
.btn:disabled { opacity: 0.5; cursor: default; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.card .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.card .head .title { font-weight: 600; }
.card p { margin: 6px 0; }
.small { font-size: 12.5px; color: var(--muted); }
.review { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.review input { flex: 1 1 200px; min-width: 0; }
.link { color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; background: none; border: 0; padding: 0; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
.err { color: var(--bad); }
@media (max-width: 1100px) { .layout { grid-template-columns: 170px minmax(0, 1fr); } aside { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); } }
@media (max-width: 700px) {
  .layout { grid-template-columns: 1fr; }
  nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px 12px; }
  nav button { white-space: nowrap; gap: 6px; }
  header, main, aside { padding-left: 16px; padding-right: 16px; }
  .stats { margin-left: 0; }
}
</style>
</head>
<body>
<header>
  <div class="brand"><i></i>Synapse</div>
  <select id="project" aria-label="Project"></select>
  <div class="stats" id="stats"></div>
</header>
<div class="layout">
  <nav id="nav"></nav>
  <main id="main"></main>
  <aside id="detail"><p class="empty">Select a memory to see it in full.</p></aside>
</div>
<div class="toast" id="toast"></div>
<script>
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  let token = params.get('t');
  try {
    if (token) sessionStorage.setItem('synapse-token', token);
    else token = sessionStorage.getItem('synapse-token');
  } catch {}
  if (params.get('t')) history.replaceState(null, '', location.pathname); // keep the token out of the address bar

  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };
  const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); };
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), days = (Date.now() - d) / 864e5;
    if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  };

  async function api(path, query, post) {
    const url = path + (query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)) : '');
    const res = await fetch(url, post
      ? { method: 'POST', headers: { 'x-synapse-token': token || '', 'content-type': 'application/json' }, body: JSON.stringify(post) }
      : { headers: { 'x-synapse-token': token || '' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const S = { meta: null, project: '', view: 'memories', q: '', type: '', status: 'active', source: '', ltState: 'proposed', selected: null, items: [] };
  const VIEWS = [
    ['memories', 'Memories'], ['changed', 'Changed since'], ['candidates', 'Candidates'], ['sessions', 'Sessions'], ['longterm', 'Long-term'],
  ];

  function renderNav(stats) {
    const counts = { memories: stats?.byStatus?.active, changed: stats?.stale, candidates: stats?.candidates };
    $('nav').replaceChildren(...VIEWS.map(([id, label]) => h('button', {
      class: S.view === id ? 'on' : '', onclick: () => { S.view = id; S.selected = null; renderDetail(); load(); },
    }, label, counts[id] != null ? h('span', { class: 'count' }, counts[id]) : null)));
  }

  async function loadStats() {
    const s = await api('/api/stats', { project: S.project });
    const chips = [['memories', s.total], ['active', s.byStatus.active || 0], ['candidates', s.candidates]];
    if (s.stale != null) chips.push(['changed since', s.stale]);
    $('stats').replaceChildren(...chips.map(([k, v]) => h('span', { class: 'stat' }, h('b', {}, v), ' ' + k)));
    renderNav(s);
  }

  function memoryRow(m) {
    const flags = [];
    if (m.changes.length) flags.push(h('span', { class: 'flag warn', title: m.changes.map((c) => c.file + ' ' + c.change).join(', ') }, 'changed since: ' + m.changes.map((c) => c.file).slice(0, 2).join(', ') + (m.changes.length > 2 ? ' +' + (m.changes.length - 2) : '')));
    if (m.admission === 'candidate') flags.push(h('span', { class: 'flag' }, 'candidate'));
    if (m.status !== 'active') flags.push(h('span', { class: 'flag' }, m.status));
    if (m.source !== 'agent') flags.push(h('span', { class: 'flag' }, m.source));
    return h('div', { class: 'row' + (S.selected === m.id ? ' sel' : ''), tabindex: 0, role: 'button',
      onclick: () => select(m.id), onkeydown: (e) => { if (e.key === 'Enter') select(m.id); } },
      h('span', { class: 'type ' + m.type }, m.type.replace('problem-solution', 'fix')),
      h('span', { class: 'title' }, m.title),
      h('span', { class: 'date' }, when(m.updatedAt || m.createdAt)),
      h('div', { class: 'meta' }, h('span', {}, '#' + m.id), h('span', {}, m.entity), ...flags));
  }

  function filters() {
    const sel = (value, opts, on, label) => h('select', { 'aria-label': label, onchange: (e) => { on(e.target.value); load(true); } },
      ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    let timer;
    return h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Search memories…', value: S.q, 'aria-label': 'Search',
        oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { S.q = e.target.value; load(true); }, 200); } }),
      sel(S.type, [['', 'All types'], ...S.meta.types.map((t) => [t, t])], (v) => (S.type = v), 'Type'),
      sel(S.status, [['active', 'Active'], ['resolved', 'Resolved'], ['archived', 'Archived'], ['all', 'Any status']], (v) => (S.status = v), 'Status'),
      sel(S.source, [['', 'Any source'], ['agent', 'Stored by agents'], ['hook', 'Captured by hooks'], ['git', 'From git']], (v) => (S.source = v), 'Source'));
  }

  async function loadMemories(extra, hint) {
    const main = $('main');
    if (!main.querySelector('.toolbar')) main.replaceChildren(filters(), h('p', { class: 'hint', id: 'hint' }), h('div', { id: 'results' }));
    const res = await api('/api/memories', { project: S.project, q: S.q, type: S.type, status: S.status, source: S.source, limit: 200, ...extra });
    S.items = res.items;
    $('hint').textContent = hint ? hint(res) : (res.total + ' memor' + (res.total === 1 ? 'y' : 'ies') + (res.total > res.items.length ? ', showing ' + res.items.length : '') + (S.q ? ' matching "' + S.q + '"' : ''));
    $('results').replaceChildren(res.items.length ? h('div', { class: 'list' }, ...res.items.map(memoryRow)) : h('p', { class: 'small' }, 'Nothing here.'));
  }

  async function loadSessions() {
    const sessions = await api('/api/sessions', { project: S.project });
    $('main').replaceChildren(h('p', { class: 'hint' }, sessions.length + ' recent sessions, newest first.'),
      ...sessions.map((s) => h('div', { class: 'card' },
        h('div', { class: 'head' },
          h('span', { class: 'title' }, s.agent || 'session'),
          h('span', { class: 'flag' + (s.status === 'active' ? ' ok' : '') }, s.status),
          h('span', { class: 'small' }, when(s.startedAt) + (s.endedAt ? ' → ' + when(s.endedAt) : '')),
          h('span', { class: 'small' }, s.memories + ' records')),
        s.summary ? h('p', {}, s.summary) : h('p', { class: 'small' }, 'No summary yet.'),
        s.checkpoints.length ? h('div', { class: 'small' }, s.checkpoints.length + ' checkpoint' + (s.checkpoints.length === 1 ? '' : 's') + ': ' + s.checkpoints[0].text.slice(0, 160)) : null,
        h('button', { class: 'link', onclick: () => showSession(s) }, 'Show its records'))));
  }

  async function showSession(s) {
    const { items } = await api('/api/session', { id: s.id });
    S.selected = null;
    $('detail').replaceChildren(h('span', { class: 'small' }, 'Session ' + s.id.slice(0, 8)), h('h2', {}, s.agent || 'session'),
      s.summary ? h('div', { class: 'narrative' }, s.summary) : null,
      h('div', { class: 'section' }, h('h3', {}, items.length + ' records'),
        items.length ? h('div', { class: 'list' }, ...items.map(memoryRow)) : h('p', { class: 'small' }, 'None.')));
  }

  async function loadLongTerm() {
    const items = await api('/api/longterm', { project: S.project, state: S.ltState });
    const tabs = h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'State', onchange: (e) => { S.ltState = e.target.value; load(); } },
      ...[...S.meta.ltStates, 'all'].map((v) => h('option', { value: v, selected: v === S.ltState }, v))));
    const hint = S.ltState === 'proposed'
      ? 'Proposals wait for your review. Approved items reach every brief; give a reason either way.'
      : items.length + ' ' + S.ltState + ' item' + (items.length === 1 ? '' : 's') + '.';
    $('main').replaceChildren(tabs, h('p', { class: 'hint' }, hint), ...(items.length ? items.map(ltCard) : [h('p', { class: 'small' }, 'Nothing here.')]));
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
      h('p', {}, i.body),
      i.applicability ? h('p', { class: 'small' }, 'Applies ' + i.applicability) : null,
      i.evidence.length ? h('p', { class: 'small' }, 'Evidence: ' + i.evidence.join(', ')) : null,
      i.reason ? h('p', { class: 'small' }, 'Last review: ' + i.reason) : null,
      i.state === 'proposed' || i.state === 'approved'
        ? h('div', { class: 'review' }, reason,
            i.state === 'proposed' ? h('button', { class: 'btn primary', onclick: () => review('approve') }, 'Approve') : null,
            h('button', { class: 'btn danger', onclick: () => review('archive') }, i.state === 'proposed' ? 'Reject' : 'Retire'))
        : null);
  }

  async function select(id) {
    S.selected = id;
    document.querySelectorAll('.row').forEach((r) => r.classList.toggle('sel', r.querySelector('.meta span')?.textContent === '#' + id));
    renderDetail(await api('/api/memory', { id }));
  }

  function renderDetail(m) {
    const d = $('detail');
    if (!m) { d.replaceChildren(h('p', { class: 'empty' }, 'Select a memory to see it in full.')); return; }
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
      m.topicKey ? ['Topic', m.topicKey] : null, m.sessionId ? ['Session', m.sessionId.slice(0, 8)] : null,
      m.commitHash ? ['Commit', m.commitHash.slice(0, 10)] : null, m.access ? ['Read', m.access.accessCount + ' time' + (m.access.accessCount === 1 ? '' : 's')] : null,
    ].filter(Boolean);
    const list = (title, items) => items && items.length ? h('div', { class: 'section' }, h('h3', {}, title), h('ul', {}, ...items.map((x) => h('li', {}, x)))) : null;
    d.replaceChildren(
      h('span', { class: 'type ' + m.type }, m.type), h('h2', {}, m.title),
      m.changes.length ? h('p', {}, h('span', { class: 'flag warn' }, 'Changed since stored: ' + m.changes.map((c) => c.file + ' (' + c.change + ')').join(', ')), ' ', h('span', { class: 'small' }, 'Check the current code, then mark it.')) : null,
      h('div', { class: 'narrative' }, m.narrative || '(no narrative)'),
      h('dl', { class: 'kv' }, ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      list('Facts', m.facts), list('Files', m.files), list('Concepts', m.concepts),
      m.replacedBy ? h('div', { class: 'section' }, h('h3', {}, 'Replaced by'), h('button', { class: 'link', onclick: () => select(m.replacedBy.id) }, '#' + m.replacedBy.id + ' ' + m.replacedBy.title)) : null,
      m.replaces.length ? h('div', { class: 'section' }, h('h3', {}, 'Replaces'), h('ul', {}, ...m.replaces.map((r) => h('li', {}, h('button', { class: 'link', onclick: () => select(r.id) }, '#' + r.id + ' ' + r.title))))) : null,
      list('Feedback', m.feedback.map((f) => f.signal + ' · ' + when(f.createdAt) + (f.note ? ' · ' + f.note : ''))),
      h('div', { class: 'actions' }, ...actions));
  }

  async function refresh(id) {
    await Promise.all([loadStats(), load(true)]);
    if (id) renderDetail(await api('/api/memory', { id }));
  }

  async function load(keepToolbar) {
    try {
      if (!keepToolbar && ['memories', 'changed', 'candidates'].includes(S.view)) $('main').replaceChildren();
      if (S.view === 'memories') await loadMemories({});
      else if (S.view === 'changed') {
        if (S.project !== S.meta.current) { $('main').replaceChildren(h('p', { class: 'hint' }, 'File freshness can only be checked for the project synapse ui was started in (' + S.meta.current + ').')); return; }
        await loadMemories({ changed: 1 }, (r) => r.total + ' memor' + (r.total === 1 ? 'y names' : 'ies name') + ' files edited after it was stored. Check current code, then mark each verified or outdated.');
      } else if (S.view === 'candidates') await loadMemories({ admission: 'candidate' }, (r) => r.total + ' auto-captured candidate' + (r.total === 1 ? '' : 's') + '. Keep the useful ones (qualify); they rank lower until then.');
      else if (S.view === 'sessions') await loadSessions();
      else if (S.view === 'longterm') await loadLongTerm();
      renderNav(null);
      loadStats().catch(() => {});
    } catch (e) {
      $('main').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  async function init() {
    if (!token) { $('main').replaceChildren(h('p', { class: 'err' }, 'Open the URL printed by "synapse ui" (it carries an access token).')); return; }
    try { S.meta = await api('/api/state'); } catch (e) { $('main').replaceChildren(h('p', { class: 'err' }, e.message)); return; }
    S.project = S.meta.current;
    const ids = new Set(S.meta.projects.map((p) => p.projectId));
    const options = [...(ids.has(S.meta.current) ? [] : [{ projectId: S.meta.current, count: 0 }]), ...S.meta.projects];
    $('project').replaceChildren(...options.map((p) => h('option', { value: p.projectId, selected: p.projectId === S.project }, p.projectId + ' (' + p.count + ')')));
    $('project').onchange = (e) => { S.project = e.target.value; S.selected = null; renderDetail(); load(); };
    await load();
  }
  init();
})();
</script>
</body>
</html>`;
