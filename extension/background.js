"use strict";

// ─── Context menu builder ─────────────────────────────────────────────────────
// Bug fix #16 — called on both onInstalled AND onStartup so menus survive reloads
function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn("contextMenus.removeAll error:", chrome.runtime.lastError.message);
    }

    const items = [
      { id: "cc-root",         title: "Code Collector",                     contexts: ["page", "selection"] },
      { id: "cc-save-primary", title: "Save all code → Primary folder",     contexts: ["page", "selection"], parentId: "cc-root" },
      { id: "cc-save-archive", title: "Save all code → Archive folder",     contexts: ["page", "selection"], parentId: "cc-root" },
      { id: "cc-save-both",    title: "Save all code → Both folders",       contexts: ["page", "selection"], parentId: "cc-root" },
      { id: "cc-sep",          type: "separator",                            contexts: ["page", "selection"], parentId: "cc-root" },
      { id: "cc-save-cloud",   title: "Save all code → Cloud folder",       contexts: ["page", "selection"], parentId: "cc-root" },
    ];

    for (const item of items) {
      chrome.contextMenus.create(item, () => {
        if (chrome.runtime.lastError) {
          // Swallow duplicate-ID errors that can happen during rapid reloads
          const msg = chrome.runtime.lastError.message || "";
          if (!msg.includes("duplicate")) {
            console.warn("contextMenus.create error:", msg);
          }
        }
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(buildContextMenus);
chrome.runtime.onStartup.addListener(buildContextMenus); // bug fix #16

// ─── Context menu click handler ───────────────────────────────────────────────
const TARGET_MAP = {
  "cc-save-primary": "primary",
  "cc-save-archive": "archive",
  "cc-save-both":    "both",
  "cc-save-cloud":   "cloud",
};

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = TARGET_MAP[info.menuItemId];
  if (!target || !tab?.id) return;

  // Bug fix #8 — handle sendMessage failure (content script not ready)
  chrome.tabs.sendMessage(tab.id, { type: "COLLECT_AND_SEND", target }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("sendMessage to content script failed:", chrome.runtime.lastError.message);
      // Inject the content script on-demand and retry once
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["content.js"] },
        () => {
          if (chrome.runtime.lastError) return; // tab not injectable (chrome:// etc.)
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { type: "COLLECT_AND_SEND", target });
          }, 300);
        }
      );
    }
  });
});

// ─── Message relay: content script → server ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "POST_PAYLOAD") return false;

  const { payload, target } = msg;

  getSettings().then((settings) => {
    const port  = validatePort(settings.serverPort);
    const token = settings.authToken || "";

    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Auth-Token"] = token;

    payload.target = target;

    fetch(`http://127.0.0.1:${port}/collect`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(payload),
    })
      .then(async (r) => {
        // Bug fix #8 — check both HTTP status and parse errors
        if (!r.ok) {
          let detail = `Server returned ${r.status}`;
          try {
            const j = await r.json();
            if (j.error) detail = j.error;
          } catch { /* non-JSON error body */ }
          throw new Error(detail);
        }
        const json = await r.json();
        sendResponse({ ok: true, result: json });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
  });

  return true; // keep channel open for async sendResponse
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function validatePort(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return 8765;
  return n;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ serverPort: 8765, authToken: "" }, resolve);
  });
}

// [RVF] session-handlers
/**
 * background_session_patch.js
 * ════════════════════════════
 * Add these message handlers to background.js.
 *
 * Handles two new message types from claude_scraper.js:
 *
 *   CONVERSATION_CAPTURE — relay turns to /collect-conversation
 *   FETCH_LAST_SESSION   — fetch prior context from /context/session
 *
 * Also handles new Claude tab detection:
 *   When a tab navigates to claude.ai/chat/new (or fresh chat),
 *   proactively fetch last session and tell the content script.
 *
 * HOW TO ADD TO background.js:
 *   1. Find your existing chrome.runtime.onMessage.addListener block
 *   2. Add the two new cases from _handleSessionMessage below
 *   3. Add the tab listener from _watchClaudeTabs below
 *   4. Make sure SERVER_PORT matches your existing port constant
 *
 * Rear View Foresight LLC — Feic Mo Chroí
 */

"use strict";

const SERVER_PORT = 8765; // match your existing port constant

// ── Message handler additions ─────────────────────────────────────────────────
//
// Add these cases inside your existing onMessage listener:
//
//   chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//
//     ... your existing cases ...
//
//     // ── NEW: Conversation capture ────────────────────────────────────────
//     if (message.type === "CONVERSATION_CAPTURE") {
//       _relayConversationCapture(message).then(sendResponse);
//       return true; // keep channel open for async response
//     }
//
//     // ── NEW: Fetch last session ──────────────────────────────────────────
//     if (message.type === "FETCH_LAST_SESSION") {
//       _fetchLastSession(message.platform).then(sendResponse);
//       return true;
//     }
//
//   });

async function _relayConversationCapture(message) {
  const {
    session_id,
    platform,
    source_url,
    source_title,
    turns,
  } = message;

  if (!turns || turns.length === 0) {
    return { ok: false, reason: "no turns" };
  }

  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}/collect-conversation`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ session_id, platform, source_url, source_title, turns }),
    });

    if (!res.ok) {
      console.warn("[cc] /collect-conversation returned", res.status);
      return { ok: false, status: res.status };
    }

    const data = await res.json();
    return { ok: true, session_id: data.session_id };

  } catch (err) {
    // Server not running — silent fail
    console.debug("[cc] server not available:", err.message);
    return { ok: false, reason: "server unavailable" };
  }
}


async function _fetchLastSession(platform = "claude") {
  try {
    const res = await fetch(
      `http://localhost:${SERVER_PORT}/context/session?platform=${platform}`,
      { signal: AbortSignal.timeout(2000) }
    );

    if (!res.ok) return { context: null };

    const data = await res.json();
    return data; // { context, session_id, source_url, captured_at, files_touched }

  } catch {
    return { context: null };
  }
}


// ── Tab watcher — paste into background.js ────────────────────────────────────
//
// Watches for Claude tabs navigating to a new conversation.
// When detected, fetches last session and pushes it to the content script.
//
// Add this block to background.js (outside any listener, at module scope):

function _watchClaudeTabs() {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only care when navigation completes on Claude
    if (changeInfo.status !== "complete") return;
    if (!tab.url || !tab.url.startsWith("https://claude.ai")) return;

    // Only on new/fresh conversations
    const isNew = (
      tab.url.includes("/chat/new") ||
      tab.url === "https://claude.ai/" ||
      tab.url === "https://claude.ai"
    );
    if (!isNew) return;

    // Small delay to let the page render before injecting
    setTimeout(async () => {
      const sessionData = await _fetchLastSession("claude");
      if (!sessionData.context) return;

      // Tell the content script to show the banner
      chrome.tabs.sendMessage(tabId, {
        type:    "SHOW_PRIOR_CONTEXT",
        context: sessionData.context,
      }).catch(() => {
        // Content script not ready yet — ignore
      });
    }, 1200);
  });
}

// Call this once at background.js startup:
// _watchClaudeTabs();


// ── Export for testing ────────────────────────────────────────────────────────
if (typeof module !== "undefined") {
  module.exports = { _relayConversationCapture, _fetchLastSession, _watchClaudeTabs };
}
