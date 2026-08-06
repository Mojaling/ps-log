import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, nextVersion, versionFromSource } from '../scripts/bump-version.mjs';

test('deployment version rolls from patch 9 to the next minor version', ()=>{
  assert.equal(nextVersion('1.0.0'), '1.0.1');
  assert.equal(nextVersion('1.0.8'), '1.0.9');
  assert.equal(nextVersion('1.0.9'), '1.1.0');
  assert.equal(nextVersion('1.9.9'), '2.0.0');
});

test('deployment version compares the repository release with the local deploy state', ()=>{
  assert.ok(compareVersions('1.3.4', '1.3.3') > 0);
  assert.equal(compareVersions('1.3.3', '1.3.3'), 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
});

test('version.js with unresolved Git conflict markers is rejected before deployment', ()=>{
  assert.equal(versionFromSource("export const APP_VERSION = '1.3.3';"), '1.3.3');
  const conflict = `${'<'.repeat(7)} HEAD
export const APP_VERSION = '1.3.2';
${'='.repeat(7)}
export const APP_VERSION = '1.3.3';
${'>'.repeat(7)} upstream/master`;
  assert.throws(()=>versionFromSource(conflict), /merge conflict markers/);
});
