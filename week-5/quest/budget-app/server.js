// ─────────────────────────────────────────────
// 달력 가계부 🐷 — Budget App 백엔드
// Express 5 + Supabase(PostgreSQL). 로컬(node server.js)과 Vercel 서버리스 겸용.
// ─────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3800;

const MAX_MEMO_LENGTH = 40;
const MAX_AMOUNT = 1_000_000_000_000;   // 1조 — 오타로 들어온 말도 안 되는 금액을 막는다
const TYPES = ['income', 'expense'];

const MAX_LABEL_LENGTH = 12;            // 분류 이름 — 달력/모달 타일에 들어가는 길이 한계
const MAX_EMOJI_LENGTH = 8;             // 👨‍👩‍👧 같은 ZWJ 결합 이모지를 고려한 길이

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
    CREATE TABLE IF NOT EXISTS transactions (
      id          BIGSERIAL   PRIMARY KEY,
      tx_date     DATE        NOT NULL,
      type        TEXT        NOT NULL CHECK (type IN ('income', 'expense')),
      category    TEXT        NOT NULL,
      amount      BIGINT      NOT NULL CHECK (amount > 0),
      memo        TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // 달력·목록 모두 날짜 역순으로 읽으므로 그 순서에 맞춘 인덱스를 둔다
  await pool.query('CREATE INDEX IF NOT EXISTS transactions_tx_date_idx ON transactions (tx_date DESC, id DESC)');

  // 사용자가 추가한 분류만 담는다. 기본 분류(식비·월급 등)는 클라이언트에 내장되어 있어
  // DB 가 비어 있어도 앱이 정상 동작한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id          BIGSERIAL   PRIMARY KEY,
      type        TEXT        NOT NULL CHECK (type IN ('income', 'expense')),
      key         TEXT        NOT NULL UNIQUE,
      label       TEXT        NOT NULL,
      emoji       TEXT        NOT NULL DEFAULT '🏷️',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // 같은 종류 안에서 이름이 겹치면 고르기 어려우므로 막는다
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS categories_type_label_idx ON categories (type, label)');

  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────

// 'YYYY-MM-DD' 형식과 실제 존재하는 날짜인지까지 확인한다
function cleanDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const ok = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return ok ? text : null;
}

// 'YYYY-MM'
function cleanMonth(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const month = Number(text.slice(5));
  return month >= 1 && month <= 12 ? text : null;
}

// 분류 키는 영문 키다. 기본 분류는 클라이언트가 정의하고(food, salary ...),
// 사용자가 추가한 분류는 서버가 만든다(c<base36> 형태라 숫자가 섞인다).
function cleanCategory(value) {
  const text = String(value ?? '').trim().slice(0, 30);
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(text) ? text : null;
}

// 사용자가 추가한 분류의 키. 기본 분류 키와 겹치지 않도록 'c' + 시각 + 난수로 만든다
function generateCategoryKey() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 분류 이름 — 제어문자 제거 후 길이 제한
function cleanLabel(value) {
  const text = String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return text || null;
}

// 이모지 — 글자 수가 아니라 코드포인트 기준으로 자른다 (서로게이트 페어가 쪼개지면 깨진다)
function cleanEmoji(value) {
  const text = [...String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()]
    .slice(0, MAX_EMOJI_LENGTH)
    .join('');
  return text || '🏷️';
}

function toCategory(row) {
  return {
    id: Number(row.id),
    type: row.type,
    key: row.key,
    label: row.label,
    emoji: row.emoji,
  };
}

// 제어문자를 공백으로 바꾸고 길이를 제한한다
function cleanMemo(value) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_MEMO_LENGTH);
}

// 원 단위 정수만 허용 (소수점·음수·0 거부)
function cleanAmount(value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return amount;
}

// DB row → 클라이언트가 기대하는 Transaction 객체
// tx_date 는 SQL 에서 to_char 로 문자열화해서 가져온다 (Date 로 받으면 타임존 때문에 하루씩 밀린다)
function toTransaction(row) {
  return {
    id: Number(row.id),
    date: row.tx_date,
    type: row.type,
    category: row.category,
    amount: Number(row.amount),
    memo: row.memo,
  };
}

const SELECT_COLUMNS = `id, to_char(tx_date, 'YYYY-MM-DD') AS tx_date, type, category, amount, memo`;

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

// 목록 조회 — ?month=YYYY-MM (해당 월만), ?type=income|expense (종류 필터)
app.get('/api/transactions', async (req, res) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.month !== undefined) {
      const month = cleanMonth(req.query.month);
      if (!month) {
        return res.status(400).json({ success: false, message: 'month 는 YYYY-MM 형식이어야 해요' });
      }
      values.push(`${month}-01`);
      // date_trunc 로 비교하면 인덱스를 못 타므로 범위 조건으로 쓴다
      conditions.push(`tx_date >= $${values.length}::date AND tx_date < ($${values.length}::date + INTERVAL '1 month')`);
    }

    if (req.query.type !== undefined) {
      if (!TYPES.includes(req.query.type)) {
        return res.status(400).json({ success: false, message: 'type 은 income 또는 expense 여야 해요' });
      }
      values.push(req.query.type);
      conditions.push(`type = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM transactions ${where} ORDER BY tx_date DESC, id DESC`,
      values
    );
    res.json({ success: true, data: rows.map(toTransaction) });
  } catch (err) {
    console.error('GET /api/transactions:', err.message);
    res.status(500).json({ success: false, message: '내역을 불러오지 못했어요' });
  }
});

// 생성
app.post('/api/transactions', async (req, res) => {
  try {
    const body = req.body || {};

    const date = cleanDate(body.date);
    if (!date) {
      return res.status(400).json({ success: false, message: '날짜는 YYYY-MM-DD 형식이어야 해요' });
    }
    if (!TYPES.includes(body.type)) {
      return res.status(400).json({ success: false, message: '종류는 수입 또는 지출이어야 해요' });
    }
    const category = cleanCategory(body.category);
    if (!category) {
      return res.status(400).json({ success: false, message: '분류를 선택해 주세요' });
    }
    const amount = cleanAmount(body.amount);
    if (!amount) {
      return res.status(400).json({ success: false, message: '금액을 올바르게 입력해 주세요' });
    }

    const { rows } = await pool.query(
      `INSERT INTO transactions (tx_date, type, category, amount, memo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [date, body.type, category, amount, cleanMemo(body.memo)]
    );
    res.status(201).json({ success: true, data: toTransaction(rows[0]) });
  } catch (err) {
    console.error('POST /api/transactions:', err.message);
    res.status(500).json({ success: false, message: '내역을 저장하지 못했어요' });
  }
});

// 수정 — 보낸 필드만 바꾼다
app.patch('/api/transactions/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 예요' });
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.date !== undefined) {
      const date = cleanDate(body.date);
      if (!date) {
        return res.status(400).json({ success: false, message: '날짜는 YYYY-MM-DD 형식이어야 해요' });
      }
      values.push(date);
      fields.push(`tx_date = $${values.length}`);
    }

    if (body.type !== undefined) {
      if (!TYPES.includes(body.type)) {
        return res.status(400).json({ success: false, message: '종류는 수입 또는 지출이어야 해요' });
      }
      values.push(body.type);
      fields.push(`type = $${values.length}`);
    }

    if (body.category !== undefined) {
      const category = cleanCategory(body.category);
      if (!category) {
        return res.status(400).json({ success: false, message: '분류를 선택해 주세요' });
      }
      values.push(category);
      fields.push(`category = $${values.length}`);
    }

    if (body.amount !== undefined) {
      const amount = cleanAmount(body.amount);
      if (!amount) {
        return res.status(400).json({ success: false, message: '금액을 올바르게 입력해 주세요' });
      }
      values.push(amount);
      fields.push(`amount = $${values.length}`);
    }

    if (body.memo !== undefined) {
      values.push(cleanMemo(body.memo));
      fields.push(`memo = $${values.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 내용이 없어요' });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE transactions SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING ${SELECT_COLUMNS}`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '그 내역을 찾지 못했어요' });
    }
    res.json({ success: true, data: toTransaction(rows[0]) });
  } catch (err) {
    console.error('PATCH /api/transactions/:id:', err.message);
    res.status(500).json({ success: false, message: '내역을 수정하지 못했어요' });
  }
});

// 삭제
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 예요' });
    }

    const { rows } = await pool.query('DELETE FROM transactions WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '그 내역을 찾지 못했어요' });
    }
    res.json({ success: true, data: { id: Number(rows[0].id) } });
  } catch (err) {
    console.error('DELETE /api/transactions/:id:', err.message);
    res.status(500).json({ success: false, message: '내역을 삭제하지 못했어요' });
  }
});

// ── 분류(카테고리) ───────────────────────────

// 사용자가 추가한 분류 목록
app.get('/api/categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type, key, label, emoji FROM categories ORDER BY id ASC'
    );
    res.json({ success: true, data: rows.map(toCategory) });
  } catch (err) {
    console.error('GET /api/categories:', err.message);
    res.status(500).json({ success: false, message: '분류를 불러오지 못했어요' });
  }
});

// 분류 추가 — 키는 서버가 만든다
app.post('/api/categories', async (req, res) => {
  try {
    const body = req.body || {};

    if (!TYPES.includes(body.type)) {
      return res.status(400).json({ success: false, message: '종류는 수입 또는 지출이어야 해요' });
    }
    const label = cleanLabel(body.label);
    if (!label) {
      return res.status(400).json({ success: false, message: '분류 이름을 입력해 주세요' });
    }

    const { rows } = await pool.query(
      `INSERT INTO categories (type, key, label, emoji)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, key, label, emoji`,
      [body.type, generateCategoryKey(), label, cleanEmoji(body.emoji)]
    );
    res.status(201).json({ success: true, data: toCategory(rows[0]) });
  } catch (err) {
    // categories_type_label_idx 위반 = 같은 종류에 같은 이름이 이미 있다
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: '같은 이름의 분류가 이미 있어요' });
    }
    console.error('POST /api/categories:', err.message);
    res.status(500).json({ success: false, message: '분류를 추가하지 못했어요' });
  }
});

// 분류 삭제 — 이미 쓰고 있는 분류는 지우지 않는다 (지난 내역의 이름이 사라지기 때문)
app.delete('/api/categories/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 예요' });
    }

    const { rows: found } = await pool.query('SELECT key FROM categories WHERE id = $1', [id]);
    if (found.length === 0) {
      return res.status(404).json({ success: false, message: '그 분류를 찾지 못했어요' });
    }

    const { rows: used } = await pool.query(
      'SELECT count(*)::int AS count FROM transactions WHERE category = $1',
      [found[0].key]
    );
    if (used[0].count > 0) {
      return res.status(409).json({
        success: false,
        message: `이 분류를 쓰는 내역이 ${used[0].count}건 있어서 지울 수 없어요`,
      });
    }

    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('DELETE /api/categories/:id:', err.message);
    res.status(500).json({ success: false, message: '분류를 삭제하지 못했어요' });
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
    console.log(`🐷 달력 가계부 서버 실행 중 → http://localhost:${PORT}`);
  });
}

module.exports = app;
