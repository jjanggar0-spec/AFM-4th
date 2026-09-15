require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
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

// 관리자 목록 조회용 비밀번호 (문의자 이메일이 공개되지 않도록)
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();

const MAX_LENGTHS = { name: 50, email: 100, content: 2000 };
const MIN_CONTENT = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Helpers ──────────────────────────────────
// 개행/탭을 제외한 제어문자를 제거하고 길이를 제한한다
const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);

// 길이가 달라도 일정한 시간에 비교하도록 해시끼리 비교한다
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const isAdmin = (given) => !!given && crypto.timingSafeEqual(sha256(given), sha256(ADMIN_PASSWORD));

// 서버리스에서는 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다
// Supabase 에는 realtime.messages 가 따로 있으므로 public 스키마를 명시한다
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.messages (
      id           BIGSERIAL PRIMARY KEY,
      name         TEXT        NOT NULL,
      email        TEXT        NOT NULL,
      content      TEXT        NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS messages_received_at_idx ON public.messages (received_at DESC)');
  dbInitialized = true;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname), { dotfiles: 'deny', index: 'index.html' }));

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

// ── API: 문의 목록 (관리자, 최신순) ────────────
app.get('/api/messages', async (req, res, next) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({ success: false, message: '서버에 ADMIN_PASSWORD 가 설정되지 않았습니다.' });
    }
    if (!isAdmin(req.get('x-admin-password'))) {
      return res.status(401).json({ success: false, message: '관리자 비밀번호가 올바르지 않습니다.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, email, content, received_at AS "receivedAt"
         FROM public.messages
        ORDER BY received_at DESC, id DESC
        LIMIT 500`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ── API: 문의 접수 (PostgreSQL 저장) ──────────
app.post('/api/messages', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = clean(body.name, MAX_LENGTHS.name);
    const email = clean(body.email, MAX_LENGTHS.email);
    const content = clean(body.content, MAX_LENGTHS.content);

    if (!name) {
      return res.status(400).json({ success: false, message: '이름을 입력해 주세요.' });
    }
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: '올바른 이메일을 입력해 주세요.' });
    }
    if (content.length < MIN_CONTENT) {
      return res.status(400).json({ success: false, message: `내용을 ${MIN_CONTENT}자 이상 입력해 주세요.` });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.messages (name, email, content)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, content, received_at AS "receivedAt"`,
      [name, email, content]
    );

    console.log(`[문의 접수] #${rows[0].id} ${name} <${email}> → PostgreSQL(public.messages)`);
    res.status(201).json({ success: true, data: rows[0] });
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
    console.log(`내 소개 페이지: http://localhost:${PORT}`);
    console.log(`관리자 페이지: http://localhost:${PORT}/#/admin`);
    console.log('문의 저장소: PostgreSQL (public.messages 테이블)');
  });
}
module.exports = app;
