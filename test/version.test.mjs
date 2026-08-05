import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../scripts/bump-version.mjs';

test('deployment version rolls from patch 9 to the next minor version', ()=>{
  assert.equal(nextVersion('1.0.0'), '1.0.1');
  assert.equal(nextVersion('1.0.8'), '1.0.9');
  assert.equal(nextVersion('1.0.9'), '1.1.0');
  assert.equal(nextVersion('1.9.9'), '2.0.0');
});
