#!/usr/bin/env python3
"""Export extracted chat code payloads into plain text files per code block."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Bug fix #13 — comprehensive language → extension map
LANG_TO_EXT: dict[str, str] = {
    "python":       "py",
    "py":           "py",
    "javascript":   "js",
    "js":           "js",
    "typescript":   "ts",
    "ts":           "ts",
    "jsx":          "jsx",
    "tsx":          "tsx",
    "json":         "json",
    "bash":         "sh",
    "shell":        "sh",
    "sh":           "sh",
    "zsh":          "sh",
    "html":         "html",
    "css":          "css",
    "scss":         "scss",
    "sass":         "sass",
    "less":         "less",
    "markdown":     "md",
    "md":           "md",
    "rust":         "rs",
    "rs":           "rs",
    "go":           "go",
    "golang":       "go",
    "java":         "java",
    "kotlin":       "kt",
    "swift":        "swift",
    "c":            "c",
    "cpp":          "cpp",
    "c++":          "cpp",
    "csharp":       "cs",
    "c#":           "cs",
    "php":          "php",
    "ruby":         "rb",
    "rb":           "rb",
    "r":            "r",
    "sql":          "sql",
    "yaml":         "yaml",
    "yml":          "yaml",
    "toml":         "toml",
    "xml":          "xml",
    "svg":          "svg",
    "dockerfile":   "dockerfile",
    "makefile":     "makefile",
    "graphql":      "graphql",
    "proto":        "proto",
    "lua":          "lua",
    "perl":         "pl",
    "scala":        "scala",
    "elixir":       "ex",
    "erlang":       "erl",
    "haskell":      "hs",
    "ocaml":        "ml",
    "text":         "txt",
    "txt":          "txt",
    "plaintext":    "txt",
    "plain":        "txt",
}


def extension_for_language(lang: str) -> str:
    return LANG_TO_EXT.get((lang or "text").lower(), "txt")


# Bug fix #12 — returns (blocks_written, error_message) instead of raising
def export_file(source_file: Path, output_dir: Path) -> tuple[int, str | None]:
    try:
        raw = source_file.read_text(encoding="utf-8")
    except OSError as e:
        return 0, f"cannot read {source_file.name}: {e}"

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        return 0, f"invalid JSON in {source_file.name}: {e}"

    blocks = payload.get("blocks")
    if not isinstance(blocks, list):
        return 0, f"'blocks' is not a list in {source_file.name}"

    base = source_file.stem
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return 0, f"cannot create output dir: {e}"

    count = 0
    for idx, block in enumerate(blocks, start=1):
        language = str(block.get("language", "text"))
        content  = str(block.get("content", ""))
        if not content:
            continue
        ext      = extension_for_language(language)
        out_name = f"{base}_block_{idx:03d}.{ext}"
        try:
            (output_dir / out_name).write_text(content, encoding="utf-8")
            count += 1
        except OSError as e:
            print(f"  warning: could not write {out_name}: {e}", file=sys.stderr)

    return count, None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert JSON exports to plain files")
    parser.add_argument("--input-dir",  default="exports",       help="Directory of JSON export files")
    parser.add_argument("--output-dir", default="plain_exports",  help="Where to write plain files")
    return parser.parse_args()


def main() -> int:
    args       = parse_args()
    input_dir  = Path(args.input_dir)
    output_dir = Path(args.output_dir)

    if not input_dir.exists():
        print(f"error: input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    json_files = sorted(input_dir.glob("*.json"))
    if not json_files:
        print(f"no JSON files found in {input_dir}", file=sys.stderr)
        return 0

    total_files   = 0
    total_blocks  = 0
    total_errors  = 0

    for item in json_files:
        blocks, error = export_file(item, output_dir)
        if error:
            # Bug fix #12 — log and continue instead of crashing
            print(f"skip: {error}", file=sys.stderr)
            total_errors += 1
        else:
            total_files  += 1
            total_blocks += blocks

    print(f"processed_files={total_files}")
    print(f"exported_blocks={total_blocks}")
    if total_errors:
        print(f"skipped_files={total_errors}")

    return 0 if total_errors == 0 else 2  # exit 2 = partial success


if __name__ == "__main__":
    raise SystemExit(main())
