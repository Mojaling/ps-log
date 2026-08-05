import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveConceptOrder,
  moveFolderOrder,
  seedConceptOrders,
  seedFolderOrders,
  sortByOrder,
} from '../public/concept-order.js';

test('기존 노트와 폴더에는 이전 화면 순서대로 정렬값을 만든다', ()=>{
  const concepts = [
    {id:'old', lang:'cpp', folderId:null, updatedAt:'2026-01-01'},
    {id:'new', lang:'cpp', folderId:null, updatedAt:'2026-02-01'},
  ];
  const folders = [
    {id:'b', lang:'cpp', parentId:null, name:'나'},
    {id:'a', lang:'cpp', parentId:null, name:'가'},
  ];
  seedConceptOrders(concepts);
  seedFolderOrders(folders);
  assert.deepEqual(sortByOrder(concepts).map(item=>item.id), ['new','old']);
  assert.deepEqual(sortByOrder(folders).map(item=>item.id), ['a','b']);
});

test('노트를 같은 폴더에서 앞뒤로 정렬하고 다른 폴더 위치로 옮긴다', ()=>{
  const concepts = ['a','b','c'].map((id,order)=>({id,order,lang:'cpp',folderId:null}));
  assert.equal(moveConceptOrder(concepts, 'c', null, 'a', 'before'), true);
  assert.deepEqual(sortByOrder(concepts).map(item=>item.id), ['c','a','b']);
  assert.equal(moveConceptOrder(concepts, 'a', 'folder-1'), true);
  assert.equal(concepts.find(item=>item.id==='a').folderId, 'folder-1');
});

test('폴더도 같은 단계에서 재정렬하거나 다른 폴더 안의 원하는 위치로 옮긴다', ()=>{
  const folders = [
    {id:'a',order:0,lang:'cpp',parentId:null},
    {id:'b',order:1,lang:'cpp',parentId:null},
    {id:'child',order:0,lang:'cpp',parentId:'a'},
  ];
  assert.equal(moveFolderOrder(folders, 'b', null, 'a', 'before'), true);
  assert.deepEqual(sortByOrder(folders.filter(item=>!item.parentId)).map(item=>item.id), ['b','a']);
  assert.equal(moveFolderOrder(folders, 'b', 'a', 'child', 'after'), true);
  assert.deepEqual(sortByOrder(folders.filter(item=>item.parentId==='a')).map(item=>item.id), ['child','b']);
});
