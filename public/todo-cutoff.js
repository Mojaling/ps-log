const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function addIsoDays(iso, days){
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function seoulClock(now){
  const shifted = new Date(now.getTime() + SEOUL_OFFSET_MS);
  return {
    date:shifted.toISOString().slice(0, 10),
    hour:shifted.getUTCHours(),
  };
}

export function currentTodoDate(now=new Date()){
  const clock = seoulClock(now);
  return clock.hour < 8 ? addIsoDays(clock.date, -1) : clock.date;
}

export function isTodoDateClosed(iso, now=new Date()){
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso||'')) && iso < currentTodoDate(now);
}

export function isTodoLocked(todo, now=new Date()){
  return !!todo && isTodoDateClosed(todo.date, now);
}

export function isTodoOverdue(todo, now=new Date()){
  return !!todo && !todo.done && isTodoLocked(todo, now);
}

export function millisecondsUntilNextTodoCutoff(now=new Date()){
  const shifted = new Date(now.getTime() + SEOUL_OFFSET_MS);
  let cutoff = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    8,
  ) - SEOUL_OFFSET_MS;
  if(cutoff <= now.getTime()) cutoff += DAY_MS;
  return cutoff - now.getTime();
}
