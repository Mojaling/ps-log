import { marked } from './vendor/marked.esm.js';
import createDOMPurify from './vendor/purify.es.mjs';
import { buildContentsCommit, contributionCommitMessage } from './sync-commit.js';
import { isTodoDateClosed, isTodoLocked, isTodoOverdue, millisecondsUntilNextTodoCutoff } from './todo-cutoff.js';
import { canPlaceFolder } from './folder-tree.js';
import {
  moveConceptOrder,
  moveFolderOrder,
  nextConceptOrder,
  nextFolderOrder,
  seedConceptOrders,
  seedFolderOrders,
  sortByOrder,
} from './concept-order.js';
import {
  compactLegacyFormatting,
  deleteLine,
  duplicateLine,
  indentSelection,
  insertBlankLineMark,
  insertTable,
  renderCompactFormatting,
  toggleHighlight,
  toggleSelection,
  toggleTextColor,
} from './editor-format.js';
import { createEditHistory, UNDO_LIMIT } from './editor-history.js';
import { highlightCodeBlocks } from './code-highlight.js';
import { nextTodoColor, normalizeTodoColor } from './todo-color.js';
import { MAX_TODO_TEMPLATES, missingTodoTemplatesForDate, normalizeTodoTemplates } from './todo-templates.js';
import { syncedScrollTop } from './scroll-sync.js';
import { createImageStore, imageFingerprint, imageMetadata, imagePayload, imageRecords, missingImageIds, referencedImageIds } from './image-store.js';
import { calculateStorageUsage, formatBytes, GITHUB_FILE_LIMIT_BYTES, RECOMMENDED_DATA_BYTES } from './storage-usage.js';
import { DEFAULT_CONCEPT_CATEGORIES, MAX_CONCEPT_CATEGORIES, normalizeConceptCategories } from './concept-categories.js';
import { collectConceptTags, conceptHasTag, normalizeConceptTags } from './concept-tags.js';
import { buildReviewSchedule, DEFAULT_REVIEW_OFFSETS, inferProblemReviewOffsets, normalizeReviewOffsets, parseReviewOffsets } from './review-schedule.js';
import { APP_VERSION } from './version.js';
import { initializeTeam, queueTeamActivity, reconcileTeamActivities, syncTeamProblem } from './team-client.js';
import { loadSessionSecret, saveSessionSecret } from './session-secrets.js';
import { MAX_SOLUTION_BYTES, normalizeSolutionLanguage, solutionByteLength } from './solution-code.js';

/* =========================================================
   PS Log — app logic
   Data lives in localStorage and syncs to data.json in a
   private GitHub repo via the Contents API.
   ========================================================= */

const STORE_KEY = 'pslog.data.v1';
const SYNC_KEY  = 'pslog.sync.v1';   // GitHub 연결 정보 (기기별, 내보내기에 포함되지 않음)
const SYNC_TOKEN_KEY = 'pslog.sync-token.session.v1'; // 탭 세션 종료 시 사라지는 GitHub 토큰
const DIRTY_KEY = 'pslog.dirty.v1';  // 아직 깃허브에 올리지 못한 변경이 있는지
const LANG_KEY  = 'pslog.lang.v1';   // 개념에서 마지막으로 보던 언어 (기기별 화면 상태)
const TREE_KEY  = 'pslog.tree.v1';   // 폴더 펼침 상태 (기기별 화면 상태)
const TAG_KEY   = 'pslog.concept-tag.v1'; // 마지막으로 선택한 개념 태그 (기기별 화면 상태)
const PREVIEW_ONLY_KEY = 'pslog.preview-only.v1'; // 개념 프리뷰 전용 모드 (기기별 화면 상태)
const CONTRIBUTION_KEY = 'pslog.contribution.v1'; // 아직 GitHub에 반영하지 못한 풀이·복습 이벤트
const CONTRAST_KEY = 'pslog.contrast.v1'; // 화면 대비 (기기별 화면 상태)
const DEFAULT_PROBLEM_SITES = [
  {id:'default-boj', name:'백준', url:'https://www.acmicpc.net/'},
  {id:'default-programmers', name:'프로그래머스', url:'https://school.programmers.co.kr/learn/challenges'},
  {id:'default-leetcode', name:'LeetCode', url:'https://leetcode.com/problemset/'},
  {id:'default-swea', name:'SWEA', url:'https://swexpertacademy.com/main/code/problem/problemList.do'},
];
const DOMPurify = createDOMPurify(window);
marked.setOptions({ gfm:true, breaks:true });

function normalizeContrast(value){ return value === 'high' ? 'high' : 'standard'; }
function applyContrast(value){
  const contrast = normalizeContrast(value);
  document.documentElement.dataset.contrast = contrast;
  localStorage.setItem(CONTRAST_KEY, contrast);
  return contrast;
}
applyContrast(localStorage.getItem(CONTRAST_KEY));

/* ---------- 개념 노트의 상위 카테고리 ---------- */
const DEFAULT_LANG = DEFAULT_CONCEPT_CATEGORIES[0].id;
let activeLang = localStorage.getItem(LANG_KEY) || DEFAULT_LANG;
let activeConceptTag = localStorage.getItem(TAG_KEY) || '';

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
let state = {
  version:2,
  settings:{
    email:'', editorTabSize:4,
    reviewOffsets:[...DEFAULT_REVIEW_OFFSETS],
    conceptCategories:DEFAULT_CONCEPT_CATEGORIES.map(item=>({...item})),
    defaultTodos:[],
    problemSites:DEFAULT_PROBLEM_SITES.map(s=>({...s})),
  },
  problems:[], concepts:[], conceptFolders:[], todos:[], images:{},
};

const imageStore = createImageStore();
const imageCache = new Map();
const imageObjectUrls = new Map();
const trustedImageObjectUrls = new Set();
let imageStoreReady = false;

function localStateSnapshot(){
  return Object.assign({}, state, {images:imageStoreReady ? imageMetadata(state.images) : state.images});
}

function cachedImage(id){
  const image = state.images[id];
  if(image && typeof image.data === 'string') return image;
  return imageCache.get(id) || image || null;
}

function syncedImages(images=state.images){
  return imagePayload(images, imageCache);
}

function revokeImageObjectUrl(id){
  const cached = imageObjectUrls.get(id);
  if(!cached) return;
  URL.revokeObjectURL(cached.url);
  trustedImageObjectUrls.delete(cached.url);
  imageObjectUrls.delete(id);
}

function clearImageObjectUrls(){
  [...imageObjectUrls.keys()].forEach(revokeImageObjectUrl);
}

function dataUrlBlob(data){
  const comma = data.indexOf(',');
  if(comma < 0 || !/;base64$/i.test(data.slice(0, comma))) return null;
  const mime = data.slice(5, comma).replace(/;base64$/i, '');
  const binary = atob(data.slice(comma + 1).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for(let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type:mime});
}

function previewImageSource(id){
  const image = cachedImage(id);
  if(!image || typeof image.data !== 'string') return null;
  if(!image.data.startsWith('data:')) return safeImgSrc(image.data);
  const cached = imageObjectUrls.get(id);
  if(cached && cached.data === image.data) return cached.url;
  revokeImageObjectUrl(id);
  try{
    const blob = dataUrlBlob(image.data);
    if(!blob) return null;
    const url = URL.createObjectURL(blob);
    imageObjectUrls.set(id, {data:image.data, url});
    trustedImageObjectUrls.add(url);
    return url;
  }catch(error){
    console.warn('이미지 미리보기 주소를 만들지 못했습니다.', error);
    return null;
  }
}

function retainImageObjectUrls(markdown){
  const used = referencedImageIds(markdown);
  [...imageObjectUrls.keys()].forEach(id=>{ if(!used.has(id)) revokeImageObjectUrl(id); });
}

async function initializeImageStorage(){
  try{
    const stored = await imageStore.getAll();
    imageCache.clear();
    stored.forEach(image=>imageCache.set(image.id, image));

    // 이전 버전의 localStorage에 들어 있던 Base64 이미지를 먼저 IndexedDB에 복사한다.
    // 쓰기가 완료된 뒤에만 localStorage에서 원본을 제거해 마이그레이션 도중 유실을 막는다.
    const legacy = imageRecords(state.images);
    if(legacy.length){
      await imageStore.putMany(legacy);
      legacy.forEach(image=>imageCache.set(image.id, image));
    }
    state.images = imageMetadata(state.images);
    imageStoreReady = true;
    localStorage.setItem(STORE_KEY, JSON.stringify(localStateSnapshot()));
  }catch(error){
    imageRecords(state.images).forEach(image=>imageCache.set(image.id, image));
    console.warn('IndexedDB 이미지 저장소를 준비하지 못했습니다.', error);
    toast('이미지 저장소를 준비하지 못했어요 · 브라우저 설정을 확인해 주세요');
  }
}

async function replaceStoredImages(data){
  if(!imageStoreReady) return;
  const records = imageRecords(data.images);
  if(records.length !== Object.keys(data.images).length){
    throw new Error('깃허브 데이터에서 일부 이미지 원본을 찾을 수 없습니다');
  }
  await imageStore.replaceAll(records);
  clearImageObjectUrls();
  imageCache.clear();
  records.forEach(image=>imageCache.set(image.id, image));
  data.images = imageMetadata(data.images);
}

function save(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(localStateSnapshot()));
  }catch(e){
    toast('브라우저 저장 공간이 부족해요 · 큰 이미지를 줄이거나 삭제해 주세요');
  }
  if(applyingRemote) return;   // 원격 내용을 반영하는 중이면 되돌려 올리지 않는다
  setDirty(true);
  schedulePush();
}

function load(){
  const raw = localStorage.getItem(STORE_KEY);
  if(raw){
    try{
      const parsed = JSON.parse(raw);
      const hadLegacyEmail = Object.prototype.hasOwnProperty.call(parsed?.settings || {}, 'email');
      state = normalize(parsed);
      if(hadLegacyEmail) localStorage.setItem(STORE_KEY, JSON.stringify(localStateSnapshot()));
      return true;
    }catch(e){}
  }
  return false;
}
// data.json은 다른 기기·불러오기·저장소에서 그대로 들어온다. 모양이 어긋난 항목 하나가
// 렌더 도중 예외를 던지면 화면 전체가 비므로, 여기서 한 번 형태를 맞춰 둔다.
// 멀쩡한 데이터에는 손대지 않는다 (건드리면 fingerprint가 달라져 매번 다시 커밋된다).
const asStr = (v, fb='') => typeof v === 'string' ? v : fb;
const normalizeEditorTabSize = value => {
  const size = Math.trunc(Number(value));
  return size >= 1 && size <= 8 ? size : 4;
};

function normalizeProblem(p, defaultReviewOffsets=DEFAULT_REVIEW_OFFSETS){
  const out = Object.assign({}, p);
  out.id = asStr(out.id) || uid();
  out.number = asStr(out.number);
  out.title = asStr(out.title);
  out.link = asStr(out.link);
  out.site = asStr(out.site);
  out.difficulty = asStr(out.difficulty);
  out.attemptDate = asStr(out.attemptDate);
  out.firstResult = out.firstResult === 'fail' ? 'fail' : 'success';
  out.note = asStr(out.note);
  out.solutionCode = asStr(out.solutionCode);
  out.solutionLanguage = out.solutionCode
    ? (normalizeSolutionLanguage(out.solutionLanguage) || 'cpp')
    : '';
  out.createdAt = asStr(out.createdAt);
  out.updatedAt = asStr(out.updatedAt);
  if(out.firstResult === 'fail'){
    const rawReviews = Array.isArray(out.reviews) ? out.reviews.filter(r=>r && typeof r==='object') : [];
    const offsets = rawReviews.length
      ? inferProblemReviewOffsets(out, daysBetween)
      : normalizeReviewOffsets(out.reviewOffsets, defaultReviewOffsets);
    out.reviewOffsets = offsets;
    // trackHTML·markReviewDone이 reviews를 인덱스로 훑는다
    out.reviews = rawReviews
      .slice(0, offsets.length)
      .map((r, index) => ({
        offset: offsets[index],
        due: asStr(r.due),
        done: !!r.done,
        doneDate: typeof r.doneDate === 'string' ? r.doneDate : null,
      }));
    if(!out.reviews.length && out.attemptDate) out.reviews = buildReviewSchedule(out.attemptDate, offsets, addDays);
  }else{
    delete out.reviewOffsets;
    delete out.reviews;
  }
  return out;
}

function normalizeConcept(c, categoryIds=[DEFAULT_LANG], fallbackCategory=DEFAULT_LANG){
  const out = Object.assign({}, c);
  out.id = asStr(out.id) || uid();
  out.title = asStr(out.title);
  out.markdown = compactLegacyFormatting(asStr(out.markdown));
  out.tags = normalizeConceptTags(out.tags);
  out.folderId = asStr(out.folderId) || null;
  out.order = out.order !== null && out.order !== '' && Number.isFinite(Number(out.order)) ? Number(out.order) : null;
  out.createdAt = asStr(out.createdAt);
  out.updatedAt = asStr(out.updatedAt);
  // 카테고리가 없던 예전 노트는 첫 카테고리로 본다
  if(!categoryIds.includes(out.lang)) out.lang = fallbackCategory;
  return out;
}

function normalizeConceptFolder(f, categoryIds=[DEFAULT_LANG], fallbackCategory=DEFAULT_LANG){
  const out = Object.assign({}, f);
  out.id = asStr(out.id) || uid();
  out.name = asStr(out.name, '새 폴더').trim() || '새 폴더';
  if(!categoryIds.includes(out.lang)) out.lang = fallbackCategory;
  out.parentId = asStr(out.parentId) || null;
  out.order = out.order !== null && out.order !== '' && Number.isFinite(Number(out.order)) ? Number(out.order) : null;
  out.createdAt = asStr(out.createdAt);
  out.updatedAt = asStr(out.updatedAt);
  return out;
}

function normalizeProblemSites(settings){
  if(!Array.isArray(settings && settings.problemSites)){
    return DEFAULT_PROBLEM_SITES.map(s=>({...s}));
  }
  return settings.problemSites
    .filter(s => s && typeof s === 'object')
    .map(s => ({id:asStr(s.id)||uid(), name:asStr(s.name).trim(), url:asStr(s.url).trim()}))
    .filter(s => s.name && safeHttpUrl(s.url));
}

function normalizeTodo(t){
  const out = Object.assign({}, t);
  out.id = asStr(out.id) || uid();
  out.date = asStr(out.date);
  out.text = asStr(out.text);
  out.done = !!out.done;
  out.color = normalizeTodoColor(out.color);
  out.templateId = asStr(out.templateId) || null;
  out.createdAt = asStr(out.createdAt);
  out.updatedAt = asStr(out.updatedAt);
  return out;
}

function normalize(d){
  d = d || {};
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const conceptCategories = normalizeConceptCategories(d.settings && d.settings.conceptCategories);
  const categoryIds = conceptCategories.map(item=>item.id);
  const fallbackCategory = categoryIds[0];
  const reviewOffsets = normalizeReviewOffsets(d.settings && d.settings.reviewOffsets);
  const images = {};
  if(isObj(d.images)){
    for(const [id, img] of Object.entries(d.images)){
      if(!isObj(img)) continue;
      images[id] = {name:asStr(img.name, '이미지')};
      if(typeof img.data === 'string') images[id].data = img.data;
    }
  }
  const out = {
    version: 2,
    settings: {
      editorTabSize: normalizeEditorTabSize(d.settings && d.settings.editorTabSize),
      reviewOffsets,
      conceptCategories,
      defaultTodos: normalizeTodoTemplates(d.settings && d.settings.defaultTodos),
      problemSites: normalizeProblemSites(d.settings),
    },
    problems: (Array.isArray(d.problems) ? d.problems : []).filter(isObj).map(problem=>normalizeProblem(problem, reviewOffsets)),
    concepts: (Array.isArray(d.concepts) ? d.concepts : []).filter(isObj).map(concept=>normalizeConcept(concept, categoryIds, fallbackCategory)),
    conceptFolders: (Array.isArray(d.conceptFolders) ? d.conceptFolders : []).filter(isObj).map(folder=>normalizeConceptFolder(folder, categoryIds, fallbackCategory)),
    // todos · images는 나중에 추가된 필드 — 예전 data.json에는 없으므로 비워서 채운다
    todos: (Array.isArray(d.todos) ? d.todos : []).filter(isObj).map(normalizeTodo),
    images,
  };
  const folderIds = new Set(out.conceptFolders.map(f=>f.id));
  for(const f of out.conceptFolders){
    if(f.parentId === f.id || !folderIds.has(f.parentId)) f.parentId = null;
  }
  // 손상된 데이터에 A→B→A 같은 순환 폴더가 있어도 트리 렌더링이 멈추지 않게 끊는다.
  for(const f of out.conceptFolders){
    const seen = new Set([f.id]);
    let parentId = f.parentId;
    while(parentId){
      if(seen.has(parentId)){ f.parentId = null; break; }
      seen.add(parentId);
      parentId = out.conceptFolders.find(x=>x.id===parentId)?.parentId || null;
    }
  }
  for(const c of out.concepts){
    const folder = out.conceptFolders.find(f=>f.id===c.folderId);
    if(!folder || folder.lang !== c.lang) c.folderId = null;
  }
  seedConceptOrders(out.concepts);
  seedFolderOrders(out.conceptFolders);
  extractInlineImages(out);
  if(!categoryIds.includes(activeLang)) activeLang = fallbackCategory;
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
    for(const id of referencedImageIds(c.markdown)) used.add(id);
  }
  const removed = [];
  for(const id of Object.keys(state.images)){
    if(used.has(id)) continue;
    delete state.images[id];
    imageCache.delete(id);
    revokeImageObjectUrl(id);
    removed.push(id);
  }
  if(imageStoreReady && removed.length){
    imageStore.deleteMany(removed).catch(error=>console.warn('사용하지 않는 이미지를 정리하지 못했습니다.', error));
  }
}

/* ============================================================
   GitHub 동기화
   비공개 저장소의 data.json을 Contents API로 읽고 커밋한다.
   토큰은 sessionStorage에만 저장되어 탭 세션이 끝나면 사라진다.
   ============================================================ */
let sync = { token:'', repo:'', branch:'master', path:'data.json' };
let remoteSha = null;        // 마지막으로 확인한 원격 파일의 blob sha
let applyingRemote = false;  // 원격 → 로컬 반영 중 (자동 업로드 억제)
let initializing = false;    // 첫 동기화 진행 중 (로컬을 먼저 올려버리지 않도록)
let pushTimer = null;
let pushInFlight = null;

function loadSync(){
  try{
    const loaded = loadSessionSecret(localStorage, sessionStorage, {
      persistentKey:SYNC_KEY, sessionKey:SYNC_TOKEN_KEY, secretField:'token',
    });
    sync = Object.assign(sync, loaded.config, {token:loaded.secret});
  }catch(e){}
  sync.branch = sync.branch || 'master';
  sync.path = sync.path || 'data.json';
}
function saveSync(){
  saveSessionSecret(localStorage, sessionStorage, {
    persistentKey:SYNC_KEY,
    sessionKey:SYNC_TOKEN_KEY,
    secretField:'token',
    config:{repo:sync.repo, branch:sync.branch, path:sync.path},
    secret:sync.token,
  });
}
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

async function ghPutFile(text, message, sha, contribution=false){
  const url = `https://api.github.com/repos/${sync.repo}/contents/${encodeURI(sync.path)}`;
  const body = buildContentsCommit({
    message,
    content:b64encode(text),
    branch:sync.branch,
    sha,
    contribution,
  });
  const res = await fetch(url, { method:'PUT', headers:ghHeaders(), body:JSON.stringify(body) });
  if(res.status === 409 || res.status === 422){ const e = new Error('conflict'); e.conflict = true; throw e; }
  if(!res.ok) throw new Error(await ghError(res));
  const j = await res.json();
  return j.content && j.content.sha;
}

/* ---------- 직렬화 ---------- */
function snapshot(){
  const images = syncedImages();
  const missing = missingImageIds(state.images, imageCache);
  if(missing.length){
    throw new Error(`이미지 원본 ${missing.length}개를 찾을 수 없어 동기화를 중단했습니다`);
  }
  return {
    version:2,
    exportedAt:new Date().toISOString(),
    settings:state.settings,
    problems:state.problems.map(({_lastDate,...p})=>p),
    concepts:state.concepts,
    conceptFolders:state.conceptFolders,
    todos:state.todos,
    images,
  };
}
function serialize(){ return JSON.stringify(snapshot(), null, 2) + '\n'; }
// 비교용: 시각처럼 매번 달라지는 값은 뺀다
function fingerprint(d){
  return JSON.stringify({
    settings:d.settings,
    problems:(d.problems||[]).map(({_lastDate,...p})=>p),
    concepts:d.concepts,
    conceptFolders:d.conceptFolders||[],
    todos:d.todos||[],
    images:imageFingerprint(d.images||{}, imageCache),
  });
}

async function applyRemote(data){
  clearTimeout(pushTimer);   // 방금 버린 로컬 내용을 되올리지 않는다
  applyingRemote = true;
  try{
    const next = normalize(data);
    await replaceStoredImages(next);
    state = next;
    save();
  }finally{
    applyingRemote = false;
  }
  setDirty(false);
  closeConceptEditor();
  renderProblems(); renderConceptList(); renderSchedule();
}

function loadContributionEvents(){
  try{
    const events = JSON.parse(localStorage.getItem(CONTRIBUTION_KEY) || '[]');
    return Array.isArray(events)
      ? events.filter(event=>event && typeof event.id==='string' && ['solve','review'].includes(event.kind)).slice(-50)
      : [];
  }catch(e){ return []; }
}

function queueContribution(kind, problem, stage){
  const events = loadContributionEvents();
  events.push({
    id:uid(),
    kind,
    site:problem.site||'',
    number:problem.number||'',
    title:problem.title||'',
    stage:stage||null,
    createdAt:new Date().toISOString(),
  });
  localStorage.setItem(CONTRIBUTION_KEY, JSON.stringify(events.slice(-50)));
}

function settleContributionEvents(ids){
  if(!ids.length) return;
  const completed = new Set(ids);
  const remaining = loadContributionEvents().filter(event=>!completed.has(event.id));
  if(remaining.length) localStorage.setItem(CONTRIBUTION_KEY, JSON.stringify(remaining));
  else localStorage.removeItem(CONTRIBUTION_KEY);
}

/* ---------- pull / push ---------- */
async function pullRemote(){
  const f = await ghFetchFile();
  if(f.missing){ remoteSha = null; return { missing:true }; }
  remoteSha = f.sha;
  const raw = JSON.parse(f.text);
  const hadLegacyEmail = Object.prototype.hasOwnProperty.call(raw?.settings || {}, 'email');
  return { data: normalize(raw), hadLegacyEmail };
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
    let contributionEvents = loadContributionEvents();
    let contributionIds = contributionEvents.map(event=>event.id);
    let isContribution = contributionEvents.length > 0;
    let msg = isContribution
      ? contributionCommitMessage(contributionEvents)
      : `PS Log 기록 업데이트 (${new Date().toLocaleString('ko-KR')})`;
    let pushedFingerprint = fingerprint(state);
    let payload = serialize();
    try{
      remoteSha = await ghPutFile(payload, msg, remoteSha, isContribution);
    }catch(e){
      if(!e.conflict) throw e;
      // 다른 기기에서 먼저 저장한 경우
      const r = await pullRemote();
      if(!r.missing && fingerprint(r.data) === fingerprint(state)){
        settleContributionEvents(contributionIds);
        setDirty(false); setSyncStatus('ok', '이미 최신');
        return true;
      }
      const overwrite = confirm(
        '깃허브에 다른 기기에서 저장한 변경이 있어요.\n\n' +
        '확인 = 이 기기 내용으로 덮어쓰기\n' +
        '취소 = 깃허브 내용을 가져오고 이 기기 변경은 버리기');
      if(!overwrite){
        if(!r.missing) await applyRemote(r.data);
        settleContributionEvents(contributionIds);
        setSyncStatus('ok', '깃허브 내용으로 맞춤');
        return true;
      }
      contributionEvents = loadContributionEvents();
      contributionIds = contributionEvents.map(event=>event.id);
      isContribution = contributionEvents.length > 0;
      msg = isContribution
        ? contributionCommitMessage(contributionEvents)
        : `PS Log 기록 업데이트 (${new Date().toLocaleString('ko-KR')})`;
      pushedFingerprint = fingerprint(state);
      payload = serialize();
      remoteSha = await ghPutFile(payload, msg + ' (덮어씀)', remoteSha, isContribution);
    }
    settleContributionEvents(contributionIds);
    if(fingerprint(state)===pushedFingerprint){
      setDirty(false);
      setSyncStatus('ok', '동기화됨');
    }else{
      setDirty(true);
      schedulePush();
      setSyncStatus('dirty', '저장 대기 중');
    }
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
      if(r.hadLegacyEmail){
        setDirty(true);
        await pushNow(true);
        toast('이메일 정보를 제거해 안전하게 다시 저장했어요');
        return;
      }
      setSyncStatus('ok', '이미 최신'); toast('이미 최신 상태예요'); return;
    }
    await applyRemote(r.data);
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
      localStorage.removeItem(CONTRIBUTION_KEY);
    }
    if(differs) await applyRemote(r.data);
    if(r.hadLegacyEmail){
      setDirty(true);
      await pushNow(true);
      return;
    }
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
  const token = $('#s-token').value.trim();
  if(token) sync.token = token;
  sync.repo   = $('#s-repo').value.trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/\/$/,'');
  sync.branch = $('#s-branch').value.trim() || 'master';
  sync.path   = $('#s-path').value.trim() || 'data.json';
}
function openSettings(){
  $('#s-contrast').value = normalizeContrast(localStorage.getItem(CONTRAST_KEY));
  $('#s-tab-size').value = normalizeEditorTabSize(state.settings.editorTabSize);
  $('#s-review-offsets').value = state.settings.reviewOffsets.join(', ');
  $('#s-token').value  = '';
  $('#s-token').placeholder = sync.token ? '현재 탭에 토큰이 연결되어 있습니다' : 'github_pat_...';
  $('#s-repo').value   = sync.repo || '';
  $('#s-branch').value = sync.branch || 'master';
  $('#s-path').value   = sync.path || 'data.json';
  $('#s-cronkey').value = '';
  $('#s-cronkey').placeholder = usageCfg.cronKey ? '현재 탭에 관리 키가 연결되어 있습니다' : '비워 두면 깃허브만 확인';
  $('#s-testResult').textContent = '';
  $('#s-usageState').textContent = '';
  $('#s-usageOut').replaceChildren();
  $('#settingsDlg').showModal();
  showLocalStorageUsage();
}

/* ============================================================
   사용량 — 깃허브는 이 브라우저의 토큰으로 바로, Resend·Cloudflare는
   시크릿을 쥐고 있는 Worker의 /__usage를 통해 조회한다.
   외부 API 응답이 섞이므로 innerHTML 대신 노드로 만들어 붙인다.
   ============================================================ */
const USAGE_KEY = 'pslog.usage.v1';   // 관리 키 (기기별, 내보내기에 포함되지 않음)
const USAGE_CRON_KEY = 'pslog.cron-key.session.v1';
let usageCfg = { cronKey: '' };
let usageRenderToken = 0;

function loadUsageCfg(){
  try{
    const loaded = loadSessionSecret(localStorage, sessionStorage, {
      persistentKey:USAGE_KEY, sessionKey:USAGE_CRON_KEY, secretField:'cronKey',
    });
    usageCfg = Object.assign(usageCfg, loaded.config, {cronKey:loaded.secret});
  }catch(e){}
}
function saveUsageCfg(){
  saveSessionSecret(localStorage, sessionStorage, {
    persistentKey:USAGE_KEY, sessionKey:USAGE_CRON_KEY, secretField:'cronKey',
    config:{}, secret:usageCfg.cronKey,
  });
}

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

function storageKind(bytes, recommended = RECOMMENDED_DATA_BYTES){
  if(bytes > recommended) return 'err';
  if(bytes > recommended * 0.8) return 'warn';
  return 'ok';
}

async function localStorageUsageRows(){
  const ids = Object.keys(state.images || {});
  const imageDataUrls = ids.map(id=>cachedImage(id)?.data).filter(value=>typeof value === 'string' && value);
  let serialized = '';
  let serializationError = '';
  try{ serialized = serialize(); }
  catch(error){ serializationError = error?.message || 'data.json을 계산하지 못했습니다'; }
  const metrics = calculateStorageUsage(serialized, imageDataUrls, ids.length);
  const rows = [];

  rows.push(usageRow('사진 원본', `${nfmt(metrics.totalImageCount)}장 · ${formatBytes(metrics.imageOriginalBytes)}`,
    `data.json 안의 Base64 사진 데이터 ${formatBytes(metrics.imageEmbeddedBytes)}`
      + (metrics.missingImages ? ` · 원본 누락 ${nfmt(metrics.missingImages)}장` : ''),
    metrics.imageEmbeddedBytes / RECOMMENDED_DATA_BYTES,
    metrics.missingImages ? 'err' : storageKind(metrics.imageEmbeddedBytes)));

  if(serializationError){
    rows.push(usageRow('data.json 현재 예상', '계산 실패', serializationError, null, 'err'));
  }else{
    rows.push(usageRow('data.json 현재 예상', `${formatBytes(metrics.dataJsonBytes)} / 권장 20 MB`,
      `문제·노트·일정·모든 사진 포함 · GitHub 파일 지원 상한 ${formatBytes(GITHUB_FILE_LIMIT_BYTES)}`,
      metrics.dataJsonBytes / RECOMMENDED_DATA_BYTES, storageKind(metrics.dataJsonBytes)));
    rows.push(usageRow('다음 GitHub 업로드 요청', formatBytes(metrics.githubRequestBytes),
      'data.json 전체를 REST API 전송용 Base64로 다시 인코딩한 예상 크기',
      metrics.githubRequestBytes / (RECOMMENDED_DATA_BYTES * 4 / 3),
      storageKind(metrics.dataJsonBytes)));
  }

  if(navigator.storage?.estimate){
    try{
      const estimate = await navigator.storage.estimate();
      const used = Number(estimate.usage || 0);
      const quota = Number(estimate.quota || 0);
      rows.push(usageRow('이 사이트의 브라우저 저장공간',
        quota ? `${formatBytes(used)} / ${formatBytes(quota)}` : formatBytes(used),
        'IndexedDB 이미지뿐 아니라 이 사이트의 캐시 등 전체 사용량을 포함한 브라우저 추정치',
        quota ? used / quota : null, quota && used > quota * 0.8 ? 'warn' : 'ok'));
    }catch(_){ /* 저장공간 추정 미지원은 핵심 계산에 영향을 주지 않는다. */ }
  }
  return rows;
}

async function showLocalStorageUsage(){
  const token = ++usageRenderToken;
  const out = $('#s-usageOut');
  try{
    const rows = await localStorageUsageRows();
    if(token === usageRenderToken && $('#settingsDlg').open) out.replaceChildren(...rows);
  }catch(error){
    if(token === usageRenderToken) out.replaceChildren(
      usageRow('로컬 저장 용량', '계산 실패', error?.message || '', null, 'err'));
  }
}

async function githubDataSizeRow(){
  if(!syncReady()){
    return usageRow('GitHub 저장 data.json', '토큰 미설정', '위에서 저장소와 토큰을 먼저 입력하세요', null, 'muted');
  }
  const url = `https://api.github.com/repos/${sync.repo}/contents/${encodeURI(sync.path)}`
            + `?ref=${encodeURIComponent(sync.branch)}&t=${Date.now()}`;
  const res = await fetch(url, {headers:ghHeaders(), cache:'no-store'});
  if(res.status === 404) return usageRow('GitHub 저장 data.json', '아직 없음', '첫 동기화 때 생성됩니다', null, 'muted');
  if(!res.ok) return usageRow('GitHub 저장 data.json', `조회 실패 · ${res.status}`, await ghError(res), null, 'err');
  const data = await res.json();
  const bytes = Math.max(0, Number(data.size) || 0);
  return usageRow('GitHub 저장 data.json', formatBytes(bytes), `${sync.branch}/${sync.path}에 저장된 현재 원격 파일`,
    bytes / RECOMMENDED_DATA_BYTES, storageKind(bytes));
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
  const renderToken = ++usageRenderToken;
  btn.disabled = true;
  stateEl.dataset.kind = 'busy'; stateEl.textContent = '확인 중…';
  out.replaceChildren();

  // 저장 전에도 확인할 수 있도록 지금 입력창에 있는 값을 쓴다 (연결 테스트와 같은 방식)
  const saved = JSON.stringify(sync);
  readSyncForm();
  usageCfg.cronKey = $('#s-cronkey').value.trim() || usageCfg.cronKey;
  saveUsageCfg();
  try{
    const [localRows, remoteDataRow, githubRow, workerRows] = await Promise.all([
      localStorageUsageRows(),
      githubDataSizeRow().catch(e=>usageRow('GitHub 저장 data.json', '조회 실패', e.message || '', null, 'err')),
      githubUsageRow().catch(e => usageRow('깃허브 API', '조회 실패', e.message || '', null, 'err')),
      workerUsageRows(),
    ]);
    const rows = [
      ...localRows,
      remoteDataRow,
      githubRow,
      resendUsageRow(),
      ...workerRows,
    ];
    if(renderToken === usageRenderToken) out.replaceChildren(...rows);
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

/* ============================================================
   자주 푸는 문제 사이트
   ============================================================ */
function safeHttpUrl(u){
  if(typeof u !== 'string' || !u.trim()) return null;
  let p;
  try{ p = new URL(u.trim()); }catch(e){ return null; }
  return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : null;
}

function renderQuickSites(){
  const el = $('#quickSiteList');
  if(!el) return;
  const sites = state.settings.problemSites || [];
  if(!sites.length){
    el.innerHTML = '<p class="quick-sites-empty">등록한 사이트가 없어요. 자주 가는 문제 사이트를 추가해 보세요.</p>';
    return;
  }
  el.innerHTML = sites.map(s=>{
    const href = safeHttpUrl(s.url);
    if(!href) return '';
    return `<div class="quick-site">
      <a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.name)}</a>
      <button type="button" data-del-site="${escapeAttr(s.id)}" title="${escapeAttr(s.name)} 삭제" aria-label="${escapeAttr(s.name)} 삭제">×</button>
    </div>`;
  }).join('');
}

function setQuickSiteForm(show){
  $('#quickSiteForm').hidden = !show;
  $('#toggleSiteForm').setAttribute('aria-expanded', String(show));
  if(show) $('#qs-name').focus();
  else $('#quickSiteForm').reset();
}

function addQuickSite(e){
  e.preventDefault();
  const name = $('#qs-name').value.trim();
  const url = safeHttpUrl($('#qs-url').value);
  if(!name || !url){ toast('사이트 이름과 올바른 http(s) 주소가 필요해요'); return; }
  state.settings.problemSites.push({id:uid(), name, url});
  save(); renderQuickSites(); setQuickSiteForm(false);
  toast('문제 사이트 바로가기를 추가했어요');
}

function deleteQuickSite(id){
  state.settings.problemSites = state.settings.problemSites.filter(s=>s.id!==id);
  save(); renderQuickSites();
}

/* ---------- review logic ---------- */
// Build the review schedule for a problem based on first result.
function buildReviews(attemptDate, offsets=state.settings.reviewOffsets){
  return buildReviewSchedule(attemptDate, offsets, addDays);
}

function reviewStage(problem, index){
  return Number(problem?.reviews?.[index]?.offset)
    || Number(problem?.reviewOffsets?.[index])
    || DEFAULT_REVIEW_OFFSETS[index]
    || index + 1;
}

function renderReviewScheduleHint(){
  const hint = $('#reviewScheduleHint');
  if(!hint) return;
  hint.innerHTML = `실패로 저장하면 <b>${state.settings.reviewOffsets.map(day=>`${day}일`).join(' · ')} 뒤</b> 복습 일정이 자동으로 잡혀요.`;
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
  const active = activeReview(p);
  const nodes = p.reviews.map((r,i)=>{
    const stage = reviewStage(p, i);
    let cls = 'track-dot', tip = `${stage}일차 · ${fmtKDate(r.due)}`;
    if(r.done){ cls += ' done'; tip = `완료 (${fmtKDate(r.doneDate||r.due)})`; }
    else if(r.due < t){ cls += ' overdue'; tip = `기한 지남 · ${fmtKDate(r.due)}`; }
    else if(r.due <= t){ cls += ' due'; tip = `오늘 복습 · ${fmtKDate(r.due)}`; }
    const actionable = !r.done && active && active.idx === i;
    if(actionable) cls += ' is-actionable';
    else if(!r.done && r.due <= t) tip += ' · 앞 단계 완료 후 진행';
    const mark = r.done ? '✓' : stage;
    const line = i < p.reviews.length-1
      ? `<div class="track-line ${r.done?'filled':''}"></div>` : '';
    return `<div class="track-node">
        <div class="${cls}" ${actionable?`data-review="${escapeAttr(p.id)}" data-review-idx="${i}" role="button" tabindex="0"`:'aria-disabled="true"'} title="${escapeAttr(tip)}">${mark}</div>
        <span class="track-label">${stage}일</span>
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
        ${p.solutionCode ? `<a class="icon-btn" href="solution.html#local=${encodeURIComponent(p.id)}">풀이 보기</a>` : ''}
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
  renderQuickSites();
  renderReviewScheduleHint();
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
      const stage = reviewStage(p, a.idx);
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
    const reviewedDates = new Set();
    for(const r of p.reviews || []){
      if(r.done && r.doneDate) reviewedDates.add(r.doneDate);
    }
    for(const date of reviewedDates) bump(date, 'review');
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
  const active = activeReview(p);
  if(!active || active.idx!==idx){ toast('앞선 복습 단계부터 완료해 주세요'); return; }
  p.reviews[idx].done = true;
  p.reviews[idx].doneDate = todayISO();
  p.updatedAt = new Date().toISOString();
  const stage = reviewStage(p, idx);
  queueContribution('review', p, stage);
  void queueTeamActivity('review_completed', p, stage);
  save(); renderProblems();
  toast('복습 완료로 표시했어요');
}

function deleteProblem(id){
  const p = state.problems.find(x=>x.id===id);
  if(!p) return;
  if(!confirm(`"${p.title||p.number}" 기록을 삭제할까요? 팀 랭킹에서 이 문제로 받은 점수도 회수됩니다.`)) return;
  void queueTeamActivity('problem_deleted', p);
  state.problems = state.problems.filter(x=>x.id!==id);
  save(); renderProblems();
  toast('기록을 삭제했어요 · 팀 점수도 갱신됩니다');
}

/* ---------- add / edit form ---------- */
let resultVal = 'success';

function openForm(edit){
  $('#probForm').hidden = false;
  $('#toggleForm').setAttribute('aria-expanded','true');
  if(!edit && !$('#f-date').value) $('#f-date').value = todayISO();
}
function resetForm(){
  ['f-number','f-title','f-link','f-difficulty','f-note','f-solution-code'].forEach(id=>$('#'+id).value='');
  $('#f-site').selectedIndex = 0;
  $('#f-solution-language').value = 'cpp';
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
  $('#f-solution-language').value = normalizeSolutionLanguage(p.solutionLanguage) || 'cpp';
  $('#f-solution-code').value = p.solutionCode||'';
  setResult(p.firstResult||'success');
  $('#cancelEdit').hidden = false;
  openForm(true);
  $('.review-hero').scrollIntoView({behavior:'smooth',block:'start'});
}

function submitForm(e){
  e.preventDefault();
  const id = $('#editId').value;
  const attemptDate = $('#f-date').value || todayISO();
  const solutionCode = $('#f-solution-code').value.replace(/\r\n?/g, '\n');
  const solutionLanguage = solutionCode ? normalizeSolutionLanguage($('#f-solution-language').value) : '';
  if(solutionCode && !solutionLanguage){ toast('풀이 언어는 C++, Python, Java 중에서 선택해 주세요'); return; }
  if(solutionByteLength(solutionCode) > MAX_SOLUTION_BYTES){ toast('풀이 코드는 최대 64KB까지 저장할 수 있어요'); return; }
  const data = {
    number: $('#f-number').value.trim(),
    title: $('#f-title').value.trim(),
    link: $('#f-link').value.trim(),
    site: $('#f-site').value,
    difficulty: $('#f-difficulty').value.trim(),
    attemptDate,
    firstResult: resultVal,
    note: $('#f-note').value.trim(),
    solutionLanguage,
    solutionCode,
  };
  if(!data.number && !data.title){ toast('문제 번호나 제목 중 하나는 필요해요'); return; }

  if(id){
    const p = state.problems.find(x=>x.id===id);
    const wasFail = p.firstResult==='fail';
    Object.assign(p, data, {updatedAt:new Date().toISOString()});
    // manage review schedule on result / date change
    if(data.firstResult==='fail'){
      if(!wasFail || !p.reviews || !p.reviews.length){
        p.reviewOffsets = [...state.settings.reviewOffsets];
        p.reviews = buildReviews(attemptDate, p.reviewOffsets);
      }else if(p._lastDate !== attemptDate){
        // keep done-state where possible but recompute due dates from new attempt date
        p.reviews = p.reviews.map((r,i)=>({offset:reviewStage(p,i), due:addDays(attemptDate,reviewStage(p,i)),done:r.done,doneDate:r.doneDate}));
      }
    }else{
      delete p.reviews;
      delete p.reviewOffsets;
    }
    p._lastDate = attemptDate;
    let activitySync = null;
    if(wasFail && data.firstResult==='success') {
      queueContribution('solve', p);
      activitySync = queueTeamActivity('problem_solved', p);
    } else if(!wasFail && data.firstResult==='fail') {
      activitySync = queueTeamActivity('problem_failed', p);
    }
    toast('수정했어요');
    if(activitySync) void activitySync.then(()=>syncTeamProblem(p));
    else void syncTeamProblem(p);
  }else{
    const p = {
      id: uid(), ...data,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      _lastDate: attemptDate,
    };
    if(data.firstResult==='fail'){
      p.reviewOffsets = [...state.settings.reviewOffsets];
      p.reviews = buildReviews(attemptDate, p.reviewOffsets);
    }
    state.problems.push(p);
    queueContribution('solve', p);
    void queueTeamActivity(data.firstResult==='success' ? 'problem_solved' : 'problem_failed', p)
      .then(()=>syncTeamProblem(p));
    toast(data.firstResult==='fail' ? '기록 완료 · 복습 일정을 잡았어요' : '기록 완료 🎉');
  }
  save(); resetForm();
  $('#probForm').hidden = true;
  $('#toggleForm').setAttribute('aria-expanded','false');
  renderProblems();
}

/* ---------- email (Worker secret MAIL_TO) ---------- */
async function sendReviewMail(){
  const due = dueProblems();
  if(!due.length) return;
  if(!usageCfg.cronKey){
    toast('설정에서 현재 탭의 관리 키를 먼저 입력하세요');
    openSettings();
    return;
  }
  try{
    const res = await fetch('/__cron', {
      method:'POST',
      headers:{Authorization:`Bearer ${usageCfg.cronKey}`},
      cache:'no-store',
    });
    if(!res.ok) throw new Error(res.status === 403 ? '관리 키가 올바르지 않습니다' : `발송 실패 (${res.status})`);
    toast(await res.text());
  }catch(error){
    toast(error.message || '메일을 보내지 못했습니다');
  }
}

/* ============================================================
   RENDER — concepts
   ============================================================ */
let activeConcept = null;
let saveTimer = null;
let previewTimer = null;
let codeHighlightTimer = null;
const PREVIEW_DELAY_MS = 160;
const CODE_HIGHLIGHT_DELAY_MS = 260;
let openFolders = new Set();
let conceptPreviewOnly = localStorage.getItem(PREVIEW_ONLY_KEY) === 'true';

try{
  const savedFolders = JSON.parse(localStorage.getItem(TREE_KEY) || '[]');
  if(Array.isArray(savedFolders)) openFolders = new Set(savedFolders.filter(v=>typeof v==='string'));
}catch(e){}

function saveOpenFolders(){
  localStorage.setItem(TREE_KEY, JSON.stringify([...openFolders]));
}

function conceptCategories(){
  return state.settings.conceptCategories;
}

function conceptCategoryIds(){
  return conceptCategories().map(item=>item.id);
}

function conceptCategoryLabel(id){
  return conceptCategories().find(item=>item.id===id)?.name || '카테고리';
}

function ensureActiveConceptCategory(){
  const ids = conceptCategoryIds();
  if(!ids.includes(activeLang)) activeLang = ids[0] || DEFAULT_LANG;
  localStorage.setItem(LANG_KEY, activeLang);
}

function renderConceptCategorySelect(selected=activeLang){
  const select = $('#c-lang');
  if(!select) return;
  select.innerHTML = conceptCategories().map(item=>
    `<option value="${escapeAttr(item.id)}" ${item.id===selected?'selected':''}>${escapeHTML(item.name)}</option>`
  ).join('');
}

// 상위 카테고리 탭의 선택 상태와 개수를 맞춘다 (개수는 검색어와 무관하다)
function renderLangTabs(){
  ensureActiveConceptCategory();
  const ids = conceptCategoryIds();
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for(const c of state.concepts) if(counts[c.lang] !== undefined) counts[c.lang]++;
  $('#langTabs').innerHTML = conceptCategories().map(item=>{
    const on = item.id === activeLang;
    return `<button class="lang-tab ${on?'is-on':''}" data-lang="${escapeAttr(item.id)}" role="tab" aria-selected="${on}">
      ${escapeHTML(item.name)}<span class="lang-count">${counts[item.id] || ''}</span></button>`;
  }).join('');
  renderConceptCategorySelect(state.concepts.find(item=>item.id===activeConcept)?.lang || activeLang);
}

function setLang(lang){
  if(!conceptCategoryIds().includes(lang) || lang === activeLang) return;
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

function foldersForLang(lang=activeLang){
  return state.conceptFolders.filter(f=>f.lang===lang);
}

function folderChildren(parentId, lang=activeLang){
  return sortByOrder(foldersForLang(lang)
    .filter(f=>(f.parentId||null)===(parentId||null)));
}

function folderOptionsHTML(lang, selected){
  const out = ['<option value="">미분류</option>'];
  const visit = (parentId, depth, seen) => {
    for(const f of folderChildren(parentId, lang)){
      if(seen.has(f.id)) continue;
      const next = new Set(seen); next.add(f.id);
      out.push(`<option value="${escapeAttr(f.id)}" ${f.id===selected?'selected':''}>${escapeHTML('　'.repeat(depth)+f.name)}</option>`);
      visit(f.id, depth+1, next);
    }
  };
  visit(null, 0, new Set());
  return out.join('');
}

function populateFolderSelect(lang, selected){
  $('#c-folder').innerHTML = folderOptionsHTML(lang, selected);
}

function conceptButton(c, depth){
  return `<button class="concept-item concept-tree-note ${c.id===activeConcept?'is-active':''}"
      style="--tree-depth:${depth}" data-concept="${escapeAttr(c.id)}" role="treeitem" draggable="true"
      title="드래그해서 순서를 바꾸거나 다른 폴더로 이동할 수 있습니다">
      <b>${escapeHTML(c.title||'(제목 없음)')}</b>
      <span>${fmtKDate((c.updatedAt||'').slice(0,10))} 수정</span>
      ${(c.tags&&c.tags.length)?`<div class="ci-tags">${c.tags.map(t=>`<span class="ci-tag">${escapeHTML(t)}</span>`).join('')}</div>`:''}
    </button>`;
}

function renderFolderNode(folder, notes, term, depth, seen, filterActive=false){
  if(seen.has(folder.id)) return '';
  const nextSeen = new Set(seen); nextSeen.add(folder.id);
  const children = folderChildren(folder.id);
  const directNotes = sortByOrder(notes.filter(c=>c.folderId===folder.id));
  const childHTML = children.map(f=>renderFolderNode(f, notes, term, depth+1, nextSeen, filterActive)).filter(Boolean);
  const nameMatches = term && folder.name.toLowerCase().includes(term);
  if(filterActive && !nameMatches && !directNotes.length && !childHTML.length) return '';
  const isOpen = filterActive || openFolders.has(folder.id);
  const count = directNotes.length + childHTML.length;
  return `<div class="folder-node" role="treeitem" aria-expanded="${isOpen}" style="--tree-depth:${depth}">
    <div class="folder-row" data-drop-folder="${escapeAttr(folder.id)}" data-folder-id="${escapeAttr(folder.id)}"
      draggable="true" title="위·아래에 놓으면 정렬, 가운데에 놓으면 하위 폴더로 이동합니다">
      <button type="button" class="folder-toggle" data-folder-toggle="${escapeAttr(folder.id)}" aria-label="${escapeAttr(folder.name)} ${isOpen?'접기':'펼치기'}">${isOpen?'▾':'▸'}</button>
      <button type="button" class="folder-name" data-folder-toggle="${escapeAttr(folder.id)}">📁 ${escapeHTML(folder.name)}</button>
      <span class="folder-count">${count||''}</span>
      <span class="folder-actions">
        <button type="button" data-folder-add="${escapeAttr(folder.id)}" title="하위 폴더 추가" aria-label="${escapeAttr(folder.name)}에 하위 폴더 추가">＋</button>
        <button type="button" data-folder-rename="${escapeAttr(folder.id)}" title="이름 변경" aria-label="${escapeAttr(folder.name)} 이름 변경">✎</button>
        <button type="button" data-folder-delete="${escapeAttr(folder.id)}" title="폴더 삭제" aria-label="${escapeAttr(folder.name)} 삭제">×</button>
      </span>
    </div>
    <div class="folder-children" role="group" ${isOpen?'':'hidden'}>
      ${directNotes.map(c=>conceptButton(c, depth+1)).join('')}${childHTML.join('')}
    </div>
  </div>`;
}

function renderConceptTagFilters(concepts){
  const tags = collectConceptTags(concepts);
  if(activeConceptTag && !tags.some(tag=>tag.key===activeConceptTag)){
    activeConceptTag = '';
    localStorage.removeItem(TAG_KEY);
  }
  $('#conceptTagCount').textContent = tags.length ? `${tags.length}개` : '';
  $('#conceptTagFilters').innerHTML = tags.length
    ? `<button type="button" class="concept-tag-chip ${activeConceptTag?'':'is-active'}" data-concept-tag="" aria-pressed="${!activeConceptTag}">전체</button>`
      + tags.map(tag=>`<button type="button" class="concept-tag-chip ${tag.key===activeConceptTag?'is-active':''}"
          data-concept-tag="${escapeAttr(tag.key)}" aria-pressed="${tag.key===activeConceptTag}">
          ${escapeHTML(tag.name)} <span>${tag.count}</span></button>`).join('')
    : '';
}

function setConceptTagFilter(tag){
  activeConceptTag = tag === activeConceptTag ? '' : tag;
  if(activeConceptTag) localStorage.setItem(TAG_KEY, activeConceptTag);
  else localStorage.removeItem(TAG_KEY);
  renderConceptList();
}

function renderConceptList(){
  renderLangTabs();
  const term = $('#conceptSearch').value.trim().toLowerCase();
  const allItems = state.concepts
    .filter(c => c.lang === activeLang);
  renderConceptTagFilters(allItems);
  const items = allItems.filter(c =>
    (!activeConceptTag || conceptHasTag(c, activeConceptTag))
    && (!term || (c.title+' '+(c.tags||[]).join(' ')+' '+c.markdown).toLowerCase().includes(term))
  );
  const el = $('#conceptList');
  const roots = folderChildren(null);
  if(!allItems.length && !roots.length){
    el.innerHTML = `<p class="empty" style="padding:20px 6px">`
      + `${escapeHTML(conceptCategoryLabel(activeLang))} 노트와 폴더가 없어요.</p>`;
    return;
  }
  const unfiled = sortByOrder(items.filter(c=>!c.folderId));
  const filterActive = !!term || !!activeConceptTag;
  const folderHTML = roots.map(f=>renderFolderNode(f, items, term, 0, new Set(), filterActive)).filter(Boolean).join('');
  const rootDropHTML = `<div class="folder-root-drop" data-folder-root-drop role="button" aria-label="최상위 폴더로 이동">
    최상위 폴더로 이동
  </div>`;
  const unfiledHTML = `<div class="unfiled-group" data-drop-folder="" aria-label="미분류 영역">
    <div class="unfiled-label">미분류 <span class="unfiled-drop-hint">여기에 놓으면 폴더에서 꺼냅니다</span></div>
    ${unfiled.map(c=>conceptButton(c,0)).join('')}
  </div>`;
  const hasResults = !!folderHTML || unfiled.length > 0;
  el.innerHTML = hasResults || !filterActive
    ? rootDropHTML + folderHTML + unfiledHTML
    : `<p class="empty" style="padding:20px 6px">${activeConceptTag && !term ? '선택한 태그의 노트가 없어요.' : '검색 결과가 없어요.'}</p>`;
}

let draggedConceptId = null;
let draggedFolderId = null;

function clearConceptDragState(){
  const list = $('#conceptList');
  list.classList.remove('is-dragging-note', 'is-dragging-folder');
  list.querySelectorAll('.is-dragging, .is-drop-target, .is-drop-before, .is-drop-after, .is-drop-inside').forEach(el=>{
    el.classList.remove('is-dragging', 'is-drop-target', 'is-drop-before', 'is-drop-after', 'is-drop-inside');
  });
  draggedConceptId = null;
  draggedFolderId = null;
}

function moveConceptToPosition(conceptId, folderId, targetConceptId=null, position='end'){
  const concept = state.concepts.find(c=>c.id===conceptId);
  if(!concept) return false;

  const folder = folderId
    ? state.conceptFolders.find(f=>f.id===folderId && f.lang===concept.lang)
    : null;
  if(folderId && !folder) return false;

  const previousFolderId = concept.folderId || null;
  const nextFolderId = folder ? folder.id : null;
  if(!moveConceptOrder(state.concepts, conceptId, nextFolderId, targetConceptId, position)) return false;
  if(folder){
    openFolders.add(folder.id);
    saveOpenFolders();
  }
  save();
  renderConceptList();
  if(activeConcept===concept.id) populateFolderSelect(concept.lang, concept.folderId);
  const movedFolder = previousFolderId !== nextFolderId;
  toast(movedFolder
    ? (folder ? `"${folder.name}" 폴더로 옮겼어요` : '미분류로 옮겼어요')
    : '노트 순서를 변경했어요');
  return true;
}

function setConceptPreviewOnly(enabled){
  conceptPreviewOnly = !!enabled;
  localStorage.setItem(PREVIEW_ONLY_KEY, String(conceptPreviewOnly));
  const editor = $('#conceptEditor');
  const button = $('#c-previewMode');
  editor.classList.toggle('is-preview-only', conceptPreviewOnly);
  button.setAttribute('aria-pressed', String(conceptPreviewOnly));
  button.textContent = conceptPreviewOnly ? '편집 같이 보기' : '프리뷰만 보기';
  button.title = conceptPreviewOnly ? '작성 화면과 프리뷰를 함께 표시합니다' : '작성 화면을 닫고 프리뷰를 크게 표시합니다';
}

function moveFolderToPosition(folderId, parentId, targetFolderId=null, position='end'){
  if(!canPlaceFolder(state.conceptFolders, folderId, parentId)) return false;
  const folder = state.conceptFolders.find(f=>f.id===folderId);
  const parent = parentId ? state.conceptFolders.find(f=>f.id===parentId) : null;
  const previousParentId = folder.parentId || null;
  if(!moveFolderOrder(state.conceptFolders, folderId, parent ? parent.id : null, targetFolderId, position)) return false;
  openFolders.add(folder.id);
  if(parent) openFolders.add(parent.id);
  saveOpenFolders();
  save();
  renderConceptList();
  populateFolderSelect(activeLang, activeConcept
    ? state.concepts.find(c=>c.id===activeConcept)?.folderId
    : null);
  const movedParent = previousParentId !== (parent ? parent.id : null);
  toast(movedParent
    ? (parent ? `"${folder.name}" 폴더를 "${parent.name}" 안으로 옮겼어요` : `"${folder.name}" 폴더를 최상위로 옮겼어요`)
    : '폴더 순서를 변경했어요');
  return true;
}

function dropEdge(event, element, edgeSize=.5){
  const rect = element.getBoundingClientRect();
  if(!rect.height) return 'after';
  const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  if(ratio < edgeSize) return 'before';
  if(ratio > 1 - edgeSize) return 'after';
  return 'inside';
}

function conceptDropIntent(event){
  const noteElement = event.target.closest('[data-concept]');
  if(noteElement){
    if(noteElement.dataset.concept === draggedConceptId) return null;
    const target = state.concepts.find(item=>item.id===noteElement.dataset.concept);
    if(!target) return null;
    const position = dropEdge(event, noteElement, .5)==='before' ? 'before' : 'after';
    return {
      element:noteElement,
      className:position==='before' ? 'is-drop-before' : 'is-drop-after',
      folderId:target.folderId || null,
      targetId:target.id,
      position,
    };
  }
  const folderElement = event.target.closest('[data-drop-folder]');
  if(!folderElement) return null;
  return {
    element:folderElement,
    className:'is-drop-inside',
    folderId:folderElement.dataset.dropFolder || null,
    targetId:null,
    position:'end',
  };
}

function folderDropIntent(event){
  const folderElement = event.target.closest('[data-folder-id]');
  if(folderElement){
    const target = state.conceptFolders.find(item=>item.id===folderElement.dataset.folderId);
    if(!target || target.id===draggedFolderId) return null;
    const edge = dropEdge(event, folderElement, .28);
    const parentId = edge==='inside' ? target.id : (target.parentId || null);
    if(!canPlaceFolder(state.conceptFolders, draggedFolderId, parentId)) return null;
    return {
      element:folderElement,
      className:edge==='before' ? 'is-drop-before' : edge==='after' ? 'is-drop-after' : 'is-drop-inside',
      parentId,
      targetId:edge==='inside' ? null : target.id,
      position:edge==='inside' ? 'end' : edge,
    };
  }
  const rootElement = event.target.closest('[data-folder-root-drop]');
  if(!rootElement || !canPlaceFolder(state.conceptFolders, draggedFolderId, null)) return null;
  return {element:rootElement, className:'is-drop-inside', parentId:null, targetId:null, position:'end'};
}

function showConceptDropIntent(intent){
  $('#conceptList').querySelectorAll('.is-drop-target, .is-drop-before, .is-drop-after, .is-drop-inside').forEach(element=>{
    element.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after', 'is-drop-inside');
  });
  if(intent) intent.element.classList.add('is-drop-target', intent.className);
}

function openConcept(id){
  const c = state.concepts.find(x=>x.id===id);
  if(!c) return;
  activeConcept = id;
  $('#conceptEmpty').hidden = true;
  $('#conceptEditor').hidden = false;
  $('#c-title').value = c.title||'';
  renderConceptCategorySelect(c.lang || DEFAULT_LANG);
  populateFolderSelect(c.lang || DEFAULT_LANG, c.folderId);
  $('#c-tags').value = (c.tags||[]).join(', ');
  const body = $('#c-body');
  body.value = c.markdown||'';
  editHistory.reset();
  body.scrollTop = 0;
  $('#c-preview').scrollTop = 0;
  renderPreview();
  renderConceptList();
  $('#c-saveState').textContent = '';
}

function newConcept(){
  // 지금 보고 있는 언어로 만든다
  const c = {id:uid(), title:'', lang:activeLang, folderId:null, order:nextConceptOrder(state.concepts, activeLang), tags:[], markdown:'', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()};
  state.concepts.push(c); save();
  openConcept(c.id);
  $('#c-title').focus();
}

function createFolder(parentId){
  const parent = parentId ? state.conceptFolders.find(f=>f.id===parentId) : null;
  const name = prompt(parent ? `"${parent.name}" 아래에 만들 폴더 이름` : `${conceptCategoryLabel(activeLang)} 폴더 이름`);
  if(!name || !name.trim()) return;
  const folder = {id:uid(), name:name.trim(), lang:activeLang, parentId:parentId||null, order:nextFolderOrder(state.conceptFolders, activeLang, parentId), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()};
  state.conceptFolders.push(folder);
  openFolders.add(folder.id);
  if(parentId) openFolders.add(parentId);
  saveOpenFolders(); save(); renderConceptList();
}

function renameFolder(id){
  const folder = state.conceptFolders.find(f=>f.id===id);
  if(!folder) return;
  const name = prompt('새 폴더 이름', folder.name);
  if(!name || !name.trim() || name.trim()===folder.name) return;
  folder.name = name.trim(); folder.updatedAt = new Date().toISOString();
  save(); renderConceptList(); populateFolderSelect($('#c-lang').value, $('#c-folder').value);
}

function deleteFolder(id){
  const folder = state.conceptFolders.find(f=>f.id===id);
  if(!folder) return;
  const directNotes = state.concepts.filter(c=>c.folderId===id).length;
  const childCount = state.conceptFolders.filter(f=>f.parentId===id).length;
  const detail = directNotes||childCount ? `\n안의 노트 ${directNotes}개와 하위 폴더 ${childCount}개는 상위 폴더로 이동합니다.` : '';
  if(!confirm(`"${folder.name}" 폴더를 삭제할까요?${detail}`)) return;
  for(const c of state.concepts) if(c.folderId===id) c.folderId = folder.parentId || null;
  for(const f of state.conceptFolders) if(f.parentId===id) f.parentId = folder.parentId || null;
  state.conceptFolders = state.conceptFolders.filter(f=>f.id!==id);
  seedConceptOrders(state.concepts);
  seedFolderOrders(state.conceptFolders);
  openFolders.delete(id); saveOpenFolders(); save();
  renderConceptList();
  if(activeConcept){
    const c = state.concepts.find(x=>x.id===activeConcept);
    if(c) populateFolderSelect(c.lang, c.folderId);
  }
}

function saveConcept(showToast){
  if(!activeConcept) return;
  const c = state.concepts.find(x=>x.id===activeConcept);
  if(!c) return;
  const previousGroup = `${c.lang}:${c.folderId || ''}`;
  c.title = $('#c-title').value.trim();
  c.tags = normalizeConceptTags($('#c-tags').value.split(','));
  c.markdown = $('#c-body').value;
  c.updatedAt = new Date().toISOString();

  // 노트의 언어를 바꿨으면 목록도 그 언어로 따라가야 노트가 눈앞에서 사라지지 않는다
  const lang = $('#c-lang').value;
  if(conceptCategoryIds().includes(lang) && lang !== c.lang){
    c.lang = lang;
    c.folderId = null;
    activeLang = lang;
    localStorage.setItem(LANG_KEY, lang);
  }
  const folderId = $('#c-folder').value || null;
  const folder = state.conceptFolders.find(f=>f.id===folderId && f.lang===c.lang);
  c.folderId = folder ? folder.id : null;
  if(previousGroup !== `${c.lang}:${c.folderId || ''}`){
    c.order = nextConceptOrder(state.concepts.filter(item=>item.id!==c.id), c.lang, c.folderId);
  }

  // 어디에서도 쓰지 않는 사진 정리는 "저장" 버튼을 눌렀을 때만 한다.
  // 자동저장에서 하면 사진을 잘라내 다른 노트로 옮기는 중에 사라질 수 있다.
  if(showToast) gcImages();

  save(); renderConceptList();
  $('#c-saveState').textContent = '저장됨 · ' + new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  if(showToast) toast('노트를 저장했어요');
}

function safeDownloadName(value){
  return String(value || 'concept-note').trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 80) || 'concept-note';
}

async function exportConceptMarkdown(){
  if(!activeConcept) return;
  saveConcept(false);
  const concept = state.concepts.find(item=>item.id===activeConcept);
  if(!concept) return;
  const images = syncedImages();
  const markdown = String(concept.markdown || '').replace(/img:([A-Za-z0-9_-]+)/g, (match, id)=>
    images[id] && typeof images[id].data === 'string' ? images[id].data : match
  );
  const blob = new Blob([markdown], {type:'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeDownloadName(concept.title)}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  toast('Markdown 파일을 내보냈어요');
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

function syncConceptPreviewScroll(){
  const body = $('#c-body');
  const preview = $('#c-preview');
  preview.scrollTop = syncedScrollTop(
    body.scrollTop,
    body.scrollHeight,
    body.clientHeight,
    preview.scrollHeight,
    preview.clientHeight,
  );
}

let conceptPreviewSyncFrame = 0;
function syncConceptPreviewAfterInput(previousEditorTop, previousPreviewTop){
  if(conceptPreviewSyncFrame) cancelAnimationFrame(conceptPreviewSyncFrame);
  conceptPreviewSyncFrame = requestAnimationFrame(()=>{
    conceptPreviewSyncFrame = 0;
    const body = $('#c-body');
    const preview = $('#c-preview');
    const editorMax = Math.max(0, body.scrollHeight - body.clientHeight);
    const previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight);
    const nearEditorBottom = editorMax - body.scrollTop <= Math.max(36, body.clientHeight * .08);

    // Enter 입력 뒤 브라우저가 커서를 따라 편집창을 내린 경우에는 새 위치로 동기화한다.
    // 아직 편집창이 움직이지 않았다면 높이 증가만으로 비율이 작아져 프리뷰가 위로
    // 역이동하지 않도록 직전 프리뷰 위치를 그대로 유지한다.
    if(nearEditorBottom){
      preview.scrollTop = previewMax;
    }else if(Math.abs(body.scrollTop - previousEditorTop) > 1){
      syncConceptPreviewScroll();
    }else{
      preview.scrollTop = Math.min(previousPreviewTop, previewMax);
    }
  });
}

function renderPreview(){
  clearTimeout(previewTimer);
  clearTimeout(codeHighlightTimer);
  previewTimer = null;
  const body = $('#c-body');
  const preview = $('#c-preview');
  const previousEditorTop = body.scrollTop;
  const previousPreviewTop = preview.scrollTop;
  retainImageObjectUrls(body.value);
  preview.innerHTML = mdToHTML(body.value);
  // innerHTML 교체가 scrollTop을 0으로 초기화하므로 우선 화면 점프부터 막는다.
  preview.scrollTop = Math.min(previousPreviewTop, Math.max(0, preview.scrollHeight - preview.clientHeight));
  syncConceptPreviewAfterInput(previousEditorTop, previousPreviewTop);
  preview.querySelectorAll('img').forEach(img=>{
    if(!img.complete) img.addEventListener('load', syncConceptPreviewScroll, {once:true});
  });
  // Prism은 코드 블록 전체를 다시 훑으므로 타이핑과 분리해 입력이 멈춘 뒤 실행한다.
  codeHighlightTimer = setTimeout(()=>{
    codeHighlightTimer = null;
    const top = preview.scrollTop;
    highlightCodeBlocks(preview);
    preview.scrollTop = Math.min(top, Math.max(0, preview.scrollHeight - preview.clientHeight));
  }, CODE_HIGHLIGHT_DELAY_MS);
}

function schedulePreview(delay=PREVIEW_DELAY_MS){
  clearTimeout(previewTimer);
  clearTimeout(codeHighlightTimer);
  codeHighlightTimer = null;
  previewTimer = setTimeout(renderPreview, delay);
}

/* ---------- 되돌리기 ---------- */
const editHistory = createEditHistory(UNDO_LIMIT);

function editorSnapshot(){
  const ta = $('#c-body');
  const length = ta.value.length;
  return {
    value: ta.value,
    selectionStart: ta.selectionStart ?? length,
    selectionEnd: ta.selectionEnd ?? length,
  };
}

// 편집기 값을 바꾸는 곳은 모두 여기를 거친다. 그래야 되돌리기에 빠지는 편집이 없다.
function applyEditorEdit(edited){
  const ta = $('#c-body');
  editHistory.record(editorSnapshot());
  ta.value = edited.value;
  ta.setSelectionRange(edited.selectionStart, edited.selectionEnd);
  schedulePreview(0);
  scheduleSave();
}

function undoEditorChange(){
  const previous = editHistory.undo();
  if(!previous){ toast('되돌릴 편집이 없어요'); return; }
  const ta = $('#c-body');
  ta.value = previous.value;
  ta.setSelectionRange(previous.selectionStart, previous.selectionEnd);
  schedulePreview(0);
  scheduleSave();
}

function applyEditorFormat(kind){
  const ta = $('#c-body');
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  let formatted;
  if(kind === 'bold') formatted = toggleSelection(ta.value, start, end, '**', '**');
  else if(kind === 'italic') formatted = toggleSelection(ta.value, start, end, '*', '*');
  else if(kind === 'underline') formatted = toggleSelection(ta.value, start, end, '++', '++');
  else if(kind === 'superscript') formatted = toggleSelection(ta.value, start, end, '^{', '}', '2');
  else if(kind === 'subscript') formatted = toggleSelection(ta.value, start, end, '_{', '}', '2');
  else if(kind === 'highlight') formatted = toggleHighlight(ta.value, start, end, $('#c-highlight-color').value);
  else if(kind === 'text-color') formatted = toggleTextColor(ta.value, start, end, $('#c-text-color').value);
  else if(kind === 'table') formatted = insertTable(ta.value, start, end);
  else if(kind === 'blank-line') formatted = insertBlankLineMark(ta.value, start, end);
  else if(kind === 'duplicate-line') formatted = duplicateLine(ta.value, start, end);
  else if(kind === 'delete-line') formatted = deleteLine(ta.value, start, end);
  else return;

  ta.focus();
  applyEditorEdit(formatted);
}

function insertImage(file){
  if(!file || !file.type.startsWith('image/') || file.type === 'image/svg+xml'){
    toast('PNG·JPG·GIF·WebP 같은 래스터 이미지만 넣을 수 있어요');
    return;
  }
  if(file.size > 2 * 1024 * 1024){ toast('이미지는 한 장에 2MB 이하만 넣을 수 있어요'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    // 사진 원본은 IndexedDB에 두고, localStorage와 본문에는 짧은 정보만 남긴다.
    const id = uid();
    const name = (file.name || '이미지').replace(/\.[^.]+$/,'') || '이미지';
    const image = {id, name, data:reader.result};
    try{
      if(imageStoreReady){
        await imageStore.putMany([image]);
        imageCache.set(id, image);
        state.images[id] = {name};
      }else{
        // IndexedDB를 사용할 수 없는 환경에서는 이전 저장 방식을 유지한다.
        state.images[id] = {name, data:reader.result};
        imageCache.set(id, image);
      }
    }catch(error){
      console.warn('이미지를 IndexedDB에 저장하지 못했습니다.', error);
      toast('이미지를 저장하지 못했어요 · 브라우저 저장 공간을 확인해 주세요');
      return;
    }
    const ta = $('#c-body');
    const md = `\n![${name}](img:${id})\n`;
    const pos = ta.selectionStart ?? ta.value.length;
    applyEditorEdit({
      value: ta.value.slice(0,pos) + md + ta.value.slice(pos),
      selectionStart: pos + md.length,
      selectionEnd: pos + md.length,
    });
    toast('사진을 넣었어요');
  };
  reader.readAsDataURL(file);
}

function scheduleSave(){
  clearTimeout(saveTimer);
  $('#c-saveState').textContent = '입력 중…';
  saveTimer = setTimeout(()=>saveConcept(false), 700);
}

/* ---------- Markdown + 안전한 HTML ---------- */
function escapeHTML(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHTML(s).replace(/"/g,'&quot;'); }

/* ---------- 주소 검사 ----------
   href에 javascript: 가 들어오면 클릭 한 번으로 이 오리진의 스크립트가 되고,
   브라우저 세션의 깃허브 토큰까지 가져갈 수 있다. 스킴을 좁혀서 막는다.
   브라우저와 같은 URL 파서를 쓰므로 "java\nscript:" 같은 우회도 함께 걸린다. */
const SAFE_LINK_SCHEMES = ['http:', 'https:'];
function safeLink(u){
  if(typeof u !== 'string' || !u.trim()) return null;
  let p;
  try{ p = new URL(u.trim(), location.href); }catch(e){ return null; }
  return SAFE_LINK_SCHEMES.includes(p.protocol) ? p.href : null;
}
// 사진은 앱이 만든 data:image 와 http(s) 주소만 허용한다.
const SAFE_IMG_DATA = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]*$/i;
function safeImgSrc(u){
  if(typeof u !== 'string' || !u.trim()) return null;
  if(SAFE_IMG_DATA.test(u.trim())) return u.trim();
  if(u.startsWith('blob:') && trustedImageObjectUrls.has(u)) return u;
  let p;
  try{ p = new URL(u.trim(), location.href); }catch(e){ return null; }
  return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : null;
}

function prepareMarkdown(src){
  let text = String(src || '').replace(/^\uFEFF/, '');
  // YAML front matter는 문서 메타데이터이므로 본문에는 렌더링하지 않는다.
  const frontMatter = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if(frontMatter) text = text.slice(frontMatter[0].length);
  text = renderCompactFormatting(text);
  // 정화 단계에서는 안전한 내부 자리표시자를 쓰고, 정화가 끝난 뒤 앱이 만든 blob 주소로 바꾼다.
  return text.replace(/(\]\(\s*|\]:\s*)img:([A-Za-z0-9_-]+)/g, (m,prefix,id)=>{
    return prefix + `https://pslog.invalid/image/${id}`;
  });
}

function mdToHTML(src){
  if(!src) return '<p class="md-placeholder">미리보기가 여기에 표시됩니다.</p>';
  const raw = marked.parse(prepareMarkdown(src));
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES:{html:true},
    FORBID_TAGS:['style','script','iframe','object','embed','form','button','textarea','select','option'],
    FORBID_ATTR:['style','srcset'],
  });
  const template = document.createElement('template');
  template.innerHTML = clean;

  template.content.querySelectorAll('a').forEach(a=>{
    const href = safeLink(a.getAttribute('href') || '');
    if(!href){
      const blocked = document.createElement('span');
      blocked.className = 'md-link-blocked';
      blocked.textContent = '허용되지 않은 링크';
      a.replaceWith(...a.childNodes, blocked);
      return;
    }
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  template.content.querySelectorAll('img').forEach(img=>{
    const rawSrc = img.getAttribute('src') || '';
    const internal = rawSrc.match(/^https:\/\/pslog\.invalid\/image\/([A-Za-z0-9_-]+)$/);
    const srcValue = internal ? previewImageSource(internal[1]) : safeImgSrc(rawSrc);
    if(!srcValue){
      const missing = document.createElement('span');
      missing.className = 'md-img-missing';
      missing.textContent = '사진을 찾을 수 없어요';
      img.replaceWith(missing);
      return;
    }
    img.src = srcValue;
    img.loading = 'lazy';
  });
  // 원시 HTML의 입력 요소는 허용하지 않고, marked가 만든 읽기 전용 체크박스만 남긴다.
  template.content.querySelectorAll('input').forEach(input=>{
    if(input.type !== 'checkbox') input.remove();
    else{ input.disabled = true; input.classList.add('task-list-item-checkbox'); }
  });
  return template.innerHTML;
}

/* ============================================================
   RENDER — 일정표 (주간 달력 + 날짜별 TODO)
   ============================================================ */
// 화면에 보이는 주의 일요일 (ISO)
let weekStart = startOfWeek(todayISO());
let selectedScheduleDate = todayISO();
let draggedTodoId = null;
let suppressTodoClick = false;

function clearTodoDragState(){
  $$('.todo.is-dragging').forEach(item=>item.classList.remove('is-dragging'));
  $$('.day-cell.is-todo-drop').forEach(cell=>cell.classList.remove('is-todo-drop'));
  draggedTodoId = null;
  setTimeout(()=>{ suppressTodoClick = false; }, 0);
}

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

function addTodo(iso, text, color, focusArea='grid'){
  if(isTodoDateClosed(iso)){
    toast('오전 8시에 마감된 날짜에는 할 일을 추가할 수 없어요');
    return;
  }
  text = text.trim();
  if(!text) return;
  const now = new Date().toISOString();
  state.todos.push({
    id:uid(), date:iso, text, done:false,
    color:normalizeTodoColor(color), createdAt:now, updatedAt:now,
  });
  save();
  renderSchedule(iso, focusArea);   // 이어서 더 적을 수 있게 입력한 영역에 다시 포커스
}

function moveTodo(id, date){
  const todo = state.todos.find(item=>item.id===id);
  if(!todo || todo.date===date) return false;
  if(isTodoLocked(todo)){ toast('오전 8시에 마감된 Todo는 옮길 수 없어요'); return false; }
  if(isTodoDateClosed(date)){ toast('마감된 날짜로 Todo를 옮길 수 없어요'); return false; }
  todo.date = date;
  todo.updatedAt = new Date().toISOString();
  selectedScheduleDate = date;
  save(); renderSchedule();
  toast(`${fmtKDate(date)}로 Todo를 옮겼어요`);
  return true;
}

function renderDefaultTodoPanel(){
  const list = $('#defaultTodoList');
  if(!list) return;
  const templates = state.settings.defaultTodos;
  $('#defaultTodoCount').textContent = `${templates.length} / ${MAX_TODO_TEMPLATES}`;
  list.innerHTML = templates.length
    ? templates.map(template=>`<div class="default-todo-template todo-color-${normalizeTodoColor(template.color)}">
        <i aria-hidden="true"></i><span title="${escapeAttr(template.text)}">${escapeHTML(template.text)}</span>
        <button type="button" data-delete-default-todo="${escapeAttr(template.id)}" aria-label="${escapeAttr(template.text)} 기본 Todo 삭제">×</button>
      </div>`).join('')
    : '<p class="day-empty">등록된 기본 Todo가 없어요.</p>';
}

function addDefaultTodoTemplate(text, color){
  text = String(text || '').trim();
  if(!text) return;
  if(state.settings.defaultTodos.length >= MAX_TODO_TEMPLATES){
    toast(`기본 Todo는 최대 ${MAX_TODO_TEMPLATES}개까지 등록할 수 있어요`);
    return;
  }
  state.settings.defaultTodos.push({id:uid(), text:text.slice(0,200), color:normalizeTodoColor(color)});
  save(); renderDefaultTodoPanel();
  $('#defaultTodoText').value = '';
  $('#defaultTodoText').focus();
}

function deleteDefaultTodoTemplate(id){
  state.settings.defaultTodos = state.settings.defaultTodos.filter(template=>template.id!==id);
  save(); renderDefaultTodoPanel();
}

function addDefaultTodosToday(){
  const date = todayISO();
  if(isTodoDateClosed(date)) return;
  const missing = missingTodoTemplatesForDate(state.settings.defaultTodos, state.todos, date);
  if(!state.settings.defaultTodos.length){
    $('#defaultTodoPanel').hidden = false;
    $('#toggleDefaultTodos').setAttribute('aria-expanded', 'true');
    $('#defaultTodoText').focus();
    toast('먼저 기본 Todo를 등록해 주세요');
    return;
  }
  if(!missing.length){ toast('오늘 기본 Todo는 이미 모두 추가되어 있어요'); return; }
  const now = new Date().toISOString();
  for(const template of missing){
    state.todos.push({
      id:uid(), date, text:template.text, done:false, color:template.color,
      templateId:template.id, createdAt:now, updatedAt:now,
    });
  }
  weekStart = startOfWeek(date);
  selectedScheduleDate = date;
  save(); renderSchedule();
  toast(`오늘 일정에 기본 Todo ${missing.length}개를 추가했어요`);
}

function changeTodoColor(id){
  const t = state.todos.find(x => x.id === id);
  if(!t || t.done) return;
  if(isTodoLocked(t)){
    toast('오전 8시에 마감된 Todo는 수정할 수 없어요');
    return;
  }
  t.color = nextTodoColor(t.color);
  t.updatedAt = new Date().toISOString();
  save(); renderSchedule();
}

function toggleTodo(id){
  const t = state.todos.find(x => x.id === id);
  if(!t) return;
  if(isTodoLocked(t)){
    toast('오전 8시에 마감된 Todo는 수정할 수 없어요');
    return;
  }
  t.done = !t.done;
  t.updatedAt = new Date().toISOString();
  save(); renderSchedule();
}

function deleteTodo(id){
  const t = state.todos.find(x => x.id === id);
  if(!t) return;
  if(isTodoLocked(t)){
    toast('오전 8시에 마감된 Todo는 삭제할 수 없어요');
    return;
  }
  state.todos = state.todos.filter(x => x.id !== id);
  save(); renderSchedule();
}

function todoMarkup(t, detail=false){
  const locked = isTodoLocked(t);
  const overdue = isTodoOverdue(t);
  const color = normalizeTodoColor(t.color);
  const actionHint = locked
    ? (overdue ? '오전 8시에 마감된 미완료 Todo입니다' : '오전 8시에 마감된 Todo입니다')
    : '클릭하면 완료 표시가 바뀝니다';
  return `<div class="todo todo-color-${color} ${detail ? 'todo-detail' : ''} ${t.done ? 'is-done' : ''} ${locked ? 'is-locked' : ''} ${overdue ? 'is-locked-overdue' : ''}" data-todo="${escapeAttr(t.id)}"
      draggable="${locked ? 'false' : 'true'}"
      ${locked ? 'aria-disabled="true"' : 'role="button" tabindex="0"'}
      title="${escapeAttr(t.text)} · ${actionHint}" aria-label="${escapeAttr(t.text)}. ${actionHint}">
    <span class="tick">${overdue ? '!' : '✓'}</span>
    <span class="todo-text">${escapeHTML(t.text)}</span>
    ${locked
      ? `<span class="todo-lock">${overdue ? '미완료' : '마감'}</span>`
      : `${t.done ? '' : `<button class="todo-color-dot" data-todocolor="${escapeAttr(t.id)}" title="색상 변경: 파랑 → 노랑 → 보라" aria-label="할 일 색상 변경"></button>`}
         <button class="todo-del" data-deltodo="${escapeAttr(t.id)}" title="삭제" aria-label="할 일 삭제">×</button>`}
  </div>`;
}

function dayCell(iso, dow){
  const today = todayISO();
  const items = todosOn(iso);
  const dateClosed = isTodoDateClosed(iso);
  const left = items.filter(t => !t.done).length;
  const done = items.length - left;
  const progress = items.length ? Math.round((done / items.length) * 100) : 0;
  const cls = [
    'day-cell',
    iso === selectedScheduleDate ? 'is-selected' : '',
    iso === today ? 'is-today' : (iso < today ? 'is-past' : ''),
    dow === 0 ? 'is-sun' : (dow === 6 ? 'is-sat' : ''),
  ].filter(Boolean).join(' ');

  const list = items.length
    ? items.map(t => todoMarkup(t)).join('')
    : `<p class="day-empty">할 일 없음</p>`;

  return `<section class="${cls}" data-date="${iso}" tabindex="0" aria-label="${fmtKDate(iso)} 일정 선택">
    <div class="day-head">
      <div class="day-date">
        <span class="day-dow">${HM_DOW[dow]}</span>
        <time class="day-num" datetime="${iso}">${+iso.slice(8)}</time>
        ${iso === today ? '<span class="today-badge">오늘</span>' : ''}
      </div>
      ${items.length ? `<span class="day-count ${left ? '' : 'is-complete'}">${left ? `${left}개 남음` : '완료'}</span>` : ''}
    </div>
    ${items.length ? `<div class="day-progress" role="progressbar" aria-label="${fmtKDate(iso)} 할 일 완료율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div>` : '<div class="day-progress is-empty" aria-hidden="true"></div>'}
    <div class="day-todos">${list}</div>
    ${dateClosed
      ? '<p class="todo-closed">오전 8시 마감</p>'
      : `<form class="todo-add" data-date="${iso}">
          <div class="todo-add-row">
            <input type="text" placeholder="＋ 할 일" aria-label="${fmtKDate(iso)} 할 일 추가" />
            <select class="todo-color-select" aria-label="할 일 색상">
              <option value="blue">파랑</option>
              <option value="yellow">노랑</option>
              <option value="purple">보라</option>
            </select>
            <button type="submit" class="todo-add-btn" aria-label="${fmtKDate(iso)} 할 일 등록">＋</button>
          </div>
        </form>`}
  </section>`;
}

function renderScheduleDetail(){
  const detail = $('#scheduleDetail');
  if(!detail) return;
  const iso = selectedScheduleDate;
  const items = todosOn(iso);
  const left = items.filter(item=>!item.done).length;
  const done = items.length - left;
  const dow = HM_DOW[new Date(`${iso}T00:00:00`).getDay()];
  const dateClosed = isTodoDateClosed(iso);
  const list = items.length
    ? `<div class="schedule-detail-list">${items.map(item=>todoMarkup(item, true)).join('')}</div>`
    : `<div class="schedule-detail-empty"><b>등록된 Todo가 없어요.</b><span>아래에서 이 날짜의 첫 할 일을 추가해 보세요.</span></div>`;

  detail.innerHTML = `<div class="schedule-detail-head">
      <div>
        <p class="eyebrow">선택한 날짜</p>
        <h2><time datetime="${iso}">${fmtKDate(iso)} ${dow}요일</time></h2>
      </div>
      <div class="schedule-detail-summary">
        <span>전체 <b>${items.length}</b></span>
        <span>남음 <b>${left}</b></span>
        <span>완료 <b>${done}</b></span>
      </div>
    </div>
    ${list}
    ${dateClosed
      ? '<p class="schedule-detail-closed">오전 8시에 마감된 날짜입니다.</p>'
      : `<form class="todo-add schedule-detail-add" data-date="${iso}">
          <div class="todo-add-row">
            <input type="text" placeholder="이 날짜에 할 일 추가" aria-label="${fmtKDate(iso)} 상세 할 일 추가" />
            <select class="todo-color-select" aria-label="할 일 색상">
              <option value="blue">파랑</option>
              <option value="yellow">노랑</option>
              <option value="purple">보라</option>
            </select>
            <button type="submit" class="todo-add-btn" aria-label="${fmtKDate(iso)} 상세 할 일 등록">＋</button>
          </div>
        </form>`}
  `;
}

function selectScheduleDate(iso){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  selectedScheduleDate = iso;
  $$('#weekGrid .day-cell').forEach(cell=>cell.classList.toggle('is-selected', cell.dataset.date===iso));
  renderScheduleDetail();
}

let todoCutoffTimer = null;
function scheduleTodoCutoffRefresh(){
  clearTimeout(todoCutoffTimer);
  todoCutoffTimer = setTimeout(()=>{
    renderSchedule();
    void reconcileTeamActivities();
    scheduleTodoCutoffRefresh();
  }, millisecondsUntilNextTodoCutoff() + 50);
}

function renderSchedule(focusDate, focusArea='grid'){
  const grid = $('#weekGrid');
  if(!grid) return;
  const days = Array.from({length:7}, (_,i) => addDays(weekStart, i));
  renderDefaultTodoPanel();
  if(!days.includes(selectedScheduleDate)){
    selectedScheduleDate = days.includes(todayISO()) ? todayISO() : days[0];
  }
  grid.innerHTML = days.map((iso,i) => dayCell(iso, i)).join('');

  const end = days[6];
  const sameMonth = weekStart.slice(0,7) === end.slice(0,7);
  const thisWeek = weekStart === startOfWeek(todayISO());
  $('#weekTitle').textContent =
    `${fmtKDate(weekStart)} – ${sameMonth ? +end.slice(8) + '일' : fmtKDate(end)}`
    + (thisWeek ? ' · 이번 주' : '');

  renderScheduleDetail();

  if(focusDate){
    const focusRoot = focusArea==='detail' ? $('#scheduleDetail') : grid;
    const input = focusRoot.querySelector(`.todo-add[data-date="${focusDate}"] input`);
    if(input) input.focus();
  }
}

function shiftWeek(n){
  weekStart = addDays(weekStart, n * 7);
  selectedScheduleDate = addDays(selectedScheduleDate, n * 7);
  renderSchedule();
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
  $('#view-team').hidden = name!=='team';
  document.body.dataset.view = name;   // 페이지마다 다른 최대 폭을 쓰기 위한 표시
  if(name==='concepts') renderConceptList();
  if(name==='schedule') renderSchedule();
  window.dispatchEvent(new CustomEvent('pslog:viewchange', {detail:{view:name}}));
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
  $('#problemList').addEventListener('keydown', e=>{
    if(e.key!=='Enter' && e.key!==' ') return;
    const rev = e.target.closest('[data-review]');
    if(rev){ e.preventDefault(); markReviewDone(rev.dataset.review, +rev.dataset.reviewIdx); }
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

  // 자주 푸는 문제 사이트
  $('#toggleSiteForm').addEventListener('click', ()=>setQuickSiteForm($('#quickSiteForm').hidden));
  $('#cancelSiteForm').addEventListener('click', ()=>setQuickSiteForm(false));
  $('#quickSiteForm').addEventListener('submit', addQuickSite);
  $('#quickSiteList').addEventListener('click', e=>{
    const del = e.target.closest('[data-del-site]');
    if(del) deleteQuickSite(del.dataset.delSite);
  });

  // sync
  $('#btnSync').addEventListener('click', syncNow);

  // settings
  $('#btnSettings').addEventListener('click', openSettings);
  $('#s-test').addEventListener('click', testConnection);
  $('#s-usage').addEventListener('click', checkUsage);
  $('#s-forget-token').addEventListener('click', ()=>{
    sync.token = '';
    saveSync();
    remoteSha = null;
    $('#s-token').value = '';
    $('#s-token').placeholder = 'github_pat_...';
    setSyncStatus('idle', '연결 안 됨');
    toast('이 탭의 GitHub 토큰을 지웠어요');
  });
  $('#s-forget-cronkey').addEventListener('click', ()=>{
    usageCfg.cronKey = '';
    saveUsageCfg();
    $('#s-cronkey').value = '';
    $('#s-cronkey').placeholder = '비워 두면 깃허브만 확인';
    toast('이 탭의 관리 키를 지웠어요');
  });
  $('#settingsDlg').addEventListener('close', ()=>{
    $('#s-token').value = '';
    $('#s-cronkey').value = '';
  });
  $('#settingsForm').addEventListener('submit', e=>{
    if(!(e.submitter && e.submitter.value==='save')) return;
    const editorTabSize = normalizeEditorTabSize($('#s-tab-size').value);
    const parsedReviewOffsets = parseReviewOffsets($('#s-review-offsets').value);
    if(!parsedReviewOffsets.ok){
      e.preventDefault();
      toast(parsedReviewOffsets.error);
      $('#s-review-offsets').focus();
      return;
    }
    const reviewOffsets = parsedReviewOffsets.offsets;
    applyContrast($('#s-contrast').value);
    const wasReady = syncReady();
    readSyncForm();
    saveSync();
    usageCfg.cronKey = $('#s-cronkey').value.trim() || usageCfg.cronKey;
    saveUsageCfg();

    if(syncReady() && !wasReady){
      // 이 기기에서 처음 연결 — 원격을 먼저 가져온 뒤 로컬 설정을 반영한다
      clearTimeout(pushTimer);
      toast('설정을 저장했어요 · 깃허브와 맞추는 중…');
      initialSync(state.problems.length > 0 || state.concepts.length > 0).then(()=>{
        const changed = state.settings.editorTabSize !== editorTabSize
          || state.settings.reviewOffsets.join(',') !== reviewOffsets.join(',');
        state.settings.editorTabSize = editorTabSize;
        state.settings.reviewOffsets = reviewOffsets;
        renderReviewScheduleHint();
        if(changed) save();
        $('#s-tab-size').value = normalizeEditorTabSize(state.settings.editorTabSize);
      });
      return;
    }

    state.settings.editorTabSize = editorTabSize;
    state.settings.reviewOffsets = reviewOffsets;
    renderReviewScheduleHint();
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
  $('#weekToday').addEventListener('click', ()=>{
    weekStart = startOfWeek(todayISO());
    selectedScheduleDate = todayISO();
    renderSchedule();
  });
  const handleTodoClick = e=>{
    if(suppressTodoClick) return;
    const del = e.target.closest('[data-deltodo]');
    if(del){ deleteTodo(del.dataset.deltodo); return; }
    const color = e.target.closest('[data-todocolor]');
    if(color){ changeTodoColor(color.dataset.todocolor); return; }
    const item = e.target.closest('[data-todo]');
    if(item) toggleTodo(item.dataset.todo);
  };
  const handleTodoKeydown = e=>{
    if(e.key !== 'Enter' && e.key !== ' ') return;
    if(e.target.closest('[data-deltodo],[data-todocolor]')) return;
    const item = e.target.closest('[data-todo]');
    if(item){ e.preventDefault(); toggleTodo(item.dataset.todo); }
  };
  const handleTodoSubmit = e=>{
    const form = e.target.closest('.todo-add');
    if(!form) return;
    e.preventDefault();
    addTodo(
      form.dataset.date,
      form.querySelector('input').value,
      form.querySelector('.todo-color-select').value,
      form.closest('#scheduleDetail') ? 'detail' : 'grid',
    );
  };
  $('#weekGrid').addEventListener('click', e=>{
    const cell = e.target.closest('.day-cell');
    if(cell) selectScheduleDate(cell.dataset.date);
    handleTodoClick(e);
  });
  $('#scheduleDetail').addEventListener('click', handleTodoClick);
  // 키보드로도 완료 표시를 바꿀 수 있게
  $('#weekGrid').addEventListener('keydown', e=>{
    if(e.target.classList.contains('day-cell') && (e.key==='Enter' || e.key===' ')){
      e.preventDefault();
      selectScheduleDate(e.target.dataset.date);
      return;
    }
    handleTodoKeydown(e);
  });
  $('#scheduleDetail').addEventListener('keydown', handleTodoKeydown);
  $('#weekGrid').addEventListener('submit', handleTodoSubmit);
  $('#scheduleDetail').addEventListener('submit', handleTodoSubmit);
  [$('#weekGrid'), $('#scheduleDetail')].forEach(root=>{
    root.addEventListener('dragstart', e=>{
      const item = e.target.closest('.todo[draggable="true"]');
      if(!item) return;
      draggedTodoId = item.dataset.todo;
      suppressTodoClick = true;
      item.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `todo:${draggedTodoId}`);
    });
    root.addEventListener('dragend', clearTodoDragState);
  });
  $('#weekGrid').addEventListener('dragover', e=>{
    if(!draggedTodoId) return;
    const cell = e.target.closest('.day-cell');
    const todo = state.todos.find(item=>item.id===draggedTodoId);
    if(!cell || !todo || todo.date===cell.dataset.date || isTodoDateClosed(cell.dataset.date)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.day-cell.is-todo-drop').forEach(item=>item.classList.toggle('is-todo-drop', item===cell));
  });
  $('#weekGrid').addEventListener('dragleave', e=>{
    const cell = e.target.closest('.day-cell');
    if(cell && (!e.relatedTarget || !cell.contains(e.relatedTarget))) cell.classList.remove('is-todo-drop');
  });
  $('#weekGrid').addEventListener('drop', e=>{
    if(!draggedTodoId) return;
    const cell = e.target.closest('.day-cell');
    if(!cell) return;
    e.preventDefault();
    const id = draggedTodoId;
    clearTodoDragState();
    moveTodo(id, cell.dataset.date);
  });
  $('#toggleDefaultTodos').addEventListener('click', ()=>{
    const panel = $('#defaultTodoPanel');
    panel.hidden = !panel.hidden;
    $('#toggleDefaultTodos').setAttribute('aria-expanded', String(!panel.hidden));
    if(!panel.hidden) $('#defaultTodoText').focus();
  });
  $('#addDefaultTodosToday').addEventListener('click', addDefaultTodosToday);
  $('#defaultTodoForm').addEventListener('submit', e=>{
    e.preventDefault();
    addDefaultTodoTemplate($('#defaultTodoText').value, $('#defaultTodoColor').value);
  });
  $('#defaultTodoList').addEventListener('click', e=>{
    const button = e.target.closest('[data-delete-default-todo]');
    if(button) deleteDefaultTodoTemplate(button.dataset.deleteDefaultTodo);
  });

  // concepts
  $('#langTabs').addEventListener('click', e=>{
    const b = e.target.closest('[data-lang]');
    if(b) setLang(b.dataset.lang);
  });
  $('#addConceptCategory').addEventListener('click', addConceptCategory);
  $('#renameConceptCategory').addEventListener('click', renameConceptCategory);
  $('#deleteConceptCategory').addEventListener('click', deleteConceptCategory);
  $('#c-lang').addEventListener('change', ()=>{
    const lang = $('#c-lang').value;
    populateFolderSelect(lang, null);
    saveConcept(false);
    toast(`${conceptCategoryLabel(lang)} 노트로 옮겼어요`);
  });
  $('#c-folder').addEventListener('change', ()=>saveConcept(false));
  $('#newFolder').addEventListener('click', ()=>createFolder(null));
  $('#newConcept').addEventListener('click', newConcept);
  $('#conceptSearch').addEventListener('input', renderConceptList);
  $('#conceptTagFilters').addEventListener('click', e=>{
    const button = e.target.closest('[data-concept-tag]');
    if(button) setConceptTagFilter(button.dataset.conceptTag);
  });
  $('#conceptList').addEventListener('click', e=>{
    const add = e.target.closest('[data-folder-add]');
    const rename = e.target.closest('[data-folder-rename]');
    const del = e.target.closest('[data-folder-delete]');
    const toggle = e.target.closest('[data-folder-toggle]');
    const note = e.target.closest('[data-concept]');
    if(add) createFolder(add.dataset.folderAdd);
    else if(rename) renameFolder(rename.dataset.folderRename);
    else if(del) deleteFolder(del.dataset.folderDelete);
    else if(toggle){
      const id = toggle.dataset.folderToggle;
      if(openFolders.has(id)) openFolders.delete(id); else openFolders.add(id);
      saveOpenFolders(); renderConceptList();
    }else if(note) openConcept(note.dataset.concept);
  });
  $('#conceptList').addEventListener('dragstart', e=>{
    const note = e.target.closest('[data-concept][draggable="true"]');
    const folder = e.target.closest('[data-folder-id][draggable="true"]');
    if(note){
      draggedConceptId = note.dataset.concept;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `concept:${draggedConceptId}`);
      note.classList.add('is-dragging');
      $('#conceptList').classList.add('is-dragging-note');
    }else if(folder){
      draggedFolderId = folder.dataset.folderId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `folder:${draggedFolderId}`);
      folder.classList.add('is-dragging');
      $('#conceptList').classList.add('is-dragging-folder');
    }
  });
  $('#conceptList').addEventListener('dragover', e=>{
    const intent = draggedConceptId ? conceptDropIntent(e)
      : draggedFolderId ? folderDropIntent(e)
      : null;
    if(!intent) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showConceptDropIntent(intent);
  });
  $('#conceptList').addEventListener('dragleave', e=>{
    const target = e.target.closest('[data-concept], [data-drop-folder], [data-folder-root-drop]');
    if(target && (!e.relatedTarget || !target.contains(e.relatedTarget))){
      target.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after', 'is-drop-inside');
    }
  });
  $('#conceptList').addEventListener('drop', e=>{
    if(draggedFolderId){
      const intent = folderDropIntent(e);
      if(!intent) return;
      e.preventDefault();
      const folderId = draggedFolderId;
      clearConceptDragState();
      moveFolderToPosition(folderId, intent.parentId, intent.targetId, intent.position);
      return;
    }
    const intent = draggedConceptId ? conceptDropIntent(e) : null;
    if(!intent) return;
    e.preventDefault();
    const conceptId = draggedConceptId;
    clearConceptDragState();
    moveConceptToPosition(conceptId, intent.folderId, intent.targetId, intent.position);
  });
  $('#conceptList').addEventListener('dragend', clearConceptDragState);
  // input 시점의 ta.value 는 이미 바뀐 값이라, 직전 상태를 따로 들고 있다가 기록한다.
  let typingBaseline = null;
  $('#c-body').addEventListener('beforeinput', ()=>{ typingBaseline = editorSnapshot(); });
  $('#c-body').addEventListener('input', ()=>{
    if(typingBaseline) editHistory.recordTyping(typingBaseline);
    typingBaseline = null;
    schedulePreview(); scheduleSave();
  });
  $('#c-body').addEventListener('scroll', syncConceptPreviewScroll, {passive:true});
  $('#editorFormatbar').addEventListener('mousedown', e=>{
    if(e.target.closest('[data-format]')) e.preventDefault();
  });
  $('#editorFormatbar').addEventListener('click', e=>{
    const button = e.target.closest('[data-format]');
    if(button) applyEditorFormat(button.dataset.format);
  });
  $('#c-body').addEventListener('keydown', e=>{
    if(e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey){
      e.preventDefault();
      const ta = e.currentTarget;
      const edited = indentSelection(
        ta.value,
        ta.selectionStart ?? ta.value.length,
        ta.selectionEnd ?? ta.value.length,
        state.settings.editorTabSize,
        e.shiftKey,
      );
      applyEditorEdit(edited);
      return;
    }
    if(!(e.ctrlKey || e.metaKey)) return;
    // 브라우저 기본 되돌리기는 앱이 value에 대입한 편집을 모르므로 항상 우리 기록을 쓴다.
    if(e.key.toLowerCase() === 'z' && !e.shiftKey && !e.altKey){
      e.preventDefault();
      undoEditorChange();
      return;
    }
    // Ctrl+Alt+아래는 줄 복사. Alt 조합은 아래 서식 단축키로 내려보내지 않는다.
    if(e.altKey){
      if(e.key === 'ArrowDown'){
        e.preventDefault();
        applyEditorFormat('duplicate-line');
      }
      return;
    }
    // Ctrl+D는 브라우저 즐겨찾기라 반드시 막아야 한다.
    if(e.key.toLowerCase() === 'd' && !e.shiftKey){
      e.preventDefault();
      applyEditorFormat('delete-line');
      return;
    }
    const key = e.key.toLowerCase();
    const format = key === 'b' ? 'bold'
      : key === 'i' ? 'italic'
      : key === 'u' ? 'underline'
      : key === 'h' ? 'text-color'
      : e.shiftKey && e.code === 'Period' ? 'superscript'
      : e.shiftKey && e.code === 'Comma' ? 'subscript'
      : e.code === 'Space' ? 'highlight'
      : null;
    if(!format) return;
    e.preventDefault();
    applyEditorFormat(format);
  });
  $('#c-title').addEventListener('input', scheduleSave);
  $('#c-tags').addEventListener('input', scheduleSave);
  $('#c-save').addEventListener('click', ()=>saveConcept(true));
  $('#c-export').addEventListener('click', exportConceptMarkdown);
  $('#c-previewMode').addEventListener('click', ()=>setConceptPreviewOnly(!conceptPreviewOnly));
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
  const versionBadge = $('#appVersion');
  if(versionBadge) versionBadge.textContent = `v${APP_VERSION}`;
  bind();
  setConceptPreviewOnly(conceptPreviewOnly);
  loadSync();
  loadUsageCfg();
  const hadLocal = load();
  await initializeImageStorage();
  document.body.dataset.view = 'problems';
  renderProblems();
  renderConceptList();
  renderSchedule();
  scheduleTodoCutoffRefresh();
  setSyncStatus(isDirty() ? 'dirty' : 'idle', isDirty() ? '저장 안 됨' : '대기');
  if(syncReady()) await initialSync(hadLocal);
  await initializeTeam({
    toast,
    appVersion:APP_VERSION,
    getProblems:()=>state.problems,
    getTodos:()=>state.todos,
  });
  if(location.hash === '#team') switchView('team');
}

function addConceptCategory(){
  if(conceptCategories().length >= MAX_CONCEPT_CATEGORIES){
    toast(`상위 카테고리는 최대 ${MAX_CONCEPT_CATEGORIES}개까지 만들 수 있어요`);
    return;
  }
  const name = prompt('새 상위 카테고리 이름');
  if(!name || !name.trim()) return;
  const item = {id:`category-${uid()}`, name:name.trim().slice(0,20)};
  state.settings.conceptCategories.push(item);
  activeLang = item.id;
  save(); renderConceptList();
}

function renameConceptCategory(){
  const item = conceptCategories().find(category=>category.id===activeLang);
  if(!item) return;
  const name = prompt('상위 카테고리 새 이름', item.name);
  if(!name || !name.trim() || name.trim()===item.name) return;
  item.name = name.trim().slice(0,20);
  save(); renderConceptList();
}

function deleteConceptCategory(){
  if(conceptCategories().length <= 1){ toast('상위 카테고리는 한 개 이상 필요해요'); return; }
  const item = conceptCategories().find(category=>category.id===activeLang);
  if(!item) return;
  const next = conceptCategories().find(category=>category.id!==item.id);
  const noteCount = state.concepts.filter(concept=>concept.lang===item.id).length;
  const folderCount = state.conceptFolders.filter(folder=>folder.lang===item.id).length;
  const detail = noteCount || folderCount
    ? `\n노트 ${noteCount}개와 폴더 ${folderCount}개는 "${next.name}" 카테고리로 이동합니다.` : '';
  if(!confirm(`"${item.name}" 카테고리를 삭제할까요?${detail}`)) return;
  for(const concept of state.concepts) if(concept.lang===item.id) concept.lang = next.id;
  for(const folder of state.conceptFolders) if(folder.lang===item.id) folder.lang = next.id;
  state.settings.conceptCategories = conceptCategories().filter(category=>category.id!==item.id);
  activeLang = next.id;
  if(activeConcept && state.concepts.find(concept=>concept.id===activeConcept)?.lang !== activeLang) closeConceptEditor();
  save(); renderConceptList();
}
boot();
