// 2단계 · 시세 조회
//   node scripts/price.mjs
// 전략 3종목(BTC·ETH·XRP)과 지금 지갑에 있는 코인의 현재가, 3종목의 업비트 일봉(최근 10개)과
// 원칙 2 주간 등락률(오늘 09:00 시가 ÷ 7일 전 09:00 시가 − 1)을 data/<오늘>/price.json 에 남긴다.
//
// 모의투자 앱에는 GET /api/price 가 없어 업비트 공개 API 를 직접 부른다 (전략의 공식 판단 데이터도 업비트).

import { join } from 'node:path';
import {
  STRATEGY, api, upbit, currentPrices, addDays, kstDateOf, kstHourOf, kstDateTime,
  roundPct, fmtPct, won, dataDir, writeJson,
} from './lib.mjs';

const now = new Date();
const today = kstDateOf(now);
const weekAgo = addDays(today, -7);

const wallet = await api('/wallet');
const held = Object.values(wallet.holdings).map((h) => ({ id: h.coinId, symbol: h.symbol, name: h.name }));
const targets = [...STRATEGY.coins, ...held.filter((h) => !STRATEGY.coins.some((c) => c.id === h.id))];
const prices = await currentPrices(targets);

const candles = {};
for (const rule of STRATEGY.coins) {
  const rows = await upbit(`/candles/days?market=${rule.market}&count=10`);
  const list = rows.map((c) => ({
    date: c.candle_date_time_kst.slice(0, 10),
    open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
    volumeKrw: Math.round(c.candle_acc_trade_price),
  }));
  const openOn = (ymd) => list.find((c) => c.date === ymd)?.open;
  const todayOpen = openOn(today);
  const weekAgoOpen = openOn(weekAgo);
  candles[rule.market] = {
    candles: list,
    weekly: todayOpen && weekAgoOpen
      ? { today, weekAgo, todayOpen, weekAgoOpen, changePct: roundPct((todayOpen / weekAgoOpen - 1) * 100) }
      : { today, weekAgo, error: kstHourOf(now) < 9 ? '09:00 전이라 오늘 일봉이 없어요.' : '업비트 일봉에 필요한 날짜가 없어요.' },
  };
}

const out = { fetchedAt: now.toISOString(), fetchedAtKst: kstDateTime(now), today, prices, candles };
const file = join(dataDir(today), 'price.json');
writeJson(file, out);

console.log(`# 시세 (${out.fetchedAtKst} KST)\n`);
console.log('| 코인 | 현재가 | 24h | 출처 |\n|---|---:|---:|---|');
for (const t of targets) {
  const p = prices[t.id];
  console.log(`| ${t.symbol.toUpperCase()} | ${p ? won(p.price) : '—'} | ${p?.changeRate24h != null ? fmtPct(p.changeRate24h) : '—'} | ${p?.source ?? '시세 없음'} |`);
}
console.log(`\n| 코인 | ${weekAgo} 09:00 시가 | ${today} 09:00 시가 | 주간 등락률 | ≤ ${STRATEGY.weeklyDropPct}% |\n|---|---:|---:|---:|:---:|`);
for (const rule of STRATEGY.coins) {
  const w = candles[rule.market].weekly;
  console.log(w.error
    ? `| ${rule.symbol.toUpperCase()} | — | — | ${w.error} | — |`
    : `| ${rule.symbol.toUpperCase()} | ${won(w.weekAgoOpen)} | ${won(w.todayOpen)} | ${fmtPct(w.changePct)} | ${w.changePct <= STRATEGY.weeklyDropPct ? '✅' : '❌'} |`);
}
console.log(`\n저장: ${file}`);
