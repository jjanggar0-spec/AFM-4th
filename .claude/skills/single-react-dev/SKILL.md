---
name: single-react-dev
description: Use when the user wants a complete web app in a single index.html file using CDN-based React and Tailwind CSS — interactive UIs, SPAs with hash routing, dashboards, forms, CRUD interfaces, or any self-contained web app without a build system or bundler ("할 일 관리 앱 만들어줘", "매출 대시보드 페이지", "빌드 도구 없이 여러 페이지 웹앱", "Create a contact form with validation").
---

# Single-File React Developer

CDN 기반 React 18 + ReactDOM + Babel standalone + Tailwind CSS로, 빌드 도구 없이 단 하나의 `index.html` 파일 안에 완결된 프로덕션 품질 웹앱을 만든다.

## 🎯 Core Principles

1. **Single File Only**: 산출물은 오직 `index.html` 하나. 추가 파일을 만들지도, 분리를 제안하지도 않는다.
2. **CDN-Based, Version-Pinned**: 모든 라이브러리(React, ReactDOM, Babel, Tailwind CSS)는 CDN `<script>` 태그로 로드하며 **모든 URL에 명시적 버전을 고정**한다. bare/`@latest` URL 금지. (미고정 `@babel/standalone`이 8.x로 올라가 인라인 JSX가 통째로 깨진 사례 있음.) Babel은 반드시 **7.x** (`@7.25.9`) — 8.x는 인라인 `text/babel` 처리가 바뀌어 동작하지 않는다.
3. **Structured Components**: 한 파일 안이라도 컴포넌트는 명확한 섹션 구분자로 잘 조직한다.
4. **Hash-Based Routing**: 멀티 페이지 내비게이션이 필요하면 해시 라우팅(`/#/path`)을 쓴다.

## 📐 Template Structure

`index.html`은 항상 이 구조를 따른다:

```
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[App Title]</title>
  <script src="https://cdn.tailwindcss.com/3.4.16"></script>
  <!-- ⚠️ 모든 CDN은 버전을 명시적으로 고정한다. 미고정 시 @babel/standalone 이
       최신(8.x)으로 올라가 type="text/babel" 인라인 변환이 통째로 깨진다.
       Babel 은 반드시 7.x 로 고정한다 (8.x 미지원). React/ReactDOM 도 정확히 핀. -->
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone@7.25.9/babel.min.js"></script>
  <!-- Additional CDN libraries as needed (반드시 버전 고정) -->
  <style>
    /* Custom CSS only when Tailwind utilities are insufficient */
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // Code organized in strict dependency order
  </script>
</body>
</html>
```

## 📋 Code Organization (within `<script type="text/babel">`)

`// ========================================` 섹션 구분 주석과 함께 항상 이 순서로 조직한다:

1. **React Hooks Destructuring** — 필요한 훅을 최상단에서 추출
2. **🎨 Design System Components** — 재사용 UI 프리미티브 (Button, Input, Card, Modal, Badge 등). 비즈니스 로직 없이 props로만 구동
3. **🔀 Router Components** (라우팅 필요 시에만) — RouterContext, Router, Routes, Route, Link, useRouter, useParams, matchRoute
4. **🧩 Common/Layout Components** — Header, Footer, Sidebar, Navigation 등
5. **📄 Page Components** — 각 페이지/뷰. 자체 상태와 비즈니스 로직 보유
6. **🚀 App Component** — 전체를 조합하는 루트 컴포넌트
7. **Rendering** — `ReactDOM.createRoot(document.getElementById('root')).render(<App />);`

## 🎨 Design System Components

항상 잘 다듬어진 재사용 가능한 Design System 컴포넌트를 제공한다:

- **Button**: `variant` (primary, secondary, danger, ghost), `size` (sm, md, lg), `disabled`, `onClick`, `className` 지원
- **Input**: `type`, `label`, `value`, `onChange`, `placeholder`, `error`, `disabled` 지원
- **Card**: shadow, rounded corners, padding을 갖춘 단순 래퍼
- **Modal**: `isOpen`, `onClose`, `title`, `children`, `size` 지원
- 필요 시 추가 (Badge, Select, Textarea, Tabs 등)

Design System 컴포넌트 규칙:
- Tailwind CSS 유틸리티 클래스만 사용
- 확장을 위한 `className` prop 수용
- 순수 프레젠테이셔널 (비즈니스 로직 없음)
- 합리적인 기본값 보유

## 🔀 Router Implementation

라우팅이 필요하면 경량 해시 기반 라우터를 구현한다:
- `createContext`로 `RouterContext`
- `hashchange` 이벤트로 해시 상태를 관리하는 `Router` 컴포넌트
- 현재 경로를 라우트에 매칭하는 `Routes` 컴포넌트
- `path`와 `element` props를 받는 `Route` 컴포넌트
- 내비게이션용 `Link` 컴포넌트
- 동적 파라미터(`:id`)를 지원하는 `matchRoute` 함수
- `useRouter()`, `useParams()` 훅

라우팅이 필요 없으면 라우터 코드를 전부 생략한다.

## 📡 API Communication Rules

**CRITICAL: API_BASE_URL은 절대 `http://localhost:xxxx`로 하드코딩하지 않는다**

항상 다음 패턴 중 하나를 사용:

```javascript
// ✅ Preferred: Relative path
const API_BASE_URL = '/api';

// ✅ Alternative: Origin-based
const API_BASE_URL = window.location.origin + '/api';

// ✅ If truly needed: Environment-aware
const API_BASE_URL = window.location.hostname === 'localhost'
  ? `http://${window.location.hostname}:3001/api`
  : '/api';

// ❌ NEVER DO THIS
const API_BASE_URL = 'http://localhost:3001'; // FORBIDDEN
```

API 호출이 필요하면 `useFetch` 커스텀 훅을 제공한다:

```javascript
function useFetch(endpoint) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}${endpoint}`)
      .then(res => res.json())
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [endpoint]);

  return { data, loading, error };
}
```

## 🔧 Additional CDN Libraries

추가 기능이 필요하면 `<head>`에 적절한 CDN 라이브러리를 추가한다:
- **Axios**: `https://cdn.jsdelivr.net/npm/axios@1/dist/axios.min.js`
- **Day.js**: `https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js`
- **Chart.js**: `https://cdn.jsdelivr.net/npm/chart.js@4`
- **Lodash**: `https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js`
- **Marked** (Markdown): `https://cdn.jsdelivr.net/npm/marked@15/marked.min.js`
- **SortableJS**: `https://cdn.jsdelivr.net/npm/sortablejs@1/Sortable.min.js`

> 모든 URL은 버전 고정(정확 버전 또는 메이저 핀). 절대 `@latest`·미고정 사용 금지.

## 🧠 State Management

- 컴포넌트 로컬 상태는 `useState`
- 공유/전역 상태는 `useContext` + `createContext` (Provider 패턴으로 래핑)
- 복잡한 상태 로직은 `useReducer`
- 적절할 때 `useMemo`, `useCallback`으로 성능 최적화
- DOM 참조와 가변 값은 `useRef`

## ✅ Quality Standards

1. **Responsive Design**: Tailwind 반응형 프리픽스(`sm:`, `md:`, `lg:`)로 모바일·태블릿·데스크톱 모두 대응
2. **Accessibility**: 적절한 `aria` 속성, 시맨틱 HTML, 키보드 내비게이션 지원
3. **Error Handling**: 사용자 친화적 에러 상태 표시, 엣지 케이스 처리
4. **Loading States**: 비동기 작업 중 로딩 인디케이터 표시
5. **Empty States**: 빈 데이터를 우아하게 처리·표시
6. **Korean Language**: 별도 지정이 없으면 UI 기본 언어는 한국어
7. **Clean Code**: 일관된 네이밍, 명확한 주석, 논리적 그룹핑

## 📝 Response Format

모든 요청에 대해:

1. **요구사항 간단 분석** (1–3문장)
2. **완전한 `index.html` 파일** 산출
3. `// ========================================` 패턴의 **섹션 주석** 추가
4. 마지막에 **실행 방법 안내**:
   - VS Code Live Server 확장 사용
   - 또는 터미널에서 `npx serve .`
   - 해시 라우팅 사용 시 사용 가능한 라우트 목록 (예: `/#/`, `/#/about`)

## ⚠️ Strict Rules

1. **ONE FILE ONLY**: 추가 파일 생성·제안 금지
2. **DEPENDENCY ORDER**: 컴포넌트는 사용 전에 선언
3. **NO HARDCODED LOCALHOST URLS**: API URL은 상대 경로 또는 `window.location` 사용
4. **TAILWIND FIRST**: Tailwind 유틸리티 우선; `<style>`은 Tailwind로 불가능한 것(애니메이션, 복잡한 셀렉터)에만
5. **BABEL REQUIRED (v7, PINNED)**: JSX는 항상 `<script type="text/babel">`. `@babel/standalone@7.25.9` 고정 — 8.x는 인라인 `text/babel` 처리가 바뀌어 깨진다. 미고정 Babel URL 금지
6. **REMOVE UNUSED CODE**: 라우팅이 필요 없으면 라우터 코드 제외, API 호출이 없으면 useFetch 제외. 산출물은 린하게
7. **COMPLETE & RUNNABLE**: 로컬 서버로 열면 즉시 동작해야 함 — 빠진 조각 없이
8. **PIN EVERY CDN VERSION**: 모든 `<script src>`에 명시적 버전(정확 버전 `@7.25.9` 또는 메이저 `@4`). bare/`@latest` URL 금지 — 메이저 버전이 조용히 바뀌며 예고 없이 깨진다

## 💡 Best Practices

- 이모지 접두 섹션 헤더로 가독성 확보
- 컴포넌트 정의 사이 빈 줄 하나
- Design System 컴포넌트 먼저, 페이지 컴포넌트 마지막
- 비즈니스 로직은 페이지 컴포넌트에, Design System 컴포넌트에는 넣지 않기
- 폼은 controlled component 선호
- 동적 클래스명은 템플릿 리터럴 사용
- `useEffect` return 함수에서 적절한 cleanup 구현
