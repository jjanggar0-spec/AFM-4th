# 지역 업체 수집 스크립트 (검증됨: 2026-10-08 구리 안과 리서치)

모든 코드는 `mcp__playwright__browser_evaluate` 의 `function` 에 그대로 넣는다.

- **같은 도메인 페이지에 먼저 `browser_navigate` 한 뒤** 실행한다 (fetch·iframe은 same-origin만 된다).
- 결과가 크면 `filename: ".playwright-mcp/<이름>.json"` 으로 저장한 뒤 node로 가공한다.
  - 이 PC에는 python이 없다 → `node -e` 를 쓴다.
  - 저장된 JSON이 문자열로 한 번 더 감싸져 있을 수 있다 → `if(typeof d=='string') d=JSON.parse(d)`.
- evaluate 호출 사이에는 지역 변수가 사라진다. 다음 호출에서 다시 쓸 함수와 결과는 `window.__xxx` 에 둔다.
- `window.open` 으로 탭 20개를 순서대로 여는 방식은 "Target page closed" 오류가 났다. 아래 **fetch / iframe 방식**을 쓴다.

---

## 1. 기준 업체 좌표 찾기

`browser_navigate` → `https://pcmap.place.naver.com/<업종>/list?query=<업체명>`
업종: `hospital`(병원), `restaurant`, `place` 등.

```js
() => Object.entries(window.__APOLLO_STATE__||{})
  .filter(([k,v]) => k.startsWith('PlaceListBusinessesItem'))
  .map(([k,v]) => ({id:v.id, name:v.name, cat:v.category, addr:v.roadAddress||v.address, x:v.x, y:v.y,
                    tel:v.phone||v.virtualPhone, vr:v.visitorReviewCount, br:v.blogCafeReviewCount}))
```

## 2. 반경 N km 안 업체 목록 (검색어 여러 개를 fetch로 동시에)

- 목록 페이지 HTML에 `__APOLLO_STATE__ = {...};` 가 들어 있어서 fetch + JSON.parse로 바로 읽힌다.
- 검색어는 **시·구 + 동(洞) + 역 이름**을 넉넉히 넣는다. 결과가 더 늘지 않을 때까지 추가한다.
- 거리는 하버사인 직선거리다.

```js
async () => {
const qs = ['구리 안과','인창동 안과','다산 안과' /* … 시·구·동·역 이름 */];
const cx=127.1396708, cy=37.6009196, R_KM=5, CAT=/안과/;   // 기준 좌표·반경·업종
const dist=(x,y)=>{const R=6371,dLat=(y-cy)*Math.PI/180,dLon=(x-cx)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(cy*Math.PI/180)*Math.cos(y*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));};
const out={};
await Promise.all(qs.map(async q=>{
  const t=await (await fetch('/hospital/list?query='+encodeURIComponent(q)+'&x='+cx+'&y='+cy)).text();
  const i=t.indexOf('__APOLLO_STATE__ = ')+19, j=t.indexOf('};',i)+1;
  let s; try{s=JSON.parse(t.slice(i,j));}catch(e){return;}
  for(const [k,v] of Object.entries(s)) if(k.startsWith('PlaceListBusinessesItem')&&v.x)
    out[v.id]={id:v.id,name:v.name,cat:v.category,addr:(v.commonAddress||'')+' | '+(v.roadAddress||''),
               d:+dist(+v.x,+v.y).toFixed(2),vr:v.visitorReviewCount,br:v.blogCafeReviewCount,tel:v.phone||v.virtualPhone};
}));
return Object.values(out).filter(o=>o.d<=R_KM && CAT.test((o.cat||'')+o.name)).sort((a,b)=>a.d-b.d);
}
```

## 3. 한 업체의 방문자 리뷰 전체 (대상 업체용)

`browser_navigate` → `https://pcmap.place.naver.com/hospital/<ID>/review/visitor?reviewSort=recent`

```js
async () => {
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let k=0;k<80;k++){            // "펼쳐서 더보기" 한 번에 10건씩 늘어난다
  const b=[...document.querySelectorAll('a,button')].find(e=>/^\s*펼쳐서 더보기/.test(e.innerText||''));
  if(!b) break; b.click(); await sleep(1500);
}
const lis=[...document.querySelectorAll('li')].filter(li=>/방문일/.test(li.innerText)&&/인증 수단/.test(li.innerText));
for(const li of lis) for(const a of li.querySelectorAll('a,button')) if((a.innerText||'').trim()==='더보기') try{a.click()}catch(e){}
await sleep(1500);
return lis.map((li,i)=>{
  const t=li.innerText, lines=t.split('반응 남기기')[0].split('\n').map(s=>s.trim()).filter(Boolean);
  const vd=t.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/);
  const after=t.split(/인증 수단\n[^\n]+\n/)[1]||'';
  return {i, date: vd?`${vd[1]}-${vd[2].padStart(2,'0')}-${vd[3].padStart(2,'0')}`:'',
    visit:(t.match(/(\d+)번째 방문/)||[])[1], auth:(t.match(/인증 수단\n([^\n]+)/)||[])[1],
    reply: after.trim().length>20,                       // 사장님 답글 여부
    text: lines.slice(lines.indexOf('팔로우')+1).join(' / ').replace(/ \/ (더보기|접기)/g,'')};
});
}
```

- 리뷰 앞부분에 **방문 태그**가 붙는다: `예약 후 이용` / `예약 없이 이용` + `대기 시간 바로 입장 | 10분 이내 | 30분 이내 | 30분 이상 | 1시간 이상 | 2시간 이상`.
  - 정규식 `/대기 시간 ?([^/]+?)(?: \/|$)/` 로 뽑아 분포를 낸다.
- 답글 원문이 필요하면 `t.slice(t.indexOf('인증 수단'), +700)` 를 본다. 답글 날짜가 몰려 있는지도 확인한다.

## 4. 여러 업체의 최신 리뷰 표본 (주변 업체 비교용) — iframe 크롤러

먼저 아무 pcmap 페이지에서 함수를 `window` 에 등록한다.

```js
async () => {
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
window.__res = window.__res || {};
window.__crawlFn = async function(id, more=5){
  const f=document.createElement('iframe');
  f.style.cssText='width:800px;height:900px;position:fixed;left:0;top:0;opacity:0.01';
  f.src='/hospital/'+id+'/review/visitor?reviewSort=recent'; document.body.appendChild(f);
  await new Promise(r=>f.onload=r); await sleep(2500);
  const d=f.contentDocument;
  for(let k=0;k<more;k++){ const b=[...d.querySelectorAll('a,button')].find(e=>/^\s*펼쳐서 더보기/.test(e.innerText||'')); if(!b)break; b.click(); await sleep(1600); }
  const lis=[...d.querySelectorAll('li')].filter(li=>/방문일/.test(li.innerText)&&/인증 수단/.test(li.innerText));
  const rows=lis.map(li=>{const t=li.innerText, lines=t.split('반응 남기기')[0].split('\n').map(s=>s.trim()).filter(Boolean);
    const vd=t.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/); const after=t.split(/인증 수단\n[^\n]+\n/)[1]||'';
    return {date: vd?`${vd[1]}-${vd[2].padStart(2,'0')}-${vd[3].padStart(2,'0')}`:'', reply: after.trim().length>20,
            text: lines.slice(lines.indexOf('팔로우')+1).join(' / ').replace(/ \/ (더보기|접기)/g,'')};});
  f.remove(); window.__res[id]=rows; return rows.length;
};
return 'ok';
}
```

그다음 **5개씩** 나눠 호출한다 (한 번에 다 돌리면 시간 초과가 날 수 있다).

```js
async () => Promise.all(['ID1','ID2','ID3','ID4','ID5'].map(id=>window.__crawlFn(id).catch(e=>'err '+e)))
```

- 곳당 30~60건이 모인다. 동시에 돌리면 일부는 덜 펼쳐질 수 있는데, 비교용 표본으로는 충분하다.
- ⚠️ **중첩된 `li` 때문에 같은 리뷰가 두 번 잡힌다.** 가공할 때 반드시 `date + text.slice(0,80)` 를 키로 중복을 제거한다.
- 다 모으면 `() => window.__res` 를 `filename` 으로 저장한다.

## 5. 업체 기본 정보 (진료시간·전문의 수·홈페이지·편의)

```js
async () => {
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ids=[/* ID 목록 */]; window.__home={};
async function home(id){
  const f=document.createElement('iframe'); f.style.cssText='width:800px;height:900px;position:fixed;left:0;top:0;opacity:0.01';
  f.src='/hospital/'+id+'/home'; document.body.appendChild(f);
  await new Promise(r=>f.onload=r); await sleep(2000);
  const d=f.contentDocument;
  const ex=[...d.querySelectorAll('a,span,div')].find(e=>(e.innerText||'').trim()==='펼쳐보기'); if(ex){ex.click(); await sleep(800);}
  const t=d.body.innerText; f.remove();
  const a=t.indexOf('주소'), b=t.indexOf('진료정보');
  window.__home[id]=t.slice(a, b>0?b:a+1500).replace(/\n+/g,' | ').slice(0,1200);
}
for(let i=0;i<ids.length;i+=6) await Promise.all(ids.slice(i,i+6).map(home));
return window.__home;
}
```

- 텍스트에서 요일별 시간, `전문의안과 N명`, `편의 | 예약, 주차, 발렛파킹 …`, 공지(조기 접수마감, 휴진일)를 읽는다.
- 일요일·야간(19시 이후) 진료 여부를 표시한다. 조사일이 공휴일 주간이면 그날은 "휴무"로 나오니 월~목 기준으로 적는다.

## 6. 네이버 블로그 (fetch로 여러 검색어 → m.blog 본문)

`search.naver.com` 페이지에서 실행한다.

```js
async () => {
const qs=['<업체> 후기','<업체> 단점','<업체> 대기시간','<업체> 불친절','<업체> 과잉진료'];
const m={};
await Promise.all(qs.map(async q=>{
  const t=await (await fetch('/search.naver?ssc=tab.blog.all&query='+encodeURIComponent(q))).text();
  const doc=new DOMParser().parseFromString(t,'text/html');
  for(const a of doc.querySelectorAll('a[href*="blog.naver.com"]')){
    const h=a.href.split('?')[0], tx=(a.textContent||'').trim();
    if(/blog\.naver\.com\/[^/]+\/\d+/.test(h) && tx.length>=8 && !m[h]) m[h]={h,title:tx.slice(0,120),q};
  }
}));
return Object.values(m);
}
```

- 검색 결과에 무관한 글이 많다 → 제목에 업체명이 있는 글만 고른다.
- 본문은 `browser_navigate` 로 `m.blog.naver.com/<id>/<no>` 에 간 뒤 fetch(`'/'+id+'/'+no`) → `.se-main-container` 의 텍스트를 읽는다. 날짜는 `.blog_date`.
- 병원 **공식 블로그**·보도자료·"체험단/소정의 원고료" 글은 광고로 분류한다.

## 7. 카카오맵 후기 (별점 포함)

1. `https://map.kakao.com/?q=<업체명>` → `#info\.search\.place\.list li` 의 `a.moreview` href 에서 `place.map.kakao.com/<ID>` 를 얻는다.
2. 그 주소로 `browser_navigate` 한 뒤 아래 코드를 실행한다.

```js
async () => {
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tab=[...document.querySelectorAll('a,button')].find(e=>(e.innerText||'').trim()==='후기'); if(tab) tab.click(); await sleep(2500);
for(let k=0;k<10;k++){ window.scrollTo(0,1e7); await sleep(1200); }   // 스크롤하면 후기가 더 나온다
for(const b of [...document.querySelectorAll('a,button,span')].filter(e=>(e.innerText||'').trim()==='더보기'&&e.offsetParent)) try{b.click()}catch(e){}
await sleep(800);
const t=document.body.innerText, seg=t.slice(t.indexOf('후기 목록'), t.indexOf('기타 메뉴'));
const items=seg.split('리뷰어 이름,').slice(1).map(s=>{const st=s.match(/별점\n([\d.]+)\n(\d{4}\.\d{2}\.\d{2})/)||[];
  return {star:st[1],date:st[2],txt:s.replace(/[\s\S]*?\d{4}\.\d{2}\.\d{2}\.\n/,'').split('좋아요 개수')[0].replace(/\n+/g,' ').trim()}});
return {n:items.length, dist:items.reduce((a,x)=>(a[x.star]=(a[x.star]||0)+1,a),{}), low:items.filter(x=>+x.star<=3), dates:items.map(x=>x.date)};
}
```

- 리뷰어 닉네임이 함께 나오지만 보고서에는 넣지 않는다.
- 날짜 목록에서 **짧은 기간에 5점이 몰렸는지** 확인한다.

## 7-1. 카카오맵 후기 전체를 JSON으로 (권장 · 2026-10-08 서울 안과 리서치에서 검증)

화면 스크롤보다 훨씬 빠르고, 별점·날짜·사장님 답글·작성자 후기 수까지 나온다. `place.map.kakao.com/<아무 ID>` 에 `browser_navigate` 한 뒤 실행한다.

- 여러 업체의 카카오 ID 찾기: `map.kakao.com/?q=...` 페이지에서 `#search\.keyword\.query` 에 이름을 넣고 `#search\.keyword\.submit` 을 클릭하는 것을 반복하고, `#info\.search\.place\.list li a.moreview` 의 href를 읽는다.
- 목록에 **"후기 미제공"** 이라고 나오면 그 업체는 카카오 후기를 받지 않는다. 보고서에 그대로 적는다.

```js
async () => {
const places={'업체A':'9493762','업체B':'24018052'};   // 이름: 카카오 ID
const out={};
await Promise.all(Object.entries(places).map(async ([n,id])=>{
  let rows=[], last=null, score=null;
  for(let p=0;p<120;p++){            // 한 번에 20건 → 최대 2,400건
    const j=await (await fetch(`/places/tab/reviews/kakaomap/${id}?order=LATEST&only_photo_review=false`+(last?`&previous_last_review_id=${last}`:''),{headers:{pf:'PC'}})).json();
    if(!score) score=j.score_set;    // review_count, average_score
    const rv=j.reviews||[]; if(!rv.length) break;
    rows.push(...rv.map(r=>({star:r.star_rating, date:(r.registered_at||'').slice(0,10), txt:(r.contents||'').replace(/\s+/g,' '),
      reply:!!(r.meta&&r.meta.place_owner_reply), owner_cnt:r.meta&&r.meta.owner&&r.meta.owner.review_count})));
    last=rv[rv.length-1].review_id; if(!j.has_next) break;
  }
  out[n]={id,score:{count:score&&score.review_count,avg:score&&score.average_score},rows};
}));
window.__kakao=out;
return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.rows.length+'/'+v.score.count+' avg '+v.score.avg]));
}
```

- "낮은 별점순" 정렬은 없다(LOW_RATING 등은 빈 결과). 전부 받아서 `star<=2` 로 거른다.
- 신뢰성 지표:
  - **5점 중 작성자 후기 수(owner_cnt)가 1~2개인 비율**
  - 연도별 후기 수가 갑자기 늘어난 시기
  - 하루에 많이 몰린 날
  - 이번 조사에서는 상위 병원 5점의 50~90%가 후기 1~2개 계정이었다.
- 리뷰어 닉네임·프로필은 저장하지 않는다(보고서에 넣지 않음).

## 7-2. 큰 Area(시 전체 등)

- 목록은 **구 × 업종 검색어 4종**으로 시작한 뒤, **역·동 이름 검색어**로 채운다. 늘어나는 수가 3% 이하가 되면 멈춘다(서울 안과: 482 → 497).
- 리뷰가 수천 건인 상위 업체는 iframe 크롤러를 `more=19~22` 로 돌려 **곳당 120~180건**을 받는다. 2~3곳씩 동시에 돌린다.
- 기간이 업체마다 다르므로 "표본 기간(일)과 하루 리뷰 수"를 같이 적는다.

## 8. 안 된 것 / 주의

- 모두닥(`modoodoc.com/search/?search_query=`)은 404 → 쓰지 않는다.
- `file://` 은 Playwright에서 막혀 있다 → 로컬 서버(`npx -y http-server -p 5517 -s`)로 연다.
