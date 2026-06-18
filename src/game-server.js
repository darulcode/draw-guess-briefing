const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { JsonStore } = require('./store');
const {
  canTransition,
  getDrawerBonus,
  getPointsByRank,
  hashToken,
  leaderboard,
  normalizeAnswer,
  safeTokenEquals,
  sanitizeStroke,
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
  const store = await new JsonStore(options.dbPath || path.join(root, 'data', 'db.json')).init();
  const words = await fs.readJson(options.wordsPath || path.join(root, 'data', 'words.json'));
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  const runtime = new Map();
  const canvasHistory = new Map();
  let shuttingDown = false;

  const configuredBase = String(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const lanUrls = privateLanAddresses().map((address) => `http://${address}:${port}`);
  const baseUrl = configuredBase || lanUrls[0] || `http://localhost:${port}`;
  const joinUrl = (roomId) => `${baseUrl}/join/${roomId}`;

  app.use('/public', express.static(path.join(root, 'public'), { maxAge: options.test ? 0 : '1h' }));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: store.data.rooms.length }));
  app.get('/api/rooms/:roomId/qr', async (req, res) => {
    if (!store.room(req.params.roomId)) return res.status(404).json({ error: 'Room tidak ditemukan.' });
    res.type('png');
    return res.send(await QRCode.toBuffer(joinUrl(req.params.roomId), { width: 512, margin: 2, color: { dark: '#17152B', light: '#FFFFFF' } }));
  });

  const view = (name) => (_req, res) => res.sendFile(path.join(root, 'views', name));
  app.get('/', view('index.html'));
  app.get('/admin', view('admin.html'));
  app.get('/admin/room/:roomId', view('admin-room.html'));
  app.get('/join/:roomId', view('join.html'));
  app.get('/play/:roomId', view('play.html'));
  app.get('/screen/:roomId', view('screen.html'));

  function clearRuntime(roomId) {
    const active = runtime.get(roomId);
    if (active?.phaseTimer) clearTimeout(active.phaseTimer);
    if (active?.ticker) clearInterval(active.ticker);
    runtime.delete(roomId);
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
    return {
      roundNumber: round.roundNumber,
      status: round.status,
      word: round.word,
      correct,
      drawer: drawer ? { id: drawer.id, name: drawer.name, bonus: round.drawerBonus || 0 } : null
    };
  }

  function sharedState(room) {
    const players = store.roomPlayers(room.id);
    const drawer = players.find((player) => player.id === room.drawerId);
    return {
      id: room.id,
      name: room.name,
      status: room.status,
      currentRound: room.currentRound,
      maxRound: room.maxRound,
      duration: room.duration,
      countdownEndsAt: room.countdownEndsAt,
      endsAt: room.endsAt,
      drawer: drawer ? publicPlayer(drawer) : null,
      playerCount: players.length
    };
  }

  function adminState(room) {
    const players = store.roomPlayers(room.id);
    const answers = room.currentRound ? store.roundAnswers(room.id, room.currentRound) : [];
    return {
      ...sharedState(room),
      secretWord: room.currentWord,
      players: players.map((player) => ({ ...publicPlayer(player, true), isOnline: player.isOnline })),
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
    const currentAnswers = room.currentRound ? store.roundAnswers(room.id, room.currentRound) : [];
    const hasCorrect = currentAnswers.some((answer) => answer.playerId === player.id && answer.isCorrect && !answer.rolledBack);
    const showResults = room.status === 'round_result' || room.status === 'finished';
    return {
      ...sharedState(room),
      players: room.status === 'waiting' ? players.map((item) => publicPlayer(item)) : undefined,
      me: { ...publicPlayer(player, true), isDrawer: player.id === room.drawerId, hasCorrect },
      canGuess: room.status === 'drawing' && player.id !== room.drawerId && !hasCorrect,
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
      round.drawerBonus = 0;
    } else if (!round.bonusAwarded) {
      round.drawerBonus = getDrawerBonus(correctAnswers.length);
      const drawer = players.find((player) => player.id === round.drawerId);
      if (drawer) drawer.score += round.drawerBonus;
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
    return true;
  }

  function authHost(roomId, token) {
    const room = store.room(roomId);
    return room && safeTokenEquals(token, room.hostTokenHash) ? room : null;
  }

  function authPlayer(roomId, playerId, token) {
    const player = store.data.players.find((item) => item.roomId === roomId && item.id === playerId);
    return player && safeTokenEquals(token, player.sessionTokenHash) ? player : null;
  }

  function attachSocket(socket, role, roomId, playerId = null) {
    socket.data = { role, roomId, playerId };
    socket.join(`room:${roomId}`);
    socket.join(`${role === 'player' ? 'players' : role}:${roomId}`);
  }

  function acknowledge(ack, data) {
    if (typeof ack === 'function') ack(data);
  }

  io.on('connection', (socket) => {
    socket.on('admin:create-room', async (payload = {}, ack) => {
      try {
        const name = String(payload.name || 'Briefing Pagi').trim().slice(0, 50) || 'Briefing Pagi';
        const maxRound = Math.min(Math.max(Number(payload.maxRound) || 5, 1), 20);
        const duration = Math.min(Math.max(Number(payload.duration) || 60, 15), 300);
        const roomId = createRoomId(store);
        const hostToken = nanoid(32);
        const room = {
          id: roomId,
          name,
          status: 'waiting',
          currentRound: 0,
          maxRound,
          duration,
          wordMode: payload.wordMode === 'random' ? 'random' : 'manual',
          currentWord: null,
          drawerId: null,
          startedAt: null,
          endsAt: null,
          countdownEndsAt: null,
          hostTokenHash: hashToken(hostToken),
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
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Token host tidak valid.' });
      attachSocket(socket, 'admin', room.id);
      return acknowledge(ack, { ok: true, data: { state: adminState(room), canvasHistory: canvasHistory.get(room.id) || [] } });
    });

    socket.on('screen:watch', (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      if (!room) return acknowledge(ack, { ok: false, error: 'Room tidak ditemukan.' });
      attachSocket(socket, 'screen', room.id);
      return acknowledge(ack, { ok: true, data: { state: screenState(room), canvasHistory: canvasHistory.get(room.id) || [] } });
    });

    socket.on('player:join', async (payload = {}, ack) => {
      const room = store.room(payload.roomId);
      if (!room) return acknowledge(ack, { ok: false, error: 'Room tidak ditemukan.' });
      if (room.status === 'finished') return acknowledge(ack, { ok: false, error: 'Game sudah selesai.' });
      const checked = validateName(payload.name);
      if (!checked.ok) return acknowledge(ack, { ok: false, error: checked.error });
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
    });

    socket.on('admin:random-word', (payload = {}, ack) => {
      if (!authHost(payload.roomId, payload.hostToken)) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      const choice = words[Math.floor(Math.random() * words.length)];
      return acknowledge(ack, { ok: true, data: choice });
    });

    socket.on('admin:start-countdown', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      if (room.status !== 'waiting') return acknowledge(ack, { ok: false, error: 'Ronde sebelumnya belum selesai.' });
      const players = store.roomPlayers(room.id);
      if (players.length < 2) return acknowledge(ack, { ok: false, error: 'Minimal 2 peserta untuk memulai.' });
      if (!players.some((player) => player.id === payload.drawerId)) return acknowledge(ack, { ok: false, error: 'Pilih penggambar yang valid.' });
      const word = normalizeAnswer(payload.word);
      if (!word) return acknowledge(ack, { ok: false, error: 'Kata rahasia wajib diisi.' });
      const duration = Math.min(Math.max(Number(payload.duration) || room.duration, 15), 300);
      if (!canTransition(room.status, 'countdown')) return acknowledge(ack, { ok: false, error: 'Transisi ronde tidak valid.' });
      room.status = 'countdown';
      room.currentRound += 1;
      room.drawerId = payload.drawerId;
      room.currentWord = word;
      room.duration = duration;
      room.countdownEndsAt = new Date(Date.now() + countdownMs).toISOString();
      room.endsAt = null;
      const round = {
        id: `round_${nanoid(10)}`,
        roomId: room.id,
        roundNumber: room.currentRound,
        drawerId: room.drawerId,
        word,
        status: 'countdown',
        correctOrder: [],
        drawerBonus: 0,
        bonusAwarded: false,
        startedAt: null,
        endedAt: null
      };
      store.data.rounds.push(round);
      canvasHistory.set(room.id, []);
      await store.save();
      const phaseTimer = setTimeout(() => beginDrawing(room.id), countdownMs);
      runtime.set(room.id, { phaseTimer, ticker: null });
      io.to(`room:${room.id}`).emit('game:countdown', { endsAt: room.countdownEndsAt, currentRound: room.currentRound });
      emitSecret(room);
      acknowledge(ack, { ok: true, data: { state: adminState(room) } });
      await broadcastRoom(room.id);
    });

    socket.on('admin:start-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room || room.status !== 'countdown') return acknowledge(ack, { ok: false, error: 'Countdown tidak aktif.' });
      await beginDrawing(room.id);
      return acknowledge(ack, { ok: true });
    });

    socket.on('admin:stop-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      const ended = await endRound(room.id, 'finished');
      return acknowledge(ack, ended ? { ok: true } : { ok: false, error: 'Tidak ada ronde aktif.' });
    });

    socket.on('admin:skip-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      const ended = await endRound(room.id, 'skipped');
      return acknowledge(ack, ended ? { ok: true } : { ok: false, error: 'Tidak ada ronde aktif.' });
    });

    socket.on('admin:next-round', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      if (room.status !== 'round_result') return acknowledge(ack, { ok: false, error: 'Hasil ronde belum tersedia.' });
      if (room.currentRound >= room.maxRound) {
        room.status = 'finished';
        room.currentWord = null;
        room.drawerId = null;
        await store.save();
        io.to(`room:${room.id}`).emit('game:finished');
      } else {
        room.status = 'waiting';
        room.currentWord = null;
        room.drawerId = null;
        room.startedAt = null;
        canvasHistory.set(room.id, []);
        await store.save();
        io.to(`room:${room.id}`).emit('canvas:clear');
      }
      acknowledge(ack, { ok: true, data: { state: adminState(room) } });
      await broadcastRoom(room.id);
    });

    socket.on('admin:reset-game', async (payload = {}, ack) => {
      const room = authHost(payload.roomId, payload.hostToken);
      if (!room) return acknowledge(ack, { ok: false, error: 'Akses host ditolak.' });
      clearRuntime(room.id);
      room.status = 'waiting';
      room.currentRound = 0;
      room.currentWord = null;
      room.drawerId = null;
      room.startedAt = null;
      room.endsAt = null;
      room.countdownEndsAt = null;
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
        const round = store.currentRound(room);
        round.correctOrder.push(player.id);
      }
      await store.save();
      const result = { correct: isCorrect, points, rank, message: isCorrect ? `Benar! +${points} poin` : 'Belum tepat, coba lagi!' };
      socket.emit('answer:result', result);
      acknowledge(ack, { ok: true, data: result });
      await broadcastRoom(room.id);
      const eligible = store.roomPlayers(room.id).filter((item) => item.id !== room.drawerId);
      const correctIds = new Set(store.roundAnswers(room.id, room.currentRound).filter((item) => item.isCorrect && !item.rolledBack).map((item) => item.playerId));
      if (eligible.length > 0 && eligible.every((item) => correctIds.has(item.id))) await endRound(room.id, 'finished');
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
      round.drawerBonus = 0;
    }
    room.status = 'round_result';
    room.endsAt = null;
    room.countdownEndsAt = null;
    recovered = true;
  }
  if (recovered) await store.save();

  return {
    app,
    io,
    server,
    store,
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
