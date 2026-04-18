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
'        
