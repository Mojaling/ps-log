export const SYNC_BOT_IDENTITY = Object.freeze({
  name: 'PS Log Sync Bot',
  email: 'sync@ps-log.invalid',
});

export function buildContentsCommit({message, content, branch, sha, contribution=false}){
  const body = {message, content, branch};
  if(sha) body.sha = sha;
  if(!contribution){
    body.author = {...SYNC_BOT_IDENTITY};
    body.committer = {...SYNC_BOT_IDENTITY};
  }
  return body;
}

function cleanLabel(value){
  return String(value||'').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function eventLabel(event){
  const identity = [cleanLabel(event.site), cleanLabel(event.number)].filter(Boolean).join(' ');
  return identity || cleanLabel(event.title) || '문제';
}

export function contributionCommitMessage(events){
  const valid = Array.isArray(events) ? events.filter(Boolean) : [];
  if(valid.length===1){
    const event = valid[0];
    const label = eventLabel(event);
    if(event.kind==='review'){
      const stage = Number(event.stage);
      return `review: ${label}${Number.isFinite(stage) && stage>0 ? ` (${stage}일차)` : ''}`;
    }
    return `solve: ${label}`;
  }

  const solves = valid.filter(event=>event.kind==='solve').length;
  const reviews = valid.filter(event=>event.kind==='review').length;
  const parts = [];
  if(solves) parts.push(`문제 풀이 ${solves}건`);
  if(reviews) parts.push(`복습 ${reviews}건`);
  return `activity: ${parts.join(' · ') || '문제 풀이 기록'}`;
}
