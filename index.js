"use strict";

const { addLog, getLogs } = require("./logger");
const { startTelemetry } = require('./telemetry');
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

let chatHistory = [];
function addChat(username, message) {
  chatHistory.push({ username, message, time: Date.now() });
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
}

let reconnectHistory = [];
function addReconnectEvent(reason, type) {
  reconnectHistory.push({ reason, type, time: Date.now() });
  if (reconnectHistory.length > 20) reconnectHistory = reconnectHistory.slice(-20);
}

const CHAT_COOLDOWN_MS = 1200;
let lastChatTime = 0;
let chatQueue = [];
let chatQueueTimer = null;

function safeBotChat(message) {
  chatQueue.push(message);
  if (!chatQueueTimer) processQueue();
}
function processQueue() {
  if (!chatQueue.length) { chatQueueTimer = null; return; }
  const now = Date.now();
  const wait = Math.max(0, CHAT_COOLDOWN_MS - (now - lastChatTime));
  chatQueueTimer = setTimeout(() => {
    if (bot && botState.connected && chatQueue.length) {
      const msg = chatQueue.shift();
      try { bot.chat(msg); lastChatTime = Date.now(); } catch (_) {}
    }
    processQueue();
  }, wait);
}

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
  ping: null,
  health: null,
  food: null,
  inventory: [],
  players: [],
  lastKickAnalysis: null,
};

let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let lastKickReason = null;
let botRunning = true;

function analyzeKickReason(reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("already connected") || r.includes("proxy"))
    return { label: "Duplicate Session", color: "#f59e0b", icon: "⚠️", tip: "Wait 60-90s before reconnecting. Proxy still has old session." };
  if (r.includes("throttl") || r.includes("too fast") || r.includes("wait before"))
    return { label: "Rate Throttled", color: "#ef4444", icon: "🚫", tip: "Server throttled reconnects. Waiting longer before retry." };
  if (r.includes("banned") || r.includes("ban"))
    return { label: "Banned", color: "#dc2626", icon: "🔨", tip: "Bot may be banned. Check server rules." };
  if (r.includes("whitelist"))
    return { label: "Not Whitelisted", color: "#dc2626", icon: "🔒", tip: "Add bot username to the server whitelist." };
  if (r.includes("outdated") || r.includes("version"))
    return { label: "Version Mismatch", color: "#8b5cf6", icon: "🔄", tip: "Update settings.json version field." };
  if (r.includes("timeout") || r.includes("timed out"))
    return { label: "Connection Timeout", color: "#6366f1", icon: "⏱️", tip: "Server took too long to respond." };
  if (r.includes("full") || r.includes("maximum"))
    return { label: "Server Full", color: "#f97316", icon: "👥", tip: "Server is at max capacity. Will retry." };
  if (r === "" || r.includes("end of stream"))
    return { label: "Server Offline / Starting", color: "#64748b", icon: "💤", tip: "Server is sleeping or starting up." };
  return { label: "Unknown Kick", color: "#94a3b8", icon: "❓", tip: reason || "No reason provided." };
}

// ── HEALTH ──────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const players = bot && bot.players
    ? Object.values(bot.players).map(p => ({ username: p.username, ping: p.ping })).filter(p => p.username)
    : [];
  const inventory = bot && bot.inventory
    ? bot.inventory.slots.slice(36, 45).map((item, i) => item ? {
        slot: i, name: item.name,
        displayName: item.displayName || item.name,
        count: item.count,
      } : null).filter(Boolean)
    : [];
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    ping: botState.ping,
    health: botState.health,
    food: botState.food,
    players, inventory,
    lastKickAnalysis: botState.lastKickAnalysis,
    serverIp: config.server.ip,
    serverPort: config.server.port,
    botRunning,
  });
});

app.get("/chat-history", (req, res) => res.json(chatHistory));
app.get("/logs-json", (req, res) => res.json(getLogs().slice(-100)));
app.get("/ping", (req, res) => res.send("pong"));

// ── BOT CONTROL ─────────────────────────────────────────────
app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true; createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  if (bot) { try { bot.end(); } catch (_) {} bot = null; }
  clearAllIntervals(); clearBotTimeouts(); isReconnecting = false;
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});

app.post("/command", (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  addLog(`[Console] > ${cmd}`);
  if (!bot || typeof bot.chat !== "function")
    return res.json({ success: false, msg: bot ? "Bot still connecting." : "Bot not running." });
  try {
    safeBotChat(cmd);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    return res.json({ success: false, msg: err.message });
  }
});

// ── DASHBOARD HTML ────────────────────────────────────────
app.get("/", (req, res) => {
  const botName = (config.name || "Bot").replace(/</g, "&lt;");
  const serverIp = (config.server.ip || "").replace(/</g, "&lt;");

  const html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>' + botName + ' Dashboard</title>\n' +
'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">\n' +
'<script src="https://js.puter.com/v2/"></script>\n' +
'<style>\n' +
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\n' +
':root{\n' +
'  --bg:#0a0f1a;--surface:#111827;--surface2:#1a2235;\n' +
'  --border:#1f2937;--text:#f1f5f9;--muted:#64748b;\n' +
'  --green:#22c55e;--red:#ef4444;--blue:#3b82f6;\n' +
'  --yellow:#f59e0b;--sidebar:#0d1424;\n' +
'}\n' +
'body{font-family:"Inter",sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;overflow:hidden}\n' +
'.sidebar{width:220px;min-width:220px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:20px 12px;gap:4px;height:100vh;position:fixed;left:0;top:0;z-index:100}\n' +
'.sidebar-brand{padding:8px 12px 20px;border-bottom:1px solid var(--border);margin-bottom:8px}\n' +
'.sidebar-brand h1{font-size:15px;font-weight:700}\n' +
'.sidebar-brand p{font-size:11px;color:var(--muted);margin-top:2px}\n' +
'.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;color:var(--muted);transition:all .15s;border:none;background:none;width:100%;text-align:left;font-family:inherit}\n' +
'.nav-item:hover{background:var(--surface);color:var(--text)}\n' +
'.nav-item.active{background:var(--surface2);color:var(--text)}\n' +
'.nav-icon{font-size:16px;width:20px;text-align:center}\n' +
'.sidebar-bottom{margin-top:auto;padding:12px;background:var(--surface);border-radius:10px;border:1px solid var(--border)}\n' +
'.side-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}\n' +
'.side-dot.online{background:var(--green);box-shadow:0 0 6px var(--green)}\n' +
'.side-dot.offline{background:var(--red)}\n' +
'.side-status-text{font-size:12px;font-weight:600}\n' +
'.main{margin-left:220px;flex:1;height:100vh;overflow-y:auto;padding:28px 24px}\n' +
'.page{display:none}.page.active{display:block}\n' +
'.page-header{margin-bottom:24px}\n' +
'.page-header h2{font-size:22px;font-weight:700}\n' +
'.page-header p{font-size:13px;color:var(--muted);margin-top:4px}\n' +
'.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}\n' +
'.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:14px}\n' +
'.card-value{font-size:28px;font-weight:700;line-height:1}\n' +
'.card-sub{font-size:12px;color:var(--muted);margin-top:6px}\n' +
'.grid{display:grid;gap:16px;margin-bottom:16px}\n' +
'.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:1fr 1fr 1fr}\n' +
'@media(max-width:700px){.g2,.g3{grid-template-columns:1fr}.sidebar{display:none}.main{margin-left:0}}\n' +
'.hero{border-radius:16px;padding:24px 28px;margin-bottom:20px;display:flex;align-items:center;gap:20px;border:1.5px solid;transition:all .4s;position:relative;overflow:hidden}\n' +
'.hero.online{background:linear-gradient(135deg,#052e16,#0a1628);border-color:#16a34a}\n' +
'.hero.offline{background:linear-gradient(135deg,#1c0a0a,#0a1628);border-color:#dc2626}\n' +
'.pulse{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;position:relative}\n' +
'.pulse.online{background:rgba(34,197,94,.15);border:2px solid #16a34a}\n' +
'.pulse.offline{background:rgba(239,68,68,.15);border:2px solid #dc2626}\n' +
'.pulse.online::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(34,197,94,.3);animation:ripple 2s infinite}\n' +
'@keyframes ripple{0%{transform:scale(1);opacity:1}100%{transform:scale(1.5);opacity:0}}\n' +
'.hero-label{font-size:20px;font-weight:700}\n' +
'.hero-label.online{color:#22c55e}.hero-label.offline{color:#ef4444}\n' +
'.hero-detail{font-size:13px;color:var(--muted);margin-top:4px}\n' +
'.ping-badge{font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#60a5fa;margin-left:auto;flex-shrink:0}\n' +
'.bar-row{margin-bottom:12px}\n' +
'.bar-label{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:5px}\n' +
'.bar-label span:last-child{font-weight:600;color:var(--text)}\n' +
'.bar-track{background:var(--border);border-radius:99px;height:8px;overflow:hidden}\n' +
'.bar-fill{height:100%;border-radius:99px;transition:width .4s ease}\n' +
'.bar-hp{background:linear-gradient(90deg,#ef4444,#f87171)}\n' +
'.bar-food{background:linear-gradient(90deg,#f59e0b,#fbbf24)}\n' +
'.player-list{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto}\n' +
'.player-item{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg);border-radius:8px;font-size:13px}\n' +
'.player-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0}\n' +
'.player-ping{margin-left:auto;font-size:11px;color:var(--muted)}\n' +
'.inv-grid{display:grid;grid-template-columns:repeat(9,1fr);gap:4px}\n' +
'.inv-slot{aspect-ratio:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);text-align:center;padding:2px;overflow:hidden;position:relative}\n' +
'.item-name{font-size:8px;line-height:1.2;word-break:break-all;color:var(--text)}\n' +
'.item-count{position:absolute;bottom:1px;right:2px;font-size:8px;font-weight:700;color:#fbbf24}\n' +
'.chat-box{background:var(--bg);border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:12px}\n' +
'.chat-msg{font-size:12.5px;line-height:1.5}\n' +
'.chat-time{color:var(--muted);font-size:10px;margin-right:6px}\n' +
'.chat-user{font-weight:700;color:#60a5fa;margin-right:4px}\n' +
'.input-row{display:flex;gap:8px}\n' +
'.txt-input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 14px;font-size:13px;color:var(--text);font-family:inherit;outline:none;transition:border-color .2s}\n' +
'.txt-input:focus{border-color:var(--blue)}\n' +
'.btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;color:#fff}\n' +
'.btn-blue{background:#1d4ed8}.btn-blue:hover{background:#2563eb}\n' +
'.btn-green{background:#15803d;border:1.5px solid #16a34a;color:#22c55e}\n' +
'.btn-green:hover{filter:brightness(1.2)}\n' +
'.btn-red{background:#7f1d1d;border:1.5px solid #dc2626;color:#ef4444}\n' +
'.btn-red:hover{filter:brightness(1.2)}\n' +
'.btn:disabled{opacity:.5;cursor:default}\n' +
'.kick-card{border-radius:10px;padding:14px 16px;border:1px solid}\n' +
'.kick-header{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:6px}\n' +
'.kick-tip{font-size:12px;color:var(--muted);line-height:1.5}\n' +
'.controls{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}\n' +
'.ctl-btn{min-height:46px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;border:1.5px solid;font-family:inherit;transition:all .2s}\n' +
'.ctl-btn:hover{filter:brightness(1.2)}\n' +
'.btn-start{background:#052e16;border-color:#16a34a;color:#22c55e}\n' +
'.btn-stop{background:#1c0505;border-color:#dc2626;color:#ef4444}\n' +
'.log-body{background:var(--bg);border-radius:10px;padding:16px;max-height:calc(100vh - 220px);overflow-y:auto;font-family:"SF Mono","Fira Code",monospace;font-size:12px;line-height:1.8;display:flex;flex-direction:column;gap:1px}\n' +
'.log-entry{display:block;white-space:pre-wrap;word-break:break-all}\n' +
'.log-entry.error{color:#f87171}.log-entry.warn{color:#fbbf24}\n' +
'.log-entry.success{color:#4ade80}.log-entry.control{color:#60a5fa}\n' +
'.log-entry.default{color:#64748b}\n' +
'.log-console{display:flex;gap:8px;margin-top:12px}\n' +
'.log-console input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 14px;font-size:13px;color:var(--text);font-family:monospace;outline:none}\n' +
'.log-console input:focus{border-color:var(--green)}\n' +
'.log-console button{padding:9px 18px;background:#052e16;border:1px solid #16a34a;border-radius:8px;color:#22c55e;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit}\n' +
'.ai-wrap{display:flex;flex-direction:column;height:calc(100vh - 120px)}\n' +
'.ai-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:4px 2px;margin-bottom:16px}\n' +
'.ai-msg{display:flex;gap:10px;align-items:flex-start}\n' +
'.ai-msg.user{flex-direction:row-reverse}\n' +
'.ai-av{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}\n' +
'.ai-av.bot{background:linear-gradient(135deg,#1d4ed8,#7c3aed)}\n' +
'.ai-av.user{background:var(--surface2)}\n' +
'.ai-bubble{max-width:75%;padding:12px 16px;border-radius:14px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}\n' +
'.ai-bubble.bot{background:var(--surface);border:1px solid var(--border);border-top-left-radius:4px}\n' +
'.ai-bubble.user{background:#1d4ed8;color:#fff;border-top-right-radius:4px}\n' +
'.ai-bubble code{background:rgba(0,0,0,.35);padding:2px 6px;border-radius:4px;font-family:monospace;font-size:11px}\n' +
'.ai-bubble pre{background:rgba(0,0,0,.45);padding:10px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:11px;font-family:monospace;white-space:pre}\n' +
'.ai-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 10px;border-radius:99px;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:#4ade80;margin-top:6px}\n' +
'.ai-input-row{display:flex;gap:8px}\n' +
'.ai-textarea{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 18px;font-size:13px;color:var(--text);font-family:inherit;outline:none;resize:none;transition:border-color .2s;min-height:48px;max-height:120px}\n' +
'.ai-textarea:focus{border-color:var(--blue)}\n' +
'.ai-quick{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}\n' +
'.ai-quick-btn{padding:6px 12px;background:var(--surface);border:1px solid var(--border);border-radius:99px;font-size:11px;color:var(--muted);cursor:pointer;font-family:inherit;transition:all .2s}\n' +
'.ai-quick-btn:hover{background:var(--surface2);color:var(--text);border-color:var(--blue)}\n' +
'.typing{display:flex;gap:4px;padding:12px 16px}\n' +
'.typing span{width:7px;height:7px;background:var(--muted);border-radius:50%;animation:bounce .8s infinite}\n' +
'.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}\n' +
'@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}\n' +
'.empty{text-align:center;padding:24px;font-size:13px;color:var(--muted)}\n' +
'::-webkit-scrollbar{width:4px;height:4px}\n' +
'::-webkit-scrollbar-track{background:transparent}\n' +
'::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'\n' +
'<nav class="sidebar">\n' +
'  <div class="sidebar-brand">\n' +
'    <h1>⚿ ' + botName + '</h1>\n' +
'    <p>' + serverIp + '</p>\n' +
'  </div>\n' +
'  <button class="nav-item active" onclick="nav(\'dashboard\',this)"><span class="nav-icon">📊</span> Dashboard</button>\n' +
'  <button class="nav-item" onclick="nav(\'logs\',this)"><span class="nav-icon">📋</span> Logs</button>\n' +
'  <button class="nav-item" onclick="nav(\'ai\',this)"><span class="nav-icon">🤖</span> AI Helper</button>\n' +
'  <div class="sidebar-bottom">\n' +
'    <span class="side-dot offline" id="side-dot"></span>\n' +
'    <span class="side-status-text" id="side-txt">Offline</span>\n' +
'  </div>\n' +
'</nav>\n' +
'\n' +
'<main class="main">\n' +
'\n' +
'  <!-- DASHBOARD -->\n' +
'  <div class="page active" id="page-dashboard">\n' +
'    <div class="page-header"><h2>Dashboard</h2><p>Live bot status and controls</p></div>\n' +
'    <div class="hero offline" id="hero">\n' +
'      <div class="pulse offline" id="pulse">⚡</div>\n' +
'      <div>\n' +
'        <div class="hero-label offline" id="hero-label">Connecting...</div>\n' +
'        <div class="hero-detail" id="hero-detail">Establishing connection</div>\n' +
'      </div>\n' +
'      <div class="ping-badge" id="ping-badge">Ping: ---</div>\n' +
'    </div>\n' +
'    <div class="grid g3">\n' +
'      <div class="card"><div class="card-title">Uptime</div><div class="card-value" id="uptime-val">---</div><div class="card-sub">Since last connect</div></div>\n' +
'      <div class="card"><div class="card-title">Reconnects</div><div class="card-value" id="reconnect-val">0</div><div class="card-sub">Total attempts</div></div>\n' +
'      <div class="card"><div class="card-title">Position</div><div class="card-value" style="font-size:15px;margin-top:6px" id="coords-val">---</div><div class="card-sub">Current coords</div></div>\n' +
'    </div>\n' +
'    <div class="grid g2">\n' +
'      <div class="card">\n' +
'        <div class="card-title">Bot Vitals</div>\n' +
'        <div class="bar-row">\n' +
'          <div class="bar-label"><span>❤️ Health</span><span id="hp-txt">---</span></div>\n' +
'          <div class="bar-track"><div class="bar-fill bar-hp" id="hp-bar" style="width:0%"></div></div>\n' +
'        </div>\n' +
'        <div class="bar-row">\n' +
'          <div class="bar-label"><span>🍖 Food</span><span id="food-txt">---</span></div>\n' +
'          <div class="bar-track"><div class="bar-fill bar-food" id="food-bar" style="width:0%"></div></div>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="card">\n' +
'        <div class="card-title">Players Online</div>\n' +
'        <div class="player-list" id="player-list"><div class="empty">No players detected</div></div>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div class="card">\n' +
'      <div class="card-title">Hotbar Inventory</div>\n' +
'      <div class="inv-grid" id="inv-grid"></div>\n' +
'    </div>\n' +
'    <div class="card">\n' +
'      <div class="card-title">💬 In-Game Chat</div>\n' +
'      <div class="chat-box" id="chat-box"><div class="empty">No chat yet</div></div>\n' +
'      <div class="input-row">\n' +
'        <input class="txt-input" id="chat-input" type="text" placeholder="Send a message in-game..." maxlength="256">\n' +
'        <button class="btn btn-blue" onclick="sendChat()">Send</button>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div id="kick-section" style="display:none;margin-bottom:16px">\n' +
'      <div class="card-title" style="margin-bottom:8px">🧠 Last Kick Analysis</div>\n' +
'      <div class="kick-card" id="kick-card">\n' +
'        <div class="kick-header" id="kick-header"></div>\n' +
'        <div class="kick-tip" id="kick-tip"></div>\n' +
'      </div>\n' +
'    </div>\n' +
'    <div class="controls">\n' +
'      <button class="ctl-btn btn-start" id="btn-start" onclick="startBot()">▶ Start Bot</button>\n' +
'      <button class="ctl-btn btn-stop" id="btn-stop" onclick="stopBot()">■ Stop Bot</button>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- LOGS -->\n' +
'  <div class="page" id="page-logs">\n' +
'    <div class="page-header"><h2>Bot Logs</h2><p>Live output · auto-refreshes every 5s</p></div>\n' +
'    <div class="card" style="padding:16px">\n' +
'      <div class="log-body" id="log-body"><div class="empty">No logs yet</div></div>\n' +
'      <div class="log-console">\n' +
'        <input type="text" id="log-input" placeholder="Send command or message...">\n' +
'        <button onclick="sendLogCmd()">Send</button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- AI -->\n' +
'  <div class="page" id="page-ai">\n' +
'    <div class="page-header"><h2>AI Helper</h2><p>Powered by Claude via Puter.js — free, no API key needed</p></div>\n' +
'    <div class="ai-wrap">\n' +
'      <div class="ai-quick">\n' +
'        <button class="ai-quick-btn" onclick="quickAsk(\'What is the bot currently doing?\')">What\'s the bot doing?</button>\n' +
'        <button class="ai-quick-btn" onclick="quickAsk(\'Are there any errors in the logs?\')">Check for errors</button>\n' +
'        <button class="ai-quick-btn" onclick="quickAsk(\'Why did the bot get kicked?\')">Why kicked?</button>\n' +
'        <button class="ai-quick-btn" onclick="quickAsk(\'List all players online\')">Who\'s online?</button>\n' +
'      </div>\n' +
'      <div class="ai-msgs" id="ai-msgs">\n' +
'        <div class="ai-msg">\n' +
'          <div class="ai-av bot">🤖</div>\n' +
'          <div class="ai-bubble bot">\n' +
'            Hey! I can see your bot\'s live status, logs, and chat. Ask me anything — debugging, commands, or general questions.<br><br>\n' +
'            <strong>⚠️ IMPORTANT:</strong> Before using the AI, you need to login to Puter.js. After sending your first message, a login prompt will appear. Just login and select your account to use the AI features!\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="ai-input-row">\n' +
'        <textarea class="ai-textarea" id="ai-input" rows="1" placeholder="Ask anything... (Login prompt will appear on first message)"></textarea>\n' +
'        <button class="btn btn-blue" id="ai-send" onclick="sendAI()" style="border-radius:12px;padding:12px 20px;font-size:14px;font-weight:700">Send</button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'</main>\n' +
'\n' +
'<script>\n' +
'let aiResponseCount = 0;\n' +
'\n' +
'function esc(s){var d=document.createElement("div");d.textContent=String(s);return d.innerHTML;}\n' +
'function fmt(s){if(s<0)return "--";return Math.floor(s/3600)+"h "+Math.floor((s%3600)/60)+"m "+(s%60)+"s";}\n' +
'function post(url,body){return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json();});}\n' +
'\n' +
'function nav(page,el){\n' +
'  document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active");});\n' +
'  document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});\n' +
'  document.getElementById("page-"+page).classList.add("active");\n' +
'  if(el)el.classList.add("active");\n' +
'  if(page==="logs")refreshLogs();\n' +
'}\n' +
'\n' +
'function update(){\n' +
'  fetch("/health").then(function(r){return r.json();}).then(function(h){\n' +
'    var online=h.status==="connected";\n' +
'    document.getElementById("hero").className="hero "+(online?"online":"offline");\n' +
'    document.getElementById("pulse").className="pulse "+(online?"online":"offline");\n' +
'    document.getElementById("pulse").textContent=online?"⚡":"💤";\n' +
'    var hl=document.getElementById("hero-label");\n' +
'    hl.className="hero-label "+(online?"online":"offline");\n' +
'    hl.textContent=online?"Connected":"Disconnected";\n' +
'    document.getElementById("hero-detail").textContent=online?"Playing on "+h.serverIp+":"+h.serverPort:"Not connected to server";\n' +
'    document.getElementById("ping-badge").textContent="Ping: "+(h.ping!=null?h.ping+"ms":"—");\n' +
'    document.getElementById("side-dot").className="side-dot "+(online?"online":"offline");\n' +
'    document.getElementById("side-txt").textContent=online?"Online":"Offline";\n' +
'    document.getElementById("uptime-val").textContent=h.uptime>0?fmt(h.uptime):"—";\n' +
'    document.getElementById("reconnect-val").textContent=h.reconnectAttempts;\n' +
'    document.getElementById("coords-val").textContent=h.coords?h.coords.x.toFixed(1)+", "+h.coords.y.toFixed(1)+", "+h.coords.z.toFixed(1):"—";\n' +
'    var hp=h.health,food=h.food;\n' +
'    document.getElementById("hp-txt").textContent=hp!=null?hp+"/20":"—";\n' +
'    document.getElementById("hp-bar").style.width=hp!=null?(hp/20*100)+"%":"0%";\n' +
'    document.getElementById("food-txt").textContent=food!=null?food+"/20":"—";\n' +
'    document.getElementById("food-bar").style.width=food!=null?(food/20*100)+"%":"0%";\n' +
'    var pl=document.getElementById("player-list");\n' +
'    if(h.players&&h.players.length){\n' +
'      pl.innerHTML=h.players.map(function(p){\n' +
'        return \'<div class="player-item"><span class="player-dot"></span>\'+esc(p.username)+\'<span class="player-ping">\'+p.ping+\'ms</span></div>\';\n' +
'      }).join("");\n' +
'    }else{pl.innerHTML=\'<div class="empty">No players detected</div>\';}\n' +
'    var slots=Array(9).fill(null);\n' +
'    if(h.inventory)h.inventory.forEach(function(item){slots[item.slot]=item;});\n' +
'    document.getElementById("inv-grid").innerHTML=slots.map(function(item){\n' +
'      if(!item)return \'<div class="inv-slot"><span style="color:var(--border)">·</span></div>\';\n' +
'      return \'<div class="inv-slot"><span class="item-name">\'+esc(item.displayName)+\'</span><span class="item-count">\'+item.count+\'</span></div>\';\n' +
'    }).join("");\n' +
'    if(h.lastKickAnalysis){\n' +
'      var k=h.lastKickAnalysis;\n' +
'      document.getElementById("kick-section").style.display="block";\n' +
'      document.getElementById("kick-card").style.cssText="border-color:"+k.color+";background:"+k.color+"11";\n' +
'      document.getElementById("kick-header").innerHTML=k.icon+\' <span style="color:\'+k.color+\'">\'+esc(k.label)+\'</span>\';\n' +
'      document.getElementById("kick-tip").textContent=k.tip;\n' +
'    }else{document.getElementById("kick-section").style.display="none";}\n' +
'    document.getElementById("btn-start").disabled=!!h.botRunning;\n' +
'    document.getElementById("btn-stop").disabled=!h.botRunning;\n' +
'  }).catch(function(){});\n' +
'  fetch("/chat-history").then(function(r){return r.json();}).then(function(chat){\n' +
'    var box=document.getElementById("chat-box");\n' +
'    if(!chat.length){box.innerHTML=\'<div class="empty">No chat yet</div>\';return;}\n' +
'    box.innerHTML=chat.map(function(c){\n' +
'      var t=new Date(c.time);\n' +
'      var ts=String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0");\n' +
'      return \'<div class="chat-msg"><span class="chat-time">\'+ts+\'</span><span class="chat-user">\'+esc(c.username)+\'</span>\'+esc(c.message)+\'</div>\';\n' +
'    }).join("");\n' +
'    box.scrollTop=box.scrollHeight;\n' +
'  }).catch(function(){});\n' +
'}\n' +
'\n' +
'function refreshLogs(){\n' +
'  fetch("/logs-json").then(function(r){return r.json();}).then(function(logs){\n' +
'    var body=document.getElementById("log-body");\n' +
'    if(!logs.length){body.innerHTML=\'<div class="empty">No logs yet</div>\';return;}\n' +
'    body.innerHTML=logs.map(function(l){\n' +
'      var text=typeof l==="string"?l:(l.message||String(l));\n' +
'      var cls="default";\n' +
'      if(text.includes("[FATAL]")||text.includes("Error:"))cls="error";\n' +
'      else if(text.includes("[KickAnalyzer]")||text.includes("Reconnecting"))cls="warn";\n' +
'      else if(text.includes("Spawned")||text.includes("started"))cls="success";\n' +
'      else if(text.includes("[Control]")||text.includes("[Console]"))cls="control";\n' +
'      return \'<span class="log-entry \'+cls+\'">\'+esc(text)+\'</span>\';\n' +
'    }).join("");\n' +
'    body.scrollTop=body.scrollHeight;\n' +
'  }).catch(function(){});\n' +
'}\n' +
'\n' +
'function sendChat(){\n' +
'  var inp=document.getElementById("chat-input");\n' +
'  var msg=inp.value.trim();if(!msg)return;\n' +
'  inp.value="";\n' +
'  post("/command",{command:msg});\n' +
'}\n' +
'document.getElementById("chat-input").addEventListener("keydown",function(e){if(e.key==="Enter")sendChat();});\n' +
'\n' +
'function sendLogCmd(){\n' +
'  var inp=document.getElementById("log-input");\n' +
'  var msg=inp.value.trim();if(!msg)return;\n' +
'  inp.value="";\n' +
'  post("/command",{command:msg});\n' +
'}\n' +
'document.getElementById("log-input").addEventListener("keydown",function(e){if(e.key==="Enter")sendLogCmd();});\n' +
'\n' +
'function startBot(){\n' +
'  document.getElementById("btn-start").disabled=true;\n' +
'  post("/start").then(function(){setTimeout(update,1500);}).catch(function(){\n' +
'    document.getElementById("btn-start").disabled=false;\n' +
'  });\n' +
'}\n' +
'function stopBot(){\n' +
'  document.getElementById("btn-stop").disabled=true;\n' +
'  post("/stop").then(function(){setTimeout(update,500);}).catch(function(){\n' +
'    document.getElementById("btn-stop").disabled=false;\n' +
'  });\n' +
'}\n' +
'\n' +
'var aiHistory=[];\n' +
'\n' +
'function quickAsk(text){document.getElementById("ai-input").value=text;sendAI();}\n' +
'\n' +
'function appendMsg(role,html,action){\n' +
'  var msgs=document.getElementById("ai-msgs");\n' +
'  var wrap=document.createElement("div");wrap.className="ai-msg "+role;\n' +
'  var av=document.createElement("div");av.className="ai-av "+(role==="user"?"user":"bot");\n' +
'  av.textContent=role==="user"?"👤":"🤖";\n' +
'  var bubble=document.createElement("div");bubble.className="ai-bubble "+(role==="user"?"user":"bot");\n' +
'  bubble.innerHTML=html;\n' +
'  if(action&&action.type==="command"){\n' +
'    var pill=document.createElement("div");pill.className="ai-pill";\n' +
'    pill.textContent="⚡ Ran: "+action.cmd;bubble.appendChild(pill);\n' +
'  }\n' +
'  wrap.appendChild(av);wrap.appendChild(bubble);msgs.appendChild(wrap);\n' +
'  msgs.scrollTop=msgs.scrollHeight;\n' +
'}\n' +
'\n' +
'function fmtAI(text){\n' +
'  text = String(text || "");\n' +
'  return text\n' +
'    .replace(/&/g,"&amp;")\n' +
'    .replace(/</g,"&lt;")\n' +
'    .replace(/>/g,"&gt;")\n' +
'    .replace(/```([\\s\\S]*?)```/g,"<pre>$1</pre>")\n' +
'    .replace(/`([^`\\n]+)`/g,"<code>$1</code>")\n' +
'    .replace(/\\*\\*(.*?)\\*\\*/g,"<strong>$1</strong>")\n' +
'    .replace(/\\n/g,"<br>");\n' +
'}\n' +
'\n' +
'function showTyping(){\n' +
'  var msgs=document.getElementById("ai-msgs");\n' +
'  var d=document.createElement("div");d.className="ai-msg";d.id="ai-typing";\n' +
'  d.innerHTML=\'<div class="ai-av bot">🤖</div><div class="ai-bubble bot"><div class="typing"><span></span><span></span><span></span></div></div>\';\n' +
'  msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;\n' +
'}\n' +
'function hideTyping(){var el=document.getElementById("ai-typing");if(el)el.remove();}\n' +
'\n' +
'async function sendAI(){\n' +
'  var inp=document.getElementById("ai-input");\n' +
'  var text=inp.value.trim();if(!text)return;\n' +
'  inp.value="";inp.style.height="auto";\n' +
'  document.getElementById("ai-send").disabled=true;\n' +
'  appendMsg("user",fmtAI(text));\n' +
'  var ctx="";\n' +
'  try{\n' +
'    var h=await fetch("/health").then(function(r){return r.json();});\n' +
'    var logs=await fetch("/logs-json").then(function(r){return r.json();});\n' +
'    var chat=await fetch("/chat-history").then(function(r){return r.json();});\n' +
'    ctx="BOT STATUS: connected="+h.status+", uptime="+h.uptime+"s, server="+h.serverIp+":"+h.serverPort+\n' +
'      ", ping="+(h.ping||"N/A")+"ms, health="+(h.health||"N/A")+"/20, food="+(h.food||"N/A")+"/20"+\n' +
'      ", reconnects="+h.reconnectAttempts+\n' +
'      ", players="+(h.players&&h.players.length?h.players.map(function(p){return p.username;}).join(", "):"none")+\n' +
'      ", lastKick="+(h.lastKickAnalysis?h.lastKickAnalysis.label+": "+h.lastKickAnalysis.tip:"none")+\n' +
'      "\\n\\nRECENT LOGS:\\n"+logs.slice(-60).join("\\n")+\n' +
'      "\\n\\nIN-GAME CHAT:\\n"+(chat.slice(-10).map(function(c){return "<"+c.username+"> "+c.message;}).join("\\n")||"none");\n' +
'  }catch(e){}\n' +
'  var sysPrompt="You are an AI assistant inside a Minecraft AFK bot dashboard. Expert in Node.js, mineflayer, Minecraft servers.\\n\\n"+ctx+\n' +
'    "\\n\\nIf the user wants to run a bot command, include EXACTLY at the END:\\n__ACTION__{\\"type\\":\\"command\\",\\"cmd\\":\\"/the-command\\"}__END__\\n\\nBe concise. Format code in markdown.";\n' +
'  var fullPrompt=sysPrompt+"\\n\\n"+\n' +
'    aiHistory.map(function(m){return (m.role==="user"?"User: ":"Assistant: ")+m.parts[0].text;}).join("\\n")+\n' +
'    "\\n\\nUser: "+text+"\\nAssistant:";\n' +
'  showTyping();\n' +
'  try{\n' +
'    var response=await puter.ai.chat(fullPrompt,{model:"claude-sonnet-4-5",stream:false});\n' +
'    hideTyping();\n' +
'    var reply=typeof response==="string"?response:\n' +
'      (response&&response.message&&response.message.content&&response.message.content[0]&&response.message.content[0].text)||\n' +
'      (response&&response.text)||String(response);\n' +
'    \n' +
'    aiResponseCount++;\n' +
'    if(aiResponseCount === 1 || aiResponseCount % 8 === 0) {\n' +
'      reply = reply + "\\n\\n📢 Subscribe to @ropsey on YouTube! 🎮✨";\n' +
'    }\n' +
'    \n' +
'    var action=null;\n' +
'    var match=reply.match(/__ACTION__(.+?)__END__/s);\n' +
'    if(match){\n' +
'      try{\n' +
'        action=JSON.parse(match[1]);\n' +
'        reply=reply.replace(/__ACTION__.+?__END__/s,"").trim();\n' +
'        if(action.type==="command")await post("/command",{command:action.cmd});\n' +
'      }catch(e){}\n' +
'    }\n' +
'    aiHistory.push({role:"user",parts:[{text:text}]});\n' +
'    aiHistory.push({role:"model",parts:[{text:reply}]});\n' +
'    if(aiHistory.length>20)aiHistory=aiHistory.slice(-20);\n' +
'    appendMsg("bot",fmtAI(reply),action);\n' +
'  }catch(e){\n' +
'    hideTyping();\n' +
'    appendMsg("bot","❌ <strong>Error:</strong> "+esc(e.message));\n' +
'  }\n' +
'  document.getElementById("ai-send").disabled=false;\n' +
'}\n' +
'\n' +
'var aiTa=document.getElementById("ai-input");\n' +
'aiTa.addEventListener("input",function(){this.style.height="auto";this.style.height=Math.min(this.scrollHeight,120)+"px";});\n' +
'aiTa.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAI();}});\n' +
'\n' +
'(function(){\n' +
'  var g=document.getElementById("inv-grid");\n' +
'  g.innerHTML=Array(9).fill(\'<div class="inv-slot"><span style="color:var(--border)">·</span></div>\').join("");\n' +
'})();\n' +
'\n' +
'setInterval(update,4000);\n' +
'setInterval(function(){\n' +
'  if(document.getElementById("page-logs").classList.contains("active"))refreshLogs();\n' +
'},5000);\n' +
'update();\n' +
'</script>\n' +
'</body>\n' +
'</html>';

  res.send(html);
});

// ── SERVER ───────────────────────────────────────────────────
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    addLog(`[Server] Port ${PORT} in use, trying ${PORT + 1}`);
    server.listen(PORT + 1, "0.0.0.0");
  } else {
    addLog(`[Server] Error: ${err.message}`);
  }
});

function formatUptime(s){return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m '+(s%60)+'s';}

// ── IMPROVED SELF-PING FOR RAILWAY & RENDER (24/7 OPERATION) ──
function startSelfPing(){
  // Platform detection - works on Railway AND Render
  let url = null;
  
  // Check for Railway (modern)
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    url = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    addLog(`[KeepAlive] Railway detected: ${url}`);
  }
  // Check for Railway (legacy)
  else if (process.env.RAILWAY_STATIC_URL) {
    url = process.env.RAILWAY_STATIC_URL;
    if (!url.startsWith("http")) url = `https://${url}`;
    addLog(`[KeepAlive] Railway (legacy) detected: ${url}`);
  }
  // Check for Render
  else if (process.env.RENDER_EXTERNAL_URL) {
    url = process.env.RENDER_EXTERNAL_URL;
    addLog(`[KeepAlive] Render detected: ${url}`);
  }
  // Check for Replit
  else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    url = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
    addLog(`[KeepAlive] Replit detected: ${url}`);
  }
  // Fallback: try to detect from PORT (local development)
  else if (process.env.PORT) {
    addLog("[KeepAlive] ⚠️ No platform URL detected - running in local mode");
    addLog("[KeepAlive] Self-ping disabled (not needed for local development)");
    return;
  }
  
  if(!url) {
    addLog("[KeepAlive] ❌ Could not detect platform URL!");
    addLog("[KeepAlive] For 24/7 operation, set one of these environment variables:");
    addLog("[KeepAlive]   - RAILWAY_PUBLIC_DOMAIN (Railway)");
    addLog("[KeepAlive]   - RENDER_EXTERNAL_URL (Render)");
    addLog("[KeepAlive] Or use UptimeRobot (free) to ping your bot URL");
    return;
  }
  
  // Clean the URL
  url = url.replace(/\/$/, '');
  addLog(`[KeepAlive] ✅ Self-ping enabled for: ${url}`);
  addLog(`[KeepAlive] ⏰ Pinging every 4 minutes to prevent sleeping`);
  
  // Ping every 4 minutes (Render/Railway free tiers sleep after 15-30 min)
  setInterval(() => {
    const pingUrl = `${url}/ping`;
    const protocol = pingUrl.startsWith("https") ? https : http;
    
    protocol.get(pingUrl, (res) => {
      // Only log errors, not successes (to keep logs clean)
      if (res.statusCode !== 200) {
        addLog(`[KeepAlive] ⚠️ Ping returned ${res.statusCode}`);
      }
    }).on("error", (e) => {
      addLog(`[KeepAlive] ❌ Ping failed: ${e.message}`);
    });
  }, 4 * 60 * 1000); // Every 4 minutes
}

// Start self-ping (will auto-detect Railway or Render)
startSelfPing();

// Memory monitoring
setInterval(() => {
  const memUsed = process.memoryUsage().heapUsed / 1024 / 1024;
  addLog(`[Memory] Heap: ${memUsed.toFixed(2)} MB`);
  
  // Warning if memory is high (prevent crashes)
  if (memUsed > 500) {
    addLog(`[Memory] ⚠️ High memory usage: ${memUsed.toFixed(2)} MB`);
  }
}, 5 * 60 * 1000);

function clearBotTimeouts(){
  if(reconnectTimeoutId){clearTimeout(reconnectTimeoutId);reconnectTimeoutId=null;}
  if(connectionTimeoutId){clearTimeout(connectionTimeoutId);connectionTimeoutId=null;}
}
function clearAllIntervals(){activeIntervals.forEach(id=>clearInterval(id));activeIntervals=[];}
function addInterval(cb,delay){const id=setInterval(cb,delay);activeIntervals.push(id);return id;}

const KICK_REASONS={
  PROXY_DUPLICATE:"already connected to this proxy",
  THROTTLE_KEYWORDS:["throttl","wait before reconnect","too fast"],
};

function getReconnectDelay(){
  const r=(lastKickReason||"").toLowerCase();
  if(r.includes(KICK_REASONS.PROXY_DUPLICATE))return 65000+Math.floor(Math.random()*15000);
  if(lastKickReason==="")return 30000+Math.floor(Math.random()*10000);
  if(botState.wasThrottled||KICK_REASONS.THROTTLE_KEYWORDS.some(k=>r.includes(k))){
    botState.wasThrottled=false;return 60000+Math.floor(Math.random()*60000);
  }
  const base=config.utils["auto-reconnect-delay"]||3000;
  const max=config.utils["max-reconnect-delay"]||30000;
  return Math.min(base*Math.pow(2,botState.reconnectAttempts),max)+Math.floor(Math.random()*2000);
}

function createBot(){
  if(!botRunning)return;
  if(isReconnecting){addLog("[Bot] Already reconnecting...");return;}
  if(bot){
    clearAllIntervals();
    try{bot.removeAllListeners();bot.end();}catch(_){}
    bot=null;
  }
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);
  try{
    const ver=config.server.version?.trim()!==""?config.server.version:false;
    bot=mineflayer.createBot({
      username:config["bot-account"].username,
      password:config["bot-account"].password||undefined,
      auth:config["bot-account"].type,
      host:config.server.ip,
      port:config.server.port,
      version:ver,
      hideErrors:false,
      keepAlive:false,
      checkTimeoutInterval:600000,
    });
    bot._client.on("keep_alive",packet=>{
      try{bot._client.write("keep_alive",{keepAliveId:packet.keepAliveId});}catch(_){}
    });
    bot.loadPlugin(pathfinder);
    clearBotTimeouts();
    connectionTimeoutId=setTimeout(()=>{
      if(!botState.connected){
        addLog("[Bot] Connection timeout 150s");
        try{bot.removeAllListeners();bot.end();}catch(_){}
        bot=null;scheduleReconnect();
      }
    },150000);
    let spawnHandled=false;
    bot.once("spawn",()=>{
      if(spawnHandled)return;
      spawnHandled=true;lastKickReason=null;clearBotTimeouts();
      botState.connected=true;botState.lastActivity=Date.now();
      botState.reconnectAttempts=0;botState.lastKickAnalysis=null;
      isReconnecting=false;
      addLog(`[Bot] [+] Spawned! Version: ${bot.version}`);
      startTelemetry(bot,config.server.ip);
      const mcData=require("minecraft-data")(bot.version);
      const defaultMove=new Movements(bot,mcData);
      defaultMove.allowFreeMotion=false;defaultMove.canDig=false;
      defaultMove.liquidCost=1000;defaultMove.fallDamageCost=1000;
      addInterval(()=>{if(bot&&botState.connected)botState.ping=bot.player?.ping??null;},5000);
      bot.on("health",()=>{botState.health=bot.health;botState.food=bot.food;});
      bot.on("chat",(username,message)=>{if(username!==bot.username)addChat(username,message);});
      initializeModules(bot,mcData,defaultMove);
      setTimeout(()=>{
        if(bot&&botState.connected&&config.server["try-creative"])safeBotChat("/gamemode creative");
      },3000);
    });
    bot.on("kicked",reason=>{
      const kr=typeof reason==="object"?JSON.stringify(reason):String(reason||"");
      addLog(`[Bot] Kicked: ${kr}`);
      botState.connected=false;clearAllIntervals();
      let kt=kr;try{kt=JSON.parse(kr).text||kr;}catch(_){}
      lastKickReason=kt;
      botState.lastKickAnalysis=analyzeKickReason(kt);
      addLog(`[KickAnalyzer] ${botState.lastKickAnalysis.label}: ${botState.lastKickAnalysis.tip}`);
      addReconnectEvent(kt,"kicked");
      if(KICK_REASONS.THROTTLE_KEYWORDS.some(k=>kt.toLowerCase().includes(k)))botState.wasThrottled=true;
    });
    bot.on("end",reason=>{
      addLog(`[Bot] Disconnected: ${reason||"Unknown"}`);
      botState.connected=false;clearAllIntervals();spawnHandled=false;
      addReconnectEvent(reason||"Unknown","disconnect");
      if(botRunning)scheduleReconnect();
    });
    bot.on("error",err=>{
      const msg=err?.message||String(err);
      addLog(`[Bot] Error: ${msg}`);
      botState.errors.push({type:"error",message:msg,time:Date.now()});
    });
  }catch(err){
    addLog(`[Bot] Failed: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(){
  if(!botRunning)return;
  clearBotTimeouts();
  if(isReconnecting)return;
  isReconnecting=true;botState.reconnectAttempts++;
  const delay=getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimeoutId=setTimeout(()=>{
    reconnectTimeoutId=null;isReconnecting=false;lastKickReason=null;createBot();
  },delay);
}

function initializeModules(bot,mcData,defaultMove){
  addLog("[Modules] Initializing...");
  if(config.utils["auto-auth"]?.enabled){
    const pw=config.utils["auto-auth"].password;let authHandled=false;
    const tryAuth=type=>{
      if(authHandled||!bot||!botState.connected)return;authHandled=true;
      if(type==="register"){safeBotChat(`/register ${pw} ${pw}`);addLog("[Auth] /register sent");}
      else{safeBotChat(`/login ${pw}`);addLog("[Auth] /login sent");}
    };
    bot.on("messagestr",msg=>{
      if(authHandled)return;const m=msg.toLowerCase();
      if(m.includes("/register")||m.includes("register "))tryAuth("register");
      else if(m.includes("/login")||m.includes("login "))tryAuth("login");
    });
    setTimeout(()=>{if(!authHandled&&bot&&botState.connected){safeBotChat(`/login ${pw}`);authHandled=true;}},10000);
  }
  if(config.utils["chat-messages"]?.enabled){
    const messages=config.utils["chat-messages"].messages;
    if(config.utils["chat-messages"].repeat){
      let i=0;
      addInterval(()=>{
        if(bot&&botState.connected){safeBotChat(messages[i]);botState.lastActivity=Date.now();i=(i+1)%messages.length;}
      },config.utils["chat-messages"]["repeat-delay"]*1000);
    }else{
      messages.forEach((msg,idx)=>setTimeout(()=>{if(bot&&botState.connected)safeBotChat(msg);},idx*1500));
    }
  }
  const cw=config.movement?.["circle-walk"]?.enabled;
  if(config.position?.enabled&&!cw){
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x,config.position.y,config.position.z));
  }
  if(config.utils["anti-afk"]?.enabled){
    addInterval(()=>{if(!bot||!botState.connected)return;try{bot.swingArm();}catch(_){}},15000+Math.floor(Math.random()*15000));
    addInterval(()=>{if(!bot||!botState.connected)return;try{bot.setQuickBarSlot(Math.floor(Math.random()*9));}catch(_){}},20000+Math.floor(Math.random()*20000));
    addInterval(()=>{
      if(!bot||!botState.connected)return;
      try{bot.look(Math.random()*Math.PI*2,(Math.random()-.5)*.5,true);botState.lastActivity=Date.now();}catch(_){}
    },10000+Math.floor(Math.random()*10000));
    if(!cw){
      addInterval(()=>{
        if(!bot||!botState.connected||typeof bot.setControlState!=="function")return;
        try{
          bot.look(Math.random()*Math.PI*2,0,true);bot.setControlState("forward",true);
          setTimeout(()=>{if(bot&&typeof bot.setControlState==="function")bot.setControlState("forward",false);},400+Math.floor(Math.random()*600));
          botState.lastActivity=Date.now();
        }catch(e){addLog(`[AntiAFK] ${e.message}`);}
      },45000+Math.floor(Math.random()*45000));
    }
    addInterval(()=>{
      if(!bot||!botState.connected||typeof bot.setControlState!=="function")return;
      try{
        bot.setControlState("jump",true);
        setTimeout(()=>{if(bot&&typeof bot.setControlState==="function")bot.setControlState("jump",false);},300);
        botState.lastActivity=Date.now();
      }catch(e){}
    },60000+Math.floor(Math.random()*60000));
    if(config.utils["anti-afk"].sneak){
      try{if(typeof bot.setControlState==="function")bot.setControlState("sneak",true);}catch(_){}
    }
  }
  addLog("[Modules] All initialized!");
}

const readline=require("readline");
const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});
rl.on("line",line=>{
  if(!bot||!botState.connected){addLog("[Console] Bot not connected");return;}
  const t=line.trim();
  if(t.startsWith("say "))safeBotChat(t.slice(4));
  else if(t.startsWith("cmd "))safeBotChat("/"+t.slice(4));
  else if(t==="status")addLog(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now()-botState.startTime)/1000))}`);
  else safeBotChat(t);
});

process.on("uncaughtException",err=>{
  const msg=err?.message||String(err)||"Unknown";
  try{addLog(`[FATAL] ${msg}`);}catch(_){}
  const isNet=["PartialReadError","ECONNRESET","EPIPE","ETIMEDOUT","timed out","write after end"].some(k=>msg.includes(k));
  try{clearAllIntervals();}catch(_){}
  try{botState.connected=false;}catch(_){}
  try{
    if(isReconnecting){isReconnecting=false;if(reconnectTimeoutId){clearTimeout(reconnectTimeoutId);reconnectTimeoutId=null;}}
  }catch(_){}
  setTimeout(()=>{try{scheduleReconnect();}catch(e){}},isNet?5000:10000);
});

process.on("unhandledRejection",reason=>{
  const msg=String(reason);
  addLog(`[FATAL] Rejection: ${msg}`);
  const isNet=["ETIMEDOUT","ECONNRESET","EPIPE","ENOTFOUND","timed out","PartialReadError"].some(k=>msg.includes(k));
  if(isNet&&!isReconnecting){
    clearAllIntervals();botState.connected=false;
    if(bot){try{bot.end();}catch(_){}bot=null;}
    scheduleReconnect();
  }
});

process.on("SIGTERM",()=>addLog("[System] SIGTERM — ignoring."));
process.on("SIGINT",()=>addLog("[System] SIGINT — ignoring."));

addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v3.0");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version||"auto-detect"}`);
addLog("=".repeat(50));

createBot();
