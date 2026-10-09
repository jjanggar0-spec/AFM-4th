// 6단계 · 주문 실행
//   node scripts/order.mjs --memo "판단 근거 한 줄"            ← 미리보기 (주문 안 함)
//   node scripts/order.mjs --memo "판단 근거 한 줄" --execute  ← 실제 체결
// decision.json 의 주문을 모의투자 앱 POST /api/orders 로 보내고, 응답을 data/<오늘>/orders.json 에 남긴다.
// 체결가는 실행 직전에 다시 받은 현재가를 쓴다. memo 칼럼(최대 200자)에 판단 근거를 남긴다.
// 같은 날 두 번 체결되지 않도록 orders.json 이 이미 있으면 멈춘다 (--force 로만 다시 실행).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MEMO_MAX_LENGTH, api, currentPrices, kstDateOf, kstDateTime, won, dataDir, readJson, writeJson, parseArgs } from './lib.mjs';

const args = parseArgs();
const today = kstDateOf(new Date());
const decision = readJson(join(dataDir(today), 'decision.json'));
if (!decision) {
  console.error(`data/${today}/decision.json 이 없어요. 먼저 node scripts/decide.mjs 를 실행해 주세요.`);
  process.exit(1);
}
const ordersFile = join(dataDir(today), 'orders.json');
if (args.execute && existsSync(ordersFile) && !args.force) {
  console.error(`오늘 주문 기록(${ordersFile})이 이미 있어요. 중복 체결을 막기 위해 멈춥니다. 정말 다시 보내려면 --force 를 붙이세요.`);
  process.exit(1);
}
const reason = typeof args.memo === 'string' ? args.memo.trim() : '';
if (decision.orders.length && !reason) {
  console.error('--memo "판단 근거" 가 필요해요. 주문메모 칼럼에 남길 이유를 적어 주세요.');
  process.exit(1);
}

if (!decision.orders.length) {
  console.log(`결론: ${decision.verdict} — 실행할 주문이 없어요.`);
  if (args.execute) writeJson(ordersFile, { executedAt: new Date().toISOString(), verdict: decision.verdict, results: [] });
  process.exit(0);
}

const prices = await currentPrices(decision.orders.map((o) => o.coin));
const memoOf = (o) => `[에이전트 ${decision.verdict}] ${o.rule} · ${o.why} · ${reason}`.slice(0, MEMO_MAX_LENGTH);

const results = [];
for (const o of decision.orders) {
  const p = prices[o.coin.id];
  if (!p) { results.push({ ...o, ok: false, error: '현재가를 구하지 못했어요.' }); continue; }
  const body = { side: o.side, coin: o.coin, price: p.price, memo: memoOf(o), ...(o.side === 'buy' ? { amount: o.amount } : { quantity: o.quantity }) };
  const label = `${o.side === 'buy' ? '매수' : '매도'} ${o.coin.symbol.toUpperCase()} ${o.side === 'buy' ? won(o.amount) : `${o.quantity}개`} @ ${won(p.price)} (${p.source})`;

  if (!args.execute) {
    console.log(`[미리보기] ${label}\n  memo: ${body.memo}`);
    continue;
  }
  try {
    const data = await api('/orders', { method: 'POST', body });
    results.push({ ...o, ok: true, request: body, order: data.order });
    console.log(`✅ 체결 #${data.order.id} ${label}`);
  } catch (err) {
    results.push({ ...o, ok: false, request: body, error: err.message });
    console.log(`❌ 실패 ${label}\n  ${err.message}`);
  }
}

if (args.execute) {
  const now = new Date();
  writeJson(ordersFile, { executedAt: now.toISOString(), executedAtKst: kstDateTime(now), verdict: decision.verdict, results });
  console.log(`\n저장: ${ordersFile}`);
} else {
  console.log('\n미리보기만 했어요. 실제로 체결하려면 --execute 를 붙이세요.');
}
