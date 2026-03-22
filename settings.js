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

  $("primaryPath").textContent = settings.primaryDir || "—";
  $("archivePath").textContent = settings.archiveDir || "—";
  $("cloudPath").textContent   = settings.cloudDir   || "—";

  $("saveToArchive").checked = !!settings.saveToArchive;
  $("cloudEnabled").checked  = !!settings.cloudEnabled;
  $("startOnLogin").checked  = !!settings.startOnLogin;
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
    btn.textContent  = "Stop Collector";
    btn.className    = "btn btn-danger";
  } else {
    dot.classList.remove("running");
    text.textContent = "stopped";
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
    settings[storeKey]           = chosen;
    $(displayId).textContent = chosen;
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
    saveToArchive: $("saveToArchive").checked,
    cloudEnabled:  $("cloudEnabled").checked,
    startOnLogin:  $("startOnLogin").checked,
    serverPort:    validPort,
    authToken:     $("authToken").value.trim(),
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

// ─── Wire up ──────────────────────────────────────────────────────────────────
$("pickPrimary").addEventListener("click", () => pickDir("primaryDir", "primaryPath"));
$("pickArchive").addEventListener("click", () => pickDir("archiveDir", "archivePath"));
$("pickCloud").addEventListener("click",   () => pickDir("cloudDir",   "cloudPath"));

$("cloudEnabled").addEventListener("change", toggleCloudRow);

$("toggleServerBtn").addEventListener("click", async () => {
  $("toggleServerBtn").disabled = true;
  // Bug fix #10 — use returned state to update UI correctly
  const nowRunning = await window.api.toggleServer();
  $("toggleServerBtn").disabled = false;
  await loadStatus();
});

$("saveBtn").addEventListener("click", saveSettings);
$("cancelBtn").addEventListener("click", () => window.close());

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
loadStatus();

// Bug fix — clear interval on window close to avoid orphaned timers
statusInterval = setInterval(loadStatus, 5000);
window.addEventListener("beforeunload", () => {
  clearInterval(statusInterval);
});
