function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Secrets used by the browser are deliberately kept out of persistent storage.
// Existing installations are migrated once so an old localStorage copy is removed.
function loadSessionSecret(persistentStorage, sessionStorage, options) {
  const { persistentKey, sessionKey, secretField } = options;
  const config = parseObject(persistentStorage.getItem(persistentKey));
  const legacySecret = typeof config[secretField] === 'string' ? config[secretField] : '';
  delete config[secretField];

  const secret = sessionStorage.getItem(sessionKey) || legacySecret;
  persistentStorage.setItem(persistentKey, JSON.stringify(config));
  if (secret) sessionStorage.setItem(sessionKey, secret);
  return { config, secret };
}

function saveSessionSecret(persistentStorage, sessionStorage, options) {
  const { persistentKey, sessionKey, secretField, config = {}, secret = '' } = options;
  const safeConfig = { ...config };
  delete safeConfig[secretField];
  persistentStorage.setItem(persistentKey, JSON.stringify(safeConfig));
  if (secret) sessionStorage.setItem(sessionKey, secret);
  else sessionStorage.removeItem(sessionKey);
}

export { loadSessionSecret, saveSessionSecret };
