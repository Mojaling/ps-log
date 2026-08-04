import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_BOT_IDENTITY,
  buildContentsCommit,
  contributionCommitMessage,
} from '../public/sync-commit.js';

test('일반 동기화 커밋은 GitHub 계정과 연결되지 않은 봇 명의를 사용한다', () => {
  const body = buildContentsCommit({
    message:'sync', content:'e30=', branch:'master', sha:'abc', contribution:false,
  });
  assert.deepEqual(body.author, SYNC_BOT_IDENTITY);
  assert.deepEqual(body.committer, SYNC_BOT_IDENTITY);
  assert.equal(body.sha, 'abc');
});

test('풀이와 복습 커밋은 인증 사용자가 작성하도록 작성자 정보를 생략한다', () => {
  const body = buildContentsCommit({
    message:'solve: BOJ 1000', content:'e30=', branch:'master', contribution:true,
  });
  assert.equal('author' in body, false);
  assert.equal('committer' in body, false);
});

test('풀이·복습 이벤트에 맞는 커밋 메시지를 만든다', () => {
  assert.equal(contributionCommitMessage([
    {kind:'solve', site:'백준', number:'1000', title:'A+B'},
  ]), 'solve: 백준 1000');
  assert.equal(contributionCommitMessage([
    {kind:'review', site:'백준', number:'1000', stage:7},
  ]), 'review: 백준 1000 (7일차)');
  assert.equal(contributionCommitMessage([
    {kind:'solve'}, {kind:'review'}, {kind:'review'},
  ]), 'activity: 문제 풀이 1건 · 복습 2건');
});
