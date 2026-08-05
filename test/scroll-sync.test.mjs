import test from 'node:test';
import assert from 'node:assert/strict';
import { syncedScrollTop } from '../public/scroll-sync.js';

test('편집창의 스크롤 비율에 맞춰 프리뷰 위치를 계산한다', () => {
  assert.equal(syncedScrollTop(0, 1000, 200, 1800, 200), 0);
  assert.equal(syncedScrollTop(400, 1000, 200, 1800, 200), 800);
  assert.equal(syncedScrollTop(800, 1000, 200, 1800, 200), 1600);
});

test('내용이 짧거나 범위를 벗어난 스크롤 값도 안전하게 처리한다', () => {
  assert.equal(syncedScrollTop(100, 200, 200, 800, 200), 0);
  assert.equal(syncedScrollTop(-100, 1000, 200, 1800, 200), 0);
  assert.equal(syncedScrollTop(2000, 1000, 200, 1800, 200), 1600);
});
