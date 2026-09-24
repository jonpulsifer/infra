/* infra wiki client: theme, mobile nav, search, code copy, scrollspy, graph. No deps. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const isDark = () =>
    root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("[data-theme-toggle]")?.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    dispatchEvent(new Event("themechange"));
  });

  const side = $("#side");
  const menu = $("[data-menu]");
  const setMenu = (open) => {
    side?.toggleAttribute("data-open", open);
    menu?.setAttribute("aria-expanded", String(open));
  };
  menu?.addEventListener("click", () => setMenu(!side.hasAttribute("data-open")));

  const dialog = $("dialog.search");
  const input = $("input", dialog);
  const results = $("#search-results");
  let index;
  let sel = 0;

  const open = async () => {
    setMenu(false);
    dialog.showModal();
    input.select();
    index ??= await fetch("/search.json").then((r) => r.json());
    search();
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const highlight = (node, text, terms) => {
    const re = new RegExp(`(${terms.map(escRe).join("|")})`, "gi");
    for (const [i, part] of text.split(re).entries()) node.append(i % 2 ? el("mark", "", part) : part);
    return node;
  };
  const snippet = (text, term) => {
    const at = text.toLowerCase().indexOf(term);
    if (at < 0) return "";
    const from = Math.max(0, at - 40);
    return (from ? "…" : "") + text.slice(from, at + 120);
  };
  const move = (to) => {
    const items = $$("li[role=option]", results);
    if (!items.length) return;
    sel = (to + items.length) % items.length;
    for (const [i, li] of items.entries()) {
      li.classList.toggle("sel", i === sel);
      li.setAttribute("aria-selected", String(i === sel));
    }
    items[sel].scrollIntoView({ block: "nearest" });
  };

  function search() {
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    results.replaceChildren();
    if (!terms.length || !index) return;
    const hits = [];
    for (const p of index) {
      const title = p.t.toLowerCase();
      let score = 0;
      let anchor;
      for (const t of terms) {
        const h = p.h.find(([text]) => text.toLowerCase().includes(t));
        if (title.includes(t)) score += title.startsWith(t) ? 12 : 8;
        else if (h) {
          score += 5;
          anchor ??= h;
        }
        else if (p.d.toLowerCase().includes(t)) score += 3;
        else if (p.x.toLowerCase().includes(t)) score += 1;
        else {
          score = 0;
          break;
        }
      }
      if (score) hits.push({ p, score, anchor });
    }
    hits.sort((a, b) => b.score - a.score);
    for (const { p, anchor } of hits.slice(0, 12)) {
      const li = el("li");
      li.setAttribute("role", "option");
      const a = el("a");
      a.href = anchor ? `${p.u}#${anchor[1]}` : p.u;
      const title = highlight(el("span", "r-title"), anchor ? `${p.t} › ${anchor[0]}` : p.t, terms);
      a.append(title, el("span", "r-sec eyebrow", p.s));
      a.append(highlight(el("span", "r-snip"), snippet(p.x, terms[0]) || p.d, terms));
      li.append(a);
      results.append(li);
    }
    if (!hits.length) results.append(el("li", "r-none", "No page matches."));
    move(0);
  }

  input?.addEventListener("input", search);
  for (const b of $$("[data-search]")) b.addEventListener("click", open);
  dialog?.addEventListener("click", (e) => e.target === dialog && dialog.close());
  dialog?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(sel + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      $$("li[role=option] a", results)[sel]?.click();
    }
  });
  addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      dialog.open ? dialog.close() : open();
    } else if (e.key === "/" && !typing && !dialog.open) {
      e.preventDefault();
      open();
    } else if (e.key === "Escape" && side?.hasAttribute("data-open")) {
      setMenu(false);
      menu.focus();
    }
  });

  for (const block of $$(".code")) {
    const b = el("button", "copy", "Copy");
    b.type = "button";
    b.setAttribute("aria-label", "Copy code");
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("pre", block).textContent);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Failed";
      }
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
    block.append(b);
  }

  const toc = new Map($$(".toc a").map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const heads = [...toc.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const spy = () => {
    let cur = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < innerHeight / 3) cur = h;
    for (const [id, a] of toc) {
      if (id === cur.id) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  };
  if (heads.length) {
    addEventListener("scroll", spy, { passive: true });
    spy();
  }

  const canvas = $("#graph");
  if (canvas) fetch("/graph.json").then((r) => r.json()).then((g) => graph(canvas, g));

  function graph(canvas, { nodes, links }) {
    const ctx = canvas.getContext("2d");
    const N = nodes.map((n, i) => {
      const a = (i / nodes.length) * 2 * Math.PI;
      return { ...n, x: Math.cos(a) * 200, y: Math.sin(a) * 200, vx: 0, vy: 0, r: 3 + Math.sqrt(n.d) * 2 };
    });
    let W = 0;
    let H = 0;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let hover = -1;
    let alpha = 1;
    let raf = 0;
    let drag = null;
    let fitted = true;
    const fit = () => {
      const xs = N.map((n) => n.x);
      const ys = N.map((n) => n.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      zoom = Math.min(2, (W - 180) / (x1 - x0 || 1), (H - 60) / (y1 - y0 || 1));
      panX = -((x0 + x1) / 2 + 60) * zoom;
      panY = -((y0 + y1) / 2) * zoom;
    };

    const tick = () => {
      for (let i = 0; i < N.length; i++)
        for (let j = i + 1; j < N.length; j++) {
          const a = N[i];
          const b = N[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const f = (Math.min(6000 / d2, 3) * alpha) / Math.sqrt(d2);
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      for (const [s, t] of links) {
        const a = N[s];
        const b = N[t];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - 120) * 0.01 * alpha) / d;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of N) {
        n.vx = (n.vx - n.x * 0.004 * alpha) * 0.6;
        n.vy = (n.vy - n.y * 0.004 * alpha) * 0.6;
        n.x += n.vx;
        n.y += n.vy;
      }
      alpha *= 0.985;
    };

    const draw = () => {
      const css = getComputedStyle(canvas);
      if (fitted) fit();
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(W / 2 + panX, H / 2 + panY);
      ctx.scale(zoom, zoom);
      ctx.lineWidth = 1 / zoom;
      for (const [s, t] of links) {
        ctx.strokeStyle = hover === s || hover === t ? css.caretColor : css.borderTopColor;
        ctx.beginPath();
        ctx.moveTo(N[s].x, N[s].y);
        ctx.lineTo(N[t].x, N[t].y);
        ctx.stroke();
      }
      ctx.font = `500 ${11 / zoom}px Geist, sans-serif`;
      N.forEach((n, i) => {
        ctx.fillStyle = i === hover ? css.caretColor : css.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
        ctx.fill();
        if (zoom > 0.7 || i === hover || n.d > 3) ctx.fillText(n.t, n.x + n.r + 4 / zoom, n.y + 3.5 / zoom);
      });
    };

    const frame = () => {
      if (alpha > 0.01) tick();
      draw();
      raf = alpha > 0.01 ? requestAnimationFrame(frame) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const resize = () => {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * devicePixelRatio;
      canvas.height = H * devicePixelRatio;
      kick();
    };
    const at = (e) => {
      const b = canvas.getBoundingClientRect();
      const x = (e.clientX - b.left - W / 2 - panX) / zoom;
      const y = (e.clientY - b.top - H / 2 - panY) / zoom;
      return N.findIndex((n) => Math.hypot(n.x - x, n.y - y) < n.r + 5);
    };

    canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      fitted = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (drag) {
        panX += e.clientX - drag.x;
        panY += e.clientY - drag.y;
        drag.moved ||= Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2;
        drag.x = e.clientX;
        drag.y = e.clientY;
      } else hover = at(e);
      canvas.style.cursor = hover >= 0 && !drag ? "pointer" : drag ? "grabbing" : "grab";
      kick();
    });
    canvas.addEventListener("pointerup", (e) => {
      const i = at(e);
      if (drag && !drag.moved && i >= 0) location.href = N[i].u;
      drag = null;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        fitted = false;
        zoom = Math.min(4, Math.max(0.25, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        kick();
      },
      { passive: false },
    );
    addEventListener("resize", resize);
    addEventListener("themechange", kick);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", kick);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) while (alpha > 0.01) tick();
    resize();
  }
})();
