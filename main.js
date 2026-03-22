"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require("electron");
const path  = require("path");
const fs    = require("fs");
const http  = require("http");
const Store = require("electron-store");

// ─── Settings ─────────────────────────────────────────────────────────────────
const store = new Store({
  defaults: {
    primaryDir:    path.join(app.getPath("documents"), "CodeCollector", "primary"),
    archiveDir:    path.join(app.getPath("documents"), "CodeCollector", "archive"),
    cloudDir:      "",
    cloudEnabled:  false,
    authToken:     "",
    serverPort:    8765,
    startOnLogin:  false,
    saveToArchive: true,
  },
});

// ─── State ────────────────────────────────────────────────────────────────────
let tray           = null;
let settingsWindow = null;
let server         = null;
let serverRunning  = false;
let captureCount   = 0;

const ASSETS   = path.join(__dirname, "assets");
const iconPath = (on) => path.join(ASSETS, on ? "icon-active.png" : "icon-inactive.png");

// ─── Filesystem helpers ───────────────────────────────────────────────────────
function ensureDir(dir) {
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function dateSlug() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function safeSegment(text, maxLen = 40) {
  return (text || "")
    .replace(/[^a-zA-Z0-9\-_.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLen) || "untitled";
}

/**
 * Build a smart filename from payload metadata.
 *
 * Format: {site-title}__{date}__{purpose}__{NNN}.json
 *
 * Examples:
 *   claude-ai__2026-03-14__function-routePayload__001.json
 *   chatgpt__2026-03-14__main-py__001.json
 *   claude-ai__2026-03-14__snippet__001.json
 */
function buildSmartFilename(payload, index = 1) {
  const date  = dateSlug();

  // Site name from source_title or URL
  const rawTitle = (payload.source_title || "")
    .replace(/\s*[-|–]\s*claude\.ai.*/i, "")
    .replace(/\s*[-|–]\s*ChatGPT.*/i, "")
    .trim();
  let hostname = "unknown";
  try { hostname = new URL(payload.source_url || "").hostname; } catch {}
  const siteSlug = safeSegment(rawTitle || hostname, 30);

  // Purpose: prefer detected_filename, then purpose_hint from first block, then entity name
  let purposeSlug = "";
  const firstBlock = (payload.blocks || [])[0];
  if (firstBlock) {
    const detected = firstBlock.detected_filename;
    const hint     = firstBlock.purpose_hint;
    const entity   = firstBlock.entity_names?.[0];
    const lang     = firstBlock.language || "snippet";

    if (detected) {
      purposeSlug = safeSegment(detected.replace(/\.[^.]+$/, ""), 36); // strip extension
    } else if (hint) {
      purposeSlug = safeSegment(hint.split(/\s+/).slice(0, 5).join("-"), 36);
    } else if (entity) {
      purposeSlug = safeSegment(`${firstBlock.code_type || lang}-${entity}`, 36);
    } else {
      purposeSlug = safeSegment(lang, 20);
    }
  }

  const seq = String(index).padStart(3, "0");
  const parts = [siteSlug, date, purposeSlug || "capture", seq].filter(Boolean);
  return `${parts.join("__")}.json`;
}

// ─── Counter per output dir (to keep sequence numbers unique) ─────────────────
const _seqCounters = {};
function nextSeq(dir) {
  _seqCounters[dir] = (_seqCounters[dir] || 0) + 1;
  return _seqCounters[dir];
}

function writePayload(dir, payload) {
  ensureDir(dir);
  const filename = buildSmartFilename(payload, nextSeq(dir));
  const outPath  = path.join(dir, filename);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  return outPath;
}

// ─── Routing ──────────────────────────────────────────────────────────────────
function routePayload(payload) {
  const target     = payload.target || "primary";
  const primaryDir = store.get("primaryDir");
  const archiveDir = store.get("archiveDir");
  const cloudDir   = store.get("cloudDir");
  const saved      = {};

  const writeTo = (key, dir) => {
    if (dir) { try { saved[key] = writePayload(dir, payload); } catch (e) { console.error(`Failed to write ${key}:`, e.message); } }
  };

  if (target === "primary" || target === "both")
    writeTo("primary", primaryDir);

  if (target === "archive" || target === "both" || (target === "primary" && store.get("saveToArchive")))
    writeTo("archive", archiveDir);

  if ((target === "cloud" || target === "both") && store.get("cloudEnabled") && cloudDir)
    writeTo("cloud", cloudDir);

  return saved;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function createServer() {
  return http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.method !== "POST" || req.url !== "/collect") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Auth guard
    const token = store.get("authToken");
    if (token && req.headers["x-auth-token"] !== token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!payload || !Array.isArray(payload.blocks)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload missing blocks array" }));
        return;
      }

      const saved_to = routePayload(payload);
      captureCount++;
      updateTrayMenu();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", blocks: payload.blocks.length, saved_to }));
    });
  });
}

function startServer() {
  if (serverRunning) return;
  server = createServer();
  server.listen(store.get("serverPort"), "127.0.0.1", () => {
    serverRunning = true;
    updateTrayIcon(true);
    updateTrayMenu();
  });
  server.on("error", (err) => {
    console.error("Server error:", err.message);
    serverRunning = false;
    updateTrayIcon(false);
    updateTrayMenu();
    // Auto-restart after 3s unless it's a port conflict
    if (err.code !== "EADDRINUSE") {
      console.log("Attempting server restart in 3s…");
      setTimeout(startServer, 3000);
    } else {
      console.error(`Port ${store.get("serverPort")} is in use. Change the port in Settings.`);
    }
  });
}

function stopServer() {
  if (!server || !serverRunning) return;
  server.close(() => { serverRunning = false; updateTrayIcon(false); updateTrayMenu(); });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function updateTrayIcon(on) {
  if (!tray) return;
  try { tray.setImage(nativeImage.createFromPath(iconPath(on))); } catch {}
  tray.setToolTip(on ? `Code Collector — running · ${captureCount} captured` : "Code Collector — stopped");
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: serverRunning ? "🟢  Collector running" : "🔴  Collector stopped", enabled: false },
    { label: `${captureCount} capture${captureCount !== 1 ? "s" : ""} this session`, enabled: false },
    { type: "separator" },
    { label: serverRunning ? "Stop Collector" : "Start Collector",
      click: () => serverRunning ? stopServer() : startServer() },
    { type: "separator" },
    { label: "Open Primary Folder", click: () => shell.openPath(store.get("primaryDir")) },
    { label: "Open Archive Folder", click: () => shell.openPath(store.get("archiveDir")) },
    { type: "separator" },
    { label: "Settings…", click: openSettings },
    { type: "separator" },
    { label: "Quit Code Collector", click: () => app.quit() },
  ]));
}

// ─── Settings window ──────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 580, height: 680, resizable: false,
    title: "Code Collector — Settings",
    backgroundColor: "#0d0d0d",
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle("get-settings",      () => store.store);
ipcMain.handle("get-server-status", () => ({ running: serverRunning, port: store.get("serverPort"), captureCount }));
ipcMain.handle("toggle-server",     () => { serverRunning ? stopServer() : startServer(); });

ipcMain.handle("save-settings", (_e, updated) => {
  const oldPort = store.get("serverPort");
  Object.entries(updated).forEach(([k, v]) => store.set(k, v));
  if (updated.serverPort && updated.serverPort !== oldPort) { stopServer(); setTimeout(startServer, 600); }
  app.setLoginItemSettings({ openAtLogin: !!store.get("startOnLogin") });
  return { ok: true };
});

ipcMain.handle("pick-directory", async (_e, key) => {
  const r = await dialog.showOpenDialog(settingsWindow, {
    properties:  ["openDirectory", "createDirectory"],
    defaultPath: store.get(key) || app.getPath("documents"),
  });
  return r.canceled ? null : (r.filePaths[0] || null);
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock.hide();
  tray = new Tray(nativeImage.createFromPath(iconPath(false)));
  updateTrayMenu();
  startServer();
  app.setLoginItemSettings({ openAtLogin: !!store.get("startOnLogin") });
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", stopServer);

// [RVF] session-endpoints
/**
 * session_endpoints.js
 * ════════════════════
 * Add these endpoints to main.js (your Electron HTTP server).
 *
 * Three new routes:
 *
 *   POST /collect-conversation
 *     Receives raw turns from claude_scraper.js (via sendBeacon on unload).
 *     Runs the Python conversation extractor.
 *     Stores the session summary in the index.
 *
 *   GET /context/session?platform=claude
 *     Returns the most recent session summary for the given platform.
 *     Called by background.js when a new Claude tab opens.
 *     Response: { context: "WHAT WAS BUILT\n  • ...\n\nDECISIONS..." }
 *
 *   GET /context/session/all
 *     Returns all stored session summaries (for the UI / history view).
 *
 * HOW TO ADD TO main.js:
 *   1. Copy the SESSION INDEX section into module scope (near your other state)
 *   2. Copy the three route handlers into your request router
 *   3. Copy the _runConversationExtractor helper into module scope
 *   4. Make sure `spawn` or `execFile` from child_process is imported
 *
 * Rear View Foresight LLC — Feic Mo Chroí
 */

"use strict";

// ══════════════════════════════════════════════════════════════════════════════
// SESSION INDEX — paste into module scope in main.js
// ══════════════════════════════════════════════════════════════════════════════

// In-memory session index — survives as long as the tray app runs.
// Tier 2 replaces this with SQLite. Same interface.
const _sessionIndex = new Map();   // session_id → SessionRecord
const _latestByPlatform = new Map(); // platform → session_id

/**
 * @typedef {Object} SessionRecord
 * @property {string}   session_id
 * @property {string}   platform
 * @property {string}   source_url
 * @property {string}   source_title
 * @property {number}   captured_at   — unix timestamp
 * @property {string}   context       — the formatted context block text
 * @property {string[]} files_touched
 * @property {number}   turn_count
 */


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /collect-conversation
// ══════════════════════════════════════════════════════════════════════════════

async function handleCollectConversation(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const {
    session_id,
    platform     = "claude",
    source_url   = "",
    source_title = "Claude",
    turns        = [],
  } = payload;

  if (!turns.length) {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, skipped: "no turns" }));
    return;
  }

  try {
    // Run the Python extractor to produce the summary
    const summary = await _runConversationExtractor({
      session_id,
      platform,
      source_url,
      source_title,
      turns,
    });

    // Store in index
    const record = {
      session_id:   summary.session_id,
      platform:     summary.platform,
      source_url:   summary.source_url,
      source_title: summary.source_title,
      captured_at:  Date.now() / 1000,
      context:      summary.context,
      files_touched: summary.files_touched || [],
      turn_count:   summary.turn_count || turns.length,
    };

    _sessionIndex.set(session_id, record);
    _latestByPlatform.set(platform, session_id);

    console.log(
      `[session] stored ${session_id} (${platform}) — ` +
      `${turns.length} turns, ${record.files_touched.length} files`
    );

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, session_id }));

  } catch (err) {
    console.error("[session] extractor failed:", err.message);
    // Store a minimal record even if extractor fails
    _sessionIndex.set(session_id, {
      session_id,
      platform,
      source_url,
      source_title,
      captured_at: Date.now() / 1000,
      context:     `Session captured — ${turns.length} turns\nSource: ${source_url}`,
      files_touched: [],
      turn_count:  turns.length,
    });
    _latestByPlatform.set(platform, session_id);

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, session_id, warning: "extractor failed, minimal record stored" }));
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /context/session
// ══════════════════════════════════════════════════════════════════════════════

function handleGetSessionContext(req, res, urlParams) {
  const platform = urlParams.get("platform") || "claude";
  const sessionId = _latestByPlatform.get(platform);

  if (!sessionId) {
    res.writeHead(200);
    res.end(JSON.stringify({ context: null, message: "no prior session" }));
    return;
  }

  const record = _sessionIndex.get(sessionId);
  if (!record) {
    res.writeHead(200);
    res.end(JSON.stringify({ context: null, message: "session not found" }));
    return;
  }

  // Don't surface context older than 7 days
  const ageHours = (Date.now() / 1000 - record.captured_at) / 3600;
  if (ageHours > 168) {
    res.writeHead(200);
    res.end(JSON.stringify({ context: null, message: "session too old" }));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({
    context:      record.context,
    session_id:   record.session_id,
    source_url:   record.source_url,
    captured_at:  record.captured_at,
    files_touched: record.files_touched,
    age_hours:    Math.round(ageHours * 10) / 10,
  }));
}


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /context/session/all
// ══════════════════════════════════════════════════════════════════════════════

function handleGetAllSessions(req, res) {
  const sessions = Array.from(_sessionIndex.values())
    .sort((a, b) => b.captured_at - a.captured_at)
    .map((r) => ({
      session_id:   r.session_id,
      platform:     r.platform,
      source_url:   r.source_url,
      source_title: r.source_title,
      captured_at:  r.captured_at,
      files_touched: r.files_touched,
      turn_count:   r.turn_count,
      context_preview: r.context.slice(0, 200),
    }));

  res.writeHead(200);
  res.end(JSON.stringify({ sessions, total: sessions.length }));
}


// ══════════════════════════════════════════════════════════════════════════════
// HELPER: _runConversationExtractor
// Calls extractors/conversation.py as a subprocess
// ══════════════════════════════════════════════════════════════════════════════


function _runConversationExtractor(payload) {
  return new Promise((resolve, reject) => {
    // Path to the extractor script — adjust to match your project layout
    const scriptPath = path.join(__dirname, "extractors", "conversation_server.py");
    const input = JSON.stringify(payload);

    const proc = execFile(
      "python3",
      [scriptPath],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`extractor error: ${err.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`extractor bad JSON: ${stdout.slice(0, 200)}`));
        }
      }
    );

    // Send payload via stdin
    proc.stdin.write(input);
    proc.stdin.end();
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// WIRE INTO YOUR ROUTER — paste into your existing request handler
// ══════════════════════════════════════════════════════════════════════════════
//
// In your main.js request handler (the function passed to http.createServer),
// add these cases:
//
//   if (req.method === "POST" && req.url === "/collect-conversation") {
//     return handleCollectConversation(req, res, body);
//   }
//
//   if (req.method === "GET" && req.url.startsWith("/context/session/all")) {
//     return handleGetAllSessions(req, res);
//   }
//
//   if (req.method === "GET" && req.url.startsWith("/context/session")) {
//     const urlParams = new URLSearchParams(req.url.split("?")[1] || "");
//     return handleGetSessionContext(req, res, urlParams);
//   }
//
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  handleCollectConversation,
  handleGetSessionContext,
  handleGetAllSessions,
};
