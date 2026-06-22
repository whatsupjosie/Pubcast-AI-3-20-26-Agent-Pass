# CODE COLLECTOR — SESSION HANDOFF
**Project:** Code Collector  
**Owner:** Josie Curtsey Cobbley / Rear View Foresight LLC  
**Date:** 2026-03-14  
**Status:** Browser version functionally complete. OS version designed, not built.

---

## WHAT THIS PRODUCT IS

A two-surface code capture tool. Both surfaces feed the same local Electron app, same destinations, same output format.

```
SURFACE 1 (FREE)        SURFACE 2 (PAID)
Browser Extension   +   OS Right-Click Integration
       ↓                         ↓
    background.js         OS shell extension
       ↓                         ↓
       └──────────┬──────────────┘
                  ↓
         Electron Tray App
         (HTTP server :8765)
                  ↓
         ┌────────┼────────┐
       Primary  Archive  Cloud
       Folder   Folder   Folder
```

---

## WHAT IS BUILT (browser side — FREE tier)

### Files and what they do

**`extension/manifest.json`**  
Manifest V3. Targets: claude.ai, chat.openai.com, chatgpt.com, gemini.google.com, copilot.microsoft.com, perplexity.ai, aistudio.google.com. Permissions: contextMenus, storage, activeTab, scripting.

**`extension/content.js`**  
The intelligence layer. Runs on every supported page. Does:
- Collects all code blocks, deduped by language+content key
- Site-specific DOM selectors for each AI platform
- Context extraction: scans siblings and walks DOM tree for surrounding explanation text
- Code structure analysis: extracts function names, class names, imports, entrypoints
- NLP-lite purpose scoring: finds the best sentence describing what the code does
- Filename detection: finds mentions like `main.py` near the code
- Sends to background.js with target (primary/archive/both/cloud)
- Shows gold toast on success with purpose hint, red toast on failure with specific error

**`extension/background.js`**  
Service worker. Builds right-click context menu (4 options). Relays POST from content.js to local server. Handles content script injection if page loaded before extension.

**`extension/popup.html` + `popup.js`**  
Extension toolbar popup. Same 4 save targets as right-click menu. Pings server to show live status dot. 

**`extension/options.html`**  
Redirects user to the tray app for settings. Clean page, no duplication.

**`extension/icons/`** — icon16, icon48, icon128 (gold C on dark circle)

---

**`app/main.js`**  
The Electron main process. Does everything:
- Tray icon (gold = running, gray = stopped)  
- Embedded HTTP server on 127.0.0.1:8765
- Routing: primary / archive / both / cloud based on `payload.target`
- Smart filename generation: `claude-ai__2026-03-14__function-routePayload__001.json`
- Auto-restart on server crash (except EADDRINUSE — port conflict)
- Persistent settings via electron-store
- Opens settings window on request

**`app/settings.html` + `settings.js`**  
Full settings UI (dark, gold accents, DM Mono/DM Sans). Controls:
- Primary folder (browse)
- Archive folder (browse)
- Save to archive toggle
- Cloud sync toggle + cloud folder (browse, appears on toggle)
- Auth token (optional)
- Server port (default 8765)
- Start on login toggle
- Stop/Start server button

**`app/preload.js`**  
Secure IPC bridge. Exposes: getSettings, saveSettings, pickDirectory, getServerStatus, toggleServer.

**`app/package.json`**  
electron + electron-store + electron-builder. Builds for mac (dmg+zip), win (nsis), linux (AppImage+deb). App ID: `ai.pubcast.code-collector`. Copyright: Rear View Foresight LLC.

**`app/assets/`** — icon-active.png (gold), icon-inactive.png (gray) for tray

**`tools/export_plain_files.py`**  
Converts saved JSON captures into individual plain code files per block.

---

## BUGS FIXED IN LAST DEBUG ROUND

1. **AbortController dead code** — was created but signal never passed anywhere. Replaced with real `settled` flag + `clearTimeout` pattern. Timeout now shows proper toast.
2. **Icons directory missing** — Extension wouldn't load in Chrome. Created `extension/icons/` with icon16/48/128.png and `app/assets/` with tray icons.
3. **URL parsing crash** — `new URL("http://unknown")` throws. Wrapped in try/catch with fallback.
4. **Server silent death** — On non-EADDRINUSE errors, server now auto-restarts after 3s with console log. EADDRINUSE gives a clear error message instead.
5. **Status interval leak** — settings.js had `let statusInterval` with proper cleanup — confirmed clean.

---

## OUTPUT FORMAT (what each JSON capture looks like)

```json
{
  "source_url": "https://claude.ai/chat/...",
  "source_title": "Claude",
  "captured_at": "2026-03-14T20:00:00.000Z",
  "target": "primary",
  "blocks": [
    {
      "language": "python",
      "content": "def route_payload(payload):\n    ...",
      "context_before": "This function handles save routing.",
      "context_after": "It writes to whichever folders are enabled.",
      "previous_context": "...",
      "context_window": "...",
      "purpose_hint": "This function handles save routing.",
      "detected_filename": "main.py",
      "code_type": "function",
      "entity_names": ["route_payload"],
      "entities": [{ "kind": "function", "name": "route_payload" }],
      "imports": ["pathlib", "json"],
      "probable_entrypoint": false,
      "context_evidence": [...]
    }
  ]
}
```

---

## THE OS VERSION — WHAT IT NEEDS TO DO (PAID TIER)

This is the product people pay for. It needs to feel like it belongs on the OS — not a bolt-on.

### Core behavior

The user right-clicks any code file in their file manager / Finder / Explorer and sees:

```
Code Collector
  → Send to Primary
  → Send to Archive
  → Send to Both
  → Send to Cloud
```

Selecting one reads the file, extracts what it needs, and POSTs to the same local server (`127.0.0.1:8765/collect`) with the same payload format. The Electron app handles it identically — same routing, same smart filenames, same output.

### What "extraction" means for local files

Unlike a chat page, a local file IS the code — there's no surrounding context to scrape. So the OS version builds context differently:

| Field | Source |
|-------|--------|
| `language` | File extension (`.py` → python, `.rs` → rust, etc.) |
| `content` | Full file contents |
| `detected_filename` | The actual filename |
| `context_before` | Contents of any README or .md file in the same directory |
| `context_after` | Git log of the file (last 3 commits) if repo detected |
| `purpose_hint` | Top-of-file docstring or comment block |
| `entity_names` | Same code structure analysis as browser version |
| `source_url` | `file:///path/to/file.py` |
| `source_title` | filename |

### Platform requirements

**macOS**
- Finder extension (FinderSync API) — requires Apple Developer account for distribution
- Or: Quick Action / Automator workflow (no signing required, simpler but less elegant)
- Or: Services menu item via `NSServices` in Info.plist
- Recommended path: Quick Action for v1, proper FinderSync for v2

**Windows**
- Shell extension via registry (classic, works everywhere)
- Or: PowerShell context menu script injected by the installer
- Recommended path: Registry approach via NSIS installer for v1

**Linux**
- Nautilus script (GNOME) — drop a script in `~/.local/share/nautilus/scripts/`
- Dolphin service menu (KDE)
- Thunar custom action
- Recommended path: Nautilus + Dolphin for v1 (covers 80% of Linux desktop users)

### The bridge

Every OS integration just needs to call a small local binary or script that:
1. Reads the file(s)
2. Builds the payload
3. POSTs to `127.0.0.1:8765/collect` with the correct target
4. Shows a native notification with the result

That binary/script can be a tiny Python script bundled with the Electron app, or a small compiled Rust/Go binary for zero-dependency distribution.

### Pairing with the Electron app

The Electron app already handles everything on the receiving end. The OS integration doesn't need to know about routing, folders, or settings — it just sends to the server. The server does the rest.

One thing to add to the Electron app for OS support:
- A new settings panel section: **"OS Integration"**
  - Install Finder extension / Windows shell extension / Nautilus script
  - Uninstall
  - Status: installed / not installed

### What makes the paid version worth paying for

1. **Workflow continuity** — you can capture from your actual codebase, not just AI chat
2. **Batch capture** — select 10 files, right-click once, all 10 go to the archive
3. **Git context** — paid version pulls last 3 commit messages as `context_after` — free version can't do this
4. **Directory capture** — right-click a folder, capture everything in it with one action
5. **Watch mode** (stretch goal) — watch a directory, auto-capture any file that changes

---

## PLAN FOR NEXT SESSION

### Priority 1 — OS bridge script (the core of the paid tier)

Build `collector_bridge.py` — a small Python script bundled with the Electron app that:
- Accepts a file path as argument
- Accepts a target flag (primary/archive/both/cloud)
- Reads the file, builds the full enriched payload
- POSTs to the local server
- Prints result or error to stdout
- Used by all platform integrations as the single source of truth

```bash
python3 collector_bridge.py --file /path/to/main.py --target primary
```

### Priority 2 — macOS Quick Action

An Automator Quick Action that calls the bridge script. Appears in Finder right-click menu under "Quick Actions". No Developer account needed for personal use. Can be packaged as a `.workflow` file and installed by the Electron app automatically.

### Priority 3 — Windows registry integration

NSIS installer modification to add the context menu entry. Points to `collector_bridge.py` (or a compiled binary wrapper). Works on all Windows versions.

### Priority 4 — Electron app "OS Integration" settings panel

New section in `settings.html`:
- Install button per platform
- Shows installed/not installed status
- Uninstall button
- This is the upgrade gate — show it to free users, grey it out, "Upgrade to unlock"

### Priority 5 — Paywall architecture decision

How does the app know the user has paid?  
Options:
- License key (simplest — Gumroad or LemonSqueezy generates them)
- Paddle / Stripe subscription with webhook to activate
- GitHub Sponsors tier check

Recommendation: **License key via LemonSqueezy** for v1. One-time purchase, no subscription complexity, generates keys automatically.

---

## THINGS TO NOT FORGET

- The `{app/` directory artifact in the zip (stray folder from early build) — clean it before release
- The `export_plain_files.py` tool needs updating to output the new metadata fields (purpose_hint, entity_names, etc.)
- The popup.js `chrome.runtime.openOptionsPage()` call needs `?.()` — it's already there but confirm on Firefox
- Need real icons before any public release — the placeholder gold-C icons are functional but not brand-level
- The manifest `"type": "module"` was removed from background service worker — background.js uses CommonJS-style `"use strict"` which is correct for MV3 service workers

---

## BRAND NOTES

- Company: **Rear View Foresight LLC**
- Platform: **PubCast AI** (this tool is a standalone side product, not PubCast core)
- Motto: **Feic Mo Chroí™** (See My Heart) — trademark pending
- Tagline: **"We make movies."**
- Visual: gold (#c9a84c) on near-black (#0d0d0d), DM Mono + DM Sans
- Copyright line: `Copyright © 2026 Rear View Foresight LLC`

---

*Start the next session by loading this document as context. The zip `code_collector_v3_fixed.zip` is the current clean build.*
