require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DB 연결 ──────────────────────────────────
// Supabase Transaction Pooler(6543). 환경변수에 trailing newline 이 붙는 경우가
// 있어 항상 .trim() 한다. 연결 문자열은 .env 에만 두고 커밋하지 않는다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인하세요.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // Supabase 는 SSL 필수
  max: 5,                              // 풀러 뒤라 커넥션은 적게 유지
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

const MAX_TITLE_LENGTH = 200;

// ── Helpers ──────────────────────────────────
// 개행/탭을 제외한 제어문자를 제거하고 길이를 제한한다
const cleanTitle = (value) =>
  String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);

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

// 2026-09-12 16:20 형태의 로컬 시각
function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// DB 행 → 클라이언트 응답 형태 (id 는 bigint 라 문자열로 내려간다)
const toTodo = (row) => ({
  id: String(row.id),
  title: row.title,
  done: row.done,
  createdAt: formatDateTime(row.created_at),
});

// 라우트별 id 검증 (BIGSERIAL 이라 양의 정수 문자열만 허용)
const parseId = (raw) => (/^\d+$/.test(String(raw)) ? String(raw) : null);

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

// API 요청 전에 테이블을 준비한다
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 연결에 실패했습니다.' });
  }
});

// ── API: 할 일 목록 ───────────────────────────
app.get('/api/todos', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, done, created_at FROM todos ORDER BY done ASC, created_at DESC'
    );
    res.json({ success: true, data: { todos: rows.map(toTodo), count: rows.length } });
  } catch (err) {
    next(err);
  }
});

// ── API: 할 일 추가 ───────────────────────────
app.post('/api/todos', async (req, res, next) => {
  try {
    const title = cleanTitle((req.body || {}).title);
    if (!title) {
      return res.status(400).json({ success: false, message: '할 일을 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      'INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at',
      [title]
    );
    console.log(`[할 일 추가] #${rows[0].id} ${title}`);
    res.status(201).json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API: 완료한 할 일 전체 삭제 ───────────────
// ⚠️ '/api/todos/:id' 보다 먼저 선언해야 'completed' 가 id 로 잡히지 않는다
app.delete('/api/todos/completed', async (_req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE done = true');
    console.log(`[완료 비우기] ${rowCount}건 삭제`);
    res.json({ success: true, data: { deleted: rowCount } });
  } catch (err) {
    next(err);
  }
});

// ── API: 할 일 수정 (제목 / 완료 여부) ─────────
app.patch('/api/todos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 할 일 번호입니다.' });
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.title !== undefined) {
      const title = cleanTitle(body.title);
      if (!title) {
        return res.status(400).json({ success: false, message: '할 일 내용은 비울 수 없습니다.' });
      }
      values.push(title);
      fields.push(`title = $${values.length}`);
    }

    if (body.done !== undefined) {
      if (typeof body.done !== 'boolean') {
        return res.status(400).json({ success: false, message: 'done 값은 true/false 여야 합니다.' });
      }
      values.push(body.done);
      fields.push(`done = $${values.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: '변경할 내용이 없습니다.' });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE todos SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING id, title, done, created_at`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API: 할 일 삭제 ───────────────────────────
app.delete('/api/todos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 할 일 번호입니다.' });
    }

    const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`할 일 관리: http://localhost:${PORT}`);
    console.log('저장소: PostgreSQL (todos 테이블)');
  });
}
module.exports = app;
