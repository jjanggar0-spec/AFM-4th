// 냉장고 재료 & 레시피 관리 — 재료 태그 등록/삭제 + 레시피 작성·수정·삭제·조회 + Gemini 레시피 자동 생성 API 서버 (Supabase PostgreSQL)

// ── Module imports ───────────────────────────
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
// PC 에 같은 이름의 환경변수(예: GEMINI_API_KEY)가 있어도 이 프로젝트의 .env 값을 우선한다
try { Object.assign(process.env, util.parseEnv(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'))); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

// 아래 상수는 index.html 의 같은 이름 상수와 값이 같아야 한다
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품·달걀', '양념·소스', '곡물·면', '기타'];
const NAME_MAX = 30;         // 재료 이름 글자 수
const TITLE_MAX = 60;        // 요리명 글자 수
const STEP_MAX = 500;        // 조리 단계 하나의 글자 수
const RECIPE_ITEMS_MAX = 30; // 레시피 하나의 재료 수 / 단계 수 상한
const LIST_LIMIT = 500;

// AI 레시피 자동 생성 (Google Gemini). 키가 비어 있으면 생성 기능만 꺼진다
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const GEMINI_TIMEOUT_MS = 30000;

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ingredients (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND ${NAME_MAX}),
    category   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ingredients_created_at_idx ON ingredients (created_at DESC);

  CREATE TABLE IF NOT EXISTS recipes (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${TITLE_MAX}),
    ingredients TEXT[]      NOT NULL DEFAULT '{}',
    steps       TEXT[]      NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS recipes_created_at_idx ON recipes (created_at DESC);

  ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE recipes     ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  ingredients            IS '냉장고에 있는 재료';
  COMMENT ON COLUMN ingredients.id         IS '재료 ID';
  COMMENT ON COLUMN ingredients.name       IS '재료 이름 (중복 불가)';
  COMMENT ON COLUMN ingredients.category   IS '분류 (채소 / 과일 / 육류 / 해산물 / 유제품·달걀 / 양념·소스 / 곡물·면 / 기타)';
  COMMENT ON COLUMN ingredients.created_at IS '등록일시';

  COMMENT ON TABLE  recipes             IS '직접 작성한 레시피';
  COMMENT ON COLUMN recipes.id          IS '레시피 ID';
  COMMENT ON COLUMN recipes.title       IS '요리명';
  COMMENT ON COLUMN recipes.ingredients IS '필요한 재료 이름 목록';
  COMMENT ON COLUMN recipes.steps       IS '조리법 (단계 순서대로)';
  COMMENT ON COLUMN recipes.created_at  IS '작성일시';
`;

// 서버리스 cold start 마다 불릴 수 있어 한 번만 실행되게 promise 를 공유한다
let dbInitPromise = null;
function initDB() {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
      await pool.query(SCHEMA_SQL);
    })().catch((err) => {
      dbInitPromise = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbInitPromise;
}

// ── Helpers ──────────────────────────────────
const ID_RE = /^[1-9]\d{0,15}$/;
const INGREDIENT_COLUMNS = 'id, name, category, created_at';
const RECIPE_COLUMNS = 'id, title, ingredients, steps, created_at';

const toIngredient = (row) => ({
  id: Number(row.id),
  name: row.name,
  category: row.category,
  createdAt: row.created_at.toISOString(),
});

const toRecipe = (row) => ({
  id: Number(row.id),
  title: row.title,
  ingredients: row.ingredients,
  steps: row.steps,
  createdAt: row.created_at.toISOString(),
});

const charLen = (s) => [...s].length;
// 한 줄 값은 연속 공백을 하나로, 여러 줄 값은 줄바꿈을 살린다
const cleanLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const cleanText = (v) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';

function parseIngredientInput(body) {
  const name = cleanLine(body?.name);
  const category = cleanLine(body?.category);
  if (!name) return { error: '재료 이름을 입력해 주세요.' };
  if (charLen(name) > NAME_MAX) return { error: `재료 이름은 ${NAME_MAX}자까지 쓸 수 있어요.` };
  if (!CATEGORIES.includes(category)) return { error: `분류는 ${CATEGORIES.join(' / ')} 중 하나여야 해요.` };
  return { name, category };
}

function parseRecipeInput(body) {
  const title = cleanLine(body?.title);
  if (!title) return { error: '요리명을 입력해 주세요.' };
  if (charLen(title) > TITLE_MAX) return { error: `요리명은 ${TITLE_MAX}자까지 쓸 수 있어요.` };

  if (!Array.isArray(body?.ingredients) || !Array.isArray(body?.steps)) {
    return { error: '재료와 조리법은 목록 형태로 보내야 해요.' };
  }
  // 같은 재료를 두 번 넣어도 한 번만 저장한다
  const ingredients = [...new Set(body.ingredients.map(cleanLine).filter(Boolean))];
  const steps = body.steps.map(cleanText).filter(Boolean);

  if (!ingredients.length) return { error: '재료를 한 개 이상 넣어 주세요.' };
  if (ingredients.length > RECIPE_ITEMS_MAX) return { error: `재료는 ${RECIPE_ITEMS_MAX}개까지 넣을 수 있어요.` };
  if (ingredients.some((n) => charLen(n) > NAME_MAX)) return { error: `재료 이름은 ${NAME_MAX}자까지 쓸 수 있어요.` };
  if (!steps.length) return { error: '조리법을 한 단계 이상 적어 주세요.' };
  if (steps.length > RECIPE_ITEMS_MAX) return { error: `조리 단계는 ${RECIPE_ITEMS_MAX}개까지 적을 수 있어요.` };
  if (steps.some((s) => charLen(s) > STEP_MAX)) return { error: `조리 단계 하나는 ${STEP_MAX}자까지 쓸 수 있어요.` };

  return { title, ingredients, steps };
}

// ── AI recipe generation (Gemini) ────────────
const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();

const RECIPE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    feasible: { type: 'BOOLEAN' },
    title: { type: 'STRING' },
    ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
    note: { type: 'STRING' },
  },
  required: ['feasible', 'title', 'ingredients', 'steps', 'note'],
  propertyOrdering: ['feasible', 'title', 'ingredients', 'steps', 'note'],
};

function buildRecipePrompt(title, fridge) {
  const byCategory = {};
  fridge.forEach(({ name, category }) => { (byCategory[category] ||= []).push(name); });
  const fridgeText = Object.entries(byCategory).map(([c, names]) => `- ${c}: ${names.join(', ')}`).join('\n');

  return `냉장고 재료:
${fridgeText}

요리명: ${title || '(비어 있음 — 위 냉장고 재료로 만들기 좋은 요리를 하나 골라 줘)'}

규칙:
1. 냉장고 재료를 최대한 활용한다. 냉장고에 없는 재료는 꼭 필요한 기본 재료(물, 간장, 설탕, 식용유 등)만 최소한으로 넣는다.
2. ingredients 에는 재료 이름만 넣는다 (양·단위 없이, 최대 15개). 냉장고 재료는 위에 적힌 이름을 글자 그대로 쓴다.
3. steps 는 4~8단계, 한 단계는 한두 문장이다. 분량(예: 양파 1/2개, 간장 1큰술), 불 세기, 시간을 구체적으로 적고 단계 번호는 붙이지 않는다.
4. 요리명이 주어졌으면 title 은 그 요리명을 그대로 쓴다.
5. 요리명이 음식이 아니거나 냉장고 재료로 도저히 만들 수 없는 요리면 feasible 을 false 로 하고, note 에 이유와 대신 만들 만한 요리를 한 문장으로 적는다.
6. feasible 이 true 면 note 에는 맛을 살리는 팁이나 대체 재료를 한 문장으로 적는다.`;
}

async function generateRecipe(title, fridge) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: RECIPE_SCHEMA,
  };
  // 레시피 정도는 깊게 생각할 필요가 없어 thinking 을 줄이면 응답이 훨씬 빨라진다
  if (/gemini-3/.test(GEMINI_MODEL)) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  else if (/2\.5-flash/.test(GEMINI_MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: '너는 한국 가정식 요리 연구가다. 사용자의 냉장고 재료로 집에서 만들 수 있는 레시피를 주어진 JSON 형식으로만 답한다.' }],
        },
        contents: [{ role: 'user', parts: [{ text: buildRecipePrompt(title, fridge) }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    }
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no text (finishReason: ${json?.candidates?.[0]?.finishReason})`);
  return JSON.parse(text);
}

function badId(req, res) {
  if (ID_RE.test(req.params.id)) return false;
  res.status(400).json({ success: false, message: 'ID 형식이 올바르지 않아요.' });
  return true;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '64kb' }));

// express.static(__dirname) 는 .env·server.js 까지 노출하므로 화면 파일만 명시적으로 내보낸다
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api', async (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했어요. DATABASE_URL 설정을 확인해 주세요.' });
  }
});

// ── API routes: ingredients ──────────────────
app.get('/api/ingredients', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM ingredients ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`
    );
    res.json({ success: true, data: rows.map(toIngredient) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/ingredients', async (req, res, next) => {
  const input = parseIngredientInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    // 이미 있는 이름이면 아무것도 넣지 않고 409 로 알려준다
    const { rows } = await pool.query(
      `INSERT INTO ingredients (name, category) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING ${INGREDIENT_COLUMNS}`,
      [input.name, input.category]
    );
    if (!rows.length) {
      return res.status(409).json({ success: false, message: `'${input.name}'은(는) 이미 냉장고에 있어요.` });
    }
    res.status(201).json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/ingredients/:id', async (req, res, next) => {
  if (badId(req, res)) return;
  try {
    const { rows } = await pool.query(
      `DELETE FROM ingredients WHERE id = $1 RETURNING ${INGREDIENT_COLUMNS}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: '이미 삭제된 재료예요.' });
    res.json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API routes: recipes ──────────────────────
app.get('/api/recipes', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${RECIPE_COLUMNS} FROM recipes ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`
    );
    res.json({ success: true, data: rows.map(toRecipe) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recipes', async (req, res, next) => {
  const input = parseRecipeInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO recipes (title, ingredients, steps) VALUES ($1, $2, $3) RETURNING ${RECIPE_COLUMNS}`,
      [input.title, input.ingredients, input.steps]
    );
    res.status(201).json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 냉장고 재료로 레시피 초안을 만든다 (저장은 하지 않음 — 화면에서 확인·수정 후 POST /api/recipes)
app.post('/api/recipes/generate', async (req, res, next) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ success: false, message: 'AI 자동 생성이 설정되지 않았어요. GEMINI_API_KEY 환경변수를 확인해 주세요.' });
  }
  const title = cleanLine(req.body?.title);
  if (charLen(title) > TITLE_MAX) {
    return res.status(400).json({ success: false, message: `요리명은 ${TITLE_MAX}자까지 쓸 수 있어요.` });
  }

  try {
    const { rows: fridge } = await pool.query('SELECT name, category FROM ingredients ORDER BY category, name');
    if (!fridge.length) {
      return res.status(400).json({ success: false, message: '냉장고에 재료가 없어요. 먼저 재료를 넣어 주세요.' });
    }

    let raw;
    try {
      raw = await generateRecipe(title, fridge);
    } catch (err) {
      console.error('Gemini error:', err.message);
      const message = err.status === 429
        ? 'AI 사용량이 잠시 몰렸어요. 조금 뒤에 다시 시도해 주세요.'
        : [400, 401, 403].includes(err.status) && /key|credential|auth|permission/i.test(err.message)
          ? 'Gemini API 키가 올바르지 않아요. GEMINI_API_KEY 설정을 확인해 주세요.'
          : err.name === 'TimeoutError'
          ? 'AI 응답이 너무 오래 걸려요. 다시 시도해 주세요.'
          : 'AI 가 레시피를 만들지 못했어요. 다시 시도해 주세요.';
      return res.status(err.status === 429 ? 429 : 502).json({ success: false, message });
    }

    const note = cleanText(raw?.note).slice(0, 300);
    if (raw?.feasible === false) {
      return res.status(422).json({ success: false, message: note || '이 요리명으로는 레시피를 만들기 어려워요.' });
    }

    // 모델이 길이 제한을 넘기거나 단계 번호를 붙여도 저장 규칙에 맞게 다듬는다
    const input = parseRecipeInput({
      title: title || cleanLine(raw?.title).slice(0, TITLE_MAX),
      ingredients: (Array.isArray(raw?.ingredients) ? raw.ingredients : [])
        .map((n) => String(n).slice(0, NAME_MAX)).slice(0, RECIPE_ITEMS_MAX),
      steps: (Array.isArray(raw?.steps) ? raw.steps : [])
        .map((s) => String(s).replace(/^\s*\d+\s*[.)]\s*/, '').slice(0, STEP_MAX)).slice(0, RECIPE_ITEMS_MAX),
    });
    if (input.error) {
      console.error('Gemini recipe rejected:', input.error);
      return res.status(502).json({ success: false, message: 'AI 가 만든 레시피 형식이 올바르지 않아요. 다시 시도해 주세요.' });
    }

    const have = new Set(fridge.map((f) => normalize(f.name)));
    res.json({
      success: true,
      data: { ...input, note, missing: input.ingredients.filter((n) => !have.has(normalize(n))) },
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/recipes/:id', async (req, res, next) => {
  if (badId(req, res)) return;
  const input = parseRecipeInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `UPDATE recipes SET title = $1, ingredients = $2, steps = $3 WHERE id = $4 RETURNING ${RECIPE_COLUMNS}`,
      [input.title, input.ingredients, input.steps, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: '레시피를 찾을 수 없어요. 삭제되었을 수 있어요.' });
    res.json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/recipes/:id', async (req, res, next) => {
  if (badId(req, res)) return;
  try {
    const { rows } = await pool.query(`DELETE FROM recipes WHERE id = $1 RETURNING ${RECIPE_COLUMNS}`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: '이미 삭제된 레시피예요.' });
    res.json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.all('/api/{*splat}', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 본문이 올바른 JSON 이 아니에요.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: '보내는 내용이 너무 길어요.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버에서 요청을 처리하지 못했어요.' });
});

// ── Startup & export ─────────────────────────
// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  // Express 5 는 포트 충돌 같은 listen 오류를 throw 하지 않고 콜백 인자로 넘긴다
  app.listen(PORT, (err) => {
    if (err) {
      console.error(err.code === 'EADDRINUSE'
        ? `포트 ${PORT} 을(를) 이미 다른 프로그램이 쓰고 있어요. .env 의 PORT 를 바꿔 주세요.`
        : err);
      process.exit(1);
    }
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
module.exports = app;
