// ─────────────────────────────────────────────
// 오늘의 할 일 🌸 — Todo App 백엔드
// Express 5 + Supabase(PostgreSQL). 로컬(node server.js)과 Vercel 서버리스 겸용.
// ─────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

const MAX_TITLE_LENGTH = 200;

// ── DB 연결 ──────────────────────────────────
// Supabase Transaction Pooler(6543). 환경변수에 trailing newline 이 붙는 경우가
// 있어 항상 .trim() 한다. 접속 문자열은 .env 에만 두고 절대 커밋하지 않는다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('⚠️  DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // Supabase 는 SSL 필수
  max: 5,                               // 풀러 뒤라 커넥션은 적게 유지
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// 서버리스에서는 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id          BIGSERIAL   PRIMARY KEY,
      title       TEXT        NOT NULL,
      done        BOOLEAN     NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS todos_created_at_idx ON todos (created_at DESC)');
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────

// 개행/탭을 포함한 제어문자를 공백으로 바꾸고 길이를 제한한다
function cleanTitle(value) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

// 2026-09-19 16:40 형태의 로컬 시각
function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// DB row → 클라이언트가 기대하는 Todo 객체
function toTodo(row) {
  return {
    id: Number(row.id),
    title: row.title,
    done: row.done,
    createdAt: formatDateTime(row.created_at),
  };
}

// :id 파라미터를 양의 정수로 검증
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API 요청 전에 테이블을 준비한다 (lazy init)
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('initDB 실패:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했어요' });
  }
});

// ── API routes ───────────────────────────────

// 목록 조회 (최신순)
app.get('/api/todos', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, done, created_at FROM todos ORDER BY created_at DESC, id DESC'
    );
    res.json({ success: true, data: rows.map(toTodo) });
  } catch (err) {
    console.error('GET /api/todos:', err.message);
    res.status(500).json({ success: false, message: '할 일을 불러오지 못했어요' });
  }
});

// 생성
app.post('/api/todos', async (req, res) => {
  try {
    const title = cleanTitle(req.body && req.body.title);
    if (!title) {
      return res.status(400).json({ success: false, message: '할 일 제목을 입력해 주세요' });
    }

    const { rows } = await pool.query(
      'INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at',
      [title]
    );
    res.status(201).json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    console.error('POST /api/todos:', err.message);
    res.status(500).json({ success: false, message: '할 일을 추가하지 못했어요' });
  }
});

// 수정 — { done } 또는 { title }, 둘 다 가능
app.patch('/api/todos/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 예요' });
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.title !== undefined) {
      const title = cleanTitle(body.title);
      if (!title) {
        return res.status(400).json({ success: false, message: '할 일 제목을 입력해 주세요' });
      }
      values.push(title);
      fields.push(`title = $${values.length}`);
    }

    if (body.done !== undefined) {
      if (typeof body.done !== 'boolean') {
        return res.status(400).json({ success: false, message: 'done 은 true/false 여야 해요' });
      }
      values.push(body.done);
      fields.push(`done = $${values.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 내용이 없어요 (title 또는 done)' });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE todos SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING id, title, done, created_at`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '그 할 일을 찾지 못했어요' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    console.error('PATCH /api/todos/:id:', err.message);
    res.status(500).json({ success: false, message: '할 일을 수정하지 못했어요' });
  }
});

// 삭제
app.delete('/api/todos/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 예요' });
    }

    const { rows } = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '그 할 일을 찾지 못했어요' });
    }
    res.json({ success: true, data: { id: Number(rows[0].id) } });
  } catch (err) {
    console.error('DELETE /api/todos/:id:', err.message);
    res.status(500).json({ success: false, message: '할 일을 삭제하지 못했어요' });
  }
});

// 정의되지 않은 API 경로는 HTML 대신 JSON 404 로 돌려준다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 경로예요' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
// 스택 트레이스는 서버 로그에만 남기고 클라이언트에는 노출하지 않는다
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버에서 문제가 발생했어요' });
});

// ── Startup & export ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌸 오늘의 할 일 서버 실행 중 → http://localhost:${PORT}`);
  });
}

module.exports = app;
