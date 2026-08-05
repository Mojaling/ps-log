// 개념 노트 편집기의 되돌리기 기록.
//
// textarea에는 브라우저가 붙여 주는 되돌리기가 이미 있지만, 자바스크립트가 value에 직접
// 대입하는 순간(서식 적용·표 넣기·줄 삭제 등) 그 기록이 통째로 사라진다. 그래서 앱이
// 바꾼 편집은 Ctrl+Z로 되돌릴 수 없었다. 타이핑과 앱 편집을 한 곳에 모아 기록한다.

export const UNDO_LIMIT = 10;
// 글자 하나마다 한 칸씩 쌓으면 10칸이 몇 글자 만에 차 버린다.
// 치다가 쉰 지점을 한 덩어리의 경계로 본다.
export const TYPING_PAUSE_MS = 600;

export function createEditHistory(limit = UNDO_LIMIT, pauseMs = TYPING_PAUSE_MS){
  const maxEntries = Math.max(1, Math.trunc(Number(limit)) || UNDO_LIMIT);
  const pause = Math.max(0, Math.trunc(Number(pauseMs)) || 0);
  let entries = [];
  let lastTypedAt = 0;

  function normalize(snapshot){
    if(!snapshot || typeof snapshot.value !== 'string') return null;
    const length = snapshot.value.length;
    const start = Math.max(0, Math.min(Number(snapshot.selectionStart) || 0, length));
    const end = Math.max(start, Math.min(Number(snapshot.selectionEnd) || start, length));
    return { value: snapshot.value, selectionStart: start, selectionEnd: end };
  }

  function push(snapshot){
    const entry = normalize(snapshot);
    if(!entry) return;
    const last = entries[entries.length - 1];
    // 내용이 그대로면 되돌릴 것이 없다. 커서만 움직인 것도 기록하지 않는다.
    if(last && last.value === entry.value) return;
    entries.push(entry);
    // 가장 오래된 것부터 버려 항상 최근 maxEntries 개만 남긴다.
    if(entries.length > maxEntries) entries.shift();
  }

  return {
    get size(){ return entries.length; },
    get limit(){ return maxEntries; },

    // 다른 노트를 열면 이전 노트의 기록으로 되돌아가면 안 된다.
    reset(){ entries = []; lastTypedAt = 0; },

    // 서식 적용처럼 한 번에 끝나는 편집. 바꾸기 직전 상태를 반드시 남긴다.
    record(snapshot){
      push(snapshot);
      lastTypedAt = 0;
    },

    // 타이핑. 쉬었다 다시 치기 시작할 때만 한 칸 남긴다.
    recordTyping(snapshot, now = Date.now()){
      if(now - lastTypedAt > pause) push(snapshot);
      lastTypedAt = now;
    },

    // 되돌릴 것이 없으면 null.
    undo(){
      const entry = entries.pop() || null;
      lastTypedAt = 0;
      return entry;
    },
  };
}
