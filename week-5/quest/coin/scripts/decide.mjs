// 5단계 · 판단 (규칙 계산)
//   node scripts/decide.mjs
// my-strategy.md 의 원칙·상한·금지 조건을 하나씩 대입해 매수 / 매도 / 관망 을 정하고
// 실행할 주문 목록과 함께 data/<오늘>/decision.json 에 남긴다. 주문은 하지 않는다.
//
// 입력: data/<오늘>/price.json (price.mjs) · events.json (리서치에서 오늘 확인한 금지 이벤트) · 앱 지갑

import { join } from 'node:path';
import {
  STRATEGY, MIN_ORDER_KRW, EVENTS_PATH, api, addDays, kstDateOf, kstHourOf, kstDateTime,
  roundPct, fmtPct, won, dataDir, readJson, writeJson, soldInCurrentPosition,
} from './lib.mjs';

const now = new Date();
const today = kstDateOf(now);
const price = readJson(join(dataDir(today), 'price.json'));
if (!price) {
  console.error(`data/${today}/price.json 이 없어요. 먼저 node scripts/price.mjs 를 실행해 주세요.`);
  process.exit(1);
}
const wallet = await api('/wallet');
const events = readJson(EVENTS_PATH, { checkedAt: null, events: [] });

// ── 금지 조건 ────────────────────────────────
// kst: 발표·표결 시각(한국 시각) / 시각을 모르면 usDate / 날짜를 모르면 unconfirmedUntil(그날까지 매수 금지)
function windowOf(ev) {
  if (ev.kst) {
    const day = kstDateOf(new Date(ev.kst));
    return { ...ev, blockedDays: [addDays(day, -1), day] };
  }
  if (ev.usDate) return { ...ev, blockedDays: [addDays(ev.usDate, -1), ev.usDate, addDays(ev.usDate, 1)] };
  return { ...ev, unconfirmed: true, blockedDays: [] };
}
const windows = (events.events ?? []).map(windowOf);
const blocks = windows.filter((w) => (w.unconfirmed ? today <= w.unconfirmedUntil : w.blockedDays.includes(today)));
const eventsFresh = events.checkedAt === today;

// check.ok: true(통과) · false(탈락) · null(확인 불가 → 매수하지 않음)
const verdictOf = (checks) => (checks.some((c) => c.ok === false) ? 'skip' : checks.some((c) => c.ok == null) ? 'unknown' : 'go');

const coinInfo = (rule) => {
  const h = wallet.holdings[rule.id];
  return { id: rule.id, symbol: h?.symbol ?? rule.symbol, name: h?.name ?? rule.name, image: h?.image ?? rule.image };
};

// ── 매수 (원칙 1·2 + 상한 + 금지 조건) ──────────
const buys = STRATEGY.coins.map((rule) => {
  const checks = [{ label: '원칙 1 · 종목', ok: true, text: `${rule.symbol.toUpperCase()}는 매수 대상 3종목이에요.` }];

  const w = price.candles[rule.market]?.weekly;
  if (kstHourOf(now) < 9) {
    checks.push({ label: '원칙 2 · 주간 -3% 이하', ok: false, text: '09:00 전이라 오늘 일봉이 없어요.' });
  } else if (!w || w.error) {
    checks.push({ label: '원칙 2 · 주간 -3% 이하', ok: false, text: `${w?.error ?? '주간 등락률 없음'} 데이터가 없으면 매수하지 않아요.` });
  } else {
    checks.push({
      label: '원칙 2 · 주간 -3% 이하',
      ok: w.changePct <= STRATEGY.weeklyDropPct,
      text: `${w.weekAgo} 09:00 ${won(w.weekAgoOpen)} → ${w.today} 09:00 ${won(w.todayOpen)} = ${fmtPct(w.changePct)}`,
    });
  }

  if (!eventsFresh) {
    checks.push({ label: '금지 조건 · 이벤트', ok: null, text: `events.json 을 오늘(${today}) 확인하지 않았어요 (마지막 확인 ${events.checkedAt ?? '없음'}).` });
  } else if (blocks.length) {
    checks.push({ label: '금지 조건 · 이벤트', ok: false, text: blocks.map((b) => `${b.name} (${b.unconfirmed ? '날짜 미확인' : b.blockedDays[0] === today ? '전날' : '당일'})`).join(', ') });
  } else {
    checks.push({ label: '금지 조건 · 이벤트', ok: true, text: '오늘은 금지 이벤트의 전날·당일이 아니에요.' });
  }

  const boughtToday = wallet.orders.some((o) => o.side === 'buy' && o.coinId === rule.id && kstDateOf(new Date(o.at)) === today);
  checks.push({ label: '상한 · 하루 1회', ok: !boughtToday, text: boughtToday ? `오늘 이미 ${rule.symbol.toUpperCase()}를 샀어요.` : '오늘 매수 기록이 없어요.' });

  const cost = wallet.holdings[rule.id]?.cost ?? 0;
  const amount = Math.floor(Math.min(STRATEGY.maxBuyKrw, Math.max(0, STRATEGY.maxCostPerCoinKrw - cost), wallet.cash));
  checks.push({
    label: '상한 · 매수 금액',
    ok: amount >= MIN_ORDER_KRW,
    text: `min(30만 원, 40만 원 − 보유 원가 ${won(cost)}, 현금 ${won(wallet.cash)}) = ${won(amount)}${amount < MIN_ORDER_KRW ? ` · 최소 주문 ${won(MIN_ORDER_KRW)} 미만` : ''}`,
  });

  const verdict = verdictOf(checks);
  return { coin: coinInfo(rule), market: rule.market, weekly: w, checks, verdict, amount: verdict === 'go' ? amount : 0 };
});

// ── 매도 (원칙 3, 보유 중인 모든 코인 · 금지 조건과 무관) ──
const sells = Object.values(wallet.holdings).map((h) => {
  const coin = { id: h.coinId, symbol: h.symbol, name: h.name, image: h.image };
  const avgPrice = h.cost / h.qty;
  const p = price.prices[h.coinId];
  if (!p) return { coin, avgPrice, verdict: 'unknown', action: '판단 불가', text: '현재가를 구하지 못했어요.' };
  const rate = roundPct((p.price / avgPrice - 1) * 100);
  const sold = soldInCurrentPosition(wallet.orders, h.coinId);
  const base = { coin, qty: h.qty, cost: h.cost, avgPrice, price: p.price, priceSource: p.source, rate, sold, pnl: h.qty * p.price - h.cost };

  if (rate <= STRATEGY.stopLossPct) return { ...base, verdict: 'go', action: '손절 · 전량 매도', rule: '원칙 3 ①', sellQty: h.qty, text: `수익률 ${fmtPct(rate)} ≤ ${STRATEGY.stopLossPct}%` };
  if (sold && rate <= STRATEGY.breakEvenPct) return { ...base, verdict: 'go', action: '본전 이탈 · 전량 매도', rule: '원칙 3 ②', sellQty: h.qty, text: `이미 익절한 포지션, 수익률 ${fmtPct(rate)} ≤ 0%` };
  if (!sold && rate >= STRATEGY.takeProfitPct) {
    const sellQty = Math.floor(h.qty * STRATEGY.takeProfitRatio * 1e8) / 1e8;
    return { ...base, verdict: 'go', action: '익절 · 50% 매도', rule: '원칙 3 ③', sellQty, text: `수익률 ${fmtPct(rate)} ≥ +${STRATEGY.takeProfitPct}%, 이번 포지션 첫 매도` };
  }
  return { ...base, verdict: 'skip', action: '보유 유지', text: `수익률 ${fmtPct(rate)} · 손절 ${STRATEGY.stopLossPct}% / 익절 +${STRATEGY.takeProfitPct}% 사이${sold ? ' (이미 익절한 포지션)' : ''}` };
});

// ── 결론 ─────────────────────────────────────
// 매도 규칙은 언제든 먼저 실행하므로 매도가 하나라도 있으면 '매도', 매수만 있으면 '매수', 없으면 '관망'
const orders = [
  ...sells.filter((s) => s.verdict === 'go').map((s) => ({ side: 'sell', coin: s.coin, quantity: s.sellQty, rule: `${s.rule} ${s.action}`, why: s.text })),
  ...buys.filter((b) => b.verdict === 'go').map((b) => ({ side: 'buy', coin: b.coin, amount: b.amount, rule: '원칙 2 매수', why: `주간 ${fmtPct(b.weekly.changePct)} · 금지 이벤트 없음` })),
];
const verdict = orders.some((o) => o.side === 'sell') ? '매도' : orders.length ? '매수' : '관망';

const out = { decidedAt: now.toISOString(), decidedAtKst: kstDateTime(now), today, verdict, orders, buys, sells, blocks, eventsCheckedAt: events.checkedAt, cash: wallet.cash };
const file = join(dataDir(today), 'decision.json');
writeJson(file, out);

console.log(`# 판단 · ${today} (${out.decidedAtKst} KST)\n\n결론: **${verdict}**\n`);
console.log('## 매수 점검');
for (const b of buys) {
  console.log(`\n### ${b.coin.symbol.toUpperCase()} → ${{ go: '매수', skip: '매수 안 함', unknown: '판단 불가(매수 안 함)' }[b.verdict]}${b.verdict === 'go' ? ` ${won(b.amount)}` : ''}`);
  for (const c of b.checks) console.log(`- ${c.ok === true ? '✅' : c.ok === false ? '❌' : '❔'} ${c.label}: ${c.text}`);
}
console.log('\n## 매도 점검\n\n| 코인 | 평균단가 | 현재가 | 수익률 | 판단 |\n|---|---:|---:|---:|---|');
for (const s of sells) console.log(`| ${s.coin.symbol.toUpperCase()} | ${won(s.avgPrice)} | ${s.price ? won(s.price) : '—'} | ${s.rate != null ? fmtPct(s.rate) : '—'} | ${s.action} — ${s.text} |`);
console.log(`\n## 실행할 주문 (${orders.length}건)`);
for (const o of orders) console.log(`- ${o.side === 'buy' ? '매수' : '매도'} ${o.coin.symbol.toUpperCase()} ${o.side === 'buy' ? won(o.amount) : `${o.quantity}개`} — ${o.rule}`);
console.log(`\n저장: ${file}`);
