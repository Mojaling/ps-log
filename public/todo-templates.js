import { normalizeTodoColor } from './todo-color.js';

export const MAX_TODO_TEMPLATES = 20;

export function normalizeTodoTemplates(value){
  if(!Array.isArray(value)) return [];
  const seen = new Set();
  const templates = [];
  for(const item of value){
    if(!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const text = String(item.text || '').trim().slice(0, 200);
    if(!id || !text || seen.has(id)) continue;
    seen.add(id);
    templates.push({id, text, color:normalizeTodoColor(item.color)});
    if(templates.length === MAX_TODO_TEMPLATES) break;
  }
  return templates;
}

export function missingTodoTemplatesForDate(templates, todos, date){
  const existing = new Set((todos || []).filter(todo=>todo.date===date && todo.templateId).map(todo=>todo.templateId));
  return normalizeTodoTemplates(templates).filter(template=>!existing.has(template.id));
}
