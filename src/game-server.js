const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { AuthService, publicUser } = require('./auth-service');
const { safeNextPath } = require('./auth-utils');
const { JsonStore } = require('./store');
const {
  canTransition,
  getDrawerScore,
  getPointsByRank,
  hashToken,
  isAdminUsername,
  leaderboard,
  normalizeAnswer,
  safeTokenEquals,
  sanitizeStroke,
  selectDrawer,
  validateName
} = require('./game-utils');

function privateLanAddresses() {
  const virtual = /virtual|vmware|vbox|hyper-v|loopback|wsl/i;
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== 'IPv4' || item.internal || virtual.test(name)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) addresses.push({ name, address: item.address });
    }
  }
  addresses.sort((left, right) => {
    const priority = (entry) => {
      if (/wi-?fi|wlan|wireless/i.test(entry.name)) return 0;
      if (/^192\.168\.56\./.test(entry.address)) return 3;
      if (/ethernet|lan/i.test(entry.name)) return 1;
      return 2;
    };
    return priority(left) - priority(right);
  });
  return [...new Set(addresses.map((entry) => entry.address))];
}

function createRoomId(store) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = String(Math.floor(100000 + Math.random() * 900000));
    if (!store.room(id)) return id;
  }
  throw new Error('Tidak dapat membuat Room ID unik. Coba lagi.');
}

function publicPlayer(player, includeScore = false) {
  return { id: player.id, name: player.name, ...(includeScore ? { score: player.score } : {}) };
}

async function createGameServer(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const countdownMs = Number(options.countdownMs ?? 3000);
  const tickMs = Number(options.tickMs ?? 1000);
  const publicMinPlayers = Math.max(4, Number(options.publicMinPlayers ?? process.env.PUBLIC_MIN_PLAYERS ?? 4));
  const publicRoomCapacity = Math.max(publicMinPlayers, Number(options.publicRoomCapacity ?? process.env.PUBLIC_ROOM_CAPACITY ?? 8));
  const publicMaxRound = Math.min(Math.max(Number(options.publicMaxRound ?? process.env.PUBLIC_MAX_ROUND ?? 5), 1), 20);
  const publicRoundDuration = Math.min(Math.max(Number(options.publicRoundDuration ?? process.env.PUBLIC_ROUND_DURATION ?? 60), 15), 300);
  const publicResultMs = Math.max(0, Number(options.publicResultMs ?? process.env.PUBLIC_RESULT_MS ?? 7000));
  const publicFinalMs = Math.max(0, Number(options.publicFinalMs ?? process.env.PUBLIC_FINAL_MS ?? 12000));
  const store = await new JsonStore(options.dbPath || process.env.DB_PATH || path.join(root, 'data', 'db.json')).init();
  const auth = new AuthService({
    store,
    passwordRounds: options.passwordRounds,
    sessionTtlMs: options.sessionTtlMs,
    googleClient: options.googleClient,
    googleClientId: options.googleClientId ?? process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: options.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: options.googleCallbackUrl ?? process.env.GOOGLE_CALLBACK_URL
  });
  const words = await fs.readJson(options.wordsPath || path.join(root, 'data', 'words.json'));
  let migratedRooms = false;
  for (const room of store.data.rooms) {
    if (!room.drawerMode) { room.drawerMode = 'manual'; migratedRooms = true; }
    if (!room.adminPinHash) { room.adminPinHash = hashToken('1234'); migratedRooms = true; }
    if (!Array.isArray(room.usedWords)) { room.usedWords = []; migratedRooms = true; }
    if (typeof room.isPublic !== 'boolean') { room.isPublic = false; migratedRooms = true; }
  }
  for (const player of store.data.players) {
    if (!player.isOnline && !player.socketId) continue;
    player.isOnline = false;
    player.socketId = null;
    migratedRooms = true;
  }
  if (migratedRooms) await store.save();
  const app = express();
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  const runtime = new Map();
  const canvasHistory = new Map();
  const authAttempts = new Map();
  let shuttingDown = false;

  const configuredBase = String(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const lanUrls = privateLanAddresses().map((address) => `http://${address}:${port}`);
  const baseUrl = configuredBase || lanUrls[0] || `http://localhost:${port}`;
  const joinUrl = (roomId) => `${baseUrl}/join/${roomId}`;

  app.use('/public', express.static(path.join(root, 'public'), { maxAge: 0, etag: true }));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use((req, _res, next) => {
    req.authUser = auth.userFromCookieHeader(req.headers.cookie);
    next();
  });

  function requestIsSecure(req) {
    return Boolean(req.secure);
  }

  function sameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false;
    }
  }

  function requireUser(req, res, next) {
    if (req.authUser) return next();
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  function authError(res, status, error) {
    return res.status(status).json({ ok: false, error });
  }

  function authAttemptKey(req, action) {
    return `${action}:${req.ip}`;
  }

  function authAttemptBlocked(req, res, action) {
    const key = authAttemptKey(req, action);
    const now = Date.now();
    const attempt = authAttempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
      authAttempts.set(key, { count: 0, resetAt: now + 10 * 60 * 1000 });
      return false;
    }
    if (attempt.count < 10) return false;
    res.set('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)));
    authError(res, 429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');
    return true;
  }

  function recordAuthFailure(req, action) {
    const key = authAttemptKey(req, action);
    const attempt = authAttempts.get(key);
    if (attempt) attempt.count += 1;
  }

  function clearAuthFailures(req, action) {
    authAttempts.delete(authAttemptKey(req, action));
  }

  app.get('/health', (_req, res) => res.json({ ok: true, rooms: store.data.rooms.length }));
  app.get('/api/rooms/:roomId/qr', async (req, res) => {
    if (!store.room(req.params.roomId)) return res.status(404).json({ error: 'Room tidak ditemukan.' });
    res.type('png');
    return res.send(await QRCode.toBuffer(joinUrl(req.params.roomId), { width: 512, margin: 2, color: { dark: '#17152B', light: '#FFFFFF' } }));
  });

  const view = (name) => (_req, res) => res.sendFile(path.join(root, 'views', name));
  app.get('/', view('index.html'));
  app.get('/login', (req, res) => req.authUser ? res.redirect(safeNextPath(req.query.next)) : view('login.html')(req, res));
  app.get('/signup', (req, res) => req.authUser ? res.redirect(safeNextPath(req.query.next)) : view('signup.html')(req, res));
  app.get('/account', requireUser, view('account.html'));
  app.get('/quick-match', requireUser, view('quick-match.html'));
  app.get('/admin', requireUser, view('admin.html'));
  app.get('/admin/room/:roomId', (req, res) => res.redirect(`/screen/${req.params.roomId}`));
  app.get('/join/:roomId', view('join.html'));
  app.get('/play/:roomId', view('play.html'));
  app.get('/screen/:roomId', view('screen.html'));

  app.use('/api/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ ok: true, data: { user: publicUser(req.authUser), googleEnabled: auth.googleEnabled } });
  });

  app.post('/api/auth/signup', async (req, res) => {
    if (!sameOrigin(req)) return authError(res, 403, 'Origin permintaan tidak valid.');
    if (authAttemptBlocked(req, res, 'signup')) return;
    const result = await auth.signup(req.body || {});
    if (!result.ok) {
      recordAuthFailure(req, 'signup');
      return authError(res, 400, result.error);
    }
    clearAuthFailures(req, 'signup');
    const token = await auth.createSession(result.user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, requestIsSecure(req)));
    return res.status(201).json({ ok: true, data: { user: publicUser(result.user), next: safeNextPath(req.body?.next) } });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!sameOrigin(req)) return authError(res, 403, 'Origin permintaan tidak valid.');
    if (authAttemptBlocked(req, res, 'login')) return;
    const result = await auth.login(req.body || {});
    if (!result.ok) {
      recordAuthFailure(req, 'login');
      return authError(res, 401, result.error);
    }
    clearAuthFailures(req, 'login');
    const token = await auth.createSession(result.user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, requestIsSecure(req)));
    return res.json({ ok: true, data: { user: publicUser(result.user), next: safeNextPath(req.body?.next) } });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!sameOrigin(req)) return authError(res, 403, 'Origin permintaan tidak valid.');
    await auth.destroySession(auth.sessionToken(req.headers.cookie));
    res.setHeader('Set-Cookie', auth.clearSessionCookie(requestIsSecure(req)));
    return res.json({ ok: true });
  });

  app.get('/auth/google', (req, res) => {
    const result = auth.beginGoogle(req.query.next);
    if (!result.ok) return res.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    res.setHeader('Set-Cookie', auth.googleStateCookieValue(result.state, requestIsSecure(req)));
    return res.redirect(result.url);
  });

  app.get('/auth/google/callback', async (req, res) => {
    try {
      const result = await auth.finishGoogle({ code: req.query.code, state: req.query.state, cookieHeader: req.headers.cookie });
      res.append('Set-Cookie', auth.clearGoogleStateCookie(requestIsSecure(req)));
      if (!result.ok) return res.redirect(`/login?error=${encodeURIComponent(result.error)}`);
      const token = await auth.createSession(result.user.id);
      res.append('Set-Cookie', auth.sessionCookie(token, requestIsSecure(req)));
      return res.redirect(result.next);
    } catch (error) {
      res.append('Set-Cookie', auth.clearGoogleStateCookie(requestIsSecure(req)));
      return res.redirect(`/login?error=${encodeURIComponent('Login Google gagal. Coba lagi.')}`);
    }
  });

  function clearRuntime(roomId) {
    const active = runtime.get(roomId);
    if (active?.phaseTimer) clearTimeout(active.phaseTimer);
    if (active?.ticker) clearInterval(active.ticker);
    runtime.delete(roomId);
  }

  function takeWordFromBank(room) {
    const bank = words.map((entry) => normalizeAnswer(entry.word)).filter(Boolean);
    if (!bank.length) return null;
    let available = bank.filter((word) => !room.usedWords.includes(word));
    if (!available.length) {
      room.usedWords = [];
      available = bank;
    }
    const word = available[Math.floor(Math.random() * available.length)];
    room.usedWords.push(word);
    return word;
  }

  function createPublicRoom() {
    const room = {
      id: createRoomId(store),
      name: 'Quick Match',
      status: 'waiting',
      currentRound: 0,
      maxRound: publicMaxRound,
      duration: publicRoundDuration,
      drawerMode: 'manual',
      isPublic: true,
      minPlayers: publicMinPlayers,
      capacity: publicRoomCapacity,
      adminPinHash: null,
      usedWords: [],
      lastDrawerId: null,
      currentWord: null,
      drawerId: null,
      startedAt: null,
      endsAt: null,
      countdownEndsAt: null,
      hostTokenHash: null,
      ownerUserId: null,
      createdAt: new Date().toISOString()
    };
    store.data.rooms.push(room);
    return room;
  }

  function publicMatchRoom() {
    return store.data.rooms
      .filter((room) => room.isPublic && room.status !== 'finished')
      .map((room) => ({ room, online: store.roomPlayers(room.id).filter((player) => player.isOnline).length }))
      .filter((entry) => entry.online < (entry.room.capacity || publicRoomCapacity))
      .sort((left, right) => right.online - left.online || left.room.createdAt.localeCompare(right.room.createdAt))[0]?.room || null;
  }

  function uniquePublicName(user, room) {
    const source = String(user.displayName || user.email?.split('@')[0] || 'Pemain').trim().replace(/\s+/g, ' ');
    const base = (source || 'Pemain').slice(0, 20);
    const names = new Set(store.roomPlayers(room.id).map((player) => normalizeAnswer(player.name)));
    if (!names.has(normalizeAnswer(base))) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const ending = ` ${suffix}`;
      const candidate = `${base.slice(0, 20 - ending.length)}${ending}`;
      if (!names.has(normalizeAnswer(candidate))) return candidate;
    }
    return `Pemain ${nanoid(6)}`;
  }

  async function maybeStartPublicRoom(room) {
    if (!room?.isPublic || room.status !== 'waiting') return false;
    const onlineCount = store.roomPlayers(room.id).filter((player) => player.isOnline).length;
    if (onlineCount < (room.minPlayers || publicMinPlayers)) return false;
    const result = await startCountdown(room);
    return result.ok;
  }

  function roomResult(room) {
    const round = store.currentRound(room);
    if (!round) return null;
    const correct = store.roundAnswers(room.id, room.currentRound)
      .filter((answer) => answer.isCorrect && !answer.rolledBack)
      .sort((a, b) => a.rank - b.rank)
      .map((answer) => ({
        playerId: answer.playerId,
        name: store.data.players.find((player) => player.id === answer.playerId)?.name || 'Peserta',
        rank: answer.rank,
        points: answer.points
      }));
    const drawer = store.data.players.find((player) => player.id === round.drawerId);
    const totalGuessers = round.eligibleGuesserIds?.length ?? Math.max(store.roomPlayers(room.id).length - 1, 0);
    const drawerScore = round.drawerScore ?? round.drawerBonus ?? 0;
    const percentage = totalGuessers ? Math.round((correct.length / totalGuessers) * 100) : 0;
    return {
      roundNumber: round.roundNumber,
      status: round.status,
      word: round.word,
      correct,
      drawer: drawer ? { id: drawer.id, name: drawer.name, score: drawerScore, percentage, correctCount: correct.length, totalGuessers } : null
    };
  }

  function sharedState(room) {
    const players = store.roomPlayers(room.id);
    const onlinePlayers = players.filter((player) => player.isOnline);
    const drawer = players.find((player) => player.id === room.drawerId);
    return {
      id: room.id,
      name: room.name,
      status: room.status,
      currentRound: room.currentRound,
      maxRound: room.maxRound,
      duration: room.duration,
      drawerMode: room.drawerMode,
      isPublic: Boolean(room.isPublic),
      minPlayers: room.isPublic ? (room.minPlayers || publicMinPlayers) : undefined,
      capacity: room.isPublic ? (room.capacity || publicRoomCapacity) : undefined,
      countdownEndsAt: room.countdownEndsAt,
      endsAt: room.endsAt,
      drawer: drawer ? publicPlayer(drawer) : null,
      playerCount: room.isPublic ? onlinePlayers.length : players.length
    };
  }

  function adminState(room) {
    const players = store.roomPlayers(room.id);
    const answers = room.currentRound ? store.roundAnswers(room.id, room.currentRound) : [];
    return {
      ...sharedState(room),
      secretWord: room.currentWord,
      players: players.map((player) => ({ ...publicPlayer(player, true), isOnline: player.isOnline, isAdminUser: isAdminUsername(player.name) })),
      answers: answers.map((answer) => ({
        id: answer.id,
        playerId: answer.playerId,
        name: players.find((player) => player.id === answer.playerId)?.name || 'Peserta',
        answer: answer.answer,
        isCorrect: answer.isCorrect,
        points: answer.points,
        rolledBack: Boolean(answer.rolledBack),
        submittedAt: answer.submittedAt
      })),
      leaderboard: leaderboard(players),
      result: room.status === 'round_result' || room.status === 'finished' ? roomResult(room) : null,
      joinUrl: joinUrl(room.id),
      qrUrl: `/api/rooms/${room.id}/qr`,
      alternativeUrls: lanUrls.map((url) => `${url}/join/${room.id}`)
    };
  }

  function playerState(room, player) {
    const players = store.roomPlayers(room.id);
    const visiblePlayers = room.isPublic ? players.filter((item) => item.isOnline) : players;
    const currentAnswers = room.currentRound ? store.roundAnswers(room.id, room.currentRound) : [];
    const round = store.currentRound(room);
    const eligibleGuesserIds = round?.eligibleGuesserIds || players.filter((item) => item.id !== room.drawerId).map((item) => item.id);
    const isEligibleGuesser = eligibleGuesserIds.includes(player.id);
    const hasCorrect = currentAnswers.some((answer) => answer.playerId === player.id && answer.isCorrect && !answer.rolledBack);
    const showResults = room.status === 'round_result' || room.status === 'finished';
    return {
      ...sharedState(room),
      players: room.status === 'waiting' ? visiblePlayers.map((item) => publicPlayer(item)) : undefined,
      me: {
        ...publicPlayer(player, true),
        isDrawer: player.id === room.drawerId,
        isEligibleGuesser,
        hasCorrect,
        matchStatus: ['countdown', 'drawing'].includes(room.status) && player.id !== room.drawerId && !isEligibleGuesser ? 'queued' : 'active'
      },
      canGuess: room.status === 'drawing' && isEligibleGuesser && player.id !== room.drawerId && !hasCorrect,
      result: showResults ? roomResult(room) : null,
      leaderboard: showResults ? leaderboard(players) : undefined
    };
  }

  function screenState(room) {
    const players = store.roomPlayers(room.id);
    const correctCount = room.currentRound
      ? store.roundAnswers(room.id, room.currentRound).filter((answer) => answer.isCorrect && !answer.rolledBack).length
      : 0;
    const showResults = room.status === 'round_result' || room.status === 'finished';
    return {
      ...sharedState(room),
      players: room.status === 'waiting' ? players.map((item) => publicPlayer(item)) : undefined,
      correctCount,
      result: showResults ? roomResult(room) : null,
      leaderboard: showResults ? leaderboard(players) : undefined,
      joinUrl: joinUrl(room.id),
      qrUrl: `/api/rooms/${room.id}/qr`
    };
  }

  async function broadcastRoom(roomId, event = 'room:updated') {
    const room = store.room(roomId);
    if (!room) return;
    io.to(`admin:${roomId}`).emit(event, adminState(room));
    io.to(`screen:${roomId}`).emit(event, screenState(room));
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role !== 'player' || socket.data.roomId !== roomId) continue;
      const player = store.data.players.find((item) => item.id === socket.data.playerId);
      if (player) socket.emit(event, playerState(room, player));
    }
    io.to(`admin:${roomId}`).emit('players:updated', adminState(room).players);
    io.to(`admin:${roomId}`).emit('answers:updated', adminState(room).answers);
    io.to(`admin:${roomId}`).emit('leaderboard:updated', adminState(room).leaderboard);
    if (room.status === 'round_result' || room.status === 'finished') {
      io.to(`screen:${roomId}`).emit('leaderboard:updated', leaderboard(store.roomPlayers(roomId)));
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.role === 'player' && socket.data.roomId === roomId) {
          socket.emit('leaderboard:updated', leaderboard(store.roomPlayers(roomId)));
        }
      }
    }
  }

  function emitSecret(room) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role === 'player' && socket.data.roomId === room.id && socket.data.playerId === room.drawerId) {
        socket.emit('drawer:secret-word', { word: room.currentWord });
      }
    }
  }

  async function startCountdown(room) {
    if (!room || !canTransition(room.status, 'countdown')) {
      return { ok: false, error: 'Ronde belum dapat dimulai.' };
    }
    const onlinePlayers = store.roomPlayers(room.id).filter((player) => player.isOnline);
    const minimum = room.isPublic ? (room.minPlayers || publicMinPlayers) : 2;
    if (onlinePlayers.length < minimum) return { ok: false, error: `Minimal ${minimum} peserta online untuk memulai.` };
    const drawer = selectDrawer(onlinePlayers, room.drawerMode, room.lastDrawerId);
    if (!drawer && room.drawerMode === 'admin') {
      return { ok: false, error: 'Mode Admin membutuhkan peserta online dengan username admin.' };
    }
    if (!drawer) return { ok: false, error: 'Tidak ada penggambar yang dapat dipilih.' };
    const eligibleGuesserIds = onlinePlayers.filter((player) => player.id !== drawer.id).map((player) => player.id);
    if (!eligibleGuesserIds.length) return { ok: false, error: 'Minimal satu penebak online diperlukan.' };
    const word = takeWordFromBank(room);
    if (!word) return { ok: false, error: 'Word bank kosong.' };

    clearRuntime(room.id);
    room.status = 'countdown';
    room.currentRound += 1;
    room.drawerId = drawer.id;
    room.lastDrawerId = drawer.id;
    room.currentWord = word;
    room.startedAt = null;
    room.countdownEndsAt = new Date(Date.now() + countdownMs).toISOString();
    room.endsAt = null;
    store.data.rounds.push({
      id: `round_${nanoid(10)}`,
      roomId: room.id,
      roundNumber: room.currentRound,
      drawerId: room.drawerId,
      word,
      status: 'countdown',
      correctOrder: [],
      eligibleGuesserIds,
      drawerScore: 0,
      drawerCorrectPercentage: 0,
      bonusAwarded: false,
      startedAt: null,
      endedAt: null
    });
    canvasHistory.set(room.id, []);
    await store.save();
    const phaseTimer = setTimeout(() => beginDrawing(room.id), countdownMs);
    runtime.set(room.id, { phaseTimer, ticker: null });
    io.to(`room:${room.id}`).emit('canvas:clear');
    io.to(`room:${room.id}`).emit('game:countdown', { endsAt: room.countdownEndsAt, currentRound: room.currentRound });
    emitSecret(room);
    await broadcastRoom(room.id);
    return { ok: true, data: { state: adminState(room) } };
  }

  async function beginDrawing(roomId) {
    const room = store.room(roomId);
    if (!room || room.status !== 'countdown' || !canTransition('countdown', 'drawing')) return;
    clearRuntime(roomId);
    const now = Date.now();
    room.status = 'drawing';
    room.startedAt = new Date(now).toISOString();
    room.endsAt = new Date(now + room.duration * 1000).toISOString();
    room.countdownEndsAt = null;
    const round = store.currentRound(room);
    if (round) {
      round.status = 'drawing';
      round.startedAt = room.startedAt;
    }
    await store.save();
    const phaseTimer = setTimeout(() => endRound(roomId, 'finished'), room.duration * 1000);
    const ticker = setInterval(() => {
      const activeRoom = store.room(roomId);
      if (!activeRoom || activeRoom.status !== 'drawing') return;
      const remaining = Math.max(0, Math.ceil((new Date(activeRoom.endsAt).getTime() - Date.now()) / 1000));
      io.to(`room:${roomId}`).emit('game:timer', { remaining, endsAt: activeRoom.endsAt });
    }, tickMs);
    runtime.set(roomId, { phaseTimer, ticker });
    io.to(`room:${roomId}`).emit('game:round-started', { currentRound: room.currentRound, endsAt: room.endsAt });
    emitSecret(room);
    await broadcastRoom(roomId);
  }

  function schedulePublicAdvance(roomId, delay = publicResultMs) {
    clearRuntime(roomId);
    const phaseTimer = setTimeout(() => advancePublicRoom(roomId), delay);
    runtime.set(roomId, { phaseTimer, ticker: null });
  }

  function schedulePublicReset(roomId) {
    clearRuntime(roomId);
    const phaseTimer = setTimeout(() => resetPublicMatch(roomId), publicFinalMs);
    runtime.set(roomId, { phaseTimer, ticker: null });
  }

  async function advancePublicRoom(roomId) {
    const room = store.room(roomId);
    if (!room?.isPublic || room.status !== 'round_result') return;
    clearRuntime(roomId);
    if (room.currentRound >= room.maxRound) {
      room.status = 'finished';
      room.currentWord = null;
      room.drawerId = null;
      await store.save();
      io.to(`room:${room.id}`).emit('game:finished');
      await broadcastRoom(room.id);
      schedulePublicReset(room.id);
      return;
    }

    const onlineCount = store.roomPlayers(room.id).filter((player) => player.isOnline).length;
    if (onlineCount >= (room.minPlayers || publicMinPlayers)) {
      await startCountdown(room);
      return;
    }

    room.status = 'waiting';
    room.currentWord = null;
    room.drawerId = null;
    await store.save();
    await broadcastRoom(room.id);
  }

  async function resetPublicMatch(roomId) {
    const room = store.room(roomId);
    if (!room?.isPublic || room.status !== 'finished') return;
    clearRuntime(roomId);
    room.status = 'waiting';
    room.currentRound = 0;
    room.currentWord = null;
    room.drawerId = null;
    room.startedAt = null;
    room.endsAt = null;
    room.countdownEndsAt = null;
    room.usedWords = [];
    room.lastDrawerId = null;
    for (const player of store.roomPlayers(room.id)) player.score = 0;
    store.data.rounds = store.data.rounds.filter((round) => round.roomId !== room.id);
    store.data.answers = store.data.answers.filter((answer) => answer.roomId !== room.id);
    canvasHistory.set(room.id, []);
    await store.save();
    io.to(`room:${room.id}`).emit('canvas:clear');
    await broadcastRoom(room.id);
    if (store.roomPlayers(room.id).filter((player) => player.isOnline).length >= (room.minPlayers || publicMinPlayers)) {
      await startCountdown(room);
    }
  }

  async function endRound(roomId, roundStatus = 'finished') {
    const room = store.room(roomId);
    if (!room || !['countdown', 'drawing'].includes(room.status)) return false;
    clearRuntime(roomId);
    const round = store.currentRound(room);
    if (!round) return false;
    const players = store.roomPlayers(roomId);
    const correctAnswers = store.roundAnswers(roomId, room.currentRound).filter((answer) => answer.isCorrect && !answer.rolledBack);

    if (roundStatus === 'skipped') {
      for (const answer of correctAnswers) {
        const player = players.find((item) => item.id === answer.playerId);
        if (player) player.score = Math.max(0, player.score - answer.points);
        answer.originalPoints = answer.points;
        answer.points = 0;
        answer.rolledBack = true;
      }
      round.correctOrder = [];
      round.drawerScore = 0;
      round.drawerCorrectPercentage = 0;
    } else if (!round.bonusAwarded) {
      const totalGuessers = round.eligibleGuesserIds?.length ?? Math.max(players.length - 1, 0);
      round.drawerScore = getDrawerScore(correctAnswers.length, totalGuessers);
      round.drawerCorrectPercentage = totalGuessers ? Math.round((correctAnswers.length / totalGuessers) * 100) : 0;
      const drawer = players.find((player) => player.id === round.drawerId);
      if (drawer) drawer.score += round.drawerScore;
      round.bonusAwarded = true;
    }

    round.status = roundStatus;
    round.endedAt = new Date().toISOString();
    room.status = 'round_result';
    room.endsAt = null;
    room.countdownEndsAt = null;
    await store.save();
    io.to(`room:${roomId}`).emit('game:round-ended', { roundNumber: room.currentRound, status: roundStatus });
    await broadcastRoom(roomId);
    if (room.isPublic) schedulePublicAdvance(room.id);
    return true;
  }

  function authHost(roomId, token, adminPin) {
    const room = store.room(roomId);
    return room && !room.isPublic && (safeTokenEquals(token, room.hostTokenHash) || safeTokenEquals(adminPin, room.adminPinHash)) ? room : null;
  }

  function authPlayer(roomId, playerId, token) {
    const player = store.data.players.find((item) => item.roomId === roomId && item.id === playerId);
    return player && safeTokenEquals(token, player.sessionTokenHash) ? player : null;
  }

  function attachSocket(socket, role, roomId, playerId = null) {
    socket.data = { ...socket.data, role, roomId, playerId };
    socket.join(`room:${roomId}`);
    socket.join(`${role === 'player' ? 'players' : role}:${roomId}`);
  }

  function acknowledge(ack, data) {
    if (typeof ack === 'function') ack(data);
  }

  io.on('connection', (socket) => {
    socket.data.authUserId = auth.userFromCookieHeader(socket.request.headers.cookie)?.id || null;
    socket.on('admin:create-room', async (payload = {}, ack) => {
      try {
        if (!socket.data.authUserId) throw new Error('Silakan login sebelum membuat room.');
        const name = String(payload.name || 'Briefing Pagi').trim().slice(0, 50) || 'Briefing Pagi';
        const maxRound = Math.min(Math.max(Number(payload.maxRound) || 5, 1), 20);
        const duration = Math.min(Math.max(Number(payload.duration) || 60, 15), 300);
        const drawerMode = payload.drawerMode === 'admin' ? 'admin' : 'manual';
        const adminPin = String(payload.adminPin || '1234').trim();
        if (!/^\d{4,8}$/.test(adminPin)) throw new Error('PIN admin harus terdiri dari 4 sampai 8 digit.');
        const roomId = createRoomId(store);
        const hostToken = nanoid(32);
        const room = {
          id: roomId,
          name,
          status: 'waiting',
          currentRound: 0,
          maxRound,
          duration,
          drawerMode,
          isPublic: false,
          adminPinHash: hashToken(adminPin),
          usedWords: [],
          lastDrawerId: null,
          currentWord: null,
          drawerId: null,
          startedAt: null,
          endsAt: null,
          countdownEndsAt: null,
          hostTokenHash: hashToken(hostToken),
          ownerUserId: socket.data.authUserId,
          createdAt: new Date().toISOString()
        };
        store.data.rooms.push(room);
        await store.save();
        attachSocket(socket, 'admin', roomId);
        const data = { roomId, hostToken, state: adminState(room) };
        socket.emit('room:created', data);
        acknowledge(ack, { ok: true, data });
      } catch (error) {
        acknowledge(ack, { ok: false, error: error.message });
      }
    });

    socket.on('admin:resume', (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Token host tidak valid.' });
      attachSocket(socket, 'admin', room.id);
      return acknowledge(ack, { ok: true, data: { state: adminState(room), canvasHistory: canvasHistory.get(room.id) || [] } });
    });

    socket.on('screen:watch', (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      if (!room) return acknowledge(ack, { ok: false, error: 'Room tidak ditemukan.' });
      const isHost = Boolean(authHost(payload.roomId, payload.hostToken, payload.adminPin));
      attachSocket(socket, 'screen', room.id);
      socket.data.isHost = isHost;
      return acknowledge(ack, { ok: true, data: { state: screenState(room), canvasHistory: canvasHistory.get(room.id) || [], isHost } });
    });

    socket.on('screen:authenticate-host', (payload = {}, ack) => {
      const room = authHost(payload.roomId, null, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'PIN host salah.' });
      socket.data.isHost = true;
      return acknowledge(ack, { ok: true, data: { isHost: true } });
    });

    socket.on('public:quick-match', async (_payload = {}, ack) => {
      try {
        const user = store.data.users.find((item) => item.id === socket.data.authUserId);
        if (!user) return acknowledge(ack, { ok: false, error: 'Silakan login untuk bermain Quick Match.' });

        let player = store.data.players
          .filter((item) => item.userId === user.id && store.room(item.roomId)?.isPublic)
          .sort((left, right) => right.joinedAt.localeCompare(left.joinedAt))[0];
        let room = player ? store.room(player.roomId) : null;
        if (!room) {
          room = publicMatchRoom() || createPublicRoom();
          const playerToken = nanoid(32);
          player = {
            id: `player_${nanoid(10)}`,
            roomId: room.id,
            userId: user.id,
            name: uniquePublicName(user, room),
            score: 0,
            isOnline: true,
            socketId: socket.id,
            sessionTokenHash: hashToken(playerToken),
            joinedAt: new Date().toISOString()
          };
          store.data.players.push(player);
          attachSocket(socket, 'player', room.id, player.id);
          await store.save();
          await maybeStartPublicRoom(room);
          const data = {
            roomId: room.id,
            playerId: player.id,
            playerToken,
            state: playerState(room, player),
            canvasHistory: canvasHistory.get(room.id) || []
          };
          acknowledge(ack, { ok: true, data });
          await broadcastRoom(room.id);
          return;
        }

        const playerToken = nanoid(32);
        player.sessionTokenHash = hashToken(playerToken);
        player.isOnline = true;
        player.socketId = socket.id;
        attachSocket(socket, 'player', room.id, player.id);
        await store.save();
        await maybeStartPublicRoom(room);
        acknowledge(ack, {
          ok: true,
          data: {
            roomId: room.id,
            playerId: player.id,
            playerToken,
            state: playerState(room, player),
            canvasHistory: canvasHistory.get(room.id) || []
          }
        });
        if (player.id === room.drawerId && ['countdown', 'drawing'].includes(room.status)) socket.emit('drawer:secret-word', { word: room.currentWord });
        await broadcastRoom(room.id);
      } catch (error) {
        acknowledge(ack, { ok: false, error: error.message || 'Quick Match gagal dimulai.' });
      }
    });

    socket.on('player:join', async (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      if (!room) return acknowledge(ack, { ok: false, error: 'Room tidak ditemukan.' });
      if (room.isPublic) return acknowledge(ack, { ok: false, error: 'Room publik hanya dapat dimasuki melalui Quick Match.' });
      if (room.status === 'finished') return acknowledge(ack, { ok: false, error: 'Game sudah selesai.' });
      const checked = validateName(payload.name);
      if (!checked.ok) return acknowledge(ack, { ok: false, error: checked.error });
      if (isAdminUsername(checked.name) && !safeTokenEquals(payload.adminPin, room.adminPinHash)) {
        return acknowledge(ack, { ok: false, error: 'PIN admin salah.' });
      }
      const duplicate = store.roomPlayers(room.id).some((player) => normalizeAnswer(player.name) === normalizeAnswer(checked.name));
      if (duplicate) return acknowledge(ack, { ok: false, error: 'Nama sudah digunakan di room ini.' });
      const playerToken = nanoid(32);
      const player = {
        id: `player_${nanoid(10)}`,
        roomId: room.id,
        name: checked.name,
        score: 0,
        isOnline: true,
        socketId: socket.id,
        sessionTokenHash: hashToken(playerToken),
        joinedAt: new Date().toISOString()
      };
      store.data.players.push(player);
      await store.save();
      attachSocket(socket, 'player', room.id, player.id);
      const data = { playerId: player.id, playerToken, state: playerState(room, player), canvasHistory: canvasHistory.get(room.id) || [] };
      acknowledge(ack, { ok: true, data });
      await broadcastRoom(room.id);
    });

    socket.on('player:resume', async (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      const player = authPlayer(payload.roomId, payload.playerId, payload.playerToken);
      if (!room || !player) return acknowledge(ack, { ok: false, error: 'Sesi pemain tidak valid.' });
      player.isOnline = true;
      player.socketId = socket.id;
      await store.save();
      attachSocket(socket, 'player', room.id, player.id);
      acknowledge(ack, { ok: true, data: { state: playerState(room, player), canvasHistory: canvasHistory.get(room.id) || [] } });
      if (player.id === room.drawerId && ['countdown', 'drawing'].includes(room.status)) socket.emit('drawer:secret-word', { word: room.currentWord });
      await broadcastRoom(room.id);
      await maybeStartPublicRoom(room);
    });

    socket.on('admin:start-countdown', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      if (room.status !== 'waiting') return acknowledge(ack, { ok: false, error: 'Ronde sebelumnya belum selesai.' });
      return acknowledge(ack, await startCountdown(room));
    });

    socket.on('admin:start-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room || room.status !== 'countdown') return acknowledge(ack, { ok: false, error: 'Countdown tidak aktif.' });
      await beginDrawing(room.id);
      return acknowledge(ack, { ok: true });
    });

    socket.on('admin:stop-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      const ended = await endRound(room.id, 'finished');
      return acknowledge(ack, ended ? { ok: true } : { ok: false, error: 'Tidak ada ronde aktif.' });
    });

    socket.on('admin:skip-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      const ended = await endRound(room.id, 'skipped');
      return acknowledge(ack, ended ? { ok: true } : { ok: false, error: 'Tidak ada ronde aktif.' });
    });

    socket.on('admin:next-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      if (room.status !== 'round_result') return acknowledge(ack, { ok: false, error: 'Hasil ronde belum tersedia.' });
      if (room.currentRound >= room.maxRound) {
        room.status = 'finished';
        room.currentWord = null;
        room.drawerId = null;
        await store.save();
        io.to(`room:${room.id}`).emit('game:finished');
      } else {
        return acknowledge(ack, await startCountdown(room));
      }
      acknowledge(ack, { ok: true, data: { state: adminState(room) } });
      await broadcastRoom(room.id);
    });

    socket.on('admin:reset-game', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken, payload.adminPin);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      clearRuntime(room.id);
      room.status = 'waiting';
      room.currentRound = 0;
      room.currentWord = null;
      room.drawerId = null;
      room.startedAt = null;
      room.endsAt = null;
      room.countdownEndsAt = null;
      room.usedWords = [];
      room.lastDrawerId = null;
      for (const player of store.roomPlayers(room.id)) player.score = 0;
      store.data.rounds = store.data.rounds.filter((round) => round.roomId !== room.id);
      store.data.answers = store.data.answers.filter((answer) => answer.roomId !== room.id);
      canvasHistory.set(room.id, []);
      await store.save();
      io.to(`room:${room.id}`).emit('canvas:clear');
      acknowledge(ack, { ok: true });
      await broadcastRoom(room.id);
    });

    socket.on('player:submit-answer', async (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      const player = authPlayer(payload.roomId, payload.playerId, payload.playerToken);
      if (!room || !player) return acknowledge(ack, { ok: false, error: 'Sesi pemain tidak valid.' });
      if (room.status !== 'drawing') return acknowledge(ack, { ok: false, error: 'Ronde belum dimulai atau sudah selesai.' });
      if (player.id === room.drawerId) return acknowledge(ack, { ok: false, error: 'Penggambar tidak dapat menjawab.' });
      const round = store.currentRound(room);
      const eligibleGuesserIds = round?.eligibleGuesserIds || store.roomPlayers(room.id).filter((item) => item.id !== room.drawerId).map((item) => item.id);
      if (!eligibleGuesserIds.includes(player.id)) {
        return acknowledge(ack, { ok: false, error: 'Kamu bergabung setelah ronde dimulai. Tunggu ronde berikutnya.' });
      }
      const answerText = normalizeAnswer(payload.answer);
      if (!answerText) return acknowledge(ack, { ok: false, error: 'Jawaban tidak boleh kosong.' });
      const roundAnswers = store.roundAnswers(room.id, room.currentRound);
      if (roundAnswers.some((answer) => answer.playerId === player.id && answer.isCorrect && !answer.rolledBack)) {
        return acknowledge(ack, { ok: false, error: 'Kamu sudah menjawab benar.' });
      }
      const isCorrect = answerText === normalizeAnswer(room.currentWord);
      const rank = isCorrect ? roundAnswers.filter((answer) => answer.isCorrect && !answer.rolledBack).length + 1 : null;
      const points = isCorrect ? getPointsByRank(rank) : 0;
      const answer = {
        id: `answer_${nanoid(10)}`,
        roomId: room.id,
        roundNumber: room.currentRound,
        playerId: player.id,
        answer: answerText,
        isCorrect,
        points,
        rank,
        submittedAt: new Date().toISOString()
      };
      store.data.answers.push(answer);
      if (isCorrect) {
        player.score += points;
        round.correctOrder.push(player.id);
      }
      await store.save();
      const result = { correct: isCorrect, points, rank, message: isCorrect ? `Benar! +${points} poin` : 'Belum tepat, coba lagi!' };
      socket.emit('answer:result', result);
      acknowledge(ack, { ok: true, data: result });
      await broadcastRoom(room.id);
      const correctIds = new Set(store.roundAnswers(room.id, room.currentRound).filter((item) => item.isCorrect && !item.rolledBack).map((item) => item.playerId));
      if (eligibleGuesserIds.length > 0 && eligibleGuesserIds.every((playerId) => correctIds.has(playerId))) await endRound(room.id, 'finished');
    });

    function registerDraw(clientEvent, serverEvent, type) {
      socket.on(clientEvent, (payload = {}, ack) => {
        const room = store.room(payload.roomId);
        const player = authPlayer(payload.roomId, payload.playerId, payload.playerToken);
        if (!room || !player || room.status !== 'drawing' || room.drawerId !== player.id) {
          return acknowledge(ack, { ok: false, error: 'Canvas hanya aktif untuk penggambar.' });
        }
        const stroke = sanitizeStroke(type, payload.stroke || {});
        if (!stroke) return acknowledge(ack, { ok: false, error: 'Data gambar tidak valid.' });
        const history = canvasHistory.get(room.id) || [];
        if (history.length < 50000) history.push(stroke);
        canvasHistory.set(room.id, history);
        socket.to(`room:${room.id}`).emit(serverEvent, stroke);
        return acknowledge(ack, { ok: true });
      });
    }

    registerDraw('drawer:draw-start', 'canvas:draw-start', 'start');
    registerDraw('drawer:draw-move', 'canvas:draw-move', 'move');
    registerDraw('drawer:draw-end', 'canvas:draw-end', 'end');

    socket.on('drawer:clear-canvas', (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      const player = authPlayer(payload.roomId, payload.playerId, payload.playerToken);
      if (!room || !player || room.status !== 'drawing' || room.drawerId !== player.id) {
        return acknowledge(ack, { ok: false, error: 'Canvas hanya aktif untuk penggambar.' });
      }
      canvasHistory.set(room.id, []);
      io.to(`room:${room.id}`).emit('canvas:clear');
      return acknowledge(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      if (shuttingDown || socket.data.role !== 'player') return;
      setTimeout(async () => {
        if (shuttingDown) return;
        const stillOnline = [...io.sockets.sockets.values()].some((candidate) =>
          candidate.data.role === 'player' && candidate.data.playerId === socket.data.playerId
        );
        if (stillOnline) return;
        const player = store.data.players.find((item) => item.id === socket.data.playerId);
        if (player) {
          player.isOnline = false;
          player.socketId = null;
          await store.save();
          await broadcastRoom(player.roomId);
        }
      }, 100);
    });
  });

  // Active canvases are intentionally memory-only. Persisted active rounds become safe results after restart.
  let recovered = false;
  for (const room of store.data.rooms) {
    if (!['countdown', 'drawing'].includes(room.status)) continue;
    const round = store.currentRound(room);
    if (round) {
      round.status = 'interrupted';
      round.endedAt = new Date().toISOString();
      round.drawerScore = 0;
      round.drawerCorrectPercentage = 0;
    }
    room.status = 'round_result';
    room.endsAt = null;
    room.countdownEndsAt = null;
    recovered = true;
  }
  if (recovered) await store.save();
  for (const room of store.data.rooms) {
    if (!room.isPublic) continue;
    if (room.status === 'round_result') schedulePublicAdvance(room.id);
    if (room.status === 'finished') schedulePublicReset(room.id);
  }

  return {
    app,
    io,
    server,
    store,
    auth,
    baseUrl,
    async listen(listenPort = port) {
      await new Promise((resolve) => server.listen(listenPort, '0.0.0.0', resolve));
      return server.address();
    },
    async close() {
      shuttingDown = true;
      for (const roomId of runtime.keys()) clearRuntime(roomId);
      await store.writeQueue;
      await new Promise((resolve) => io.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createGameServer, privateLanAddresses };
