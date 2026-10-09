// 코인 모의투자 리서치 에이전트 — 공통 설정·도우미
//
// 규칙 숫자는 week-4/quest/research/my-strategy.md 와 coin-dashboard/index.html 의 STRATEGY 를 그대로 옮겼다.
// 전략이 바뀌면 이 파일의 STRATEGY 도 함께 고친다.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 경로 ─────────────────────────────────────
export const COIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STRATEGY_PATH = join(COIN_DIR, '..', '..', '..', 'week-4', 'quest', 'research', 'my-strategy.md');
export const EVENTS_PATH = join(COIN_DIR, 'events.json');
export const dataDir = (date) => join(COIN_DIR, 'data', date);

// ── 모의투자 앱 ──────────────────────────────
// 기본은 배포된 앱. 로컬 서버(node server.js, PORT 3300)로 바꾸려면 COIN_API_BASE=http://localhost:3300
export const API_BASE = (process.env.COIN_API_BASE || 'https://coin-dashboard-tau.vercel.app').replace(/\/$/, '');
export const INITIAL_CASH = 1000000;
export const MIN_ORDER_KRW = 5000;
export const MEMO_MAX_LENGTH = 200;
export const QTY_EPSILON = 1e-8;

// ── 전략 (my-strategy.md) ────────────────────
export const STRATEGY = {
  // 원칙 1 — 앱의 coin.id(CoinGecko id) 와 업비트 마켓 코드. symbol·name·image 는 앱이 저장해 온 값과 맞춘다
  coins: [
    { id: 'bitcoin', market: 'KRW-BTC', symbol: 'btc', name: 'Bitcoin', image: 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400' },
    { id: 'ethereum', market: 'KRW-ETH', symbol: 'eth', name: 'Ethereum', image: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628' },
    { id: 'ripple', market: 'KRW-XRP', symbol: 'xrp', name: 'XRP', image: 'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png?1696501442' },
  ],
  weeklyDropPct: -3,          // 원칙 2 — 주간 등락률이 이 값 이하일 때만 매수
  stopLossPct: -10,           // 원칙 3 ① 손절
  breakEvenPct: 0,            // 원칙 3 ② 익절 후 본전 이탈
  takeProfitPct: 20,          // 원칙 3 ③ 익절
  takeProfitRatio: 0.5,
  maxBuyKrw: 300000,          // 상한 — 1회 매수
  maxCostPerCoinKrw: 400000,  // 상한 — 코인당 매수 원가 합계
};

// ── 시간 (KST) ───────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
export const kstDateOf = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
export const kstHourOf = (date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hourCycle: 'h23' }).format(date));
export const addDays = (ymd, n) => kstDateOf(new Date(new Date(`${ymd}T12:00:00+09:00`).getTime() + n * DAY_MS));
export const kstDateTime = (date) => new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hourCycle: 'h23' });

// ── 숫자 표기 ────────────────────────────────
// 규칙은 소수 둘째 자리(%)로 판단한다 (−9.9999…% 가 −10% 손절을 놓치지 않도록 반올림 후 비교)
export const roundPct = (v) => Math.round(v * 100) / 100 + 0;
export const fmtPct = (v) => { const r = roundPct(v); return `${r > 0 ? '+' : ''}${r.toFixed(2)}%`; };
export const won = (v) => `${Math.round(v).toLocaleString('ko-KR')}원`;

// ── 파일 ─────────────────────────────────────
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// ── HTTP ─────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 업비트·CoinGecko 공개 API 는 초당 호출 수 제한(429)이 있어 잠깐 쉬었다가 다시 부른다
async function getJson(url, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429) { await sleep(600 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${label} 요청 한도 초과`);
}

export const upbit = (path) => getJson(`https://api.upbit.com/v1${path}`, 'Upbit');
export const coingecko = (path) => getJson(`https://api.coingecko.com/api/v3${path}`, 'CoinGecko');

// 모의투자 앱 API — 실패하면 앱이 준 message 를 그대로 올린다
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`앱 ${method} /api${path} 실패 (HTTP ${res.status}): ${json?.message ?? '응답 없음'}`);
  return json.data;
}

// ── 현재가 ───────────────────────────────────
// 판단 데이터는 업비트 원화 시세(전략 공통 기준). 업비트에 없는 코인(BNB 등)만 CoinGecko 원화 시세로 채운다.
export async function currentPrices(coins /* [{ id, symbol }] */) {
  const markets = new Set((await upbit('/market/all')).map((m) => m.market));
  const byId = {};
  const upbitCoins = coins.filter((c) => markets.has(`KRW-${c.symbol.toUpperCase()}`));
  if (upbitCoins.length) {
    const tickers = await upbit(`/ticker?markets=${upbitCoins.map((c) => `KRW-${c.symbol.toUpperCase()}`).join(',')}`);
    for (const c of upbitCoins) {
      const t = tickers.find((x) => x.market === `KRW-${c.symbol.toUpperCase()}`);
      if (t) byId[c.id] = { price: t.trade_price, source: `Upbit ${t.market}`, changeRate24h: t.signed_change_rate * 100, at: new Date(t.trade_timestamp).toISOString() };
    }
  }
  const rest = coins.filter((c) => !byId[c.id]);
  if (rest.length) {
    const cg = await coingecko(`/simple/price?ids=${rest.map((c) => c.id).join(',')}&vs_currencies=krw&include_24hr_change=true&include_last_updated_at=true`);
    for (const c of rest) {
      const p = cg[c.id];
      if (p?.krw) byId[c.id] = { price: p.krw, source: 'CoinGecko KRW (업비트 원화 마켓 없음)', changeRate24h: p.krw_24h_change ?? null, at: new Date(p.last_updated_at * 1000).toISOString() };
    }
  }
  return byId;
}

// 원칙 3 — 지금 포지션(보유 0에서 산 뒤 전량 매도 전까지)에서 매도한 적이 있는지
export function soldInCurrentPosition(ordersNewestFirst, coinId) {
  let qty = 0;
  let sold = false;
  for (const o of [...ordersNewestFirst].reverse()) {
    if (o.coinId !== coinId) continue;
    if (o.side === 'buy') {
      if (qty < QTY_EPSILON) sold = false;
      qty += o.qty;
    } else {
      qty -= o.qty;
      if (qty < QTY_EPSILON) { qty = 0; sold = false; } else sold = true;
    }
  }
  return sold;
}

// 명령행 옵션: --date 2026-10-09 --execute → { date: '2026-10-09', execute: true }
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
