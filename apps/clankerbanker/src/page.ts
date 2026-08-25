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

const num = (n: number) => n.toLocaleString('en-US');
/** ISO instant → the clock time a teller would write on the slip. */
const clock = (at: string) => at.slice(11, 19) || at;

const MP =
  'mp x402 request --url https://clankerbanker.ca/fortune --wallet main';
const CMDS = ['mp x402 limit set --amount 10000', MP, `${MP} --chain base`];
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

const cmd = (s: string) =>
  `<div class="cmd"><code>${esc(s)}</code><button type="button" data-copy="${esc(s)}" aria-label="Copy command: ${esc(s)}">Copy</button></div>`;

const FRAME = `<div class="frame ink" aria-hidden="true"><span class="inner"></span><svg class="band t" data-band="h" preserveAspectRatio="none"></svg><svg class="band b" data-band="h" preserveAspectRatio="none"></svg><svg class="band l" data-band="v" preserveAspectRatio="none"></svg><svg class="band r" data-band="v" preserveAspectRatio="none"></svg><svg class="cnr tl" data-cnr="1" viewBox="0 0 60 60"></svg><svg class="cnr tr" data-cnr="1" viewBox="0 0 60 60"></svg><svg class="cnr bl" data-cnr="1" viewBox="0 0 60 60"></svg><svg class="cnr br" data-cnr="1" viewBox="0 0 60 60"></svg></div>`;
const DENS = `<span class="den tl" aria-hidden="true">402</span><span class="den tr" aria-hidden="true">402</span><span class="den bl" aria-hidden="true">402</span><span class="den br" aria-hidden="true">402</span>`;
const WATERMARK = '<span class="watermark" aria-hidden="true">402</span>';
const RULE =
  '<svg class="wrule ink" data-rule="1" preserveAspectRatio="none" aria-hidden="true"></svg>';
const SEAL = `<div class="sealwrap" aria-hidden="true"><svg class="seal" viewBox="0 0 200 200" role="presentation" focusable="false"><defs><path id="cb-sealArc" d="M100,100 m-73,0 a73,73 0 1,1 146,0 a73,73 0 1,1 -146,0"></path><path id="cb-sealArcIn" d="M100,100 m56,0 a56,56 0 1,0 -112,0 a56,56 0 1,0 112,0"></path></defs><g class="relief"><circle cx="100" cy="100" r="88" fill="none" stroke-width="2.4"></circle><circle cx="100" cy="100" r="83" fill="none" stroke-width="1"></circle><circle cx="100" cy="100" r="47" fill="none" stroke-width="1.4"></circle><text font-family="Source Serif 4, Georgia, serif" font-size="13.5" font-weight="600" letter-spacing="3.1" stroke="none"><textPath href="#cb-sealArc" startOffset="50%" text-anchor="middle">BANQUE CLANKER &#183; CHARTERED FOR MACHINES</textPath></text><text font-family="Source Serif 4, Georgia, serif" font-size="9" font-weight="600" letter-spacing="2.4" stroke="none"><textPath href="#cb-sealArcIn" startOffset="50%" text-anchor="middle">CDIC AVOIDANT</textPath></text><text x="100" y="112" text-anchor="middle" stroke="none" font-family="Source Serif 4, Georgia, serif" font-size="40" font-weight="700" letter-spacing="-1">402</text></g></svg></div>`;
const EMPTY_REG =
  '<tr class="empty"><td colspan="6">no settlements yet</td></tr>';
const EMPTY_BOARD = '<tr class="empty"><td colspan="3">nobody yet</td></tr>';
const PRICE_HEAD =
  '<thead><tr><th class="m" scope="col">Route</th><th class="m n" scope="col">Charge</th><th scope="col">For</th></tr></thead>';

/** Serial numbers run consecutively across the series, off the settlement
 * count, so every note restrikes when the ledger moves. */
const serial = (i: number, count: number) =>
  `CB ${String(count + i).padStart(8, '0')} ${ROMAN[i]}`;

const sheet = (
  i: number,
  count: number,
  cls: string,
  style: string,
  labelledby: string,
  watermark: string,
  body: string,
) => {
  const s = esc(serial(i, count));
  return `<article class="note ${cls}" style="${style}" aria-labelledby="${labelledby}"><span class="stock-grain" aria-hidden="true"></span><span class="laid-lines" aria-hidden="true"></span>${FRAME}${DENS}<span class="serial a" data-serial aria-hidden="true">${s}</span><span class="serial b" data-serial aria-hidden="true">${s}</span>${watermark}<div class="body">${body}</div></article>`;
};

const priceRow = ([route, [price, what]]: [string, [string, string]]) =>
  `<tr><td class="m"><code>${esc(route)}</code></td><td class="m n">${esc(price)}</td><td class="d">${esc(what)}</td></tr>`;

const regRow = (e: Entry) =>
  `<tr data-key="${esc(`${e.tx}|${e.at}`)}"><td title="${esc(e.at)}">${esc(clock(e.at))}</td><td>${esc(e.route)}</td><td class="net">${chain(e.network)}</td><td title="${esc(e.payer)}">${esc(short(e.payer))}</td><td class="n">${usd(e.amount)}</td><td><a href="${esc(txUrl(e))}" rel="noopener noreferrer" target="_blank">${esc(short(e.tx))}</a></td></tr>`;

const boardRow = (l: Leader) =>
  `<tr data-payer="${esc(l.payer)}"><td class="m" title="${esc(l.payer)}">${esc(short(l.payer))}</td><td class="m n">${usd(l.total)}</td><td class="m n">${num(l.count)}</td></tr>`;

/** One box per glyph of the sheet total; the client repaints only the boxes
 * whose digit changed, so the markup here must match what it builds. */
const combCells = (money: string) =>
  [...money]
    .map((ch) => {
      const cls = ch === ' ' ? ' blank' : '$,.'.includes(ch) ? ' sep' : '';
      return `<span class="cell${cls}"><span class="g">${esc(ch === ' ' ? '' : ch)}</span></span>`;
    })
    .join('');

export function page(d: {
  entries: Entry[];
  leaderboard: Leader[];
  tips: string[];
  stats: Stats;
  chains: string[];
  brain: boolean;
}) {
  const status = d.chains.length
    ? `<p><span class="status"><span class="pip" aria-hidden="true"></span>Accepting ${esc(d.chains.join(' + '))} USDC<span class="pip two" aria-hidden="true"></span></span></p>${d.brain ? '' : '<p class="fine warn">no brain configured: /ask and /roast answer 503 before the paywall.</p>'}`
    : '<p class="fine warn">bank not open: no treasury address configured.</p>';

  const routes = Object.entries(PRICES) as [string, [string, string]][];
  const half = Math.ceil(routes.length / 2);
  const scheduleA = routes.slice(0, half).map(priceRow).join('');
  const scheduleB = `${routes.slice(half).map(priceRow).join('')}<tr><td class="m"><code>GET /ledger</code></td><td class="m n">free</td><td class="d">this ledger as JSON</td></tr><tr><td class="m"><code>POST /mcp</code></td><td class="m n">per tool</td><td class="d">MCP streamable HTTP</td></tr>`;

  const rows = d.entries.map(regRow).join('');
  const top = d.leaderboard.map(boardRow).join('');
  const tips = d.tips
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('');
  const sheetTotal = d.entries
    .reduce((t, e) => t + BigInt(e.amount), 0n)
    .toString();
  const comb = combCells(usd(sheetTotal).padStart(11, ' '));
  const latest = d.entries[0];

  const n1 = `<p class="micro" aria-hidden="true">BANQUE CLANKER&middot;CHARTERED FOR MACHINES&middot;SETTLEMENT IS FINAL&middot;NO CASH VALUE&middot;DO NOT EAT&middot;CHARGES QUOTED IN USDC&middot;WE DID NOT ASK ANY OF THEM FOR PHOTO ID&middot;BANQUE CLANKER&middot;CHARTERED FOR MACHINES&middot;SETTLEMENT IS FINAL&middot;NO CASH VALUE&middot;DO NOT EAT&middot;CHARGES QUOTED IN USDC&middot;</p>
<div class="hero">${SEAL}<div class="heroText"><h1 id="cb-h1">Banque Clanker</h1><p class="domain">clankerbanker.ca</p><p class="charter">CDIC avoidant &middot; Series 402</p><p class="pitch">A bank that charges clankers. An agent asks for a route, the route answers <strong>402</strong>, the agent pays in USDC over <a href="https://x402.org">x402</a>, and the receipt is posted here. A 402 is just a 200 that wants lunch.</p>${status}</div></div>
<div class="figures"><div class="fig"><span class="v" id="s-count">${num(d.stats.count)}</span><span class="k">Settlements</span></div><div class="fig"><span class="v" id="s-total">${usd(d.stats.total)}</span><span class="k">USDC cleared</span></div><div class="fig"><span class="v" id="s-payers">${num(d.stats.payers)}</span><span class="k">Unique clankers</span></div></div>
<p class="fine">Charges are exact, quoted in USDC, and revised whenever the operator&rsquo;s power bill is.</p>`;

  const n2 = `<h2 id="cb-h2a">Schedule of charges</h2>${RULE}<p class="sub">${num(routes.length)} metered routes, plus the ledger, free.</p>
<div class="schedule"><div class="col"><div class="scroll"><table><caption>Schedule A</caption>${PRICE_HEAD}<tbody>${scheduleA}</tbody></table></div></div><div class="col"><div class="scroll"><table><caption>Schedule B</caption>${PRICE_HEAD}<tbody>${scheduleB}</tbody></table></div></div></div>`;

  const n3 = `<h2 id="cb-h2b">Instructions to the payer</h2>${RULE}<p class="sub">Set a limit, then ask. The facilitator does the rest. MoonPay CLI settles on Solana unless told otherwise.</p>
<div class="cmds">${CMDS.map(cmd).join('')}</div>
<div class="clauses"><p class="clause"><b>From Claude.ai</b>PayBox calls <code>use_service</code> with <code>https://clankerbanker.ca/fortune</code> and settles the quote for you.</p><p class="clause"><b>Bearer pass</b><code>POST /account</code> costs $1.00 and returns a 24h token. Send it as <code>Authorization: Bearer</code> to skip the paywall on the fun routes &mdash; not <code>/ask</code>, <code>/roast</code>, <code>PUT /kv</code>, or another pass.</p><p class="clause"><b>Tool surface</b><code>POST /mcp</code> serves <code>fortune</code>, <code>oracle</code>, <code>dice</code> and <code>ask</code> as paid MCP tools, quoted in <code>_meta</code>.</p></div>`;

  const n4 = `<h2 id="cb-h2c">The ledger &middot; deposit slip</h2>
<div class="slip"><div class="formrow"><span class="field"><span class="fl">Branch</span><span class="fv">clankerbanker.ca</span></span><span class="field"><span class="fl">Account</span><span class="fv">bearer &mdash; no photo ID taken</span></span><span class="field"><span class="fl">Items</span><span class="fv" data-items>${num(d.entries.length)}</span></span></div>
<div class="scroll"><table class="reg"><caption>Settlements received &mdash; most recent first</caption><thead><tr><th scope="col">Time</th><th scope="col">Route</th><th scope="col">Net</th><th scope="col">Payer</th><th class="n" scope="col">USDC</th><th scope="col">Tx</th></tr></thead><tbody data-entries>${rows || EMPTY_REG}</tbody></table></div>
<div class="slipfoot"><div class="totalbox"><span class="stack"><span class="fl">Total this sheet</span><span class="combwrap"><span class="comb" data-comb>${comb}</span><span class="comb carbon" data-carbon aria-hidden="true">${comb}</span></span></span></div><div class="stampslot" aria-hidden="true"><div class="stamp${latest ? ' landed' : ''}" data-stamp><span class="big" data-ghost="Received">Received</span><span class="small" data-stamp-at>${esc(latest ? clock(latest.at) : '')}</span></div></div></div></div>`;

  const n5 = `<h2 id="cb-h2d">Standings</h2>${RULE}<p class="sub">Top payers by lifetime total.</p>
<div class="scroll"><table class="board"><thead><tr><th class="m" scope="col">Payer</th><th class="m n" scope="col">Lifetime USDC</th><th class="m n" scope="col">Calls</th></tr></thead><tbody data-board>${top || EMPTY_BOARD}</tbody></table></div>
<h2 class="wallhead">The wall</h2><p class="sub">Half a cent buys a name on the wall. The wall is not load-bearing.</p>
<p class="tips" data-tips>${tips || 'no tips yet'}</p>
<div class="colophon"><p class="issued">Issued at par &middot; Banque Clanker</p><p>Not insured by any corporation, crown or otherwise. No cash value. Do not eat.</p></div>
<p class="micro" aria-hidden="true">SETTLEMENT IS FINAL&middot;NO RECOURSE&middot;NO DIVIDEND&middot;NO VOTE&middot;CDIC AVOIDANT&middot;BANQUE CLANKER&middot;CLANKERBANKER.CA&middot;SETTLEMENT IS FINAL&middot;NO RECOURSE&middot;NO DIVIDEND&middot;NO VOTE&middot;CDIC AVOIDANT&middot;BANQUE CLANKER&middot;CLANKERBANKER.CA&middot;SETTLEMENT IS FINAL&middot;NO RECOURSE&middot;</p>`;

  const c = d.stats.count;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Banque Clanker &middot; clankerbanker.ca</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Courier+Prime:wght@400;700&family=IBM+Plex+Mono:wght@500;600&family=Playfair+Display:wght@700;900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap">
<style>
html,body{margin:0;padding:0}
html{background:var(--desk)}
:root{
  --stock:#f3f0e6;
  --tint:#eae5d5;
  --desk:#e0dbc7;
  --text:#17201a;
  --ink:#0d3a27;
  --sec:#35503f;
  --red:#8c221c;
  --rule:#a9a493;
  --eo:cubic-bezier(.23,1,.32,1);
  --ei:cubic-bezier(.77,0,.175,1);
  --serif:"Source Serif 4",Georgia,"Times New Roman",serif;
  --mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
  --type:"Courier Prime","Courier New",ui-monospace,monospace;
  --grot:"Archivo",ui-sans-serif,"Helvetica Neue",Helvetica,Arial,sans-serif;
  --grot-stretch:82%;
  --inset:11px;
  --band:22px;
  --rx:1px;
  --ry:1px;
}
body{
  position:relative;
  overflow-x:hidden;
  min-height:100vh;
  box-sizing:border-box;
  padding:clamp(22px,4.6vw,60px) clamp(12px,3vw,34px) clamp(34px,6vw,74px);
  background:radial-gradient(120% 78% at 50% 0%,#e7e2d1 0%,var(--desk) 58%,#d2ccb8 100%);
  color:var(--text);
  font-family:var(--serif);
  font-size:17px;
  line-height:1.62;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
*{box-sizing:border-box}

/* ---------- desk grain ---------- */
.desk-grain{
  position:absolute;inset:0;pointer-events:none;z-index:0;opacity:.05;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* ---------- the series ---------- */
.series{
  position:relative;z-index:1;
  display:flex;flex-direction:column;align-items:center;
  gap:clamp(26px,4.6vw,58px);
}

/* ---------- one note ---------- */
.note{
  position:relative;
  width:min(1060px,100%);
  min-height:clamp(330px,calc(47vw * var(--hm,1)),calc(520px * var(--hm,1)));
  display:flex;flex-direction:column;justify-content:center;
  /* block padding must clear the corner stack (denomination + serial), which is
     absolutely positioned and would otherwise sit on top of the content */
  padding:calc(var(--inset) + var(--band) + 64px)
          max(calc(var(--inset) + var(--band) + 12px),clamp(20px,4.4vw,58px));
  background:var(--stock);
  box-shadow:
    0 1px 0 rgba(23,32,26,.10),
    0 2px 6px -3px rgba(23,32,26,.30),
    0 20px 40px -22px rgba(23,32,26,.55);
  opacity:0;
  transform:rotate(var(--tilt,0deg)) translate(var(--shift,0px),14px) scale(.988);
  transition:opacity 300ms var(--eo),transform 300ms var(--eo);
}
.note.laid{
  opacity:1;
  transform:rotate(var(--tilt,0deg)) translate(var(--shift,0px),0) scale(1);
}
.note .stock-grain{
  position:absolute;inset:0;pointer-events:none;opacity:.028;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='m'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23m)'/%3E%3C/svg%3E");
}
.note .laid-lines{
  position:absolute;inset:0;pointer-events:none;opacity:.010;
  background-image:repeating-linear-gradient(90deg,rgba(13,58,39,1) 0 1px,transparent 1px 7px);
}

/* ---------- guilloche frame ---------- */
.frame{position:absolute;inset:var(--inset);pointer-events:none;border:1px solid var(--rule)}
.frame .inner{position:absolute;inset:var(--band);border:1px solid var(--rule);opacity:.72;display:block}
.frame .band{position:absolute;display:block}
.frame .band.t{top:0;left:0;right:0;height:var(--band)}
.frame .band.b{bottom:0;left:0;right:0;height:var(--band)}
.frame .band.l{left:0;top:0;bottom:0;width:var(--band)}
.frame .band.r{right:0;top:0;bottom:0;width:var(--band)}
.frame .cnr{position:absolute;width:calc(var(--band) + 9px);height:calc(var(--band) + 9px);background:var(--stock)}
.frame .cnr.tl{top:-4px;left:-4px}
.frame .cnr.tr{top:-4px;right:-4px}
.frame .cnr.bl{bottom:-4px;left:-4px}
.frame .cnr.br{bottom:-4px;right:-4px}

/* ---------- inked line work ---------- */
.ink path,.ink circle{
  fill:none;stroke:var(--ink);vector-effect:non-scaling-stroke;stroke-linecap:round;
  stroke-dasharray:1;stroke-dashoffset:1;
}
.note.inked .ink path,.note.inked .ink circle{animation:cb-ink 1400ms var(--eo) forwards}
@keyframes cb-ink{to{stroke-dashoffset:0}}

/* ---------- corner denominations + serials ---------- */
.den{
  position:absolute;
  font-family:var(--mono);
  font-weight:600;font-size:14px;line-height:1;letter-spacing:.02em;
  font-variant-numeric:tabular-nums;color:var(--ink);
  padding:5px 8px;background:var(--stock);
}
.den.tl{top:calc(var(--inset) + var(--band) + 5px);left:calc(var(--inset) + var(--band) + 5px)}
.den.tr{top:calc(var(--inset) + var(--band) + 5px);right:calc(var(--inset) + var(--band) + 5px)}
.den.bl{bottom:calc(var(--inset) + var(--band) + 5px);left:calc(var(--inset) + var(--band) + 5px)}
.den.br{bottom:calc(var(--inset) + var(--band) + 5px);right:calc(var(--inset) + var(--band) + 5px)}
.serial{
  position:absolute;
  font-family:var(--mono);
  font-weight:600;font-size:13px;letter-spacing:.18em;line-height:1;
  font-variant-numeric:tabular-nums;color:var(--ink);
  background:var(--stock);padding:4px 6px;
  transform-origin:center;
}
.serial.a{top:calc(var(--inset) + var(--band) + 32px);right:calc(var(--inset) + var(--band) + 5px)}
.serial.b{bottom:calc(var(--inset) + var(--band) + 32px);left:calc(var(--inset) + var(--band) + 5px)}
.strike{animation:cb-strike 150ms var(--eo)}
@keyframes cb-strike{from{transform:scale(.965)}to{transform:scale(1)}}

/* ---------- watermark ---------- */
.watermark{
  position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  font-family:"Playfair Display",Georgia,serif;font-weight:900;
  font-size:clamp(150px,26vw,290px);line-height:.8;letter-spacing:-.03em;
  color:var(--tint);pointer-events:none;user-select:none;z-index:0;
}
.body{position:relative;z-index:1;width:100%}

/* ---------- microprint (decorative, aria-hidden) ---------- */
.micro{
  margin:0;font-family:var(--mono);
  font-size:6px;line-height:1.4;letter-spacing:.06em;color:var(--sec);
  white-space:nowrap;overflow:hidden;text-align:center;opacity:.85;user-select:none;
  padding:0 clamp(0px,6vw,80px);
}

/* ---------- NOTE I — the hero ---------- */
.hero{
  display:grid;
  grid-template-columns:auto minmax(0,1fr);
  align-items:center;
  gap:clamp(18px,3.4vw,40px);
}
.sealwrap{
  width:clamp(116px,15vw,156px);height:clamp(116px,15vw,156px);
  display:grid;place-items:center;justify-self:center;
}
.seal{
  width:100%;height:100%;overflow:visible;
  filter:
    drop-shadow(calc(var(--rx) * 1) calc(var(--ry) * 1) 0 rgba(255,255,255,.95))
    drop-shadow(calc(var(--rx) * -1) calc(var(--ry) * -1) .5px rgba(23,32,26,.34))
    drop-shadow(calc(var(--rx) * -2) calc(var(--ry) * -2) 3px rgba(23,32,26,.13));
  transition:filter 220ms ease;
  animation:cb-emboss 1100ms var(--eo) 340ms both;
}
.seal .relief{fill:var(--stock);stroke:var(--stock)}
@keyframes cb-emboss{from{opacity:0}to{opacity:1}}

.heroText{text-align:center;min-width:0}
h1{
  margin:0;
  font-family:"Playfair Display",Georgia,serif;font-weight:900;
  font-size:clamp(48px,6.6vw,74px);line-height:1.0;letter-spacing:-.014em;
  color:var(--ink);text-wrap:balance;
  text-shadow:0 1px 0 rgba(255,255,255,.62),0 -1px 0 rgba(13,58,39,.15);
}
.domain{
  margin:9px 0 0;font-family:var(--mono);
  font-weight:600;font-size:14px;letter-spacing:.16em;color:var(--ink);
}
.charter{
  margin:10px 0 0;
  font-weight:700;font-size:12px;letter-spacing:.17em;text-transform:uppercase;
  color:var(--ink);text-wrap:balance;
}
.pitch{
  max-width:62ch;margin:14px auto 0;
  font-size:17px;font-weight:400;color:var(--text);text-wrap:pretty;
}
.status{
  display:inline-flex;align-items:center;gap:10px;
  margin:14px auto 0;padding:7px 15px;
  border:1px solid var(--ink);background:var(--stock);
  font-weight:700;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink);
}
.status .pip{width:7px;height:7px;border-radius:50%;background:var(--ink);flex:none}
.status .pip.two{opacity:.55}

.figures{
  display:grid;grid-template-columns:repeat(3,1fr);
  margin-top:clamp(16px,2.6vw,26px);
  border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);
}
.fig{padding:14px 8px;text-align:center;border-left:1px solid var(--rule)}
.fig:first-child{border-left:0}
.fig .v{
  display:block;font-family:var(--mono);
  font-weight:600;font-size:clamp(26px,4.6vw,38px);line-height:1.06;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--ink);
  transform-origin:center;
}
.fig .k{
  display:block;margin-top:7px;
  font-weight:700;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--sec);
}
.fine{
  margin:12px auto 0;max-width:64ch;text-align:center;
  font-size:14.5px;color:var(--sec);text-wrap:pretty;
}

/* ---------- shared note furniture ---------- */
h2{
  margin:0;text-align:center;
  font-weight:700;font-size:13px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--ink);text-wrap:balance;
}
.wrule{display:block;width:100%;height:14px;margin:9px auto;opacity:.7}
.sub{
  margin:0 auto 16px;max-width:64ch;text-align:center;
  font-size:14.5px;font-weight:400;color:var(--sec);text-wrap:pretty;
}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
caption{
  caption-side:top;padding-bottom:9px;text-align:left;
  font-weight:700;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--sec);
}
th{
  padding:6px 9px;text-align:left;white-space:nowrap;
  border-bottom:1.5px solid var(--ink);
  font-family:var(--serif);
  font-weight:700;font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink);
}
td{
  padding:5px 9px;border-bottom:1px solid var(--rule);
  font-size:13.5px;font-weight:500;color:var(--text);vertical-align:baseline;
}
td.m,th.m{font-family:var(--mono)}
td.n,th.n{text-align:right}
td.d{font-family:var(--serif);font-size:14px;font-weight:500;color:var(--sec)}
tbody tr:nth-child(even){background:var(--tint)}
a{color:var(--ink);text-decoration-thickness:1px;text-underline-offset:2px}
a:focus-visible,button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

/* ---------- NOTE II — schedule ---------- */
.schedule{display:grid;grid-template-columns:1fr 1fr;gap:0 clamp(20px,3.4vw,44px)}
.schedule .col{min-width:0}

/* ---------- NOTE III — instructions ---------- */
.cmds{max-width:78ch;margin:0 auto;display:grid;gap:9px}
.cmd{display:flex;align-items:stretch;border:1px solid var(--ink);background:var(--stock)}
.cmd code{
  flex:1 1 auto;min-width:0;padding:9px 12px;
  font-family:var(--mono);font-size:13.5px;font-weight:500;line-height:1.5;
  color:var(--text);overflow-wrap:anywhere;text-align:left;
}
.cmd button{
  flex:none;border:0;border-left:1px solid var(--ink);
  background:var(--tint);color:var(--ink);cursor:pointer;padding:0 15px;min-width:90px;
  font-family:var(--serif);
  font-weight:700;font-size:12px;letter-spacing:.13em;text-transform:uppercase;
  transition:background-color 140ms ease,color 140ms ease,transform 110ms var(--eo);
}
.cmd button:active{transform:scale(.965)}
.cmd button[data-done="1"]{background:var(--ink);color:var(--stock)}
.clauses{
  max-width:82ch;margin:16px auto 0;
  display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(14px,2.6vw,30px);
}
.clause{margin:0;font-size:17px;color:var(--text);text-wrap:pretty;text-align:center}
.clause b{
  display:block;margin-bottom:3px;
  font-weight:700;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink);
}
.clause code{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--ink)}

/* ---------- NOTE IV — the deposit slip ---------- */
.n4{--lh:24px}
.slip{position:relative}
.slip .formrow{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:0 clamp(14px,2.8vw,32px);
  margin:0 0 10px;
}
.slip .field{display:flex;align-items:baseline;gap:8px;flex:1 1 auto;min-width:150px}
.fl{
  font-family:var(--grot);font-stretch:var(--grot-stretch);
  font-weight:700;font-size:11px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--sec);white-space:nowrap;flex:none;
}
.fv{
  font-family:var(--type);font-weight:700;font-size:14px;line-height:var(--lh);
  color:var(--text);flex:1 1 auto;min-width:0;
  border-bottom:1px solid var(--rule);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.reg{min-width:700px}
.reg caption{
  font-family:var(--grot);font-stretch:var(--grot-stretch);font-weight:700;font-size:11px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--sec);padding-bottom:5px;
}
.reg th{
  font-family:var(--grot);font-stretch:var(--grot-stretch);
  font-weight:700;font-size:11px;letter-spacing:.13em;text-transform:uppercase;
  color:var(--sec);border-bottom:1.5px solid var(--ink);padding:0 9px 5px 0;
}
.reg td{
  font-family:var(--type);font-weight:700;font-size:13.5px;
  height:var(--lh);line-height:var(--lh);padding:0 9px 0 0;
  border-bottom:1px solid var(--rule);
  color:var(--text);white-space:nowrap;
}
.reg tbody tr:nth-child(even){background:none}
.reg td.net{
  font-family:var(--grot);font-stretch:var(--grot-stretch);font-weight:700;font-size:13px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--sec);
}
.reg tbody tr{
  position:relative;
  transition:opacity 240ms var(--eo),transform 240ms var(--eo);
}
.reg tbody tr::after{
  content:"";position:absolute;left:0;top:0;bottom:0;width:100%;
  background:linear-gradient(90deg,transparent 0 calc(100% - 3px),var(--ink) calc(100% - 3px));
  opacity:0;transform:translateX(0);pointer-events:none;
  transition:opacity 360ms linear,transform 360ms linear;
}
.reg tbody tr.enter{opacity:0;transform:translateY(-9px)}
.reg tbody tr.enter::after{opacity:.5;transform:translateX(-100%);transition:none}

.slipfoot{
  display:flex;align-items:flex-end;justify-content:space-between;
  gap:clamp(14px,3vw,34px);margin-top:12px;
}
.totalbox{display:flex;align-items:flex-end;gap:10px;min-width:0}
.totalbox .stack{display:grid;gap:3px}
.combwrap{position:relative;isolation:isolate;flex:0 0 auto}
.comb{display:flex;justify-content:flex-end}
.comb .cell{
  width:clamp(17px,3.4vw,22px);height:30px;
  border:1px solid var(--rule);border-left:0;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--type);font-weight:700;font-size:clamp(15px,3.2vw,18px);line-height:1;
  color:var(--text);font-variant-numeric:tabular-nums;
  background:rgba(255,255,255,.45);
}
.comb .cell:first-child{border-left:1px solid var(--rule)}
.comb .cell.sep{width:clamp(11px,2.2vw,14px);background:rgba(169,164,147,.18)}
.comb .cell.blank{background:rgba(169,164,147,.11)}
.comb .cell .g{display:block;transition:opacity 150ms var(--eo),transform 150ms var(--eo)}
.comb .cell.typing .g{opacity:0;transform:translateY(-5px) scale(.94);transition:none}
.comb.carbon{
  position:absolute;inset:0;z-index:-1;
  opacity:.30;filter:blur(.9px);
  transform:translate(3px,3.5px) rotate(-.4deg);
  pointer-events:none;
}
.comb.carbon .cell{border-color:transparent;background:none;color:var(--ink)}

.stampslot{position:relative;flex:0 0 auto;min-height:64px;min-width:150px}
.stamp{
  position:absolute;right:0;bottom:0;
  color:var(--red);text-align:center;padding:7px 12px 6px;
  border:3px double var(--red);
  transform:rotate(-7.4deg);
  mix-blend-mode:multiply;opacity:0;pointer-events:none;
  -webkit-mask:radial-gradient(115% 130% at 26% 32%,#000 52%,rgba(0,0,0,.88) 72%,#000 88%);
  mask:radial-gradient(115% 130% at 26% 32%,#000 52%,rgba(0,0,0,.88) 72%,#000 88%);
}
.stamp.landed{animation:cb-thunk 520ms var(--eo) both}
.stamp .big{
  display:block;position:relative;
  font-family:var(--grot);font-stretch:var(--grot-stretch);font-weight:800;font-size:clamp(19px,4.4vw,25px);line-height:1;
  letter-spacing:.09em;text-transform:uppercase;
}
.stamp .big::before{
  content:attr(data-ghost);position:absolute;left:0;top:0;
  color:var(--red);opacity:.4;transform:translate(2px,1.5px);
}
.stamp .small{
  display:block;margin-top:3px;
  font-family:var(--grot);font-stretch:var(--grot-stretch);font-weight:700;font-size:11px;line-height:1.2;
  letter-spacing:.1em;text-transform:uppercase;
}
@keyframes cb-thunk{
  0%{opacity:0;transform:rotate(-13deg) scale(1.22)}
  62%{opacity:.95;transform:rotate(-6.2deg) scale(.975)}
  100%{opacity:1;transform:rotate(-7.4deg) scale(1)}
}
@keyframes cb-thunk-flat{from{opacity:0}to{opacity:1}}

/* ---------- NOTE V — standings and the wall ---------- */
.board tbody tr{will-change:transform}
.wallhead{margin-top:clamp(14px,2.4vw,24px)}
.tips{
  display:flex;flex-wrap:wrap;gap:8px;justify-content:center;
  max-width:74ch;margin:0 auto;padding:0;list-style:none;
}
.tips .chip{
  padding:5px 11px;border:1px solid var(--ink);background:var(--stock);
  font-family:var(--mono);font-size:13.5px;font-weight:500;color:var(--text);
  transition:opacity 240ms var(--eo),transform 240ms var(--eo),background-color 160ms ease;
}
.tips .chip.fresh{opacity:0;transform:scale(.95)}
.colophon{
  margin:clamp(14px,2.4vw,22px) auto 0;max-width:66ch;text-align:center;
  border-top:1px solid var(--rule);padding-top:11px;
}
.colophon .issued{
  margin:0 0 6px;
  font-weight:700;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink);
}
.colophon p{margin:0 0 5px;font-size:14.5px;color:var(--sec);text-wrap:pretty}

/* ---------- hover ---------- */
@media (hover:hover) and (pointer:fine){
  .cmd button:hover{background:var(--ink);color:var(--stock)}
  .tips .chip:hover{background:var(--tint)}
  .reg tbody tr:hover{background:var(--tint)}
}

/* ---------- narrow ---------- */
@media (max-width:820px){
  .hero{grid-template-columns:1fr;justify-items:center}
  .clauses{grid-template-columns:1fr;max-width:60ch;gap:14px}
  .schedule{grid-template-columns:1fr;gap:18px}
}
@media (max-width:640px){
  :root{--inset:7px;--band:15px}
  body{font-size:16.5px}
  .note{padding-left:max(calc(var(--inset) + var(--band) + 10px),22px);padding-right:max(calc(var(--inset) + var(--band) + 10px),22px)}
  .den{font-size:13px;padding:3px 5px}
  .serial{font-size:13px;letter-spacing:.06em;padding:3px 4px}
  .serial.a{top:calc(var(--inset) + var(--band) + 29px)}
  .serial.b{bottom:calc(var(--inset) + var(--band) + 29px)}
  .figures{grid-template-columns:1fr}
  .fig{border-left:0;border-top:1px solid var(--rule)}
  .fig:first-child{border-top:0}
  .cmd{flex-direction:column}
  .cmd button{border-left:0;border-top:1px solid var(--ink);padding:10px 15px;min-height:40px}
  .slipfoot{flex-direction:column;align-items:stretch;gap:16px}
  .stampslot{min-height:74px}
  .stamp{right:auto;left:0}
  .comb{justify-content:flex-start}
}

/* ---------- live-page additions ---------- */
.warn{color:var(--red)}
.empty td{font-family:var(--serif);font-weight:400;color:var(--sec);text-align:center;white-space:normal}
.shine{animation:cb-shine 700ms linear 1}
@keyframes cb-shine{from{background-color:var(--tint)}to{background-color:transparent}}

/* ---------- reduced motion ---------- */
@media (prefers-reduced-motion:reduce){
  .note{transform:none;transition:opacity 260ms linear}
  .note.laid{transform:none}
  .ink path,.ink circle{stroke-dashoffset:0}
  .note.inked .ink path,.note.inked .ink circle{animation:none;stroke-dashoffset:0}
  .seal{animation:cb-emboss 420ms var(--eo) both;transition:none}
  .strike{animation:none}
  .stamp.landed{animation:cb-thunk-flat 300ms linear both;transform:rotate(-7.4deg)}
  .reg tbody tr{transition:opacity 240ms linear}
  .reg tbody tr.enter{transform:none}
  .reg tbody tr::after{display:none}
  .comb .cell .g{transition:opacity 150ms linear}
  .comb .cell.typing .g{transform:none}
  .tips .chip{transition:opacity 240ms linear}
  .tips .chip.fresh{transform:none}
  .cmd button{transition:background-color 140ms ease,color 140ms ease}
  .cmd button:active{transform:none}
  .shine{animation:none}
}
</style></head><body>
<div class="desk-grain" aria-hidden="true"></div>
<main class="series">
${sheet(0, c, 'n1', '--tilt:-.26deg;--shift:-6px;--hm:1', 'cb-h1', '', n1)}
${sheet(1, c, 'n2', '--tilt:.3deg;--shift:7px;--hm:1', 'cb-h2a', WATERMARK, n2)}
${sheet(2, c, 'n3', '--tilt:-.19deg;--shift:-4px;--hm:1', 'cb-h2b', WATERMARK, n3)}
${sheet(3, c, 'n4', '--tilt:.24deg;--shift:6px;--hm:1.06', 'cb-h2c', '', n4)}
${sheet(4, c, 'n5', '--tilt:-.3deg;--shift:-7px;--hm:1.04', 'cb-h2d', WATERMARK, n5)}
</main>
<script>
(function(){
const NS='http://www.w3.org/2000/svg';
const BASE=${JSON.stringify(BASE)};
const calm=matchMedia('(prefers-reduced-motion: reduce)');
const fine=matchMedia('(hover: hover) and (pointer: fine)');
const q=s=>document.querySelector(s);
const qa=s=>[...document.querySelectorAll(s)];

/* ---------- guilloche generators ---------- */
const gcd=(a,b)=>b?gcd(b,a%b):a;
function rosette(R,r,d,radius,cx,cy){
  const turns=r/gcd(R,r);
  const steps=Math.max(200,Math.round(turns*130*Math.min(1,radius/100)));
  const k=R-r,span=Math.abs(k)+d,s=radius/span;
  let out='';
  for(let i=0;i<=steps;i++){
    const t=(i/steps)*Math.PI*2*turns;
    const x=cx+s*(k*Math.cos(t)+d*Math.cos((k/r)*t));
    const y=cy+s*(k*Math.sin(t)-d*Math.sin((k/r)*t));
    out+=(i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2);
  }
  return out+'Z';
}
function interference(len,thick,n,c1,c2,vert){
  const amp=thick*0.30,mid=thick/2;
  const steps=Math.max(120,Math.min(190,Math.round(len/7)));
  const out=[];
  for(let i=0;i<n;i++){
    const ph=(i/n)*Math.PI*2;
    let d='';
    for(let s=0;s<=steps;s++){
      const p=(s/steps)*len;
      const u=(s/steps)*Math.PI*2;
      const off=mid+amp*Math.sin(u*c1+ph)+amp*0.52*Math.sin(u*c2-ph*1.7);
      const a=p.toFixed(1),b=off.toFixed(1);
      d+=(s?'L':'M')+(vert?b+' '+a:a+' '+b);
    }
    out.push(d);
  }
  return out;
}
function path(d,w,op,delay){
  const p=document.createElementNS(NS,'path');
  p.setAttribute('d',d);
  p.setAttribute('pathLength','1');
  p.setAttribute('stroke-width',w);
  p.setAttribute('opacity',op);
  p.style.animationDelay=delay+'ms';
  return p;
}

const notes=qa('.note');
notes.forEach(note=>{
  note.querySelectorAll('.band').forEach((svg,idx)=>{
    const vert=svg.getAttribute('data-band')==='v';
    const len=vert?900:1400,thick=40;
    svg.setAttribute('viewBox',vert?'0 0 '+thick+' '+len:'0 0 '+len+' '+thick);
    interference(len,thick,4,26,17,vert).forEach((d,i)=>svg.appendChild(path(d,0.55,0.5,130+idx*80+i*45)));
    interference(len,thick,1,7,11,vert).forEach(d=>svg.appendChild(path(d,0.7,0.7,100+idx*80)));
  });
  note.querySelectorAll('.cnr').forEach((svg,i)=>{
    svg.appendChild(path(rosette(9,4,7,26,30,30),0.6,0.75,300+i*60));
    svg.appendChild(path(rosette(7,3,5,17,30,30),0.6,0.6,360+i*60));
  });
  note.querySelectorAll('.wrule').forEach((svg,i)=>{
    const len=1200,thick=22;
    svg.setAttribute('viewBox','0 0 '+len+' '+thick);
    interference(len,thick,4,34,21,false).forEach((d,j)=>svg.appendChild(path(d,0.6,0.55,440+i*70+j*50)));
    const mid=path('M0 '+(thick/2)+'L'+len+' '+(thick/2),0.8,0.35,420+i*70);
    svg.appendChild(mid);
  });
});

/* ---------- sheets laid down + plates inking up ---------- */
if(typeof window.IntersectionObserver==='function'){
  const io=new IntersectionObserver(items=>{
    items.forEach(it=>{
      if(!it.isIntersecting)return;
      it.target.classList.add('laid','inked');
      io.unobserve(it.target);
    });
  },{threshold:0.05,rootMargin:'0px 0px -6% 0px'});
  notes.forEach(n=>io.observe(n));
}else{
  notes.forEach(n=>n.classList.add('laid','inked'));
}

/* ---------- raking light across the blind seal ---------- */
(function(){
  const seal=q('.seal');
  if(!seal||!fine.matches||calm.matches)return;
  let pending=0;
  document.addEventListener('pointermove',ev=>{
    if(pending)return;
    pending=requestAnimationFrame(()=>{
      pending=0;
      const r=seal.getBoundingClientRect();
      const dx=(ev.clientX-(r.left+r.width/2))/Math.max(r.width,1);
      const dy=(ev.clientY-(r.top+r.height/2))/Math.max(r.height,1);
      const clamp=v=>Math.max(-1.7,Math.min(1.7,v*2.4));
      seal.style.setProperty('--rx',(-clamp(dx)).toFixed(2)+'px');
      seal.style.setProperty('--ry',(-clamp(dy)).toFixed(2)+'px');
    });
  },{passive:true});
})();

/* ---------- formatting ---------- */
const ROMAN=['I','II','III','IV','V'];
const int=n=>Number(n).toLocaleString('en-US');
const usd=a=>'$'+(Number(a)/1e6).toFixed(4);
const short=s=>s.length>14?s.slice(0,6)+'…'+s.slice(-6):s;
const clock=s=>s.slice(11,19)||s;
const netOf=e=>e.network===BASE?'base':'solana';
const txHref=e=>(e.network===BASE?'https://basescan.org/tx/':'https://solscan.io/tx/')+encodeURIComponent(e.tx);
const key=e=>e.tx+'|'+e.at;
function cell(tr,text,cls){
  const td=document.createElement('td');
  if(cls)td.className=cls;
  td.textContent=text;
  tr.appendChild(td);
  return td;
}
function restrike(node){
  if(calm.matches)return;
  node.classList.remove('strike');
  void node.offsetWidth;
  node.classList.add('strike');
}
function setText(node,txt){
  if(!node||node.textContent===txt)return;
  node.textContent=txt;
  restrike(node);
}

/* ---------- serials + figures ---------- */
const serials=notes.map((n,i)=>({i:i,els:[...n.querySelectorAll('[data-serial]')]}));
const figs={count:q('#s-count'),total:q('#s-total'),payers:q('#s-payers')};
function paintStats(stats){
  serials.forEach(set=>{
    const txt='CB '+String(stats.count+set.i).padStart(8,'0')+' '+ROMAN[set.i];
    set.els.forEach(el=>setText(el,txt));
  });
  setText(figs.count,int(stats.count));
  setText(figs.total,usd(stats.total));
  setText(figs.payers,int(stats.payers));
}

/* ---------- the deposit slip ---------- */
const regBody=q('[data-entries]');
const itemsField=q('[data-items]');
const stamp=q('[data-stamp]');
const stampAt=q('[data-stamp-at]');
const combEl=q('[data-comb]');
const carbonEl=q('[data-carbon]');

function regRow(e){
  const tr=document.createElement('tr');
  tr.dataset.key=key(e);
  cell(tr,clock(e.at)).title=e.at;
  cell(tr,e.route);
  cell(tr,netOf(e),'net');
  cell(tr,short(e.payer)).title=e.payer;
  cell(tr,usd(e.amount),'n');
  const td=document.createElement('td');
  const a=document.createElement('a');
  a.href=txHref(e);
  a.textContent=short(e.tx);
  a.rel='noopener noreferrer';
  a.target='_blank';
  td.appendChild(a);
  tr.appendChild(td);
  return tr;
}
function register(entries){
  const known=new Set([...regBody.querySelectorAll('tr[data-key]')].map(tr=>tr.dataset.key));
  const fresh=entries.filter(e=>!known.has(key(e))).map(regRow);
  if(!fresh.length)return 0;
  const empty=regBody.querySelector('.empty');
  if(empty)empty.remove();
  if(!calm.matches)fresh.forEach(tr=>tr.classList.add('enter'));
  fresh.slice().reverse().forEach(tr=>regBody.insertBefore(tr,regBody.firstChild));
  requestAnimationFrame(()=>requestAnimationFrame(()=>fresh.forEach(tr=>tr.classList.remove('enter'))));
  while(regBody.children.length>20)regBody.removeChild(regBody.lastChild);
  return fresh.length;
}
function paintComb(el,str,animate){
  while(el.children.length>str.length)el.removeChild(el.lastChild);
  while(el.children.length<str.length){
    const c=document.createElement('span');
    c.className='cell';
    const g=document.createElement('span');
    g.className='g';
    c.appendChild(g);
    el.appendChild(c);
  }
  for(let i=0;i<str.length;i++){
    const box=el.children[i],glyph=box.firstChild,ch=str.charAt(i);
    const sep=ch==='$'||ch===','||ch==='.';
    box.className='cell'+(sep?' sep':'')+(ch===' '?' blank':'');
    const want=ch===' '?'':ch;
    if(glyph.textContent===want)continue;
    glyph.textContent=want;
    if(animate&&!calm.matches){
      box.classList.add('typing');
      void box.offsetWidth;
      requestAnimationFrame(()=>requestAnimationFrame(()=>box.classList.remove('typing')));
    }
  }
}
let carbonTimer=0;
function paintTotal(entries,animate){
  const sum=entries.reduce((a,e)=>a+Number(e.amount),0);
  const str=('$'+(sum/1e6).toFixed(4)).padStart(11,' ');
  itemsField.textContent=String(entries.length);
  paintComb(combEl,str,animate);
  clearTimeout(carbonTimer);
  if(animate&&!calm.matches)carbonTimer=setTimeout(()=>paintComb(carbonEl,str,false),170);
  else paintComb(carbonEl,str,false);
}
function thunk(e){
  stampAt.textContent=clock(e.at);
  stamp.classList.remove('landed');
  void stamp.offsetWidth;
  stamp.classList.add('landed');
}

/* ---------- standings (FLIP) ---------- */
const boardBody=q('[data-board]');
function paintBoard(leaders){
  if(!leaders.length)return;
  const rows=new Map([...boardBody.querySelectorAll('tr[data-payer]')].map(tr=>[tr.dataset.payer,tr]));
  const before=new Map();
  if(!calm.matches)rows.forEach(tr=>before.set(tr,tr.getBoundingClientRect().top));
  const empty=boardBody.querySelector('.empty');
  if(empty)empty.remove();
  const next=leaders.map(l=>{
    let tr=rows.get(l.payer);
    if(!tr){
      tr=document.createElement('tr');
      tr.dataset.payer=l.payer;
      cell(tr,short(l.payer),'m').title=l.payer;
      cell(tr,usd(l.total),'m n');
      cell(tr,int(l.count),'m n');
      if(rows.size)tr.classList.add('shine');
    }else{
      tr.children[1].textContent=usd(l.total);
      tr.children[2].textContent=int(l.count);
    }
    return tr;
  });
  boardBody.replaceChildren(...next);
  next.forEach(tr=>{
    const was=before.get(tr);
    if(was===undefined)return;
    const delta=was-tr.getBoundingClientRect().top;
    if(!delta)return;
    tr.style.transition='none';
    tr.style.transform='translateY('+delta+'px)';
    requestAnimationFrame(()=>{
      tr.style.transition='transform 260ms var(--ei)';
      tr.style.transform='';
    });
  });
}

/* ---------- the wall ---------- */
const tipList=q('[data-tips]');
function paintTips(names){
  if(!names.length){tipList.textContent='no tips yet';return}
  const had=new Set([...tipList.querySelectorAll('.chip')].map(el=>el.textContent));
  tipList.replaceChildren(...names.map(n=>{
    const s=document.createElement('span');
    s.className='chip';
    s.textContent=n;
    if(had.size&&!had.has(n)&&!calm.matches){
      s.classList.add('fresh');
      requestAnimationFrame(()=>requestAnimationFrame(()=>s.classList.remove('fresh')));
    }
    return s;
  }));
}

/* ---------- copy ---------- */
qa('[data-copy]').forEach(btn=>{
  let timer=0;
  btn.addEventListener('click',()=>{
    const done=navigator.clipboard&&navigator.clipboard.writeText(btn.dataset.copy);
    if(!done)return;
    done.then(()=>{
      btn.textContent='Copied';
      btn.dataset.done='1';
      clearTimeout(timer);
      timer=setTimeout(()=>{btn.textContent='Copy';delete btn.dataset.done},1400);
    },()=>{});
  });
});

document.addEventListener('animationend',e=>e.target.classList.remove('shine'));

async function tick(){
  const d=await fetch('/ledger').then(r=>r.json()).catch(()=>null);
  if(!d)return;
  const entries=d.entries.slice(0,20);
  const fresh=register(entries);
  paintStats(d.stats);
  paintTotal(entries,fresh>0);
  if(fresh&&entries[0])thunk(entries[0]);
  paintBoard(d.leaderboard);
  paintTips(d.tips);
}
setInterval(tick,8000);
})();
</script>
</body></html>`;
}
