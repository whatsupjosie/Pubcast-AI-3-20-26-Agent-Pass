#!/usr/bin/env python3
"""Build a zip bundle for the browser extension files."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


DEFAULT_FILES = [
    Path("extension/manifest.json"),
    Path("extension/content.js"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bundle extension files")
    parser.add_argument("--output", default="dist/chat_code_extractor_extension.zip")
    return parser.parse_args()


def build_bundle(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for item in DEFAULT_FILES:
            if not item.exists():
                raise FileNotFoundError(f"Missing required file: {item}")
            zf.write(item, arcname=item.name)
    return output


def main() -> int:
    args = parse_args()
    out = build_bundle(Path(args.output))
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
