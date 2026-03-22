/**
 * claude_scraper.js
 * ══════════════════
 * Content script for claude.ai.
 *
 * FULLY AUTOMATIC. No banners. No buttons. No clicks.
 *
 * New conversation detected → prior context fetched → typed into input →
 * sent automatically → Claude responds → you're already in context.
 * You open the tab. That's it. That's all you do.
 *
 * Capture runs silently in the background every 5 turns and on tab close.
 * You never see it happen.
 *
 * Rear View Foresight LLC — Feic Mo Chroí
 */

"use strict";

const PLATFORM = "claude";

const SELECTORS = {
  turn:          '[data-testid="user-message"], [data-testid="assistant-message"]',
  userTurn:      '[data-testid="user-message"]',
  assistantTurn: '[data-testid="assistant-message"]',
  turnContent:   '.whitespace-pre-wrap, [class*="prose"]',
  input:         '[data-testid="composer-input"], div[contenteditable="true"]',
  sendButton:    '[data-testid="send-button"]',
};

let _sessionId     = _extractSessionId(location.href);
let _lastTurnCount = 0;
let _primed        = false;

// ── Entry point ───────────────────────────────────────────────────────────────

(function init() {
  _maybeAutoSendContext();
  _observeTurns();
  _listenForMessages();
})();

// ── Auto-send context on new conversation ─────────────────────────────────────

async function _maybeAutoSendContext() {
  if (_primed) return;
  if (!_isNewConversation()) return;

  // Wait for the input to be ready
  const input = await _waitForElement(SELECTORS.input, 8000);
  if (!input) return;

  // Fetch prior session context from local server
  const data = await _fetchLastSession();
  if (!data || !data.context) return;

  // Safety: don't fire if user already started typing
  const existingText = input.innerText?.trim() || input.textContent?.trim() || "";
  if (existingText.length > 0) return;

  // Safety: don't fire if conversation already has turns
  const existingTurns = document.querySelectorAll(SELECTORS.turn);
  if (existingTurns.length > 0) return;

  _primed = true;

  // Wait a beat for Claude's page to fully settle
  await _sleep(600);

  // Re-check — user may have started typing during the sleep
  const textNow = input.innerText?.trim() || input.textContent?.trim() || "";
  if (textNow.length > 0) { _primed = false; return; }

  // Type the context message and send it
  await _typeAndSend(input, _formatContextMessage(data));
}

function _formatContextMessage(data) {
  // Compact, direct. Claude doesn't need a preamble.
  const lines = [
    "📎 Continuing from last session:",
    "",
    data.context,
  ];

  if (data.source_url) {
    lines.push("", `Source: ${data.source_url}`);
  }

  return lines.join("\n");
}

async function _typeAndSend(input, text) {
  // Focus and clear
  input.focus();
  document.execCommand("selectAll");
  document.execCommand("insertText", false, text);
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));

  // Wait for send button to become active
  const sendBtn = await _waitForElement(SELECTORS.sendButton, 3000);
  if (!sendBtn) return;

  // Small delay so React catches up
  await _sleep(200);

  sendBtn.click();
}

// ── Background capture ────────────────────────────────────────────────────────

function _observeTurns() {
  new MutationObserver(_debounce(() => {
    const count = document.querySelectorAll(SELECTORS.turn).length;
    if (count > _lastTurnCount) {
      _lastTurnCount = count;
      if (count % 5 === 0) _capture();
    }
  }, 1000)).observe(document.body, { childList: true, subtree: true });
}

function _capture() {
  const turns = _scrapeTurns();
  if (!turns.length) return;
  chrome.runtime.sendMessage({
    type:         "CONVERSATION_CAPTURE",
    platform:     PLATFORM,
    session_id:   _sessionId,
    source_url:   location.href,
    source_title: document.title || "Claude",
    turns,
  });
}

function _scrapeTurns() {
  const turns = [];
  document.querySelectorAll(SELECTORS.turn).forEach((node) => {
    const role = node.matches(SELECTORS.userTurn) ? "user" : "assistant";
    const content = (node.querySelector(SELECTORS.turnContent) || node)
      .innerText?.trim() || "";
    if (content.length > 3) turns.push({ role, content, ts: Date.now() / 1000 });
  });
  return turns;
}

// ── Fetch prior context from local server ─────────────────────────────────────

async function _fetchLastSession() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_LAST_SESSION", platform: PLATFORM },
      (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response || null);
      }
    );
  });
}

// ── Message listener ──────────────────────────────────────────────────────────

function _listenForMessages() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CAPTURE_SESSION_NOW") {
      _capture();
      sendResponse({ ok: true });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _isNewConversation() {
  if (["/chat/new", "/new", "/"].includes(location.pathname)) return true;
  return document.querySelectorAll(SELECTORS.turn).length === 0;
}

function _waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) { resolve(el); return; }
    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _extractSessionId(url) {
  const m = url.match(/\/chat\/([a-zA-Z0-9\-]+)/);
  return m ? m[1] : Math.random().toString(36).slice(2, 14);
}

function _debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Capture on tab close — final state
window.addEventListener("beforeunload", () => {
  const turns = _scrapeTurns();
  if (!turns.length) return;
  navigator.sendBeacon(
    "http://localhost:8765/collect-conversation",
    new Blob([JSON.stringify({
      session_id:   _sessionId,
      platform:     PLATFORM,
      source_url:   location.href,
      source_title: document.title || "Claude",
      turns,
    })], { type: "application/json" })
  );
});
