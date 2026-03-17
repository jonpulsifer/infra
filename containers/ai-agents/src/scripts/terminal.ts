// @ts-nocheck — ghostty-web types are not available
import { init, Terminal } from "/dist/ghostty-web.js";

interface Config {
  cmdId: string;
  toolName: string;
}

const config: Config = (window as any).__CONFIG__;

// Set page title and toolbar
document.title = `${config.toolName} — Agent Sandbox`;
document.getElementById("toolbar-title")!.textContent = config.toolName;

await init();

const FONTS: Record<string, string> = {
  "CaskaydiaCove NF": "'CaskaydiaCove NF', monospace",
  "0xProto NF": "'0xProto NF', monospace",
  "FiraCode NF": "'FiraCode NF', monospace",
  "GeistMono NF": "'GeistMono NF', monospace",
  "Inconsolata NF": "'Inconsolata NF', monospace",
  "JetBrainsMono NF": "'JetBrainsMono NF', monospace",
  "SpaceMono NF": "'SpaceMono NF', monospace",
  "ZedMono NF": "'ZedMono NF', monospace",
};

const savedFont = localStorage.getItem("terminal-font") || "CaskaydiaCove NF";
const picker = document.getElementById("font-picker") as HTMLSelectElement;
picker.value = savedFont;

const term = new Terminal({
  fontSize: 14,
  fontFamily: FONTS[savedFont] || FONTS["CaskaydiaCove NF"],
  theme: {
    background: "#0a0a0f",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#0a0a0f",
    selectionBackground: "#3f3f46",
    black: "#27272a",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
});

// Dynamic import for FitAddon — handle both named and default export
let FitAddon: any;
try {
  const mod = await import("/dist/ghostty-web.js");
  FitAddon = mod.FitAddon;
} catch {}
if (!FitAddon) {
  try {
    const mod = await import("/dist/addons/fit.js");
    FitAddon = mod.FitAddon || mod.default;
  } catch {}
}

let fitAddon: any;
if (FitAddon) {
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
}

const container = document.getElementById("terminal")!;
await term.open(container);

if (fitAddon) {
  fitAddon.fit();
  if (fitAddon.observeResize) fitAddon.observeResize();
}

// Status indicator
const dot = document.getElementById("status-dot")!;
const text = document.getElementById("status-text")!;
function setStatus(s: string, label: string) {
  dot.className = "status-dot " + s;
  text.textContent = label;
}

// WebSocket connection
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const cmd = new URLSearchParams(location.search).get("cmd") || "bash";
let ws: WebSocket;
let intentionalClose = false;

function connect() {
  setStatus("connecting", "Connecting");
  const url =
    proto +
    "//" +
    location.host +
    "/ws?cmd=" +
    encodeURIComponent(cmd) +
    "&cols=" +
    term.cols +
    "&rows=" +
    term.rows;
  ws = new WebSocket(url);

  ws.onopen = () => setStatus("connected", "Connected");
  ws.onmessage = (e: MessageEvent) => term.write(e.data);
  ws.onclose = () => {
    setStatus("disconnected", "Disconnected");
    if (!intentionalClose) {
      document.getElementById("session-ended")!.classList.add("visible");
    }
  };
  ws.onerror = () => setStatus("disconnected", "Error");
}

connect();

term.onData((data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
});

term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
});

window.addEventListener("resize", () => {
  if (fitAddon) fitAddon.fit();
});

// Font picker
picker.addEventListener("change", () => {
  const font = picker.value;
  localStorage.setItem("terminal-font", font);
  term.options.fontFamily = FONTS[font] || FONTS["CaskaydiaCove NF"];
  if (fitAddon) fitAddon.fit();
});
