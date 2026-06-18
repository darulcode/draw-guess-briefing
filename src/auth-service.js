const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const { OAuth2Client } = require('google-auth-library');
const { nanoid } = require('nanoid');
const { hashToken } = require('./game-utils');
const { normalizeEmail, safeNextPath, validateDisplayName, validateEmail, validatePassword } = require('./auth-utils');

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || null,
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleSub)
  };
}

class AuthService {
  constructor(options) {
    this.store = options.store;
    this.passwordRounds = Number(options.passwordRounds ?? 12);
    this.sessionTtlMs = Number(options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000);
    this.cookieName = options.cookieName || 'drawguess_session';
    this.googleStateCookie = 'drawguess_google_state';
    this.googleClientId = String(options.googleClientId || '');
    this.googleCallbackUrl = String(options.googleCallbackUrl || '');
    this.googleClient = options.googleClient || null;
    if (!this.googleClient && this.googleClientId && options.googleClientSecret && this.googleCallbackUrl) {
      this.googleClient = new OAuth2Client(this.googleClientId, options.googleClientSecret, this.googleCallbackUrl);
    }
    this.oauthStates = new Map();
  }

  get googleEnabled() {
    return Boolean(this.googleClient && this.googleClientId && this.googleCallbackUrl);
  }

  async signup({ email, password, displayName }) {
    const checkedEmail = validateEmail(email);
    if (!checkedEmail.ok) return checkedEmail;
    const checkedPassword = validatePassword(password);
    if (!checkedPassword.ok) return checkedPassword;
    const checkedName = validateDisplayName(displayName);
    if (!checkedName.ok) return checkedName;
    if (this.store.data.users.some((user) => normalizeEmail(user.email) === checkedEmail.email)) {
      return { ok: false, error: 'Email sudah terdaftar.' };
    }
    const passwordHash = await bcrypt.hash(checkedPassword.password, this.passwordRounds);
    if (this.store.data.users.some((user) => normalizeEmail(user.email) === checkedEmail.email)) {
      return { ok: false, error: 'Email sudah terdaftar.' };
    }
    const now = new Date().toISOString();
    const user = {
      id: `user_${nanoid(12)}`,
      email: checkedEmail.email,
      displayName: checkedName.displayName,
      passwordHash,
      googleSub: null,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now
    };
    this.store.data.users.push(user);
    await this.store.save();
    return { ok: true, user };
  }

  async login({ email, password }) {
    const normalized = normalizeEmail(email);
    const user = this.store.data.users.find((item) => normalizeEmail(item.email) === normalized);
    if (!user?.passwordHash || !(await bcrypt.compare(String(password ?? ''), user.passwordHash))) {
      return { ok: false, error: 'Email atau password salah.' };
    }
    return { ok: true, user };
  }

  async createSession(userId) {
    const now = Date.now();
    this.store.data.sessions = this.store.data.sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
    const token = nanoid(48);
    this.store.data.sessions.push({
      id: `session_${nanoid(12)}`,
      userId,
      tokenHash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.sessionTtlMs).toISOString()
    });
    await this.store.save();
    return token;
  }

  async destroySession(token) {
    if (!token) return;
    const tokenHash = hashToken(token);
    this.store.data.sessions = this.store.data.sessions.filter((session) => session.tokenHash !== tokenHash);
    await this.store.save();
  }

  sessionToken(cookieHeader) {
    try {
      return cookie.parse(cookieHeader || '')[this.cookieName] || '';
    } catch {
      return '';
    }
  }

  userFromCookieHeader(cookieHeader) {
    const token = this.sessionToken(cookieHeader);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.store.data.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
    return session ? this.store.data.users.find((user) => user.id === session.userId) || null : null;
  }

  sessionCookie(token, secure = false) {
    return cookie.serialize(this.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: Math.floor(this.sessionTtlMs / 1000)
    });
  }

  clearSessionCookie(secure = false) {
    return cookie.serialize(this.cookieName, '', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 });
  }

  beginGoogle(next = '/') {
    if (!this.googleEnabled) return { ok: false, error: 'Login Google belum dikonfigurasi.' };
    const state = nanoid(32);
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    for (const [key, value] of this.oauthStates) if (value.expiresAt <= Date.now()) this.oauthStates.delete(key);
    this.oauthStates.set(state, { codeVerifier, expiresAt, next: safeNextPath(next) });
    const url = this.googleClient.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    });
    return { ok: true, state, url };
  }

  googleStateCookieValue(state, secure = false) {
    return cookie.serialize(this.googleStateCookie, state, { httpOnly: true, sameSite: 'lax', secure, path: '/auth/google', maxAge: 600 });
  }

  clearGoogleStateCookie(secure = false) {
    return cookie.serialize(this.googleStateCookie, '', { httpOnly: true, sameSite: 'lax', secure, path: '/auth/google', maxAge: 0 });
  }

  async finishGoogle({ code, state, cookieHeader }) {
    const cookieState = cookie.parse(cookieHeader || '')[this.googleStateCookie];
    const pending = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!code || !state || !pending || pending.expiresAt <= Date.now() || cookieState !== state) {
      return { ok: false, error: 'Sesi login Google tidak valid atau kedaluwarsa.' };
    }
    const { tokens } = await this.googleClient.getToken({ code, codeVerifier: pending.codeVerifier, redirect_uri: this.googleCallbackUrl });
    if (!tokens.id_token) return { ok: false, error: 'Google tidak mengembalikan identitas pengguna.' };
    const ticket = await this.googleClient.verifyIdToken({ idToken: tokens.id_token, audience: this.googleClientId });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      return { ok: false, error: 'Email Google belum terverifikasi.' };
    }
    const email = normalizeEmail(profile.email);
    let user = this.store.data.users.find((item) => item.googleSub === profile.sub);
    if (!user) user = this.store.data.users.find((item) => normalizeEmail(item.email) === email);
    if (user?.googleSub && user.googleSub !== profile.sub) {
      return { ok: false, error: 'Email ini sudah terhubung ke akun Google lain.' };
    }
    const now = new Date().toISOString();
    if (!user) {
      user = {
        id: `user_${nanoid(12)}`,
        email,
        displayName: String(profile.name || email.split('@')[0]).trim().slice(0, 40),
        passwordHash: null,
        googleSub: profile.sub,
        avatarUrl: /^https:\/\//.test(profile.picture || '') ? profile.picture : null,
        createdAt: now,
        updatedAt: now
      };
      this.store.data.users.push(user);
    } else {
      user.googleSub = profile.sub;
      if (!user.avatarUrl && /^https:\/\//.test(profile.picture || '')) user.avatarUrl = profile.picture;
      user.updatedAt = now;
    }
    await this.store.save();
    return { ok: true, user, next: pending.next };
  }
}

module.exports = { AuthService, publicUser };
