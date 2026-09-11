const fs=require('fs');
const raw=fs.readFileSync(__dirname+'/신도림동-아파트-전월세-실거래-2025.09~2026.09.csv','utf8').split(/\r?\n/);
const hi=raw.findIndex(l=>l.startsWith('"NO"'));
const parse=l=>{const o=[];let c='',q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){o.push(c);c='';}else c+=ch;}o.push(c);return o;};
const H=parse(raw[hi]);
const num=s=>Number(String(s).replace(/,/g,''))||0;
const rows=raw.slice(hi+1).filter(l=>l.trim()).map(l=>{const a=parse(l);const o={};H.forEach((h,i)=>o[h]=a[i]);return o;})
  .map(r=>({
    danji:r['단지명'], type:r['전월세구분'], area:Number(r['전용면적(㎡)']),
    ym:r['계약년월'], d:r['계약일'], dep:num(r['보증금(만원)']), rent:num(r['월세금(만원)']),
    floor:Number(r['층']), built:r['건축년도'], gubun:r['계약구분'],
    py: Math.round(Number(r['전용면적(㎡)'])/0.753/3.3058)
  }));

const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2);};
const eok=v=>v==null?'-':(v/10000).toFixed(2).replace(/\.?0+$/,'')+'억';
const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;

// 40평대 = 공급 40~49평 ≈ 전용 99 ~ 125㎡ 미만
const BAND=[99,125];
const b40=rows.filter(r=>r.area>=BAND[0]&&r.area<BAND[1]);
const j=b40.filter(r=>r.type==='전세');
const w=b40.filter(r=>r.type==='월세');

const line=(t,a,key)=>console.log(` ${t}: ${a.length}건  중앙 ${key==='dep'?eok(med(a.map(x=>x.dep))):med(a.map(x=>x.rent))+'만'}  범위 ${key==='dep'?eok(Math.min(...a.map(x=>x.dep)))+'~'+eok(Math.max(...a.map(x=>x.dep))):Math.min(...a.map(x=>x.rent))+'~'+Math.max(...a.map(x=>x.rent))+'만'}`);

console.log('===== 신도림동 아파트 40평대 (전용 99~125㎡) / 2025.09.09~2026.09.08 =====');
console.log('총', b40.length, '건 (전세', j.length, '· 월세', w.length, ')');
console.log('[전세]');
line('보증금', j, 'dep');
console.log(' 평균', eok(avg(j.map(x=>x.dep))));
console.log('[월세]');
line('보증금', w, 'dep'); line('월세금', w, 'rent');
console.log(' 보증금 평균', eok(avg(w.map(x=>x.dep))), '/ 월세 평균', avg(w.map(x=>x.rent))+'만');
console.log(' 순수월세(보증금 1억 미만)', w.filter(x=>x.dep<10000).length, '건 · 반전세(1억↑)', w.filter(x=>x.dep>=10000).length,'건');

console.log('\n===== 전용면적별 =====');
const areas=[...new Set(b40.map(r=>Math.round(r.area)))].sort((a,b)=>a-b);
for(const a of areas){
  const g=b40.filter(r=>Math.round(r.area)===a);
  const gj=g.filter(r=>r.type==='전세'), gw=g.filter(r=>r.type==='월세');
  console.log(`전용 ${a}㎡ (약 ${g[0].py}평형) | 전세 ${gj.length}건 중앙 ${gj.length?eok(med(gj.map(x=>x.dep))):'-'} ${gj.length?'('+eok(Math.min(...gj.map(x=>x.dep)))+'~'+eok(Math.max(...gj.map(x=>x.dep)))+')':''} | 월세 ${gw.length}건 ${gw.length?'보증 '+eok(med(gw.map(x=>x.dep)))+' / 월 '+med(gw.map(x=>x.rent))+'만':'-'}`);
}

console.log('\n===== 단지별 =====');
const ds=[...new Set(b40.map(r=>r.danji))];
const dstat=ds.map(d=>{const g=b40.filter(r=>r.danji===d);const gj=g.filter(r=>r.type==='전세'),gw=g.filter(r=>r.type==='월세');
  return {d, built:g[0].built, n:g.length, jn:gj.length, jmed:gj.length?med(gj.map(x=>x.dep)):null,
    jmin:gj.length?Math.min(...gj.map(x=>x.dep)):null, jmax:gj.length?Math.max(...gj.map(x=>x.dep)):null,
    wn:gw.length, wdep:gw.length?med(gw.map(x=>x.dep)):null, wrent:gw.length?med(gw.map(x=>x.rent)):null,
    areas:[...new Set(g.map(x=>Math.round(x.area)))].sort((a,b)=>a-b).join('/')};
}).sort((a,b)=>(b.jmed||0)-(a.jmed||0));
dstat.forEach(x=>console.log(`${x.d} (${x.built}, 전용 ${x.areas}㎡) | 전세 ${x.jn}건 ${eok(x.jmed)} (${eok(x.jmin)}~${eok(x.jmax)}) | 월세 ${x.wn}건 ${x.wn?'보증 '+eok(x.wdep)+' / 월 '+x.wrent+'만':'-'}`));

console.log('\n===== 분기별 전세 추이 =====');
const q=r=>{const y=+r.ym.slice(0,4),m=+r.ym.slice(4);return y+'.'+(m<=3?'1Q':m<=6?'2Q':m<=9?'3Q':'4Q');};
const qs=[...new Set(j.map(q))].sort();
qs.forEach(k=>{const g=j.filter(r=>q(r)===k);console.log(` ${k}: ${g.length}건 중앙 ${eok(med(g.map(x=>x.dep)))}`);});

console.log('\n===== 최근 3개월 40평대 전세 거래 =====');
j.filter(r=>['202607','202608','202609'].includes(r.ym)).sort((a,b)=>(b.ym+b.d).localeCompare(a.ym+a.d))
 .forEach(r=>console.log(` ${r.ym.slice(0,4)}.${r.ym.slice(4)}.${r.d} ${r.danji} 전용${r.area}㎡ ${r.floor}층 ${eok(r.dep)} [${r.gubun}]`));
console.log('\n===== 최근 3개월 40평대 월세 거래 =====');
w.filter(r=>['202607','202608','202609'].includes(r.ym)).sort((a,b)=>(b.ym+b.d).localeCompare(a.ym+a.d))
 .forEach(r=>console.log(` ${r.ym.slice(0,4)}.${r.ym.slice(4)}.${r.d} ${r.danji} 전용${r.area}㎡ ${r.floor}층 보증 ${eok(r.dep)} / 월 ${r.rent}만 [${r.gubun}]`));

console.log('\n===== 참고: 인접 평형 전세 중앙값 =====');
[[80,99,'30평대(전용 80~99㎡)'],[125,145,'50평대(전용 125~145㎡)']].forEach(([lo,hi,label])=>{
  const g=rows.filter(r=>r.type==='전세'&&r.area>=lo&&r.area<hi);
  if(g.length)console.log(` ${label}: ${g.length}건 중앙 ${eok(med(g.map(x=>x.dep)))}`);
});
