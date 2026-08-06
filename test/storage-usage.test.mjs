import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64EncodedBytes,
  calculateStorageUsage,
  dataUrlPayloadBytes,
  formatBytes,
  utf8Bytes,
} from '../public/storage-usage.js';

test('Base64 사진의 실제 원본 바이트와 GitHub 전송 크기를 계산한다', () => {
  assert.equal(dataUrlPayloadBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(dataUrlPayloadBytes('data:image/png;base64,AQ=='), 1);
  assert.equal(dataUrlPayloadBytes('https://example.com/image.png'), 0);
  assert.equal(base64EncodedBytes(1), 4);
  assert.equal(base64EncodedBytes(3), 4);
  assert.equal(base64EncodedBytes(4), 8);
});

test('현재 data.json과 사진 저장 용량을 UTF-8 기준으로 집계한다', () => {
  const serialized = '{"title":"한글"}\n';
  const metrics = calculateStorageUsage(serialized, [
    'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,AQ==',
  ], 3);
  assert.equal(metrics.dataJsonBytes, utf8Bytes(serialized));
  assert.equal(metrics.githubRequestBytes, base64EncodedBytes(utf8Bytes(serialized)));
  assert.equal(metrics.imageOriginalBytes, 4);
  assert.equal(metrics.availableImages, 2);
  assert.equal(metrics.missingImages, 1);
});

test('용량은 사람이 읽기 쉬운 단위로 표시한다', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.match(formatBytes(1536), /1[.,]5 KB/);
  assert.match(formatBytes(2 * 1024 * 1024), /2 MB/);
});
