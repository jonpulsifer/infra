/* infra wiki client: theme toggle, ⌘K search, graph view. no deps. */
(() => {
  // ── theme ──
  const root = document.documentElement;
  document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
    const dark = !root.classList.contains("dark");
    root.classList.toggle("dark", dark);
    localStorage.theme = dark ? "dark" : "light";
  });

  // ── search ──
  const modal = document.querySelector(".search-modal");
  const input = modal?.querySelector("input");
  const list = modal?.querySelector(".search-results");
  let index = null;
  let sel = 0;

  const open = async () => {
    modal.hidden = false;
    input.value = "";
    list.innerHTML = "";
    input.focus();
    index ??= await (await fetch("/search.json")).json();
  };
  const close = () => (modal.hidden = true);

  const render = (results) => {
    sel = 0;
    list.innerHTML = results
      .map(
        (r, i) =>
          `<li${i === 0 ? ' class="sel"' : ""}><a href="${r.u}">${r.t}<small>${r.snip}</small></a></li>`,
      )
      .join("");
  };

  const search = (q) => {
    q = q.trim().toLowerCase();
    if (!q || !index) return render([]);
    const terms = q.split(/\s+/);
    const scored = [];
    for (const p of index) {
      const title = p.t.toLowerCase();
      const text = p.x.toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of terms) {
        if (title.includes(t)) score += title.startsWith(t) ? 12 : 6;
        else if (text.includes(t)) score += 1;
        else { ok = false; break; }
      }
      if (!ok || !score) continue;
      const at = text.indexOf(terms[0]);
      const snip = at >= 0 ? p.x.slice(Math.max(0, at - 30), at + 90) : p.x.slice(0, 100);
      scored.push({ ...p, score, snip: `…${snip}…` });
    }
    render(scored.sort((a, b) => b.score - a.score).slice(0, 9));
  };

  document.querySelectorAll("[data-search]").forEach((b) => b.addEventListener("click", open));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); modal.hidden ? open() : close(); }
    else if (e.key === "/" && modal.hidden && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); open(); }
    else if (!modal.hidden) {
      const items = [...list.querySelectorAll("li")];
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(items.length, 1);
        items.forEach((li, i) => li.classList.toggle("sel", i === sel));
        items[sel]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") items[sel]?.querySelector("a")?.click();
    }
  });
  modal?.addEventListener("click", (e) => e.target === modal && close());
  input?.addEventListener("input", () => search(input.value));

  // ── graph ──
  const canvas = document.getElementById("graph");
  if (!canvas) return;

  fetch("/graph.json").then((r) => r.json()).then(({ nodes, links }) => {
    const ctx = canvas.getContext("2d");
    const dpr = devicePixelRatio || 1;
    let W, H;
    const resize = () => {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener("resize", resize);

    const N = nodes.map((n, i) => ({
      ...n,
      x: W / 2 + Math.cos((i / nodes.length) * 2 * Math.PI) * Math.min(W, H) * 0.32,
      y: H / 2 + Math.sin((i / nodes.length) * 2 * Math.PI) * Math.min(W, H) * 0.32,
      vx: 0, vy: 0, r: 4 + Math.sqrt(n.d) * 2.2,
    }));
    let zoom = 1, panX = 0, panY = 0, hover = -1, heat = 1;

    const tick = () => {
      // repulsion
      for (let i = 0; i < N.length; i++)
        for (let j = i + 1; j < N.length; j++) {
          const a = N[i], b = N[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
          const f = Math.min(2200 / d2, 4);
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f;
          b.vx -= dx * f; b.vy -= dy * f;
        }
      // springs
      for (const [s, t] of links) {
        const a = N[s], b = N[t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - 110) * 0.004;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const n of N) {
        n.vx += (W / 2 - n.x) * 0.0012; n.vy += (H / 2 - n.y) * 0.0012;
        n.x += n.vx * heat; n.y += n.vy * heat;
        n.vx *= 0.82; n.vy *= 0.82;
      }
      heat = Math.max(heat * 0.995, 0.25);
    };

    const violet = "#8b5cf6", blue = "#60a5fa";
    const dark = () => document.documentElement.classList.contains("dark");
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(panX, panY); ctx.scale(zoom, zoom);
      ctx.lineWidth = 1 / zoom;
      for (const [s, t] of links) {
        const hi = hover === s || hover === t;
        ctx.strokeStyle = hi ? blue : dark() ? "rgba(139,92,246,.22)" : "rgba(139,92,246,.3)";
        ctx.beginPath(); ctx.moveTo(N[s].x, N[s].y); ctx.lineTo(N[t].x, N[t].y); ctx.stroke();
      }
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        const hi = i === hover;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
        g.addColorStop(0, hi ? blue : "#a78bfa");
        g.addColorStop(1, violet);
        ctx.fillStyle = g;
        ctx.shadowColor = violet; ctx.shadowBlur = hi ? 26 : 10;
        ctx.fill();
        ctx.shadowBlur = 0;
        if (zoom > 0.55 || hi || n.d > 4) {
          ctx.font = `${hi ? 600 : 450} ${11 / zoom}px Inter, sans-serif`;
          ctx.fillStyle = dark() ? (hi ? "#f4f5fb" : "rgba(217,219,232,.78)") : (hi ? "#191b28" : "rgba(42,45,61,.8)");
          ctx.fillText(n.t, n.x + n.r + 4 / zoom, n.y + 3.5 / zoom);
        }
      }
      ctx.restore();
    };

    const pos = (e) => {
      const b = canvas.getBoundingClientRect();
      return [(e.clientX - b.left - panX) / zoom, (e.clientY - b.top - panY) / zoom];
    };
    canvas.addEventListener("mousemove", (e) => {
      if (drag) { panX += e.movementX; panY += e.movementY; return; }
      const [x, y] = pos(e);
      hover = N.findIndex((n) => Math.hypot(n.x - x, n.y - y) < n.r + 5);
      canvas.style.cursor = hover >= 0 ? "pointer" : "grab";
    });
    canvas.addEventListener("click", () => { if (hover >= 0) location.href = N[hover].u; });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.1 : 0.9;
      const b = canvas.getBoundingClientRect();
      const mx = e.clientX - b.left, my = e.clientY - b.top;
      panX = mx - (mx - panX) * f; panY = my - (my - panY) * f;
      zoom *= f;
    }, { passive: false });
    let drag = false;
    canvas.addEventListener("mousedown", () => (drag = true));
    addEventListener("mouseup", () => (drag = false));

    const loop = () => { tick(); draw(); requestAnimationFrame(loop); };
    loop();
  });
})();
