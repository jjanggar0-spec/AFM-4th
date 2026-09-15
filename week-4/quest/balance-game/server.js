// 밸런스 게임 — 질문 등록 + A/B 투표 + 투표율 API 서버 (Supabase PostgreSQL)

// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

const OPTION_MAX = 60; // 선택지 글자 수 상한 — index.html 의 OPTION_MAX 와 같아야 한다
const LIST_LIMIT = 100;
const CHOICES = ['A', 'B'];

// 정렬은 고정 SQL 조각만 고르게 해서 사용자 입력이 SQL 에 섞이지 않게 한다
const SORTS = {
  latest: 'q.created_at DESC, q.id DESC',
  popular: 'count(v.id) DESC, q.created_at DESC, q.id DESC',
};

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS questions (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    option_a   TEXT        NOT NULL CHECK (char_length(option_a) BETWEEN 1 AND ${OPTION_MAX}),
    option_b   TEXT        NOT NULL CHECK (char_length(option_b) BETWEEN 1 AND ${OPTION_MAX}),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS votes (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id BIGINT      NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
    choice      CHAR(1)     NOT NULL CHECK (choice IN ('A', 'B')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS votes_question_id_choice_idx ON votes (question_id, choice);

  ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE votes     ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  questions             IS '밸런스 게임 질문';
  COMMENT ON COLUMN questions.id          IS '질문 ID';
  COMMENT ON COLUMN questions.option_a    IS '선택지 A';
  COMMENT ON COLUMN questions.option_b    IS '선택지 B';
  COMMENT ON COLUMN questions.created_at  IS '등록일시';
  COMMENT ON TABLE  votes                 IS '투표 (한 행 = 한 표)';
  COMMENT ON COLUMN votes.id              IS '투표 ID';
  COMMENT ON COLUMN votes.question_id     IS '질문 ID (questions.id)';
  COMMENT ON COLUMN votes.choice          IS '고른 선택지 (A 또는 B)';
  COMMENT ON COLUMN votes.created_at      IS '투표일시';
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

// 질문 + 선택지별 표 수. where/order 는 고정 SQL 조각만 넘긴다 (값은 params)
const questionsSql = (where, order, limit = '') => `
  SELECT q.id, q.option_a, q.option_b, q.created_at,
         count(v.id) FILTER (WHERE v.choice = 'A')::int AS count_a,
         count(v.id) FILTER (WHERE v.choice = 'B')::int AS count_b
    FROM questions q
    LEFT JOIN votes v ON v.question_id = q.id
   ${where}
   GROUP BY q.id
   ORDER BY ${order}
   ${limit}`;

// 퍼센트는 소수 첫째 자리까지, A + B 가 정확히 100 이 되게 B 를 나머지로 계산한다
function toQuestion(row) {
  const total = row.count_a + row.count_b;
  const percentA = total ? Math.round((row.count_a / total) * 1000) / 10 : 0;
  const percentB = total ? Math.round((100 - percentA) * 10) / 10 : 0;
  return {
    id: Number(row.id),
    optionA: row.option_a,
    optionB: row.option_b,
    countA: row.count_a,
    countB: row.count_b,
    total,
    percentA,
    percentB,
    createdAt: row.created_at.toISOString(),
  };
}

async function findQuestion(id) {
  const { rows } = await pool.query(questionsSql('WHERE q.id = $1', 'q.id'), [id]);
  return rows.length ? toQuestion(rows[0]) : null;
}

// 앞뒤 공백 정리 + 연속 공백 하나로
const cleanText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function parseQuestionInput(body) {
  const optionA = cleanText(body?.optionA);
  const optionB = cleanText(body?.optionB);
  if (!optionA || !optionB) return { error: '선택지 A와 B를 모두 입력해 주세요.' };
  if ([...optionA].length > OPTION_MAX || [...optionB].length > OPTION_MAX) {
    return { error: `선택지는 ${OPTION_MAX}자까지 쓸 수 있어요.` };
  }
  if (optionA.toLowerCase() === optionB.toLowerCase()) {
    return { error: '두 선택지가 같으면 고를 수가 없어요.' };
  }
  return { optionA, optionB };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '4kb' }));

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

// 투표율은 계속 바뀌므로 브라우저·CDN 캐시를 막는다 (폴링이 항상 최신 값을 받게)
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── API routes ───────────────────────────────
// 질문 목록 + 선택지별 표 수 + 전체 요약. 클라이언트가 몇 초마다 폴링한다
app.get('/api/questions', async (req, res, next) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'latest';
  try {
    const [list, summary] = await Promise.all([
      pool.query(questionsSql('', SORTS[sort], `LIMIT ${LIST_LIMIT}`)),
      pool.query(`SELECT (SELECT count(*) FROM questions)::int AS question_count,
                         (SELECT count(*) FROM votes)::int     AS vote_count`),
    ]);
    res.json({
      success: true,
      data: {
        sort,
        questions: list.rows.map(toQuestion),
        summary: {
          questionCount: summary.rows[0].question_count,
          voteCount: summary.rows[0].vote_count,
        },
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/questions/:id', async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '질문 ID 형식이 올바르지 않아요.' });
  }
  try {
    const question = await findQuestion(req.params.id);
    if (!question) return res.status(404).json({ success: false, message: '질문을 찾을 수 없어요.' });
    res.json({ success: true, data: question });
  } catch (err) {
    next(err);
  }
});

app.post('/api/questions', async (req, res, next) => {
  const input = parseQuestionInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO questions (option_a, option_b) VALUES ($1, $2)
       RETURNING id, option_a, option_b, created_at, 0 AS count_a, 0 AS count_b`,
      [input.optionA, input.optionB]
    );
    res.status(201).json({ success: true, data: toQuestion(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 투표 1표 추가 → 반영된 최신 투표율을 돌려준다
app.post('/api/questions/:id/votes', async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '질문 ID 형식이 올바르지 않아요.' });
  }
  const choice = typeof req.body?.choice === 'string' ? req.body.choice.toUpperCase() : '';
  if (!CHOICES.includes(choice)) {
    return res.status(400).json({ success: false, message: "choice 는 'A' 또는 'B' 여야 해요." });
  }
  try {
    // 없는 질문이면 INSERT 되는 행이 0개 → 404
    const inserted = await pool.query(
      `INSERT INTO votes (question_id, choice)
       SELECT id, $2 FROM questions WHERE id = $1
       RETURNING id`,
      [req.params.id, choice]
    );
    if (!inserted.rowCount) {
      return res.status(404).json({ success: false, message: '질문을 찾을 수 없어요. 삭제되었을 수 있어요.' });
    }
    const question = await findQuestion(req.params.id);
    res.status(201).json({ success: true, data: { choice, question } });
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
