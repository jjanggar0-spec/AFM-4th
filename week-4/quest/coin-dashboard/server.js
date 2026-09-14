// 코인 모의투자 — 주문 API 서버 (Supabase PostgreSQL)
//
// 지갑(현금·보유코인)은 따로 저장하지 않고 orders 테이블을 처음부터 다시 계산해 만든다.
// 주문내역이 곧 원장이라 지갑과 주문내역이 서로 어긋날 일이 없다.

// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

const INITIAL_CASH = 1000000;
const MIN_ORDER_KRW = 5000;
const QTY_EPSILON = 1e-8; // 부동소수점 오차로 남는 먼지 수량은 전량으로 취급
const MEMO_MAX_LENGTH = 200;
const MEMO_TITLE_MAX_LENGTH = 100;
const MEMO_CONTENT_MAX_LENGTH = 5000;
const ORDER_LOCK_KEY = 7240913; // 동시에 들어온 주문이 같은 잔고를 두 번 쓰지 않도록 거는 advisory lock

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// ── Database (lazy init) ─────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS orders (
    id           BIGSERIAL PRIMARY KEY,
    ordered_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    side         TEXT             NOT NULL CHECK (side IN ('buy', 'sell')),
    coin_id      TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    coin_name    TEXT             NOT NULL,
    image_url    TEXT,
    price        DOUBLE PRECISION NOT NULL CHECK (price > 0),
    quantity     DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
    amount       BIGINT           NOT NULL CHECK (amount >= 0),
    memo         TEXT             NOT NULL DEFAULT '',
    profit       DOUBLE PRECISION,
    profit_rate  DOUBLE PRECISION
  );
  CREATE INDEX IF NOT EXISTS orders_ordered_at_idx ON orders (ordered_at DESC);

  -- 서버는 postgres 계정으로 접속하므로 영향이 없고, Supabase 공개 API(anon 키)로는 읽고 쓸 수 없게 막는다
  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  orders             IS '코인 모의투자 주문내역';
  COMMENT ON COLUMN orders.ordered_at  IS '주문일자';
  COMMENT ON COLUMN orders.side        IS '주문 구분 (buy=매수, sell=매도)';
  COMMENT ON COLUMN orders.coin_id     IS 'CoinGecko 코인 ID';
  COMMENT ON COLUMN orders.symbol      IS '코인 심볼';
  COMMENT ON COLUMN orders.coin_name   IS '코인 이름';
  COMMENT ON COLUMN orders.image_url   IS '코인 아이콘 URL';
  COMMENT ON COLUMN orders.price       IS '체결가 (원)';
  COMMENT ON COLUMN orders.quantity    IS '체결 수량';
  COMMENT ON COLUMN orders.amount      IS '체결금액 (원)';
  COMMENT ON COLUMN orders.memo        IS '주문메모';
  COMMENT ON COLUMN orders.profit      IS '실현손익 (원, 매도만)';
  COMMENT ON COLUMN orders.profit_rate IS '수익률 (%, 매도만)';

  CREATE TABLE IF NOT EXISTS memos (
    id          BIGSERIAL   PRIMARY KEY,
    title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${MEMO_TITLE_MAX_LENGTH}),
    content     TEXT        NOT NULL DEFAULT '' CHECK (char_length(content) <= ${MEMO_CONTENT_MAX_LENGTH}),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS memos_created_at_idx ON memos (created_at DESC);
  ALTER TABLE memos ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  memos            IS '메모';
  COMMENT ON COLUMN memos.id         IS '메모 번호';
  COMMENT ON COLUMN memos.title      IS '제목';
  COMMENT ON COLUMN memos.content    IS '내용';
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

function toOrder(row) {
  return {
    id: Number(row.id),
    at: row.ordered_at.toISOString(),
    side: row.side,
    coinId: row.coin_id,
    symbol: row.symbol,
    name: row.coin_name,
    image: row.image_url,
    price: row.price,
    qty: row.quantity,
    amount: Number(row.amount),
    memo: row.memo,
    profit: row.profit,
    profitRate: row.profit_rate,
  };
}

async function selectOrders(db) {
  const { rows } = await db.query('SELECT * FROM orders ORDER BY id ASC');
  return rows.map(toOrder);
}

// 주문을 오래된 순서로 다시 체결해 현재 지갑을 만든다 (평균단가 방식)
function buildWallet(orders) {
  let cash = INITIAL_CASH;
  const holdings = {};

  for (const o of orders) {
    if (o.side === 'buy') {
      const prev = holdings[o.coinId];
      cash -= o.amount;
      holdings[o.coinId] = {
        coinId: o.coinId, symbol: o.symbol, name: o.name, image: o.image,
        qty: (prev?.qty ?? 0) + o.qty,
        cost: (prev?.cost ?? 0) + o.amount,
        lastPrice: o.price,
      };
      continue;
    }

    cash += o.amount;
    const h = holdings[o.coinId];
    if (!h) continue;
    if (h.qty - o.qty < QTY_EPSILON) {
      delete holdings[o.coinId];
    } else {
      h.cost -= h.cost * (o.qty / h.qty);
      h.qty -= o.qty;
      h.lastPrice = o.price;
    }
  }

  return { initialCash: INITIAL_CASH, cash, holdings, orders: [...orders].reverse() };
}

// ── Validation ───────────────────────────────
function parseOrderInput(body) {
  const { side, coin, price, amount, quantity, memo = '' } = body || {};

  if (side !== 'buy' && side !== 'sell') return { error: 'side 는 buy 또는 sell 이어야 해요.' };
  if (!coin || typeof coin !== 'object') return { error: 'coin 정보가 필요해요.' };
  if (typeof coin.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(coin.id)) return { error: 'coin.id 가 올바르지 않아요.' };
  if (typeof coin.symbol !== 'string' || !coin.symbol.trim() || coin.symbol.length > 20) return { error: 'coin.symbol 이 올바르지 않아요.' };
  if (typeof coin.name !== 'string' || !coin.name.trim() || coin.name.length > 100) return { error: 'coin.name 이 올바르지 않아요.' };
  const image = typeof coin.image === 'string' && /^https:\/\//.test(coin.image) && coin.image.length <= 500 ? coin.image : null;

  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return { error: 'price 는 0보다 큰 숫자여야 해요.' };
  if (typeof memo !== 'string') return { error: 'memo 는 문자열이어야 해요.' };
  const cleanMemo = memo.trim();
  if (cleanMemo.length > MEMO_MAX_LENGTH) return { error: `주문메모는 ${MEMO_MAX_LENGTH}자까지 쓸 수 있어요.` };

  const base = { side, coin: { id: coin.id, symbol: coin.symbol.trim(), name: coin.name.trim(), image }, price, memo: cleanMemo };

  if (side === 'buy') {
    if (!Number.isInteger(amount) || amount <= 0) return { error: '매수 amount 는 원 단위 정수여야 해요.' };
    if (amount < MIN_ORDER_KRW) return { error: `최소 주문 금액은 ${MIN_ORDER_KRW.toLocaleString('ko-KR')}원이에요.` };
    return { ...base, amount };
  }

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return { error: '매도 quantity 는 0보다 큰 숫자여야 해요.' };
  return { ...base, quantity };
}

function toMemo(row) {
  return { id: Number(row.id), title: row.title, content: row.content, createdAt: row.created_at.toISOString() };
}

function parseMemoInput(body) {
  const { title, content = '' } = body || {};
  if (typeof title !== 'string' || !title.trim()) return { error: 'title 은 비어 있지 않은 문자열이어야 해요.' };
  if (typeof content !== 'string') return { error: 'content 는 문자열이어야 해요.' };
  const cleanTitle = title.trim();
  if (cleanTitle.length > MEMO_TITLE_MAX_LENGTH) return { error: `제목은 ${MEMO_TITLE_MAX_LENGTH}자까지 쓸 수 있어요.` };
  if (content.length > MEMO_CONTENT_MAX_LENGTH) return { error: `내용은 ${MEMO_CONTENT_MAX_LENGTH}자까지 쓸 수 있어요.` };
  return { title: cleanTitle, content };
}

// URL 의 :id 가 양의 정수가 아니면 null (BIGSERIAL 범위 밖 숫자는 DB 에서 오류가 나므로 안전 정수로 제한)
function parseId(value) {
  const id = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

// 현재 지갑 기준으로 체결 결과를 계산한다. 잔고가 모자라면 error 를 돌려준다.
function executeOrder(wallet, input) {
  const { side, coin, price, memo } = input;

  if (side === 'buy') {
    if (input.amount > wallet.cash) return { error: '보유 현금이 부족해요.' };
    return { side, coin, price, memo, quantity: input.amount / price, amount: input.amount, profit: null, profitRate: null };
  }

  const h = wallet.holdings[coin.id];
  if (!h) return { error: '보유한 수량이 없어요.' };
  if (input.quantity > h.qty + QTY_EPSILON) return { error: '보유 수량보다 많이 팔 수 없어요.' };

  const isAll = h.qty - input.quantity < QTY_EPSILON;
  const quantity = isAll ? h.qty : input.quantity;
  const amount = Math.round(quantity * price);
  // 전량 매도는 소액이어도 허용해야 잔량이 묶이지 않는다
  if (!isAll && amount < MIN_ORDER_KRW) return { error: `최소 주문 금액은 ${MIN_ORDER_KRW.toLocaleString('ko-KR')}원이에요.` };

  const costBasis = isAll ? h.cost : h.cost * (quantity / h.qty);
  const profit = amount - costBasis;
  const profitRate = costBasis > 0 ? (profit / costBasis) * 100 : 0;
  return { side, coin, price, memo, quantity, amount, profit, profitRate };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '16kb' }));

// express.static(__dirname) 는 .env·server.js 까지 노출하므로 쓰지 않고 화면 파일만 명시적으로 내보낸다
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
app.get('/api/health', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM memos) AS memos'
    );
    res.json({ success: true, data: { database: 'ok', ...rows[0] } });
  } catch (err) {
    next(err);
  }
});

// 지갑 = 현금 + 보유코인 + 주문내역(최신순)
app.get('/api/wallet', async (_req, res, next) => {
  try {
    res.json({ success: true, data: buildWallet(await selectOrders(pool)) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders', async (req, res, next) => {
  const input = parseOrderInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });

  const client = await pool.connect().catch(next);
  if (!client) return;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ORDER_LOCK_KEY]);

    const result = executeOrder(buildWallet(await selectOrders(client)), input);
    if (result.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: result.error });
    }

    const { rows } = await client.query(
      `INSERT INTO orders (side, coin_id, symbol, coin_name, image_url, price, quantity, amount, memo, profit, profit_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [result.side, result.coin.id, result.coin.symbol, result.coin.name, result.coin.image,
        result.price, result.quantity, result.amount, result.memo, result.profit, result.profitRate]
    );
    const wallet = buildWallet(await selectOrders(client));
    await client.query('COMMIT');

    res.status(201).json({ success: true, data: { order: toOrder(rows[0]), wallet } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// 지갑 초기화 = 주문내역 전체 삭제
app.delete('/api/orders', async (_req, res, next) => {
  try {
    await pool.query('DELETE FROM orders');
    res.json({ success: true, data: buildWallet([]) });
  } catch (err) {
    next(err);
  }
});

// ── Memos ────────────────────────────────────
app.get('/api/memos', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM memos ORDER BY created_at DESC, id DESC');
    res.json({ success: true, data: rows.map(toMemo) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/memos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'id 는 양의 정수여야 해요.' });
  try {
    const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Memo not found' });
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/memos', async (req, res, next) => {
  const input = parseMemoInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      'INSERT INTO memos (title, content) VALUES ($1, $2) RETURNING *',
      [input.title, input.content]
    );
    res.status(201).json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/memos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'id 는 양의 정수여야 해요.' });
  const input = parseMemoInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  try {
    const { rows } = await pool.query(
      'UPDATE memos SET title = $1, content = $2 WHERE id = $3 RETURNING *',
      [input.title, input.content, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Memo not found' });
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/memos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'id 는 양의 정수여야 해요.' });
  try {
    const { rows } = await pool.query('DELETE FROM memos WHERE id = $1 RETURNING *', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Memo not found' });
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
