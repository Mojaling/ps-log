import test from 'node:test';
import assert from 'node:assert/strict';
import {imageFingerprint, imageMetadata, imagePayload, imageRecords, missingImageIds} from '../public/image-store.js';

test('localStorage용 이미지 상태에서는 Base64 원본을 제거한다', ()=>{
  assert.deepEqual(imageMetadata({
    first:{name:'첫 사진', data:'data:image/png;base64,AAAA'},
    second:{data:'data:image/jpeg;base64,BBBB'},
  }), {
    first:{name:'첫 사진'},
    second:{name:'이미지'},
  });
});

test('GitHub 동기화용 데이터에는 IndexedDB 원본을 다시 합친다', ()=>{
  const cache = new Map([
    ['first', {id:'first', name:'캐시 이름', data:'data:image/png;base64,AAAA'}],
  ]);
  assert.deepEqual(imagePayload({first:{name:'노트 사진'}}, cache), {
    first:{name:'노트 사진', data:'data:image/png;base64,AAAA'},
  });
  assert.deepEqual(missingImageIds({first:{name:'노트 사진'}, lost:{name:'누락'}}, cache), ['lost']);
});

test('기존 localStorage와 원격 JSON 이미지를 IndexedDB 레코드로 변환한다', ()=>{
  assert.deepEqual(imageRecords({first:{name:'사진', data:'data:image/png;base64,AAAA'}}), [
    {id:'first', name:'사진', data:'data:image/png;base64,AAAA'},
  ]);
  assert.deepEqual(imageRecords({metadataOnly:{name:'사진'}}), []);
});

test('동기화 비교값은 큰 Base64 전체를 복사하지 않고 짧은 특징값만 사용한다', ()=>{
  const cache = new Map([['first', {name:'사진', data:'data:image/png;base64,AAAA'}]]);
  assert.deepEqual(imageFingerprint({first:{name:'사진'}}, cache), [
    ['first', '사진', 26, 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
  ]);
});
