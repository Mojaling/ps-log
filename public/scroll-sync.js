export function syncedScrollTop(
  sourceScrollTop,
  sourceScrollHeight,
  sourceClientHeight,
  targetScrollHeight,
  targetClientHeight,
) {
  const sourceMax = Math.max(0, Number(sourceScrollHeight) - Number(sourceClientHeight));
  const targetMax = Math.max(0, Number(targetScrollHeight) - Number(targetClientHeight));
  if(sourceMax === 0 || targetMax === 0) return 0;
  const ratio = Math.min(1, Math.max(0, Number(sourceScrollTop) / sourceMax));
  return ratio * targetMax;
}
