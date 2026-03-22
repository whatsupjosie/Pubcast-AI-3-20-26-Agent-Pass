"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const CONTEXT_TEXT_LIMIT      = 900;
const SIBLING_SCAN_LIMIT      = 5;
const PARENT_SCAN_LIMIT       = 4;
const PREVIOUS_BLOCK_SCAN_LIMIT = 2;
const SENTENCE_SCAN_LIMIT     = 6;
const FETCH_TIMEOUT_MS        = 15000;

// ─── Site-specific semantic selectors ────────────────────────────────────────
// Each AI chat site has its own DOM structure. We know them. Use them.
const SITE_SELECTORS = {
  "claude.ai":             "[data-testid='message'], .font-claude-message, .prose",
  "chat.openai.com":       "[data-message-author-role], .markdown",
  "chatgpt.com":           "[data-message-author-role], .markdown",
  "gemini.google.com":     "message-content, .model-response-text",
  "copilot.microsoft.com": "[data-testid='message-content'], .ac-textBlock",
  "perplexity.ai":         ".prose, [class*='answer']",
  "aistudio.google.com":   "ms-chunk, .turn-content",
};

function getSiteSelector() {
  const host = location.hostname;
  for (const [domain, sel] of Object.entries(SITE_SELECTORS)) {
    if (host.includes(domain)) return sel;
  }
  return null;
}

// ─── Text utilities ───────────────────────────────────────────────────────────
function normalizeText(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text, limit = CONTEXT_TEXT_LIMIT) {
  const t = normalizeText(text);
  return t.length <= limit ? t : `${t.slice(0, limit).trim()}…`;
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeText)
    .filter(Boolean);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function isElement(node) {
  return !!node && node.nodeType === Node.ELEMENT_NODE;
}

function isCodeLike(node) {
  if (!isElement(node)) return false;
  const tag = node.tagName.toLowerCase();
  if (["pre", "code", "script", "style", "noscript"].includes(tag)) return true;
  return !!node.querySelector("pre, code");
}

function isTextCandidate(node) {
  if (!isElement(node) || isCodeLike(node)) return false;
  const tag = node.tagName.toLowerCase();
  if (["p", "li", "blockquote", "dd", "dt", "figcaption", "summary", "h1", "h2", "h3", "h4"].includes(tag)) return true;
  if (["div", "section", "article", "main", "aside"].includes(tag)) {
    return normalizeText(node.innerText || node.textContent || "").length >= 20;
  }
  return false;
}

function getTextFrom(node) {
  if (!isTextCandidate(node)) return "";
  return truncateText(node.innerText || node.textContent || "");
}

function getCodeContainer(node) {
  return node.closest("pre") || node;
}

// ─── Language detection ───────────────────────────────────────────────────────
function detectLanguage(node) {
  // 1. CSS classes on node
  for (const cls of Array.from(node.classList || [])) {
    if (cls.startsWith("language-")) return cls.replace("language-", "").toLowerCase();
    if (cls.startsWith("lang-"))     return cls.replace("lang-", "").toLowerCase();
  }
  // 2. Parent <pre> attributes
  const pre = node.closest("pre");
  if (pre) {
    for (const cls of Array.from(pre.classList || [])) {
      if (cls.startsWith("language-")) return cls.replace("language-", "").toLowerCase();
    }
    const dl = pre.getAttribute("data-language") || pre.getAttribute("data-lang") || pre.getAttribute("lang");
    if (dl) return dl.toLowerCase();
  }
  // 3. Content heuristics
  const t = node.textContent || "";
  if (/^(import |from |def |class |if __name__)/.test(t))  return "python";
  if (/^(const |let |var |function |=>|import {)/.test(t)) return "javascript";
  if (/^(fn |use |mod |impl |struct )/.test(t))            return "rust";
  if (/^(package |import "golang)/.test(t))                return "go";
  if (/^(<\?php|namespace |use )/.test(t))                 return "php";
  if (/<[a-zA-Z][^>]*>/.test(t))                          return "html";
  if (/^\s*[\{\[]/.test(t))                               return "json";
  return "text";
}

// ─── Context extraction ───────────────────────────────────────────────────────
function findSemanticBlock(node) {
  const siteSelector = getSiteSelector();
  let current = node;
  while (current && isElement(current)) {
    // Site-specific semantic containers
    if (siteSelector && current.matches?.(siteSelector)) return current;
    // Generic semantic markers
    if (current.matches?.("article, section, [data-message-author-role], [role='listitem'], li")) return current;
    current = current.parentElement;
  }
  return node.parentElement || node;
}

function collectDirectionalContext(container, direction) {
  const texts = [];
  let current = container;
  let hops = 0;

  // Scan siblings first
  while (current && hops < SIBLING_SCAN_LIMIT) {
    current = direction === "before" ? current.previousElementSibling : current.nextElementSibling;
    if (!current) break;
    hops++;
    const text = getTextFrom(current);
    if (text) direction === "before" ? texts.unshift(text) : texts.push(text);
  }

  if (texts.length) return truncateText(texts.join("\n\n"));

  // Walk up the DOM if siblings came up empty
  let parent = container.parentElement;
  let depth  = 0;
  while (parent && depth < PARENT_SCAN_LIMIT) {
    const candidates = Array.from(parent.children)
      .filter((c) => c !== container && !isCodeLike(c))
      .map(getTextFrom)
      .filter(Boolean);

    if (candidates.length) {
      const slice = direction === "before" ? candidates.slice(0, 2) : candidates.slice(-2);
      return truncateText(slice.join("\n\n"));
    }
    parent = parent.parentElement;
    depth++;
  }
  return "";
}

function collectPreviousSemanticBlockText(container) {
  const block = findSemanticBlock(container);
  const texts = [];
  let current = block;
  let hops    = 0;

  while (current && hops < PREVIOUS_BLOCK_SCAN_LIMIT) {
    current = current.previousElementSibling;
    if (!current) break;
    hops++;
    const raw = normalizeText(current.innerText || current.textContent || "");
    if (raw.length >= 20) texts.unshift(truncateText(raw, 500));
  }
  return truncateText(texts.join("\n\n"), 700);
}

// ─── Code structure analysis ──────────────────────────────────────────────────
function inferCodeStructure(code, language) {
  const entities = [];
  const imports  = [];

  const addEntity = (kind, name) => {
    if (!name) return;
    if (!entities.some((e) => e.kind === kind && e.name === name)) entities.push({ kind, name });
  };

  const patterns = [
    { kind: "function",       regex: /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
    { kind: "class",          regex: /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/g },
    { kind: "function",       regex: /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g },
    { kind: "function",       regex: /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g },
    { kind: "arrow_function", regex: /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?[^\n=]*=>/g },
    { kind: "interface",      regex: /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)\b/g },
    { kind: "type",           regex: /\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g },
    { kind: "fn",             regex: /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },       // Rust
    { kind: "func",           regex: /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },     // Go
  ];

  for (const { kind, regex } of patterns) {
    let m;
    while ((m = regex.exec(code)) !== null) addEntity(kind, m[1]);
  }

  const importPatterns = [
    /\bimport\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /\bfrom\s+([A-Za-z0-9_./-]+)\s+import\s/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\buse\s+([A-Za-z0-9_:]+);/g,   // Rust
    /^import\s+"([^"]+)"/gm,         // Go
  ];

  for (const regex of importPatterns) {
    let m;
    while ((m = regex.exec(code)) !== null) {
      if (!imports.includes(m[1])) imports.push(m[1]);
    }
  }

  return {
    code_type:          entities[0]?.kind || (language === "json" ? "data" : "snippet"),
    entity_names:       entities.map((e) => e.name),
    entities,
    imports,
    probable_entrypoint:
      /\bif\s+__name__\s*==\s*['"]__main__['"]/.test(code) ||
      /\bfunc\s+main\s*\(/.test(code) ||
      /\bfunction\s+main\s*\(/.test(code),
  };
}

// ─── Purpose inference (scored NLP-lite) ─────────────────────────────────────
function scoreSentence(sentence, codeInfo) {
  let score = 0;
  const lower = sentence.toLowerCase();

  if (inferFilename(sentence))                                                                        score += 6;
  if (/(this|the|below|following)\s+(function|class|script|module|snippet|code|file)/i.test(sentence)) score += 5;
  if (/(used to|used for|handles|creates|builds|renders|stores|saves|exports|uploads|parses|collects|validates|calculates|returns|loads|writes|reads)/i.test(sentence)) score += 5;
  if (/(main\.|index\.|app\.|utils\.|config\.)/i.test(sentence))                                    score += 4;
  if (/(purpose|goal|used by|called by|entry point|helper|wrapper|client|server|endpoint)/i.test(sentence)) score += 3;

  for (const name of codeInfo.entity_names || []) {
    if (name && lower.includes(name.toLowerCase())) score += 4;
  }
  for (const imp of codeInfo.imports || []) {
    if (imp && lower.includes(String(imp).toLowerCase())) score += 2;
  }

  if (sentence.length > 180) score -= 1;
  return score;
}

function inferPurposeFromContext(contextSources, codeInfo) {
  const candidates = [];
  for (const { label, text } of contextSources) {
    for (const sentence of splitSentences(text).slice(0, SENTENCE_SCAN_LIMIT)) {
      const score = scoreSentence(sentence, codeInfo);
      if (score > 0) candidates.push({ label, sentence, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.sentence.length - b.sentence.length);

  const best = candidates[0];
  let purposeHint = "";
  if (best) {
    purposeHint = best.sentence;
  } else if (codeInfo.entity_names?.length) {
    purposeHint = `${codeInfo.code_type} ${codeInfo.entity_names[0]}`;
  }

  return {
    purpose_hint:     truncateText(purposeHint, 240),
    context_evidence: candidates.slice(0, 5),
  };
}

// ─── Filename detection ───────────────────────────────────────────────────────
function inferFilename(text) {
  const m = text.match(/\b([\w.-]+\.(?:py|js|ts|tsx|jsx|json|md|html|css|sh|sql|rb|php|java|go|rs|cpp|c|h|cs|swift|kt|yaml|toml|env))\b/i);
  return m ? m[1] : "";
}

// ─── Main collection ──────────────────────────────────────────────────────────
function collectCodeBlocks() {
  const nodes  = Array.from(document.querySelectorAll("pre code, pre > div, code"));
  const seen   = new Set();
  const blocks = [];

  for (const node of nodes) {
    const text = normalizeText(node.textContent || "");
    if (!text || text.length < 10) continue;

    const language = detectLanguage(node);
    const key      = `${language}::${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const container     = getCodeContainer(node);
    const contextBefore = collectDirectionalContext(container, "before");
    const contextAfter  = collectDirectionalContext(container, "after");
    const prevBlock     = collectPreviousSemanticBlockText(container);
    const contextWindow = truncateText([prevBlock, contextBefore, contextAfter].filter(Boolean).join("\n\n"));

    const codeInfo = inferCodeStructure(text, language);
    const sources  = [
      { label: "previous_block", text: prevBlock },
      { label: "before",         text: contextBefore },
      { label: "after",          text: contextAfter },
    ].filter((s) => s.text);

    const { purpose_hint, context_evidence } = inferPurposeFromContext(sources, codeInfo);
    const detected_filename                  = inferFilename(contextWindow) || inferFilename(contextBefore);

    blocks.push({
      language,
      content:              text,
      context_before:       contextBefore,
      context_after:        contextAfter,
      previous_context:     prevBlock,
      context_window:       contextWindow,
      purpose_hint,
      detected_filename,
      code_type:            codeInfo.code_type,
      entity_names:         codeInfo.entity_names,
      entities:             codeInfo.entities,
      imports:              codeInfo.imports,
      probable_entrypoint:  codeInfo.probable_entrypoint,
      context_evidence,
    });
  }

  return blocks;
}

// ─── Payload builder ──────────────────────────────────────────────────────────
function buildPayload(target) {
  return {
    source_url:   location.href,
    source_title: document.title,
    captured_at:  new Date().toISOString(),
    target,
    blocks:       collectCodeBlocks(),
  };
}

// ─── Toast notification ───────────────────────────────────────────────────────
function showToast(message, type = "ok") {
  const existing = document.getElementById("cc-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "cc-toast";
  Object.assign(toast.style, {
    position:      "fixed",
    bottom:        "24px",
    right:         "24px",
    zIndex:        "2147483647",
    padding:       "12px 18px",
    borderRadius:  "8px",
    fontFamily:    "ui-monospace, 'DM Mono', monospace",
    fontSize:      "13px",
    fontWeight:    "500",
    color:         type === "ok" ? "#000" : "#fff",
    background:    type === "ok" ? "#c9a84c" : (type === "warn" ? "#b35c00" : "#c0392b"),
    boxShadow:     "0 4px 24px rgba(0,0,0,0.4)",
    transition:    "opacity 0.4s",
    opacity:       "1",
    pointerEvents: "none",
    maxWidth:      "360px",
    lineHeight:    "1.4",
  });

  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ─── Send via background (with timeout) ──────────────────────────────────────
async function collectAndSend(target) {
  const payload = buildPayload(target);

  if (payload.blocks.length === 0) {
    showToast("No code blocks found on this page.", "error");
    return;
  }

  // Real timeout — if background takes too long, show error and bail
  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      showToast("Collector timed out — is the tray app running?", "error");
    }
  }, FETCH_TIMEOUT_MS);

  chrome.runtime.sendMessage(
    { type: "POST_PAYLOAD", payload, target },
    (response) => {
      if (settled) return; // timeout already fired
      settled = true;
      clearTimeout(timeout);

      if (chrome.runtime.lastError) {
        showToast(`Extension error: ${chrome.runtime.lastError.message}`, "error");
        return;
      }

      if (!response?.ok) {
        const err = response?.error || "Unknown error";
        if (err.includes("fetch") || err.includes("refused") || err.includes("Failed")) {
          showToast("Collector app isn't running — start it from the system tray.", "error");
        } else if (err.includes("Unauthorized")) {
          showToast("Auth token mismatch. Check Settings.", "warn");
        } else {
          showToast(`Save failed: ${err}`, "error");
        }
        return;
      }

      const { blocks, saved_to } = response.result;
      const destinations         = Object.keys(saved_to || {}).join(" + ") || target;

      // Build a smart summary using the context data
      const firstBlock  = payload.blocks[0];
      const hint        = firstBlock?.purpose_hint || firstBlock?.entity_names?.[0] || "";
      const hintSuffix  = hint ? ` — ${hint.slice(0, 60)}` : "";

      showToast(`✓ ${blocks} block${blocks !== 1 ? "s" : ""} → ${destinations}${hintSuffix}`);
    }
  );
}

// ─── Listen for context menu commands from background ─────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "COLLECT_AND_SEND") collectAndSend(msg.target);
});
