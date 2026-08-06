import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  finalizeDay,
  kstDate,
  normalizeActivity,
  recordActivity,
  safeOrigin,
  streakBonus,
} from '../team-worker/index.js';
import teamWorker from '../team-worker/index.js';

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
  assert.equal(normalizeActivity({...activity('review_completed', '001'), stage:5}), null);
  assert.equal(normalizeActivity({...activity('problem_solved', '002'), problemKey:'title'}), null);
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

test('예정일 전 복습은 점수를 주지 않고 예정일 이후 첫 완료만 +3점이다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const member = {id:1};
  await recordActivity(env, member, activity('problem_failed', '020'));
  assert.equal((await recordActivity(env, member, activity('review_completed', '021', 3))).rejected, 'review_not_due');
  env.DB.sqlite.prepare('UPDATE review_schedules SET due_on = ? WHERE stage = 3').run(kstDate());
  assert.equal((await recordActivity(env, member, activity('review_completed', '022', 3))).awarded, 3);
  assert.equal((await recordActivity(env, member, activity('review_completed', '023', 3))).awarded, 0);
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

test('일일 마감은 성공한 날 연속 보너스를 주고 같은 날짜를 다시 마감하지 않는다', async t => {
  const env = await seeded();
  t.after(() => env.DB.close());
  const day = addDays(kstDate(), -1);
  const now = new Date().toISOString();
  env.DB.sqlite.prepare(`INSERT INTO score_ledger
    (award_key, member_id, kind, points, score_date, note, created_at)
    VALUES('seed-solve', 1, 'solve_award', 3, ?, '', ?)`).run(day, now);
  env.DB.sqlite.prepare('UPDATE members SET score = 1003').run();
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
