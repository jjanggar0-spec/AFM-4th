#!/usr/bin/env python
"""fill_hwpx.py 테스트용 양식 HWPX 생성 — templates/base 골격에 폼 테이블 삽입."""

import sys as _sys  # Windows 콘솔(cp949/cp1252) UTF-8 고정 — 한글·기호 출력 크래시 방지
for _stream in (_sys.stdin, _sys.stdout, _sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass
import sys
import zipfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
BASE = SKILL / "templates" / "base"

TC = ('<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3">'
      '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER">{paras}</hp:subList>'
      '<hp:cellAddr colAddr="{col}" rowAddr="{row}"/><hp:cellSpan colSpan="1" rowSpan="1"/>'
      '<hp:cellSz width="20000" height="2000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>')

def cell(row, col, paras):
    return TC.format(paras=paras, row=row, col=col)

# 한컴 줄배치 캐시 — 텍스트 수정 시 stale해지므로 fill_hwpx가 제거해야 함
LSA = ('<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000"'
       ' textheight="1000" baseline="850" spacing="600" horzpos="0"'
       ' horzsize="42520" flags="393216"/></hp:linesegarray>')

def p(run_xml, pid, lsa=False):
    body = run_xml + (LSA if lsa else "")
    return f'<hp:p id="{pid}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">{body}</hp:p>'

def t_run(text, charpr="0"):
    return f'<hp:run charPrIDRef="{charpr}"><hp:t>{text}</hp:t></hp:run>'

FORM = (
    p(t_run("입사 지원 신청서"), 9001, lsa=True)  # replace로 수정됨 → 캐시 제거 기대
    # 표 1: 라벨-값 (빈 self-closing run / 기존 값 / 어노테이션 / 체크박스 / 괄호 빈칸)
    + p('<hp:run charPrIDRef="0"><hp:tbl id="9100" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="1" rowCnt="5" colCnt="2" cellSpacing="0" borderFillIDRef="3" noAdjust="0">'
        + "<hp:tr>" + cell(0, 0, p(t_run("성  명", "1"), 9101))
        + cell(0, 1, p('<hp:run charPrIDRef="2"/>', 9102)) + "</hp:tr>"
        + "<hp:tr>" + cell(1, 0, p(t_run("연락처"), 9103))
        + cell(1, 1, p(t_run("010-0000-0000"), 9104, lsa=True)) + "</hp:tr>"  # fill로 수정 → 제거 기대
        + "<hp:tr>" + cell(2, 0, p(t_run("주  소"), 9105))
        + cell(2, 1, p(t_run("(한자：      )"), 9106)) + "</hp:tr>"
        + "<hp:tr>" + cell(3, 0, p(t_run("동의여부"), 9107, lsa=True))  # 라벨 셀 = 무수정 → 캐시 보존 기대
        + cell(3, 1, p(t_run("□동의 □비동의"), 9108)) + "</hp:tr>"
        + "<hp:tr>" + cell(4, 0, p(t_run("통수"), 9109))
        + cell(4, 1, p(t_run("일반(  )통"), 9110)) + "</hp:tr>"
        + "</hp:tbl></hp:run>", 9002)
    # 표 2: 헤더+데이터 행
    + p('<hp:run charPrIDRef="0"><hp:tbl id="9200" zOrder="1" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="1" rowCnt="2" colCnt="2" cellSpacing="0" borderFillIDRef="3" noAdjust="0">'
        + "<hp:tr>" + cell(0, 0, p(t_run("품명"), 9201)) + cell(0, 1, p(t_run("수량"), 9202)) + "</hp:tr>"
        + "<hp:tr>" + cell(1, 0, p(t_run(" "), 9203)) + cell(1, 1, p(t_run(" "), 9204)) + "</hp:tr>"
        + "</hp:tbl></hp:run>", 9003)
    # 인라인 라벨
    + p(t_run("작성자: 미정"), 9004)
    # run 경계로 쪼개진 문장 (replace 테스트용 — 한컴이 자주 이렇게 저장)
    + p('<hp:run charPrIDRef="0"><hp:t>본 문서는 2025년 </hp:t></hp:run>'
        '<hp:run charPrIDRef="1"><hp:t>기준으로 작성되었습니다.</hp:t></hp:run>', 9005)
)

def main(out_path):
    section = (BASE / "Contents" / "section0.xml").read_text(encoding="utf-8")
    assert "</hs:sec>" in section
    section = section.replace("</hs:sec>", FORM + "</hs:sec>")

    files = []  # (zip명, 데이터, 압축방식)
    files.append(("mimetype", (BASE / "mimetype").read_bytes(), zipfile.ZIP_STORED))
    for rel in ["version.xml", "settings.xml", "META-INF/manifest.xml",
                "META-INF/container.xml", "META-INF/container.rdf",
                "Contents/content.hpf", "Contents/header.xml",
                "Preview/PrvImage.png", "Preview/PrvText.txt"]:
        src = BASE / rel
        if src.exists():
            files.append((rel, src.read_bytes(), zipfile.ZIP_DEFLATED))
    files.append(("Contents/section0.xml", section.encode("utf-8"), zipfile.ZIP_DEFLATED))

    with zipfile.ZipFile(out_path, "w") as zf:
        for name, data, method in files:
            zf.writestr(zipfile.ZipInfo(name), data, compress_type=method)
    print(f"생성: {out_path}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test_form.hwpx")
