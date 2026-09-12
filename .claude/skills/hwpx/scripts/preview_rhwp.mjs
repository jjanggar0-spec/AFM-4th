#!/usr/bin/env node
/**
 * HWPX/HWP 시각 점검 — rhwp-studio 웹 뷰어를 Playwright로 띄워 실제 렌더를 캡처한다.
 *
 * 한컴오피스가 없는 머신에서 SKILL.md 의 "한컴에서 시각 점검" 단계를 대신한다.
 * 구조 검증(validate.py)이 잡지 못하는 것 — 빈 페이지, 깨진 표, 누락된 그림,
 * 레이아웃 붕괴 — 을 눈으로 확인하는 용도다.
 *
 * 사용법:
 *   node preview_rhwp.mjs <문서.hwpx> [--out DIR] [--shots N] [--keep-open]
 *
 * 출력: DIR/rhwp-01.png ... 과 요약 JSON(stdout). 문서가 열리지 않으면 exit 1.
 *
 * 의존성: Playwright + Chromium.
 *   npm install -g playwright && npx playwright install chromium
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const VIEWER = "https://edwardkim.github.io/rhwp/";
const EMPTY_HINT = "HWP 파일을 선택해주세요";

function parseArgs(argv) {
  const args = { input: null, out: ".", shots: 6, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--shots") args.shots = Number(argv[++i]);
    else if (a === "--keep-open") args.keepOpen = true;
    else if (!args.input) args.input = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("사용법: node preview_rhwp.mjs <문서.hwpx> [--out DIR] [--shots N]");
  process.exit(2);
}

const input = resolve(args.input);
if (!existsSync(input)) {
  console.error(`파일 없음: ${input}`);
  process.exit(2);
}

// ESM import 는 NODE_PATH 를 보지 않는다. 로컬 → 전역 npm root 순으로 찾는다.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch { /* 전역 설치본을 찾아본다 */ }
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      shell: process.platform === "win32",
    }).trim();
    // playwright 는 CJS 라 import() 로는 named export 가 안 잡힐 때가 있다.
    return createRequire(import.meta.url)(`${root}/playwright`);
  } catch {
    return null;
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error(
    "playwright 를 찾을 수 없다. 설치:\n" +
    "  npm install -g playwright && npx playwright install chromium",
  );
  process.exit(2);
}
const { chromium } = playwright;

mkdirSync(args.out, { recursive: true });

const browser = await chromium.launch({ headless: !args.keepOpen });
const page = await browser.newPage({ viewportSize: { width: 1400, height: 1000 } });

const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e.message)));
page.on("console", (m) => m.type() === "error" && jsErrors.push(m.text()));

await page.goto(VIEWER, { waitUntil: "networkidle" });
await page.setInputFiles("#file-input", input);

// 렌더가 멎을 때까지 — 상태 표시줄 문구가 연속 3회 같아지면 완료로 본다
let previous = "";
let stable = 0;
for (let i = 0; i < 60 && stable < 3; i++) {
  await page.waitForTimeout(500);
  const now = await page.evaluate(() => document.body.innerText);
  if (now === previous) stable++;
  else {
    stable = 0;
    previous = now;
  }
}

const loaded = await page.evaluate((hint) => {
  const text = document.body.innerText;
  return {
    stillEmpty: text.includes(hint),
    pages: (text.match(/\d+ \/ (\d+) 쪽/) || [, "?"])[1],
    // 본문은 캔버스에 그려지므로 innerText 로는 못 읽는다. 그림만 DOM 에 남는다.
    images: [...document.querySelectorAll("img")]
      .filter((i) => i.naturalWidth > 100)
      .map((i) => `${i.naturalWidth}x${i.naturalHeight}`),
    status: (text.match(/[^\n]*페이지 \([\d.]+ms\)/) || [""])[0].trim(),
  };
}, EMPTY_HINT);

// 문서 스크롤 컨테이너를 훑으며 캡처
const scroller = await page.evaluateHandle(() =>
  [...document.querySelectorAll("*")].find(
    (e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300,
  ),
);

const shots = [];
const steps = Math.max(1, args.shots);
for (let i = 0; i < steps; i++) {
  await scroller.evaluate((el, f) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
  }, steps === 1 ? 0 : i / (steps - 1));
  await page.waitForTimeout(1500);
  const file = `${args.out}/rhwp-${basename(input, ".hwpx")}-${String(i + 1).padStart(2, "0")}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
}

console.log(JSON.stringify({
  file: input,
  opened: !loaded.stillEmpty,
  pages: loaded.pages,
  status: loaded.status,
  images: loaded.images,
  js_errors: jsErrors.slice(0, 5),
  screenshots: shots,
}, null, 2));

if (!args.keepOpen) await browser.close();
process.exit(loaded.stillEmpty ? 1 : 0);
