# Code Collector

Capture code blocks from AI chat pages. Right-click → save to wherever you want.  
Local-first. Cloud optional. Every capture knows what it is.

---

## What's new in this build

**Context-aware captures** — every saved code block now includes:
- `context_before` / `context_after` — surrounding explanation text
- `purpose_hint` — the most relevant sentence describing what the code does (scored NLP)
- `detected_filename` — if a filename like `main.py` is mentioned near the code, it's captured
- `entity_names` — functions, classes, interfaces extracted from the code
- `imports` — dependencies detected
- `probable_entrypoint` — flagged if `if __name__ == "__main__"` or `func main()` is found
- `code_type` — function / class / snippet / data

**Smart filenames** — instead of `chat_code_20260314_120000_Claude.json` you get:  
`claude-ai__2026-03-14__function-routePayload__001.json`

**Site-specific DOM targeting** — Claude, ChatGPT, Gemini, Copilot, Perplexity, and AI Studio each get their own semantic selectors for better context extraction.

**Auth error handling** — distinct toast messages for server-not-running vs token-mismatch.

---

## Install

### Desktop App
```bash
cd app
npm install
npm start           # dev
npm run build:mac   # production macOS .dmg
npm run build:win   # production Windows .exe
npm run build:linux # production AppImage / .deb
```

### Browser Extension
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder

Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`

---

## How it works

```
Right-click or popup click
        ↓
content.js — collects + enriches blocks
        ↓
background.js — POSTs to local server
        ↓
Electron tray app (main.js)
        ↓
Primary folder  (always)
Archive folder  (if enabled)
Cloud folder    (if enabled + configured)
```

---

## Save targets

| Target | What it does |
|--------|-------------|
| **Primary** | Your main save location |
| **Archive** | Backup copy |
| **Both** | Primary + Archive + Cloud (if on) |
| **Cloud** | A folder synced by Drive/Dropbox/etc. |

---

## Output format

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
      "purpose_hint": "This function handles save routing.",
      "detected_filename": "main.py",
      "code_type": "function",
      "entity_names": ["route_payload"],
      "imports": ["pathlib", "json"],
      "probable_entrypoint": false
    }
  ]
}
```

---

## Convert to plain files

```bash
python3 tools/export_plain_files.py \
  --input-dir ~/Documents/CodeCollector/primary \
  --output-dir ~/Desktop/plain_exports
```

---

## Supported sites

- claude.ai
- chat.openai.com / chatgpt.com
- gemini.google.com
- copilot.microsoft.com
- perplexity.ai
- aistudio.google.com

---

Built by Rear View Foresight LLC · **Feic Mo Chroí™** · *We make movies.*
