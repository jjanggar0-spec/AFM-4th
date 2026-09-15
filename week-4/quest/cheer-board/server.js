// 고민·칭찬·응원 게시판 — 글쓰기 + 공감(+1) + 최신순/공감순 정렬 + 관리자 글 삭제 API 서버 (Supabase PostgreSQL)

// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

const CONTENT_MAX = 500; // 글 내용 글자 수 상한 — index.html 의 CONTENT_MAX 와 같아야 한다
const LIST_LIMIT = 200;
const CATEGORIES = ['고민', '칭찬', '응원'];

// 관리자 비밀번호는 환경변수로만 받는다. 비어 있으면 관리자 기능 전체가 꺼진다
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 관리자 로그인 유지 시간 (12시간)

// 정렬은 고정 SQL 조각만 고르게 해서 사용자 입력이 SQL 에 섞이지 않게 한다
const SORTS = {
  latest: 'created_at DESC, id DESC',
  likes: 'likes DESC, created_at DESC, id DESC',
};

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000, // 연결이 끊겨도 요청이 몇 분씩 매달리지 않고 바로 에러를 돌려주게
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS posts (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category   TEXT        NOT NULL CHECK (category IN ('고민', '칭찬', '응원')),
    content    TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND ${CONTENT_MAX}),
    likes      INTEGER     NOT NULL DEFAULT 0 CHECK (likes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at DESC);
  CREATE INDEX IF NOT EXISTS posts_likes_idx      ON posts (likes DESC, created_at DESC);

  ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  posts            IS '고민·칭찬·응원 게시글';
  COMMENT ON COLUMN posts.id         IS '글 ID';
  COMMENT ON COLUMN posts.category   IS '카테고리 (고민 / 칭찬 / 응원)';
  COMMENT ON COLUMN posts.content    IS '글 내용';
  COMMENT ON COLUMN posts.likes      IS '공감 수';
  COMMENT ON COLUMN posts.created_at IS '작성일시';
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
const POST_COLUMNS = 'id, category, content, likes, created_at';

function toPost(row) {
  return {
    id: Number(row.id),
    category: row.category,
    content: row.content,
    likes: row.likes,
    createdAt: row.created_at.toISOString(),
  };
}

// 앞뒤 공백만 정리하고 줄바꿈은 살린다 (3줄 이상 빈 줄은 2줄로)
const cleanContent = (v) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';

function parsePostInput(body) {
  const category = typeof body?.category === 'string' ? body.category.trim() : '';
  const content = cleanContent(body?.content);
  if (!CATEGORIES.includes(category)) return { error: `카테고리는 ${CATEGORIES.join(' / ')} 중 하나여야 해요.` };
  if (!content) return { error: '내용을 입력해 주세요.' };
  if ([...content].length > CONTENT_MAX) return { error: `내용은 ${CONTENT_MAX}자까지 쓸 수 있어요.` };
  return { category, content };
}

// ── Admin auth ───────────────────────────────
// 서버리스는 요청마다 인스턴스가 달라 세션 메모리를 못 쓰므로, 만료시각을 비밀번호로 서명한
// 토큰("만료ms.서명")을 준다. 비밀번호를 바꾸면 이전 토큰은 모두 무효가 된다
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b)); // 길이가 달라도 비교 시간이 같다
const signAdmin = (exp) => crypto.createHmac('sha256', ADMIN_PASSWORD).update(`cheer-board-admin:${exp}`).digest('base64url');

function issueAdminToken() {
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
  return { token: `${expiresAt}.${signAdmin(expiresAt)}`, expiresAt: new Date(expiresAt).toISOString() };
}

function isValidAdminToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!/^\d{13}$/.test(exp || '') || !sig) return false;
  return Number(exp) > Date.now() && safeEqual(sig, signAdmin(exp));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, message: '관리자 기능이 설정되지 않았어요. ADMIN_PASSWORD 환경변수를 확인해 주세요.' });
  }
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ success: false, message: '관리자 로그인이 필요하거나 만료됐어요. 다시 로그인해 주세요.' });
  }
  next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '8kb' }));

// express.static(__dirname) 는 .env·server.js 까지 노출하므로 화면 파일만 명시적으로 내보낸다
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// DB 가 필요한 글 API 에만 건다 (관리자 로그인은 DB 없이 동작)
app.use('/api/posts', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했어요. DATABASE_URL 설정을 확인해 주세요.' });
  }
});

// 공감 수는 계속 바뀌므로 브라우저·CDN 캐시를 막는다
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── API routes ───────────────────────────────
// 글 목록 (sort=latest|likes, category=고민|칭찬|응원) + 카테고리별 글 수
app.get('/api/posts', async (req, res, next) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'latest';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  try {
    const [list, counts] = await Promise.all([
      pool.query(
        `SELECT ${POST_COLUMNS} FROM posts
          WHERE ($1::text IS NULL OR category = $1)
          ORDER BY ${SORTS[sort]}
          LIMIT ${LIST_LIMIT}`,
        [category]
      ),
      pool.query(`SELECT category, count(*)::int AS count, coalesce(sum(likes), 0)::int AS likes
                    FROM posts GROUP BY category`),
    ]);
    const summary = { total: 0, likes: 0, byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
    for (const row of counts.rows) {
      summary.byCategory[row.category] = row.count;
      summary.total += row.count;
      summary.likes += row.likes;
    }
    res.json({ success: true, data: { sort, category, posts: list.rows.map(toPost), summary } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/posts', async (req, res, next) => {
  const input = parsePostInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (category, content) VALUES ($1, $2) RETURNING ${POST_COLUMNS}`,
      [input.category, input.content]
    );
    res.status(201).json({ success: true, data: toPost(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 공감 +1 — 한 문장 UPDATE 로 올려서 동시에 여러 명이 눌러도 수가 빠지지 않는다
app.patch('/api/posts/:id/like', async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '글 ID 형식이 올바르지 않아요.' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING ${POST_COLUMNS}`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '글을 찾을 수 없어요. 삭제되었을 수 있어요.' });
    }
    res.json({ success: true, data: toPost(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 관리자 로그인 — 비밀번호가 맞으면 삭제 요청에 쓸 토큰을 준다
app.post('/api/admin/login', async (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ success: false, message: '관리자 기능이 설정되지 않았어요. ADMIN_PASSWORD 환경변수를 확인해 주세요.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    await sleep(700); // 비밀번호 대입 속도를 늦춘다
    return res.status(401).json({ success: false, message: '비밀번호가 맞지 않아요.' });
  }
  res.json({ success: true, data: issueAdminToken() });
});

// 글 삭제 (관리자 전용)
app.delete('/api/posts/:id', requireAdmin, async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '글 ID 형식이 올바르지 않아요.' });
  }
  try {
    const { rows } = await pool.query(`DELETE FROM posts WHERE id = $1 RETURNING ${POST_COLUMNS}`, [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '이미 삭제된 글이에요.' });
    }
    res.json({ success: true, data: toPost(rows[0]) });
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
