// ─────────────────────────────────────────────
// 물빛 화실 — fal.ai 기반 수채화 이미지 생성 서버
// 로컬(node server.js) / Vercel 서버리스 듀얼 모드
//
// 보안 원칙
//  1. fal.ai 키는 서버 프로세스 안에만 둔다. 응답·로그 어디에도 싣지 않는다.
//  2. 기본은 127.0.0.1 만 수신한다. 외부 개방은 명시적으로 선택해야 한다.
//  3. 키가 새더라도 비용이 묶이도록 생성 한도를 서버가 직접 건다.
// ─────────────────────────────────────────────

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── 설정 파일 로드 ───────────────────────────
// 우선순위: 실제 환경변수 > MULBIT_ENV_FILE > ~/.mulbit/.env > ./.env
const ENV_CANDIDATES = [
  process.env.MULBIT_ENV_FILE,
  path.join(os.homedir(), '.mulbit', '.env'),
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

const PORT = Number(process.env.PORT || 3200);
const HOST = (process.env.HOST || '127.0.0.1').trim();
const FAL_KEY = (process.env.FAL_KEY || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const FAL_BASE = 'https://fal.run';
const LLM_MODEL = (process.env.FAL_LLM_MODEL || 'anthropic/claude-haiku-4.5').trim();

const LIMITS = {
  windowMs: 10 * 60 * 1000,
  perIp: Number(process.env.MAX_PAINTS_PER_WINDOW || 10),   // IP당 10분 10장
  concurrent: Number(process.env.MAX_CONCURRENT || 2),
  daily: Number(process.env.MAX_DAILY_PAINTS || 60)          // 하루 60장
};

// ── 수채화 표현 사전 ─────────────────────────
// 화면의 선택지를 FLUX 가 잘 알아듣는 영문 묘사로 옮긴다.
const PRESETS = {
  paper: [
    { id: 'hot',   label: '세목', note: '매끈 · 선명', prompt: 'on smooth hot-press watercolor paper, crisp edges, fine controlled detail' },
    { id: 'cold',  label: '중목', note: '기본 · 부드러움', prompt: 'on cold-press watercolor paper with gentle tooth, balanced soft edges' },
    { id: 'rough', label: '황목', note: '거침 · 붓자국', prompt: 'on rough watercolor paper, pronounced paper texture, broken dry edges, granulating pigment settling in the grain' }
  ],
  water: [
    { level: 1, label: '마른붓',   prompt: 'dry brush technique, controlled deliberate strokes, almost no bleeding' },
    { level: 2, label: '적게',     prompt: 'mostly wet-on-dry layering, clean glazes, a few soft edges' },
    { level: 3, label: '보통',     prompt: 'mix of wet-in-wet and wet-on-dry, soft transitions with some defined shapes' },
    { level: 4, label: '넉넉히',   prompt: 'generous wet-in-wet washes, soft bleeding edges, gentle pigment blooms' },
    { level: 5, label: '흠뻑 번짐', prompt: 'very wet-on-wet, loose flowing washes, cauliflower blooms and backruns, colors bleeding freely into each other' }
  ],
  palette: [
    { id: 'payne',  label: '페인즈그레이', swatch: ['#3e4a57', '#6b7784', '#a9b2bb', '#e3e7ea'], prompt: "limited monochrome palette of Payne's grey and indigo, quiet tonal values" },
    { id: 'classic',label: '울트라마린·번트시에나', swatch: ['#3d5ba9', '#7d8fc4', '#a8643a', '#d9b28f'], prompt: 'classic two-pigment palette of ultramarine blue and burnt sienna, neutral greys mixed on paper' },
    { id: 'spring', label: '봄 파스텔', swatch: ['#e6a2ae', '#f1dd8a', '#9cc19a', '#a9c7e4'], prompt: 'airy pastel palette of rose madder, lemon yellow, sap green and cerulean, light and luminous with lots of white paper showing' },
    { id: 'dusk',   label: '해질녘', swatch: ['#d8a13a', '#b5485d', '#8a6aa8', '#394a7a'], prompt: 'warm dusk palette of quinacridone gold, alizarin crimson, cobalt violet and indanthrone blue' }
  ],
  size: [
    { id: 'square_hd',     label: '정사각', note: '1024×1024' },
    { id: 'portrait_4_3',  label: '세로',   note: '768×1024' },
    { id: 'landscape_4_3', label: '가로',   note: '1024×768' }
  ],
  quality: [
    { id: 'draft', label: '초벌', note: '빠르고 저렴 · 몇 초', model: 'fal-ai/flux/schnell', params: { num_inference_steps: 4 } },
    { id: 'final', label: '완성', note: '정교함 · 10~30초',  model: 'fal-ai/flux/dev',     params: { num_inference_steps: 28, guidance_scale: 3.5 } }
  ]
};

const BASE_STYLE = 'traditional hand-painted watercolor, translucent layered washes, visible paper texture, natural pigment granulation, white of the paper used for highlights, painterly and loose';
// FLUX 는 부정문을 잘 따르지 않고 오히려 그 단어에 끌려간다 ('no signature' → 서명이 그려짐).
// 그래서 피하고 싶은 것은 적지 않고, 원하는 상태만 긍정문으로 적는다.
const GUARD = 'the painting fills the sheet, surrounded by clean unmarked white paper margins, painted by hand with a brush';

function find(list, key, value, fallbackIndex) {
  return list.find(x => x[key] === value) || list[fallbackIndex];
}

function buildPrompt(subject, paper, water, palette) {
  return [
    `A watercolor painting of ${subject}`,
    paper.prompt,
    water.prompt,
    palette.prompt,
    BASE_STYLE,
    GUARD
  ].join('. ') + '.';
}

// ── 한국어 장면 → 영문 ───────────────────────
// FLUX 는 한국어를 거의 이해하지 못한다. 같은 fal 키로 fal-ai/any-llm 을 불러 옮긴다.
// 응답 형식(실측): { output: "...", reasoning: null, partial: false, error: null }
const TRANSLATE_SYSTEM = [
  'You convert a Korean scene description into a concise English prompt for an image model.',
  'Translate faithfully: keep every concrete object, place, time of day, weather and spatial relationship exactly as written.',
  'Do not add objects, story, emotion, mood or style words. Do not mention painting, art or watercolor.',
  // 간판·책·포스터가 장면에 있으면 FLUX 가 엉터리 글자를 그려 넣는다. 빈 표면으로 묘사하게 한다.
  'If the scene has any shop, sign, signboard, book, poster, label, menu or screen, describe its surface as a plain blank board with nothing on it.',
  'Output only one English sentence without quotes.'
].join(' ');

function hasHangul(s) { return /[ㄱ-ㆎ가-힣]/.test(s); }

async function toEnglish(text) {
  try {
    const r = await fetch(`${FAL_BASE}/fal-ai/any-llm`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, system_prompt: TRANSLATE_SYSTEM, prompt: text }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error || typeof data.output !== 'string') {
      console.error(`[translate] fal ${r.status} ${typeof data.detail === 'string' ? data.detail.slice(0, 60) : ''}`);
      return null;
    }
    const out = data.output.trim().replace(/^["'“”]+|["'“”]+$/g, '').slice(0, 600);
    return out && !hasHangul(out) ? out : null;
  } catch (err) {
    console.error('[translate]', err.message);
    return null;
  }
}

// ── 인메모리 저장소 ──────────────────────────
const gallery = [];          // 최근 그림 (서버 재시작 시 초기화)
const GALLERY_MAX = 24;
const hits = new Map();      // ip -> [timestamp]
let inFlight = 0;
let usage = { day: today(), paints: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function rollDay() { if (usage.day !== today()) usage = { day: today(), paints: 0 }; }
function maskKey(k) { return k ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length}자)` : '없음'; }

// ── 보안 헤더 ────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '16kb' }));

// 정적 서빙은 화면 파일 하나로 제한한다 (폴더 전체를 열면 server.js 등이 노출된다).
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'server-index.html'));
});

// ── 접근 통제 ────────────────────────────────
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || 'unknown'; }

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
    res.status(429).json({ success: false, code: 'rate_limited', message: `10분에 ${LIMITS.perIp}장까지 그릴 수 있습니다. 잠시 쉬었다가 다시 그려주세요.` });
    return false;
  }
  if (inFlight >= LIMITS.concurrent) {
    res.status(429).json({ success: false, code: 'busy', message: '이미 그리고 있는 그림이 있습니다. 끝난 뒤에 다시 시도해 주세요.' });
    return false;
  }
  if (usage.paints >= LIMITS.daily) {
    res.status(429).json({ success: false, code: 'daily_cap', message: `오늘 그릴 수 있는 ${LIMITS.daily}장을 모두 사용했습니다. 내일 다시 이용해 주세요.` });
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  return true;
}

// ── 상태 · 선택지 ────────────────────────────
app.get('/api/health', (_req, res) => {
  rollDay();
  res.json({
    success: true,
    data: {
      keyConfigured: Boolean(FAL_KEY),        // 키 값은 절대 내려보내지 않는다
      passwordRequired: Boolean(APP_PASSWORD),
      usage: { paintsToday: usage.paints, dailyLimit: LIMITS.daily }
    }
  });
});

app.get('/api/options', (_req, res) => {
  // 영문 프롬프트·모델 파라미터는 내부 구현이므로 라벨만 내려보낸다.
  res.json({
    success: true,
    data: {
      paper:   PRESETS.paper.map(({ id, label, note }) => ({ id, label, note })),
      water:   PRESETS.water.map(({ level, label }) => ({ level, label })),
      palette: PRESETS.palette.map(({ id, label, swatch }) => ({ id, label, swatch })),
      size:    PRESETS.size,
      quality: PRESETS.quality.map(({ id, label, note }) => ({ id, label, note }))
    }
  });
});

// ── 갤러리 ───────────────────────────────────
app.get('/api/gallery', (req, res) => {
  if (!checkPassword(req, res)) return;
  res.json({ success: true, data: gallery });
});

// ── 그리기 ───────────────────────────────────
app.post('/api/paint', async (req, res) => {
  if (!checkPassword(req, res)) return;

  const body = req.body || {};
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';

  if (!subject) {
    return res.status(400).json({ success: false, message: '무엇을 그릴지 적어주세요.' });
  }
  if (subject.length > 500) {
    return res.status(400).json({ success: false, message: '장면 설명은 500자 이내로 적어주세요.' });
  }
  if (!FAL_KEY) {
    return res.status(500).json({ success: false, message: '서버에 FAL_KEY가 설정되지 않았습니다. 설정 파일을 확인해 주세요.' });
  }

  const paper   = find(PRESETS.paper, 'id', body.paper, 1);
  const water   = find(PRESETS.water, 'level', Number(body.water), 2);
  const palette = find(PRESETS.palette, 'id', body.palette, 1);
  const size    = find(PRESETS.size, 'id', body.size, 0);
  const quality = find(PRESETS.quality, 'id', body.quality, 0);

  let seed;
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
      return res.status(400).json({ success: false, message: '시드는 0 이상의 정수로 적어주세요.' });
    }
  }

  if (!checkLimits(res, clientIp(req))) return;

  inFlight++;
  usage.paints++;
  const started = Date.now();

  try {
    // 한글이 있으면 영문으로 옮긴다. 옮기지 못하면 원문 그대로 그린다.
    let subjectEn = null;
    let translation = 'skipped';
    if (hasHangul(subject)) {
      subjectEn = await toEnglish(subject);
      translation = subjectEn ? 'ok' : 'failed';
    }

    const prompt = buildPrompt(subjectEn || subject, paper, water, palette);
    const payload = {
      prompt,
      image_size: size.id,
      num_images: 1,
      enable_safety_checker: true,
      ...quality.params,
      ...(seed !== undefined ? { seed } : {})
    };

    const upstream = await fetch(`${FAL_BASE}/${quality.model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });

    const raw = await upstream.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { /* 본문이 JSON 이 아닐 수 있다 */ }

    if (!upstream.ok) {
      usage.paints = Math.max(0, usage.paints - 1);   // 그려지지 않은 요청은 한도에서 빼 준다
      console.error(`[paint] fal ${upstream.status} ${typeof data.detail === 'string' ? data.detail.slice(0, 80) : ''}`);
      const e = friendlyError(upstream.status, data);
      return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    }

    // 성공 응답에서 이미지 한 장을 꺼낸다. (images[] 가 표준, image 단일 필드도 대비)
    const img = (Array.isArray(data.images) && data.images[0]) || data.image || null;
    const nsfw = Array.isArray(data.has_nsfw_concepts) && data.has_nsfw_concepts[0] === true;

    if (nsfw) {
      return res.status(422).json({ success: false, code: 'safety_filtered', message: '안전 필터에 걸려 그림을 보여드릴 수 없습니다. 장면 표현을 조금 바꿔 주세요.' });
    }
    if (!img || !img.url) {
      console.error('[paint] 이미지 URL 없음');
      return res.status(502).json({ success: false, code: 'no_image', message: '그림이 만들어지지 않았습니다. 한 번 더 시도해 주세요.' });
    }

    const item = {
      id: crypto.randomUUID(),
      url: img.url,
      width: img.width || null,
      height: img.height || null,
      seed: data.seed ?? seed ?? null,
      subject,
      subjectEn,
      translation,
      paper: paper.label,
      water: water.label,
      palette: palette.label,
      size: size.label,
      quality: quality.label,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      createdAt: new Date().toISOString()
    };

    gallery.unshift(item);
    if (gallery.length > GALLERY_MAX) gallery.length = GALLERY_MAX;

    res.json({ success: true, data: item });

  } catch (err) {
    usage.paints = Math.max(0, usage.paints - 1);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ success: false, code: 'timeout', message: '그림이 2분 안에 완성되지 않았습니다. 초벌로 먼저 그려보시겠어요.' });
    }
    console.error('[paint]', err.message);
    res.status(502).json({ success: false, code: 'upstream_error', message: 'fal.ai에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.' });
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
});

// ── 내려받기 ─────────────────────────────────
// 갤러리에 있는 그림만 받는다. URL 을 요청으로 받지 않으므로 임의 주소 요청(SSRF)이 불가능하다.
app.get('/api/download/:id', async (req, res) => {
  if (!checkPassword(req, res)) return;
  const item = gallery.find(g => g.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: '그림을 찾을 수 없습니다. 서버가 다시 시작되었을 수 있습니다.' });

  try {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return res.status(502).json({ success: false, message: '원본 이미지를 받아오지 못했습니다.' });
    const type = r.headers.get('content-type') || 'image/jpeg';
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const stamp = item.createdAt.slice(0, 19).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="mulbit-${stamp}.${ext}"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('[download]', err.message);
    res.status(502).json({ success: false, message: '내려받기에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});

function friendlyError(status, data) {
  const detail = typeof data.detail === 'string' ? data.detail : '';
  if (status === 403 && /locked|top_?up|balance|credit/i.test(detail)) {
    return { status: 402, code: 'top_up_required', message: 'fal.ai 계정 잔액이 부족해 잠겨 있습니다. fal.ai 대시보드의 Billing에서 충전한 뒤 다시 그려주세요.' };
  }
  if (status === 401) {
    return { status: 502, code: 'invalid_key', message: 'fal.ai 키가 거부되었습니다. 키가 폐기되었는지 확인하고 설정 파일을 갱신해 주세요.' };
  }
  if (status === 422) {
    return { status: 400, code: 'rejected', message: '요청 형식이 거부되었습니다. 장면 설명을 조금 바꿔 다시 시도해 주세요.' };
  }
  if (status === 429) {
    return { status: 429, code: 'upstream_rate_limited', message: 'fal.ai 쪽 요청이 몰렸습니다. 잠시 후 다시 그려주세요.' };
  }
  if (status >= 500) {
    return { status: 502, code: 'upstream_down', message: 'fal.ai 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.' };
  }
  return { status: 502, code: `fal_${status}`, message: '그림을 그리지 못했습니다. 잠시 후 다시 시도해 주세요.' };
}

// ── 그 밖의 경로 (Express 5 문법) ────────────
app.all('/api/{*splat}', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 경로입니다.' });
});
app.get('/{*splat}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'server-index.html'));
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
  if (!FAL_KEY) warn.push('FAL_KEY가 없습니다. 설정 파일을 확인하세요.');
  if (ENV_FILE_USED && /OneDrive|Dropbox|Google ?Drive|iCloud/i.test(ENV_FILE_USED)) {
    warn.push(`설정 파일이 클라우드 동기화 폴더에 있습니다 → ${ENV_FILE_USED}`);
    warn.push(`권장 위치: ${path.join(os.homedir(), '.mulbit', '.env')}`);
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !APP_PASSWORD) {
    warn.push(`외부(${HOST})에 열려 있는데 APP_PASSWORD가 없습니다. 누구나 이 키로 그림을 생성할 수 있습니다.`);
  }
  return warn;
}

if (require.main === module) {
  const warn = safetyReport();
  app.listen(PORT, HOST, () => {
    console.log('──────────────────────────────────────────────');
    console.log(`물빛 화실 → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`fal 키    : ${maskKey(FAL_KEY)}`);
    console.log(`설정 파일 : ${ENV_FILE_USED || '없음 (환경변수만 사용)'}`);
    console.log(`수신 주소 : ${HOST}${HOST === '127.0.0.1' ? ' — 이 컴퓨터에서만 접속 가능' : ''}`);
    console.log(`접속 암호 : ${APP_PASSWORD ? '설정됨' : '없음'}`);
    console.log(`생성 한도 : 10분 ${LIMITS.perIp}장 / 하루 ${LIMITS.daily}장`);
    if (warn.length) {
      console.log('──────────────────────────────────────────────');
      warn.forEach(w => console.log(`  ⚠ ${w}`));
    }
    console.log('──────────────────────────────────────────────');
  });
}
module.exports = app;
