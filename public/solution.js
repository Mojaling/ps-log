import { normalizeSolutionLanguage, solutionLanguageLabel } from './solution-code.js';

const STORE_KEY = 'pslog.data.v1';
const params = new URLSearchParams(location.hash.slice(1));
const $ = selector => document.querySelector(selector);
let fallbackPath = '/';
let currentCode = '';

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) {
    return '';
  }
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2200);
}

function localSolution(id) {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const problem = (Array.isArray(data.problems) ? data.problems : []).find(item => item?.id === id);
    if (!problem?.solutionCode) return null;
    return {
      owner:'내 풀이',
      problem,
      solution:{ language:problem.solutionLanguage, code:problem.solutionCode },
    };
  } catch (_) {
    return null;
  }
}

async function teamSolution(login, problemKey) {
  const response = await fetch(
    `/__team/members/${encodeURIComponent(login)}/problems/${problemKey}/solution`,
    { credentials:'same-origin', cache:'no-store', headers:{ Accept:'application/json' } },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('팀 로그인이 필요합니다. 목록으로 돌아가 다시 로그인해 주세요.');
    throw new Error(data.message || `풀이를 불러오지 못했습니다. (${response.status})`);
  }
  return { ...data, owner:`${data.member?.name || data.member?.login || '팀원'}님의 풀이` };
}

function render(data) {
  const problem = data.problem || {};
  const language = normalizeSolutionLanguage(data.solution?.language);
  currentCode = String(data.solution?.code || '');
  if (!language || !currentCode) throw new Error('표시할 풀이 코드가 없습니다.');

  $('#solutionOwner').textContent = data.owner || '풀이';
  $('#solutionTitle').textContent = problem.title || [problem.site, problem.number].filter(Boolean).join(' ') || '문제 풀이';
  const meta = $('#solutionMeta');
  meta.replaceChildren();
  for (const value of [[problem.site, problem.number].filter(Boolean).join(' '), problem.difficulty]) {
    if (!value) continue;
    const span = document.createElement('span');
    span.textContent = value;
    meta.append(span);
  }
  const link = safeHttpUrl(problem.link);
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.textContent = '문제 열기 ↗';
    meta.append(anchor);
  }

  $('#solutionLanguage').textContent = solutionLanguageLabel(language);
  const code = $('#solutionCode');
  code.className = `language-${language}`;
  code.textContent = currentCode;
  code.parentElement.className = `solution-pre language-${language}`;
  globalThis.Prism?.highlightElement(code);
  $('#solutionCard').hidden = false;
  $('#solutionState').hidden = true;
  document.title = `${$('#solutionTitle').textContent} 풀이 — PS Log`;
}

async function boot() {
  try {
    const localId = params.get('local');
    const login = params.get('team');
    const problemKey = params.get('problem');
    let data;
    if (localId) {
      data = localSolution(localId);
      if (!data) throw new Error('이 브라우저에서 저장된 풀이 코드를 찾을 수 없습니다.');
    } else if (/^[A-Za-z0-9-]{1,39}$/.test(login || '') && /^[a-f0-9]{64}$/i.test(problemKey || '')) {
      fallbackPath = '/#team';
      data = await teamSolution(login, problemKey.toLowerCase());
    } else {
      throw new Error('풀이 주소가 올바르지 않습니다.');
    }
    render(data);
  } catch (error) {
    $('#solutionState').textContent = error.message || '풀이를 불러오지 못했습니다.';
  }
}

$('#solutionBack').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.assign(fallbackPath);
});

$('#solutionCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentCode);
    toast('코드를 복사했어요');
  } catch (_) {
    toast('복사하지 못했습니다. 브라우저 권한을 확인해 주세요.');
  }
});

void boot();

