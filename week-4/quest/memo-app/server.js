// 메모 앱 — memos API 서버 (Supabase PostgreSQL)

// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

const TITLE_MAX_LENGTH = 100;
const CONTENT_MAX_LENGTH = 5000;
const SEARCH_MAX_LENGTH = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// DATE 컬럼을 JS Date 로 바꾸면 시간대 때문에 하루가 밀릴 수 있어 'YYYY-MM-DD' 문자열 그대로 받는다
types.setTypeParser(types.builtins.DATE, (value) => value);

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
// coin-dashboard 도 같은 memos 테이블을 쓴다. 그쪽이 예전 모양(일자·완료 없음)으로 먼저 만들었어도
// ADD COLUMN IF NOT EXISTS 로 빠진 컬럼을 채운다
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memos (
    id          BIGSERIAL   PRIMARY KEY,
    memo_date   DATE        NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
    title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${TITLE_MAX_LENGTH}),
    content     TEXT        NOT NULL DEFAULT '' CHECK (char_length(content) <= ${CONTENT_MAX_LENGTH}),
    done        BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE memos ADD COLUMN IF NOT EXISTS memo_date DATE    NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date;
  ALTER TABLE memos ADD COLUMN IF NOT EXISTS done      BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS memos_memo_date_idx ON memos (memo_date DESC, created_at DESC);
  ALTER TABLE memos ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  memos            IS '메모';
  COMMENT ON COLUMN memos.id         IS '메모 번호';
  COMMENT ON COLUMN memos.memo_date  IS '일자';
  COMMENT ON COLUMN memos.title      IS '제목';
  COMMENT ON COLUMN memos.content    IS '내용';
  COMMENT ON COLUMN memos.done       IS '완료 여부';
  COMMENT ON COLUMN memos.created_at IS '작성일시';
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
function toMemo(row) {
  return {
    id: Number(row.id),
    date: row.memo_date,
    title: row.title,
    content: row.content,
    done: row.done,
    createdAt: row.created_at.toISOString(),
  };
}

// 'YYYY-MM-DD' 형식이면서 실제로 있는 날짜인지 (2026-02-30 같은 값 거르기)
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// 요청 body → DB 컬럼 값. partial=true 면 보낸 필드만 검사한다 (PATCH 용)
function parseMemoInput(body, { partial = false } = {}) {
  const src = body || {};
  const fields = {};

  if (!partial || 'date' in src) {
    if (!isValidDate(src.date)) return { error: '일자는 YYYY-MM-DD 형식의 올바른 날짜여야 해요.' };
    fields.memo_date = src.date;
  }
  if (!partial || 'title' in src) {
    if (typeof src.title !== 'string' || !src.title.trim()) return { error: '제목을 입력해 주세요.' };
    const title = src.title.trim();
    if (title.length > TITLE_MAX_LENGTH) return { error: `제목은 ${TITLE_MAX_LENGTH}자까지 쓸 수 있어요.` };
    fields.title = title;
  }
  if (!partial || 'content' in src) {
    const content = src.content ?? '';
    if (typeof content !== 'string') return { error: 'content 는 문자열이어야 해요.' };
    if (content.length > CONTENT_MAX_LENGTH) return { error: `내용은 ${CONTENT_MAX_LENGTH}자까지 쓸 수 있어요.` };
    fields.content = content;
  }
  if (!partial || 'done' in src) {
    const done = src.done ?? false;
    if (typeof done !== 'boolean') return { error: 'done 은 true 또는 false 여야 해요.' };
    fields.done = done;
  }

  if (!Object.keys(fields).length) return { error: '수정할 항목(date, title, content, done)을 보내 주세요.' };
  return { fields };
}

// 검색 조건 → WHERE 절. 값은 모두 $n 파라미터로 넘겨 SQL 인젝션을 막는다
function buildSearch(query) {
  const where = [];
  const params = [];

  const q = typeof query.q === 'string' ? query.q.trim().slice(0, SEARCH_MAX_LENGTH) : '';
  if (q) {
    // LIKE 특수문자(\ % _)는 글자 그대로 찾도록 이스케이프
    params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }

  if (query.status === 'done' || query.status === 'todo') {
    params.push(query.status === 'done');
    where.push(`done = $${params.length}`);
  }

  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    if (!query[key]) continue;
    if (!isValidDate(query[key])) return { error: `${key} 는 YYYY-MM-DD 형식이어야 해요.` };
    params.push(query[key]);
    where.push(`memo_date ${op} $${params.length}`);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// URL 의 :id 가 양의 정수가 아니면 null
function parseId(value) {
  const id = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function badId(res) {
  return res.status(400).json({ success: false, message: 'id 는 양의 정수여야 해요.' });
}

function notFound(res) {
  return res.status(404).json({ success: false, message: '메모를 찾을 수 없어요.' });
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '16kb' }));

// express.static(__dirname) 는 .env·server.js 까지 노출하므로 화면 파일만 명시적으로 내보낸다
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했어요. DATABASE_URL 설정을 확인해 주세요.' });
  }
});

// ── API routes ───────────────────────────────
// 목록 + 검색: ?q=검색어&status=all|todo|done&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/memos', async (req, res, next) => {
  const search = buildSearch(req.query);
  if (search.error) return res.status(400).json({ success: false, message: search.error });
  try {
    const { rows } = await pool.query(
      `SELECT * FROM memos ${search.sql} ORDER BY memo_date DESC, created_at DESC, id DESC`,
      search.params
    );
    res.json({ success: true, data: rows.map(toMemo) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/memos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badId(res);
  try {
    const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1', [id]);
    if (!rows.length) return notFound(res);
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/memos', async (req, res, next) => {
  const input = parseMemoInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  const { memo_date, title, content, done } = input.fields;
  try {
    const { rows } = await pool.query(
      'INSERT INTO memos (memo_date, title, content, done) VALUES ($1, $2, $3, $4) RETURNING *',
      [memo_date, title, content, done]
    );
    res.status(201).json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PUT = 전체 수정, PATCH = 보낸 항목만 수정 (예: 완료 체크만 { done: true })
async function updateMemo(req, res, next, partial) {
  const id = parseId(req.params.id);
  if (!id) return badId(res);
  const input = parseMemoInput(req.body, { partial });
  if (input.error) return res.status(400).json({ success: false, message: input.error });

  // 컬럼 이름은 parseMemoInput 이 정한 고정 키만 들어오므로 SQL 에 그대로 넣어도 안전하다
  const columns = Object.keys(input.fields);
  const sets = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE memos SET ${sets} WHERE id = $${columns.length + 1} RETURNING *`,
      [...Object.values(input.fields), id]
    );
    if (!rows.length) return notFound(res);
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
}

app.put('/api/memos/:id', (req, res, next) => updateMemo(req, res, next, false));
app.patch('/api/memos/:id', (req, res, next) => updateMemo(req, res, next, true));

app.delete('/api/memos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return badId(res);
  try {
    const { rows } = await pool.query('DELETE FROM memos WHERE id = $1 RETURNING *', [id]);
    if (!rows.length) return notFound(res);
    res.json({ success: true, data: toMemo(rows[0]) });
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
