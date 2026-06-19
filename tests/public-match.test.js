const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { io: createClient } = require('socket.io-client');
const { createGameServer } = require('../src/game-server');

function connect(url, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...(cookieHeader ? { extraHeaders: { Cookie: cookieHeader } } : {})
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForState(socket, status, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:updated', handler);
      reject(new Error(`Timeout menunggu state ${status}`));
    }, timeout);
    const handler = (state) => {
      if (state.status !== status) return;
      clearTimeout(timer);
      socket.off('room:updated', handler);
      resolve(state);
    };
    socket.on('room:updated', handler);
  });
}

async function signup(url, index) {
  const response = await fetch(`${url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: `Pemain ${index}`,
      email: `pemain${index}@example.com`,
      password: 'password-test'
    })
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

test('Quick Match tanpa host mengantrekan pemain baru hingga ronde berikutnya', { timeout: 20000 }, async (context) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'draw-guess-public-'));
  const dbPath = path.join(temp, 'db.json');
  await fs.writeFile(dbPath, JSON.stringify({ users: [], sessions: [], rooms: [], players: [], rounds: [], answers: [] }));
  const game = await createGameServer({
    dbPath,
    port: 0,
    passwordRounds: 4,
    countdownMs: 40,
    tickMs: 10,
    publicResultMs: 40,
    publicFinalMs: 40,
    publicMaxRound: 2
  });
  const address = await game.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];
  context.after(async () => {
    for (const client of clients) client.disconnect();
    await game.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const protectedPage = await fetch(`${url}/quick-match`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.match(protectedPage.headers.get('location'), /^\/login\?next=/);

  const guest = await connect(url); clients.push(guest);
  assert.equal((await emitAck(guest, 'public:quick-match')).ok, false);

  const cookies = [];
  for (let index = 1; index <= 5; index += 1) cookies.push(await signup(url, index));
  const quickMatchPage = await fetch(`${url}/quick-match`, { headers: { Cookie: cookies[0] } });
  assert.equal(quickMatchPage.status, 200);
  assert.match(await quickMatchPage.text(), /Mencari arena publik/);
  for (const cookie of cookies) clients.push(await connect(url, cookie));
  const players = [];

  for (let index = 0; index < 3; index += 1) {
    const matched = await emitAck(clients[index + 1], 'public:quick-match');
    assert.equal(matched.ok, true);
    assert.equal(matched.data.state.status, 'waiting');
    players.push(matched.data);
  }
  assert.equal(new Set(players.map((player) => player.roomId)).size, 1);

  const firstDrawing = clients.slice(1, 5).map((client) => waitForState(client, 'drawing'));
  const fourth = await emitAck(clients[4], 'public:quick-match');
  players.push(fourth.data);
  const roomId = fourth.data.roomId;
  assert.equal(fourth.ok, true);
  assert.equal(fourth.data.state.status, 'countdown');
  assert.equal(fourth.data.state.playerCount, 4);
  assert.equal(fourth.data.state.minPlayers, 4);
  assert.equal('secretWord' in fourth.data.state, false);

  const drawingStates = await Promise.all(firstDrawing);
  assert.equal(drawingStates.every((state) => state.status === 'drawing'), true);
  assert.equal(drawingStates.filter((state) => state.me.isDrawer).length, 1);
  assert.equal(drawingStates.filter((state) => 'leaderboard' in state).length, 0);

  const fifth = await emitAck(clients[5], 'public:quick-match');
  players.push(fifth.data);
  assert.equal(fifth.data.roomId, roomId);
  assert.equal(fifth.data.state.status, 'drawing');
  assert.equal(fifth.data.state.me.matchStatus, 'queued');
  assert.equal(fifth.data.state.me.isEligibleGuesser, false);
  assert.match((await emitAck(clients[5], 'player:submit-answer', {
    roomId,
    playerId: fifth.data.playerId,
    playerToken: fifth.data.playerToken,
    answer: game.store.room(roomId).currentWord
  })).error, /ronde berikutnya/i);

  assert.equal((await emitAck(guest, 'player:join', { roomId, name: 'Tamu' })).ok, false);
  assert.equal((await emitAck(guest, 'admin:start-countdown', { roomId, adminPin: '1234' })).ok, false);

  const firstResultPromise = waitForState(clients[5], 'round_result');
  const secondCountdownPromise = waitForState(clients[5], 'countdown');
  const firstWord = game.store.room(roomId).currentWord;
  for (let index = 0; index < 4; index += 1) {
    if (drawingStates[index].me.isDrawer) continue;
    const answer = await emitAck(clients[index + 1], 'player:submit-answer', {
      roomId,
      playerId: players[index].playerId,
      playerToken: players[index].playerToken,
      answer: firstWord
    });
    assert.equal(answer.ok, true);
  }
  const firstResult = await firstResultPromise;
  assert.equal(firstResult.leaderboard.length, 5);
  assert.equal(firstResult.currentRound, 1);

  const secondCountdown = await secondCountdownPromise;
  assert.equal(secondCountdown.currentRound, 2);
  assert.equal(secondCountdown.me.matchStatus, 'active');

  const secondDrawingPromise = waitForState(clients[5], 'drawing');
  const secondDrawing = await secondDrawingPromise;
  const secondWord = game.store.room(roomId).currentWord;
  const finalPromise = waitForState(clients[5], 'finished');
  for (let index = 0; index < players.length; index += 1) {
    const client = clients[index + 1];
    const resumed = await emitAck(client, 'player:resume', {
      roomId,
      playerId: players[index].playerId,
      playerToken: players[index].playerToken
    });
    if (resumed.data.state.me.isDrawer) continue;
    const answer = await emitAck(client, 'player:submit-answer', {
      roomId,
      playerId: players[index].playerId,
      playerToken: players[index].playerToken,
      answer: secondWord
    });
    assert.equal(answer.ok, true);
  }
  assert.equal(secondDrawing.me.matchStatus, 'active');
  const finalState = await finalPromise;
  assert.equal(finalState.currentRound, 2);
  assert.equal(finalState.leaderboard.length, 5);
});
