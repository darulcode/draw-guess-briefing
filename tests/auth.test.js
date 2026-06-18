const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createGameServer } = require('../src/game-server');
const { normalizeEmail, safeNextPath, validateDisplayName, validateEmail, validatePassword } = require('../src/auth-utils');

test('validasi data akun dan redirect lokal', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(validateEmail('salah').ok, false);
  assert.equal(validateEmail('user@example.com').ok, true);
  assert.equal(validatePassword('pendek').ok, false);
  assert.equal(validatePassword('delapan8').ok, true);
  assert.equal(validateDisplayName(' A ').ok, false);
  assert.equal(safeNextPath('/admin'), '/admin');
  assert.equal(safeNextPath('//evil.example'), '/');
  assert.equal(safeNextPath('https://evil.example'), '/');
});

test('signup, login, sesi, proteksi admin, dan Google linking', { timeout: 15000 }, async (context) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'draw-guess-auth-'));
  const dbPath = path.join(temp, 'db.json');
  await fs.writeFile(dbPath, JSON.stringify({ users: [], sessions: [], rooms: [], players: [], rounds: [], answers: [] }));
  let googleOptions = null;
  const googleClient = {
    generateAuthUrl(options) {
      googleOptions = options;
      return `https://accounts.google.test/oauth?state=${encodeURIComponent(options.state)}`;
    },
    async getToken(options) {
      assert.equal(options.code, 'valid-code');
      assert.equal(typeof options.codeVerifier, 'string');
      return { tokens: { id_token: 'verified-id-token' } };
    },
    async verifyIdToken(options) {
      assert.equal(options.idToken, 'verified-id-token');
      assert.equal(options.audience, 'google-client-test');
      return { getPayload: () => ({ sub: 'google-user-1', email: 'host@example.com', email_verified: true, name: 'Host Google', picture: 'https://example.com/avatar.png' }) };
    }
  };
  const game = await createGameServer({
    dbPath,
    port: 0,
    passwordRounds: 4,
    googleClient,
    googleClientId: 'google-client-test',
    googleCallbackUrl: 'http://127.0.0.1/auth/google/callback'
  });
  const address = await game.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await game.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const protectedAdmin = await fetch(`${url}/admin`, { redirect: 'manual' });
  assert.equal(protectedAdmin.status, 302);
  assert.match(protectedAdmin.headers.get('location'), /^\/login\?next=/);

  const invalidOrigin = await fetch(`${url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ displayName: 'Host', email: 'host@example.com', password: 'password-test' })
  });
  assert.equal(invalidOrigin.status, 403);

  const invalidSignup = await fetch(`${url}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'H', email: 'salah', password: 'pendek' })
  });
  assert.equal(invalidSignup.status, 400);

  const signup = await fetch(`${url}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host Email', email: 'Host@Example.com', password: 'password-test', next: '/admin' })
  });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  assert.equal(signupBody.data.user.email, 'host@example.com');
  assert.equal('passwordHash' in signupBody.data.user, false);
  const signupSetCookie = signup.headers.get('set-cookie');
  assert.match(signupSetCookie, /HttpOnly/i);
  assert.match(signupSetCookie, /SameSite=Lax/i);
  const sessionCookie = signupSetCookie.split(';')[0];
  assert.notEqual(game.store.data.users[0].passwordHash, 'password-test');

  const me = await fetch(`${url}/api/auth/me`, { headers: { Cookie: sessionCookie } }).then((response) => response.json());
  assert.equal(me.data.user.displayName, 'Host Email');
  assert.equal(me.data.googleEnabled, true);
  assert.equal((await fetch(`${url}/admin`, { headers: { Cookie: sessionCookie } })).status, 200);

  const duplicate = await fetch(`${url}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host Lagi', email: 'host@example.com', password: 'password-lain' })
  });
  assert.equal(duplicate.status, 400);

  const wrongLogin = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'host@example.com', password: 'password-salah' })
  });
  assert.equal(wrongLogin.status, 401);
  const correctLogin = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'host@example.com', password: 'password-test' })
  });
  assert.equal(correctLogin.status, 200);

  const googleStart = await fetch(`${url}/auth/google?next=/account`, { redirect: 'manual' });
  assert.equal(googleStart.status, 302);
  assert.equal(googleOptions.code_challenge_method, 'S256');
  const stateCookie = googleStart.headers.get('set-cookie').split(';')[0];
  const state = new URL(googleStart.headers.get('location')).searchParams.get('state');
  const googleCallback = await fetch(`${url}/auth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual', headers: { Cookie: stateCookie }
  });
  assert.equal(googleCallback.status, 302);
  assert.equal(googleCallback.headers.get('location'), '/account');
  assert.equal(game.store.data.users.length, 1);
  assert.equal(game.store.data.users[0].googleSub, 'google-user-1');

  const logout = await fetch(`${url}/api/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: '{}'
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${url}/api/auth/me`, { headers: { Cookie: sessionCookie } }).then((response) => response.json());
  assert.equal(afterLogout.data.user, null);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'host@example.com', password: 'selalu-salah' })
    });
    assert.equal(response.status, 401);
  }
  const rateLimited = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'host@example.com', password: 'selalu-salah' })
  });
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.headers.get('retry-after')) > 0);
});
