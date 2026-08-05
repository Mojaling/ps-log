const DB_NAME = 'pslog.images.v1';
const DB_VERSION = 1;
const STORE_NAME = 'images';

function requestResult(request){
  return new Promise((resolve, reject)=>{
    request.addEventListener('success', ()=>resolve(request.result), {once:true});
    request.addEventListener('error', ()=>reject(request.error || new Error('IndexedDB 요청에 실패했습니다')), {once:true});
  });
}

function transactionResult(transaction){
  return new Promise((resolve, reject)=>{
    transaction.addEventListener('complete', ()=>resolve(), {once:true});
    transaction.addEventListener('abort', ()=>reject(transaction.error || new Error('IndexedDB 작업이 취소되었습니다')), {once:true});
    transaction.addEventListener('error', ()=>reject(transaction.error || new Error('IndexedDB 작업에 실패했습니다')), {once:true});
  });
}

export function imageMetadata(images){
  const out = {};
  for(const [id, image] of Object.entries(images || {})){
    if(!image || typeof image !== 'object') continue;
    out[id] = {name:typeof image.name === 'string' ? image.name : '이미지'};
  }
  return out;
}

export function imagePayload(images, cache){
  const out = {};
  for(const [id, image] of Object.entries(images || {})){
    if(!image || typeof image !== 'object') continue;
    const cached = cache instanceof Map ? cache.get(id) : cache && cache[id];
    const data = typeof image.data === 'string' ? image.data : cached && cached.data;
    if(typeof data !== 'string' || !data) continue;
    out[id] = {
      name:typeof image.name === 'string' ? image.name : (cached && cached.name) || '이미지',
      data,
    };
  }
  return out;
}

export function missingImageIds(images, cache){
  const payload = imagePayload(images, cache);
  return Object.keys(images || {}).filter(id=>!payload[id]);
}

export function imageFingerprint(images, cache){
  return Object.entries(images || {}).map(([id, image])=>{
    const cached = cache instanceof Map ? cache.get(id) : cache && cache[id];
    const data = image && typeof image.data === 'string' ? image.data : cached && cached.data;
    return [
      id,
      image && typeof image.name === 'string' ? image.name : (cached && cached.name) || '이미지',
      typeof data === 'string' ? data.length : -1,
      typeof data === 'string' ? data.slice(0, 32) : '',
      typeof data === 'string' ? data.slice(-32) : '',
    ];
  });
}

// 본문이 사진을 가리키는 방법은 두 가지다: 인라인 `![이름](img:<id>)`와 참조형 `[이름]: img:<id>`.
// 미리보기 정리와 사진 청소가 서로 다른 규칙을 쓰면 아직 쓰는 사진을 지우게 되므로 여기서 한 번만 정의한다.
export function referencedImageIds(markdown){
  const ids = new Set();
  for(const match of String(markdown || '').matchAll(/(?:\]\(\s*|\]:\s*)img:([A-Za-z0-9_-]+)/g)) ids.add(match[1]);
  return ids;
}

export function imageRecords(images){
  return Object.entries(images || {}).flatMap(([id, image])=>{
    if(!image || typeof image !== 'object' || typeof image.data !== 'string' || !image.data) return [];
    return [{id, name:typeof image.name === 'string' ? image.name : '이미지', data:image.data}];
  });
}

export function createImageStore(indexedDBApi=globalThis.indexedDB){
  let databasePromise = null;

  function database(){
    if(!indexedDBApi) return Promise.reject(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다'));
    if(databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject)=>{
      const request = indexedDBApi.open(DB_NAME, DB_VERSION);
      request.addEventListener('upgradeneeded', ()=>{
        const db = request.result;
        if(!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, {keyPath:'id'});
      });
      request.addEventListener('success', ()=>resolve(request.result), {once:true});
      request.addEventListener('error', ()=>reject(request.error || new Error('이미지 저장소를 열 수 없습니다')), {once:true});
      request.addEventListener('blocked', ()=>reject(new Error('다른 PS Log 탭을 닫고 다시 시도해 주세요')), {once:true});
    });
    return databasePromise;
  }

  async function getAll(){
    const db = await database();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const done = transactionResult(transaction);
    const records = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    await done;
    return records;
  }

  async function putMany(records){
    if(!records.length) return;
    const db = await database();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    records.forEach(record=>store.put(record));
    await done;
  }

  async function replaceAll(records){
    const db = await database();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    records.forEach(record=>store.put(record));
    await done;
  }

  async function deleteMany(ids){
    if(!ids.length) return;
    const db = await database();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    ids.forEach(id=>store.delete(id));
    await done;
  }

  return {getAll, putMany, replaceAll, deleteMany};
}
