---
name: recipe-card
description: "레시피북에 새 요리 레시피를 카드 형식으로 추가할 때 사용한다. 트리거: '저녁 메뉴 추천', '15분 레시피', '레시피 만들어줘', '레시피북에 추가', 'recipe' 요청 등 요리 레시피를 문서로 남겨달라는 모든 요청. 정해진 마크다운 템플릿으로 작성하고, Gemini 이미지 모델(Nano Banana)로 지브리풍 썸네일을 생성해 상단에 삽입한 뒤 커밋까지 처리한다. 단순히 요리법을 말로만 물어보는 경우(파일로 남길 필요 없음)에는 사용하지 않는다."
---

# 레시피 카드 작성

`week-1/quesks/레시피북/`에 레시피 한 편을 마크다운 카드로 남긴다. 썸네일 이미지 1장이 항상 함께 간다.

## 워크플로

1. **요구사항 확인** — 소요 시간, 인분, 식사 시간대, 재료 제약. 사용자가 안 밝혔으면 상식선에서 정하고 결과에 명시한다. 되묻지 말 것.
2. **레시피 본문 작성** — 아래 템플릿 그대로. 파일명은 `<요리명-케밥케이스>.md` (한글 유지, 공백은 `-`). 예: `간장버터-치킨덮밥.md`
3. **썸네일 생성** — `scripts/gen-thumbnail.ps1` 실행. 이미지는 `.md`와 같은 폴더에 `<같은-슬러그>.png`로 저장.
4. **이미지 확인** — Read 도구로 생성된 PNG를 직접 열어본다. 요리가 레시피와 다르게 나왔거나(재료 불일치) 이상하면 프롬프트를 고쳐 재생성한다. 확인 없이 삽입하지 말 것.
5. **삽입 → 커밋** — 제목 바로 아래 상대경로로 이미지 삽입 후, 사용자가 커밋을 요청하면 커밋한다.

## 마크다운 템플릿

````markdown
# {요리명} ({N}분)

![{이미지 대체 텍스트 — 장면 묘사}]({슬러그}.png)

> {한 줄 후킹 — 왜 이 요리인지. 예: "팬 하나로 끝나는 저녁. 밥만 있으면 완성."}

- **소요 시간** {N}분
- **분량** {N}인분
- **난이도** {쉬움 / 보통 / 어려움}

## 재료

- {재료} {분량} — {손질법}
- (선택) {부가 재료}

### 양념장

| 재료 | 분량 |
|---|---|
| ... | ... |

## 만드는 법

1. **{단계명} ({N}분)**
   {동작 설명}
   *{왜 이렇게 하는지 — 실패 방지 포인트}*

## 곁들이면 좋은 것

- **{항목}** — {한 줄 이유}

## 팁

- {대체 재료 / 맛 조절 / 리커버리 방법}
````

작성 규칙:

- **각 단계에 소요 시간을 붙인다.** 총합이 제목의 분 수와 맞아야 한다.
- **이탤릭 팁은 "왜"를 설명한다.** "물기를 닦아야 겉이 바삭하게 구워진다" 처럼 원리를 적는다. 단계마다 넣을 필요는 없고, 실패하기 쉬운 곳에만.
- 양념장이 있으면 표로 뺀다. 계량은 큰술/작은술/개 단위로 통일.
- 팁에는 최소 하나의 **대체 재료**와 **맛 조절 방법**을 넣는다.

## 썸네일 생성

API 키는 `.claude/settings.local.json`의 `env` 블록에 보관되어 있고, 세션 시작 시 `GEMINI_API_KEY` 환경변수로 자동 주입된다. **사용자에게 키를 다시 묻지 않는다.**

```powershell
& ".claude\skills\recipe-card\scripts\gen-thumbnail.ps1" `
    -OutPath "week-1\quesks\레시피북\<슬러그>.png" `
    -Prompt  "<아래 프롬프트>"
```

`ERROR: no API key`가 나오면 세션이 설정 파일보다 먼저 시작된 것이다. 사용자에게 Claude Code 재시작을 안내하거나, 이번 실행에 한해 파일에서 직접 읽어 넘긴다:

```powershell
$k = (Get-Content .claude\settings.local.json -Raw | ConvertFrom-Json).env.GEMINI_API_KEY
& ".claude\skills\recipe-card\scripts\gen-thumbnail.ps1" -ApiKey $k -OutPath "..." -Prompt "..."
```

키 취급 규칙: `.claude/settings.local.json`은 `.gitignore`에 등록되어 있다. 키를 커밋되는 파일(SKILL.md, 스크립트, 레시피 문서)에 절대 쓰지 않는다. 사용자가 채팅에 새 키를 붙여넣으면 settings.local.json을 갱신하고, 노출된 이전 키는 폐기·재발급을 안내한다.

기본 모델은 `gemini-2.5-flash-image` (Nano Banana). 실패하면 `-Model gemini-2.5-flash-image-preview`로 재시도.

PowerShell 도구 안에서 위처럼 `&`로 바로 호출하면 된다. Bash 도구에서 `powershell -NoProfile`로 감싸 호출하면 실행 정책(ExecutionPolicy)에 막히므로, 그 경우 `powershell -NoProfile -ExecutionPolicy Bypass -File <경로>` 형태로 실행한다.

### 이미지 프롬프트 틀

지브리풍 오마주로 간다. **특정 영화의 장면이나 캐릭터를 그대로 복제하도록 지시하지 않는다** — 화풍과 분위기만 차용해야 모델 필터도 통과하고 저작권 문제도 없다. "센과 치히로", "토토로" 같은 작품·캐릭터 이름을 프롬프트에 넣지 말 것.

```text
A warm, hand-painted Japanese anime film still in the style of classic 1990s
Studio Ghibli cel animation.
{인물 묘사 — 예: A young girl with a short dark bob haircut}
sits at a low wooden table inside {배경 — 예: a cozy lantern-lit dining room at night}.
{요리 묘사 — 레시피의 실제 재료를 그대로 적을 것}.
{동작 — 예: She holds chopsticks lifting a bite toward her mouth, eyes wide with delight}.
Rich golden lamplight, wisps of steam rising from the bowl,
lovingly detailed food rendering.
Nostalgic, tender atmosphere. Soft watercolor backgrounds, visible film grain,
cinematic composition.
```

요리 묘사는 레시피 재료와 일치시킨다. 반숙 달걀을 올린 레시피면 프롬프트에도 `a soft egg`를 넣는다.

## 커밋

메시지는 한국어, `<요리명>: <변경 요약>` 형식.

```
간장버터 치킨덮밥: 곁들임에 칠리소스 추가

달큰한 간장 소스에 새콤·매콤함을 더하는 조합으로 직접 확인한 팁.
```

`.md`와 `.png`를 같은 커밋에 넣는다.
