/* PS Log shared team score server. Personal notes and GitHub tokens never reach this Worker. */

import { DEFAULT_REVIEW_OFFSETS, MAX_REVIEW_DAY, normalizeReviewOffsets, parseReviewOffsets } from '../public/review-schedule.js';
const SESSION_DAYS = 30;
const KST_MS = 9 * 60 * 60 * 1000;
const DEFAULT_MAX_MEMBERS = 30;

function kstDate(value = Date.now()) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function streakBonus(streak) {
  return Math.min(Math.max(0, Number(streak) || 0) * 2, 10);
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  } catch (_) {}
  return null;
}

function normalizeActivity(input) {
  if (!input || typeof input !== 'object') return null;
  const type = String(input.type || '');
  const eventId = String(input.eventId || '');
  const problemKey = String(input.problemKey || '');
  const stage = input.stage == null ? null : Number(input.stage);
  if (!['problem_failed', 'problem_solved', 'problem_deleted', 'review_completed'].includes(type)) return null;
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(eventId)) return null;
  if (!/^[a-f0-9]{64}$/i.test(problemKey)) return null;
  if (type === 'review_completed' && (!Number.isInteger(stage) || stage < 1 || stage > MAX_REVIEW_DAY)) return null;
  const parsedOffsets = type === 'problem_failed' && input.reviewOffsets != null
    ? parseReviewOffsets(input.reviewOffsets) : null;
  if (parsedOffsets && !parsedOffsets.ok) return null;
  const activityDate = input.activityDate == null ? '' : String(input.activityDate);
  if (activityDate && !validISODate(activityDate)) return null;
  return {
    eventId,
    type,
    problemKey: problemKey.toLowerCase(),
    stage: type === 'review_completed' ? stage : null,
    reviewOffsets: type === 'problem_failed'
      ? (parsedOffsets?.offsets || [...DEFAULT_REVIEW_OFFSETS]) : null,
    activityDate,
    occurredAt: typeof input.occurredAt === 'string' ? input.occurredAt.slice(0, 40) : '',
    clientVersion: typeof input.clientVersion === 'string' ? input.clientVersion.slice(0, 40) : '',
  };
}

const nowISO = () => new Date().toISOString();
const plusSeconds = seconds => new Date(Date.now() + seconds * 1000).toISOString();

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function secretHash(value, env) {
  if (!env.SESSION_PEPPER) throw new Error('SESSION_PEPPER secret is not configured');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.SESSION_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value))));
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a || ''));
  const bb = new TextEncoder().encode(String(b || ''));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let index = 0; index < aa.length; index++) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

function problem(status, code, message) {
  return json({ error: code, message }, status);
}

async function readJson(request, maxBytes = 64 * 1024) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('request_too_large');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('request_too_large');
  return text ? JSON.parse(text) : {};
}

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

async function ensureConfig(env) {
  const existing = await env.DB.prepare('SELECT id FROM team_config WHERE id = 1').first();
  if (existing) return;
  const now = nowISO();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO team_config(id, name, season_key, created_at) VALUES(1, ?, ?, ?)',
  ).bind(env.TEAM_NAME || 'PS Log Team', env.SEASON_KEY || kstDate(), now).run();
}

function callbackUrl(env) {
  const base = String(env.TEAM_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('TEAM_PUBLIC_URL must be an https URL');
  return `${base}/v1/auth/callback`;
}

async function prepareOAuth(request, env) {
  const body = await readJson(request);
  const origin = safeOrigin(body.origin);
  if (!origin) return problem(400, 'invalid_origin', '개인 PS Log 주소가 올바르지 않습니다.');

  const invite = String(body.invite || '').trim();
  let inviteHash = null;
  if (invite) {
    inviteHash = await secretHash(invite, env);
    const found = await env.DB.prepare(
      'SELECT code_hash FROM invites WHERE code_hash = ? AND uses < max_uses AND expires_at > ?',
    ).bind(inviteHash, nowISO()).first();
    if (!found) return problem(403, 'invalid_invite', '초대 코드가 만료되었거나 사용할 수 없습니다.');
  }

  const state = randomToken();
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(nowISO()).run();
  await env.DB.prepare(
    'INSERT INTO oauth_states(state_hash, invite_hash, origin, expires_at, created_at) VALUES(?, ?, ?, ?, ?)',
  ).bind(await secretHash(state, env), inviteHash, origin, plusSeconds(600), nowISO()).run();

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', callbackUrl(env));
  url.searchParams.set('state', state);
  return json({ authorizeUrl: url.href });
}

async function githubIdentity(code, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error('GitHub OAuth is not configured');
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'ps-log-team' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env),
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) throw new Error('GitHub OAuth token exchange failed');
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ps-log-team',
    },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user.id || !user.login) throw new Error('GitHub user lookup failed');
  return {
    id: String(user.id),
    login: String(user.login).slice(0, 80),
    name: String(user.name || user.login).slice(0, 80),
    avatar: /^https:\/\//.test(String(user.avatar_url || '')) ? String(user.avatar_url).slice(0, 500) : '',
  };
}

async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!state || !code) return problem(400, 'oauth_cancelled', 'GitHub 로그인이 취소되었습니다.');

  const stateHash = await secretHash(state, env);
  const row = await env.DB.prepare(
    'SELECT state_hash, invite_hash, origin FROM oauth_states WHERE state_hash = ? AND expires_at > ?',
  ).bind(stateHash, nowISO()).first();
  if (!row) return problem(400, 'invalid_state', '로그인 요청이 만료되었습니다. 다시 시도하세요.');
  await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();

  const identity = await githubIdentity(code, env);
  let member = await env.DB.prepare('SELECT * FROM members WHERE github_id = ?').bind(identity.id).first();
  const isNew = !member;
  if (isNew) {
    if (!row.invite_hash) return problem(403, 'invite_required', '처음 참가할 때는 초대 코드가 필요합니다.');
    const invite = await env.DB.prepare(
      'SELECT code_hash FROM invites WHERE code_hash = ? AND uses < max_uses AND expires_at > ?',
    ).bind(row.invite_hash, nowISO()).first();
    if (!invite) return problem(403, 'invalid_invite', '초대 코드가 만료되었거나 이미 사용되었습니다.');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM members').first();
    const maxMembers = Math.min(100, Math.max(1, Number(env.MAX_MEMBERS || DEFAULT_MAX_MEMBERS)));
    if (Number(count?.count || 0) >= maxMembers) {
      return problem(409, 'team_full', `팀 정원 ${maxMembers}명이 모두 찼습니다.`);
    }
    const role = Number(count?.count || 0) === 0 ? 'leader' : 'member';
    const now = nowISO();
    await env.DB.prepare(
      `INSERT INTO members(github_id, github_login, display_name, avatar_url, role, score, score_reached_at, joined_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 1000, ?, ?, ?)`,
    ).bind(identity.id, identity.login, identity.name, identity.avatar, role, now, now, now).run();
    member = await env.DB.prepare('SELECT * FROM members WHERE github_id = ?').bind(identity.id).first();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO score_ledger
       (award_key, member_id, kind, points, score_date, activity_event_id, note, created_at)
       VALUES(?, ?, 'admin_adjustment', 1000, ?, NULL, 'starting_score', ?)`,
    ).bind(`base:${member.id}`, member.id, kstDate(), now).run();
    await env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE code_hash = ?').bind(row.invite_hash).run();
  } else {
    await env.DB.prepare(
      'UPDATE members SET github_login = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?',
    ).bind(identity.login, identity.name, identity.avatar, nowISO(), member.id).run();
  }
  if (member.status !== 'active') return problem(403, 'member_disabled', '참가가 중지된 계정입니다.');

  await env.DB.prepare(
    'INSERT OR IGNORE INTO member_origins(member_id, origin, created_at) VALUES(?, ?, ?)',
  ).bind(member.id, row.origin, nowISO()).run();
  const authCode = randomToken();
  await env.DB.prepare(
    'INSERT INTO auth_codes(code_hash, member_id, origin, expires_at, created_at) VALUES(?, ?, ?, ?, ?)',
  ).bind(await secretHash(authCode, env), member.id, row.origin, plusSeconds(120), nowISO()).run();
  const redirect = new URL('/__team/auth/callback', row.origin);
  redirect.searchParams.set('code', authCode);
  return Response.redirect(redirect.href, 302);
}

async function exchangeCode(request, env) {
  const body = await readJson(request);
  const origin = safeOrigin(body.origin);
  const code = String(body.code || '');
  if (!origin || !code) return problem(400, 'invalid_exchange', '로그인 교환 요청이 올바르지 않습니다.');
  const codeHash = await secretHash(code, env);
  const row = await env.DB.prepare(
    'SELECT code_hash, member_id FROM auth_codes WHERE code_hash = ? AND origin = ? AND expires_at > ?',
  ).bind(codeHash, origin, nowISO()).first();
  if (!row) return problem(400, 'expired_code', '로그인 코드가 만료되었습니다. 다시 로그인하세요.');
  await env.DB.prepare('DELETE FROM auth_codes WHERE code_hash = ?').bind(codeHash).run();
  const token = randomToken();
  const now = nowISO();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash, member_id, origin, expires_at, last_seen_at, created_at) VALUES(?, ?, ?, ?, ?, ?)',
  ).bind(await secretHash(token, env), row.member_id, origin, plusSeconds(SESSION_DAYS * 86400), now, now).run();
  return json({ token, expiresIn: SESSION_DAYS * 86400 });
}

async function authenticated(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const origin = safeOrigin(request.headers.get('X-PSLog-Origin'));
  if (!token || !origin) return null;
  const row = await env.DB.prepare(
    `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.origin = ? AND s.expires_at > ? AND m.status = 'active'`,
  ).bind(await secretHash(token, env), origin, nowISO()).first();
  return row || null;
}

async function award(env, memberId, awardKey, kind, points, day, eventId = null, note = '') {
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO score_ledger(award_key, member_id, kind, points, score_date, activity_event_id, note, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(awardKey, memberId, kind, points, day, eventId, note, nowISO()).run();
  if (!changes(inserted)) return false;
  await env.DB.prepare(
    'UPDATE members SET score = score + ?, score_reached_at = ?, updated_at = ? WHERE id = ?',
  ).bind(points, nowISO(), nowISO(), memberId).run();
  return true;
}

async function recordProblemDeletion(env, member, activity, day) {
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO problem_deletions
     (event_id, member_id, problem_key, occurred_at, server_date, client_version, processed_at, created_at)
     VALUES(?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(activity.eventId, member.id, activity.problemKey, activity.occurredAt,
    day, activity.clientVersion, nowISO()).run();
  const duplicate = !changes(inserted);
  if (duplicate) {
    const existing = await env.DB.prepare(
      'SELECT processed_at FROM problem_deletions WHERE event_id = ? AND member_id = ?',
    ).bind(activity.eventId, member.id).first();
    if (existing?.processed_at) {
      return { eventId: activity.eventId, duplicate: true, awarded: 0, revoked: 0 };
    }
  }

  const activeAwards = await env.DB.prepare(
    `SELECT l.award_key, l.points
     FROM score_ledger l
     JOIN activity_events a ON a.event_id = l.activity_event_id
     WHERE l.member_id = ? AND a.member_id = ? AND a.problem_key = ?
       AND l.kind IN ('solve_award', 'review_award') AND l.points > 0
       AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal
         WHERE reversal.award_key = 'reversal:' || l.award_key
       )
     ORDER BY l.id`,
  ).bind(member.id, member.id, activity.problemKey).all();

  let revoked = 0;
  for (const original of activeAwards.results || []) {
    const points = Math.max(0, Number(original.points) || 0);
    if (!points) continue;
    const reversed = await award(env, member.id, `reversal:${original.award_key}`,
      'admin_adjustment', -points, day, activity.eventId, `problem_deleted:${activity.problemKey}`);
    if (reversed) revoked += points;
  }

  await env.DB.prepare(
    'DELETE FROM review_schedules WHERE member_id = ? AND problem_key = ?',
  ).bind(member.id, activity.problemKey).run();
  await env.DB.prepare(
    'DELETE FROM problem_states WHERE member_id = ? AND problem_key = ?',
  ).bind(member.id, activity.problemKey).run();
  await env.DB.prepare(
    'UPDATE problem_deletions SET processed_at = ? WHERE event_id = ? AND member_id = ?',
  ).bind(nowISO(), activity.eventId, member.id).run();

  return { eventId: activity.eventId, duplicate, awarded: -revoked, revoked };
}

async function recordActivity(env, member, activity) {
  const serverDay = kstDate();
  const day = activity.activityDate && activity.activityDate <= serverDay ? activity.activityDate : serverDay;
  if (activity.type === 'problem_deleted') {
    return recordProblemDeletion(env, member, activity, day);
  }
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO activity_events(event_id, member_id, type, problem_key, stage, occurred_at, server_date, client_version, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(activity.eventId, member.id, activity.type, activity.problemKey, activity.stage,
    activity.occurredAt, serverDay, activity.clientVersion, nowISO()).run();
  const duplicate = !changes(inserted);
  if (duplicate && activity.type !== 'review_completed') {
    return { eventId: activity.eventId, duplicate: true, awarded: 0 };
  }

  if (activity.type === 'problem_failed') {
    const state = await env.DB.prepare(
      'SELECT status FROM problem_states WHERE member_id = ? AND problem_key = ?',
    ).bind(member.id, activity.problemKey).first();
    if (!state) {
      await env.DB.prepare(
        `INSERT INTO problem_states(member_id, problem_key, status, first_failed_on, updated_at)
         VALUES(?, ?, 'failed', ?, ?)`,
      ).bind(member.id, activity.problemKey, day, nowISO()).run();
      await env.DB.batch(normalizeReviewOffsets(activity.reviewOffsets).map(stage => env.DB.prepare(
        `INSERT OR IGNORE INTO review_schedules(member_id, problem_key, stage, due_on, created_at)
         VALUES(?, ?, ?, ?, ?)`,
      ).bind(member.id, activity.problemKey, stage, addDays(day, stage), nowISO())));
    }
    return { eventId: activity.eventId, duplicate: false, awarded: 0 };
  }

  if (activity.type === 'problem_solved') {
    const previous = await env.DB.prepare(
      'SELECT status FROM problem_states WHERE member_id = ? AND problem_key = ?',
    ).bind(member.id, activity.problemKey).first();
    await env.DB.prepare(
      `INSERT INTO problem_states(member_id, problem_key, status, solved_on, updated_at)
       VALUES(?, ?, 'solved', ?, ?)
       ON CONFLICT(member_id, problem_key) DO UPDATE SET status = 'solved', solved_on = COALESCE(problem_states.solved_on, excluded.solved_on), updated_at = excluded.updated_at`,
    ).bind(member.id, activity.problemKey, day, nowISO()).run();
    const granted = previous?.status === 'solved' ? false : await award(env, member.id,
      `solve:${member.id}:${activity.problemKey}:${activity.eventId}`,
      'solve_award', 3, day, activity.eventId);
    return { eventId: activity.eventId, duplicate: false, awarded: granted ? 3 : 0 };
  }

  await env.DB.prepare(
    `UPDATE review_schedules SET completed_on = ?, completed_event_id = ?
     WHERE member_id = ? AND problem_key = ? AND stage = ? AND completed_on IS NULL`,
  ).bind(day, activity.eventId, member.id, activity.problemKey, activity.stage).run();

  const existingReview = await env.DB.prepare(
    `SELECT l.id FROM score_ledger l
     JOIN activity_events a ON a.event_id = l.activity_event_id
     WHERE l.member_id = ? AND a.member_id = ? AND a.problem_key = ?
       AND l.kind = 'review_award' AND l.score_date = ?
       AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal
         WHERE reversal.award_key = 'reversal:' || l.award_key
       ) LIMIT 1`,
  ).bind(member.id, member.id, activity.problemKey, day).first();
  if (existingReview) return { eventId: activity.eventId, duplicate, awarded: 0, alreadyAwardedToday: true };

  const granted = await award(env, member.id,
    `review-day:${member.id}:${activity.problemKey}:${day}`,
    'review_award', 3, day, activity.eventId);
  return { eventId: activity.eventId, duplicate, awarded: granted ? 3 : 0 };
}

async function activities(request, env, member) {
  const body = await readJson(request, 128 * 1024);
  const values = Array.isArray(body.events) ? body.events : [body];
  if (!values.length || values.length > 50) return problem(400, 'invalid_events', '활동은 한 번에 1~50개만 보낼 수 있습니다.');
  const normalized = values.map(normalizeActivity);
  if (normalized.some(value => !value)) return problem(400, 'invalid_event', '활동 데이터 형식이 올바르지 않습니다.');
  const results = [];
  for (const activity of normalized) results.push(await recordActivity(env, member, activity));
  return json({ results, serverDate: kstDate() });
}

async function meResponse(env, member) {
  const today = kstDate();
  const activity = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN l.kind = 'solve_award' AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal WHERE reversal.award_key = 'reversal:' || l.award_key
       ) THEN 1 ELSE 0 END) AS solved,
       SUM(CASE WHEN l.kind = 'review_award' AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal WHERE reversal.award_key = 'reversal:' || l.award_key
       ) THEN 1 ELSE 0 END) AS reviewed
     FROM score_ledger l WHERE l.member_id = ? AND l.score_date = ?`,
  ).bind(member.id, today).first();
  const due = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM review_schedules WHERE member_id = ? AND due_on <= ? AND completed_on IS NULL',
  ).bind(member.id, today).first();
  return json({
    member: {
      login: member.github_login,
      name: member.display_name,
      avatarUrl: member.avatar_url,
      role: member.role,
      score: member.score,
      streak: member.streak,
    },
    today: { date: today, solved: Number(activity?.solved || 0), reviewed: Number(activity?.reviewed || 0), due: Number(due?.count || 0) },
  });
}

async function leaderboard(env) {
  const today = kstDate();
  const result = await env.DB.prepare(
    `SELECT m.github_login AS login, m.display_name AS name, m.avatar_url AS avatarUrl,
       m.score, m.streak, m.score_reached_at AS scoreReachedAt,
       COALESCE(SUM(CASE WHEN l.score_date = ? AND l.kind = 'solve_award' AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal WHERE reversal.award_key = 'reversal:' || l.award_key
       ) THEN 1 ELSE 0 END), 0) AS todaySolved,
       COALESCE(SUM(CASE WHEN l.score_date = ? AND l.kind = 'review_award' AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal WHERE reversal.award_key = 'reversal:' || l.award_key
       ) THEN 1 ELSE 0 END), 0) AS todayReviewed
     FROM members m LEFT JOIN score_ledger l ON l.member_id = m.id
     WHERE m.status = 'active'
     GROUP BY m.id
     ORDER BY m.score DESC, m.streak DESC, m.score_reached_at ASC, m.github_login ASC
     LIMIT 30`,
  ).bind(today, today).all();
  return json({
    team: env.TEAM_NAME || 'PS Log Team',
    date: today,
    members: (result.results || []).map((row, index) => ({
      rank: index + 1,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatarUrl,
      score: Number(row.score || 0),
      streak: Number(row.streak || 0),
      todaySolved: Number(row.todaySolved || 0),
      todayReviewed: Number(row.todayReviewed || 0),
    })),
  });
}

async function finalizeDay(env, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid day');
  const members = await env.DB.prepare(
    `SELECT * FROM members WHERE status = 'active'
     AND substr(datetime(joined_at, '+9 hours'), 1, 10) < ? ORDER BY id`,
  ).bind(day).all();
  const finalized = [];
  for (const member of members.results || []) {
    const exists = await env.DB.prepare(
      'SELECT member_id FROM daily_results WHERE member_id = ? AND day = ?',
    ).bind(member.id, day).first();
    if (exists) continue;
    const solved = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM score_ledger
       WHERE member_id = ? AND score_date = ? AND kind = 'solve_award'
       AND NOT EXISTS (
         SELECT 1 FROM score_ledger reversal
         WHERE reversal.award_key = 'reversal:' || score_ledger.award_key
       )`,
    ).bind(member.id, day).first();
    const due = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM review_schedules
       WHERE member_id = ? AND due_on <= ? AND (completed_on IS NULL OR completed_on >= ?)`,
    ).bind(member.id, day, day).first();
    const outstanding = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM review_schedules
       WHERE member_id = ? AND due_on <= ? AND (completed_on IS NULL OR completed_on > ?)`,
    ).bind(member.id, day, day).first();
    const completedDue = Math.max(0, Number(due?.count || 0) - Number(outstanding?.count || 0));
    const missionMet = Number(solved?.count || 0) > 0 && Number(outstanding?.count || 0) === 0;
    const nextStreak = missionMet ? Number(member.streak || 0) + 1 : 0;
    const points = missionMet ? streakBonus(nextStreak) : -5;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO daily_results(member_id, day, solved_count, due_count, completed_due_count, mission_met, streak, points, finalized_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(member.id, day, Number(solved?.count || 0), Number(due?.count || 0), completedDue,
      missionMet ? 1 : 0, nextStreak, points, nowISO()).run();
    await award(env, member.id, `daily:${member.id}:${day}`,
      missionMet ? 'streak_bonus' : 'daily_penalty', points, day, null,
      missionMet ? `연속 ${nextStreak}일 달성` : '일일 미션 미달성');
    await env.DB.prepare('UPDATE members SET streak = ?, updated_at = ? WHERE id = ?')
      .bind(nextStreak, nowISO(), member.id).run();
    finalized.push({ memberId: member.id, missionMet, points, streak: nextStreak });
  }
  return { day, finalized };
}

async function finalizeRecentDays(env, count = 7) {
  const results = [];
  const yesterday = addDays(kstDate(), -1);
  for (let offset = Math.max(1, Number(count) || 1) - 1; offset >= 0; offset--) {
    results.push(await finalizeDay(env, addDays(yesterday, -offset)));
  }
  return results;
}

function adminAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return Boolean(env.ADMIN_KEY) && auth.startsWith('Bearer ') && timingSafeEqual(auth.slice(7), env.ADMIN_KEY);
}

async function createInvite(request, env) {
  const body = await readJson(request);
  const hours = Math.min(168, Math.max(1, Number(body.expiresInHours || 24)));
  const maxUses = Math.min(30, Math.max(1, Number(body.maxUses || 1)));
  const code = `psl_${randomToken(12)}`;
  await env.DB.prepare(
    'INSERT INTO invites(code_hash, label, max_uses, expires_at, created_at) VALUES(?, ?, ?, ?, ?)',
  ).bind(await secretHash(code, env), String(body.label || '').slice(0, 80), maxUses,
    plusSeconds(hours * 3600), nowISO()).run();
  return json({ code, expiresInHours: hours, maxUses }, 201);
}

async function route(request, env) {
  if (!env.DB) return problem(503, 'database_not_configured', 'D1 binding DB가 없습니다.');
  await ensureConfig(env);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/v1/health') {
    return json({ ok: true, team: env.TEAM_NAME || 'PS Log Team', date: kstDate() });
  }
  if (request.method === 'POST' && path === '/v1/auth/prepare') return prepareOAuth(request, env);
  if (request.method === 'GET' && path === '/v1/auth/callback') return oauthCallback(request, env);
  if (request.method === 'POST' && path === '/v1/auth/exchange') return exchangeCode(request, env);

  if (path.startsWith('/v1/admin/')) {
    if (!adminAuthorized(request, env)) return problem(403, 'forbidden', '관리자 키가 올바르지 않습니다.');
    if (request.method === 'POST' && path === '/v1/admin/invites') return createInvite(request, env);
    if (request.method === 'POST' && path === '/v1/admin/finalize') {
      const body = await readJson(request);
      return json(await finalizeDay(env, String(body.day || addDays(kstDate(), -1))));
    }
    return problem(404, 'not_found', '관리 API를 찾을 수 없습니다.');
  }

  const member = await authenticated(request, env);
  if (!member) return problem(401, 'unauthorized', '팀 로그인이 필요합니다.');
  if (request.method === 'GET' && path === '/v1/me') return meResponse(env, member);
  if (request.method === 'GET' && path === '/v1/leaderboard') return leaderboard(env);
  if (request.method === 'POST' && path === '/v1/activities') return activities(request, env, member);
  if (request.method === 'POST' && path === '/v1/leader/invites') {
    if (member.role !== 'leader') return problem(403, 'leader_required', '팀장 권한이 필요합니다.');
    return createInvite(request, env);
  }
  if (request.method === 'POST' && path === '/v1/logout') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await secretHash(token, env)).run();
    return json({ ok: true });
  }
  return problem(404, 'not_found', 'API를 찾을 수 없습니다.');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error?.stack || String(error));
      const message = error?.message === 'request_too_large' ? '요청이 너무 큽니다.' : '팀 서버 처리 중 오류가 발생했습니다.';
      return problem(error?.message === 'request_too_large' ? 413 : 500, 'server_error', message);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(finalizeRecentDays(env, 7).catch(error => console.error(error?.stack || String(error))));
  },
};

export { addDays, finalizeDay, finalizeRecentDays, kstDate, normalizeActivity, recordActivity, safeOrigin, streakBonus, timingSafeEqual, validISODate };
