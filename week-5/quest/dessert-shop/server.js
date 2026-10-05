// 달콤공방 — 디저트·베이커리 쇼핑몰 API 서버 (결제 없음)
// 회원가입·로그인 + 상품 목록 + 장바구니 담기/수량 변경/삭제 (Supabase PostgreSQL)

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

// 회원 로그인 토큰 서명 키. 따로 안 넣으면 DATABASE_URL 에서 만든다 (배포마다 같은 값이라 서버리스에서도 유지된다)
const AUTH_SECRET = (process.env.AUTH_SECRET || '').trim() || `derived:${(process.env.DATABASE_URL || '').trim()}`;
const USER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 회원 로그인 유지 시간 (7일)

// 회원가입 규칙 — index.html 의 같은 이름 상수와 같아야 한다
const USERNAME_RE = /^[a-z0-9_]{4,20}$/;
const NICKNAME_MIN = 2;
const NICKNAME_MAX = 12;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const QTY_MAX = 99; // 상품 하나당 장바구니 최대 수량 — index.html 의 QTY_MAX 와 같아야 한다
const CATEGORIES = ['케이크', '빵', '구움과자', '디저트'];

// 샘플 상품 10개 — slug 가 같으면 다시 넣지 않으므로 서버를 여러 번 띄워도 중복되지 않는다
// 상품 사진은 Nano Banana(gemini-2.5-flash-image)로 생성해 images/<slug>.jpg 로 두었다
const SAMPLE_PRODUCTS = [
  { slug: 'strawberry-cream-cake', name: '딸기 생크림 케이크', category: '케이크', price: 32000, emoji: '🍰', color: '#fde2e4',
    description: '제철 생딸기를 듬뿍 올린 부드러운 바닐라 시트와 우유 생크림 (1호)' },
  { slug: 'chocolate-ganache-cake', name: '진한 초코 가나슈 케이크', category: '케이크', price: 35000, emoji: '🎂', color: '#e8d5c4',
    description: '벨기에산 다크초콜릿 가나슈를 세 겹으로 쌓은 꾸덕한 초코 케이크 (1호)' },
  { slug: 'butter-croissant', name: '버터 크루아상', category: '빵', price: 4200, emoji: '🥐', color: '#fbe7c6',
    description: '프랑스산 AOP 버터로 27겹 접어 구운 바삭하고 촉촉한 크루아상' },
  { slug: 'milk-bread', name: '우유 식빵', category: '빵', price: 5500, emoji: '🍞', color: '#f6ead7',
    description: '물 대신 우유로만 반죽해 결대로 쭉쭉 찢어지는 부드러운 식빵' },
  { slug: 'salt-bread', name: '소금빵', category: '빵', price: 3500, emoji: '🥖', color: '#efe3cf',
    description: '버터가 녹아든 쫄깃한 속살과 바삭한 바닥, 게랑드 소금 토핑' },
  { slug: 'choco-chip-cookie', name: '초코칩 쿠키 (4개입)', category: '구움과자', price: 7000, emoji: '🍪', color: '#f3dcc0',
    description: '겉은 바삭, 속은 쫀득한 뉴욕 스타일 초코칩 쿠키 4개 세트' },
  { slug: 'egg-tart', name: '포르투갈 에그타르트', category: '구움과자', price: 3200, emoji: '🥧', color: '#fff1c1',
    description: '바삭한 페이스트리 속 진한 커스터드를 고온에서 그을려 구운 에그타르트' },
  { slug: 'vanilla-cupcake', name: '바닐라 컵케이크', category: '디저트', price: 4800, emoji: '🧁', color: '#e9e3f7',
    description: '마다가스카르 바닐라빈 시트에 크림치즈 프로스팅을 올린 컵케이크' },
  { slug: 'glazed-donut', name: '글레이즈드 도넛', category: '디저트', price: 2800, emoji: '🍩', color: '#fde6d2',
    description: '매일 아침 튀겨 달콤한 슈거 글레이즈를 입힌 폭신한 링 도넛' },
  { slug: 'custard-pudding', name: '커스터드 푸딩', category: '디저트', price: 4500, emoji: '🍮', color: '#fcefc7',
    description: '유정란과 우유로 중탕해 만든 탱글한 푸딩과 쌉싸름한 캐러멜 소스' },
].map((p) => ({ ...p, image_url: `/images/${p.slug}.jpg` }));

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000, // 연결이 끊겨도 요청이 몇 분씩 매달리지 않고 바로 에러를 돌려주게
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
// 같은 Supabase 프로젝트를 쓰는 다른 앱(마음게시판 users·posts 등)과 겹치지 않게 shop_ 접두사를 붙인다
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS shop_users (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT        NOT NULL CONSTRAINT shop_users_username_key UNIQUE CHECK (username ~ '^[a-z0-9_]{4,20}$'),
    nickname      TEXT        NOT NULL CHECK (char_length(nickname) BETWEEN ${NICKNAME_MIN} AND ${NICKNAME_MAX}),
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE shop_users ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  shop_users               IS '쇼핑몰 회원';
  COMMENT ON COLUMN shop_users.username      IS '로그인 아이디 (영문 소문자·숫자·_ 4~20자)';
  COMMENT ON COLUMN shop_users.nickname      IS '닉네임 (화면 인사말에 표시)';
  COMMENT ON COLUMN shop_users.password_hash IS 'scrypt 해시 (scrypt$솔트$해시)';
  COMMENT ON COLUMN shop_users.created_at    IS '가입일시';

  CREATE TABLE IF NOT EXISTS shop_products (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug        TEXT        NOT NULL UNIQUE,
    name        TEXT        NOT NULL,
    category    TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    price       INTEGER     NOT NULL CHECK (price >= 0),
    emoji       TEXT        NOT NULL DEFAULT '🍰',
    color       TEXT        NOT NULL DEFAULT '#fde2e4',
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE shop_products ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  shop_products             IS '판매 상품';
  COMMENT ON COLUMN shop_products.slug        IS '상품 고유 키 (샘플 데이터 중복 방지)';
  COMMENT ON COLUMN shop_products.name        IS '상품명';
  COMMENT ON COLUMN shop_products.category    IS '분류 (케이크 / 빵 / 구움과자 / 디저트)';
  COMMENT ON COLUMN shop_products.description IS '상품 설명';
  COMMENT ON COLUMN shop_products.price       IS '판매가 (원)';
  COMMENT ON COLUMN shop_products.emoji       IS '상품 이미지 대신 쓰는 이모지';
  COMMENT ON COLUMN shop_products.color       IS '상품 카드 배경색';
  COMMENT ON COLUMN shop_products.is_active   IS '판매 중 여부 (false 면 목록에서 숨김)';

  -- 상품 사진 (이미지 기능 추가 전에 만든 테이블에도 붙도록 ALTER 로 추가)
  ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS image_url TEXT;
  COMMENT ON COLUMN shop_products.image_url   IS '상품 사진 경로 (없으면 이모지로 표시)';

  CREATE TABLE IF NOT EXISTS shop_cart_items (
    user_id    BIGINT      NOT NULL REFERENCES shop_users(id)    ON DELETE CASCADE,
    product_id BIGINT      NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    quantity   INTEGER     NOT NULL CHECK (quantity BETWEEN 1 AND ${QTY_MAX}),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id)
  );
  ALTER TABLE shop_cart_items ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  shop_cart_items            IS '회원별 장바구니 (회원·상품 한 쌍에 한 줄)';
  COMMENT ON COLUMN shop_cart_items.quantity   IS '담은 수량 (1~${QTY_MAX})';
  COMMENT ON COLUMN shop_cart_items.added_at   IS '처음 담은 일시';
  COMMENT ON COLUMN shop_cart_items.updated_at IS '수량을 마지막으로 바꾼 일시';
`;

// 서버리스 cold start 마다 불릴 수 있어 한 번만 실행되게 promise 를 공유한다
let dbInitPromise = null;
function initDB() {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
      await pool.query(SCHEMA_SQL);
      await pool.query(
        // 이미 있는 상품은 사진이 비어 있을 때만 채운다 (나중에 바꾼 사진은 덮어쓰지 않는다)
        `INSERT INTO shop_products (slug, name, category, description, price, emoji, color, image_url)
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS t(slug text, name text, category text, description text, price int, emoji text, color text, image_url text)
         ON CONFLICT (slug) DO UPDATE SET image_url = EXCLUDED.image_url
          WHERE shop_products.image_url IS NULL`,
        [JSON.stringify(SAMPLE_PRODUCTS)]
      );
    })().catch((err) => {
      dbInitPromise = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbInitPromise;
}

// ── Helpers ──────────────────────────────────
const ID_RE = /^[1-9]\d{0,15}$/;

const toUser = (row) => ({ id: Number(row.id), username: row.username, nickname: row.nickname });

const toProduct = (row) => ({
  id: Number(row.id),
  name: row.name,
  category: row.category,
  description: row.description,
  price: row.price,
  emoji: row.emoji,
  color: row.color,
  imageUrl: row.image_url ?? null,
});

// 장바구니는 언제나 "전체 목록 + 합계"를 돌려줘서 화면이 서버 상태와 어긋나지 않게 한다
async function fetchCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.quantity, c.added_at, p.id, p.name, p.category, p.description, p.price, p.emoji, p.color, p.image_url
       FROM shop_cart_items c
       JOIN shop_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.added_at, p.id`,
    [userId]
  );
  const items = rows.map((r) => ({ product: toProduct(r), quantity: r.quantity, subtotal: r.price * r.quantity }));
  return {
    items,
    totalQuantity: items.reduce((s, i) => s + i.quantity, 0),
    totalPrice: items.reduce((s, i) => s + i.subtotal, 0),
  };
}

function parseQuantity(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= QTY_MAX ? n : null;
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

// ── User auth ────────────────────────────────
// 비밀번호는 Node 내장 scrypt(솔트 16바이트)로 해시해 저장한다 — 원문은 어디에도 남기지 않는다
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b)); // 길이가 달라도 비교 시간이 같다

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

// 회원 토큰 = "회원ID.만료ms.서명" — 서버리스라 세션 메모리 대신 서명으로 확인한다
const signUser = (uid, exp) => crypto.createHmac('sha256', AUTH_SECRET).update(`dessert-shop-user:${uid}:${exp}`).digest('base64url');

function issueUserToken(row) {
  const expiresAt = Date.now() + USER_TOKEN_TTL_MS;
  return {
    token: `${row.id}.${expiresAt}.${signUser(row.id, expiresAt)}`,
    expiresAt: new Date(expiresAt).toISOString(),
    user: toUser(row),
  };
}

function readUserId(req) {
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
  const [uid, exp, sig] = String(token || '').split('.');
  if (!ID_RE.test(uid || '') || !/^\d{13}$/.test(exp || '') || !sig) return null;
  if (Number(exp) <= Date.now() || !safeEqual(sig, signUser(uid, exp))) return null;
  return uid;
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

// 상품 사진은 images 폴더만 내보낸다. 파일명이 바뀌지 않으니 하루 동안 캐시한다
app.use('/images', express.static(path.join(__dirname, 'images'), { maxAge: '1d' }));
app.use('/images', (_req, res) => res.status(404).end()); // 없는 사진이 SPA fallback(index.html)으로 가지 않게

app.use('/api', async (_req, res, next) => {
  res.set('Cache-Control', 'no-store'); // 장바구니는 계속 바뀌므로 브라우저·CDN 캐시를 막는다
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했어요. DATABASE_URL 설정을 확인해 주세요.' });
  }
});

// ── API routes: 회원 ─────────────────────────
// 회원가입 — 가입하면 바로 로그인된 상태가 되도록 토큰을 같이 준다
app.post('/api/auth/signup', async (req, res, next) => {
  const input = parseSignupInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO shop_users (username, nickname, password_hash) VALUES ($1, $2, $3)
       RETURNING id, username, nickname`,
      [input.username, input.nickname, await hashPassword(input.password)]
    );
    res.status(201).json({ success: true, data: issueUserToken(rows[0]) });
  } catch (err) {
    // UNIQUE 위반 — 두 사람이 동시에 같은 아이디로 가입해도 DB 가 한 명만 받아 준다
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 사용 중인 아이디예요.' });
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
      'SELECT id, username, nickname, password_hash FROM shop_users WHERE username = $1',
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
    const { rows } = await pool.query('SELECT id, username, nickname FROM shop_users WHERE id = $1', [req.userId]);
    if (!rows.length) {
      return res.status(401).json({ success: false, message: '회원 정보를 찾을 수 없어요. 다시 로그인해 주세요.' });
    }
    res.json({ success: true, data: toUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API routes: 상품 ─────────────────────────
// 상품 목록은 비회원도 볼 수 있다
app.get('/api/products', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, category, description, price, emoji, color, image_url
         FROM shop_products WHERE is_active ORDER BY id`
    );
    res.json({ success: true, data: { categories: CATEGORIES, products: rows.map(toProduct) } });
  } catch (err) {
    next(err);
  }
});

// ── API routes: 장바구니 (회원 전용) ──────────
app.get('/api/cart', requireUser, async (req, res, next) => {
  try {
    res.json({ success: true, data: await fetchCart(req.userId) });
  } catch (err) {
    next(err);
  }
});

// 담기 — 이미 담긴 상품이면 수량을 더한다 (최대 QTY_MAX 개). 한 문장 UPSERT 라 연타해도 줄이 겹치지 않는다
app.post('/api/cart', requireUser, async (req, res, next) => {
  const productId = ID_RE.test(String(req.body?.productId ?? '')) ? String(req.body.productId) : null;
  const quantity = req.body?.quantity === undefined ? 1 : parseQuantity(req.body.quantity);
  if (!productId) return res.status(400).json({ success: false, message: '상품을 골라 주세요.' });
  if (!quantity) return res.status(400).json({ success: false, message: `수량은 1~${QTY_MAX}개로 담을 수 있어요.` });
  try {
    // 회원·상품이 실제로 있을 때만 들어가도록 SELECT 로 넣는다 (토큰은 살아 있는데 회원이 지워진 경우 등)
    const { rowCount } = await pool.query(
      `INSERT INTO shop_cart_items (user_id, product_id, quantity)
       SELECT u.id, p.id, $3 FROM shop_users u, shop_products p
        WHERE u.id = $1 AND p.id = $2 AND p.is_active
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity   = LEAST(shop_cart_items.quantity + EXCLUDED.quantity, ${QTY_MAX}),
                     updated_at = now()`,
      [req.userId, productId, quantity]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: '상품을 찾을 수 없거나 판매가 끝났어요.' });
    res.status(201).json({ success: true, data: await fetchCart(req.userId) });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(401).json({ success: false, message: '회원 정보를 찾을 수 없어요. 다시 로그인해 주세요.' });
    }
    next(err);
  }
});

// 수량 변경 — 장바구니에서 +/- 를 누를 때
app.patch('/api/cart/:productId', requireUser, async (req, res, next) => {
  if (!ID_RE.test(req.params.productId)) {
    return res.status(400).json({ success: false, message: '상품 ID 형식이 올바르지 않아요.' });
  }
  const quantity = parseQuantity(req.body?.quantity);
  if (!quantity) return res.status(400).json({ success: false, message: `수량은 1~${QTY_MAX}개로 정할 수 있어요.` });
  try {
    const { rowCount } = await pool.query(
      `UPDATE shop_cart_items SET quantity = $3, updated_at = now()
        WHERE user_id = $1 AND product_id = $2`,
      [req.userId, req.params.productId, quantity]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: '장바구니에 없는 상품이에요.' });
    res.json({ success: true, data: await fetchCart(req.userId) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cart/:productId', requireUser, async (req, res, next) => {
  if (!ID_RE.test(req.params.productId)) {
    return res.status(400).json({ success: false, message: '상품 ID 형식이 올바르지 않아요.' });
  }
  try {
    await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1 AND product_id = $2',
      [req.userId, req.params.productId]);
    res.json({ success: true, data: await fetchCart(req.userId) });
  } catch (err) {
    next(err);
  }
});

// 장바구니 비우기
app.delete('/api/cart', requireUser, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1', [req.userId]);
    res.json({ success: true, data: await fetchCart(req.userId) });
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
