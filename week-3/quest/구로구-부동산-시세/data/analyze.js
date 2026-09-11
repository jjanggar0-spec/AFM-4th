const fs = require('fs');
const d = JSON.parse(fs.readFileSync(__dirname + '/guro-price-raw.json', 'utf8'));

const med = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2 ? s[m] : Math.round((s[m-1]+s[m])/2); };

// 월세 1,000만원 초과는 보증금 혼입/입력오류로 판단해 제외
const RENT_CAP = 1000;
const lease = d.lease.filter(x => x.leaseCount > 0 && x.medianLeasePrice > 0);
const rent  = d.rent.filter(x => x.rentCount > 0 && x.medianRentPrice > 0 && x.medianRentPrice <= RENT_CAP);

const stat = (L, R) => ({
  lComplex: L.length, lArticles: L.reduce((s,x)=>s+x.leaseCount,0),
  lMed: med(L.map(x=>x.medianLeasePrice)),
  lMin: L.length ? Math.min(...L.map(x=>x.minLeasePrice)) : null,
  lMax: L.length ? Math.max(...L.map(x=>x.maxLeasePrice)) : null,
  lUnit: med(L.map(x=>x.medianLeaseUnitPrice).filter(v=>v>0)),
  lRate: med(L.map(x=>Math.round((x.minLeaseRate+x.maxLeaseRate)/2)).filter(v=>v>0)),
  rComplex: R.length, rArticles: R.reduce((s,x)=>s+x.rentCount,0),
  rMed: med(R.map(x=>x.medianRentPrice)),
  rMin: R.length ? Math.min(...R.map(x=>x.minRentPrice).filter(v=>v>0)) : null,
  rMax: R.length ? Math.max(...R.map(x=>x.maxRentPrice).filter(v=>v<=RENT_CAP)) : null,
});

const BIG = 300; // 세대수 300 이상 = 대표 단지
const dongs = [...new Set([...lease, ...rent].map(x => x.dong))];
const byDong = dongs.map(dg => ({
  dong: dg,
  all: stat(lease.filter(x=>x.dong===dg), rent.filter(x=>x.dong===dg)),
  big: stat(lease.filter(x=>x.dong===dg && x.hh>=BIG), rent.filter(x=>x.dong===dg && x.hh>=BIG)),
})).sort((a,b) => (b.big.lMed ?? b.all.lMed ?? 0) - (a.big.lMed ?? a.all.lMed ?? 0));

const out = {
  collectedAt: d.collectedAt,
  guroAll: stat(lease, rent),
  guroBig: stat(lease.filter(x=>x.hh>=BIG), rent.filter(x=>x.hh>=BIG)),
  byDong,
  topLease: [...lease].filter(x=>x.hh>=BIG).sort((a,b)=>b.hh-a.hh).slice(0,15)
    .map(x=>({dong:x.dong,name:x.name,hh:x.hh,built:x.built.slice(0,4),area:x.repArea,med:x.medianLeasePrice,min:x.minLeasePrice,max:x.maxLeasePrice,n:x.leaseCount,unit:x.medianLeaseUnitPrice,rate:x.maxLeaseRate})),
  topRent: [...rent].filter(x=>x.hh>=BIG).sort((a,b)=>b.hh-a.hh).slice(0,15)
    .map(x=>({dong:x.dong,name:x.name,hh:x.hh,built:x.built.slice(0,4),area:x.repArea,med:x.medianRentPrice,min:x.minRentPrice,max:x.maxRentPrice,n:x.rentCount})),
  excluded: d.rent.filter(x=>x.rentCount>0 && x.medianRentPrice>RENT_CAP).map(x=>({dong:x.dong,name:x.name,med:x.medianRentPrice})),
};
fs.writeFileSync(__dirname + '/summary.json', JSON.stringify(out, null, 1));

const eok = v => v==null ? '-' : (v/10000).toFixed(2).replace(/\.?0+$/,'') + '억';
console.log('== 구로구 전체(모든 아파트) ==');
console.log(' 전세: 단지', out.guroAll.lComplex, '매물', out.guroAll.lArticles, '중앙', eok(out.guroAll.lMed), '범위', eok(out.guroAll.lMin)+'~'+eok(out.guroAll.lMax), '평당', out.guroAll.lUnit+'만');
console.log(' 월세: 단지', out.guroAll.rComplex, '매물', out.guroAll.rArticles, '중앙', out.guroAll.rMed+'만', '범위', out.guroAll.rMin+'~'+out.guroAll.rMax+'만');
console.log('== 300세대 이상 대표단지 ==');
console.log(' 전세: 단지', out.guroBig.lComplex, '매물', out.guroBig.lArticles, '중앙', eok(out.guroBig.lMed), '범위', eok(out.guroBig.lMin)+'~'+eok(out.guroBig.lMax), '평당', out.guroBig.lUnit+'만', '전세가율', out.guroBig.lRate+'%');
console.log(' 월세: 단지', out.guroBig.rComplex, '매물', out.guroBig.rArticles, '중앙', out.guroBig.rMed+'만', '범위', out.guroBig.rMin+'~'+out.guroBig.rMax+'만');
console.log('== 동별 (300세대 이상 기준) ==');
for (const r of byDong) console.log(' ', r.dong.padEnd(6),
  '전세', String(r.big.lComplex).padStart(2)+'단지', String(r.big.lArticles).padStart(3)+'건', (eok(r.big.lMed)).padStart(6), (eok(r.big.lMin)+'~'+eok(r.big.lMax)).padStart(14), '평당'+String(r.big.lUnit||'-').padStart(5),
  '| 월세', String(r.big.rComplex).padStart(2)+'단지', String(r.big.rArticles).padStart(3)+'건', String(r.big.rMed||'-').padStart(4)+'만', (String(r.big.rMin||'-')+'~'+String(r.big.rMax||'-')).padStart(9));
console.log('제외된 이상치:', JSON.stringify(out.excluded));
