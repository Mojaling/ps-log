import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  currentTodoDate,
  finalizeDay,
  kstDate,
  memberProblemSolution,
  memberProblems,
  normalizeActivity,
  normalizeCatalogProblem,
  normalizeProblemMetadata,
  personalAuthRedirect,
  recordActivity,
  safeOrigin,
  safeProblemLink,
  streakBonus,
  syncProblemCatalog,
} from '../team-worker/index.js';
import teamWorker from '../team-worker/index.js';

test('개인 사이트 로그인 코드는 query가 아닌 fragment에 둔다', () => {
  const redirect = new URL(personalAuthRedirect('https://me.example.com', 'secret_code'));
  assert.equal(redirect.search, '');
  assert.equal(redirect.hash, '#team-auth=secret_code');
});

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta:{ changes:Number(result.changes || 0) } };
  }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results:this.db.prepare(this.sql).all(...this.params) }; }
}

class D1TestDatabase {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0001_init.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0002_base_score_and_problem_deletions.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0003_custom_review_schedules.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0004_todo_failures.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0005_shared_problem_metadata.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../migrations/team/0006_shared_solutions.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  close() { this.sqlite.close(); }
}

function activity(type, suffix, stage = null) {
  return {
    eventId:`123e4567-e89b-12d3-a456-426614174${suffix}`,
    type,
    problemKey:'a'.repeat(64),
    stage,
    occurredAt:new Date().toISOString(),
    clientVersion:'1.3.0',
  };
}

async function seeded() {
  const DB = new D1TestDatabase();
  const now = new Date().toISOString();
  DB.sqlite.prepare(`INSERT INTO members
    (github_id, github_login, display_name, role, score_reached_at, joined_at, updated_at)
    VALUES (?, ?, ?, 'leader', ?, ?, ?)`).run('1', 'leader', 'Leader', now, addDays(kstDate(), -2) + 'T00:00:00Z', now);
  return { DB, SESSION_PEPPER:'test-pepper' };
}

test('KST 날짜와 연속 보너스 상한을 계산한다', () => {
  assert.equal(kstDate(new Date('2026-08-05T15:01:00Z')), '2026-08-06');
  assert.equal(addDays('2026-08-06', 21), '2026-08-27');
  assert.deepEqual([1,2,3,4,5,9].map(streakBonus), [2,4,6,8,10,10]);
  assert.equal(currentTodoDate(new Date('2026-08-07T21:59:00Z')), '2026-08-07');
  assert.equal(currentTodoDate(new Date('2026-08-07T23:01:00Z')), '2026-08-08');
});

test('기존 팀원은 마이그레이션 후 기본 점수 1000점을 한 번만 받는다', () => {
  const sqlite = new DatabaseSync(':memory:');
  const now = new Date().toISOString();
  sqlite.exec(readFileSync(new URL('../migrations/team/0001_init.sql', import.meta.url), 'utf8'));
  sqlite.prepare(`INSERT INTO members
    (github_id, github_login, display_name, role, score, score_reached_at, joined_at, updated_at)
    VALUES('7', 'member', 'Member', 'member', 12, ?, ?, ?)`).run(now, now, now);
  const migration = readFileSync(new URL('../migrations/team/0002_base_score_and_problem_deletions.sql', import.meta.url), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare('SELECT score FROM members WHERE id=1').get().score, 1012);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM score_ledger WHERE award_key='base:1'").get().count, 1);
  sqlite.close();
});

test('개인 Worker 원본 주소와 활동 입력을 엄격하게 제한한다', () => {
  assert.equal(safeOrigin('https://me.example.com'), 'https://me.example.com');
  assert.equal(safeOrigin('https://me.example.com/path'), null);
  assert.equal(safeOrigin('javascript:alert(1)'), null);
  assert.ok(normalizeActivity(activity('problem_solved', '000')));
  assert.ok(normalizeActivity(activity('problem_deleted', '003')));
  assert.ok(normalizeActivity({...activity('todo_missed', '007'), activityDate:'2026-08-01'}));
  assert.ok(normalizeActivity({...activity('review_completed', '001'), stage:5}));
  assert.equal(normalizeActivity({...activity('review_completed', '006'), stage:5, activityDate:'2026-02-30'}), null);
  assert.deepEqual(normalizeActivity({...activity('problem_failed', '004'), reviewOffsets:[5,10,25,30]}).reviewOffsets, [5,10,25,30]);
  assert.equal(normalizeActivity({...activity('problem_failed', '005'), reviewOffsets:[1,2,3,4,5,6]}), null);
  assert.equal(normalizeActivity({...activity('problem_solved', '002'), problemKey:'title'}), null);
  assert.equal(safeProblemLink('javascript:alert(1)'), '');
  assert.equal(safeProblemLink('https://user:secret@example.com/problem'), '');
  assert.equal(safeProblemLink('https://example.com/problem#answer'), 'https://example.com/problem');
  assert.deepEqual(normalizeProblemMetadata({site:' BOJ ', number:'1000', title:'A+B', difficulty:'D1'}), {
    site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', link:'',
  });
});

test('문제 메타데이터를 저장하고 로그인한 팀원에게 최근 목록으로 제공한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const solved = normalizeActivity({
    ...activity('problem_solved', '080'),
    activityDate:'2026-08-01',
    problem:{site:'백준', number:'1000', title:'A+B', difficulty:'D1', link:'https://www.acmicpc.net/problem/1000'},
  });
  await recordActivity(env, {id:1}, solved);
  const response = await memberProblems(env, 'leader');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 1);
  assert.deepEqual(data.problems[0], {
    problemKey:'a'.repeat(64),
    status:'solved', site:'백준', number:'1000', title:'A+B', difficulty:'D1',
    link:'https://www.acmicpc.net/problem/1000', hasSolution:false, date:'2026-08-01',
  });
});

test('문제 목록에는 코드 본문을 싣지 않고 풀이 상세 요청에서 한 건만 제공한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  await recordActivity(env, {id:1}, normalizeActivity({
    ...activity('problem_solved', '082'), activityDate:'2026-08-01',
    problem:{site:'BOJ', number:'1000', title:'A+B', difficulty:'D1'},
  }));
  const code = '#include <iostream>\nint main() { return 0; }';
  await syncProblemCatalog(new Request('https://team.example.com/v1/problems/catalog', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({problems:[{
      problemKey:'a'.repeat(64),
      problem:{site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', solutionLanguage:'c++', solutionCode:code},
    }]}),
  }), env, {id:1});

  const list = await (await memberProblems(env, 'leader')).json();
  assert.equal(list.problems[0].hasSolution, true);
  assert.equal('solutionCode' in list.problems[0], false);
  const detail = await memberProblemSolution(env, 'leader', 'a'.repeat(64));
  assert.equal(detail.status, 200);
  const data = await detail.json();
  assert.deepEqual(data.solution, {language:'cpp', code});

  const legacySync = await syncProblemCatalog(new Request('https://team.example.com/v1/problems/catalog', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({problems:[{
      problemKey:'a'.repeat(64), problem:{site:'BOJ', number:'1000', title:'A+B (수정)'},
    }]}),
  }), env, {id:1});
  assert.equal(legacySync.status, 200);
  const afterLegacySync = await (await memberProblemSolution(env, 'leader', 'a'.repeat(64))).json();
  assert.equal(afterLegacySync.solution.code, code);
});

test('공유 풀이 언어와 최대 64KB 용량을 서버에서 검증한다', () => {
  assert.equal(normalizeCatalogProblem({site:'BOJ', title:'A', solutionLanguage:'ruby', solutionCode:'puts 1'}), null);
  assert.equal(normalizeCatalogProblem({site:'BOJ', title:'A', solutionLanguage:'python', solutionCode:'가'.repeat(22000)}), null);
  assert.deepEqual(normalizeCatalogProblem({site:'BOJ', title:'A', solutionLanguage:'py', solutionCode:'print(1)'}), {
    site:'BOJ', number:'', title:'A', difficulty:'', link:'', solutionLanguage:'python', solutionCode:'print(1)',
  });
});

test('팀원의 문제는 최신 10개만 제공한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const insert = env.DB.sqlite.prepare(`INSERT INTO problem_states
    (member_id, problem_key, status, solved_on, updated_at, site, problem_number, title, difficulty, link)
    VALUES(1, ?, 'solved', ?, ?, 'BOJ', ?, ?, 'D1', ?)`);
  for (let index = 1; index <= 12; index += 1) {
    const day = `2026-08-${String(index).padStart(2, '0')}`;
    insert.run(String(index).padStart(64, '0'), day, `${day}T00:00:00.000Z`, String(index), `문제 ${index}`, `https://www.acmicpc.net/problem/${index}`);
  }
  const response = await memberProblems(env, 'leader');
  const data = await response.json();
  assert.equal(data.total, 12);
  assert.equal(data.truncated, true);
  assert.equal(data.problems.length, 10);
  assert.equal(data.problems[0].title, '문제 12');
  assert.equal(data.problems.at(-1).title, '문제 3');
});

test('문제 카탈로그 동기화는 본인의 기존 문제 메타데이터만 갱신한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  await recordActivity(env, {id:1}, normalizeActivity({...activity('problem_solved', '081'), activityDate:'2026-08-01'}));
  const response = await syncProblemCatalog(new Request('https://team.example.com/v1/problems/catalog', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({problems:[{
      problemKey:'a'.repeat(64),
      problem:{site:'SWEA', number:'1213', title:'String', difficulty:'D3', link:'https://example.com/1213'},
    }]}),
  }), env, {id:1});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 1);
  const row = env.DB.sqlite.prepare('SELECT title, difficulty FROM problem_states WHERE member_id=1').get();
  assert.deepEqual({...row}, {title:'String', difficulty:'D3'});
});

test('사용자 지정 복습 일정은 서버에도 같은 날짜로 등록된다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};
  const failed = {...activity('problem_failed', '014'), reviewOffsets:[5,10,25,30], activityDate:'2026-08-01'};
  await recordActivity(env, member, normalizeActivity(failed));
  const schedules = env.DB.sqlite.prepare('SELECT stage, due_on FROM review_schedules ORDER BY stage').all();
  const stages = schedules.map(row=>row.stage);
  assert.deepEqual(stages, [5,10,25,30]);
  assert.deepEqual(schedules.map(row=>row.due_on), ['2026-08-06','2026-08-11','2026-08-26','2026-08-31']);
});

test('실패 일정과 문제 성공 점수는 서버에서 만들고 중복 이벤트를 한 번만 반영한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};
  const failed = await recordActivity(env, member, activity('problem_failed', '010'));
  assert.equal(failed.awarded, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM review_schedules').get().count, 3);

  const solvedEvent = activity('problem_solved', '011');
  assert.equal((await recordActivity(env, member, solvedEvent)).awarded, 3);
  assert.equal((await recordActivity(env, member, solvedEvent)).duplicate, true);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1003);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM score_ledger WHERE kind='solve_award'").get().count, 1);
});

test('서버 일정이 없어도 같은 문제의 하루 첫 복습만 +3점이다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};
  const first = activity('review_completed', '021', 3);
  assert.equal((await recordActivity(env, member, first)).awarded, 3);
  const sameProblemNextStage = await recordActivity(env, member, activity('review_completed', '022', 7));
  assert.equal(sameProblemNextStage.awarded, 0);
  assert.equal(sameProblemNextStage.alreadyAwardedToday, true);
  assert.equal((await recordActivity(env, member, first)).awarded, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1003);
});

test('기존 단계별 복습 점수가 있으면 새 하루 점수를 중복 지급하지 않는다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = kstDate();
  const now = new Date().toISOString();
  env.DB.sqlite.prepare(`INSERT INTO activity_events
    (event_id, member_id, type, problem_key, stage, occurred_at, server_date, client_version, created_at)
    VALUES(?, 1, 'review_completed', ?, 3, ?, ?, '1.3.3', ?)`).run(
    '123e4567-e89b-12d3-a456-426614174090', 'a'.repeat(64), now, day, now,
  );
  env.DB.sqlite.prepare(`INSERT INTO score_ledger
    (award_key, member_id, kind, points, score_date, activity_event_id, note, created_at)
    VALUES('legacy-review', 1, 'review_award', 3, ?, '123e4567-e89b-12d3-a456-426614174090', '', ?)`).run(day, now);
  env.DB.sqlite.prepare('UPDATE members SET score = 1003').run();

  const result = await recordActivity(env, {id:1}, activity('review_completed', '091', 7));
  assert.equal(result.awarded, 0);
  assert.equal(result.alreadyAwardedToday, true);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1003);
});

test('문제 삭제는 해당 문제의 점수를 한 번만 회수하고 재등록을 허용한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};

  assert.equal((await recordActivity(env, member, activity('problem_solved', '030'))).awarded, 3);
  const deletion = activity('problem_deleted', '031');
  assert.equal((await recordActivity(env, member, deletion)).awarded, -3);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1000);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM problem_states').get().count, 0);
  assert.equal((await recordActivity(env, member, deletion)).duplicate, true);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1000);

  assert.equal((await recordActivity(env, member, activity('problem_solved', '032'))).awarded, 3);
  assert.equal((await recordActivity(env, member, activity('problem_deleted', '033'))).awarded, -3);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id = 1').get().score, 1000);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM score_ledger WHERE kind='admin_adjustment'").get().count, 2);
});

test('마감된 미완료 Todo는 항목마다 -5점이며 재전송해도 한 번만 차감한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};
  const day = addDays(kstDate(), -1);
  const first = normalizeActivity({...activity('todo_missed', '040'), activityDate:day});
  const second = normalizeActivity({
    ...activity('todo_missed', '041'),
    problemKey:'b'.repeat(64),
    activityDate:day,
  });

  assert.equal((await recordActivity(env, member, first)).awarded, -5);
  assert.equal((await recordActivity(env, member, first)).awarded, 0);
  assert.equal((await recordActivity(env, member, second)).awarded, -5);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id=1').get().score, 990);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM todo_failures').get().count, 2);
});

test('문제 미등록과 당일 복습 누락은 각각 -5점 차감한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = addDays(kstDate(), -1);
  const now = new Date().toISOString();
  env.DB.sqlite.prepare(`INSERT INTO review_schedules
    (member_id, problem_key, stage, due_on, created_at)
    VALUES(1, ?, 3, ?, ?)`).run('c'.repeat(64), day, now);

  const result = await finalizeDay(env, day);
  assert.equal(result.finalized[0].problemMet, false);
  assert.equal(result.finalized[0].reviewMet, false);
  assert.equal(result.finalized[0].points, -10);
  assert.equal(env.DB.sqlite.prepare('SELECT score FROM members WHERE id=1').get().score, 990);
});

test('복습 누락은 예정일에만 감점하고 다음 날 반복 차감하지 않는다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = addDays(kstDate(), -1);
  const dueDay = addDays(day, -1);
  env.DB.sqlite.prepare(`INSERT INTO review_schedules
    (member_id, problem_key, stage, due_on, created_at)
    VALUES(1, ?, 3, ?, ?)`).run('d'.repeat(64), dueDay, new Date().toISOString());

  const result = await finalizeDay(env, day);
  assert.equal(result.finalized[0].problemMet, false);
  assert.equal(result.finalized[0].reviewMet, true);
  assert.equal(result.finalized[0].points, -5);
});

test('실패로 등록한 문제도 1일 1문제 등록 미션을 달성한다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = addDays(kstDate(), -1);
  const failed = normalizeActivity({...activity('problem_failed', '042'), activityDate:day});
  await recordActivity(env, {id:1}, failed);

  const result = await finalizeDay(env, day);
  assert.equal(result.finalized[0].problemMet, true);
  assert.equal(result.finalized[0].reviewMet, true);
  assert.equal(result.finalized[0].points, 2);
});

test('일일 마감은 성공한 날 연속 보너스를 주고 같은 날짜를 다시 마감하지 않는다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = addDays(kstDate(), -1);
  const solved = normalizeActivity({...activity('problem_solved', '043'), activityDate:day});
  await recordActivity(env, {id:1}, solved);
  const first = await finalizeDay(env, day);
  assert.equal(first.finalized.length, 1);
  assert.equal(first.finalized[0].points, 2);
  assert.equal(env.DB.sqlite.prepare('SELECT score, streak FROM members WHERE id=1').get().score, 1005);
  assert.equal((await finalizeDay(env, day)).finalized.length, 0);
});

test('관리 API는 ADMIN_KEY가 틀리면 초대 코드를 만들지 않는다', async t => {
  const env = await seeded();
  env.ADMIN_KEY = 'right-key';
  env.TEAM_NAME = 'Test Team';
  t.after(() => env.DB.close());
  const response = await teamWorker.fetch(new Request('https://team.example.com/v1/admin/invites', {
    method:'POST', headers:{Authorization:'Bearer wrong-key','Content-Type':'application/json'}, body:'{}',
  }), env);
  assert.equal(response.status, 403);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM invites').get().count, 0);
});
