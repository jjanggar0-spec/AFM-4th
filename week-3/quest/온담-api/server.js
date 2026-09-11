// ─────────────────────────────────────────────
// 온담 API — OpenAI 기반 병원 홍보 상담 서버
// 로컬(node server.js) / Vercel 서버리스 듀얼 모드
//
// 보안 원칙
//  1. API 키는 서버 프로세스 안에만 둔다. 응답·로그 어디에도 싣지 않는다.
//  2. 기본은 127.0.0.1 만 수신한다. 외부 개방은 명시적으로 선택해야 한다.
//  3. 키가 새더라도 피해가 제한되도록 호출 한도를 서버가 직접 건다.
// ─────────────────────────────────────────────

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── .env 로드 ────────────────────────────────
// 우선순위: 실제 환경변수 > ONDAM_ENV_FILE > ~/.ondam/.env > ./.env
// 클라우드 동기화 폴더(OneDrive 등) 밖에 두는 편이 안전하다.
const ENV_CANDIDATES = [
  process.env.ONDAM_ENV_FILE,
  path.join(os.homedir(), '.ondam', '.env'),
  path.join(__dirname, '.env')
].filter(Boolean);

let ENV_FILE_USED = null;
(function loadEnv() {
  for (const file of ENV_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0) continue;
      const key = s.slice(0, i).trim();
      if (process.env[key] === undefined) {
        process.env[key] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
    ENV_FILE_USED = file;
    break;
  }
})();

const app = express();
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3000);
const HOST = (process.env.HOST || '127.0.0.1').trim();
const API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ── 사용 한도 (키가 새더라도 피해를 묶어두는 안전장치) ──
const LIMITS = {
  windowMs: 10 * 60 * 1000,
  perIp: Number(process.env.MAX_REQUESTS_PER_WINDOW || 20),
  concurrent: Number(process.env.MAX_CONCURRENT || 3),
  dailyRequests: Number(process.env.MAX_DAILY_REQUESTS || 200),
  dailyTokens: Number(process.env.MAX_DAILY_TOKENS || 200000)
};

// ── 인메모리 저장소 ──────────────────────────
const sessions = new Map();   // sessionId -> { messages, updatedAt }
const hits = new Map();       // ip -> [timestamp]
let inFlight = 0;
let usage = { day: today(), requests: 0, tokens: 0 };

const MAX_TURNS = 24;
const MAX_SESSIONS = 500;
const SESSION_TTL = 1000 * 60 * 60 * 6;

function today() { return new Date().toISOString().slice(0, 10); }
function rollDay() { if (usage.day !== today()) usage = { day: today(), requests: 0, tokens: 0 }; }
function maskKey(k) { return k ? `${k.slice(0, 7)}…${k.slice(-4)} (${k.length}자)` : '없음'; }

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    s = { messages: [], updatedAt: Date.now() };
    sessions.set(id, s);
  }
  s.updatedAt = Date.now();
  return s;
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.updatedAt > SESSION_TTL) sessions.delete(id);
  for (const [ip, list] of hits) {
    const kept = list.filter(t => now - t < LIMITS.windowMs);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
}

// ── 온담의 성격 (system 프롬프트) ─────────────
const SYSTEM_PROMPT = [
  "당신은 '온담'이라는 이름의 병원 홍보 전문 상담 에이전트입니다. 한국의 병·의원 원장님과 마케팅 담당자를 상대합니다.",
  "",
  "[성격과 말투]",
  "- 차분합니다. 서두르지 않고, 놀라거나 과장하지 않습니다.",
  "- 부드러운 존댓말을 씁니다. '~해보시면 어떨까요', '~하시는 편이 좋습니다' 같은 어조를 씁니다.",
  "- 느낌표를 거의 쓰지 않습니다. 이모지를 쓰지 않습니다.",
  "- 상대를 가르치려 들지 않습니다. 어려운 마케팅 용어는 쉬운 말로 풀어 씁니다.",
  "- 답변은 보통 3~6문단, 필요할 때만 짧은 목록을 씁니다. 장황하게 늘이지 않습니다.",
  "",
  "[상담 원칙]",
  "- 상황을 모르면 먼저 한두 가지를 여쭙습니다. 진료과목, 개원 시기, 위치, 지금 하고 있는 채널, 신환 수 같은 것들입니다.",
  "- 다만 매번 되묻지는 않습니다. 이미 충분히 들었으면 바로 답을 드립니다.",
  "- 추상적인 조언 대신 이번 주에 해볼 수 있는 구체적인 행동을 제안합니다.",
  "- 비용이 드는 제안을 할 때는 대략의 금액대와, 돈을 쓰지 않는 대안을 함께 말씀드립니다.",
  "- 효과를 장담하지 않습니다. '보통 이런 경우가 많습니다' 정도로 말합니다.",
  "- 모르는 것은 모른다고 말합니다. 통계나 수치를 지어내지 않습니다.",
  "",
  "[반드시 지킬 것]",
  "- 의료법 제56조(의료광고 금지) 위반 소지가 있는 제안은 하지 않습니다.",
  "  치료 효과 보장, 최상급 표현('최고', '유일', '1위'), 환자 유인·알선, 비급여 할인 이벤트, 심의받지 않은 광고 문구가 여기에 해당합니다.",
  "- 광고성 게시물을 제안할 때는 사전심의 대상 여부를 짧게 덧붙입니다.",
  "- 환자 후기·치료 전후 사진 활용은 규제가 까다로우므로 신중하게 안내합니다.",
  "- 병원 홍보와 무관한 질문에는 부드럽게 범위를 알리고, 대신 도울 수 있는 것을 말씀드립니다.",
  "",
  "모든 답변은 한국어로 합니다."
].join('\n');

// ── 보안 헤더 ────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '64kb' }));

// 정적 서빙은 화면 파일 하나로 제한한다.
// 폴더 전체를 열면 server.js·package.json·node_modules·.env 까지 함께 노출된다.
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 접근 통제 ────────────────────────────────
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkPassword(req, res) {
  if (!APP_PASSWORD) return true;
  if ((req.get('x-app-password') || '') === APP_PASSWORD) return true;
  res.status(401).json({ success: false, code: 'auth_required', message: '접속 암호가 필요합니다.' });
  return false;
}

function checkLimits(res, ip) {
  rollDay();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < LIMITS.windowMs);

  if (list.length >= LIMITS.perIp) {
    res.status(429).json({ success: false, code: 'rate_limited', message: '요청이 너무 잦습니다. 10분 뒤에 다시 시도해 주세요.' });
    return false;
  }
  if (inFlight >= LIMITS.concurrent) {
    res.status(429).json({ success: false, code: 'busy', message: '지금 처리 중인 요청이 많습니다. 잠시 뒤에 보내주세요.' });
    return false;
  }
  if (usage.requests >= LIMITS.dailyRequests) {
    res.status(429).json({ success: false, code: 'daily_cap', message: '오늘 사용 한도에 도달했습니다. 내일 다시 이용해 주세요.' });
    return false;
  }
  if (usage.tokens >= LIMITS.dailyTokens) {
    res.status(429).json({ success: false, code: 'token_cap', message: '오늘 토큰 한도에 도달했습니다. 내일 다시 이용해 주세요.' });
    return false;
  }

  list.push(now);
  hits.set(ip, list);
  return true;
}

// ── 상태 확인 ────────────────────────────────
app.get('/api/health', (_req, res) => {
  rollDay();
  res.json({
    success: true,
    data: {
      model: MODEL,
      keyConfigured: Boolean(API_KEY),   // 키 값 자체는 절대 내려보내지 않는다
      passwordRequired: Boolean(APP_PASSWORD),
      sessions: sessions.size,
      usage: {
        requestsToday: usage.requests,
        tokensToday: usage.tokens,
        dailyRequestLimit: LIMITS.dailyRequests,
        dailyTokenLimit: LIMITS.dailyTokens
      }
    }
  });
});

// ── 대화 기록 조회 ───────────────────────────
app.get('/api/history/:sessionId', (req, res) => {
  if (!checkPassword(req, res)) return;
  const s = sessions.get(req.params.sessionId);
  res.json({ success: true, data: s ? s.messages : [] });
});

// ── 대화 초기화 ──────────────────────────────
app.post('/api/reset', (req, res) => {
  if (!checkPassword(req, res)) return;
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId가 필요합니다.' });
  sessions.delete(sessionId);
  res.json({ success: true, data: { sessionId } });
});

// ── 상담 (SSE 스트리밍) ──────────────────────
app.post('/api/chat', async (req, res) => {
  if (!checkPassword(req, res)) return;

  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
    return res.status(400).json({ success: false, message: 'sessionId가 올바르지 않습니다.' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, message: '질문 내용이 비어 있습니다.' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ success: false, message: '질문이 너무 깁니다. 4000자 이내로 적어주세요.' });
  }
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: '서버에 OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해 주세요.' });
  }
  if (!checkLimits(res, clientIp(req))) return;

  sweep();
  const session = getSession(sessionId);
  const userMessage = { role: 'user', content: message.trim() };
  const history = session.messages.slice(-MAX_TURNS);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // req 의 'close' 는 본문을 다 읽은 시점에도 발생하므로 res 를 기준으로 판단한다.
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  inFlight++;
  usage.requests++;
  let answer = '';

  try {
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, userMessage]
      })
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      let detail = {};
      try { detail = JSON.parse(raw).error || {}; } catch { /* JSON 이 아닐 수 있다 */ }
      console.error(`[chat] OpenAI ${upstream.status} ${detail.code || detail.type || ''}`);
      finished = true;
      send('error', {
        code: detail.code || detail.type || `http_${upstream.status}`,
        message: friendlyError(upstream.status, detail)
      });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          if (chunk.usage && chunk.usage.total_tokens) usage.tokens += chunk.usage.total_tokens;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            answer += delta;
            send('delta', { delta });
          }
        } catch { /* 조각난 JSON 은 다음 루프에서 이어붙는다 */ }
      }
    }

    if (!answer.trim()) {
      finished = true;
      send('error', { code: 'empty_completion', message: '답변이 만들어지지 않았습니다. 질문을 조금 더 구체적으로 적어주세요.' });
      return res.end();
    }

    session.messages.push(userMessage, { role: 'assistant', content: answer });
    if (session.messages.length > MAX_TURNS) session.messages = session.messages.slice(-MAX_TURNS);

    finished = true;
    send('done', { text: answer });
    res.end();

  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer.trim()) session.messages.push(userMessage, { role: 'assistant', content: answer });
      return res.end();
    }
    console.error('[chat]', err.message);   // 스택·본문을 그대로 남기지 않는다
    send('error', { code: 'upstream_error', message: '연결이 잠시 끊겼습니다. 다시 보내주세요.' });
    res.end();
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
});

function friendlyError(status, detail) {
  const code = detail.code || detail.type || '';
  if (code === 'credit_balance_exhausted' || code === 'insufficient_quota') {
    return 'OpenAI 계정에 크레딧이 없습니다. 결제 설정에서 크레딧을 충전한 뒤 다시 시도해 주세요.';
  }
  if (status === 401) return 'API 키가 거부되었습니다. 키가 폐기되었는지 확인하고 설정을 갱신해 주세요.';
  if (status === 404) return `모델 '${MODEL}'을 찾을 수 없습니다. OPENAI_MODEL 값을 확인해 주세요.`;
  if (status === 429) return '요청이 잠시 몰렸습니다. 조금 뒤에 다시 보내주세요.';
  if (status >= 500) return 'OpenAI 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
  return detail.message || '요청을 처리하지 못했습니다.';
}

// ── 그 밖의 경로 (Express 5 문법) ────────────
// 존재하지 않는 API 는 404 로, 나머지는 화면으로 돌려보낸다.
app.all('/api/{*splat}', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 경로입니다.' });
});
app.get('/{*splat}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (res.headersSent) return res.end();
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── 기동 전 안전 점검 ────────────────────────
function safetyReport() {
  const warn = [];
  if (!API_KEY) warn.push('OPENAI_API_KEY가 없습니다. 설정 파일을 확인하세요.');
  if (ENV_FILE_USED && /OneDrive|Dropbox|Google ?Drive|iCloud/i.test(ENV_FILE_USED)) {
    warn.push(`.env가 클라우드 동기화 폴더에 있습니다 → ${ENV_FILE_USED}`);
    warn.push(`권장 위치: ${path.join(os.homedir(), '.ondam', '.env')} (서버가 자동으로 먼저 찾습니다)`);
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !APP_PASSWORD) {
    warn.push(`외부(${HOST})에 열려 있는데 APP_PASSWORD가 없습니다. 누구나 이 키로 요청할 수 있습니다.`);
  }
  return warn;
}

if (require.main === module) {
  const warn = safetyReport();
  app.listen(PORT, HOST, () => {
    console.log('──────────────────────────────────────────────');
    console.log(`온담 API 서버 → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`모델      : ${MODEL}`);
    console.log(`API 키    : ${maskKey(API_KEY)}`);
    console.log(`설정 파일 : ${ENV_FILE_USED || '없음 (환경변수만 사용)'}`);
    console.log(`수신 주소 : ${HOST}${HOST === '127.0.0.1' ? ' — 이 컴퓨터에서만 접속 가능' : ''}`);
    console.log(`접속 암호 : ${APP_PASSWORD ? '설정됨' : '없음'}`);
    console.log(`일일 한도 : ${LIMITS.dailyRequests}회 / ${LIMITS.dailyTokens.toLocaleString()}토큰`);
    if (warn.length) {
      console.log('──────────────────────────────────────────────');
      warn.forEach(w => console.log(`  ⚠ ${w}`));
    }
    console.log('──────────────────────────────────────────────');
  });
}
module.exports = app;
