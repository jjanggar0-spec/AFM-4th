#!/usr/bin/env python
"""Remove stale branded preview artifacts from the bundled report template.

The editable document body is already neutral.  This script rebuilds PrvText
from the actual section XML and drops the stale preview thumbnail so Finder or
other preview surfaces cannot expose an obsolete sample logo.
"""
from __future__ import annotations

import sys as _sys  # Windows 콘솔(cp949/cp1252) UTF-8 고정 — 한글·기호 출력 크래시 방지
for _stream in (_sys.stdin, _sys.stdout, _sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass

import argparse
import os
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


TEXT_SUFFIXES = (".xml", ".txt", ".hpf", ".rdf")
FORBIDDEN = ("브라더", "brother")
HP_T = "{http://www.hancom.co.kr/hwpml/2011/paragraph}t"


def sanitize(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as zin:
        section = ET.fromstring(zin.read("Contents/section0.xml"))
        preview = "\n".join(
            "".join(node.itertext()) for node in section.findall(f".//{HP_T}")
            if "".join(node.itertext()).strip()
        ).encode("utf-8")
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".hwpx", delete=False) as handle:
            temp = Path(handle.name)
        with zipfile.ZipFile(temp, "w") as zout:
            for item in zin.infolist():
                if item.filename == "Preview/PrvImage.png":
                    continue
                data = preview if item.filename == "Preview/PrvText.txt" else zin.read(item.filename)
                zout.writestr(item, data)
    os.replace(temp, path)

    with zipfile.ZipFile(path, "r") as check:
        for name in check.namelist():
            if name.lower().endswith(TEXT_SUFFIXES):
                text = check.read(name).decode("utf-8", "ignore").lower()
                if any(marker in text for marker in FORBIDDEN):
                    raise SystemExit(f"FORBIDDEN_BRAND_REMAINS: {name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets/report-template.hwpx",
    )
    args = parser.parse_args()
    sanitize(args.path)
    print(f"SANITIZED {args.path}")


if __name__ == "__main__":
    main()
