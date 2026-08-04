import test from 'node:test';
import assert from 'node:assert/strict';
import { canMoveFolder } from '../public/folder-tree.js';

const folders = [
  {id:'root-a', lang:'cpp', parentId:null},
  {id:'child-a', lang:'cpp', parentId:'root-a'},
  {id:'grandchild-a', lang:'cpp', parentId:'child-a'},
  {id:'root-b', lang:'cpp', parentId:null},
  {id:'java-root', lang:'java', parentId:null},
];

test('폴더를 다른 폴더 안이나 최상위로 이동할 수 있다', ()=>{
  assert.equal(canMoveFolder(folders, 'root-b', 'root-a'), true);
  assert.equal(canMoveFolder(folders, 'child-a', null), true);
});

test('자기 자신이나 자신의 하위 폴더 안으로 이동할 수 없다', ()=>{
  assert.equal(canMoveFolder(folders, 'root-a', 'root-a'), false);
  assert.equal(canMoveFolder(folders, 'root-a', 'child-a'), false);
  assert.equal(canMoveFolder(folders, 'root-a', 'grandchild-a'), false);
});

test('다른 언어 폴더 및 현재 위치로는 이동하지 않는다', ()=>{
  assert.equal(canMoveFolder(folders, 'root-a', 'java-root'), false);
  assert.equal(canMoveFolder(folders, 'child-a', 'root-a'), false);
});
