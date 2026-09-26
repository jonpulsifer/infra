// The page, self-contained: no build step, no CDN, and nothing fetched but
// /events. Caller names come from the carrier, so the script writes every
// value with textContent and never as HTML.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Switchboard</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #16181d; --muted: #5d6573;
  --line: #dde1e7; --ok: #16794a; --warn: #9a6200; --bad: #b42318;
  --talk: #1f5fbf; --held: #7a3fb0; --toy: #0e7c86;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --ink: #e6e8ec; --muted: #9aa3b2;
    --line: #2a2f3a; --ok: #3fbf7f; --warn: #e0a43a; --bad: #f0645a;
    --talk: #6ea8ff; --held: #c08cf0; --toy: #4fc9d3;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 16px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin: 24px 0 8px; }
.status { display: flex; flex-wrap: wrap; gap: 6px; font-size: 13px; }
.pill { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
  white-space: nowrap; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
.muted { color: var(--muted); }
.lines { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.card .top { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
.card .sub { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.call { display: grid; gap: 4px; }
.call .who { font-weight: 600; overflow-wrap: anywhere; }
.call .stage { font-weight: 600; }
.stage.talking { color: var(--talk); } .stage.held { color: var(--held); }
.stage.toy, .stage.agent { color: var(--toy); } .stage.refused { color: var(--bad); }
.stage.ringing, .stage.prompt { color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: 12px; border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; color: var(--muted); }
.calls { display: grid; gap: 8px; }
.empty { color: var(--muted); font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td { padding: 6px 4px; border-top: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
td.num { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.elapsed { font-variant-numeric: tabular-nums; }
@media (max-width: 560px) { .hide-narrow { display: none; } }
</style>
</head>
<body>
<main>
<header>
  <h1>Switchboard</h1>
  <div class="status" id="status"></div>
</header>
<h2>Lines</h2>
<div class="lines" id="lines"></div>
<h2>Calls in progress</h2>
<div class="calls" id="calls"></div>
<h2>Recent calls</h2>
<table><tbody id="recent"></tbody></table>
</main>
<script>
(function () {
  var view = null;
  var offset = 0;
  var stream = 'connecting';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function since(iso) { return (Date.now() + offset - Date.parse(iso)) / 1000; }
  function party(p, fallback) {
    var name = p && p.name, number = p && p.number;
    if (name && number && name !== number) return name + ' · ' + number;
    return name || number || fallback;
  }
  function lineName(line) { return line ? line.replace(/^line/, 'line ') : 'no line'; }
  function pill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

  function renderStatus() {
    var box = document.getElementById('status');
    box.replaceChildren();
    var a = view && view.asterisk;
    if (a) {
      var ariCls = a.ari === 'connected' ? 'ok' : a.ari === 'connecting' ? 'warn' : 'bad';
      box.append(pill('ARI ' + a.ari + (a.reason ? ' (' + a.reason + ')' : ''), ariCls));
      box.append(pill('metrics ' + a.metrics, a.metrics === 'ok' ? 'ok' : a.metrics === 'failing' ? 'bad' : 'warn'));
      if (a.version) box.append(pill('Asterisk ' + a.version, 'muted'));
      if (a.uptimeSeconds !== null) box.append(pill('up ' + clock(a.uptimeSeconds), 'muted'));
    }
    if (view && view.eaten !== null) box.append(pill(view.eaten + ' eaten', 'muted'));
    box.append(pill(stream === 'live' ? 'live' : 'reconnecting', stream === 'live' ? 'ok' : 'warn'));
  }

  function renderLines() {
    var box = document.getElementById('lines');
    box.replaceChildren();
    view.lines.forEach(function (l) {
      var card = el('div', 'card');
      var top = el('div', 'top');
      top.append(el('span', '', lineName(l.line)));
      top.append(el('span', l.calls ? 'ok' : 'muted', l.calls ? 'in use' : 'idle'));
      card.append(top);
      card.append(el('div', 'sub', (l.account || l.trunk || 'no trunk') + (l.screened ? ' · screened' : '')));
      var chips = el('div', 'chips');
      var h = l.handset;
      chips.append(pill('handset ' + h + (l.handsetRttMs !== null ? ' ' + l.handsetRttMs + ' ms' : ''),
        h === 'online' ? 'ok' : h === 'offline' ? 'bad' : 'warn'));
      var r = l.registration;
      chips.append(pill('trunk ' + r, r === 'registered' ? 'ok' : r === 'unknown' ? 'warn' : 'bad'));
      card.append(chips);
      box.append(card);
    });
  }

  function renderCalls() {
    var box = document.getElementById('calls');
    box.replaceChildren();
    if (!view.calls.length) { box.append(el('div', 'empty', 'No calls.')); return; }
    view.calls.forEach(function (c) {
      var card = el('div', 'card call');
      var top = el('div', 'top');
      var who = c.direction === 'handset'
        ? '↗ ' + lineName(c.line) + (c.dialled ? ' → ' + c.dialled : '')
        : (c.direction === 'inbound' ? '↘ ' : '') + party(c.caller, 'unknown caller');
      top.append(el('span', 'who', who));
      var t = el('span', 'elapsed');
      t.dataset.since = c.startedAt;
      top.append(t);
      card.append(top);
      card.append(el('div', 'stage ' + c.stage.key, c.stage.label));
      var sub = [lineName(c.line), c.trunk, c.verdict, c.state].filter(Boolean).join(' · ');
      card.append(el('div', 'sub', sub));
      if (c.talkingSince) {
        var talk = el('div', 'sub');
        talk.append('talking ');
        var tt = el('span', 'elapsed');
        tt.dataset.since = c.talkingSince;
        talk.append(tt);
        card.append(talk);
      }
      if (c.trail.length) {
        var chips = el('div', 'chips');
        c.trail.forEach(function (k) { chips.append(el('span', 'chip', k)); });
        card.append(chips);
      }
      box.append(card);
    });
  }

  function renderRecent() {
    var body = document.getElementById('recent');
    body.replaceChildren();
    if (!view.recent.length) {
      var row = el('tr');
      var cell = el('td', 'empty', 'No calls since the board started.');
      row.append(cell);
      body.append(row);
      return;
    }
    view.recent.forEach(function (c) {
      var row = el('tr');
      var at = new Date(c.startedAt);
      row.append(el('td', 'num', at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      var who = c.direction === 'handset'
        ? '↗ ' + (c.dialled || lineName(c.line))
        : '↘ ' + party(c.caller, 'unknown');
      row.append(el('td', '', who));
      row.append(el('td', 'hide-narrow', lineName(c.line)));
      var what = c.verdict && c.lastStage.indexOf(c.verdict) === -1
        ? c.verdict + ' · ' + c.lastStage
        : c.lastStage;
      row.append(el('td', '', what));
      row.append(el('td', 'hide-narrow muted', c.causeText || ''));
      row.append(el('td', 'num', clock(c.seconds)));
      body.append(row);
    });
  }

  function tick() {
    document.querySelectorAll('.elapsed').forEach(function (node) {
      if (node.dataset.since) node.textContent = clock(since(node.dataset.since));
    });
  }

  function render() {
    renderStatus();
    if (!view) return;
    renderLines();
    renderCalls();
    renderRecent();
    tick();
  }

  function connect() {
    var source = new EventSource('/events');
    source.addEventListener('board', function (e) {
      view = JSON.parse(e.data);
      offset = Date.parse(view.now) - Date.now();
      stream = 'live';
      render();
    });
    source.addEventListener('ping', function () {
      if (stream !== 'live') { stream = 'live'; renderStatus(); }
    });
    source.onerror = function () {
      stream = 'reconnecting';
      renderStatus();
      // The browser retries on its own unless the stream failed outright.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setTimeout(connect, 3000);
      }
    };
  }

  render();
  connect();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>
`;
