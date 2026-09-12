#!/usr/bin/env python
"""P9 페이지 설정·다단·쪽/단 나누기 회귀 테스트.

page-break/column-break(문단 속성), set-columns(secPr colPr), set-page(secPr
pagePr/margin)가 원본을 보존하며 secPr 완전성·한컴 열림 게이트를 지키는지 검증.

사용법: python tests/test_page.py
"""

import sys as _sys  # Windows 콘솔(cp949/cp1252) UTF-8 고정 — 한글·기호 출력 크래시 방지
for _stream in (_sys.stdin, _sys.stdout, _sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILL = ROOT / "scripts" / "fill_hwpx.py"
BUILD = Path(__file__).resolve().parent / "build_test_form.py"

PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def run(*args, expect=0):
    r = subprocess.run([sys.executable, str(FILL), *map(str, args)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != expect:
        print(f"    [exit {r.returncode}] {r.stderr.strip()[:200]}")
    out = json.loads(r.stdout) if r.stdout.strip() else None
    return r.returncode, out


def sec(p):
    return zipfile.ZipFile(p).read("Contents/section0.xml").decode()


def secpr_complete(p):
    """secPr가 pagePr와 그 안 margin 자식을 모두 보존하는지."""
    x = sec(p)
    m = re.search(r'<hp:pagePr\b[^>]*?>(.*?)</hp:pagePr>', x, re.S)
    return bool(m) and "<hp:margin" in m.group(1)


def changed_entries(a, b):
    bm = {i.filename: i.CRC for i in zipfile.ZipFile(a).infolist()}
    pm = {i.filename: i.CRC for i in zipfile.ZipFile(b).infolist()}
    return (sorted(k for k in bm if bm[k] != pm.get(k)),
            [k for k in pm if k not in bm])


def main():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        form = d / "form.hwpx"
        subprocess.run([sys.executable, str(BUILD), str(form)],
                       check=True, capture_output=True, encoding="utf-8", errors="replace")
        base_text = sec(form)

        # ── page-break ──
        pb = d / "pb.hwpx"
        code, rep = run("page-break", form, pb, "--after", "입사 지원 신청서")
        check("page-break 성공", code == 0 and rep and rep["ok"])
        check("pageBreak=1 1개 설정",
              sec(pb).count('pageBreak="1"') == 1)
        ch, added = changed_entries(form, pb)
        check("page-break: section만 변경",
              ch == ["Contents/section0.xml"] and not added)
        check("page-break: secPr 완전", secpr_complete(pb))
        code, _ = run("check", pb, "--strict")
        check("page-break check --strict", code == 0)

        # 해제(--off)
        off = d / "off.hwpx"
        code, _ = run("page-break", pb, off, "--after", "입사 지원 신청서", "--off")
        check("page-break --off 해제",
              code == 0 and sec(off).count('pageBreak="1"') == 0)

        # ── column-break ──
        cb = d / "cb.hwpx"
        code, rep = run("column-break", form, cb, "--para", "2")
        check("column-break 성공", code == 0 and rep and rep["ok"])
        check("columnBreak=1 1개 설정",
              sec(cb).count('columnBreak="1"') == 1)
        code, _ = run("check", cb, "--strict")
        check("column-break check --strict", code == 0)

        # ── set-columns ──
        sc = d / "sc.hwpx"
        code, rep = run("set-columns", form, sc, "--count", "2", "--gap-mm", "5")
        check("set-columns 성공", code == 0 and rep and rep["ok"])
        check("colCount=2 + gap 반영",
              'colCount="2"' in sec(sc) and 'sameGap="1417"' in sec(sc))
        check("set-columns: secPr 완전", secpr_complete(sc))
        ch, added = changed_entries(form, sc)
        check("set-columns: section만 변경",
              ch == ["Contents/section0.xml"] and not added)
        code, _ = run("check", sc, "--strict")
        check("set-columns check --strict", code == 0)

        # count=1 복귀
        sc1 = d / "sc1.hwpx"
        code, _ = run("set-columns", sc, sc1, "--count", "1")
        check("set-columns count=1 복귀",
              code == 0 and 'colCount="1"' in sec(sc1)
              and 'sameGap="0"' in sec(sc1))

        # count=0 거부
        code, _ = run("set-columns", form, d / "bad.hwpx", "--count", "0",
                      expect=1)
        check("set-columns count=0 거부(exit 1)", code == 1)

        # ── set-page ──
        sp = d / "sp.hwpx"
        code, rep = run("set-page", form, sp, "--orientation", "landscape",
                        "--margin-mm", "20")
        check("set-page 성공", code == 0 and rep and rep["ok"])
        m = re.search(r'<hp:pagePr\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"',
                      sec(sp))
        check("가로방향: width>height",
              bool(m) and int(m.group(1)) > int(m.group(2)))
        mg = re.search(r'<hp:margin\b[^>]*/>', sec(sp))
        check("여백 20mm(5669) 반영",
              bool(mg) and 'left="5669"' in mg.group(0)
              and 'top="5669"' in mg.group(0)
              and 'gutter="0"' in mg.group(0))  # header/footer/gutter 보존
        check("set-page: secPr 완전", secpr_complete(sp))
        ch, added = changed_entries(form, sp)
        check("set-page: section만 변경",
              ch == ["Contents/section0.xml"] and not added)
        code, _ = run("check", sp, "--strict")
        check("set-page check --strict", code == 0)

        # size 프리셋 + portrait
        sp2 = d / "sp2.hwpx"
        code, _ = run("set-page", form, sp2, "--size", "a5",
                      "--orientation", "portrait")
        m = re.search(r'<hp:pagePr\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"',
                      sec(sp2))
        check("A5 세로: width<height & 크기 적용",
              bool(m) and int(m.group(1)) < int(m.group(2))
              and abs(int(m.group(1)) - round(148 * 7200 / 25.4)) <= 1)
        code, _ = run("check", sp2, "--strict")
        check("set-page A5 check --strict", code == 0)

        # 변경 항목 미지정 거부
        code, _ = run("set-page", form, d / "bad2.hwpx", expect=1)
        check("set-page 항목 미지정 거부(exit 1)", code == 1)

        # ── 본문 보존(텍스트 불변): page-break는 텍스트를 안 건드림 ──
        check("page-break 본문 텍스트 보존",
              "입사 지원 신청서" in sec(pb) and "동의여부" in sec(pb))

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
