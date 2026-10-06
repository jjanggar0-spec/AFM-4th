// 고민·칭찬·응원 게시판 — 회원가입·로그인 + 글쓰기 + 공감(+1) + 최신순/공감순 정렬 + 글 삭제(작성자·관리자) API 서버 (Supabase PostgreSQL)

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

// 회원 로그인 토큰 서명 키. 따로 안 넣으면 DATABASE_URL 에서 만든다 (배포마다 같은 값이라 서버리스에서도 유지된다)
const AUTH_SECRET = (process.env.AUTH_SECRET || '').trim() || `derived:${(process.env.DATABASE_URL || '').trim()}`;
const USER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 회원 로그인 유지 시간 (7일)

// 회원가입 규칙 — index.html 의 같은 이름 상수와 같아야 한다
const USERNAME_RE = /^[a-z0-9_]{4,20}$/;
const NICKNAME_MIN = 2;
const NICKNAME_MAX = 12;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

// 정렬은 고정 SQL 조각만 고르게 해서 사용자 입력이 SQL 에 섞이지 않게 한다
const SORTS = {
  latest: 'p.created_at DESC, p.id DESC',
  likes: 'p.likes DESC, p.created_at DESC, p.id DESC',
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

  CREATE TABLE IF NOT EXISTS users (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT        NOT NULL CONSTRAINT users_username_key UNIQUE CHECK (username ~ '^[a-z0-9_]{4,20}$'),
    nickname      TEXT        NOT NULL CONSTRAINT users_nickname_key UNIQUE
                              CHECK (char_length(nickname) BETWEEN ${NICKNAME_MIN} AND ${NICKNAME_MAX}),
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  users               IS '회원';
  COMMENT ON COLUMN users.username      IS '로그인 아이디 (영문 소문자·숫자·_ 4~20자)';
  COMMENT ON COLUMN users.nickname      IS '닉네임 (닉네임 공개 글에 표시)';
  COMMENT ON COLUMN users.password_hash IS 'scrypt 해시 (scrypt$솔트$해시)';
  COMMENT ON COLUMN users.created_at    IS '가입일시';

  -- 회원가입 전에 쓰인 글은 user_id 가 NULL 인 익명 글로 남는다
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS user_id   BIGINT  REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT true;
  CREATE INDEX IF NOT EXISTS posts_user_id_idx ON posts (user_id);

  COMMENT ON COLUMN posts.user_id   IS '작성 회원 ID (회원가입 기능 전 글은 NULL)';
  COMMENT ON COLUMN posts.anonymous IS '익명 여부 (true 면 닉네임을 숨김)';
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

// $1 = 요청한 회원 ID (비회원이면 NULL) — 내 글인지만 알려주고, 익명 글의 작성자는 내보내지 않는다
const POST_SELECT = `
  SELECT p.id, p.category, p.content, p.likes, p.created_at,
         CASE WHEN p.anonymous THEN NULL ELSE u.nickname END        AS author,
         (p.user_id IS NOT NULL AND p.user_id = $1::bigint) IS TRUE AS mine
    FROM posts p
    LEFT JOIN users u ON u.id = p.user_id`;

function toPost(row) {
  return {
    id: Number(row.id),
    category: row.category,
    content: row.content,
    likes: row.likes,
    author: row.author ?? null,
    mine: !!row.mine,
    createdAt: row.created_at.toISOString(),
  };
}

// 글 하나를 화면에 쓰는 모양으로 다시 읽는다 (INSERT·UPDATE 직후)
async function fetchPost(id, userId) {
  const { rows } = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [userId, id]);
  return rows[0] ? toPost(rows[0]) : null;
}

const toUser = (row) => ({ id: Number(row.id), username: row.username, nickname: row.nickname });

// 앞뒤 공백만 정리하고 줄바꿈은 살린다 (3줄 이상 빈 줄은 2줄로)
const cleanContent = (v) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';

function parsePostInput(body) {
  const category = typeof body?.category === 'string' ? body.category.trim() : '';
  const content = cleanContent(body?.content);
  if (!CATEGORIES.includes(category)) return { error: `카테고리는 ${CATEGORIES.join(' / ')} 중 하나여야 해요.` };
  if (!content) return { error: '내용을 입력해 주세요.' };
  if ([...content].length > CONTENT_MAX) return { error: `내용은 ${CONTENT_MAX}자까지 쓸 수 있어요.` };
  return { category, content, anonymous: body?.anonymous !== false }; // 기본은 익명
}

function parseSignupInput(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim().replace(/\s+/g, ' ') : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) return { error: '아이디는 영문 소문자·숫자·_ 로 4~20자여야 해요.' };
  const nickLen = [...nickname].length;
  if (nickLen < NICKNAME_MIN || nickLen > NICKNAME_MAX) return { error: `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자여야 해요.` };
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { error: `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자여야 해요.` };
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return { error: '비밀번호에 영문과 숫자를 모두 넣어 주세요.' };
  return { username, nickname, password };
}

// ── Admin auth ───────────────────────────────
// 서버리스는 요청마다 인스턴스가 달라 세션 메모리를 못 쓰므로, 만료시각을 비밀번호로 서명한
// 토큰("만료ms.서명")을 준다. 비밀번호를 바꾸면 이전 토큰은 모두 무효가 된다
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b)); // 길이가 달라도 비교 시간이 같다
const signAdmin = (exp) => crypto.createHmac('sha256', ADMIN_PASSWORD).update(`cheer-board-admin:${exp}`).digest('base64url');
const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];

function issueAdminToken() {
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
  return { token: `${expiresAt}.${signAdmin(expiresAt)}`, expiresAt: new Date(expiresAt).toISOString() };
}

function isValidAdminToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!/^\d{13}$/.test(exp || '') || !sig) return false;
  return Number(exp) > Date.now() && safeEqual(sig, signAdmin(exp));
}

// ── User auth ────────────────────────────────
// 비밀번호는 Node 내장 scrypt(솔트 16바이트)로 해시해 저장한다 — 원문은 어디에도 남기지 않는다
const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// 없는 아이디로 로그인해도 해시 계산을 똑같이 해서, 응답 시간으로 가입 여부를 알 수 없게 한다
let dummyHash = null;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password-0'));

// 회원 토큰 = "회원ID.만료ms.서명" — 관리자 토큰과 섞이지 않게 서명 문구를 다르게 한다
const signUser = (uid, exp) => crypto.createHmac('sha256', AUTH_SECRET).update(`cheer-board-user:${uid}:${exp}`).digest('base64url');

function issueUserToken(row) {
  const expiresAt = Date.now() + USER_TOKEN_TTL_MS;
  return {
    token: `${row.id}.${expiresAt}.${signUser(row.id, expiresAt)}`,
    expiresAt: new Date(expiresAt).toISOString(),
    user: toUser(row),
  };
}

// 회원 토큰은 관리자 토큰(Authorization)과 따로 X-User-Token 헤더로 받는다 — 둘 다 켜 둘 수 있게
function readUserId(req) {
  const [uid, exp, sig] = String(req.get('x-user-token') || '').split('.');
  if (!ID_RE.test(uid || '') || !/^\d{13}$/.test(exp || '') || !sig) return null;
  if (Number(exp) <= Date.now() || !safeEqual(sig, signUser(uid, exp))) return null;
  return uid;
}

// 토큰이 없거나 틀려도 비회원으로 통과 (목록·공감은 누구나)
function optionalUser(req, _res, next) {
  req.userId = readUserId(req);
  next();
}

function requireUser(req, res, next) {
  req.userId = readUserId(req);
  if (!req.userId) {
    return res.status(401).json({ success: false, message: '로그인이 필요하거나 만료됐어요. 다시 로그인해 주세요.' });
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

// DB 가 필요한 글·회원 API 에만 건다 (관리자 로그인은 DB 없이 동작)
app.use(['/api/posts', '/api/auth'], async (_req, res, next) => {
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

// ── API routes: 회원 ─────────────────────────
// 회원가입 — 가입하면 바로 로그인된 상태가 되도록 토큰을 같이 준다
app.post('/api/auth/signup', async (req, res, next) => {
  const input = parseSignupInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, nickname, password_hash) VALUES ($1, $2, $3)
       RETURNING id, username, nickname`,
      [input.username, input.nickname, await hashPassword(input.password)]
    );
    res.status(201).json({ success: true, data: issueUserToken(rows[0]) });
  } catch (err) {
    // UNIQUE 위반 — 두 사람이 동시에 같은 아이디로 가입해도 DB 가 한 명만 받아 준다
    if (err.code === '23505') {
      const message = err.constraint === 'users_nickname_key' ? '이미 사용 중인 닉네임이에요.' : '이미 사용 중인 아이디예요.';
      return res.status(409).json({ success: false, message });
    }
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, PASSWORD_MAX) : '';
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해 주세요.' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, nickname, password_hash FROM users WHERE username = $1',
      [username]
    );
    const ok = await verifyPassword(password, rows[0]?.password_hash ?? (await getDummyHash()));
    if (!rows.length || !ok) {
      await sleep(700); // 비밀번호 대입 속도를 늦춘다
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 맞지 않아요.' });
    }
    res.json({ success: true, data: issueUserToken(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 새로고침 뒤 저장된 토큰이 아직 쓸 만한지(탈퇴·만료 여부) 확인
app.get('/api/auth/me', requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username, nickname FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) {
      return res.status(401).json({ success: false, message: '회원 정보를 찾을 수 없어요. 다시 로그인해 주세요.' });
    }
    res.json({ success: true, data: toUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API routes: 글 ───────────────────────────
// 글 목록 (sort=latest|likes, category=고민|칭찬|응원) + 카테고리별 글 수
app.get('/api/posts', optionalUser, async (req, res, next) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'latest';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  try {
    const [list, counts] = await Promise.all([
      pool.query(
        `${POST_SELECT}
          WHERE ($2::text IS NULL OR p.category = $2)
          ORDER BY ${SORTS[sort]}
          LIMIT ${LIST_LIMIT}`,
        [req.userId, category]
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

// 글쓰기는 회원만 — 익명으로 올려도 서버는 작성자를 알고 있어서 본인이 지울 수 있다
app.post('/api/posts', requireUser, async (req, res, next) => {
  const input = parsePostInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    // users 에서 골라 넣으므로, 토큰은 살아 있는데 회원 행이 지워졌다면 0행이 된다
    const { rows } = await pool.query(
      `INSERT INTO posts (category, content, anonymous, user_id)
       SELECT $1, $2, $3, id FROM users WHERE id = $4
       RETURNING id`,
      [input.category, input.content, input.anonymous, req.userId]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: '회원 정보를 찾을 수 없어요. 다시 로그인해 주세요.' });
    }
    res.status(201).json({ success: true, data: await fetchPost(rows[0].id, req.userId) });
  } catch (err) {
    next(err);
  }
});

// 공감 +1 — 한 문장 UPDATE 로 올려서 동시에 여러 명이 눌러도 수가 빠지지 않는다
app.patch('/api/posts/:id/like', optionalUser, async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '글 ID 형식이 올바르지 않아요.' });
  }
  try {
    const { rows } = await pool.query('UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING id', [req.params.id]);
    const post = rows.length ? await fetchPost(rows[0].id, req.userId) : null;
    if (!post) {
      return res.status(404).json({ success: false, message: '글을 찾을 수 없어요. 삭제되었을 수 있어요.' });
    }
    res.json({ success: true, data: post });
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

// 글 삭제 — 관리자 토큰(Authorization)이면 모든 글, 회원 토큰(X-User-Token)이면 내가 쓴 글만
app.delete('/api/posts/:id', optionalUser, async (req, res, next) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '글 ID 형식이 올바르지 않아요.' });
  }
  const isAdmin = !!ADMIN_PASSWORD && isValidAdminToken(bearer(req));
  if (!isAdmin && !req.userId) {
    return res.status(401).json({ success: false, message: '로그인이 필요하거나 만료됐어요. 다시 로그인해 주세요.' });
  }
  try {
    const { rows } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND ($2::boolean OR user_id = $3::bigint) RETURNING id',
      [req.params.id, isAdmin, req.userId]
    );
    if (!rows.length) {
      const { rowCount } = await pool.query('SELECT 1 FROM posts WHERE id = $1', [req.params.id]);
      return rowCount
        ? res.status(403).json({ success: false, message: '내가 쓴 글만 삭제할 수 있어요.' })
        : res.status(404).json({ success: false, message: '이미 삭제된 글이에요.' });
    }
    res.json({ success: true, data: { id: Number(rows[0].id) } });
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
