"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const { execFile } = require("child_process");
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require("electron");
const Store = require("electron-store");

// CPU limiter state
const CPU_LIMIT_PERCENT = 70;

// Store instance - moved to top after imports
const store = new Store({
  defaults: {
    primaryDir:      path.join(app.getPath("documents"), "CodeCollector", "primary"),
    secondaryDir:    "",
    archiveDir:      path.join(app.getPath("documents"), "CodeCollector", "archive"),
    cloudDir:        "",
    cloudEnabled:    false,
    authToken:       "",
    serverPort:      8765,
    startOnLogin:    false,
    saveToArchive:   true,
    cpuLimiterEnabled: true,
  },
});

function getAppCpuUsage() {
  const usage = process.cpuUsage();
  const total = usage.user + usage.system;
  const elapsed = process.uptime() * 1000000; // microseconds
  return (total / elapsed) * 100; // percentage
}

function isCpuLimiterEnabled() {
  return store.get("cpuLimiterEnabled", true); // default true
}

function checkCpuLimit() {
  if (process.env.NO_CPU_LIMIT === '1') return;
  if (!isCpuLimiterEnabled()) return;
  const usage = getAppCpuUsage();
  if (usage > CPU_LIMIT_PERCENT) {
    throw new Error(`CPU usage too high (${usage.toFixed(1)}%). Limit is ${CPU_LIMIT_PERCENT}%. Wait for usage to drop or disable CPU limiter in settings.`);
  }
}

async function throttleForCpu() {
  if (!isCpuLimiterEnabled()) return;
  const usage = getAppCpuUsage();
  if (usage > CPU_LIMIT_PERCENT) {
    // Wait 1 second to let CPU cool down
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let tray           = null;
let settingsWindow = null;
let server         = null;
let serverRunning  = false;
let captureCount   = 0;
let serverRetryCount = 0;
const MAX_SERVER_RETRIES = 3;

const ASSETS   = path.join(__dirname, "assets");
const iconPath = (on) => path.join(ASSETS, on ? "icon-active.png" : "icon-inactive.png");

// ─── Settings ─────────────────────────────────────────────────────────────────
// Store initialization moved to top

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

// ─── Code file scanner helpers ───────────────────────────────────────────────
function isLikelyCodeLine(line) {
  const trimmed = (line || "").trim();
  if (!trimmed) return false;

  const codeTokens = [
    "function", "def", "class", "import", "from", "const", "let", "var", "if", "else", "for", "while", "return", "=>", "#include", "package", "pub", "fn", "console.log"
  ];
  if (codeTokens.some((token) => trimmed.includes(token))) return true;

  const symbols = (trimmed.match(/[{};=<>()[\]\\]/g) || []).length;
  if (symbols >= 2) return true;

  if (/^\s{2,}/.test(line) && trimmed.length > 20) return true;

  return false;
}

function extractCodeBlocksFromText(text) {
  if (typeof text !== "string") return [];

  const blocks = [];
  const lines  = text.split(/\r?\n/);

  let fenced = false;
  let fenceLang = "";
  let current = [];

  const flushCurrent = () => {
    const joined = current.join("\n").trim();
    if (joined.length >= 10) {
      blocks.push({ language: fenceLang || "unknown", content: joined });
    }
    current = [];
    fenceLang = "";
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```\s*(\w*)/);
    if (fenceMatch) {
      if (fenced) {
        flushCurrent();
        fenced = false;
      } else {
        fenced = true;
        fenceLang = fenceMatch[1] || "unknown";
        current = [];
      }
      continue;
    }

    if (fenced) {
      current.push(line);
      continue;
    }

    if (isLikelyCodeLine(line)) {
      current.push(line);
      continue;
    }

    // non-code boundary
    if (current.length) {
      flushCurrent();
    }
  }

  if (current.length) flushCurrent();

  // Deduplicate similar blocks
  return blocks
    .map((b) => ({ language: b.language, content: b.content.trim() }))
    .filter((b) => b.content.length > 0);
}

function isSafePath(filePath) {
  if (process.env.TEST_MODE === "1") return true;
  const absPath = path.resolve(filePath);
  const homeDir = app.getPath("home");
  const docsDir = app.getPath("documents");
  const downloadsDir = app.getPath("downloads");

  // Allow only user-controlled directories: home, documents, downloads, and subdirs
  const allowedBases = [homeDir, docsDir, downloadsDir].map(p => path.resolve(p));
  const isInAllowed = allowedBases.some(base => absPath.startsWith(base + path.sep) || absPath === base);

  if (!isInAllowed) {
    throw new Error("Path not allowed: only user directories (home, documents, downloads) are permitted.");
  }

  // Reject system files and sensitive paths
  const forbidden = ["/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/sys", "/proc", "/dev"];
  if (forbidden.some(f => absPath.startsWith(f))) {
    throw new Error("Path not allowed: system directories are forbidden.");
  }

  return true;
}

function isTextFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);

    // Check for null bytes (binary indicator)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return false;
    }

    // Check for high ratio of non-printable chars
    let nonPrintable = 0;
    for (let i = 0; i < bytesRead; i++) {
      const c = buffer[i];
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) nonPrintable++; // tab, lf, cr ok
    }
    if (nonPrintable > bytesRead * 0.3) return false;

    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

function sanitizeCodeOutput(code) {
  // Strip any potential HTML/JS tags or scripts
  return (code || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .trim();
}

function scanFileForCode(filePath) {
  checkCpuLimit();

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("File not found");
  }

  isSafePath(filePath);

  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error("Not a regular file");
  }

  if (!isTextFile(filePath)) {
    throw new Error("File appears to be binary or non-text; only text files are allowed.");
  }

  if (stats.size > 10 * 1024 * 1024) {
    throw new Error("File too large (max 10 MB)");
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read file: ${err.message}`);
  }

  const blocks = extractCodeBlocksFromText(raw)
    .map((b) => ({ language: b.language, content: sanitizeCodeOutput(b.content) }));

  const warning = stats.size > 2 * 1024 * 1024
    ? `Large file: ${(stats.size / (1024 * 1024)).toFixed(2)} MB (scan may be slow).`
    : "";

  return {
    filePath,
    detected: blocks.length > 0,
    count: blocks.length,
    warning,
    blocks,
  };
}

async function scanFolderForCode(folderPath, maxFiles = 500) {
  checkCpuLimit();

  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error("Folder not found");
  }

  isSafePath(folderPath);

  const stats = fs.statSync(folderPath);
  if (!stats.isDirectory()) {
    throw new Error("Not a directory");
  }

  const supportedExt = new Set(["txt","md","json","js","ts","py","java","cpp","c","h","go","rs","sh","html","css","yaml","yml"]);
  const results = [];
  let count = 0;

  async function walk(dir) {
    if (count >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const ext = entry.name.split('.').pop().toLowerCase();
      if (!supportedExt.has(ext)) continue;

      count++;
      try {
        isSafePath(fullPath);
        const entryStats = fs.statSync(fullPath);
        if (entryStats.size > 10 * 1024 * 1024) {
          results.push({ filePath: fullPath, skipped: true, reason: "Exceeds max file size (10 MB)" });
          continue;
        }
        if (!isTextFile(fullPath)) {
          results.push({ filePath: fullPath, skipped: true, reason: "Appears to be binary or non-text" });
          continue;
        }
        const fileResult = scanFileForCode(fullPath);
        results.push(fileResult);

        // Throttle to prevent CPU overload between files
        await throttleForCpu();
      } catch (err) {
        // Handle CPU limit errors specially
        if (err.message && err.message.includes('CPU usage too high')) {
          results.push({ filePath: fullPath, skipped: true, reason: "CPU limit reached - scan paused", errorType: "cpu_limit" });
          // Don't continue scanning more files to prevent further CPU issues
          break;
        } else {
          results.push({ filePath: fullPath, error: err.message, errorType: "scan_error" });
        }
      }
    }
  }

  await walk(folderPath);

  return {
    folderPath,
    scanned: count,
    maxFiles,
    results,
    warning: count >= maxFiles ? `Reached max file scan limit (${maxFiles}); some files may not be scanned.` : "",
  };
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
  try { hostname = new URL(payload.source_url || "").hostname; } catch (err) { /* ignore invalid URL */ }
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
  const target       = payload.target || "primary";
  const primaryDir   = store.get("primaryDir");
  const secondaryDir = store.get("secondaryDir");
  const archiveDir   = store.get("archiveDir");
  const cloudDir     = store.get("cloudDir");
  const saved        = {};

  const writeTo = (key, dir) => {
    if (dir) { try { saved[key] = writePayload(dir, payload); } catch (e) { console.error(`Failed to write ${key}:`, e.message); } }
  };

  if (!primaryDir) {
    console.warn("primaryDir is not configured; using app documents path");
    writeTo("primary", path.join(app.getPath("documents"), "CodeCollector", "primary"));
  } else if (target === "primary" || target === "both") {
    writeTo("primary", primaryDir);
  }

  // Secondary location gets an unconditional mirror copy if set
  if (secondaryDir) {
    writeTo("secondary", secondaryDir);
  }

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

      let saved_to;
      try {
        saved_to = routePayload(payload);
        captureCount++;
        updateTrayMenu();
      } catch (err) {
        console.error("Failed to save payload:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to save payload", details: err.message }));
        return;
      }

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
    serverRetryCount = 0; // Reset retry count on successful start
    updateTrayIcon(true);
    updateTrayMenu();
  });
  server.on("error", (err) => {
    console.error("Server error:", err.message);
    serverRunning = false;
    updateTrayIcon(false);
    updateTrayMenu();

    // Only auto-restart for recoverable errors and within retry limit
    const recoverableErrors = ["EMFILE", "ENFILE", "ENOMEM", "ENOBUFS"];
    if (recoverableErrors.includes(err.code) && serverRetryCount < MAX_SERVER_RETRIES) {
      serverRetryCount++;
      const delay = Math.min(1000 * Math.pow(2, serverRetryCount), 30000); // Exponential backoff, max 30s
      console.log(`Attempting server restart ${serverRetryCount}/${MAX_SERVER_RETRIES} in ${delay/1000}s…`);
      setTimeout(startServer, delay);
    } else if (err.code === "EADDRINUSE") {
      console.error(`Port ${store.get("serverPort")} is in use. Change the port in settings.`);
    } else {
      console.error(`Server failed to start after ${MAX_SERVER_RETRIES} attempts. Check system resources and settings.`);
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
  try { tray.setImage(nativeImage.createFromPath(iconPath(on))); } catch (err) { console.debug("Tray image load error", err.message); }
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

let serverRestartTimeout = null;
ipcMain.handle("save-settings", (_e, updated) => {
  const oldPort = store.get("serverPort");
  const portChanged = updated.serverPort && updated.serverPort !== oldPort;

  // Clear any pending restart
  if (serverRestartTimeout) {
    clearTimeout(serverRestartTimeout);
    serverRestartTimeout = null;
  }

  Object.entries(updated).forEach(([k, v]) => store.set(k, v));

  if (portChanged) {
    stopServer();
    // Delay restart to ensure port is fully released
    serverRestartTimeout = setTimeout(() => {
      serverRestartTimeout = null;
      startServer();
    }, 1000);
  }

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

ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(settingsWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Text/Code files", extensions: ["txt", "md", "json", "js", "ts", "py", "java", "cpp", "c", "h", "go", "rs", "sh", "html", "css", "yaml", "yml"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : (r.filePaths[0] || null);
});

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(settingsWindow, {
    properties: ["openDirectory"],
  });
  return r.canceled ? null : (r.filePaths[0] || null);
});

ipcMain.handle("scan-file", async (_e, filePath) => {
  try {
    return scanFileForCode(filePath);
  } catch (err) {
    return { error: err.message, errorType: "scan_error" };
  }
});

ipcMain.handle("scan-folder", async (_e, folderPath) => {
  try {
    return await scanFolderForCode(folderPath);
  } catch (err) {
    return { error: err.message, errorType: "scan_error" };
  }
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
  scanFileForCode,
  scanFolderForCode,
  buildSmartFilename,
  routePayload,
  isTextFile,
};
