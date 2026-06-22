"use strict";

const $ = (id) => document.getElementById(id);

let settings      = {};
let statusInterval = null;

// Bug fix #7 — proper port range validation
function validatePort(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return null;
  return n;
}

async function loadSettings() {
  settings = await window.api.getSettings();

  $("primaryPath").textContent   = settings.primaryDir || "—";
  $("secondaryPath").textContent = settings.secondaryDir || "—";
  $("archivePath").textContent   = settings.archiveDir || "—";
  $("cloudPath").textContent      = settings.cloudDir   || "—";

  $("saveToArchive").checked = !!settings.saveToArchive;
  $("cloudEnabled").checked  = !!settings.cloudEnabled;
  $("startOnLogin").checked  = !!settings.startOnLogin;
  $("cpuLimiterEnabled").checked = settings.cpuLimiterEnabled !== false; // default true
  $("serverPort").value      = settings.serverPort || 8765;
  $("authToken").value       = settings.authToken  || "";

  toggleCloudRow();
}

async function loadStatus() {
  const status = await window.api.getServerStatus();
  const dot    = $("statusDot");
  const text   = $("serverStatusText");
  const btn    = $("toggleServerBtn");

  if (status.running) {
    dot.classList.add("running");
    text.textContent = `running · :${status.port} · ${status.captureCount} captured`;
    text.className = "server-status status-indicator running";
    btn.textContent  = "Stop Collector";
    btn.className    = "btn btn-danger";
  } else {
    dot.classList.remove("running");
    text.textContent = "stopped";
    text.className = "server-status status-indicator stopped";
    btn.textContent  = "Start Collector";
    btn.className    = "btn btn-ghost";
  }
}

function toggleCloudRow() {
  $("cloudDirRow").classList.toggle("visible", $("cloudEnabled").checked);
}

async function pickDir(storeKey, displayId) {
  const chosen = await window.api.pickDirectory(storeKey);
  if (chosen) {
    settings[storeKey] = chosen;
    $(displayId).textContent = chosen;
  }
}

async function renderScanResult(info) {
  if (!info) {
    $("scanOutput").value = "No result.";
    return;
  }

  if (info.error) {
    $("scanOutput").value = `Error: ${info.error}`;
    return;
  }

  let text = "";
  if (info.folderPath) {
    text += `Folder scanned: ${info.folderPath}\nFiles considered: ${info.scanned} (max ${info.maxFiles})\n`;
    if (info.warning) text += `Warning: ${info.warning}\n`;
    text += "\n";
    for (const item of info.results || []) {
      if (item.skipped) {
        text += `- SKIPPED ${item.filePath}: ${item.reason}\n`;
      } else if (item.error) {
        text += `- ERROR ${item.filePath}: ${item.error}\n`;
      } else if (item.detected && item.count > 0) {
        text += `- ${item.filePath}: ${item.count} blocks${item.warning ? ' (' + item.warning + ')' : ''}\n`;
      }
    }
    $("scanOutput").value = text;
    return;
  }

  // Single file result
  text += `File scanned: ${info.filePath}\n`;
  if (info.warning) text += `Warning: ${info.warning}\n`;
  if (info.error) {
    text += `Error: ${info.error}\n`;
  } else if (!info.detected) {
    text += "No code blocks detected.";
  } else {
    text += `Found ${info.count} block${info.count !== 1 ? "s" : ""}.\n\n`;
    text += (info.blocks || []).map((block, idx) => `--- Block #${idx + 1} [${block.language || 'unknown'}] ---\n${block.content}`).join("\n\n");
  }
  $("scanOutput").value = text;
}

async function scanFileAndShow() {
  const btn = $("scanFileBtn");
  const originalText = btn.innerHTML;

  try {
    const filePath = await window.api.pickFile();
    if (!filePath) {
      return;
    }

    // Start activity
    playSound('scan-start');
    showActivityPanel('reading', `Reading file: ${filePath.split('/').pop()}`, 10);
    showDirectionalFlow('processing', 'Reading');

    btn.innerHTML = '<span>Scanning...</span>';
    btn.classList.add('loading');

    $("scanOutput").value = `Scanning ${filePath} ...`;

    // Update progress
    showActivityPanel('processing', `Analyzing code patterns...`, 50);
    showDirectionalFlow('processing', 'Processing');

    const result = await window.api.scanFile(filePath);

    // Complete
    showActivityPanel('success', `Scan complete`, 100);
    showDirectionalFlow('download', 'Complete');
    playSound('scan-complete');

    await renderScanResult(result);

    // Auto-hide after success
    setTimeout(() => {
      hideActivityPanel();
    }, 2000);

  } catch (error) {
    showActivityPanel('error', `Scan failed: ${error.message}`, 0);
    playSound('error');
    $("scanOutput").value = `Error: ${error.message}`;

    setTimeout(() => {
      hideActivityPanel();
    }, 3000);
  } finally {
    btn.innerHTML = originalText;
    btn.classList.remove('loading');
  }
}

async function scanFolderAndShow() {
  const btn = $("scanFolderBtn");
  const originalText = btn.innerHTML;

  try {
    const folderPath = await window.api.pickFolder();
    if (!folderPath) {
      return;
    }

    // Start activity
    playSound('scan-start');
    showActivityPanel('reading', `Scanning folder: ${folderPath.split('/').pop()}`, 5);
    showDirectionalFlow('processing', 'Scanning');

    btn.innerHTML = '<span>Scanning...</span>';
    btn.classList.add('loading');

    $("scanOutput").value = `Scanning folder ${folderPath} ...`;

    // Update progress
    showActivityPanel('processing', `Discovering files...`, 25);

    const result = await window.api.scanFolder(folderPath);

    if (result) {
      // Show results
      showActivityPanel('success', `Found ${result.results?.length || 0} files`, 100);
      showDirectionalFlow('download', 'Complete');
      playSound('scan-complete');

      await renderScanResult(result);

      setTimeout(() => {
        hideActivityPanel();
      }, 3000);
    }

  } catch (error) {
    if (error.errorType === 'cpu_limit') {
      // CPU throttling
      showActivityPanel('throttling', 'CPU usage too high - throttling', 0);
      showDirectionalFlow('processing', 'Throttling');
      playSound('throttling');

      setTimeout(() => {
        hideActivityPanel();
      }, 2000);
    } else {
      // General error
      showActivityPanel('error', `Scan failed: ${error.message || error}`, 0);
      playSound('error');
    }

    $("scanOutput").value = `Error: ${error.message || error}`;

    setTimeout(() => {
      hideActivityPanel();
    }, 3000);
  } finally {
    btn.innerHTML = originalText;
    btn.classList.remove('loading');
  }
}

function showSaveMsg(text = "Saved.", isError = false) {
  const msg = $("saveMsg");
  msg.textContent = text;
  msg.style.color = isError ? "#c0392b" : "#27ae60";
  msg.classList.add("visible");
  setTimeout(() => msg.classList.remove("visible"), 2500);
}

async function saveSettings() {
  // Bug fix #7 — validate port before saving
  const rawPort    = $("serverPort").value;
  const validPort  = validatePort(rawPort);
  if (validPort === null) {
    showSaveMsg(`Port must be 1024–65535`, true);
    $("serverPort").focus();
    return;
  }

  const updated = {
    ...settings,
    saveToArchive:  $("saveToArchive").checked,
    cloudEnabled:   $("cloudEnabled").checked,
    startOnLogin:   $("startOnLogin").checked,
    cpuLimiterEnabled: $("cpuLimiterEnabled").checked,
    serverPort:     validPort,
    authToken:      $("authToken").value.trim(),
    secondaryDir:   settings.secondaryDir || "",
  };

  const result = await window.api.saveSettings(updated);
  if (result?.ok) {
    settings = updated;
    showSaveMsg("Saved.");
    setTimeout(loadStatus, 800); // give server time to restart if port changed
  } else {
    showSaveMsg("Save failed.", true);
  }
}

// Activity and sound management
let activityStartTime = null;
let activityTimer = null;
let soundEnabled = true;
let currentAudioContext = null;

// Audio context for sound generation
function initAudioContext() {
  if (!currentAudioContext) {
    currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return currentAudioContext;
}

// Generate different sounds for different activities
function playSound(type) {
  if (!soundEnabled) return;

  const audioContext = initAudioContext();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  switch (type) {
    case 'scan-start':
      // Rising tone for scan start
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.2);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
      break;

    case 'scan-complete':
      // Pleasant chime for completion
      oscillator.frequency.setValueAtTime(523, audioContext.currentTime); // C5
      oscillator.frequency.setValueAtTime(659, audioContext.currentTime + 0.1); // E5
      oscillator.frequency.setValueAtTime(784, audioContext.currentTime + 0.2); // G5
      gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
      break;

    case 'error':
      // Descending tone for errors
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(220, audioContext.currentTime + 0.3);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
      break;

    case 'throttling':
      // Warning beep pattern
      setTimeout(() => {
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.1);
      }, 0);

      setTimeout(() => {
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.1);
      }, 150);
      break;
  }
}

// Activity panel management
function showActivityPanel(state, message, progress = 0) {
  const panel = $('activityPanel');
  const icon = $('statusIcon');
  const details = $('activityDetails');
  const progressBar = $('progressBar');

  // Update content
  details.textContent = message;
  progressBar.style.width = `${progress}%`;

  // Update icon and state
  icon.className = 'status-icon';
  switch (state) {
    case 'reading':
      icon.classList.add('reading');
      icon.textContent = '📖';
      break;
    case 'processing':
      icon.classList.add('processing');
      icon.textContent = '⚙️';
      break;
    case 'throttling':
      icon.classList.add('throttling');
      icon.textContent = '⚠️';
      break;
    case 'success':
      icon.classList.add('success');
      icon.textContent = '✅';
      break;
    case 'error':
      icon.classList.add('error');
      icon.textContent = '❌';
      break;
    default:
      icon.textContent = '⏸️';
  }

  // Show panel
  panel.classList.add('visible');

  // Start timer if not already running
  if (!activityStartTime) {
    activityStartTime = Date.now();
    updateActivityTimer();
    activityTimer = setInterval(updateActivityTimer, 1000);
  }
}

function hideActivityPanel() {
  const panel = $('activityPanel');
  panel.classList.remove('visible');

  // Clear timer
  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }
  activityStartTime = null;
  $('activityTimer').textContent = '--:--';
}

function updateActivityTimer() {
  if (!activityStartTime) return;

  const elapsed = Math.floor((Date.now() - activityStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  $('activityTimer').textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Directional flow indicators
function showDirectionalFlow(type, label) {
  const flow = $('directionalFlow');
  const flowLabel = $('flowLabel');
  const flowArrow = $('flowArrow');

  flowLabel.textContent = label;
  flowArrow.className = 'flow-arrow';

  switch (type) {
    case 'upload':
      flowArrow.classList.add('upload');
      break;
    case 'download':
      flowArrow.classList.add('download');
      break;
    case 'processing':
      flowArrow.style.animation = 'flowPulse 1s ease-in-out infinite';
      break;
  }

  flow.classList.add('visible');

  // Auto-hide after 3 seconds
  setTimeout(() => {
    flow.classList.remove('visible');
  }, 3000);
}

// Sound toggle
function toggleSound() {
  soundEnabled = !soundEnabled;
  const toggle = $('soundToggle');
  toggle.classList.toggle('muted', !soundEnabled);

  // Save preference
  localStorage.setItem('soundEnabled', soundEnabled);
}

// Load sound preference
function loadSoundPreference() {
  const saved = localStorage.getItem('soundEnabled');
  soundEnabled = saved !== null ? JSON.parse(saved) : true;
  $('soundToggle').classList.toggle('muted', !soundEnabled);
}

// ─── Wire up ──────────────────────────────────────────────────────────────────
$("pickPrimary").addEventListener("click", () => pickDir("primaryDir", "primaryPath"));
$("pickSecondary").addEventListener("click", () => pickDir("secondaryDir", "secondaryPath"));
$("pickArchive").addEventListener("click", () => pickDir("archiveDir", "archivePath"));
$("pickCloud").addEventListener("click",   () => pickDir("cloudDir",   "cloudPath"));

$("cloudEnabled").addEventListener("change", toggleCloudRow);

$("toggleServerBtn").addEventListener("click", async () => {
  $("toggleServerBtn").disabled = true;
  await window.api.toggleServer();
  $("toggleServerBtn").disabled = false;
  await loadStatus();
});

$("saveBtn").addEventListener("click", saveSettings);
$("cancelBtn").addEventListener("click", () => window.close());
$("scanFileBtn").addEventListener("click", scanFileAndShow);
$("scanFolderBtn").addEventListener("click", scanFolderAndShow);

// Activity panel controls
$("soundToggle").addEventListener("click", toggleSound);
$("activityClose").addEventListener("click", hideActivityPanel);

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
loadStatus();
loadSoundPreference();

// Bug fix — clear interval on window close to avoid orphaned timers
statusInterval = setInterval(loadStatus, 5000);
window.addEventListener("beforeunload", () => {
  clearInterval(statusInterval);
});
