# 모의투자 리서치 에이전트 — 실행 절차

하루 한 번, 아래 7단계를 **순서대로** 실행한다. 모든 명령은 이 폴더(`week-5/quest/coin`)에서 실행한다.
날짜·시각은 모두 **한국 시각(KST)**. 오늘 날짜를 `{오늘}`(YYYY-MM-DD)이라 쓴다.

```
coin/
├── AGENT.md            ← 이 문서 (절차)
├── events.json         ← 금지 이벤트 일정 (3단계에서 매일 확인·갱신)
├── market-mood.md      ← 시장 분위기 (4단계에서 매일 덮어씀)
├── scripts/            ← price · decide · order · wallet (Node 20+, 의존성 없음)
├── data/{오늘}/        ← price.json · decision.json · orders.json · wallet.json · 영상 자막
└── reports/{오늘}.md   ← 그날의 리포트
```

- 모의투자 앱: 기본 `https://coin-dashboard-tau.vercel.app` (로컬 서버로 바꾸려면 `COIN_API_BASE=http://localhost:3300`)
- 앱에는 `GET /api/price` 가 **없다.** 시세는 업비트 공개 API 를 쓴다 (전략의 공식 판단 데이터도 업비트).
- 주문은 `POST /api/orders` (복수형). 지갑은 `GET /api/wallet`.

---

## 1. 원칙 읽기

`../../../week-4/quest/research/my-strategy.md` 를 **처음부터 끝까지** 읽는다. 특히 확인할 것:

- 원칙 1 종목(BTC·ETH·XRP) · 원칙 2 주간 -3% 이하 · 원칙 3 매도 ①②③
- 상한: 1회 30만 원 / 코인당 원가 40만 원 / 같은 코인 하루 1회 / 최소 5,000원
- 금지 조건: **FOMC 금리 결정 발표**, **미 의회 가상자산 법안 표결**의 전날·당일 매수 금지
- 공통 기준: 뉴스·AI 브리핑·공포탐욕지수는 **참고만** 하고 판단에는 쓰지 않는다

전략 숫자가 `scripts/lib.mjs` 의 `STRATEGY` 와 다르면 **멈추고 사용자에게 알린다.** (임의로 고치지 않는다)

## 2. 시세 조회

```bash
node scripts/price.mjs
```

전략 3종목 + 보유 코인의 현재가, 업비트 일봉 10개, 주간 등락률을 `data/{오늘}/price.json` 에 남긴다.
09:00 KST 전에는 오늘 일봉이 없어 매수 판단을 할 수 없다 → 09:00 이후에 실행한다.

## 3. 리서치 — 최소 3개 소스

**웹은 반드시 Playwright MCP**(`mcp__playwright__browser_*`)로 직접 연다. 아래 세 갈래에서 각각 1곳 이상, 합계 3곳 이상.

| 갈래 | 예시 | 도구 |
|---|---|---|
| 뉴스 | 네이버 뉴스 검색 "비트코인" 최신순, 토큰포스트, 코인데스크코리아, 블록미디어 | Playwright |
| 커뮤니티 | 업비트 공포·탐욕 지수 / 코인니스 / 디시 비트코인 갤러리 / 레딧 r/CryptoCurrency | Playwright |
| 영상 | 유튜브 "비트코인 오늘" 최신순 → 이번 주 영상 1개 | yt-dlp (+ Whisper) |

**영상 처리**

```bash
# 자막만 (한국어 자동 자막) — 저장 위치는 data/{오늘}/video
powershell -NoProfile -ExecutionPolicy Bypass -File "../../../.claude/skills/youtube-transcript/scripts/fetch.ps1" -Url "<URL>" -OutDir "data/{오늘}/video" -SubsOnly
powershell -NoProfile -ExecutionPolicy Bypass -File "../../../.claude/skills/youtube-transcript/scripts/srt-clean.ps1" -Path "data/{오늘}/video/<파일>.ko.srt" -Out "data/{오늘}/video/transcript.md"
```

- 자막이 없는 영상이면: `whisper` 명령이 있을 때만 `yt-dlp -x --audio-format mp3` 로 음성을 받아 `whisper <mp3> --language ko --model small` 로 받아쓴다. **없으면 자막 있는 다른 영상을 고른다.** (이 PC에는 2026-10-09 기준 Python·Whisper 가 설치돼 있지 않다)
- 자동 자막은 고유명사·수치가 틀릴 수 있다 → 수치는 다른 소스와 교차 확인한다.

**금지 이벤트 확인 (판단에 직접 쓰이는 유일한 리서치)**

- 연준 FOMC 일정: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- 미 의회 가상자산 법안 표결 일정: 상원/하원 공식 일정 또는 이를 한국 시각으로 인용한 보도
- 오늘부터 **최소 2주 앞**까지 확인해 `events.json` 을 갱신하고 `checkedAt` 을 `{오늘}` 로 바꾼다.

```json
{
  "checkedAt": "2026-10-09",
  "events": [
    { "name": "FOMC 금리 결정 발표", "kst": "2026-10-29T03:00:00+09:00", "source": "https://..." },
    { "name": "美 하원 ○○법 표결", "usDate": "2026-10-20", "source": "https://..." },
    { "name": "美 상원 ○○법 표결 (날짜 미정)", "unconfirmedUntil": "2026-10-16", "source": "https://..." }
  ]
}
```

- `kst`: 시각을 알면 한국 시각 / `usDate`: 미국 날짜만 알 때 / `unconfirmedUntil`: "이번 주" 처럼 날짜를 모르면 그날까지 매수 금지
- `checkedAt` 이 오늘이 아니면 `decide.mjs` 가 금지 조건을 "확인 불가"로 보고 **매수하지 않는다.**

## 4. 분위기 갱신 — `market-mood.md`

오늘 날짜로 **덮어쓴다.** 모든 수치·주장 옆에 **근거 링크**를 단다. 형식:

```markdown
# 코인시장 분위기 — {오늘} ({요일})

> **수집 시각**: {HH:MM} KST · **소스**: {n}곳 (뉴스 {a} · 커뮤니티 {b} · 영상 {c})
> **주의**: 뉴스·커뮤니티·영상은 my-strategy.md 공통 기준에 따라 **참고용**이며, 매매 판단은 업비트 시세와 공식 일정으로만 합니다.

## 한 줄 요약
## 1. 시세 (업비트, price.json)          ← 현재가 · 24h · 주간 등락률 표
## 2. 뉴스                                ← 기사별 한 줄 + [매체](링크)
## 3. 커뮤니티 · 심리 지표                 ← 공포·탐욕 등 + 링크. 출처마다 다르면 다르다고 쓴다
## 4. 영상                                ← 제목·채널·링크·핵심 3줄 (자동 자막 기반임을 명시)
## 5. 금지 이벤트 일정 (events.json)       ← 미국 시각 / 한국 시각 / 금지 날짜 / 공식 링크
## 분위기 판단                            ← 🟢🟡🔴 표 + 종합
## 근거 링크                              ← 이 문서에 쓴 모든 URL 목록
```

## 5. 판단

```bash
node scripts/decide.mjs
```

- 규칙 계산은 스크립트가 한다. **에이전트가 결과를 바꾸지 않는다.** 뉴스가 아무리 나빠도/좋아도 규칙이 "매수"면 매수, "관망"이면 관망이다.
- 결론은 **매수 / 매도 / 관망** 중 하나 (매도 규칙이 걸리면 매도가 우선, 그날 매수 주문도 함께 있으면 리포트에 모두 적는다).
- 결론의 **이유를 한 문단**(3~5문장)으로 쓴다: 어떤 규칙이 통과·탈락했는지(숫자 포함) → 리서치에서 본 분위기가 참고로 어땠는지 → 그래서 무엇을 하는지.
- `❔ 확인 불가` 가 남아 있으면 그 원인(대개 events.json)을 먼저 해결하고 다시 실행한다.

## 6. 주문 실행

```bash
node scripts/order.mjs --memo "<판단 근거 한 줄>"            # 미리보기
node scripts/order.mjs --memo "<판단 근거 한 줄>" --execute  # 실제 체결
```

- 미리보기로 금액·수량·memo 를 확인한 뒤 `--execute` 로 체결한다. 체결가는 실행 직전 업비트 현재가.
- memo 칼럼은 200자 제한 → `[에이전트 {결론}] {규칙} · {수치} · {근거 한 줄}` 로 자동 조립된다. 근거 한 줄은 60자 안팎으로.
- 관망이면 주문 없이 `orders.json` 에 빈 기록만 남긴다.
- 같은 날 `orders.json` 이 이미 있으면 스크립트가 멈춘다. **`--force` 는 사용자가 허락할 때만** 쓴다.
- 실패하면 오류 메시지를 리포트에 그대로 남기고 재시도하지 않는다.

## 7. 리포트 — `reports/{오늘}.md`

```bash
node scripts/wallet.mjs   # 지갑 표 (리포트에 그대로 붙인다)
```

```markdown
# 모의투자 리포트 — {오늘} ({요일})

> 실행 {HH:MM} KST · 앱 {API_BASE} · 전략 week-4/quest/research/my-strategy.md

## 오늘의 판단: {매수 | 매도 | 관망}
{5단계의 이유 한 문단}

## 규칙 점검                ← decide.mjs 출력의 매수 점검 · 매도 점검 표
## 주문 실행                ← 체결 번호 · 코인 · 금액/수량 · 체결가 · memo (관망이면 "주문 없음")
## 근거                     ← 시세 수치 + market-mood.md 요약 3줄 + 주요 링크
## 지갑 상태 · 누적 수익률   ← wallet.mjs 출력
## 내일 볼 것               ← 다가오는 금지 이벤트, 손절/익절선까지 남은 거리 등
```

마지막으로 사용자에게 **결론 · 주문 결과 · 누적 수익률 · 리포트 경로**를 짧게 보고한다.
