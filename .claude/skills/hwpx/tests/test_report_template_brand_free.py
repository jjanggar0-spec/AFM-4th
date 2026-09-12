#!/usr/bin/env python
"""Regression gate for the neutral built-in report template."""

import sys as _sys  # Windows 콘솔(cp949/cp1252) UTF-8 고정 — 한글·기호 출력 크래시 방지
for _stream in (_sys.stdin, _sys.stdout, _sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "assets/report-template.hwpx"
FORBIDDEN = ("브라더", "brother")


def main() -> None:
    with ZipFile(ASSET) as zf:
        names = zf.namelist()
        assert names[0] == "mimetype"
        assert zf.getinfo("mimetype").compress_type == 0
        assert "Preview/PrvImage.png" not in names
        assert not any(name.startswith("BinData/") for name in names)
        for name in names:
            if name.lower().endswith((".xml", ".txt", ".hpf", ".rdf")):
                text = zf.read(name).decode("utf-8", "ignore").lower()
                assert not any(marker in text for marker in FORBIDDEN), name
        body = zf.read("Contents/section0.xml").decode("utf-8")
        preview = zf.read("Preview/PrvText.txt").decode("utf-8")
        assert "〔기관명 입력〕" in body
        assert "〔기관명 입력〕" in preview
    print("PASS report template is brand-free and preview-synchronized")


if __name__ == "__main__":
    main()
