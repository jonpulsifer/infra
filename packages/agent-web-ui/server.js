#!/usr/bin/env node

/**
 * Agent Sandbox Web Terminal Server
 *
 * Lean backend: serves pre-built HTML/CSS/JS from dist/, manages PTY
 * sessions over WebSocket, and runs the OpenClaw gateway as a background
 * service with automatic restart.
 */

import { spawn } from "child_process";
import { randomBytes } from "crypto";
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
const GHOSTTY_DIST = path.join(__dirname, "dist");
const WASM_PATH = path.join(__dirname, "ghostty-vt.wasm");
const APP_DIST = path.join(__dirname, "app");

// ============================================================================
// Tool definitions
// ============================================================================

const TOOLS = [
  {
    id: "claude",
    name: "Claude Code",
    description: "AI coding assistant by Anthropic",
    icon: "/assets/icons/claude.svg",
    cmd: "claude",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Terminal-based AI coding agent",
    icon: "/assets/icons/opencode.svg",
    cmd: "opencode",
  },
  {
    id: "openclaw",
    name: "OpenClaw TUI",
    description: "Self-hosted AI assistant terminal interface",
    icon: "/assets/icons/openclaw.svg",
    cmd: "openclaw",
    args: ["tui"],
  },
  {
    id: "openclaw-gw",
    name: "OpenClaw Gateway",
    description: "Web dashboard for the OpenClaw gateway",
    icon: "/assets/icons/openclaw.svg",
    href: ":18789",
  },
  {
    id: "bash",
    name: "Shell",
    description: "Interactive bash session",
    icon: "/assets/icons/ghostty-icon.png",
    cmd: null, // uses $SHELL
  },
];

function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function getCommand(cmdId) {
  const tool = TOOLS.find((t) => t.id === cmdId);
  if (tool && tool.cmd) return [tool.cmd, tool.args || []];
  return [getShell(), []];
}

function getToolName(cmdId) {
  const tool = TOOLS.find((t) => t.id === cmdId);
  return tool ? tool.name : "Shell";
}

// ============================================================================
// Template injection
// ============================================================================

function serveTemplate(file, config, res) {
  const filePath = path.join(APP_DIST, file);
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }
    const injected = html.replace(
      "<!--__SERVER_CONFIG__-->",
      `<script>window.__CONFIG__=${JSON.stringify(config)}</script>`
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(injected);
  });
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
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

// ============================================================================
// HTTP Server
// ============================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health probes (k8s liveness/readiness)
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (pathname === "/readyz") {
    const gatewayUp = isGatewayHealthy();
    const status = gatewayUp ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: gatewayUp ? "ok" : "not ready",
        gateway: gatewayUp ? "running" : "down",
      })
    );
    return;
  }

  // Landing page
  if (pathname === "/" || pathname === "/index.html") {
    return serveTemplate("landing.html", {
      tools: TOOLS,
      openclawToken: openclawToken,
    }, res);
  }

  // Terminal page
  if (pathname === "/terminal") {
    const cmd = url.searchParams.get("cmd") || "bash";
    return serveTemplate("terminal.html", {
      cmdId: cmd,
      toolName: getToolName(cmd),
    }, res);
  }

  // Our built assets (CSS, JS, icons, fonts)
  if (pathname.startsWith("/assets/")) {
    const filePath = path.join(APP_DIST, pathname.slice(8));
    return serveFile(filePath, res);
  }

  // Font files (served from our dist)
  if (pathname.startsWith("/fonts/")) {
    const filePath = path.join(APP_DIST, "fonts", pathname.slice(7));
    return serveFile(filePath, res);
  }

  // ghostty-web dist files
  if (pathname.startsWith("/dist/")) {
    const filePath = path.join(GHOSTTY_DIST, pathname.slice(6));
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
// OpenClaw Gateway (background service)
// ============================================================================

let openclawGateway = null;
let openclawToken = null;
let gatewayRestarts = 0;
let shuttingDown = false;

const GATEWAY_RESTART_BASE_DELAY = 1000;
const GATEWAY_RESTART_MAX_DELAY = 30000;

function startOpenClawGateway() {
  if (shuttingDown) return;

  // Ensure openclaw config exists with sane container defaults
  const openclawDir = path.join(homedir(), ".openclaw");
  const openclawConfig = path.join(openclawDir, "openclaw.json");
  if (!fs.existsSync(openclawConfig)) {
    fs.mkdirSync(openclawDir, { recursive: true });

    openclawToken =
      process.env.OPENCLAW_GATEWAY_TOKEN || randomBytes(32).toString("hex");

    fs.writeFileSync(
      openclawConfig,
      JSON.stringify(
        {
          gateway: {
            auth: { token: openclawToken, mode: "token" },
            controlUi: {
              allowInsecureAuth: true,
              dangerouslyAllowHostHeaderOriginFallback: true,
              dangerouslyDisableDeviceAuth: true,
            },
          },
        },
        null,
        2
      )
    );
    console.log(`[openclaw-gw] wrote default config to ${openclawConfig}`);
  } else {
    // Read token from existing config
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawConfig, "utf8"));
      openclawToken = cfg?.gateway?.auth?.token || null;
    } catch {}
  }

  openclawGateway = spawn(
    "openclaw",
    ["gateway", "--bind", "lan", "--allow-unconfigured"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  openclawGateway.stdout.on("data", (data) => {
    process.stdout.write(`[openclaw-gw] ${data}`);
  });

  openclawGateway.stderr.on("data", (data) => {
    process.stderr.write(`[openclaw-gw] ${data}`);
  });

  openclawGateway.on("exit", (code, signal) => {
    openclawGateway = null;
    if (shuttingDown) return;

    gatewayRestarts++;
    const delay = Math.min(
      GATEWAY_RESTART_BASE_DELAY * Math.pow(2, gatewayRestarts - 1),
      GATEWAY_RESTART_MAX_DELAY
    );
    console.log(
      `[openclaw-gw] exited (code=${code}, signal=${signal}), restarting in ${delay}ms (attempt ${gatewayRestarts})`
    );
    setTimeout(startOpenClawGateway, delay);
  });

  // Reset restart counter after 60s of stable running
  openclawGateway.on("spawn", () => {
    console.log(`[openclaw-gw] started (pid=${openclawGateway.pid})`);
    setTimeout(() => {
      if (openclawGateway) gatewayRestarts = 0;
    }, 60000);
  });
}

function isGatewayHealthy() {
  return openclawGateway !== null && openclawGateway.exitCode === null;
}

// ============================================================================
// Start
// ============================================================================

function shutdown() {
  shuttingDown = true;
  if (openclawGateway) {
    openclawGateway.kill();
    openclawGateway = null;
  }
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Agent Sandbox server listening on http://0.0.0.0:${PORT}`);
  startOpenClawGateway();
});
