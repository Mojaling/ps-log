export const DEFAULT_REVIEW_OFFSETS = Object.freeze([3, 7, 21]);
export const MAX_REVIEW_COUNT = 5;
export const MAX_REVIEW_DAY = 365;

export function parseReviewOffsets(value){
  const parts = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[\s,]+/).filter(Boolean);
  if(!parts.length) return {ok:false, error:'복습 날짜를 한 개 이상 입력해 주세요.'};
  if(parts.length > MAX_REVIEW_COUNT) return {ok:false, error:`복습은 최대 ${MAX_REVIEW_COUNT}회까지 설정할 수 있어요.`};

  const offsets = parts.map(Number);
  if(offsets.some(day=>!Number.isInteger(day) || day < 1 || day > MAX_REVIEW_DAY)){
    return {ok:false, error:`복습 날짜는 1~${MAX_REVIEW_DAY} 사이의 정수로 입력해 주세요.`};
  }
  if(new Set(offsets).size !== offsets.length) return {ok:false, error:'같은 복습 날짜를 두 번 입력할 수 없어요.'};
  offsets.sort((a,b)=>a-b);
  return {ok:true, offsets};
}

export function normalizeReviewOffsets(value, fallback=DEFAULT_REVIEW_OFFSETS){
  const parsed = parseReviewOffsets(value);
  return parsed.ok ? parsed.offsets : [...fallback];
}

export function inferProblemReviewOffsets(problem, daysBetween){
  const configured = parseReviewOffsets(problem && problem.reviewOffsets);
  if(configured.ok) return configured.offsets;
  const reviews = Array.isArray(problem && problem.reviews) ? problem.reviews : [];
  const inferred = reviews.map((review, index)=>{
    const explicit = Number(review && review.offset);
    if(Number.isInteger(explicit) && explicit >= 1 && explicit <= MAX_REVIEW_DAY) return explicit;
    if(typeof daysBetween === 'function' && problem.attemptDate && review && review.due){
      return daysBetween(problem.attemptDate, review.due);
    }
    return DEFAULT_REVIEW_OFFSETS[index];
  });
  const parsed = parseReviewOffsets(inferred);
  if(parsed.ok) return parsed.offsets;
  return DEFAULT_REVIEW_OFFSETS.slice(0, Math.max(1, Math.min(reviews.length || DEFAULT_REVIEW_OFFSETS.length, MAX_REVIEW_COUNT)));
}

export function buildReviewSchedule(attemptDate, offsets, addDays){
  return normalizeReviewOffsets(offsets).map(offset=>({
    offset,
    due:addDays(attemptDate, offset),
    done:false,
    doneDate:null,
  }));
}
