/* =========================================================
   PS Log — app logic (vanilla JS, no dependencies)
   Data lives in localStorage and syncs to data.json in a
   private GitHub repo via the Contents API.
   ========================================================= */

const STORE_KEY = 'pslog.data.v1';
const SYNC_KEY  = 'pslog.sync.v1';   // GitHub 연결 정보 (기기별, 내보내기에 포함되지 않음)
const DIRTY_KEY = 'pslog.dirty.v1';  // 아직 깃허브에 올리지 못한 변경이 있는지
const LANG_KEY  = 'pslog.lang.v1';   // 개념에서 마지막으로 보던 언어 (기기별 화면 상태)
const REVIEW_OFFSETS = [3, 7, 21]; // days after a failed attempt

/* ---------- 개념 노트의 언어 ---------- */
const LANGS = [['cpp','C++'], ['java','Java'], ['python','Python']];
const LANG_IDS = LANGS.map(l => l[0]);
const LANG_LABEL = Object.fromEntries(LANGS);
const DEFAULT_LANG = 'cpp';
// 언어는 데이터가 아니라 화면 상태라 data.json이 아니라 이 기기에만 남긴다
let activeLang = LANG_IDS.includes(localStorage.getItem(LANG_KEY))
  ? localStorage.getItem(LANG_KEY) : DEFAULT_LANG;

/* ---------- date helpers ---------- */
const MS_DAY = 86400000;
// 날짜는 항상 "이 기기의 달력 날짜"로 다룬다.
// toISOString()은 UTC라, 한국(UTC+9)에서는 자정~오전 9시에 하루가 밀린다.
function isoOf(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const todayISO = () => isoOf(new Date());
function addDays(iso, n){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
function daysBetween(a, b){ // b - a in days
  return Math.round((new Date(b+'T00:00:00') - new Date(a+'T00:00:00')) / MS_DAY);
}
function fmtKDate(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${+m}월 ${+d}일`;
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

/* ---------- state ---------- */
// images: { <id>: {name, data} }
// 사진은 본문이 아니라 여기에 따로 담는다. 본문에는 ![이름](img:<id>) 참조만 남아서
// 편집창이 base64 덩어리로 뒤덮이지 않는다.
let state = { version:1, settings:{email:''}, problems:[], concepts:[], todos:[], images:{} };

function save(){
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if(applyingRemote) return;   // 원격 내용을 반영하는 중이면 되돌려 올리지 않는다
  setDirty(true);
  schedulePush();
}

function load(){
  const raw = localStorage.getItem(STORE_KEY);
  if(raw){
    try{ state = normalize(JSON.parse(raw)); return true; }catch(e){}
  }
  return false;
}
// data.json은 다른 기기·불러오기·저장소에서 그대로 들어온다. 모양이 어긋난 항목 하나가
// 렌더 도중 예외를 던지면 화면 전체가 비므로, 여기서 한 번 형태를 맞춰 둔다.
// 멀쩡한 데이터에는 손대지 않는다 (건드리면 fingerprint가 달라져 매번 다시 커밋된다).
const asStr = (v, fb='') => typeof v === 'string' ? v : fb;

function normalizeProblem(p){
  const out = Object.assign({}, p);
  out.id = asStr(out.id) || uid();
  if(out.firstResult === 'fail'){
    // trackHTML·markReviewDone이 reviews를 인덱스로 훑는다
    out.reviews = (Array.isArray(out.reviews) ? out.reviews : [])
      .filter(r => r && typeof r === 'object')
      .slice(0, REVIEW_OFFSETS.length)
      .map(r => ({
        due: asStr(r.due),
        done: !!r.done,
        doneDate: typeof r.doneDate === 'string' ? r.doneDate : null,
      }));
  }
  return out;
}

function normalizeConcept(c){
  const out = Object.assign({}, c);
  out.id = asStr(out.id) || uid();
  out.title = asStr(out.title);
  out.markdown = asStr(out.markdown);
  out.tags = Array.isArray(out.tags) ? out.tags.filter(t => typeof t === 'string') : [];
  // 언어가 없던 예전 노트는 C++로 본다
  if(!LANG_IDS.includes(out.lang)) out.lang = DEFAULT_LANG;
  return out;
}

function normalizeTodo(t){
  const out = Object.assign({}, t);
  out.id = asStr(out.id) || uid();
  out.date = asStr(out.date);
  out.text = asStr(out.text);
  out.done = !!out.done;
  return out;
}

function normalize(d){
  d = d || {};
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const images = {};
  if(isObj(d.images)){
    for(const [id, img] of Object.entries(d.images)){
      if(isObj(img) && typeof img.data === 'string') images[id] = { name: asStr(img.name, '이미지'), data: img.data };
    }
  }
  const out = {
    version: 1,
    settings: { email: asStr(d.settings && d.settings.email) },
    problems: (Array.isArray(d.problems) ? d.problems : []).filter(isObj).map(normalizeProblem),
    concepts: (Array.isArray(d.concepts) ? d.concepts : []).filter(isObj).map(normalizeConcept),
    // todos · images는 나중에 추가된 필드 — 예전 data.json에는 없으므로 비워서 채운다
    todos: (Array.isArray(d.todos) ? d.todos : []).filter(isObj).map(normalizeTodo),
    images,
  };
  extractInlineImages(out);
  return out;
}

// 예전 노트는 본문에 data: URL을 통째로 넣었다. 편집창이 base64로 뒤덮여 글을 읽을 수
// 없으므로, 열 때 사진을 images로 빼내고 본문에는 짧은 참조만 남긴다.
// id는 기기마다 같은 값이 나오도록 결정적으로 만든다 — 무작위로 만들면 기기끼리
// 같은 내용인데도 다르다고 판정해 동기화가 계속 어긋난다.
function extractInlineImages(d){
  for(const c of d.concepts){
    const src = c.markdown || '';
    if(!src.includes('](data:')) continue;
    let n = 0;
    c.markdown = src.replace(/!\[([^\]]*)\]\((data:[^)]+)\)/g, (m, alt, data) => {
      const id = `${c.id}-${++n}`;
      d.images[id] = { name: alt || '이미지', data };
      return `![${alt}](img:${id})`;
    });
  }
}

// 어떤 노트도 참조하지 않는 사진을 버린다 (노트를 지웠을 때만 호출)
function gcImages(){
  const used = new Set();
  for(const c of state.concepts){
    for(const m of (c.markdown||'').matchAll(/\]\(img:([^)]+)\)/g)) used.add(m[1]);
  }
  for(const id of Object.keys(state.images)){
    if(!used.has(id)) delete state.images[id];
  }
}

/* ============================================================
   GitHub 동기화
   비공개 저장소의 data.json을 Contents API로 읽고 커밋한다.
   토큰은 이 브라우저의 localStorage에만 저장되며 사이트에 배포되지 않는다.
   ============================================================ */
let sync = { token:'', repo:'', branch:'master', path:'data.json' };
let remoteSha = null;        // 마지막으로 확인한 원격 파일의 blob sha
let applyingRemote = false;  // 원격 → 로컬 반영 중 (자동 업로드 억제)
let initializing = false;    // 첫 동기화 진행 중 (로컬을 먼저 올려버리지 않도록)
let pushTimer = null;
let pushInFlight = null;

function loadSync(){
  try{
    const raw = localStorage.getItem(SYNC_KEY);
    if(raw) sync = Object.assign(sync, JSON.parse(raw));
  }catch(e){}
  sync.branch = sync.branch || 'master';
  sync.path = sync.path || 'data.json';
}
function saveSync(){ localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); }
function syncReady(){ return !!(sync.token && /^[^/\s]+\/[^/\s]+$/.test(sync.repo)); }

function isDirty(){ return localStorage.getItem(DIRTY_KEY) === '1'; }
function setDirty(v){
  localStorage.setItem(DIRTY_KEY, v ? '1' : '0');
  if(v) setSyncStatus('dirty', '저장 안 됨');
}

/* ---------- base64 (UTF-8 안전, 큰 문서도 스택 안 터지게 청크 처리) ---------- */
function b64encode(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for(let i = 0; i < bytes.length; i += 0x8000){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decode(b64){
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- API 호출 ---------- */
function ghHeaders(extra){
  return Object.assign({
    'Authorization': `Bearer ${sync.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }, extra || {});
}
async function ghError(res){
  let msg = '';
  try{ msg = (await res.json()).message || ''; }catch(e){}
  if(res.status === 401) return '토큰이 잘못되었거나 만료됐어요 (401)';
  if(res.status === 403) return '권한이 없어요. 토큰에 Contents 쓰기 권한을 주세요 (403)';
  if(res.status === 404) return '저장소나 브랜치를 찾을 수 없어요. 주소·권한을 확인하세요 (404)';
  if(res.status === 409) return '저장소가 비어 있거나 브랜치가 없어요 (409)';
  return `${res.status} ${msg}`.trim();
}

// 원격 data.json 읽기 → {missing} 또는 {sha, text}
async function ghFetchFile(){
  const url = `https://api.github.com/repos/${sync.repo}/contents/${encodeURI(sync.path)}`
            + `?ref=${encodeURIComponent(sync.branch)}&t=${Date.now()}`;
  const res = await fetch(url, { headers: ghHeaders(), cache:'no-store' });
  if(res.status === 404) return { missing:true };
  if(!res.ok) throw new Error(await ghError(res));
  const j = await res.json();
  if(j.content) return { sha:j.sha, text:b64decode(j.content) };
  // 1MB 초과 파일은 content가 비어 온다 → blob API로 원본을 받는다
  const b = await fetch(`https://api.github.com/repos/${sync.repo}/git/blobs/${j.sha}`,
    { headers: ghHeaders({'Accept':'application/vnd.github.raw'}) });
  if(!b.ok) throw new Error(await ghError(b));
  return { sha:j.sha, text: await b.text() };
}

async function ghPutFile(text, message, sha){
  const url = `https://api.github.com/repos/${sync.repo}/contents/${encodeURI(sync.path)}`;
  const body = { message, content:b64encode(text), branch:sync.branch };
  if(sha) body.sha = sha;
  const res = await fetch(url, { method:'PUT', headers:ghHeaders(), body:JSON.stringify(body) });
  if(res.status === 409 || res.status === 422){ const e = new Error('conflict'); e.conflict = true; throw e; }
  if(!res.ok) throw new Error(await ghError(res));
  const j = await res.json();
  return j.content && j.content.sha;
}

/* ---------- 직렬화 ---------- */
function snapshot(){
  return {
    version:1,
    exportedAt:new Date().toISOString(),
    settings:state.settings,
    problems:state.problems.map(({_lastDate,...p})=>p),
    concepts:state.concepts,
    todos:state.todos,
    images:state.images,
  };
}
function serialize(){ return JSON.stringify(snapshot(), null, 2) + '\n'; }
// 비교용: 시각처럼 매번 달라지는 값은 뺀다
function fingerprint(d){
  return JSON.stringify({
    settings:d.settings,
    problems:(d.problems||[]).map(({_lastDate,...p})=>p),
    concepts:d.concepts,
    todos:d.todos||[],
    images:d.images||{},
  });
}

function applyRemote(data){
  clearTimeout(pushTimer);   // 방금 버린 로컬 내용을 되올리지 않는다
  applyingRemote = true;
  state = normalize(data);
  save();
  applyingRemote = false;
  setDirty(false);
  closeConceptEditor();
  $('#s-email').value = state.settings.email || '';
  renderProblems(); renderConceptList(); renderSchedule();
}

/* ---------- pull / push ---------- */
async function pullRemote(){
  const f = await ghFetchFile();
  if(f.missing){ remoteSha = null; return { missing:true }; }
  remoteSha = f.sha;
  return { data: normalize(JSON.parse(f.text)) };
}

async function pushNow(force){
  if(!syncReady()) return false;
  if(initializing && !force){
    // 첫 동기화가 끝나기 전에는 올리지 않는다 (빈 로컬로 원격을 덮어쓰는 사고 방지)
    clearTimeout(pushTimer);
    pushTimer = setTimeout(()=>pushNow(), 1500);
    return false;
  }
  if(!force && !isDirty()) return false;
  if(pushInFlight) return pushInFlight;
  pushInFlight = (async () => {
    setSyncStatus('busy', '올리는 중…');
    const msg = `PS Log 기록 업데이트 (${new Date().toLocaleString('ko-KR')})`;
    try{
      remoteSha = await ghPutFile(serialize(), msg, remoteSha);
    }catch(e){
      if(!e.conflict) throw e;
      // 다른 기기에서 먼저 저장한 경우
      const r = await pullRemote();
      if(!r.missing && fingerprint(r.data) === fingerprint(state)){
        setDirty(false); setSyncStatus('ok', '이미 최신');
        return true;
      }
      const overwrite = confirm(
        '깃허브에 다른 기기에서 저장한 변경이 있어요.\n\n' +
        '확인 = 이 기기 내용으로 덮어쓰기\n' +
        '취소 = 깃허브 내용을 가져오고 이 기기 변경은 버리기');
      if(!overwrite){
        if(!r.missing) applyRemote(r.data);
        setSyncStatus('ok', '깃허브 내용으로 맞춤');
        return true;
      }
      remoteSha = await ghPutFile(serialize(), msg + ' (덮어씀)', remoteSha);
    }
    setDirty(false);
    setSyncStatus('ok', '동기화됨');
    return true;
  })().catch(err => {
    setSyncStatus('err', err.message || '동기화 실패');
    toast('동기화 실패 · ' + (err.message || ''));
    return false;
  }).finally(() => { pushInFlight = null; });
  return pushInFlight;
}

function schedulePush(){
  if(!syncReady()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(()=>pushNow(), 4000);
}

// 상단 동기화 버튼: 올릴 게 있으면 올리고, 없으면 최신 내용을 받아온다
async function syncNow(){
  if(!syncReady()){ toast('설정에서 깃허브 저장소를 먼저 연결하세요'); openSettings(); return; }
  clearTimeout(pushTimer);
  if(isDirty()){
    if(await pushNow(true)) toast('깃허브에 저장했어요');
    return;
  }
  setSyncStatus('busy', '받는 중…');
  try{
    const r = await pullRemote();
    if(r.missing){ await pushNow(true); toast('깃허브에 data.json을 만들었어요'); return; }
    if(fingerprint(r.data) === fingerprint(state)){
      setSyncStatus('ok', '이미 최신'); toast('이미 최신 상태예요'); return;
    }
    applyRemote(r.data);
    setSyncStatus('ok', '불러옴'); toast('깃허브에서 최신 기록을 가져왔어요');
  }catch(e){
    setSyncStatus('err', e.message); toast('동기화 실패 · ' + e.message);
  }
}

/* 첫 진입: 원격을 기준으로 맞춘다 */
async function initialSync(hadLocal){
  clearTimeout(pushTimer);
  initializing = true;
  setSyncStatus('busy', '동기화 중…');
  try{
    const r = await pullRemote();
    if(r.missing){
      await pushNow(true);
      return;
    }
    const differs = fingerprint(r.data) !== fingerprint(state);
    if(hadLocal && isDirty() && differs){
      const keepLocal = confirm(
        '이 기기에 아직 깃허브에 올리지 않은 변경이 있어요.\n\n' +
        '확인 = 이 기기 내용을 올리기\n' +
        '취소 = 깃허브 내용을 가져오기 (이 기기 변경은 사라짐)');
      if(keepLocal){ await pushNow(true); return; }
    }
    if(differs) applyRemote(r.data);
    setDirty(false);
    setSyncStatus('ok', '동기화됨');
  }catch(e){
    setSyncStatus('err', e.message);
  }finally{
    initializing = false;
  }
}

/* ---------- 상태 표시 ---------- */
function setSyncStatus(kind, text){
  const el = $('#syncStatus');
  if(!el) return;
  el.dataset.kind = kind;
  el.textContent = syncReady() ? text : '연결 안 됨';
  el.title = syncReady() ? `${sync.repo} · ${sync.branch}/${sync.path}` : '설정에서 깃허브 저장소를 연결하세요';
}

async function testConnection(){
  const btn = $('#s-test');
  const out = $('#s-testResult');
  out.textContent = '확인 중…'; out.dataset.kind = 'busy';
  btn.disabled = true;
  const saved = JSON.stringify(sync);
  readSyncForm();
  try{
    if(!syncReady()) throw new Error('저장소는 사용자명/저장소이름 형식으로, 토큰과 함께 입력하세요');
    const r = await ghFetchFile();
    out.dataset.kind = 'ok';
    out.textContent = r.missing
      ? `연결됨 · ${sync.path}가 아직 없어요 (저장할 때 새로 만듭니다)`
      : `연결됨 · ${sync.path}를 읽었어요`;
  }catch(e){
    out.dataset.kind = 'err';
    out.textContent = '실패 · ' + (e.message || '');
  }finally{
    sync = JSON.parse(saved);   // 테스트는 확인만 — 실제 적용은 "저장"에서
    btn.disabled = false;
  }
}

function readSyncForm(){
  sync.token  = $('#s-token').value.trim();
  sync.repo   = $('#s-repo').value.trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/\/$/,'');
  sync.branch = $('#s-branch').value.trim() || 'master';
  sync.path   = $('#s-path').value.trim() || 'data.json';
}
function openSettings(){
  $('#s-email').value  = state.settings.email || '';
  $('#s-token').value  = sync.token || '';
  $('#s-repo').value   = sync.repo || '';
  $('#s-branch').value = sync.branch || 'master';
  $('#s-path').value   = sync.path || 'data.json';
  $('#s-cronkey').value = usageCfg.cronKey || '';
  $('#s-testResult').textContent = '';
  $('#s-usageState').textContent = '';
  $('#s-usageOut').replaceChildren();
  $('#settingsDlg').showModal();
}

/* ============================================================
   사용량 — 깃허브는 이 브라우저의 토큰으로 바로, Resend·Cloudflare는
   시크릿을 쥐고 있는 Worker의 /__usage를 통해 조회한다.
   외부 API 응답이 섞이므로 innerHTML 대신 노드로 만들어 붙인다.
   ============================================================ */
const USAGE_KEY = 'pslog.usage.v1';   // 관리 키 (기기별, 내보내기에 포함되지 않음)
let usageCfg = { cronKey: '' };

function loadUsageCfg(){
  try{
    const raw = localStorage.getItem(USAGE_KEY);
    if(raw) usageCfg = Object.assign(usageCfg, JSON.parse(raw));
  }catch(e){}
}
function saveUsageCfg(){ localStorage.setItem(USAGE_KEY, JSON.stringify(usageCfg)); }

const nfmt = n => Number(n || 0).toLocaleString('ko-KR');
const hhmm = d => d.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});

function usageRow(label, value, note, ratio, kind){
  const row = document.createElement('div');
  row.className = 'usage-row';
  row.dataset.kind = kind || 'ok';

  const head = document.createElement('div');
  head.className = 'usage-head';
  const l = document.createElement('span'); l.className = 'usage-label'; l.textContent = label;
  const v = document.createElement('span'); v.className = 'usage-value'; v.textContent = value;
  head.append(l, v);
  row.append(head);

  if(typeof ratio === 'number' && isFinite(ratio)){
    const bar = document.createElement('div'); bar.className = 'usage-bar';
    const fill = document.createElement('i');
    fill.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
    bar.append(fill); row.append(bar);
  }
  if(note){
    const n = document.createElement('p'); n.className = 'usage-note'; n.textContent = note;
    row.append(n);
  }
  return row;
}

async function githubUsageRow(){
  if(!syncReady()){
    return usageRow('깃허브 API', '토큰 미설정', '위에서 저장소와 토큰을 먼저 입력하세요', null, 'muted');
  }
  const res = await fetch('https://api.github.com/rate_limit', { headers: ghHeaders(), cache:'no-store' });
  if(!res.ok) return usageRow('깃허브 API', `조회 실패 · ${res.status}`, await ghError(res), null, 'err');
  const j = await res.json();
  const core = (j.resources && j.resources.core) || j.rate;
  if(!core) return usageRow('깃허브 API', '알 수 없는 응답', '', null, 'err');
  const used = core.limit - core.remaining;
  return usageRow('깃허브 API (시간당)',
    `${nfmt(core.remaining)} / ${nfmt(core.limit)} 남음`,
    `${hhmm(new Date(core.reset * 1000))}에 초기화 · 지금까지 ${nfmt(used)}회 사용`,
    core.limit ? used / core.limit : null,
    core.remaining < core.limit * 0.1 ? 'warn' : 'ok');
}

// 행 맨 아래에 바깥으로 나가는 링크를 붙인다
function usageLink(row, href, text){
  const a = document.createElement('a');
  a.className = 'usage-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  row.append(a);
  return row;
}

// Resend는 API로 조회하지 않는다. 발송용 키는 Sending access 권한이라 발송 외의
// 호출이 401로 막히고, 그걸 뚫으려고 Full access 키로 바꾸면 도메인·API 키까지
// 다룰 수 있는 키가 Worker에 놓인다. 발송량은 대시보드에서 보는 편이 낫다.
function resendUsageRow(){
  return usageLink(
    usageRow('Resend (발송량)', '대시보드에서 확인',
      '발송 전용(Sending access) 키는 API 조회가 막혀 있습니다. '
      + '키 권한을 넓히지 않고 대시보드에서 바로 보세요.', null, 'muted'),
    'https://resend.com/emails', 'Resend 대시보드 열기 →');
}

function cloudflareUsageRow(c){
  if(!c || !c.configured){
    return usageRow('Cloudflare', '미설정',
      'CF_API_TOKEN·CF_ACCOUNT_ID 시크릿을 넣으면 Worker 요청 수를 보여 줍니다', null, 'muted');
  }
  if(c.error) return usageRow('Cloudflare', '조회 실패', c.error, null, 'err');
  return usageRow(`Cloudflare Worker (최근 ${c.windowHours}시간)`,
    `${nfmt(c.requests)} / ${nfmt(c.dailyLimit)} 요청`,
    `오류 ${nfmt(c.errors)}건 · 하위 요청 ${nfmt(c.subrequests)}건`,
    c.dailyLimit ? c.requests / c.dailyLimit : null,
    c.requests > c.dailyLimit * 0.8 ? 'warn' : 'ok');
}

// Worker의 /__usage는 이 사이트와 같은 오리진이다 (정적 파일과 Worker가 한 배포)
async function workerUsageRows(){
  if(!usageCfg.cronKey){
    return [usageRow('Cloudflare', '관리 키 미입력',
      '위 관리 키(CRON_KEY)를 넣으면 Worker 요청 수를 조회합니다', null, 'muted')];
  }
  let res;
  try{
    res = await fetch('/__usage', {
      headers: { 'Authorization': `Bearer ${usageCfg.cronKey}` },
      cache: 'no-store',
    });
  }catch(e){
    return [usageRow('Worker', '연결 실패', '이 사이트가 Worker로 배포되어 있어야 합니다', null, 'err')];
  }
  if(res.status === 403) return [usageRow('Worker', '관리 키가 맞지 않습니다 (403)', '', null, 'err')];
  if(res.status === 404){
    return [usageRow('Worker', '/__usage 를 찾을 수 없습니다 (404)',
      '코드를 바꾼 뒤 npx wrangler deploy로 재배포했는지 확인하세요', null, 'err')];
  }
  if(!res.ok) return [usageRow('Worker', `조회 실패 · ${res.status}`, '', null, 'err')];
  const j = await res.json();
  return [cloudflareUsageRow(j.cloudflare)];
}

async function checkUsage(){
  const btn = $('#s-usage'), stateEl = $('#s-usageState'), out = $('#s-usageOut');
  btn.disabled = true;
  stateEl.dataset.kind = 'busy'; stateEl.textContent = '확인 중…';
  out.replaceChildren();

  // 저장 전에도 확인할 수 있도록 지금 입력창에 있는 값을 쓴다 (연결 테스트와 같은 방식)
  const saved = JSON.stringify(sync);
  readSyncForm();
  usageCfg.cronKey = $('#s-cronkey').value.trim();
  saveUsageCfg();
  try{
    const rows = [
      await githubUsageRow().catch(e => usageRow('깃허브 API', '조회 실패', e.message || '', null, 'err')),
      resendUsageRow(),
      ...await workerUsageRows(),
    ];
    out.replaceChildren(...rows);
    stateEl.dataset.kind = 'ok';
    stateEl.textContent = `${hhmm(new Date())} 기준`;
  }catch(e){
    stateEl.dataset.kind = 'err';
    stateEl.textContent = '실패 · ' + (e.message || '');
  }finally{
    sync = JSON.parse(saved);   // 확인만 — 실제 적용은 "저장"에서
    btn.disabled = false;
  }
}

/* 창을 닫기 전에 아직 못 올린 변경이 있으면 잡아둔다 */
window.addEventListener('beforeunload', e => {
  if(syncReady() && isDirty()){ e.preventDefault(); e.returnValue = ''; }
});

/* ---------- review logic ---------- */
// Build the review schedule for a problem based on first result.
function buildReviews(attemptDate){
  return REVIEW_OFFSETS.map(off => ({
    due: addDays(attemptDate, off),
    done: false,
    doneDate: null,
  }));
}

// classify a problem -> status used for verdict + filtering
function statusOf(p){
  if(p.firstResult === 'success') return 'solved';
  const reviews = p.reviews || [];
  if(reviews.length && reviews.every(r => r.done)) return 'mastered';
  const t = todayISO();
  const pending = reviews.filter(r => !r.done);
  if(pending.some(r => r.due < t)) return 'overdue';
  if(pending.some(r => r.due <= t)) return 'due';
  return 'review'; // scheduled but nothing due yet
}

// the next actionable review (due today or overdue), or null
function activeReview(p){
  if(p.firstResult !== 'fail') return null;
  const t = todayISO();
  const idx = (p.reviews||[]).findIndex(r => !r.done && r.due <= t);
  return idx === -1 ? null : {idx, review:p.reviews[idx]};
}
function dueProblems(){
  return state.problems
    .map(p => ({p, a:activeReview(p)}))
    .filter(x => x.a)
    .sort((x,y) => x.a.review.due.localeCompare(y.a.review.due));
}

/* ============================================================
   RENDER — problems
   ============================================================ */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let filter = 'all';
let searchTerm = '';

function verdictBadge(status){
  const map = {
    solved:['solved','AC'], mastered:['mastered','복습완료'],
    overdue:['overdue','복습 지남'], due:['review','복습 오늘'], review:['review','복습 예정'],
  };
  const [cls,label] = map[status] || ['review','—'];
  return `<span class="verdict ${cls}">${label}</span>`;
}

function trackHTML(p){
  if(p.firstResult !== 'fail' || !Array.isArray(p.reviews)) return '';
  const t = todayISO();
  const nodes = p.reviews.slice(0, REVIEW_OFFSETS.length).map((r,i)=>{
    let cls = 'track-dot', tip = `${REVIEW_OFFSETS[i]}일차 · ${fmtKDate(r.due)}`;
    if(r.done){ cls += ' done'; tip = `완료 (${fmtKDate(r.doneDate||r.due)})`; }
    else if(r.due < t){ cls += ' overdue'; tip = `기한 지남 · ${fmtKDate(r.due)}`; }
    else if(r.due <= t){ cls += ' due'; tip = `오늘 복습 · ${fmtKDate(r.due)}`; }
    const mark = r.done ? '✓' : REVIEW_OFFSETS[i];
    const line = i < p.reviews.length-1
      ? `<div class="track-line ${r.done?'filled':''}"></div>` : '';
    return `<div class="track-node">
        <div class="${cls}" data-review="${escapeAttr(p.id)}" data-review-idx="${i}" title="${escapeAttr(tip)}">${mark}</div>
        <span class="track-label">${REVIEW_OFFSETS[i]}일</span>
      </div>${line}`;
  }).join('');
  return `<div class="track" role="group" aria-label="복습 진행">${nodes}</div>`;
}

function problemCard(p){
  const status = statusOf(p);
  // 링크는 스킴을 검사한 뒤에만 <a>로 만든다. javascript: 등은 링크 없이 제목만 남긴다.
  const href = safeLink(p.link);
  const titleInner = href
    ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(p.title||'(제목 없음)')}</a>`
    : escapeHTML(p.title||'(제목 없음)');
  const meta = [
    p.site ? escapeHTML(p.site) : '',
    p.difficulty ? `<span class="p-tier">${escapeHTML(p.difficulty)}</span>` : '',
    p.attemptDate ? `시도 ${fmtKDate(p.attemptDate)}` : '',
  ].filter(Boolean).join('<span class="dot">·</span>');

  return `<article class="prob" data-id="${escapeAttr(p.id)}">
    <div class="prob-left">
      <div class="prob-top">
        ${verdictBadge(status)}
        <span class="p-num">${p.site==='백준'?'BOJ ':''}${escapeHTML(p.number||'—')}</span>
      </div>
      <div class="p-title">${titleInner}</div>
      <div class="p-meta">${meta}</div>
      ${p.note ? `<div class="p-note">“${escapeHTML(p.note)}”</div>` : ''}
    </div>
    <div class="prob-right">
      ${trackHTML(p)}
      <div class="prob-actions">
        <button class="icon-btn" data-edit="${escapeAttr(p.id)}">수정</button>
        <button class="icon-btn danger" data-del="${escapeAttr(p.id)}">삭제</button>
      </div>
    </div>
  </article>`;
}

function passesFilter(p){
  const status = statusOf(p);
  if(filter==='review' && !(status==='due'||status==='overdue'||status==='review')) return false;
  if(filter==='mastered' && status!=='mastered') return false;
  if(filter==='success' && p.firstResult!=='success') return false;
  if(searchTerm){
    const hay = `${p.number||''} ${p.title||''} ${p.site||''} ${p.difficulty||''}`.toLowerCase();
    if(!hay.includes(searchTerm)) return false;
  }
  return true;
}

function renderProblems(){
  // hero queue
  const due = dueProblems();
  $('#todayLabel').textContent = fmtKDate(todayISO());
  const queue = $('#reviewQueue');
  if(!due.length){
    queue.innerHTML = `<p class="rq-empty">오늘 복습할 문제가 없어요. 새 문제를 기록하거나 쉬어가세요. ✅</p>`;
    $('#btnMail').disabled = true;
  }else{
    $('#btnMail').disabled = false;
    queue.innerHTML = due.map(({p,a})=>{
      const stage = REVIEW_OFFSETS[a.idx];
      const overdue = a.review.due < todayISO();
      return `<div class="rq-item">
        <div class="rq-main">
          <div class="rq-line">
            <span class="rq-num">${escapeHTML(p.number||'—')}</span>
            <span class="rq-title">${escapeHTML(p.title||'(제목 없음)')}</span>
            <span class="stage-tag ${overdue?'overdue':''}">${stage}일차${overdue?' · 지남':''}</span>
          </div>
          <div class="rq-sub">${escapeHTML(p.site||'')}${p.difficulty?' · '+escapeHTML(p.difficulty):''} · 예정 ${fmtKDate(a.review.due)}</div>
        </div>
        <button class="btn small" data-done="${escapeAttr(p.id)}" data-done-idx="${a.idx}">복습 완료</button>
      </div>`;
    }).join('');
  }

  // list
  const list = state.problems
    .filter(passesFilter)
    .sort((a,b)=> (b.attemptDate||'').localeCompare(a.attemptDate||'') || (b.createdAt||'').localeCompare(a.createdAt||''));
  const el = $('#problemList');
  if(!state.problems.length){
    el.innerHTML = `<div class="empty">아직 기록이 없어요. 위의 <b>＋ 문제 기록 추가</b>로 첫 문제를 남겨보세요.</div>`;
  }else if(!list.length){
    el.innerHTML = `<div class="empty">이 조건에 맞는 문제가 없어요.</div>`;
  }else{
    el.innerHTML = list.map(problemCard).join('');
  }

  renderHeatmap();
}

/* ============================================================
   기록 잔디 — 하루에 무엇을 했는지 색으로 보여준다
     새 문제(그 날짜로 기록한 문제) 1~2개 → 연한 초록, 3개 이상 → 진한 초록
     복습 완료 1~2개 → 연한 하늘, 3개 이상 → 진한 하늘
     둘 다 있는 날은 두 색을 반반으로 나눠 칠한다
   ============================================================ */
const HM_DOW = ['일','월','화','수','목','금','토'];
let hmMonth = todayISO().slice(0,7);   // 화면에 보이는 달 'YYYY-MM'

// 날짜별 {solve, review} 집계
function dayStats(){
  const map = new Map();
  const bump = (iso, key) => {
    if(!iso) return;
    const e = map.get(iso) || {solve:0, review:0};
    e[key]++; map.set(iso, e);
  };
  for(const p of state.problems){
    bump(p.attemptDate, 'solve');
    for(const r of p.reviews || []){
      if(r.done && r.doneDate) bump(r.doneDate, 'review');
    }
  }
  return map;
}
const hmLevel = n => n >= 3 ? 2 : n >= 1 ? 1 : 0;

// 'YYYY-MM'을 n달 옮긴다
function shiftMonth(ym, n){
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
}

function renderHeatmap(){
  const grid = $('#hmGrid');
  if(!grid) return;
  const stats = dayStats();
  const today = todayISO();
  const [y, m] = hmMonth.split('-').map(Number);
  const lead = new Date(y, m - 1, 1).getDay();   // 1일이 무슨 요일인지
  const days = new Date(y, m, 0).getDate();      // 그 달의 마지막 날

  const cells = [];
  for(let i = 0; i < lead; i++) cells.push('<div class="hm-cell is-blank"></div>');

  let solveSum = 0, reviewSum = 0, activeDays = 0;
  for(let day = 1; day <= days; day++){
    const iso = `${hmMonth}-${String(day).padStart(2,'0')}`;
    if(iso > today){
      cells.push(`<div class="hm-cell is-future">${day}</div>`);
      continue;
    }
    const e = stats.get(iso) || {solve:0, review:0};
    solveSum += e.solve; reviewSum += e.review;
    if(e.solve || e.review) activeDays++;

    const s = hmLevel(e.solve), r = hmLevel(e.review);
    // 날짜 숫자는 칸 왼쪽 위에 놓인다. 반반 칸은 135도라 왼쪽 위가 초록(새 문제) 쪽이니,
    // 그 자리 색이 진하면 글씨를 흰색으로 바꾼다.
    const corner = e.solve ? s : r;

    const parts = [];
    if(e.solve) parts.push(`새 문제 ${e.solve}`);
    if(e.review) parts.push(`복습 ${e.review}`);
    const tip = `${fmtKDate(iso)} (${HM_DOW[(lead + day - 1) % 7]}) · ${parts.join(' · ') || '기록 없음'}`;

    cells.push(`<div class="hm-cell${iso === today ? ' is-today' : ''}${corner === 2 ? ' is-dark' : ''}"`
      + ` data-s="${s}" data-r="${r}" title="${escapeAttr(tip)}">${day}</div>`);
  }
  while(cells.length % 7) cells.push('<div class="hm-cell is-blank"></div>');

  grid.innerHTML = cells.join('');
  $('#hmMonthLabel').textContent = `${y}년 ${m}월`
    + (hmMonth === today.slice(0,7) ? ' · 이번 달' : '');
  $('#hmSummary').innerHTML = activeDays
    ? `<b>${activeDays}일</b> 기록 · 새 문제 <b>${solveSum}</b> · 복습 <b>${reviewSum}</b>`
    : '이 달은 아직 기록이 없어요';
}

/* ---------- problem actions ---------- */
function markReviewDone(id, idx){
  const p = state.problems.find(x=>x.id===id);
  if(!p || !Array.isArray(p.reviews) || !p.reviews[idx]) return;
  p.reviews[idx].done = true;
  p.reviews[idx].doneDate = todayISO();
  p.updatedAt = new Date().toISOString();
  save(); renderProblems();
  toast('복습 완료로 표시했어요');
}

function deleteProblem(id){
  const p = state.problems.find(x=>x.id===id);
  if(!p) return;
  if(!confirm(`"${p.title||p.number}" 기록을 삭제할까요?`)) return;
  state.problems = state.problems.filter(x=>x.id!==id);
  save(); renderProblems();
}

/* ---------- add / edit form ---------- */
let resultVal = 'success';

function openForm(edit){
  $('#probForm').hidden = false;
  $('#toggleForm').setAttribute('aria-expanded','true');
  if(!edit && !$('#f-date').value) $('#f-date').value = todayISO();
}
function resetForm(){
  ['f-number','f-title','f-link','f-difficulty','f-note'].forEach(id=>$('#'+id).value='');
  $('#f-site').selectedIndex = 0;
  $('#f-date').value = todayISO();
  $('#editId').value = '';
  setResult('success');
  $('#cancelEdit').hidden = true;
}
function setResult(v){
  resultVal = v;
  $$('#f-result .seg-btn').forEach(b=> b.classList.toggle('is-on', b.dataset.val===v));
}
function fillForm(p){
  $('#editId').value = p.id;
  $('#f-number').value = p.number||'';
  $('#f-title').value = p.title||'';
  $('#f-link').value = p.link||'';
  $('#f-site').value = ['백준','프로그래머스','LeetCode','SWEA'].includes(p.site)?p.site:'기타';
  $('#f-difficulty').value = p.difficulty||'';
  $('#f-date').value = p.attemptDate||todayISO();
  $('#f-note').value = p.note||'';
  setResult(p.firstResult||'success');
  $('#cancelEdit').hidden = false;
  openForm(true);
  $('.review-hero').scrollIntoView({behavior:'smooth',block:'start'});
}

function submitForm(e){
  e.preventDefault();
  const id = $('#editId').value;
  const attemptDate = $('#f-date').value || todayISO();
  const data = {
    number: $('#f-number').value.trim(),
    title: $('#f-title').value.trim(),
    link: $('#f-link').value.trim(),
    site: $('#f-site').value,
    difficulty: $('#f-difficulty').value.trim(),
    attemptDate,
    firstResult: resultVal,
    note: $('#f-note').value.trim(),
  };
  if(!data.number && !data.title){ toast('문제 번호나 제목 중 하나는 필요해요'); return; }

  if(id){
    const p = state.problems.find(x=>x.id===id);
    const wasFail = p.firstResult==='fail';
    Object.assign(p, data, {updatedAt:new Date().toISOString()});
    // manage review schedule on result / date change
    if(data.firstResult==='fail'){
      if(!wasFail || !p.reviews || !p.reviews.length){
        p.reviews = buildReviews(attemptDate);
      }else if(p._lastDate !== attemptDate){
        // keep done-state where possible but recompute due dates from new attempt date
        p.reviews = p.reviews.map((r,i)=>({due:addDays(attemptDate,REVIEW_OFFSETS[i]),done:r.done,doneDate:r.doneDate}));
      }
    }else{
      delete p.reviews;
    }
    p._lastDate = attemptDate;
    toast('수정했어요');
  }else{
    const p = {
      id: uid(), ...data,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      _lastDate: attemptDate,
    };
    if(data.firstResult==='fail') p.reviews = buildReviews(attemptDate);
    state.problems.push(p);
    toast(data.firstResult==='fail' ? '기록 완료 · 복습 일정을 잡았어요' : '기록 완료 🎉');
  }
  save(); resetForm();
  $('#probForm').hidden = true;
  $('#toggleForm').setAttribute('aria-expanded','false');
  renderProblems();
}

/* ---------- email (mailto) ---------- */
function sendReviewMail(){
  const due = dueProblems();
  if(!due.length) return;
  const email = state.settings.email || '';
  const subject = `[PS Log] ${fmtKDate(todayISO())} 복습할 문제 ${due.length}개`;
  const lines = due.map(({p,a},i)=>{
    const stage = REVIEW_OFFSETS[a.idx];
    return `${i+1}. [${p.site||''}] ${p.number||''} ${p.title||''} (${p.difficulty||'-'}) · ${stage}일차`
      + (p.link ? `\n   ${p.link}` : '');
  });
  const body = `오늘 복습할 문제입니다.\n\n${lines.join('\n')}\n\n— PS Log`;
  const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

/* ============================================================
   RENDER — concepts
   ============================================================ */
let activeConcept = null;
let saveTimer = null;

// 언어 탭의 선택 상태와 개수를 맞춘다 (개수는 검색어와 무관하게 그 언어의 전체 노트 수)
function renderLangTabs(){
  const counts = Object.fromEntries(LANG_IDS.map(id => [id, 0]));
  for(const c of state.concepts) if(counts[c.lang] !== undefined) counts[c.lang]++;
  $$('#langTabs .lang-tab').forEach(b => {
    const on = b.dataset.lang === activeLang;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
    b.querySelector('.lang-count').textContent = counts[b.dataset.lang] || '';
  });
}

function setLang(lang){
  if(!LANG_IDS.includes(lang) || lang === activeLang) return;
  activeLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  // 열어 둔 노트가 목록에서 걸러져 사라지면 편집창도 같이 닫는다
  const c = state.concepts.find(x => x.id === activeConcept);
  if(c && c.lang !== lang) closeConceptEditor();
  renderConceptList();
}

function closeConceptEditor(){
  activeConcept = null;
  $('#conceptEditor').hidden = true;
  $('#conceptEmpty').hidden = false;
}

function renderConceptList(){
  renderLangTabs();
  const term = $('#conceptSearch').value.trim().toLowerCase();
  const items = state.concepts
    .filter(c => c.lang === activeLang)
    .filter(c => !term || (c.title+' '+(c.tags||[]).join(' ')+' '+c.markdown).toLowerCase().includes(term))
    .sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));
  const el = $('#conceptList');
  if(!items.length){
    el.innerHTML = `<p class="empty" style="padding:20px 6px">`
      + (term ? '검색 결과가 없어요.' : `${LANG_LABEL[activeLang]} 노트가 없어요.`) + `</p>`;
    return;
  }
  el.innerHTML = items.map(c=>`
    <button class="concept-item ${c.id===activeConcept?'is-active':''}" data-concept="${escapeAttr(c.id)}">
      <b>${escapeHTML(c.title||'(제목 없음)')}</b>
      <span>${fmtKDate((c.updatedAt||'').slice(0,10))} 수정</span>
      ${(c.tags&&c.tags.length)?`<div class="ci-tags">${c.tags.map(t=>`<span class="ci-tag">${escapeHTML(t)}</span>`).join('')}</div>`:''}
    </button>`).join('');
}

function openConcept(id){
  const c = state.concepts.find(x=>x.id===id);
  if(!c) return;
  activeConcept = id;
  $('#conceptEmpty').hidden = true;
  $('#conceptEditor').hidden = false;
  $('#c-title').value = c.title||'';
  $('#c-lang').value = c.lang || DEFAULT_LANG;
  $('#c-tags').value = (c.tags||[]).join(', ');
  $('#c-body').value = c.markdown||'';
  renderPreview();
  renderConceptList();
  $('#c-saveState').textContent = '';
}

function newConcept(){
  // 지금 보고 있는 언어로 만든다
  const c = {id:uid(), title:'', lang:activeLang, tags:[], markdown:'', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()};
  state.concepts.push(c); save();
  openConcept(c.id);
  $('#c-title').focus();
}

function saveConcept(showToast){
  if(!activeConcept) return;
  const c = state.concepts.find(x=>x.id===activeConcept);
  if(!c) return;
  c.title = $('#c-title').value.trim();
  c.tags = $('#c-tags').value.split(',').map(s=>s.trim()).filter(Boolean);
  c.markdown = $('#c-body').value;
  c.updatedAt = new Date().toISOString();

  // 노트의 언어를 바꿨으면 목록도 그 언어로 따라가야 노트가 눈앞에서 사라지지 않는다
  const lang = $('#c-lang').value;
  if(LANG_IDS.includes(lang) && lang !== c.lang){
    c.lang = lang;
    activeLang = lang;
    localStorage.setItem(LANG_KEY, lang);
  }

  // 어디에서도 쓰지 않는 사진 정리는 "저장" 버튼을 눌렀을 때만 한다.
  // 자동저장에서 하면 사진을 잘라내 다른 노트로 옮기는 중에 사라질 수 있다.
  if(showToast) gcImages();

  save(); renderConceptList();
  $('#c-saveState').textContent = '저장됨 · ' + new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  if(showToast) toast('노트를 저장했어요');
}

function deleteConcept(){
  if(!activeConcept) return;
  const c = state.concepts.find(x=>x.id===activeConcept);
  if(!confirm(`"${c.title||'제목 없는 노트'}"를 삭제할까요?`)) return;
  state.concepts = state.concepts.filter(x=>x.id!==activeConcept);
  closeConceptEditor();
  gcImages();   // 지운 노트에만 붙어 있던 사진도 함께 버린다
  save();
  renderConceptList();
}

function renderPreview(){ $('#c-preview').innerHTML = mdToHTML($('#c-body').value); }

function insertImage(file){
  const reader = new FileReader();
  reader.onload = () => {
    // 사진 자체는 state.images에 두고, 본문에는 짧은 참조만 넣는다
    const id = uid();
    const name = (file.name || '이미지').replace(/\.[^.]+$/,'') || '이미지';
    state.images[id] = { name, data: reader.result };
    const ta = $('#c-body');
    const md = `\n![${name}](img:${id})\n`;
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0,pos) + md + ta.value.slice(pos);
    renderPreview(); scheduleSave();
    toast('사진을 넣었어요');
  };
  reader.readAsDataURL(file);
}

function scheduleSave(){
  clearTimeout(saveTimer);
  $('#c-saveState').textContent = '입력 중…';
  saveTimer = setTimeout(()=>saveConcept(false), 700);
}

/* ---------- minimal markdown ---------- */
function escapeHTML(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHTML(s).replace(/"/g,'&quot;'); }
// escapeHTML을 한 번 되돌린다. 마크다운은 본문 전체를 먼저 이스케이프하므로,
// 주소를 검사하려면 원래 문자열로 돌려놓아야 한다 (한 번만 훑어서 이중 복원은 없다).
function unescapeHTML(s){
  return String(s).replace(/&(?:amp|lt|gt|quot|#39);/g,
    m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[m]));
}

/* ---------- 주소 검사 ----------
   href에 javascript: 가 들어오면 클릭 한 번으로 이 오리진의 스크립트가 되고,
   localStorage에 있는 깃허브 토큰까지 그대로 넘어간다. 스킴을 좁혀서 막는다.
   브라우저와 같은 URL 파서를 쓰므로 "java\nscript:" 같은 우회도 함께 걸린다. */
const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];
function safeLink(u){
  if(typeof u !== 'string' || !u.trim()) return null;
  let p;
  try{ p = new URL(u.trim(), location.href); }catch(e){ return null; }
  return SAFE_LINK_SCHEMES.includes(p.protocol) ? p.href : null;
}
// 사진은 앱이 만든 data:image 와 http(s) 주소만 허용한다.
const SAFE_IMG_DATA = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]*$/i;
function safeImgSrc(u){
  if(typeof u !== 'string' || !u.trim()) return null;
  if(SAFE_IMG_DATA.test(u.trim())) return u.trim();
  let p;
  try{ p = new URL(u.trim(), location.href); }catch(e){ return null; }
  return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : null;
}

// 본문의 img:<id>를 실제 사진으로 바꿔 준다. 그 외 주소는 검사해서 통과한 것만 쓴다.
function resolveImgSrc(src){
  if(!src.startsWith('img:')){
    return safeImgSrc(src);
  }
  const img = state.images[src.slice(4)];
  return img ? safeImgSrc(img.data) : null;
}

function mdInline(s){
  // 여기 들어오는 s는 이미 escapeHTML을 거친 상태다. 주소만 원래대로 되돌려 검사하고,
  // 속성에 넣을 때 다시 한 번만 이스케이프한다 (예전에는 두 번 걸려 &가 깨졌다).
  // images first (may contain data: urls with parens-free base64)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m,alt,src)=>{
    const url = resolveImgSrc(unescapeHTML(src));
    if(url === null) return `<span class="md-img-missing">사진을 찾을 수 없어요</span>`;
    return `<img alt="${alt}" src="${escapeAttr(url)}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m,txt,href)=>{
    const url = safeLink(unescapeHTML(href));
    if(!url) return `${txt}<span class="md-link-blocked">허용되지 않은 링크</span>`;
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, (m,code)=>`<code>${code}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}
function mdToHTML(src){
  if(!src) return '<p style="color:var(--ink-faint)">미리보기가 여기에 표시됩니다.</p>';
  const lines = escapeHTML(src).split('\n');
  let out = [], i = 0;
  while(i < lines.length){
    let line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if(fence){
      let buf = []; i++;
      while(i < lines.length && !/^```\s*$/.test(lines[i])){ buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if(h){ out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); i++; continue; }
    // hr
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(line)){ out.push('<hr>'); i++; continue; }
    // blockquote (note: escapeHTML has already turned '>' into '&gt;')
    if(/^&gt;\s?/.test(line)){
      let buf=[];
      while(i<lines.length && /^&gt;\s?/.test(lines[i])){ buf.push(lines[i].replace(/^&gt;\s?/,'')); i++; }
      out.push(`<blockquote>${mdInline(buf.join(' '))}</blockquote>`);
      continue;
    }
    // unordered list
    if(/^\s*[-*+]\s+/.test(line)){
      let buf=[];
      while(i<lines.length && /^\s*[-*+]\s+/.test(lines[i])){ buf.push(`<li>${mdInline(lines[i].replace(/^\s*[-*+]\s+/,''))}</li>`); i++; }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }
    // ordered list
    if(/^\s*\d+\.\s+/.test(line)){
      let buf=[];
      while(i<lines.length && /^\s*\d+\.\s+/.test(lines[i])){ buf.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/,''))}</li>`); i++; }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }
    // blank
    if(/^\s*$/.test(line)){ i++; continue; }
    // paragraph (gather consecutive plain lines)
    let buf=[line];
    i++;
    while(i<lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3}\s|&gt;|\s*[-*+]\s|\s*\d+\.\s|```)/.test(lines[i]) && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])){
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${mdInline(buf.join('<br>'))}</p>`);
  }
  return out.join('\n');
}

/* ============================================================
   RENDER — 일정표 (주간 달력 + 날짜별 TODO)
   ============================================================ */
// 화면에 보이는 주의 일요일 (ISO)
let weekStart = startOfWeek(todayISO());

function startOfWeek(iso){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
  return isoOf(d);
}

function todosOn(iso){
  return state.todos
    .filter(t => t.date === iso)
    // 남은 일을 위로, 그 안에서는 만든 순서대로
    .sort((a,b) => (a.done === b.done)
      ? (a.createdAt||'').localeCompare(b.createdAt||'')
      : (a.done ? 1 : -1));
}

function addTodo(iso, text){
  text = text.trim();
  if(!text) return;
  const now = new Date().toISOString();
  state.todos.push({ id:uid(), date:iso, text, done:false, createdAt:now, updatedAt:now });
  save();
  renderSchedule(iso);   // 이어서 더 적을 수 있게 그 날짜 입력칸에 다시 포커스
}

function toggleTodo(id){
  const t = state.todos.find(x => x.id === id);
  if(!t) return;
  t.done = !t.done;
  t.updatedAt = new Date().toISOString();
  save(); renderSchedule();
}

function deleteTodo(id){
  const t = state.todos.find(x => x.id === id);
  if(!t) return;
  state.todos = state.todos.filter(x => x.id !== id);
  save(); renderSchedule();
}

function dayCell(iso, dow){
  const today = todayISO();
  const items = todosOn(iso);
  const left = items.filter(t => !t.done).length;
  const cls = [
    'day-cell',
    iso === today ? 'is-today' : (iso < today ? 'is-past' : ''),
    dow === 0 ? 'is-sun' : (dow === 6 ? 'is-sat' : ''),
  ].filter(Boolean).join(' ');

  const list = items.length
    ? items.map(t => `<div class="todo ${t.done ? 'is-done' : ''}" data-todo="${escapeAttr(t.id)}" role="button" tabindex="0"
          title="클릭하면 완료 표시가 바뀝니다">
        <span class="tick">✓</span>
        <span class="todo-text">${escapeHTML(t.text)}</span>
        <button class="todo-del" data-deltodo="${escapeAttr(t.id)}" title="삭제" aria-label="할 일 삭제">×</button>
      </div>`).join('')
    : `<p class="day-empty">할 일 없음</p>`;

  return `<section class="${cls}" data-date="${iso}">
    <div class="day-head">
      <span class="day-dow">${HM_DOW[dow]}</span>
      <span class="day-num">${+iso.slice(8)}</span>
      ${left ? `<span class="day-count">${left}개 남음</span>` : ''}
    </div>
    <div class="day-todos">${list}</div>
    <form class="todo-add" data-date="${iso}">
      <input type="text" placeholder="＋ 할 일" aria-label="${fmtKDate(iso)} 할 일 추가" />
    </form>
  </section>`;
}

function renderSchedule(focusDate){
  const grid = $('#weekGrid');
  if(!grid) return;
  const days = Array.from({length:7}, (_,i) => addDays(weekStart, i));
  grid.innerHTML = days.map((iso,i) => dayCell(iso, i)).join('');

  const end = days[6];
  const sameMonth = weekStart.slice(0,7) === end.slice(0,7);
  const thisWeek = weekStart === startOfWeek(todayISO());
  $('#weekTitle').textContent =
    `${fmtKDate(weekStart)} – ${sameMonth ? +end.slice(8) + '일' : fmtKDate(end)}`
    + (thisWeek ? ' · 이번 주' : '');

  if(focusDate){
    const input = grid.querySelector(`.todo-add[data-date="${focusDate}"] input`);
    if(input) input.focus();
  }
}

function shiftWeek(n){
  weekStart = addDays(weekStart, n * 7);
  renderSchedule();
}

/* ============================================================
   Import / Export (Git-friendly data.json)
   ============================================================ */
function exportJSON(){
  const blob = new Blob([serialize()], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(syncReady() ? 'data.json을 내려받았어요 (백업용)' : 'data.json을 내보냈어요 · 깃에 커밋하세요');
}
function importJSON(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      const merged = normalize(data);
      const count = merged.problems.length + merged.concepts.length + merged.todos.length;
      if(!confirm(`불러온 파일에 문제 ${merged.problems.length}개, 개념 ${merged.concepts.length}개, 할 일 ${merged.todos.length}개가 있어요.\n현재 데이터를 이 내용으로 교체할까요?`)) return;
      state = merged; save();
      closeConceptEditor();
      renderProblems(); renderConceptList(); renderSchedule();
      $('#s-email').value = state.settings.email||'';
      toast(`${count}개 항목을 불러왔어요`);
    }catch(e){ toast('JSON을 읽지 못했어요'); }
  };
  reader.readAsText(file);
}

/* ---------- toast ---------- */
let toastTimer=null;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.hidden = true; }, 2400);
}

/* ============================================================
   Wiring
   ============================================================ */
function switchView(name){
  $$('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===name));
  $('#view-problems').hidden = name!=='problems';
  $('#view-concepts').hidden = name!=='concepts';
  $('#view-schedule').hidden = name!=='schedule';
  document.body.dataset.view = name;   // 페이지마다 다른 최대 폭을 쓰기 위한 표시
  if(name==='concepts') renderConceptList();
  if(name==='schedule') renderSchedule();
}

function bind(){
  // tabs
  $$('.tab').forEach(t=> t.addEventListener('click', ()=>switchView(t.dataset.view)));

  // form toggle
  $('#toggleForm').addEventListener('click', ()=>{
    const f = $('#probForm');
    const show = f.hidden;
    f.hidden = !show;
    $('#toggleForm').setAttribute('aria-expanded', String(show));
    if(show && !$('#f-date').value) $('#f-date').value = todayISO();
  });
  $('#probForm').addEventListener('submit', submitForm);
  $('#cancelEdit').addEventListener('click', ()=>{ resetForm(); $('#probForm').hidden=true; $('#toggleForm').setAttribute('aria-expanded','false'); });
  $$('#f-result .seg-btn').forEach(b=> b.addEventListener('click', ()=>setResult(b.dataset.val)));

  // list interactions (event delegation)
  $('#problemList').addEventListener('click', e=>{
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    const rev = e.target.closest('[data-review]');
    if(del) deleteProblem(del.dataset.del);
    else if(edit){ const p = state.problems.find(x=>x.id===edit.dataset.edit); if(p) fillForm(p); }
    else if(rev) markReviewDone(rev.dataset.review, +rev.dataset.reviewIdx);
  });
  $('#reviewQueue').addEventListener('click', e=>{
    const done = e.target.closest('[data-done]');
    if(done) markReviewDone(done.dataset.done, +done.dataset.doneIdx);
  });

  // filters + search
  $$('#filterChips .chip').forEach(c=> c.addEventListener('click', ()=>{
    $$('#filterChips .chip').forEach(x=>x.classList.remove('is-active'));
    c.classList.add('is-active'); filter = c.dataset.filter; renderProblems();
  }));
  $('#search').addEventListener('input', e=>{ searchTerm = e.target.value.trim().toLowerCase(); renderProblems(); });

  // mail
  $('#btnMail').addEventListener('click', sendReviewMail);

  // import / export
  $('#btnExport').addEventListener('click', exportJSON);
  $('#btnImport').addEventListener('click', ()=>$('#fileImport').click());
  $('#fileImport').addEventListener('change', e=>{ if(e.target.files[0]) importJSON(e.target.files[0]); e.target.value=''; });

  // sync
  $('#btnSync').addEventListener('click', syncNow);

  // settings
  $('#btnSettings').addEventListener('click', openSettings);
  $('#s-test').addEventListener('click', testConnection);
  $('#s-usage').addEventListener('click', checkUsage);
  $('#settingsForm').addEventListener('submit', e=>{
    if(!(e.submitter && e.submitter.value==='save')) return;
    const email = $('#s-email').value.trim();
    const wasReady = syncReady();
    readSyncForm();
    saveSync();
    usageCfg.cronKey = $('#s-cronkey').value.trim();
    saveUsageCfg();

    if(syncReady() && !wasReady){
      // 이 기기에서 처음 연결 — 원격을 먼저 가져온 뒤에 이메일을 얹는다
      clearTimeout(pushTimer);
      toast('설정을 저장했어요 · 깃허브와 맞추는 중…');
      initialSync(state.problems.length > 0 || state.concepts.length > 0).then(()=>{
        if(email && state.settings.email !== email){ state.settings.email = email; save(); }
        $('#s-email').value = state.settings.email || '';
      });
      return;
    }

    state.settings.email = email;
    save();
    setSyncStatus(isDirty() ? 'dirty' : 'ok', isDirty() ? '저장 안 됨' : '동기화됨');
    toast('설정을 저장했어요');
  });

  // heatmap month nav
  $('#hmPrev').addEventListener('click', ()=>{ hmMonth = shiftMonth(hmMonth, -1); renderHeatmap(); });
  $('#hmNext').addEventListener('click', ()=>{ hmMonth = shiftMonth(hmMonth, 1); renderHeatmap(); });
  $('#hmToday').addEventListener('click', ()=>{ hmMonth = todayISO().slice(0,7); renderHeatmap(); });

  // schedule
  $('#weekPrev').addEventListener('click', ()=>shiftWeek(-1));
  $('#weekNext').addEventListener('click', ()=>shiftWeek(1));
  $('#weekToday').addEventListener('click', ()=>{ weekStart = startOfWeek(todayISO()); renderSchedule(); });
  $('#weekGrid').addEventListener('click', e=>{
    const del = e.target.closest('[data-deltodo]');
    if(del){ deleteTodo(del.dataset.deltodo); return; }
    const item = e.target.closest('[data-todo]');
    if(item) toggleTodo(item.dataset.todo);
  });
  // 키보드로도 완료 표시를 바꿀 수 있게
  $('#weekGrid').addEventListener('keydown', e=>{
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('[data-todo]');
    if(item){ e.preventDefault(); toggleTodo(item.dataset.todo); }
  });
  $('#weekGrid').addEventListener('submit', e=>{
    const form = e.target.closest('.todo-add');
    if(!form) return;
    e.preventDefault();
    addTodo(form.dataset.date, form.querySelector('input').value);
  });

  // concepts
  $('#langTabs').addEventListener('click', e=>{
    const b = e.target.closest('[data-lang]');
    if(b) setLang(b.dataset.lang);
  });
  $('#c-lang').addEventListener('change', ()=>{
    const lang = $('#c-lang').value;
    saveConcept(false);
    toast(`${LANG_LABEL[lang]} 노트로 옮겼어요`);
  });
  $('#newConcept').addEventListener('click', newConcept);
  $('#conceptSearch').addEventListener('input', renderConceptList);
  $('#conceptList').addEventListener('click', e=>{ const b=e.target.closest('[data-concept]'); if(b) openConcept(b.dataset.concept); });
  $('#c-body').addEventListener('input', ()=>{ renderPreview(); scheduleSave(); });
  $('#c-title').addEventListener('input', scheduleSave);
  $('#c-tags').addEventListener('input', scheduleSave);
  $('#c-save').addEventListener('click', ()=>saveConcept(true));
  $('#c-delete').addEventListener('click', deleteConcept);
  $('#c-image').addEventListener('click', ()=>$('#c-imageFile').click());
  $('#c-imageFile').addEventListener('change', e=>{ if(e.target.files[0]) insertImage(e.target.files[0]); e.target.value=''; });
  // paste image into textarea
  $('#c-body').addEventListener('paste', e=>{
    const item = Array.from(e.clipboardData?.items||[]).find(i=>i.type.startsWith('image/'));
    if(item){ e.preventDefault(); insertImage(item.getAsFile()); }
  });
}

/* ---------- boot ---------- */
async function boot(){
  bind();
  loadSync();
  loadUsageCfg();
  const hadLocal = load();
  $('#s-email').value = state.settings.email||'';
  document.body.dataset.view = 'problems';
  renderProblems();
  renderConceptList();
  renderSchedule();
  setSyncStatus(isDirty() ? 'dirty' : 'idle', isDirty() ? '저장 안 됨' : '대기');
  if(syncReady()) await initialSync(hadLocal);
}
boot();
