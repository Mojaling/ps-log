export function normalizeConceptTags(value){
  if(!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for(const raw of value){
    const tag = String(raw || '').trim().slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if(!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function conceptHasTag(concept, tag){
  const key = String(tag || '').trim().toLocaleLowerCase();
  return !!key && normalizeConceptTags(concept && concept.tags).some(item=>item.toLocaleLowerCase()===key);
}

export function collectConceptTags(concepts){
  const collected = new Map();
  for(const concept of concepts || []){
    for(const tag of normalizeConceptTags(concept && concept.tags)){
      const key = tag.toLocaleLowerCase();
      const current = collected.get(key);
      if(current) current.count++;
      else collected.set(key, {key, name:tag, count:1});
    }
  }
  return [...collected.values()].sort((a,b)=>
    b.count-a.count || a.name.localeCompare(b.name, 'ko')
  );
}
