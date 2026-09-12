const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory store: 포켓몬 도감 데이터 (우선 10마리) ──────────────
// height: m, weight: kg, stats: 종족값, evolution: 같은 진화 계열의 도감 번호
let pokedex = [
  {
    id: 1, enName: 'bulbasaur', name: '새싹몬', genus: '씨앗포켓몬',
    types: ['grass', 'poison'], generationId: 1,
    height: 0.7, weight: 6.9, baseExperience: 64,
    stats: { hp: 45, attack: 49, defense: 49, spAttack: 65, spDefense: 65, speed: 45 },
    abilities: [{ name: '신록', hidden: false }, { name: '엽록소', hidden: true }],
    flavorText: '태어났을 때부터 등에 이상한 씨앗이 심어져 있으며 몸과 함께 씨앗도 자란다고 한다.',
    isLegendary: false, isMythical: false, evolution: [1, 2, 3],
  },
  {
    id: 4, enName: 'charmander', name: '불씨몬', genus: '도마뱀포켓몬',
    types: ['fire'], generationId: 1,
    height: 0.6, weight: 8.5, baseExperience: 62,
    stats: { hp: 39, attack: 52, defense: 43, spAttack: 60, spDefense: 50, speed: 65 },
    abilities: [{ name: '맹화', hidden: false }, { name: '태양의힘', hidden: true }],
    flavorText: '태어났을 때부터 꼬리에 불꽃이 타오른다. 불꽃이 꺼지면 생명이 끝났다는 뜻이다.',
    isLegendary: false, isMythical: false, evolution: [4, 5, 6],
  },
  {
    id: 6, enName: 'charizard', name: '화염룡', genus: '화염포켓몬',
    types: ['fire', 'flying'], generationId: 1,
    height: 1.7, weight: 90.5, baseExperience: 267,
    stats: { hp: 78, attack: 84, defense: 78, spAttack: 109, spDefense: 85, speed: 100 },
    abilities: [{ name: '맹화', hidden: false }, { name: '태양의힘', hidden: true }],
    flavorText: '거대한 불꽃을 뿜어 바위조차 녹인다. 실수로 산불을 일으키는 일도 있다고 한다.',
    isLegendary: false, isMythical: false, evolution: [4, 5, 6],
  },
  {
    id: 7, enName: 'squirtle', name: '꼬물몬', genus: '꼬마거북포켓몬',
    types: ['water'], generationId: 1,
    height: 0.5, weight: 9.0, baseExperience: 63,
    stats: { hp: 44, attack: 48, defense: 65, spAttack: 50, spDefense: 64, speed: 43 },
    abilities: [{ name: '급류', hidden: false }, { name: '젖은접시', hidden: true }],
    flavorText: '등껍질에 숨어 몸을 지킨다. 반격할 때는 입에서 강한 물줄기를 세차게 뿜어낸다.',
    isLegendary: false, isMythical: false, evolution: [7, 8, 9],
  },
  {
    id: 25, enName: 'pikachu', name: '번개쥐', genus: '쥐포켓몬',
    types: ['electric'], generationId: 1,
    height: 0.4, weight: 6.0, baseExperience: 112,
    stats: { hp: 35, attack: 55, defense: 40, spAttack: 50, spDefense: 50, speed: 90 },
    abilities: [{ name: '정전기', hidden: false }, { name: '피뢰침', hidden: true }],
    flavorText: '볼에는 전기를 모아 두는 주머니가 있다. 위급할 때 전기를 방출하여 몸을 지킨다.',
    isLegendary: false, isMythical: false, evolution: [25],
  },
];

// 타입 슬러그 → 한국어 타입명 (도감 필터 칩에 사용)
const TYPE_NAMES = {
  normal: '노말', fighting: '격투', flying: '비행', poison: '독',
  ground: '땅', rock: '바위', bug: '벌레', ghost: '고스트',
  steel: '강철', fire: '불꽃', water: '물', grass: '풀',
  electric: '전기', psychic: '에스퍼', ice: '얼음', dragon: '드래곤',
  dark: '악', fairy: '페어리',
};

// 세대 번호 → 표시 이름
const GENERATION_NAMES = { 1: '1세대', 2: '2세대', 3: '3세대', 4: '4세대', 5: '5세대' };

// 종족값 키 → 한국어 라벨 (표시 순서 그대로)
const STAT_LABELS = [
  ['hp', 'HP'],
  ['attack', '공격'],
  ['defense', '방어'],
  ['spAttack', '특수공격'],
  ['spDefense', '특수방어'],
  ['speed', '스피드'],
];

// 스프라이트 원본 (이미지 파일만 1회 받아와 서버 메모리에 캐시 후 재전송)
const SPRITE_ORIGIN = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork';
const spriteCache = new Map();

const findPokemon = (id) => pokedex.find((p) => p.id === id);

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API: 도감 목록 ────────────────────────────
app.get('/api/pokemons', (req, res, next) => {
  try {
    const keyword = String(req.query.q || '').trim().toLowerCase();
    const type = String(req.query.type || '').trim();

    let list = pokedex;
    if (type) list = list.filter((p) => p.types.includes(type));
    if (keyword) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(keyword) || p.enName.toLowerCase().includes(keyword)
      );
    }

    const pokemons = list.map((p) => ({
      id: p.id,
      enName: p.enName,
      name: p.name,
      genus: p.genus,
      types: p.types,
      generationId: p.generationId,
      sprite: `/api/pokemons/${p.id}/sprite`,
    }));

    const generationIds = [...new Set(pokedex.map((p) => p.generationId))].sort((a, b) => a - b);
    const generations = generationIds.map((id) => ({ id, label: GENERATION_NAMES[id] || `${id}세대` }));

    res.json({ success: true, data: { pokemons, typeNames: TYPE_NAMES, generations } });
  } catch (err) {
    next(err);
  }
});

// ── API: 포켓몬 상세 ──────────────────────────
app.get('/api/pokemons/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '도감 번호는 정수여야 합니다.' });
    }

    const p = findPokemon(id);
    if (!p) {
      return res.status(404).json({ success: false, message: `No.${id} 포켓몬을 찾을 수 없습니다.` });
    }

    res.json({
      success: true,
      data: {
        id: p.id,
        height: p.height,
        weight: p.weight,
        baseExperience: p.baseExperience,
        stats: STAT_LABELS.map(([key, label]) => ({ label, value: p.stats[key] })),
        abilities: p.abilities,
        generation: GENERATION_NAMES[p.generationId] || `${p.generationId}세대`,
        isLegendary: p.isLegendary,
        isMythical: p.isMythical,
        flavorText: p.flavorText,
        evolution: p.evolution
          .map((evoId) => findPokemon(evoId))
          .filter(Boolean)
          .map((evo) => ({ id: evo.id, name: evo.name })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: 스프라이트 이미지 ────────────────────
app.get('/api/pokemons/:id/sprite', async (req, res) => {
  const id = Number(req.params.id);
  if (!findPokemon(id)) {
    return res.status(404).json({ success: false, message: '이미지를 찾을 수 없습니다.' });
  }

  try {
    if (!spriteCache.has(id)) {
      const upstream = await fetch(`${SPRITE_ORIGIN}/${id}.png`);
      if (!upstream.ok) throw new Error(`sprite fetch failed (${upstream.status})`);
      spriteCache.set(id, Buffer.from(await upstream.arrayBuffer()));
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(spriteCache.get(id));
  } catch (err) {
    console.error(`sprite ${id}:`, err.message);
    res.status(502).json({ success: false, message: '이미지를 불러오지 못했습니다.' });
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`포켓몬 도감 서버: http://localhost:${PORT}`));
}
module.exports = app;
