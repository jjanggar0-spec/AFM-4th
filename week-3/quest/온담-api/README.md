# 온담 API — 병원 홍보 상담 에이전트

OpenAI API를 사용하는 차분한 말투의 병원 홍보 상담 앱입니다.
[온담 상담실](../온담-상담실/) 아티팩트와 화면·성격은 같고, 답변 엔진만 OpenAI로 바뀌었습니다.

## 실행

```bash
cd week-3/quest/온담-api
npm install
node server.js
```

→ http://localhost:3000

## 설정 파일 위치

서버가 이 순서로 찾습니다. **먼저 찾은 것 하나만** 씁니다.

| 순위 | 위치 | 비고 |
|---|---|---|
| 1 | 실제 환경변수 | CI·배포 환경 |
| 2 | `ONDAM_ENV_FILE`이 가리키는 파일 | 경로 직접 지정 |
| 3 | `%USERPROFILE%\.ondam\.env` | **권장** — 클라우드 동기화 폴더 밖 |
| 4 | 이 프로젝트 폴더의 `.env` | OneDrive 안이면 기동 시 경고 |

`.env.example`을 복사해 채우세요. 항목 설명은 그 파일 안에 있습니다.

## API

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/api/health` | – | 모델·한도·오늘 사용량 (키 값은 포함하지 않음) |
| POST | `/api/chat` | `{sessionId, message}` | **SSE** — `delta` / `done` / `error` |
| GET | `/api/history/:sessionId` | – | `{success, data:[{role, content}]}` |
| POST | `/api/reset` | `{sessionId}` | `{success, data:{sessionId}}` |

`APP_PASSWORD`를 설정하면 `/api/chat`·`/api/history`·`/api/reset`에 `x-app-password` 헤더가 필요합니다.
`/api/health`는 암호 없이도 열리지만 상태만 알려주고 키는 내보내지 않습니다.

## 보안 설계

**키를 어디에 두는가**

- API 키는 서버 프로세스 안에만 존재합니다. 응답·로그·화면 어디에도 실리지 않습니다.
- 기동 로그에도 `sk-svca…zpkA (167자)` 형태로 가려서 찍습니다.
- 기본 설정 파일 위치를 홈 디렉터리(`~/.ondam/.env`)로 잡아 OneDrive 동기화를 피합니다.
  프로젝트 폴더의 `.env`를 쓰면 기동 시 경고가 뜹니다.

**누가 접근할 수 있는가**

- 기본 수신 주소는 `127.0.0.1`입니다. 같은 와이파이의 다른 기기는 접속할 수 없습니다.
- `HOST=0.0.0.0`으로 열 때 `APP_PASSWORD`가 없으면 기동 시 경고합니다.
- 정적 서빙은 `index.html` 하나로 제한했습니다. `server.js`·`package.json`·`node_modules`·`.env`는
  요청해도 화면만 돌아옵니다. (폴더 전체를 `express.static`으로 열면 백엔드 소스가 그대로 노출됩니다.)

**키가 또 새더라도 피해를 묶어두기**

| 한도 | 기본값 | 환경변수 |
|---|---|---|
| IP당 요청 | 10분 20회 | `MAX_REQUESTS_PER_WINDOW` |
| 동시 처리 | 3건 | `MAX_CONCURRENT` |
| 하루 요청 | 200회 | `MAX_DAILY_REQUESTS` |
| 하루 토큰 | 200,000 | `MAX_DAILY_TOKENS` |

토큰은 OpenAI 응답의 `usage`를 그대로 합산합니다. 한도에 닿으면 429와 함께 안내 문구를 돌려줍니다.
서버를 재시작하면 카운터가 초기화되므로, 장기 운영에는 별도 저장소가 필요합니다.

**응답 헤더** — `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy`(위치·마이크·카메라 차단),
`x-powered-by` 제거.

## 키가 유출되었을 때

코드로는 되돌릴 수 없습니다. 순서대로 하세요.

1. [platform.openai.com/api-keys](https://platform.openai.com/api-keys)에서 해당 키 **Revoke**
2. 새 키 발급 (프로젝트 범위를 좁게 잡으면 더 안전합니다)
3. `~/.ondam/.env`의 `OPENAI_API_KEY` 한 줄 교체
4. [사용량 페이지](https://platform.openai.com/usage)에서 모르는 호출이 있었는지 확인
5. 결제 설정에서 월 사용 한도(Usage limits)를 걸어두면 상한이 생깁니다

## 대화 저장

세션은 서버 메모리(`Map`)에 보관합니다. 세션당 최근 24개 메시지, 최대 500세션, 6시간 후 만료.
서버를 재시작하면 사라집니다. 영구 보관이 필요하면 DB를 붙여야 합니다.

## 에이전트 성격

`server.js`의 `SYSTEM_PROMPT` 상수에 있습니다. 말투(차분함·부드러운 존댓말·이모지 금지),
상담 원칙(먼저 되묻기·구체적 행동 제안·효과 장담 금지), 의료법 제56조 준수 규칙이 들어 있습니다.
성격을 바꾸려면 이 상수만 고치면 됩니다.

## Vercel 배포 시

`vercel.json`이 포함되어 있습니다. 배포할 때는

- `.env`를 올리지 말고 프로젝트 환경변수에 `OPENAI_API_KEY`를 등록하세요
- `APP_PASSWORD`를 반드시 설정하세요 (공개 URL이 되므로)
- 서버리스는 인스턴스마다 메모리가 달라 사용 한도·세션이 정확히 공유되지 않습니다.
  실제 운영에는 KV·Redis 같은 공유 저장소가 필요합니다.
