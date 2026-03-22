"""
extractors/conversation_server.py
══════════════════════════════════
Subprocess wrapper for the conversation extractor.
Called by session_endpoints.js via execFile.

Reads JSON payload from stdin.
Writes JSON summary to stdout.
Writes errors to stderr.

INPUT (from session_endpoints.js):
{
  "session_id":   str,
  "platform":     str,
  "source_url":   str,
  "source_title": str,
  "turns": [
    { "role": "user"|"assistant", "content": str, "ts": float }
  ]
}

OUTPUT (to session_endpoints.js):
{
  "session_id":    str,
  "platform":      str,
  "source_url":    str,
  "context":       str,   ← the formatted context block text
  "files_touched": list,
  "decisions":     list,
  "breaks":        list,
  "builds":        list,
  "next_steps":    list,
  "turn_count":    int
}

Rear View Foresight LLC — Feic Mo Chroí
"""

import json
import sys
import os

# Add parent directory to path so we can import conversation.py
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from extractors.conversation import ConversationExtractor, ConversationTurn


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"bad input: {e}"}), file=sys.stderr)
        sys.exit(1)

    session_id   = payload.get("session_id", "unknown")
    platform     = payload.get("platform", "claude")
    source_url   = payload.get("source_url", "")
    source_title = payload.get("source_title", "Claude")
    raw_turns    = payload.get("turns", [])

    extractor = ConversationExtractor(
        session_id   = session_id,
        source_url   = source_url,
        source_title = source_title,
        platform     = platform,
    )
    extractor.ingest_raw(raw_turns)

    summary = extractor.summarize()
    context_block = summary.to_context_block()

    result = {
        "session_id":    summary.session_id,
        "platform":      summary.platform,
        "source_url":    summary.source_url,
        "context":       context_block["content"],
        "files_touched": summary.files_touched,
        "decisions":     summary.decisions,
        "breaks":        summary.breaks,
        "builds":        summary.builds,
        "next_steps":    summary.next_steps,
        "turn_count":    summary.turn_count,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
