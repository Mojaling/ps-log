export const TODO_COLORS = Object.freeze(['blue', 'yellow', 'purple']);

export function normalizeTodoColor(color){
  return TODO_COLORS.includes(color) ? color : TODO_COLORS[0];
}

export function nextTodoColor(color){
  const current = normalizeTodoColor(color);
  return TODO_COLORS[(TODO_COLORS.indexOf(current) + 1) % TODO_COLORS.length];
}
