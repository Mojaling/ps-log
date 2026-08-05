const LANGUAGE_ALIASES = Object.freeze({
  'c++':'cpp', cplusplus:'cpp', cc:'cpp', cpp:'cpp',
  py:'python', python3:'python', python:'python',
  java:'java',
});

export function normalizeCodeLanguage(language){
  const value = String(language || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[value] || value;
}

export function highlightCodeBlocks(container, prism=globalThis.Prism){
  if(!container || !prism || typeof prism.highlightElement !== 'function') return;
  container.querySelectorAll('pre code').forEach(code=>{
    const languageClass = Array.from(code.classList).find(name=>name.startsWith('language-'));
    if(!languageClass) return;
    const language = normalizeCodeLanguage(languageClass.slice(9));
    if(!prism.languages || !prism.languages[language]) return;
    code.classList.remove(languageClass);
    code.classList.add(`language-${language}`);
    if(code.parentElement){
      code.parentElement.classList.remove(languageClass);
      code.parentElement.classList.add(`language-${language}`);
    }
    prism.highlightElement(code);
  });
}
