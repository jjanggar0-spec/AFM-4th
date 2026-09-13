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

const DIVIDER = '='.repeat(64);
const SUB_DIVIDER = '-'.repeat(64);

const MAX_LENGTHS = { name: 50, email: 100, phone: 30, category: 40, message: 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Helpers ──────────────────────────────────
// 개행/탭을 제외한 제어문자를 제거하고 길이를 제한한다
const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);

// 서버리스에서는 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      email       TEXT        NOT NULL,
      phone       TEXT        NOT NULL DEFAULT '',
      category    TEXT        NOT NULL DEFAULT '기타',
      message     TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS inquiries_created_at_idx ON inquiries (created_at DESC)');
  dbInitialized = true;
}

// 2026-09-12 16:20:31 형태의 로컬 시각
function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// DB 행 하나를 txt 블록으로 변환 (내려받기용)
function formatEntry(row) {
  return [
    DIVIDER,
    `접수번호 : ${row.id}`,
    `접수일시 : ${formatDateTime(row.created_at)}`,
    `문의유형 : ${row.category}`,
    `이    름 : ${row.name}`,
    `이 메 일 : ${row.email}`,
    `연 락 처 : ${row.phone || '-'}`,
    SUB_DIVIDER,
    '문의내용 :',
    row.message,
    DIVIDER,
    '',
    '',
  ].join('\n');
}

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

// ── API: 문의 접수 (PostgreSQL 저장) ──────────
app.post('/api/inquiries', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = clean(body.name, MAX_LENGTHS.name);
    const email = clean(body.email, MAX_LENGTHS.email);
    const phone = clean(body.phone, MAX_LENGTHS.phone);
    const category = clean(body.category, MAX_LENGTHS.category) || '기타';
    const message = clean(body.message, MAX_LENGTHS.message);

    if (!name) {
      return res.status(400).json({ success: false, message: '이름을 입력해 주세요.' });
    }
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: '올바른 이메일을 입력해 주세요.' });
    }
    if (message.length < 10) {
      return res.status(400).json({ success: false, message: '문의 내용을 10자 이상 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO inquiries (name, email, phone, category, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [name, email, phone, category, message]
    );

    const saved = rows[0];
    console.log(`[문의 접수] #${saved.id} ${name} <${email}> → PostgreSQL(inquiries)`);

    res.status(201).json({
      success: true,
      data: {
        id: saved.id,
        receivedAt: formatDateTime(saved.created_at),
        savedTo: 'PostgreSQL · inquiries 테이블',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: 접수 현황 (건수 · 최근 접수일시) ─────
app.get('/api/inquiries', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count, MAX(created_at) AS latest FROM inquiries'
    );
    res.json({
      success: true,
      data: {
        count: rows[0].count,
        latest: rows[0].latest ? formatDateTime(rows[0].latest) : null,
        savedTo: 'PostgreSQL · inquiries 테이블',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: 접수 내역 txt 내려받기 (DB → txt) ────
app.get('/api/inquiries/download', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, phone, category, message, created_at FROM inquiries ORDER BY id'
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '아직 접수된 문의가 없습니다.' });
    }
    // 메모장에서도 한글이 깨지지 않도록 BOM 을 붙인다
    const text = '﻿' + rows.map(formatEntry).join('');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="inquiries.txt"');
    res.send(text);
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
    console.log(`PokéCorp 홈페이지: http://localhost:${PORT}`);
    console.log('문의 저장소: PostgreSQL (inquiries 테이블)');
  });
}
module.exports = app;
