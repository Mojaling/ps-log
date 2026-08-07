export const MAX_SOLUTION_BYTES = 64 * 1024;

const LANGUAGE_ALIASES = new Map([
  ['cpp', 'cpp'], ['c++', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'],
  ['python', 'python'], ['py', 'python'],
  ['java', 'java'],
]);

export function normalizeSolutionLanguage(value) {
  return LANGUAGE_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
}

export function solutionLanguageLabel(value) {
  return { cpp:'C++', python:'Python', java:'Java' }[normalizeSolutionLanguage(value)] || '';
}

export function solutionByteLength(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

