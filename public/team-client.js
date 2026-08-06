const OUTBOX_KEY = 'pslog.team-outbox.v1';
const MAX_OUTBOX = 200;
const EVENT_RETRY_MS = 60_000;
const RANK_ACTIVE_MS = 60_000;
const RANK_BACKGROUND_MS = 5 * 60_000;

let enabled = false;
let joined = false;
let currentView = 'problems';
let appVersion = '';
let notify = () => {};
let flushInFlight = null;
let refreshTimer = null;

function loadOutbox(storage = localStorage) {
  try {
    const values = JSON.parse(storage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(values) ? values.filter(event => event && event.eventId && event.type).slice(-MAX_OUTBOX) : [];
  } catch (_) {
    return [];
  }
}

function saveOutbox(events, storage = localStorage) {
  const next = events.slice(-MAX_OUTBOX);
  if (next.length) storage.setItem(OUTBOX_KEY, JSON.stringify(next));
  else storage.removeItem(OUTBOX_KEY);
}

function canonicalProblem(problem) {
  const site = String(problem?.site || '').trim().toLowerCase();
  const identity = String(problem?.number || problem?.link || problem?.title || '').trim().toLowerCase();
  return `${site}|${identity}`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function status(text, kind = 'idle') {
  const top = document.querySelector('#teamStatus');
  const settings = document.querySelector('#s-teamState');
  if (top) { top.textContent = text; top.dataset.kind = kind; }
  if (settings) { settings.textContent = text; settings.dataset.kind = kind; }
}

async function api(path, options = {}) {
  const response = await fetch(`/__team/${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `팀 서버 오류 (${response.status})`);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

function textCell(row, value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderLeaderboard(data) {
  const title = document.querySelector('#teamTitle');
  const date = document.querySelector('#teamDate');
  const body = document.querySelector('#teamLeaderboardBody');
  if (!body) return;
  if (title) title.textContent = data.team || '팀 랭킹';
  if (date) date.textContent = `${data.date || ''} · 최근 갱신 ${new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' })}`;
  body.replaceChildren();
  for (const member of data.members || []) {
    const row = document.createElement('tr');
    textCell(row, String(member.rank), 'team-rank');
    const person = textCell(row, '', 'team-person');
    if (member.avatarUrl) {
      const avatar = document.createElement('img');
      avatar.src = member.avatarUrl;
      avatar.alt = '';
      avatar.width = 32;
      avatar.height = 32;
      person.append(avatar);
    }
    const names = document.createElement('span');
    const display = document.createElement('b');
    display.textContent = member.name || member.login;
    const login = document.createElement('small');
    login.textContent = `@${member.login}`;
    names.append(display, login);
    person.append(names);
    textCell(row, `${Number(member.score || 0).toLocaleString('ko-KR')}점`, 'team-score');
    textCell(row, `${Number(member.streak || 0)}일`, 'team-streak');
    textCell(row, `문제 ${Number(member.todaySolved || 0)} · 복습 ${Number(member.todayReviewed || 0)}`, 'team-today');
    body.append(row);
  }
  document.querySelector('#teamEmpty').hidden = Boolean((data.members || []).length);
}

function renderMe(data) {
  const panel = document.querySelector('#teamMe');
  if (!panel) return;
  panel.hidden = false;
  panel.querySelector('[data-team-me="name"]').textContent = `${data.member.name} (@${data.member.login})`;
  panel.querySelector('[data-team-me="score"]').textContent = `${Number(data.member.score || 0).toLocaleString('ko-KR')}점`;
  panel.querySelector('[data-team-me="streak"]').textContent = `${Number(data.member.streak || 0)}일`;
  panel.querySelector('[data-team-me="today"]').textContent = `문제 ${data.today.solved} · 복습 ${data.today.reviewed} · 남은 복습 ${data.today.due}`;
  const leaderPanel = document.querySelector('#teamLeaderPanel');
  if (leaderPanel) leaderPanel.hidden = data.member.role !== 'leader';
}

function showLogin(show) {
  const loginPanel = document.querySelector('#teamLoginPanel');
  const rankPanel = document.querySelector('#teamRankPanel');
  const leaderPanel = document.querySelector('#teamLeaderPanel');
  const logout = document.querySelector('#s-teamLogout');
  if (loginPanel) loginPanel.hidden = !show;
  if (rankPanel) rankPanel.hidden = show;
  if (leaderPanel && show) leaderPanel.hidden = true;
  if (logout) logout.hidden = show;
}

async function refreshTeam() {
  if (!enabled || !joined || document.hidden) return;
  try {
    const [me, board] = await Promise.all([api('me'), api('leaderboard')]);
    renderMe(me);
    renderLeaderboard(board);
    status('팀 점수 연결됨', 'ok');
  } catch (error) {
    if (error.status === 401) {
      joined = false;
      showLogin(true);
      status('팀 로그인 필요', 'idle');
      return;
    }
    status('팀 갱신 실패', 'err');
  }
}

async function flushTeamEvents() {
  if (!enabled || !joined) return false;
  if (flushInFlight) return flushInFlight;
  const events = loadOutbox();
  if (!events.length) return true;
  flushInFlight = (async () => {
    try {
      status(`활동 ${events.length}건 전송 중…`, 'busy');
      await api('events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      const sent = new Set(events.map(event => event.eventId));
      saveOutbox(loadOutbox().filter(event => !sent.has(event.eventId)));
      status('팀 점수 연결됨', 'ok');
      await refreshTeam();
      return true;
    } catch (error) {
      if (error.status === 401) {
        joined = false;
        showLogin(true);
        status('팀 로그인 필요', 'idle');
      } else {
        status(`활동 ${events.length}건 전송 대기`, 'err');
      }
      return false;
    }
  })().finally(() => { flushInFlight = null; });
  return flushInFlight;
}

async function queueTeamActivity(type, problem, stage = null) {
  if (!enabled || !joined) return false;
  const event = {
    eventId: crypto.randomUUID(),
    type,
    problemKey: await sha256(canonicalProblem(problem)),
    stage: type === 'review_completed' ? Number(stage) : null,
    reviewOffsets: type === 'problem_failed' && Array.isArray(problem?.reviewOffsets)
      ? problem.reviewOffsets.slice(0, 5).map(Number) : null,
    occurredAt: new Date().toISOString(),
    clientVersion: appVersion,
  };
  const events = loadOutbox();
  events.push(event);
  saveOutbox(events);
  flushTeamEvents();
  return true;
}

async function startLogin(invite = '') {
  try {
    status('GitHub 로그인 준비 중…', 'busy');
    const data = await api('auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite: String(invite || '').trim() }),
    });
    location.assign(data.authorizeUrl);
  } catch (error) {
    status(error.message, 'err');
    notify(error.message);
  }
}

async function logout() {
  try { await api('logout', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }); } catch (_) {}
  joined = false;
  showLogin(true);
  status('팀에서 로그아웃됨', 'idle');
}

async function createLeaderInvite() {
  const button = document.querySelector('#teamCreateInvite');
  const output = document.querySelector('#teamInviteOutput');
  if (!button || !output) return;
  button.disabled = true;
  output.value = '발급 중…';
  try {
    const data = await api('invites', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({maxUses:1, expiresInHours:24, label:'web'}),
    });
    output.value = data.code;
    output.select();
    notify('24시간 동안 한 번 쓸 수 있는 초대 코드를 만들었어요');
  } catch (error) {
    output.value = '';
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (document.hidden || !enabled || !joined) return;
  const delay = currentView === 'team' ? RANK_ACTIVE_MS : RANK_BACKGROUND_MS;
  refreshTimer = setTimeout(async () => {
    await refreshTeam();
    scheduleRefresh();
  }, delay);
}

async function initializeTeam(options = {}) {
  notify = options.toast || notify;
  appVersion = options.appVersion || '';
  const tab = document.querySelector('[data-view="team"]');
  try {
    const config = await api('config');
    enabled = Boolean(config.enabled);
  } catch (_) {
    enabled = false;
  }
  if (tab) tab.hidden = !enabled;
  if (!enabled) {
    status('팀 랭킹 미사용', 'idle');
    return;
  }

  document.querySelector('#teamJoin')?.addEventListener('click', () => startLogin(document.querySelector('#teamInvite')?.value));
  document.querySelector('#s-teamJoin')?.addEventListener('click', () => startLogin(document.querySelector('#s-teamInvite')?.value));
  document.querySelector('#s-teamLogout')?.addEventListener('click', logout);
  document.querySelector('#teamRefresh')?.addEventListener('click', async () => { await flushTeamEvents(); await refreshTeam(); });
  document.querySelector('#teamCreateInvite')?.addEventListener('click', createLeaderInvite);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { flushTeamEvents(); refreshTeam(); }
    scheduleRefresh();
  });
  window.addEventListener('online', () => { flushTeamEvents(); refreshTeam(); });
  window.setInterval(flushTeamEvents, EVENT_RETRY_MS);
  window.addEventListener('pslog:viewchange', event => {
    currentView = event.detail?.view || 'problems';
    if (currentView === 'team') refreshTeam();
    scheduleRefresh();
  });

  try {
    const me = await api('me');
    joined = true;
    showLogin(false);
    renderMe(me);
    status('팀 점수 연결됨', 'ok');
    await flushTeamEvents();
    await refreshTeam();
  } catch (error) {
    joined = false;
    showLogin(true);
    status('팀 로그인 필요', 'idle');
  }

  const hash = location.hash;
  if (hash.startsWith('#team-join=')) {
    const invite = decodeURIComponent(hash.slice('#team-join='.length));
    history.replaceState(null, '', `${location.pathname}${location.search}#team`);
    await startLogin(invite);
  }
  scheduleRefresh();
}

export {
  OUTBOX_KEY,
  canonicalProblem,
  initializeTeam,
  loadOutbox,
  queueTeamActivity,
  saveOutbox,
};
