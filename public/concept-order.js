const normalizedGroup = value => value || null;
const numericOrder = item => item && item.order !== null && item.order !== '' && Number.isFinite(Number(item.order))
  ? Number(item.order)
  : Number.POSITIVE_INFINITY;

export function sortByOrder(items){
  return [...items].sort((a,b)=> numericOrder(a) - numericOrder(b)
    || String(a.id || '').localeCompare(String(b.id || '')));
}

function seedGroups(items, groupOf, legacyCompare){
  const groups = new Map();
  for(const item of items){
    const group = groupOf(item);
    if(!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for(const siblings of groups.values()){
    siblings.sort((a,b)=>{
      const aOrder = numericOrder(a);
      const bOrder = numericOrder(b);
      if(aOrder !== bOrder) return aOrder - bOrder;
      return legacyCompare(a,b);
    });
    siblings.forEach((item,index)=>{ item.order = index; });
  }
}

export function seedConceptOrders(concepts){
  seedGroups(
    concepts,
    item=>`${item.lang}:${normalizedGroup(item.folderId) || ''}`,
    (a,b)=> String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(a.id || '').localeCompare(String(b.id || '')),
  );
}

export function seedFolderOrders(folders){
  seedGroups(
    folders,
    item=>`${item.lang}:${normalizedGroup(item.parentId) || ''}`,
    (a,b)=> String(a.name || '').localeCompare(String(b.name || ''), 'ko')
      || String(a.id || '').localeCompare(String(b.id || '')),
  );
}

function moveInOrder(items, itemId, nextGroup, targetId, position, groupOf, setGroup){
  const item = items.find(entry=>entry.id===itemId);
  if(!item) return false;
  const oldGroup = groupOf(item);
  const oldOrder = sortByOrder(items.filter(entry=>groupOf(entry)===oldGroup));
  const oldIndex = oldOrder.findIndex(entry=>entry.id===itemId);
  const target = targetId ? items.find(entry=>entry.id===targetId) : null;
  if(targetId && (!target || target.id===item.id || groupOf(target)!==nextGroup)) return false;

  const destination = sortByOrder(items.filter(entry=>entry.id!==item.id && groupOf(entry)===nextGroup));
  let insertAt = destination.length;
  if(target){
    insertAt = destination.findIndex(entry=>entry.id===target.id);
    if(insertAt < 0) return false;
    if(position === 'after') insertAt += 1;
  }
  destination.splice(insertAt, 0, item);
  setGroup(item);

  if(oldGroup !== nextGroup){
    sortByOrder(items.filter(entry=>entry.id!==item.id && groupOf(entry)===oldGroup))
      .forEach((entry,index)=>{ entry.order = index; });
  }
  destination.forEach((entry,index)=>{ entry.order = index; });
  return oldGroup !== nextGroup || oldIndex !== insertAt;
}

export function moveConceptOrder(concepts, conceptId, folderId, targetConceptId=null, position='end'){
  const concept = concepts.find(item=>item.id===conceptId);
  if(!concept) return false;
  const nextFolderId = normalizedGroup(folderId);
  const nextGroup = `${concept.lang}:${nextFolderId || ''}`;
  return moveInOrder(
    concepts,
    conceptId,
    nextGroup,
    targetConceptId,
    position,
    item=>`${item.lang}:${normalizedGroup(item.folderId) || ''}`,
    item=>{ item.folderId = nextFolderId; },
  );
}

export function moveFolderOrder(folders, folderId, parentId, targetFolderId=null, position='end'){
  const folder = folders.find(item=>item.id===folderId);
  if(!folder) return false;
  const nextParentId = normalizedGroup(parentId);
  const nextGroup = `${folder.lang}:${nextParentId || ''}`;
  return moveInOrder(
    folders,
    folderId,
    nextGroup,
    targetFolderId,
    position,
    item=>`${item.lang}:${normalizedGroup(item.parentId) || ''}`,
    item=>{ item.parentId = nextParentId; },
  );
}

export function nextConceptOrder(concepts, lang, folderId=null){
  const group = `${lang}:${normalizedGroup(folderId) || ''}`;
  return concepts.filter(item=>`${item.lang}:${normalizedGroup(item.folderId) || ''}`===group)
    .reduce((max,item)=>Math.max(max, numericOrder(item)), -1) + 1;
}

export function nextFolderOrder(folders, lang, parentId=null){
  const group = `${lang}:${normalizedGroup(parentId) || ''}`;
  return folders.filter(item=>`${item.lang}:${normalizedGroup(item.parentId) || ''}`===group)
    .reduce((max,item)=>Math.max(max, numericOrder(item)), -1) + 1;
}
