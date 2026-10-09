// 7단계 · 지갑 상태 · 누적 수익률
//   node scripts/wallet.mjs
// 앱 지갑(GET /api/wallet)을 지금 시세로 평가해 리포트에 붙일 마크다운을 출력하고
// data/<오늘>/wallet.json 에 남긴다. 누적 수익률 = 총자산 ÷ 처음 자금 100만 원 − 1.

import { join } from 'node:path';
import { INITIAL_CASH, api, currentPrices, kstDateOf, kstDateTime, fmtPct, won, dataDir, writeJson } from './lib.mjs';

const now = new Date();
const today = kstDateOf(now);
const wallet = await api('/wallet');
const holdings = Object.values(wallet.holdings);
const prices = await currentPrices(holdings.map((h) => ({ id: h.coinId, symbol: h.symbol })));

const rows = holdings.map((h) => {
  const p = prices[h.coinId];
  const value = p ? h.qty * p.price : null;
  return {
    symbol: h.symbol.toUpperCase(), coinId: h.coinId, qty: h.qty, cost: h.cost, avgPrice: h.cost / h.qty,
    price: p?.price ?? null, priceSource: p?.source ?? null, value,
    pnl: value == null ? null : value - h.cost, rate: value == null ? null : (value / h.cost - 1) * 100,
  };
});
const missing = rows.filter((r) => r.value == null);
const coinValue = rows.reduce((s, r) => s + (r.value ?? r.cost), 0); // 시세가 없으면 원가로 둔다
const cost = rows.reduce((s, r) => s + r.cost, 0);
const total = wallet.cash + coinValue;
const realized = wallet.orders.filter((o) => o.side === 'sell').reduce((s, o) => s + (o.profit ?? 0), 0);

const summary = {
  at: now.toISOString(), atKst: kstDateTime(now), cash: wallet.cash, cost, coinValue, total,
  unrealized: coinValue - cost, realized, totalReturnPct: (total / INITIAL_CASH - 1) * 100,
  orderCount: wallet.orders.length, rows,
};
writeJson(join(dataDir(today), 'wallet.json'), summary);

console.log(`| 항목 | 값 |\n|---|---:|`);
console.log(`| 처음 자금 | ${won(INITIAL_CASH)} |`);
console.log(`| 보유 현금 | ${won(wallet.cash)} |`);
console.log(`| 코인 평가액 | ${won(coinValue)} (매수 원가 ${won(cost)}) |`);
console.log(`| **총자산** | **${won(total)}** |`);
console.log(`| 평가손익 (보유분) | ${won(summary.unrealized)} (${fmtPct(cost ? (coinValue / cost - 1) * 100 : 0)}) |`);
console.log(`| 실현손익 (누적) | ${won(realized)} |`);
console.log(`| **누적 수익률** | **${fmtPct(summary.totalReturnPct)}** |`);
console.log(`| 누적 주문 수 | ${wallet.orders.length}건 |`);
console.log(`\n| 코인 | 수량 | 평균단가 | 현재가 | 평가액 | 손익 | 수익률 |\n|---|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) {
  console.log(`| ${r.symbol} | ${Number(r.qty.toFixed(8))} | ${won(r.avgPrice)} | ${r.price ? won(r.price) : '—'} | ${r.value != null ? won(r.value) : '—'} | ${r.pnl != null ? won(r.pnl) : '—'} | ${r.rate != null ? fmtPct(r.rate) : '—'} |`);
}
console.log(`\n> 평가 시각 ${summary.atKst} KST · 시세: ${[...new Set(rows.map((r) => r.priceSource).filter(Boolean))].join(', ')}`);
if (missing.length) console.log(`> ⚠️ 시세를 못 받은 코인(${missing.map((r) => r.symbol).join(', ')})은 원가로 계산했어요.`);
