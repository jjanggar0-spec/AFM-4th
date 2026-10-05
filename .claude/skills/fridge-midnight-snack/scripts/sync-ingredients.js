// 냉장고 재료 DB → data/ingredients/<재료이름>.json (재료당 파일 1개)
//
//   node .claude/skills/fridge-midnight-snack/scripts/sync-ingredients.js
//
// DB에서 지워진 재료의 JSON 파일도 같이 지워서 폴더가 항상 DB와 같은 상태가 되게 한다.

const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '../../../../week-4/quest/fridge-recipe');
const OUT_DIR = path.join(PROJECT, 'data', 'ingredients');

// pg 는 fridge-recipe 프로젝트에만 설치돼 있다
const { Pool } = require(path.join(PROJECT, 'node_modules', 'pg'));

process.loadEnvFile(path.join(PROJECT, '.env'));

if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL 이 없습니다. ${path.join(PROJECT, '.env')} 를 확인하세요.`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const { rows } = await pool.query(
    'SELECT id, name, category, created_at FROM ingredients ORDER BY id'
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const keep = new Set();
  for (const row of rows) {
    const file = `${row.name}.json`;
    keep.add(file);
    const data = {
      id: Number(row.id),
      name: row.name,
      category: row.category,
      createdAt: row.created_at.toISOString(),
    };
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  // DB에서 사라진 재료 정리
  let removed = 0;
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith('.json') && !keep.has(file)) {
      fs.unlinkSync(path.join(OUT_DIR, file));
      removed += 1;
    }
  }

  console.log(`재료 ${rows.length}개 저장${removed ? `, ${removed}개 삭제` : ''} → ${OUT_DIR}`);
}

main()
  .catch((err) => {
    console.error('동기화 실패:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
