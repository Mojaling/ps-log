/* =========================================================
   PS Log — 복습 메일 발송 Worker
   매일 KST 08:00에 비공개 저장소의 data.json을 읽어
   오늘 복습할 문제를 메일로 보낸다.
   복습 판정 로직은 public/app.js와 동일하게 유지한다.
   ========================================================= */

const REVIEW_OFFSETS = [3, 7, 21];

// Worker는 UTC로 돈다. cron이 UTC 23시(= KST 08시)에 돌기 때문에
// UTC 날짜를 그대로 쓰면 "어제" 기준으로 목록을 만들게 된다. 한국 날짜로 계산한다.
const KST_OFFSET = 9 * 60 * 60 * 1000;
const todayISO = () => new Date(Date.now() + KST_OFFSET).toISOString().slice(0, 10);

/* ---------- GitHub ---------- */

// atob()은 latin1이라 한글 제목이 깨진다. 바이트로 되돌린 뒤 UTF-8로 디코드한다.
function b64utf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(env, accept) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ps-log-cron',
  };
}

async function readData(env) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 시크릿이 없습니다');
  if (!env.GITHUB_REPO) throw new Error('GITHUB_REPO 변수가 없습니다');

  const path = env.GITHUB_PATH || 'data.json';
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`
            + `?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'master')}`;
  // 응답 본문은 로그로만 남긴다. 호출자에게 그대로 돌려주면 저장소 구성이 새어 나간다.
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) {
    console.error(`GitHub ${res.status}: ${await res.text()}`);
    throw new Error(`GitHub ${res.status}`);
  }

  const j = await res.json();
  if (j.content) return JSON.parse(b64utf8(j.content));

  // 1MB 초과 파일은 content가 비어 온다 → blob API로 원본을 받는다 (app.js와 동일)
  const b = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/blobs/${j.sha}`,
    { headers: ghHeaders(env, 'application/vnd.github.raw') });
  if (!b.ok) {
    console.error(`GitHub blob ${b.status}: ${await b.text()}`);
    throw new Error(`GitHub blob ${b.status}`);
  }
  return JSON.parse(await b.text());
}

/* ---------- 복습 목록 ---------- */

// firstResult === 'fail' 이면서 오늘까지 due가 지났고 아직 안 한 복습을 수집
function collectDue(data, t) {
  const due = [];
  for (const p of data.problems || []) {
    if (!p || typeof p !== 'object' || p.firstResult !== 'fail' || !Array.isArray(p.reviews)) continue;
    const idx = p.reviews.findIndex(r => r && typeof r === 'object'
      && !r.done && typeof r.due === 'string' && r.due <= t);
    if (idx !== -1) due.push({ p, idx, review: p.reviews[idx] });
  }
  return due.sort((a, b) => String(a.review.due).localeCompare(String(b.review.due)));
}

// data.json의 값이 그대로 메일 본문에 들어가므로 이스케이프한다.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 메일에 넣을 링크는 http(s)만 허용한다.
function safeLink(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  let p;
  try { p = new URL(u.trim()); } catch (e) { return null; }
  return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : null;
}

function buildHTML(due, t) {
  const empty = due.length === 0;
  const rows = due.map(({ p, idx, review }, i) => {
    const overdue = review.due < t ? ' (기한 지남)' : '';
    const href = safeLink(p.link);
    const link = href ? `<br><a href="${esc(href)}">${esc(href)}</a>` : '';
    const stage = REVIEW_OFFSETS[idx] ?? (idx + 1);
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${i + 1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee"><b>${esc(p.number)} ${esc(p.title)}</b><br>
        <span style="color:#888;font-size:13px">${esc(p.site)} · ${esc(p.difficulty || '-')} · ${stage}일차${overdue}</span>${link}</td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:system-ui,'Malgun Gothic',sans-serif;max-width:600px">
    <h2 style="color:#4f46e5">${empty ? '✅ PS Log 발송 테스트' : `📚 오늘 복습할 문제 ${due.length}개`}</h2>
    <p style="color:#555">${t} · PS Log 자동 발송</p>
    ${empty
      ? '<p>이 메일이 보이면 메일 설정이 정상입니다. 오늘 복습할 문제는 없습니다.</p>'
      : `<table style="border-collapse:collapse;width:100%">${rows}</table>
         <p style="color:#999;font-size:12px;margin-top:20px">풀고 나면 PS Log에서 복습 완료로 표시하세요. 앱이 알아서 커밋합니다.</p>`}
  </div>`;
}

/* ---------- 메일 발송 ---------- */
// Workers는 raw TCP를 못 열어 SMTP를 쓸 수 없다. HTTP API로 보낸다.
// 도메인을 인증하지 않은 Resend 무료 계정은 onboarding@resend.dev에서
// "가입에 쓴 본인 주소"로만 보낼 수 있다 — 이 앱은 본인에게 보내는 용도라 그대로 맞는다.
async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY 시크릿이 없습니다');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'PS Log <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error(`Resend ${res.status}: ${await res.text()}`);
    throw new Error(`Resend ${res.status}`);
  }
}

/* ---------- 사용량 조회 ---------- */
// 무료 플랜 기준값 (안내용 표시)
const CF_FREE_DAILY_REQUESTS = 100000;

// Resend는 여기서 조회하지 않는다. 발송에 쓰는 키는 Sending access 권한이라
// 발송 외의 API를 부르면 401(restricted_api_key)이 돌아온다. 숫자 한 줄을 보려고
// 키 권한을 Full access로 넓히는 건 손해라, 앱에서는 대시보드 링크만 띄운다.

// Cloudflare는 GraphQL Analytics API로 최근 24시간 요청 수를 본다.
// CF_API_TOKEN(Account Analytics: Read) + CF_ACCOUNT_ID를 넣은 경우에만 동작한다.
async function cloudflareUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { configured: false };
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const query = `query Usage($tag: String!, $script: String!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $tag }) {
      workersInvocationsAdaptive(limit: 10000, filter: {
        scriptName: $script, datetime_geq: $start, datetime_leq: $end
      }) { sum { requests errors subrequests } }
    } }
  }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        tag: env.CF_ACCOUNT_ID,
        script: env.WORKER_NAME || 'ps-log',
        start: start.toISOString(),
        end: end.toISOString(),
      },
    }),
  });
  if (!res.ok) {
    console.error(`Cloudflare usage ${res.status}: ${await res.text()}`);
    return { configured: true, error: `Cloudflare ${res.status}` };
  }
  const j = await res.json();
  if (Array.isArray(j.errors) && j.errors.length) {
    console.error('Cloudflare GraphQL: ' + JSON.stringify(j.errors));
    return { configured: true, error: 'Cloudflare GraphQL 오류 (Worker 로그 확인)' };
  }
  const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  const sum = rows.reduce((acc, r) => ({
    requests: acc.requests + ((r.sum && r.sum.requests) || 0),
    errors: acc.errors + ((r.sum && r.sum.errors) || 0),
    subrequests: acc.subrequests + ((r.sum && r.sum.subrequests) || 0),
  }), { requests: 0, errors: 0, subrequests: 0 });
  return { configured: true, windowHours: 24, ...sum, dailyLimit: CF_FREE_DAILY_REQUESTS };
}

async function usage(env) {
  const cloudflare = await cloudflareUsage(env)
    .catch(e => ({ configured: true, error: String((e && e.message) || e) }));
  return { checkedAt: new Date().toISOString(), cloudflare };
}

/* ---------- 인증 ---------- */
// 길이가 같을 때 조기 반환하지 않는다 (한 글자씩 맞춰 보는 공격을 막는다)
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function authorized(request, url, env) {
  if (!env.CRON_KEY) return false;
  const auth = request.headers.get('Authorization') || '';
  const presented = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : (request.headers.get('X-Cron-Key') || '');
  return timingSafeEqual(presented, env.CRON_KEY);
}

/* ---------- 본체 ---------- */
// force = true 면 복습할 문제가 없어도 한 통 보낸다 (설정 확인용)
async function run(env, force) {
  const data = await readData(env);
  const t = todayISO();
  const due = collectDue(data, t);

  if (due.length === 0 && !force) {
    return '오늘 복습할 문제가 없습니다. 메일을 보내지 않습니다.';
  }

  const to = env.MAIL_TO || (data.settings && data.settings.email);
  if (!to) throw new Error('받는 주소가 없습니다 (MAIL_TO 시크릿 또는 data.json의 settings.email)');

  const subject = due.length
    ? `[PS Log] ${t} 복습할 문제 ${due.length}개`
    : `[PS Log] ${t} 발송 테스트`;
  await sendMail(env, to, subject, buildHTML(due, t));

  return due.length ? `${due.length}개 문제를 메일로 발송했습니다.` : '테스트 메일을 발송했습니다.';
}

export default {
  // 매일 KST 08:00
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      run(env, false).then(
        msg => console.log(msg),
        err => console.error(err && err.stack || String(err)),
      ),
    );
  },

  // 수동 발송과 사용량 조회.
  //   /__cron           오늘 복습할 문제가 있을 때만 발송
  //   /__cron?test=1    없어도 한 통 발송 (설정 확인용)
  //   /__usage          Resend·Cloudflare 사용량 (앱 설정창이 부른다)
  // 인증은 Authorization: Bearer <CRON_KEY> 헤더를 사용한다.
  // 메일 발송은 POST, 사용량 조회는 GET만 허용한다.
  // public/ 안의 정적 파일은 자산 서버가 먼저 응답하므로 여기까지 오지 않는다.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/__cron' && url.pathname !== '/__usage') {
      return new Response('Not found', { status: 404 });
    }
    const allowedMethod = url.pathname === '/__cron' ? 'POST' : 'GET';
    if (request.method !== allowedMethod) {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Allow': allowedMethod },
      });
    }
    if (!authorized(request, url, env)) return new Response('Forbidden', { status: 403 });
    try {
      if (url.pathname === '/__usage') {
        return Response.json(await usage(env), {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response(await run(env, url.searchParams.get('test') === '1'));
    } catch (err) {
      console.error(err && err.stack || String(err));
      return new Response(String((err && err.message) || err), { status: 500 });
    }
  },
};

// Node의 내장 테스트 러너에서 핵심 판정·보안 로직을 직접 검증한다.
export { collectDue, buildHTML, safeLink, timingSafeEqual, authorized };
