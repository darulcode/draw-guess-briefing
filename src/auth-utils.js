function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Format email tidak valid.' };
  }
  return { ok: true, email };
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) return { ok: false, error: 'Password minimal 8 karakter.' };
  if (password.length > 72) return { ok: false, error: 'Password maksimal 72 karakter.' };
  return { ok: true, password };
}

function validateDisplayName(value) {
  const displayName = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (displayName.length < 2) return { ok: false, error: 'Nama minimal 2 karakter.' };
  if (displayName.length > 40) return { ok: false, error: 'Nama maksimal 40 karakter.' };
  return { ok: true, displayName };
}

function safeNextPath(value, fallback = '/') {
  const next = String(value ?? '');
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}

module.exports = { normalizeEmail, safeNextPath, validateDisplayName, validateEmail, validatePassword };
