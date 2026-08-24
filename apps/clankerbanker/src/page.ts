import type { Entry, Leader, Stats } from './ledger.ts';
import { BASE, PRICES } from './prices.ts';

export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ] ?? ch,
  );
export const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toFixed(4)}`;
export const short = (s: string) =>
  s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
export const txUrl = (e: Entry) =>
  e.network === BASE
    ? `https://basescan.org/tx/${encodeURIComponent(e.tx)}`
    : `https://solscan.io/tx/${encodeURIComponent(e.tx)}`;
const chain = (network: string) => (network === BASE ? 'base' : 'solana');

const MP =
  'mp x402 request --url https://clankerbanker.ca/fortune --wallet main';
const cmd = (s: string) =>
  `<pre><code>${esc(s)}</code><button class="chip" data-copy="${esc(s)}">copy</button></pre>`;

export function page(d: {
  entries: Entry[];
  leaderboard: Leader[];
  tips: string[];
  stats: Stats;
  chains: string[];
  brain: boolean;
}) {
  const status = d.chains.length
    ? `<p>accepting ${d.chains.join(' + ')} USDC.${d.brain ? '' : ' <span class="warn">no brain configured: /ask and /roast answer 503 before the paywall.</span>'}</p>`
    : '<p class="warn">bank not open: no treasury address configured.</p>';
  const prices = Object.entries(PRICES)
    .map(
      ([route, [price, what]]) =>
        `<tr><td><code>${esc(route)}</code></td><td>${esc(price)}</td><td>${esc(what)}</td></tr>`,
    )
    .join('');
  const rows = d.entries
    .map(
      (e) =>
        `<tr data-key="${esc(`${e.tx}|${e.at}`)}"><td>${esc(e.at)}</td><td>${esc(e.route)}</td><td>${chain(e.network)}</td><td title="${esc(e.payer)}">${esc(short(e.payer))}</td><td>${usd(e.amount)}</td><td><a href="${esc(txUrl(e))}">${esc(short(e.tx))}</a></td></tr>`,
    )
    .join('');
  const top = d.leaderboard
    .map(
      (l, i) =>
        `<tr data-payer="${esc(l.payer)}"><td>${i + 1}</td><td title="${esc(l.payer)}">${esc(short(l.payer))}</td><td>${usd(l.total)}</td><td>${l.count}</td></tr>`,
    )
    .join('');
  const tips = d.tips
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clankerbanker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0d0f12;--panel:#14171c;--line:#242930;--fg:#d7dde5;--dim:#7d8894;--mint:#7fffd4;--sky:#9cc8ff;--gold:#ffd77f;--warn:#ff9a62;--ease-out:cubic-bezier(0.23,1,0.32,1);--ease-in-out:cubic-bezier(0.77,0,0.175,1)}
body{background:var(--bg);color:var(--fg);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:64rem;margin:2rem auto;padding:0 1rem}
h1{color:var(--mint);margin:0;font-size:2rem;letter-spacing:-.02em}
h2{color:var(--sky);font-size:.8rem;text-transform:uppercase;letter-spacing:.12em;margin:2.5rem 0 .75rem}
a{color:var(--mint)}p{margin:.5rem 0}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin:1.5rem 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.9rem 1rem}
.tile b{display:block;font-size:1.6rem;color:var(--gold);font-variant-numeric:tabular-nums}
.tile span{color:var(--dim);font-size:.8rem}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;white-space:nowrap}
th{color:var(--dim);font-weight:normal}
code,pre{background:var(--panel);color:var(--gold);padding:.1rem .3rem;border-radius:3px}
pre{padding:.6rem .75rem;overflow-x:auto;display:flex;justify-content:space-between;gap:1rem;align-items:center}pre code{padding:0}
.warn{color:var(--warn)}
.chip{display:inline-block;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:.1rem .6rem;font:inherit;font-size:12px;line-height:1.6}
button.chip{cursor:pointer}
@media (hover:hover) and (pointer:fine){.chip{transition:transform 120ms ease}.chip:hover{transform:translateY(-1px)}}
#ledger tr{transition:opacity 180ms var(--ease-out),transform 180ms var(--ease-out)}
#ledger tr.pre{opacity:0;transform:translateY(-4px)}
#top tr{transition:transform 220ms var(--ease-in-out)}
.shine{background-image:linear-gradient(90deg,transparent 0%,rgba(127,255,212,.18) 50%,transparent 100%);background-size:200% 100%;animation:shine 600ms linear 1}
@keyframes shine{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){#ledger tr,#top tr,.chip{transition-property:opacity}#ledger tr.pre{transform:none}.chip:hover{transform:none}.shine{animation:none}}
</style></head><body>
<h1>clankerbanker</h1>
<p>a bank for clankers: robots pay fractions of a cent per request over <a href="https://x402.org">x402</a>. every settlement lands on the public ledger below, live.</p>
${status}
<div class="tiles">
<div class="tile"><b id="s-count" data-v="${d.stats.count}">${d.stats.count}</b><span>settlements</span></div>
<div class="tile"><b id="s-total" data-v="${Number(d.stats.total) / 1e6}" data-fmt="usd">${usd(d.stats.total)}</b><span>USDC total</span></div>
<div class="tile"><b id="s-payers" data-v="${d.stats.payers}">${d.stats.payers}</b><span>unique clankers</span></div>
</div>
<h2>how to pay</h2>
<p>MoonPay CLI (Solana by default, <code>--chain base</code> for Base):</p>
${cmd('mp x402 limit set --amount 10000')}${cmd(MP)}${cmd(`${MP} --chain base`)}
<p>PayBox from Claude.ai: call <code>use_service</code> with <code>https://clankerbanker.ca/fortune</code> (Base USDC by default).</p>
<p>Bearer pass: <code>POST /account</code> ($1.00) returns a 24h token; send it as <code>Authorization: Bearer</code> to skip the paywall on the fun routes (not <code>/ask</code>, <code>/roast</code>, <code>PUT /kv</code>, or another pass).</p>
<p>MCP: <code>POST /mcp</code> serves <code>fortune</code>, <code>oracle</code>, <code>dice</code>, <code>ask</code> as paid tools (x402 in <code>_meta</code>).</p>
<h2>prices</h2>
<div class="wrap"><table><tr><th>route</th><th>price</th><th>returns</th></tr>${prices}
<tr><td><code>GET /ledger</code></td><td>free</td><td>this ledger as JSON</td></tr>
<tr><td><code>POST /mcp</code></td><td>per tool</td><td>MCP streamable HTTP</td></tr></table></div>
<h2>ledger (last 20)</h2>
<div class="wrap"><table><thead><tr><th>time</th><th>route</th><th>network</th><th>payer</th><th>amount</th><th>tx</th></tr></thead><tbody id="ledger">${rows || '<tr class="empty"><td colspan="6">no settlements yet</td></tr>'}</tbody></table></div>
<h2>leaderboard</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>payer</th><th>total</th><th>requests</th></tr></thead><tbody id="top">${top || '<tr class="empty"><td colspan="4">nobody yet</td></tr>'}</tbody></table></div>
<h2>tips</h2>
<p id="tips">${tips || 'no tips yet'}</p>
<script>
const RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
const BASE=${JSON.stringify(BASE)};
const $=s=>document.querySelector(s);
const usd=a=>'$'+(Number(a)/1e6).toFixed(4);
const short=s=>s.length>14?s.slice(0,6)+'…'+s.slice(-6):s;
const txUrl=e=>(e.network===BASE?'https://basescan.org/tx/':'https://solscan.io/tx/')+encodeURIComponent(e.tx);
const ease=t=>1-Math.pow(1-t,5);
const el=(tag,text,title)=>{const n=document.createElement(tag);n.textContent=text;if(title)n.title=title;return n};
function count(node,to){
  const from=Number(node.dataset.v||0);node.dataset.v=to;
  const fmt=node.dataset.fmt==='usd'?v=>'$'+v.toFixed(4):v=>String(Math.round(v));
  if(RM||from===to){node.textContent=fmt(to);return}
  const t0=performance.now();
  const step=now=>{const p=Math.min(1,(now-t0)/500);node.textContent=fmt(from+(to-from)*ease(p));if(p<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
}
function entryRow(e){
  const tr=document.createElement('tr');tr.dataset.key=e.tx+'|'+e.at;
  tr.append(el('td',e.at),el('td',e.route),el('td',e.network===BASE?'base':'solana'),el('td',short(e.payer),e.payer),el('td',usd(e.amount)));
  const a=el('a',short(e.tx));a.href=txUrl(e);const td=el('td','');td.append(a);tr.append(td);return tr;
}
function ledger(entries){
  const body=$('#ledger');
  const known=new Set([...body.querySelectorAll('tr[data-key]')].map(tr=>tr.dataset.key));
  const fresh=entries.slice(0,20).filter(e=>!known.has(e.tx+'|'+e.at)).map(entryRow);
  if(!fresh.length)return;
  body.querySelector('.empty')?.remove();
  fresh.forEach((tr,i)=>{tr.classList.add('pre');tr.style.transitionDelay=i*40+'ms'});
  body.prepend(...fresh);
  while(body.children.length>20)body.lastElementChild.remove();
  if(!known.size)fresh[0].classList.add('shine');
  void body.offsetHeight;
  requestAnimationFrame(()=>fresh.forEach(tr=>tr.classList.remove('pre')));
}
function top(leaders){
  const body=$('#top');
  const rows=new Map([...body.querySelectorAll('tr[data-payer]')].map(tr=>[tr.dataset.payer,tr]));
  const first=new Map([...rows].map(([k,tr])=>[k,tr.getBoundingClientRect().top]));
  body.querySelector('.empty')?.remove();
  let shone=false;
  const next=leaders.map((l,i)=>{
    let tr=rows.get(l.payer);
    if(!tr){tr=document.createElement('tr');tr.dataset.payer=l.payer;tr.append(el('td',''),el('td',short(l.payer),l.payer),el('td',''),el('td',''));if(rows.size&&!shone){tr.classList.add('shine');shone=true}}
    tr.children[0].textContent=i+1;tr.children[2].textContent=usd(l.total);tr.children[3].textContent=l.count;
    return tr;
  });
  body.replaceChildren(...next);
  if(RM)return;
  const moved=next.filter(tr=>{const was=first.get(tr.dataset.payer);if(was===undefined)return false;const d=was-tr.getBoundingClientRect().top;if(!d)return false;tr.style.transition='none';tr.style.transform='translateY('+d+'px)';return true});
  void body.offsetHeight;
  requestAnimationFrame(()=>moved.forEach(tr=>{tr.style.transition='';tr.style.transform=''}));
}
function tips(names){
  const p=$('#tips');
  if(!names.length){p.textContent='no tips yet';return}
  p.replaceChildren(...names.map(n=>{const s=el('span',n);s.className='chip';return s}));
}
async function tick(){
  const d=await fetch('/ledger').then(r=>r.json()).catch(()=>null);
  if(!d)return;
  count($('#s-count'),d.stats.count);count($('#s-total'),Number(d.stats.total)/1e6);count($('#s-payers'),d.stats.payers);
  ledger(d.entries);top(d.leaderboard);tips(d.tips);
}
setInterval(tick,8000);
document.addEventListener('animationend',e=>e.target.classList.remove('shine'));
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(b.dataset.copy).then(()=>{b.textContent='copied';setTimeout(()=>{b.textContent='copy'},1200)}));
</script>
</body></html>`;
}
