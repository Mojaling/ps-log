export function canPlaceFolder(folders, folderId, parentId){
  const folder = folders.find(item=>item.id===folderId);
  const nextParentId = parentId || null;
  if(!folder || folder.id===nextParentId) return false;
  if(!nextParentId) return true;

  let parent = folders.find(item=>item.id===nextParentId);
  if(!parent || parent.lang!==folder.lang) return false;

  const seen = new Set();
  while(parent){
    if(parent.id===folder.id || seen.has(parent.id)) return false;
    seen.add(parent.id);
    parent = parent.parentId
      ? folders.find(item=>item.id===parent.parentId)
      : null;
  }
  return true;
}

export function canMoveFolder(folders, folderId, parentId){
  const folder = folders.find(item=>item.id===folderId);
  if(!folder || (folder.parentId||null)===(parentId||null)) return false;
  return canPlaceFolder(folders, folderId, parentId);
}
