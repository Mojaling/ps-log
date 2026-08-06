export const RECOMMENDED_DATA_BYTES = 20 * 1024 * 1024;
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

export function utf8Bytes(value){
  return new TextEncoder().encode(String(value || '')).byteLength;
}

export function base64EncodedBytes(byteLength){
  const size = Math.max(0, Math.trunc(Number(byteLength) || 0));
  return 4 * Math.ceil(size / 3);
}

export function dataUrlPayloadBytes(value){
  const text = String(value || '');
  const comma = text.indexOf(',');
  if(comma < 0 || !/;base64$/i.test(text.slice(0, comma))) return 0;
  const payload = text.slice(comma + 1).replace(/\s/g, '');
  if(!payload) return 0;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

export function calculateStorageUsage(serialized, imageDataUrls = [], totalImageCount = imageDataUrls.length){
  const dataJsonBytes = utf8Bytes(serialized);
  let imageOriginalBytes = 0;
  let imageEmbeddedBytes = 0;
  let availableImages = 0;
  for(const value of imageDataUrls){
    if(typeof value !== 'string' || !value) continue;
    availableImages++;
    imageOriginalBytes += dataUrlPayloadBytes(value);
    imageEmbeddedBytes += utf8Bytes(value);
  }
  return {
    totalImageCount: Math.max(0, Math.trunc(Number(totalImageCount) || 0)),
    availableImages,
    missingImages: Math.max(0, Math.trunc(Number(totalImageCount) || 0) - availableImages),
    imageOriginalBytes,
    imageEmbeddedBytes,
    dataJsonBytes,
    githubRequestBytes: base64EncodedBytes(dataJsonBytes),
  };
}

export function formatBytes(value){
  const bytes = Math.max(0, Number(value) || 0);
  if(bytes < 1024) return `${Math.round(bytes).toLocaleString('ko-KR')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while(size >= 1024 && unit < units.length - 1){ size /= 1024; unit++; }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toLocaleString('ko-KR', {maximumFractionDigits:digits})} ${units[unit]}`;
}
