#!/usr/bin/env node

/**
 * Agent Sandbox Web Terminal Server
 *
 * Serves a landing page with tool selection and a full-viewport
 * ghostty-web terminal connected to a PTY running the chosen command.
 */

import fs from "fs";
import http from "http";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pty = require("@lydell/node-pty");
const { WebSocketServer } = require("ws");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const DIST_PATH = path.join(__dirname, "dist");
const WASM_PATH = path.join(__dirname, "ghostty-vt.wasm");

// ============================================================================
// Tool definitions
// ============================================================================

const TOOLS = [
  {
    id: "claude",
    name: "Claude Code",
    description: "AI coding assistant by Anthropic",
    icon: "\u2728",
    cmd: "claude",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Terminal-based AI coding agent",
    icon: "\u2b21",
    cmd: "opencode",
  },
  {
    id: "bash",
    name: "Shell",
    description: "Interactive bash session",
    icon: "\u276f",
    cmd: null, // uses $SHELL
  },
];

function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function getCommand(cmdId) {
  const tool = TOOLS.find((t) => t.id === cmdId);
  if (tool && tool.cmd) return [tool.cmd, []];
  return [getShell(), []];
}

function getToolName(cmdId) {
  const tool = TOOLS.find((t) => t.id === cmdId);
  return tool ? tool.name : "Shell";
}

// ============================================================================
// HTML Templates
// ============================================================================

const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Sandbox</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    .container {
      max-width: 720px;
      width: 100%;
      text-align: center;
    }

    .logo {
      font-size: 3rem;
      margin-bottom: 0.5rem;
      filter: grayscale(0.2);
    }

    h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #e4e4e7, #a1a1aa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .subtitle {
      color: #71717a;
      font-size: 0.95rem;
      margin-bottom: 2.5rem;
      line-height: 1.5;
    }

    .tools {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 3rem;
    }

    .tool-card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 1.75rem 1.25rem;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.75rem;
    }

    .tool-card:hover {
      border-color: #3f3f46;
      background: #1f1f23;
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .tool-card:active {
      transform: translateY(0);
    }

    .tool-icon {
      font-size: 2rem;
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #27272a;
      border-radius: 12px;
    }

    .tool-name {
      font-size: 1rem;
      font-weight: 600;
      color: #fafafa;
    }

    .tool-desc {
      font-size: 0.8rem;
      color: #71717a;
      line-height: 1.4;
    }

    footer {
      color: #3f3f46;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }

    footer a {
      color: #52525b;
      text-decoration: none;
    }

    footer a:hover { color: #71717a; }

    @media (max-width: 640px) {
      .tools { grid-template-columns: 1fr; }
      h1 { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">\u25e8</div>
    <h1>Agent Sandbox</h1>
    <p class="subtitle">Isolated AI agent runtime with web terminal access</p>
    <div class="tools">
      ${TOOLS.map(
        (t) => `
        <a class="tool-card" href="/terminal?cmd=${t.id}">
          <div class="tool-icon">${t.icon}</div>
          <div class="tool-name">${t.name}</div>
          <div class="tool-desc">${t.description}</div>
        </a>`
      ).join("")}
    </div>
    <footer>Powered by <a href="https://github.com/coder/ghostty-web">ghostty-web</a> + <a href="https://gvisor.dev">gVisor</a></footer>
  </div>
</body>
</html>`;

function terminalPage(cmdId) {
  const toolName = getToolName(cmdId);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${toolName} \u2014 Agent Sandbox</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    html, body { height: 100%; overflow: hidden; background: #0a0a0f; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e4e4e7;
      display: flex;
      flex-direction: column;
    }

    .toolbar {
      height: 40px;
      min-height: 40px;
      background: #18181b;
      border-bottom: 1px solid #27272a;
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 12px;
      z-index: 10;
    }

    .back-btn {
      color: #71717a;
      text-decoration: none;
      font-size: 1.1rem;
      display: flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 6px;
      transition: all 0.15s;
    }

    .back-btn:hover { color: #a1a1aa; background: #27272a; }

    .toolbar-title {
      font-size: 0.8rem;
      font-weight: 600;
      color: #a1a1aa;
      letter-spacing: 0.02em;
    }

    .toolbar-spacer { flex: 1; }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      color: #52525b;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #52525b;
      transition: background 0.3s;
    }

    .status-dot.connected { background: #22c55e; }
    .status-dot.connecting { background: #eab308; animation: pulse 1.2s infinite; }
    .status-dot.disconnected { background: #ef4444; }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    #terminal {
      flex: 1;
      background: #0a0a0f;
      overflow: hidden;
    }

    #terminal canvas { display: block; }

    .session-ended {
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(10, 10, 15, 0.92);
      z-index: 20;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 1rem;
    }

    .session-ended.visible { display: flex; }

    .session-ended h2 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #a1a1aa;
    }

    .session-ended a {
      color: #0a0a0f;
      background: #e4e4e7;
      text-decoration: none;
      padding: 0.5rem 1.25rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      transition: background 0.15s;
    }

    .session-ended a:hover { background: #fafafa; }
  </style>
</head>
<body>
  <div class="toolbar">
    <a class="back-btn" href="/">\u2190</a>
    <span class="toolbar-title">${toolName}</span>
    <div class="toolbar-spacer"></div>
    <div class="status">
      <div class="status-dot connecting" id="status-dot"></div>
      <span id="status-text">Connecting</span>
    </div>
  </div>
  <div id="terminal"></div>
  <div class="session-ended" id="session-ended">
    <h2>Session ended</h2>
    <a href="/">Back to launcher</a>
  </div>

  <script type="module">
    import { init, Terminal } from '/dist/ghostty-web.js';

    await init();

    const term = new Terminal({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
      theme: {
        background: '#0a0a0f',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        cursorAccent: '#0a0a0f',
        selectionBackground: '#3f3f46',
        black: '#27272a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
    });

    // Dynamic import for FitAddon — handle both named and default export
    let FitAddon;
    try {
      const mod = await import('/dist/ghostty-web.js');
      FitAddon = mod.FitAddon;
    } catch (e) {}
    if (!FitAddon) {
      try {
        const mod = await import('/dist/addons/fit.js');
        FitAddon = mod.FitAddon || mod.default;
      } catch (e) {}
    }

    let fitAddon;
    if (FitAddon) {
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
    }

    const container = document.getElementById('terminal');
    await term.open(container);

    if (fitAddon) {
      fitAddon.fit();
      if (fitAddon.observeResize) fitAddon.observeResize();
    }

    // Status
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    function setStatus(s, label) {
      dot.className = 'status-dot ' + s;
      text.textContent = label;
    }

    // WebSocket
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cmd = new URLSearchParams(location.search).get('cmd') || 'bash';
    let ws;
    let intentionalClose = false;

    function connect() {
      setStatus('connecting', 'Connecting');
      const url = proto + '//' + location.host + '/ws?cmd=' + encodeURIComponent(cmd) + '&cols=' + term.cols + '&rows=' + term.rows;
      ws = new WebSocket(url);

      ws.onopen = () => setStatus('connected', 'Connected');

      ws.onmessage = (e) => term.write(e.data);

      ws.onclose = (e) => {
        setStatus('disconnected', 'Disconnected');
        if (!intentionalClose) {
          document.getElementById('session-ended').classList.add('visible');
        }
      };

      ws.onerror = () => setStatus('disconnected', 'Error');
    }

    connect();

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });
  </script>
</body>
</html>`;
}

// ============================================================================
// MIME types
// ============================================================================

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ============================================================================
// HTTP Server
// ============================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Landing page
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(LANDING_PAGE);
    return;
  }

  // Terminal page
  if (pathname === "/terminal") {
    const cmd = url.searchParams.get("cmd") || "bash";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(terminalPage(cmd));
    return;
  }

  // ghostty-web dist files
  if (pathname.startsWith("/dist/")) {
    const filePath = path.join(DIST_PATH, pathname.slice(6));
    return serveFile(filePath, res);
  }

  // WASM file
  if (pathname === "/ghostty-vt.wasm") {
    return serveFile(WASM_PATH, res);
  }

  res.writeHead(404);
  res.end("Not Found");
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

// ============================================================================
// WebSocket PTY Server
// ============================================================================

const sessions = new Map();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cmdId = url.searchParams.get("cmd") || "bash";
  const cols = parseInt(url.searchParams.get("cols") || "80", 10);
  const rows = parseInt(url.searchParams.get("rows") || "24", 10);

  const [cmd, args] = getCommand(cmdId);

  const ptyProcess = pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  sessions.set(ws, { pty: ptyProcess });

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (data) => {
    const msg = data.toString("utf8");
    if (msg.startsWith("{")) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize") {
          ptyProcess.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {}
    }
    ptyProcess.write(msg);
  });

  ws.on("close", () => {
    const session = sessions.get(ws);
    if (session) {
      session.pty.kill();
      sessions.delete(ws);
    }
  });

  ws.on("error", () => {});
});

// ============================================================================
// Start
// ============================================================================

process.on("SIGINT", () => {
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Agent Sandbox server listening on http://0.0.0.0:${PORT}`);
});
