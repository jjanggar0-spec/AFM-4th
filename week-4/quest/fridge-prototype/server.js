// 냉장고 재료 & 레시피 관리 프로토타입 — 재료 / 레시피 / 장보기 / 즐겨찾기 API 서버 (Supabase PostgreSQL)
//
// 같은 Supabase 프로젝트를 쓰는 week-4/quest/fridge-recipe 의 ingredients·recipes 테이블과
// 충돌하지 않도록 이 프로토타입의 테이블은 모두 fp_ 접두사를 쓴다.

// ── Module imports ───────────────────────────
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { Object.assign(process.env, util.parseEnv(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'))); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

// 아래 상수는 index.html 의 같은 이름 상수와 값이 같아야 한다
const CATEGORIES = ['채소', '육류·해산물', '유제품·계란', '양념', '가공식품', '과일', '곡물'];
const LOCATIONS = ['냉장', '냉동', '실온'];
const NAME_MAX = 30;   // 재료 / 장보기 항목 이름 글자 수
const UNIT_MAX = 10;   // 단위 글자 수
const QTY_MAX = 99999; // 수량 상한
const DAYS_MIN = -365; // 유통기한 오프셋 하한 (이미 지난 재료 허용)
const DAYS_MAX = 3650; // 유통기한 오프셋 상한
const LIST_LIMIT = 500;

// AI 레시피 생성 (OpenAI). 키가 비어 있으면 생성 기능만 꺼지고 나머지는 그대로 동작한다
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-5.4-mini').trim();
const OPENAI_TIMEOUT_MS = 45000;
const TITLE_MAX = 60;         // 요리명 글자 수
const SUMMARY_MAX = 300;      // 한 줄 소개 글자 수
const STEP_MAX = 500;         // 조리 단계 하나의 글자 수
const RECIPE_ITEMS_MAX = 20;  // 레시피 하나의 재료 수 상한
const RECIPE_STEPS_MAX = 15;  // 레시피 하나의 단계 수 상한
const RECIPE_TAGS_MAX = 5;    // 태그 수 상한
const AI_REQUEST_MAX = 200;   // 사용자가 적는 요청사항 글자 수

// 로그인 / 회원가입 (JWT). JWT_SECRET 이 없으면 인증 자체를 막아 토큰을 위조당하지 않게 한다
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';  // 토큰 유효기간 (클라이언트 localStorage 에 보관)
const EMAIL_MAX = 120;
const NICKNAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;      // bcrypt 는 72바이트까지만 반영한다
const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database schema (lazy init) ──────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS fp_users (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL CHECK (char_length(email) BETWEEN 3 AND ${EMAIL_MAX}),
    nickname      TEXT        NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND ${NICKNAME_MAX}),
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- 대소문자만 다른 같은 이메일로 중복 가입되지 않게 소문자 기준 유니크
  CREATE UNIQUE INDEX IF NOT EXISTS fp_users_email_key ON fp_users (lower(email));

  CREATE TABLE IF NOT EXISTS fp_ingredients (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${NAME_MAX}),
    category   TEXT        NOT NULL,
    qty        INTEGER     NOT NULL DEFAULT 1 CHECK (qty BETWEEN 0 AND ${QTY_MAX}),
    unit       TEXT        NOT NULL DEFAULT '개',
    location   TEXT        NOT NULL DEFAULT '냉장',
    added_at   DATE        NOT NULL DEFAULT CURRENT_DATE,
    expires_at DATE        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS fp_ingredients_expires_at_idx ON fp_ingredients (expires_at);

  CREATE TABLE IF NOT EXISTS fp_recipes (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL,
    emoji      TEXT        NOT NULL DEFAULT '🍽',
    minutes    INTEGER     NOT NULL DEFAULT 15,
    difficulty TEXT        NOT NULL DEFAULT '쉬움',
    servings   INTEGER     NOT NULL DEFAULT 1,
    tags       TEXT[]      NOT NULL DEFAULT '{}',
    summary    TEXT        NOT NULL DEFAULT '',
    items      JSONB       NOT NULL DEFAULT '[]',
    steps      TEXT[]      NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS fp_recipes_created_at_idx ON fp_recipes (created_at);

  -- 이미 만들어진 테이블에도 AI 생성 여부 칼럼을 더한다
  ALTER TABLE fp_recipes ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS fp_shopping_items (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${NAME_MAX}),
    qty        TEXT        NOT NULL DEFAULT '1개',
    done       BOOLEAN     NOT NULL DEFAULT false,
    source     TEXT        NOT NULL DEFAULT '직접 추가',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS fp_shopping_items_name_key ON fp_shopping_items (name);

  CREATE TABLE IF NOT EXISTS fp_favorites (
    recipe_id  BIGINT      PRIMARY KEY REFERENCES fp_recipes (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- 로그인 도입 전에 만들어진 테이블에도 주인(user_id)을 붙인다.
  -- 주인이 아직 없는 행(user_id IS NULL)은 처음 가입하는 계정이 넘겨받는다 (claimOrphanRows 참고)
  ALTER TABLE fp_ingredients    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES fp_users (id) ON DELETE CASCADE;
  ALTER TABLE fp_recipes        ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES fp_users (id) ON DELETE CASCADE;
  ALTER TABLE fp_shopping_items ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES fp_users (id) ON DELETE CASCADE;
  ALTER TABLE fp_favorites      ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES fp_users (id) ON DELETE CASCADE;

  CREATE INDEX IF NOT EXISTS fp_ingredients_user_idx    ON fp_ingredients (user_id);
  CREATE INDEX IF NOT EXISTS fp_recipes_user_idx        ON fp_recipes (user_id);
  CREATE INDEX IF NOT EXISTS fp_shopping_items_user_idx ON fp_shopping_items (user_id);

  -- 장보기 중복 방지는 "전체에서 이름 하나"가 아니라 "계정마다 이름 하나"가 돼야 한다
  DROP INDEX IF EXISTS fp_shopping_items_name_key;
  CREATE UNIQUE INDEX IF NOT EXISTS fp_shopping_items_user_name_key ON fp_shopping_items (user_id, name);

  -- 즐겨찾기도 레시피 하나당 1행이 아니라 (계정, 레시피) 조합당 1행이 돼야 한다
  ALTER TABLE fp_favorites DROP CONSTRAINT IF EXISTS fp_favorites_pkey;
  CREATE UNIQUE INDEX IF NOT EXISTS fp_favorites_user_recipe_key ON fp_favorites (user_id, recipe_id);

  ALTER TABLE fp_users          ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fp_ingredients    ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fp_recipes        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fp_shopping_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fp_favorites      ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  fp_ingredients            IS '냉장고 프로토타입 - 보관 중인 재료';
  COMMENT ON COLUMN fp_ingredients.name       IS '재료 이름';
  COMMENT ON COLUMN fp_ingredients.category   IS '분류 (채소 / 육류·해산물 / 유제품·계란 / 양념 / 가공식품 / 과일 / 곡물)';
  COMMENT ON COLUMN fp_ingredients.qty        IS '수량 (0 이면 소진)';
  COMMENT ON COLUMN fp_ingredients.unit       IS '단위 (개 / g / ml 등)';
  COMMENT ON COLUMN fp_ingredients.location   IS '보관 위치 (냉장 / 냉동 / 실온)';
  COMMENT ON COLUMN fp_ingredients.expires_at IS '소비기한';

  COMMENT ON TABLE  fp_recipes              IS '냉장고 프로토타입 - 레시피';
  COMMENT ON COLUMN fp_recipes.items        IS '필요한 재료 [{ name, amount }]';
  COMMENT ON COLUMN fp_recipes.steps        IS '조리법 (단계 순서대로)';
  COMMENT ON COLUMN fp_recipes.ai_generated IS 'AI 가 생성한 레시피인지 여부';

  COMMENT ON TABLE  fp_shopping_items        IS '냉장고 프로토타입 - 장보기 목록';
  COMMENT ON COLUMN fp_shopping_items.source IS '어떤 레시피에서 담겼는지';

  COMMENT ON TABLE  fp_favorites IS '냉장고 프로토타입 - 즐겨찾기한 레시피';

  COMMENT ON TABLE  fp_users               IS '냉장고 프로토타입 - 가입한 사용자';
  COMMENT ON COLUMN fp_users.email         IS '로그인 아이디로 쓰는 이메일 (대소문자 무시하고 유일)';
  COMMENT ON COLUMN fp_users.nickname      IS '화면에 보여줄 이름';
  COMMENT ON COLUMN fp_users.password_hash IS 'bcrypt 해시 (평문 비밀번호는 저장하지 않는다)';
`;

// ── Seed data ────────────────────────────────
// expires_at 은 시드 시점의 CURRENT_DATE 기준 오프셋(일)으로 넣어, 처음 열었을 때 D-day 가 자연스럽게 보이게 한다
const SEED_INGREDIENTS = [
  ['삼겹살', '육류·해산물', 300, 'g', '냉장', -2, 2],
  ['계란', '유제품·계란', 8, '개', '냉장', -5, 12],
  ['대파', '채소', 2, '대', '냉장', -3, 4],
  ['양파', '채소', 3, '개', '실온', -8, 20],
  ['김치', '가공식품', 1, '통', '냉장', -20, 45],
  ['두부', '가공식품', 1, '모', '냉장', -4, 1],
  ['우유', '유제품·계란', 900, 'ml', '냉장', -6, 2],
  ['체다치즈', '유제품·계란', 5, '장', '냉장', -7, 16],
  ['애호박', '채소', 1, '개', '냉장', -9, -1],
  ['당근', '채소', 2, '개', '냉장', -6, 14],
  ['감자', '채소', 4, '개', '실온', -10, 25],
  ['청양고추', '채소', 6, '개', '냉장', -3, 6],
  ['마늘', '채소', 1, '통', '냉장', -12, 30],
  ['새우', '육류·해산물', 200, 'g', '냉동', -15, 60],
  ['베이컨', '육류·해산물', 6, '줄', '냉장', -2, 7],
  ['모짜렐라치즈', '유제품·계란', 150, 'g', '냉장', -5, 11],
  ['버터', '유제품·계란', 200, 'g', '냉장', -18, 40],
  ['만두피', '가공식품', 20, '장', '냉동', -11, 35],
  ['쌀국수면', '곡물', 2, '인분', '실온', -14, 120],
  ['밥', '곡물', 2, '공기', '냉장', -1, 3],
  ['방울토마토', '과일', 15, '개', '냉장', -4, 5],
  ['사과', '과일', 3, '개', '냉장', -5, 9],
  ['간장', '양념', 1, '병', '실온', -60, 200],
  ['고추장', '양념', 1, '통', '냉장', -45, 180],
  ['참기름', '양념', 1, '병', '실온', -50, 150],
  ['설탕', '양념', 1, '봉', '실온', -70, 300],
];

const SEED_RECIPES = [
  {
    name: '삼겹살 김치 쌀국수', emoji: '🍜', minutes: 20, difficulty: '보통', servings: 1,
    tags: ['야식', '한그릇', '국물'],
    summary: '남은 삼겹살과 잘 익은 김치로 끓이는 얼큰한 국물 쌀국수. 육수를 따로 안 내도 충분히 진합니다.',
    items: [
      { name: '삼겹살', amount: '150g' }, { name: '김치', amount: '1컵' },
      { name: '쌀국수면', amount: '1인분' }, { name: '대파', amount: '1대' },
      { name: '간장', amount: '1큰술' }, { name: '참기름', amount: '약간' },
    ],
    steps: [
      '삼겹살은 한입 크기로 썰어 달군 팬에 기름 없이 볶는다.',
      '기름이 나오면 김치를 넣고 2분간 함께 볶아 감칠맛을 낸다.',
      '물 500ml를 붓고 간장 1큰술을 넣어 5분간 끓인다.',
      '쌀국수면을 넣고 3분 더 끓인 뒤 대파를 넣는다.',
      '불을 끄고 참기름을 몇 방울 둘러 마무리한다.',
    ],
  },
  {
    name: '치즈 김치 군만두', emoji: '🥟', minutes: 15, difficulty: '쉬움', servings: 1,
    tags: ['야식', '간편', '에어프라이어'],
    summary: '만두피에 김치와 모짜렐라만 넣고 구우면 끝. 바삭한 겉면과 늘어나는 치즈의 조합.',
    items: [
      { name: '만두피', amount: '8장' }, { name: '김치', amount: '1/2컵' },
      { name: '모짜렐라치즈', amount: '80g' }, { name: '참기름', amount: '약간' },
    ],
    steps: [
      '김치는 국물을 꼭 짜고 잘게 다진다.',
      '다진 김치와 모짜렐라치즈를 섞어 소를 만든다.',
      '만두피 가운데에 소를 올리고 가장자리에 물을 발라 반으로 접어 붙인다.',
      '에어프라이어 190도에서 8분, 중간에 한 번 뒤집는다.',
      '참기름을 살짝 발라 광을 낸다.',
    ],
  },
  {
    name: '계란 볶음밥', emoji: '🍳', minutes: 12, difficulty: '쉬움', servings: 1,
    tags: ['간편', '한그릇', '아침'],
    summary: '찬밥과 계란만 있으면 되는 기본 볶음밥. 대파기름을 먼저 내는 게 포인트입니다.',
    items: [
      { name: '밥', amount: '1공기' }, { name: '계란', amount: '2개' },
      { name: '대파', amount: '1/2대' }, { name: '당근', amount: '1/4개' },
      { name: '간장', amount: '1작은술' }, { name: '참기름', amount: '약간' },
    ],
    steps: [
      '대파를 송송 썰어 기름에 약불로 볶아 파기름을 낸다.',
      '잘게 썬 당근을 넣고 1분간 볶는다.',
      '계란을 풀어 넣고 반쯤 익으면 밥을 넣어 강불로 볶는다.',
      '팬 가장자리에 간장을 둘러 불향을 입힌다.',
      '참기름을 두르고 그릇에 눌러 담아 낸다.',
    ],
  },
  {
    name: '애호박 두부 된장찌개', emoji: '🥘', minutes: 25, difficulty: '보통', servings: 2,
    tags: ['국물', '집밥'],
    summary: '유통기한 임박한 애호박과 두부를 한 번에 처리할 수 있는 기본 된장찌개.',
    items: [
      { name: '애호박', amount: '1/2개' }, { name: '두부', amount: '1/2모' },
      { name: '양파', amount: '1/2개' }, { name: '청양고추', amount: '1개' },
      { name: '된장', amount: '2큰술' }, { name: '멸치육수', amount: '600ml' },
    ],
    steps: [
      '멸치육수를 끓이고 된장을 체에 걸러 푼다.',
      '양파와 애호박을 큼직하게 썰어 넣고 5분간 끓인다.',
      '두부를 넣고 3분 더 끓인다.',
      '청양고추를 넣고 한소끔 끓여 마무리한다.',
    ],
  },
  {
    name: '감자채전', emoji: '🥔', minutes: 18, difficulty: '쉬움', servings: 1,
    tags: ['야식', '간편'],
    summary: '밀가루 없이 감자 전분만으로 붙이는 겉바속촉 감자채전.',
    items: [
      { name: '감자', amount: '2개' }, { name: '양파', amount: '1/4개' },
      { name: '소금', amount: '약간' },
    ],
    steps: [
      '감자는 채칼로 가늘게 썰어 찬물에 5분 담갔다 물기를 짠다.',
      '양파도 가늘게 채 썰어 감자와 섞고 소금으로 간한다.',
      '기름을 넉넉히 두른 팬에 얇게 펴 올린다.',
      '중불에서 한 면당 4분씩, 가장자리가 갈색이 될 때까지 굽는다.',
    ],
  },
  {
    name: '베이컨 까르보나라', emoji: '🍝', minutes: 20, difficulty: '보통', servings: 1,
    tags: ['양식', '한그릇'],
    summary: '생크림 없이 계란 노른자와 치즈로 만드는 정통식 까르보나라.',
    items: [
      { name: '스파게티면', amount: '100g' }, { name: '베이컨', amount: '3줄' },
      { name: '계란', amount: '2개' }, { name: '체다치즈', amount: '2장' },
      { name: '마늘', amount: '2쪽' }, { name: '후추', amount: '넉넉히' },
    ],
    steps: [
      '스파게티면을 소금 넣은 물에 8분간 삶고 면수를 한 컵 남긴다.',
      '베이컨과 편 썬 마늘을 약불에서 천천히 볶아 기름을 낸다.',
      '계란 노른자 2개와 치즈, 후추를 섞어 소스를 만든다.',
      '불을 끈 팬에 면과 소스를 넣고 면수를 조금씩 섞어 농도를 맞춘다.',
      '접시에 담고 후추를 더 뿌린다.',
    ],
  },
  {
    name: '새우 마늘 버터구이', emoji: '🍤', minutes: 10, difficulty: '쉬움', servings: 1,
    tags: ['야식', '간편', '술안주'],
    summary: '냉동 새우를 해동해 마늘버터에 굽기만 하면 되는 10분 안주.',
    items: [
      { name: '새우', amount: '150g' }, { name: '마늘', amount: '4쪽' },
      { name: '버터', amount: '20g' }, { name: '청양고추', amount: '1개' },
    ],
    steps: [
      '냉동 새우는 찬물에 5분 담가 해동하고 물기를 닦는다.',
      '팬에 버터를 녹이고 편 썬 마늘을 약불로 볶는다.',
      '마늘 향이 올라오면 새우를 넣고 강불에서 2분간 굽는다.',
      '송송 썬 청양고추를 넣고 30초 더 볶아 낸다.',
    ],
  },
  {
    name: '토마토 계란볶음', emoji: '🍅', minutes: 12, difficulty: '쉬움', servings: 1,
    tags: ['간편', '중식', '아침'],
    summary: '방울토마토가 남았을 때 가장 빠르게 해치우는 중국식 가정 요리.',
    items: [
      { name: '방울토마토', amount: '10개' }, { name: '계란', amount: '3개' },
      { name: '대파', amount: '1/2대' }, { name: '설탕', amount: '1작은술' },
    ],
    steps: [
      '계란을 풀어 소금 약간을 넣고 팬에 스크램블해 따로 덜어둔다.',
      '방울토마토를 반으로 잘라 팬에 넣고 으깨듯 볶는다.',
      '설탕 1작은술로 신맛을 잡는다.',
      '덜어둔 계란을 다시 넣고 대파를 올려 가볍게 섞는다.',
    ],
  },
  {
    name: '사과 요거트 볼', emoji: '🥣', minutes: 5, difficulty: '쉬움', servings: 1,
    tags: ['아침', '간편', '디저트'],
    summary: '칼질 5분이면 끝나는 아침 대용 요거트 볼.',
    items: [
      { name: '사과', amount: '1개' }, { name: '플레인요거트', amount: '200g' },
      { name: '꿀', amount: '1큰술' }, { name: '그래놀라', amount: '30g' },
    ],
    steps: [
      '사과를 껍질째 깍둑 썬다.',
      '볼에 요거트를 담고 사과를 올린다.',
      '꿀을 두르고 그래놀라를 뿌린다.',
    ],
  },
];

const SEED_SHOPPING = [
  ['된장', '1통', false, '애호박 두부 된장찌개'],
  ['스파게티면', '500g', false, '베이컨 까르보나라'],
  ['플레인요거트', '2개', true, '사과 요거트 볼'],
];

// 갓 가입한 계정의 냉장고를 예시 데이터로 채운다. 이미 뭔가 들어 있으면 건드리지 않는다
async function seedForUser(userId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM fp_ingredients WHERE user_id = $1', [userId]);
  if (rows[0].n === 0) {
    for (const [name, category, qty, unit, location, addedOffset, expiresOffset] of SEED_INGREDIENTS) {
      await pool.query(
        `INSERT INTO fp_ingredients (user_id, name, category, qty, unit, location, added_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + $7::int, CURRENT_DATE + $8::int)`,
        [userId, name, category, qty, unit, location, addedOffset, expiresOffset]
      );
    }
  }

  const { rows: r } = await pool.query('SELECT COUNT(*)::int AS n FROM fp_recipes WHERE user_id = $1', [userId]);
  if (r[0].n === 0) {
    for (const rec of SEED_RECIPES) {
      await pool.query(
        `INSERT INTO fp_recipes (user_id, name, emoji, minutes, difficulty, servings, tags, summary, items, steps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [userId, rec.name, rec.emoji, rec.minutes, rec.difficulty, rec.servings,
         rec.tags, rec.summary, JSON.stringify(rec.items), rec.steps]
      );
    }
    // 시드 직후 기본 즐겨찾기 2개 (첫 번째 · 일곱 번째 레시피)
    await pool.query(
      `INSERT INTO fp_favorites (user_id, recipe_id)
       SELECT $1, id FROM fp_recipes WHERE user_id = $1 AND name = ANY($2)
       ON CONFLICT DO NOTHING`,
      [userId, ['삼겹살 김치 쌀국수', '새우 마늘 버터구이']]
    );
  }

  const { rows: s } = await pool.query('SELECT COUNT(*)::int AS n FROM fp_shopping_items WHERE user_id = $1', [userId]);
  if (s[0].n === 0) {
    for (const [name, qty, done, source] of SEED_SHOPPING) {
      await pool.query(
        `INSERT INTO fp_shopping_items (user_id, name, qty, done, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, name) DO NOTHING`,
        [userId, name, qty, done, source]
      );
    }
  }
}

// 로그인 기능이 생기기 전에 쌓여 있던 주인 없는 데이터를 첫 가입자에게 넘긴다.
// 두 번째 가입자부터는 넘겨받을 게 남아 있지 않으므로 자기 냉장고만 보게 된다
async function claimOrphanRows(userId) {
  for (const table of ['fp_ingredients', 'fp_recipes', 'fp_shopping_items', 'fp_favorites']) {
    await pool.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
  }
}

// 서버리스 cold start 마다 불릴 수 있어 한 번만 실행되게 promise 를 공유한다
let dbInitPromise = null;
function initDB() {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      if (!(process.env.DATABASE_URL || '').trim()) throw new Error('DATABASE_URL is not set');
      await pool.query(SCHEMA_SQL);
      // 시드는 회원가입 시점에 그 계정 냉장고로 들어간다 (seedForUser)
    })().catch((err) => {
      dbInitPromise = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbInitPromise;
}

// ── Helpers ──────────────────────────────────
const ID_RE = /^[1-9]\d{0,15}$/;

const INGREDIENT_COLUMNS =
  `id, name, category, qty, unit, location,
   to_char(added_at, 'YYYY-MM-DD')   AS added_at,
   to_char(expires_at, 'YYYY-MM-DD') AS expires_at`;
const RECIPE_COLUMNS = 'id, name, emoji, minutes, difficulty, servings, tags, summary, items, steps, ai_generated';
const SHOPPING_COLUMNS = 'id, name, qty, done, source';

const toIngredient = (row) => ({
  id: String(row.id),
  name: row.name,
  category: row.category,
  qty: Number(row.qty),
  unit: row.unit,
  location: row.location,
  addedAt: row.added_at,
  expiresAt: row.expires_at,
});

const toRecipe = (row) => ({
  id: String(row.id),
  name: row.name,
  emoji: row.emoji,
  minutes: Number(row.minutes),
  difficulty: row.difficulty,
  servings: Number(row.servings),
  tags: row.tags || [],
  summary: row.summary,
  items: row.items || [],
  steps: row.steps || [],
  aiGenerated: row.ai_generated === true,
});

const toShopping = (row) => ({
  id: String(row.id),
  name: row.name,
  qty: row.qty,
  done: row.done,
  source: row.source,
});

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** 문자열 필드 정리 + 길이 검증. 통과하면 다듬은 문자열, 실패하면 null */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** 길이를 넘으면 자른다 (모델 출력처럼 거부보다 다듬는 게 나은 값에 쓴다) */
const clip = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

// ── Auth helpers (JWT) ───────────────────────
// 비밀번호 해시는 절대 밖으로 내보내지 않는다
const toUser = (row) => ({
  id: String(row.id),
  email: row.email,
  nickname: row.nickname,
});

/** 로그인·가입 성공 시 발급하는 액세스 토큰 (HS256, 7일) */
const signToken = (user) =>
  jwt.sign(
    { sub: user.id, email: user.email, nickname: user.nickname },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

/** Authorization: Bearer <token> 헤더에서 토큰만 뽑아낸다 */
function readBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * 토큰을 검증하고 req.user 를 채운다. 여기를 통과한 라우트는 req.user.id 로만 DB 를 읽고 쓴다.
 * code 를 함께 내려 클라이언트가 "만료됐으니 다시 로그인" 을 구분할 수 있게 한다
 */
async function requireAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ success: false, message: '서버에 JWT_SECRET 이 설정되지 않았습니다' });
  }

  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', message: '로그인이 필요합니다' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      message: expired ? '로그인이 만료됐어요. 다시 로그인해 주세요' : '토큰이 올바르지 않습니다',
    });
  }

  // 토큰은 유효해도 계정이 지워졌을 수 있으니 DB 에서 한 번 더 확인한다
  try {
    const { rows } = await pool.query('SELECT id, email, nickname FROM fp_users WHERE id = $1', [payload.sub]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, code: 'NO_USER', message: '계정을 찾을 수 없습니다' });
    }
    req.user = toUser(rows[0]);
    next();
  } catch (err) { next(err); }
}

// ── AI 레시피 생성 (OpenAI) ──────────────────
// 구조화 출력(strict json_schema)으로 받아 파싱 실패 가능성을 없앤다
const RECIPE_JSON_SCHEMA = {
  name: 'recipe',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'emoji', 'minutes', 'difficulty', 'servings', 'tags', 'summary', 'items', 'steps'],
    properties: {
      name: { type: 'string', description: '요리명 (한국어)' },
      emoji: { type: 'string', description: '요리를 대표하는 이모지 하나' },
      minutes: { type: 'integer', description: '총 조리 시간 (분)' },
      difficulty: { type: 'string', enum: ['쉬움', '보통', '어려움'] },
      servings: { type: 'integer', description: '인분 수' },
      tags: { type: 'array', items: { type: 'string' }, description: '짧은 한국어 태그 2~4개' },
      summary: { type: 'string', description: '요리를 한두 문장으로 소개' },
      items: {
        type: 'array',
        description: '필요한 재료와 분량',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'amount'],
          properties: {
            name: { type: 'string', description: '재료 이름. 냉장고 목록에 있는 재료는 그 이름을 그대로 쓴다' },
            amount: { type: 'string', description: '분량 (예: 150g, 1/2대, 약간)' },
          },
        },
      },
      steps: { type: 'array', items: { type: 'string' }, description: '조리 단계 (순서대로)' },
    },
  },
};

/** 냉장고 현황을 모델이 읽기 좋은 텍스트로 만든다 */
function describeFridge(rows) {
  return rows
    .map((r) => {
      const left = Number(r.days_left);
      const when = left < 0 ? '기한 지남' : left === 0 ? '오늘까지' : `D-${left}`;
      return `- ${r.name} (${r.category}, ${r.qty}${r.unit}, ${r.location} 보관, ${when})`;
    })
    .join('\n');
}

async function callOpenAI(fridgeText, request, focusText) {
  const userPrompt = [
    '## 지금 냉장고에 있는 재료',
    fridgeText || '(비어 있음)',
    '',
    focusText,
    request ? `\n## 사용자 요청사항\n${request}` : '',
    '',
    '## 지켜야 할 것',
    '- 위 냉장고 재료를 최대한 활용한다. 목록에 있는 재료는 이름을 한 글자도 바꾸지 말고 그대로 쓴다.',
    '- 소금·후추·식용유·물처럼 집에 흔히 있는 것은 목록에 없어도 써도 된다.',
    '- 그 외에 목록에 없는 재료는 꼭 필요할 때만 2개 이하로 쓴다.',
    '- 기한이 임박한 재료가 있으면 그것부터 소비하는 구성으로 만든다.',
    '- 조리 단계는 4~8단계로, 계량과 불 세기를 포함해 구체적으로 쓴다.',
    '- 모든 값은 한국어로 쓴다.',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: '너는 한국 가정식에 밝은 요리사다. 집에 있는 재료로 실제로 만들 수 있는 현실적인 레시피만 제안한다.',
          },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_schema', json_schema: RECIPE_JSON_SCHEMA },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('AI 응답이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요');
    throw new Error('AI 서버에 연결하지 못했습니다');
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);

  if (!res.ok || !json || json.error) {
    // 키·쿼터 문제는 서버 로그에만 자세히 남기고 사용자에게는 짧게 알린다
    console.error('OpenAI error:', res.status, json && json.error && json.error.message);
    if (res.status === 401) throw new Error('OpenAI API 키가 올바르지 않습니다');
    if (res.status === 429) throw new Error('OpenAI 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요');
    throw new Error('AI 레시피 생성에 실패했습니다');
  }

  const choice = json.choices && json.choices[0];
  if (choice && choice.message && choice.message.refusal) {
    throw new Error('AI 가 이 요청에 대한 레시피 작성을 거절했습니다');
  }

  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('AI 가 빈 응답을 보냈습니다');

  try {
    return JSON.parse(content);
  } catch {
    throw new Error('AI 응답을 해석하지 못했습니다');
  }
}

/** 모델 출력은 그대로 믿지 않는다. DB 제약과 화면에 맞게 다듬고, 못 쓸 값이면 거절한다 */
function sanitizeRecipe(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('AI 응답 형식이 올바르지 않습니다');

  const name = clip(raw.name, TITLE_MAX);
  if (!name) throw new Error('AI 가 요리명을 만들지 못했습니다');

  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((it) => ({ name: clip(it && it.name, NAME_MAX), amount: clip(it && it.amount, 30) || '적당량' }))
    .filter((it) => it.name)
    .slice(0, RECIPE_ITEMS_MAX);
  if (items.length === 0) throw new Error('AI 가 재료 목록을 만들지 못했습니다');

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => clip(s, STEP_MAX))
    .filter(Boolean)
    .slice(0, RECIPE_STEPS_MAX);
  if (steps.length === 0) throw new Error('AI 가 조리법을 만들지 못했습니다');

  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => clip(t, 12).replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, RECIPE_TAGS_MAX);

  // 이모지는 화면에서 한 글자만 쓰므로 코드포인트 기준으로 자른다
  const emoji = Array.from(clip(raw.emoji, 8))[0] || '🍽';

  const minutes = Math.min(600, Math.max(1, Math.round(Number(raw.minutes)) || 15));
  const servings = Math.min(12, Math.max(1, Math.round(Number(raw.servings)) || 1));
  const difficulty = ['쉬움', '보통', '어려움'].includes(raw.difficulty) ? raw.difficulty : '보통';

  return {
    name,
    emoji,
    minutes,
    difficulty,
    servings,
    tags: tags.length > 0 ? tags : ['AI추천'],
    summary: clip(raw.summary, SUMMARY_MAX) || '냉장고 재료로 만드는 요리입니다.',
    items,
    steps,
  };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname)));

// 모든 /api 요청 전에 스키마·시드가 준비됐는지 보장한다
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err.message);
    fail(res, 500, '데이터베이스 초기화에 실패했습니다');
  }
});

// ── API: auth (회원가입 · 로그인) ─────────────
// 여기 세 개만 토큰 없이 부를 수 있다. 아래 requireAuth 게이트보다 먼저 등록해야 한다
app.post('/api/auth/signup', async (req, res, next) => {
  try {
    if (!JWT_SECRET) return fail(res, 500, '서버에 JWT_SECRET 이 설정되지 않았습니다');

    const { email, nickname, password } = req.body || {};

    const cleanEmail = cleanText(email, EMAIL_MAX);
    if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) return fail(res, 400, '올바른 이메일 형식이 아닙니다');

    const cleanNickname = cleanText(nickname, NICKNAME_MAX);
    if (!cleanNickname) return fail(res, 400, `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요`);

    if (typeof password !== 'string') return fail(res, 400, '비밀번호를 입력해 주세요');
    // bcrypt 가 72바이트까지만 보므로 길이는 바이트 기준으로 잰다
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (password.length < PASSWORD_MIN || passwordBytes > PASSWORD_MAX) {
      return fail(res, 400, `비밀번호는 ${PASSWORD_MIN}자 이상 ${PASSWORD_MAX}바이트 이하로 입력해 주세요`);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO fp_users (email, nickname, password_hash) VALUES ($1, $2, $3)
         RETURNING id, email, nickname`,
        [cleanEmail, cleanNickname, passwordHash]
      );
      created = toUser(rows[0]);
    } catch (err) {
      if (err.code === '23505') return fail(res, 409, '이미 가입된 이메일입니다');
      throw err;
    }

    // 첫 가입자는 로그인 도입 전 데이터를 넘겨받고, 그래도 비어 있으면 예시 데이터를 채운다
    const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM fp_users');
    if (count[0].n === 1) await claimOrphanRows(created.id);
    await seedForUser(created.id);

    res.status(201).json({ success: true, data: { token: signToken(created), user: created } });
  } catch (err) { next(err); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!JWT_SECRET) return fail(res, 500, '서버에 JWT_SECRET 이 설정되지 않았습니다');

    const { email, password } = req.body || {};
    const cleanEmail = cleanText(email, EMAIL_MAX);
    if (!cleanEmail || typeof password !== 'string' || password.length === 0) {
      return fail(res, 400, '이메일과 비밀번호를 입력해 주세요');
    }

    const { rows } = await pool.query(
      'SELECT id, email, nickname, password_hash FROM fp_users WHERE lower(email) = lower($1)',
      [cleanEmail]
    );

    // 이메일이 없는 경우와 비밀번호가 틀린 경우를 같은 메시지로 처리한다 (가입 여부를 흘리지 않도록)
    const ok = rows.length > 0 && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다');

    const user = toUser(rows[0]);
    res.json({ success: true, data: { token: signToken(user), user } });
  } catch (err) { next(err); }
});

// 새로고침했을 때 localStorage 의 토큰이 아직 쓸 만한지 확인하는 용도
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

// ── 여기부터 아래 모든 /api 라우트는 로그인 필수 ──
app.use('/api', requireAuth);

// ── API: bootstrap (초기 로딩 한 번에) ────────
app.get('/api/bootstrap', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [ing, rec, shop, fav] = await Promise.all([
      pool.query(`SELECT ${INGREDIENT_COLUMNS} FROM fp_ingredients WHERE user_id = $1 ORDER BY expires_at ASC, id ASC LIMIT ${LIST_LIMIT}`, [userId]),
      pool.query(`SELECT ${RECIPE_COLUMNS} FROM fp_recipes WHERE user_id = $1 ORDER BY id ASC LIMIT ${LIST_LIMIT}`, [userId]),
      pool.query(`SELECT ${SHOPPING_COLUMNS} FROM fp_shopping_items WHERE user_id = $1 ORDER BY done ASC, id ASC LIMIT ${LIST_LIMIT}`, [userId]),
      pool.query('SELECT recipe_id FROM fp_favorites WHERE user_id = $1', [userId]),
    ]);
    res.json({
      success: true,
      data: {
        user: req.user,
        ingredients: ing.rows.map(toIngredient),
        recipes: rec.rows.map(toRecipe),
        shopping: shop.rows.map(toShopping),
        favorites: fav.rows.map((r) => String(r.recipe_id)),
        // 키가 없으면 클라이언트가 AI 버튼을 숨긴다
        aiEnabled: OPENAI_API_KEY.length > 0,
      },
    });
  } catch (err) { next(err); }
});

// ── API: ingredients ─────────────────────────
app.get('/api/ingredients', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM fp_ingredients WHERE user_id = $1 ORDER BY expires_at ASC, id ASC LIMIT ${LIST_LIMIT}`,
      [req.user.id]
    );
    res.json({ success: true, data: rows.map(toIngredient) });
  } catch (err) { next(err); }
});

app.post('/api/ingredients', async (req, res, next) => {
  try {
    const { name, category, qty, unit, location, days } = req.body || {};

    const cleanName = cleanText(name, NAME_MAX);
    if (!cleanName) return fail(res, 400, `재료 이름은 1~${NAME_MAX}자로 입력해 주세요`);
    if (!CATEGORIES.includes(category)) return fail(res, 400, '올바른 카테고리가 아닙니다');
    if (!LOCATIONS.includes(location)) return fail(res, 400, '올바른 보관 위치가 아닙니다');

    const qtyNum = Number(qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 0 || qtyNum > QTY_MAX) {
      return fail(res, 400, `수량은 0 이상 ${QTY_MAX} 이하의 정수여야 합니다`);
    }

    const cleanUnit = cleanText(unit, UNIT_MAX) || '개';

    const daysNum = Number(days);
    if (!Number.isInteger(daysNum) || daysNum < DAYS_MIN || daysNum > DAYS_MAX) {
      return fail(res, 400, `유통기한은 ${DAYS_MIN}~${DAYS_MAX}일 범위로 입력해 주세요`);
    }

    const { rows } = await pool.query(
      `INSERT INTO fp_ingredients (user_id, name, category, qty, unit, location, added_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, CURRENT_DATE + $7::int)
       RETURNING ${INGREDIENT_COLUMNS}`,
      [req.user.id, cleanName, category, qtyNum, cleanUnit, location, daysNum]
    );
    res.status(201).json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) { next(err); }
});

// 수량 증감 (delta: +1 / -1). 0 아래로는 내려가지 않는다
app.patch('/api/ingredients/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 재료 ID가 아닙니다');

    const delta = Number((req.body || {}).delta);
    if (!Number.isInteger(delta) || Math.abs(delta) > QTY_MAX) {
      return fail(res, 400, 'delta 는 정수여야 합니다');
    }

    const { rows } = await pool.query(
      `UPDATE fp_ingredients
          SET qty = LEAST(${QTY_MAX}, GREATEST(0, qty + $2::int))
        WHERE id = $1 AND user_id = $3
      RETURNING ${INGREDIENT_COLUMNS}`,
      [id, delta, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '재료를 찾을 수 없습니다');
    res.json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) { next(err); }
});

app.delete('/api/ingredients/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 재료 ID가 아닙니다');

    const { rows } = await pool.query(
      'DELETE FROM fp_ingredients WHERE id = $1 AND user_id = $2 RETURNING id, name',
      [id, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '재료를 찾을 수 없습니다');
    res.json({ success: true, data: { id: String(rows[0].id), name: rows[0].name } });
  } catch (err) { next(err); }
});

// ── API: recipes ─────────────────────────────
app.get('/api/recipes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${RECIPE_COLUMNS} FROM fp_recipes WHERE user_id = $1 ORDER BY id ASC LIMIT ${LIST_LIMIT}`,
      [req.user.id]
    );
    res.json({ success: true, data: rows.map(toRecipe) });
  } catch (err) { next(err); }
});

app.get('/api/recipes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 레시피 ID가 아닙니다');

    const { rows } = await pool.query(
      `SELECT ${RECIPE_COLUMNS} FROM fp_recipes WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '레시피를 찾을 수 없습니다');
    res.json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) { next(err); }
});

// 냉장고 재료를 근거로 AI 가 레시피를 하나 만들어 DB 에 저장한다
// body: { request?: string, mode?: 'all' | 'expiring' | 'pick', names?: string[] }
app.post('/api/recipes/generate', async (req, res, next) => {
  try {
    if (!OPENAI_API_KEY) {
      return fail(res, 503, 'OPENAI_API_KEY 가 설정되지 않아 AI 생성을 쓸 수 없습니다');
    }

    const body = req.body || {};
    const mode = ['all', 'expiring', 'pick'].includes(body.mode) ? body.mode : 'all';

    let request = '';
    if (body.request != null) {
      if (typeof body.request !== 'string') return fail(res, 400, '요청사항은 문자열이어야 합니다');
      request = body.request.trim().slice(0, AI_REQUEST_MAX);
    }

    // 재료 현황은 클라이언트 값을 믿지 않고 DB 에서 다시 읽는다
    const { rows } = await pool.query(
      `SELECT name, category, qty, unit, location, (expires_at - CURRENT_DATE) AS days_left
         FROM fp_ingredients
        WHERE user_id = $1 AND qty > 0
        ORDER BY expires_at ASC
        LIMIT ${LIST_LIMIT}`,
      [req.user.id]
    );
    if (rows.length === 0) {
      return fail(res, 400, '냉장고가 비어 있어 레시피를 만들 수 없습니다. 재료를 먼저 넣어 주세요');
    }

    let selected = rows;
    let focusText = '기한이 임박한 재료부터 우선 소비하는 요리를 만들어 줘.';

    if (mode === 'expiring') {
      const soon = rows.filter((r) => Number(r.days_left) <= 5);
      if (soon.length === 0) {
        return fail(res, 400, '유통기한이 임박한(5일 이내) 재료가 없습니다');
      }
      selected = soon;
      focusText = '아래 재료는 모두 기한이 임박했다. 이것들을 최대한 많이 소비하는 요리를 만들어 줘.';
    } else if (mode === 'pick') {
      const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string') : [];
      if (names.length === 0) return fail(res, 400, '사용할 재료를 하나 이상 선택해 주세요');

      const picked = new Set(names);
      selected = rows.filter((r) => picked.has(r.name));
      if (selected.length === 0) return fail(res, 400, '선택한 재료를 냉장고에서 찾을 수 없습니다');
      focusText = '아래 재료를 반드시 모두 사용하는 요리를 만들어 줘.';
    }

    const raw = await callOpenAI(describeFridge(selected), request, focusText);
    const recipe = sanitizeRecipe(raw);

    const { rows: saved } = await pool.query(
      `INSERT INTO fp_recipes (user_id, name, emoji, minutes, difficulty, servings, tags, summary, items, steps, ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, true)
       RETURNING ${RECIPE_COLUMNS}`,
      [req.user.id, recipe.name, recipe.emoji, recipe.minutes, recipe.difficulty, recipe.servings,
       recipe.tags, recipe.summary, JSON.stringify(recipe.items), recipe.steps]
    );

    res.status(201).json({ success: true, data: toRecipe(saved[0]) });
  } catch (err) {
    // callOpenAI / sanitizeRecipe 가 던진 사용자용 메시지는 그대로 전달한다
    if (err instanceof Error && err.message && !err.code) {
      console.error('recipe generate failed:', err.message);
      return fail(res, 502, err.message);
    }
    next(err);
  }
});

app.delete('/api/recipes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 레시피 ID가 아닙니다');

    // fp_favorites 는 ON DELETE CASCADE 라 즐겨찾기도 같이 지워진다
    const { rows } = await pool.query(
      'DELETE FROM fp_recipes WHERE id = $1 AND user_id = $2 RETURNING id, name',
      [id, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '레시피를 찾을 수 없습니다');
    res.json({ success: true, data: { id: String(rows[0].id), name: rows[0].name } });
  } catch (err) { next(err); }
});

// ── API: favorites ───────────────────────────
app.put('/api/favorites/:recipeId', async (req, res, next) => {
  try {
    const { recipeId } = req.params;
    if (!ID_RE.test(recipeId)) return fail(res, 400, '올바른 레시피 ID가 아닙니다');

    const { rows } = await pool.query(
      'SELECT id FROM fp_recipes WHERE id = $1 AND user_id = $2',
      [recipeId, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '레시피를 찾을 수 없습니다');

    await pool.query(
      'INSERT INTO fp_favorites (user_id, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, recipeId]
    );
    res.json({ success: true, data: { recipeId: String(recipeId), favorite: true } });
  } catch (err) { next(err); }
});

app.delete('/api/favorites/:recipeId', async (req, res, next) => {
  try {
    const { recipeId } = req.params;
    if (!ID_RE.test(recipeId)) return fail(res, 400, '올바른 레시피 ID가 아닙니다');

    await pool.query('DELETE FROM fp_favorites WHERE recipe_id = $1 AND user_id = $2', [recipeId, req.user.id]);
    res.json({ success: true, data: { recipeId: String(recipeId), favorite: false } });
  } catch (err) { next(err); }
});

// ── API: shopping list ───────────────────────
app.get('/api/shopping', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SHOPPING_COLUMNS} FROM fp_shopping_items WHERE user_id = $1 ORDER BY done ASC, id ASC LIMIT ${LIST_LIMIT}`,
      [req.user.id]
    );
    res.json({ success: true, data: rows.map(toShopping) });
  } catch (err) { next(err); }
});

// 단건 { name, qty?, source? } 또는 여러 건 { items: [{ name, amount }], source }
app.post('/api/shopping', async (req, res, next) => {
  try {
    const body = req.body || {};
    const source = cleanText(body.source, NAME_MAX) || '직접 추가';

    const incoming = Array.isArray(body.items)
      ? body.items.map((it) => ({ name: it && it.name, qty: (it && it.amount) || '1개' }))
      : [{ name: body.name, qty: body.qty || '1개' }];

    if (incoming.length === 0 || incoming.length > 50) {
      return fail(res, 400, '한 번에 1~50개까지 담을 수 있습니다');
    }

    const prepared = [];
    for (const raw of incoming) {
      const name = cleanText(raw.name, NAME_MAX);
      if (!name) return fail(res, 400, `항목 이름은 1~${NAME_MAX}자로 입력해 주세요`);
      prepared.push([name, cleanText(raw.qty, UNIT_MAX * 2) || '1개']);
    }

    const added = [];
    for (const [name, qty] of prepared) {
      const { rows } = await pool.query(
        `INSERT INTO fp_shopping_items (user_id, name, qty, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING ${SHOPPING_COLUMNS}`,
        [req.user.id, name, qty, source]
      );
      if (rows.length > 0) added.push(toShopping(rows[0]));
    }

    if (added.length === 0) {
      return res.status(200).json({ success: true, data: [], message: '이미 장바구니에 담겨 있어요' });
    }
    res.status(201).json({ success: true, data: added });
  } catch (err) { next(err); }
});

app.patch('/api/shopping/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 항목 ID가 아닙니다');

    const { done } = req.body || {};
    if (typeof done !== 'boolean') return fail(res, 400, 'done 은 true/false 여야 합니다');

    const { rows } = await pool.query(
      `UPDATE fp_shopping_items SET done = $2 WHERE id = $1 AND user_id = $3 RETURNING ${SHOPPING_COLUMNS}`,
      [id, done, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '항목을 찾을 수 없습니다');
    res.json({ success: true, data: toShopping(rows[0]) });
  } catch (err) { next(err); }
});

// 구매 완료 항목 일괄 정리 (:id 라우트보다 먼저 등록해야 가로채이지 않는다)
app.delete('/api/shopping/done', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM fp_shopping_items WHERE done = true AND user_id = $1 RETURNING id',
      [req.user.id]
    );
    res.json({ success: true, data: { removed: rows.length } });
  } catch (err) { next(err); }
});

app.delete('/api/shopping/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, '올바른 항목 ID가 아닙니다');

    const { rows } = await pool.query(
      'DELETE FROM fp_shopping_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (rows.length === 0) return fail(res, 404, '항목을 찾을 수 없습니다');
    res.json({ success: true, data: { id: String(rows[0].id) } });
  } catch (err) { next(err); }
});

// 정의되지 않은 API 경로는 여기서 404 JSON 으로 끊는다 (SPA fallback 이 HTML 을 주지 않도록)
app.use('/api', (_req, res) => fail(res, 404, '존재하지 않는 API 경로입니다'));

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
