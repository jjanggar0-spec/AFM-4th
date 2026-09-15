// 월급 비교소 — 월급·지출 응답 저장 + 통계 API 서버 (Supabase PostgreSQL)

// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────
// 로컬에서는 같은 폴더의 .env 를 읽고, Vercel 에서는 대시보드에 등록한 환경변수를 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

// index.html 의 JOB_GROUPS 와 같은 목록이어야 한다
const JOB_GROUPS = [
  '개발', '데이터·AI', '디자인', '기획·PM', '마케팅', '영업',
  '경영지원', '금융', '생산·제조', '의료·보건', '교육', '공공·공무원', '서비스', '기타',
];
const YEARS_MAX = 40;
const MONEY_MAX = 100_000_000; // 항목당 월 1억 원까지
const MAN = 10_000; // 만원

// 금액은 모두 '원' 단위 정수로 저장한다
const MONEY_FIELDS = ['salary', 'food', 'housing', 'transport', 'culture'];
// 평균·순위를 내는 지표. 컬럼 이름 고정 목록이라 SQL 에 그대로 넣어도 안전하다
const METRICS = ['salary', 'food', 'housing', 'transport', 'culture', 'total_spend', 'savings'];

// 같은 연차대끼리 비교할 때 쓰는 구간
const YEAR_BANDS = [
  { label: '경력 2년 이하', min: 0, max: 2 },
  { label: '경력 3~5년', min: 3, max: 5 },
  { label: '경력 6~9년', min: 6, max: 9 },
  { label: '경력 10~14년', min: 10, max: 14 },
  { label: '경력 15년 이상', min: 15, max: YEARS_MAX },
];

// 분포 히스토그램 구간 경계 (만원). 마지막 경계 이상은 한 칸으로 묶는다
const SALARY_EDGES = [0, 200, 250, 300, 350, 400, 500, 600, 800, 1000];
const SPEND_EDGES = [0, 50, 100, 150, 200, 250, 300, 400, 500];

// Supabase Transaction pooler(6543)는 연결을 짧게 쓰는 서버리스에 맞다
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

// ── Database (lazy init) ─────────────────────
// 결과 페이지 주소에 id 가 드러나므로 순번 대신 추측하기 어려운 UUID 를 쓴다
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS salary_reports (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_group   TEXT        NOT NULL,
    years       SMALLINT    NOT NULL CHECK (years BETWEEN 0 AND ${YEARS_MAX}),
    salary      INTEGER     NOT NULL CHECK (salary BETWEEN 1 AND ${MONEY_MAX}),
    food        INTEGER     NOT NULL CHECK (food      BETWEEN 0 AND ${MONEY_MAX}),
    housing     INTEGER     NOT NULL CHECK (housing   BETWEEN 0 AND ${MONEY_MAX}),
    transport   INTEGER     NOT NULL CHECK (transport BETWEEN 0 AND ${MONEY_MAX}),
    culture     INTEGER     NOT NULL CHECK (culture   BETWEEN 0 AND ${MONEY_MAX}),
    total_spend INTEGER     GENERATED ALWAYS AS (food + housing + transport + culture) STORED,
    savings     INTEGER     GENERATED ALWAYS AS (salary - (food + housing + transport + culture)) STORED,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS salary_reports_job_group_idx ON salary_reports (job_group);
  CREATE INDEX IF NOT EXISTS salary_reports_years_idx     ON salary_reports (years);
  ALTER TABLE salary_reports ENABLE ROW LEVEL SECURITY;

  COMMENT ON TABLE  salary_reports             IS '월급·월 지출 응답';
  COMMENT ON COLUMN salary_reports.id          IS '응답 ID';
  COMMENT ON COLUMN salary_reports.job_group   IS '직군';
  COMMENT ON COLUMN salary_reports.years       IS '연차 = 경력 햇수 (0 = 1년 미만)';
  COMMENT ON COLUMN salary_reports.salary      IS '월급 (세후 실수령, 원)';
  COMMENT ON COLUMN salary_reports.food        IS '식비 (원)';
  COMMENT ON COLUMN salary_reports.housing     IS '주거비 (원)';
  COMMENT ON COLUMN salary_reports.transport   IS '교통비 (원)';
  COMMENT ON COLUMN salary_reports.culture     IS '문화생활비 (원)';
  COMMENT ON COLUMN salary_reports.total_spend IS '월 지출 합계 (원, 자동 계산)';
  COMMENT ON COLUMN salary_reports.savings     IS '남는 돈 = 월급 - 지출 (원, 자동 계산)';
  COMMENT ON COLUMN salary_reports.created_at  IS '제출일시';
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

// ── Helpers ──────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DB 컬럼(snake_case) → 응답 키(camelCase)
const toCamel = (key) => key.replace(/_(\w)/g, (_m, c) => c.toUpperCase());

function toReport(row) {
  return {
    id: row.id,
    jobGroup: row.job_group,
    years: row.years,
    ...Object.fromEntries(METRICS.map((m) => [toCamel(m), row[m]])),
    createdAt: row.created_at.toISOString(),
  };
}

function yearBandOf(years) {
  return YEAR_BANDS.find((b) => years >= b.min && years <= b.max);
}

// 요청 body 검증 → DB 컬럼 값
function parseReportInput(body) {
  const src = body || {};

  if (!JOB_GROUPS.includes(src.jobGroup)) return { error: '직군을 목록에서 골라 주세요.' };
  if (!Number.isInteger(src.years) || src.years < 0 || src.years > YEARS_MAX) {
    return { error: `연차는 0~${YEARS_MAX} 사이 정수여야 해요.` };
  }

  const fields = { job_group: src.jobGroup, years: src.years };
  for (const key of MONEY_FIELDS) {
    const value = src[key];
    if (!Number.isInteger(value) || value < 0 || value > MONEY_MAX) {
      return { error: `${key} 는 0 ~ ${MONEY_MAX} 원 사이 정수여야 해요.` };
    }
    fields[key] = value;
  }
  if (fields.salary < 1) return { error: '월급을 입력해 주세요.' };

  return { fields };
}

// 지표별 평균 + 인원수. where 는 고정 SQL 조각만 넘긴다 (값은 params)
async function averages(where = '', params = []) {
  const avgCols = METRICS.map((m) => `COALESCE(round(avg(${m})), 0)::int AS ${m}`).join(',\n');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY salary)), 0)::int AS median_salary,
            ${avgCols}
       FROM salary_reports ${where}`,
    params
  );
  const { n, median_salary: medianSalary, ...avg } = rows[0];
  return {
    n,
    medianSalary,
    avg: Object.fromEntries(METRICS.map((m) => [toCamel(m), avg[m]])),
  };
}

// 내 위치: 나보다 값이 큰 사람 수 + 1 = 순위, 상위 % = 순위 / 인원 × 100
async function positions(report, where = '', params = []) {
  const aboveCols = METRICS
    .map((m, i) => `count(*) FILTER (WHERE ${m} > $${params.length + i + 1})::int AS ${m}`)
    .join(',\n');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, ${aboveCols} FROM salary_reports ${where}`,
    [...params, ...METRICS.map((m) => report[m])]
  );
  const { n, ...above } = rows[0];
  return {
    n,
    rank: Object.fromEntries(METRICS.map((m) => {
      const rank = above[m] + 1;
      return [toCamel(m), { rank, topPercent: Math.round((rank / n) * 1000) / 10 }];
    })),
  };
}

// width_bucket 로 구간별 인원을 센 뒤, 빈 구간도 0 으로 채워 돌려준다
async function histogram(column, edgesMan) {
  const edges = edgesMan.map((v) => v * MAN);
  const { rows } = await pool.query(
    `SELECT width_bucket(${column}, $1::int[]) AS bucket, count(*)::int AS n
       FROM salary_reports GROUP BY bucket`,
    [edges]
  );
  const counts = new Map(rows.map((r) => [r.bucket, r.n]));
  return edges.map((min, i) => ({
    min,
    max: edges[i + 1] ?? null, // null = 상한 없음
    count: counts.get(i + 1) || 0,
  }));
}

async function jobGroupBreakdown() {
  const { rows } = await pool.query(
    `SELECT job_group, count(*)::int AS n,
            round(avg(salary))::int AS avg_salary,
            round(avg(total_spend))::int AS avg_total_spend
       FROM salary_reports
      GROUP BY job_group
      ORDER BY avg_salary DESC`
  );
  return rows.map((r) => ({
    jobGroup: r.job_group,
    n: r.n,
    avgSalary: r.avg_salary,
    avgTotalSpend: r.avg_total_spend,
  }));
}

async function distribution() {
  const [salary, totalSpend, jobGroups] = await Promise.all([
    histogram('salary', SALARY_EDGES),
    histogram('total_spend', SPEND_EDGES),
    jobGroupBreakdown(),
  ]);
  return { salary, totalSpend, jobGroups };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '8kb' }));

// express.static(__dirname) 는 .env·server.js 까지 노출하므로 화면 파일만 명시적으로 내보낸다
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
// 전체 통계 (평균·분포). 아직 응답이 없으면 n = 0
app.get('/api/stats', async (_req, res, next) => {
  try {
    const [overall, dist] = await Promise.all([averages(), distribution()]);
    res.json({ success: true, data: { overall, distribution: dist } });
  } catch (err) {
    next(err);
  }
});

// 내 결과: 내 응답 + 전체/직군/연차대 평균 + 내 위치 + 분포
app.get('/api/reports/:id/stats', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, message: '결과 ID 형식이 올바르지 않아요.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM salary_reports WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: '결과를 찾을 수 없어요.' });

    const report = rows[0];
    const band = yearBandOf(report.years);
    const byJob = ['WHERE job_group = $1', [report.job_group]];
    const byBand = ['WHERE years BETWEEN $1 AND $2', [band.min, band.max]];

    const [overall, jobGroup, yearBand, posOverall, posJob, dist] = await Promise.all([
      averages(),
      averages(...byJob),
      averages(...byBand),
      positions(report),
      positions(report, ...byJob),
      distribution(),
    ]);

    res.json({
      success: true,
      data: {
        me: toReport(report),
        overall,
        jobGroup: { label: report.job_group, ...jobGroup },
        yearBand: { label: band.label, ...yearBand },
        position: { overall: posOverall, jobGroup: posJob },
        distribution: dist,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/reports', async (req, res, next) => {
  const input = parseReportInput(req.body);
  if (input.error) return res.status(400).json({ success: false, message: input.error });
  const f = input.fields;
  try {
    const { rows } = await pool.query(
      `INSERT INTO salary_reports (job_group, years, salary, food, housing, transport, culture)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [f.job_group, f.years, f.salary, f.food, f.housing, f.transport, f.culture]
    );
    res.status(201).json({ success: true, data: toReport(rows[0]) });
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
