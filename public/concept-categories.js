export const DEFAULT_CONCEPT_CATEGORIES = Object.freeze([
  Object.freeze({id:'cpp', name:'C++'}),
  Object.freeze({id:'java', name:'Java'}),
  Object.freeze({id:'python', name:'Python'}),
  Object.freeze({id:'portfolio', name:'포트폴리오'}),
]);
export const MAX_CONCEPT_CATEGORIES = 6;

export function normalizeConceptCategories(value){
  if(!Array.isArray(value)) return DEFAULT_CONCEPT_CATEGORIES.map(item=>({...item}));
  const seen = new Set();
  const categories = [];
  for(const item of value){
    if(!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim().slice(0, 20);
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    categories.push({id, name});
    if(categories.length === MAX_CONCEPT_CATEGORIES) break;
  }
  return categories.length ? categories : DEFAULT_CONCEPT_CATEGORIES.map(item=>({...item}));
}
