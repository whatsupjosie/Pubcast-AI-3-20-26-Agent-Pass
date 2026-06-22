"use strict";

const $ = (id) => document.getElementById(id);

function validatePort(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return 8765;
  return n;
}

async function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get({ serverPort: 8765 }, resolve)
  );
}

async function pingServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/collect`, {
      method: "OPTIONS",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

// Bug fix #9 — don't close popup until we confirm the content script received the message
async function sendToTab(target) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab found.", false);
    return;
  }

  // Bug fix #8 — handle sendMessage errors in popup too
  chrome.tabs.sendMessage(tab.id, { type: "COLLECT_AND_SEND", target }, (response) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || "";
      // Content script not loaded — inject on demand then retry
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["content.js"] },
        () => {
          if (chrome.runtime.lastError) {
            setStatus("Cannot inject on this page.", false);
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { type: "COLLECT_AND_SEND", target });
            window.close();
          }, 300);
        }
      );
      return;
    }
    // Success — close popup
    window.close();
  });
}

function setStatus(text, isRunning) {
  $("dot").className          = "dot" + (isRunning ? " on" : "");
  $("statusLine").textContent = text;
}

async function init() {
  const settings = await getSettings();
  const port     = validatePort(settings.serverPort);

  $("portLabel").textContent = `port ${port}`;

  const alive = await pingServer(port);
  setStatus(
    alive
      ? "Collector is running"
      : "Collector not running — check the tray app",
    alive
  );

  // Disable save buttons if collector isn't running
  if (!alive) {
    for (const id of ["savePrimary", "saveArchive", "saveBoth", "saveCloud"]) {
      const btn = $(id);
      btn.disabled = true;
      btn.style.opacity = "0.4";
      btn.style.cursor  = "not-allowed";
    }
    return;
  }

  $("savePrimary").addEventListener("click", () => sendToTab("primary"));
  $("saveArchive").addEventListener("click", () => sendToTab("archive"));
  $("saveBoth").addEventListener("click",    () => sendToTab("both"));
  $("saveCloud").addEventListener("click",   () => sendToTab("cloud"));

  // Bug fix #17 — openOptionsPage actually works now that options_ui is in manifest
  $("openSettings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
