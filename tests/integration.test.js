const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { io: createClient } = require('socket.io-client');
const { createGameServer } = require('../src/game-server');

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForState(socket, status, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('room:updated', handler); reject(new Error(`Timeout menunggu state ${status}`)); }, timeout);
    const handler = (state) => {
      if (state.status !== status) return;
      clearTimeout(timer); socket.off('room:updated', handler); resolve(state);
    };
    socket.on('room:updated', handler);
  });
}

test('alur realtime menjaga privasi, rollback skip, scoring, dan final', { timeout: 15000 }, async (context) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'draw-guess-test-'));
  const dbPath = path.join(temp, 'db.json');
  await fs.writeFile(dbPath, JSON.stringify({ rooms: [], players: [], rounds: [], answers: [] }));
  const game = await createGameServer({ dbPath, port: 0, countdownMs: 5000, tickMs: 20, test: true });
  const address = await game.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];
  context.after(async () => {
    for (const client of clients) client.disconnect();
    await game.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const admin = await connect(url); clients.push(admin);
  const created = await emitAck(admin, 'admin:create-room', { name: 'Test Briefing', maxRound: 2, duration: 30 });
  assert.equal(created.ok, true);
  const { roomId, hostToken } = created.data;

  const sessions = [];
  for (const name of ['Dina', 'Budi', 'Sari']) {
    const client = await connect(url); clients.push(client);
    const joined = await emitAck(client, 'player:join', { roomId, name });
    assert.equal(joined.ok, true);
    sessions.push({ client, playerId: joined.data.playerId, playerToken: joined.data.playerToken });
  }
  const [drawer, guesserOne, guesserTwo] = sessions;
  const screen = await connect(url); clients.push(screen);
  assert.equal((await emitAck(screen, 'screen:watch', { roomId })).ok, true);

  let secretReceived = null;
  drawer.client.once('drawer:secret-word', ({ word }) => { secretReceived = word; });
  const started = await emitAck(admin, 'admin:start-countdown', { roomId, hostToken, drawerId: drawer.playerId, word: ' Payung ', duration: 30 });
  assert.equal(started.ok, true);
  assert.equal((await emitAck(admin, 'admin:start-round', { roomId, hostToken })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secretReceived, 'payung');

  const playerView = await emitAck(guesserOne.client, 'player:resume', { roomId, playerId: guesserOne.playerId, playerToken: guesserOne.playerToken });
  const screenView = await emitAck(screen, 'screen:watch', { roomId });
  assert.equal(playerView.data.state.status, 'drawing');
  assert.equal('secretWord' in playerView.data.state, false);
  assert.equal('leaderboard' in playerView.data.state, false);
  assert.equal('secretWord' in screenView.data.state, false);
  assert.equal('leaderboard' in screenView.data.state, false);

  const deniedDraw = await emitAck(guesserOne.client, 'drawer:draw-start', { roomId, playerId: guesserOne.playerId, playerToken: guesserOne.playerToken, stroke: { x: .2, y: .2, color: '#7557ff', size: 5 } });
  assert.equal(deniedDraw.ok, false);
  const allowedDraw = await emitAck(drawer.client, 'drawer:draw-start', { roomId, playerId: drawer.playerId, playerToken: drawer.playerToken, stroke: { x: .2, y: .2, color: '#7557ff', size: 5 } });
  assert.equal(allowedDraw.ok, true);

  assert.equal((await emitAck(guesserOne.client, 'player:submit-answer', { roomId, playerId: guesserOne.playerId, playerToken: guesserOne.playerToken, answer: 'payong' })).data.correct, false);
  assert.equal((await emitAck(guesserOne.client, 'player:submit-answer', { roomId, playerId: guesserOne.playerId, playerToken: guesserOne.playerToken, answer: ' PAYUNG ' })).data.points, 100);
  assert.equal((await emitAck(admin, 'admin:stop-round', { roomId, hostToken: 'token-salah' })).ok, false);
  assert.equal((await emitAck(admin, 'admin:skip-round', { roomId, hostToken })).ok, true);

  const afterSkip = await emitAck(admin, 'admin:resume', { roomId, hostToken });
  assert.equal(afterSkip.data.state.result.status, 'skipped');
  assert.equal(afterSkip.data.state.players.find((item) => item.id === guesserOne.playerId).score, 0);
  assert.equal(afterSkip.data.state.answers.find((item) => item.isCorrect).rolledBack, true);

  assert.equal((await emitAck(admin, 'admin:next-round', { roomId, hostToken })).ok, true);
  assert.equal((await emitAck(admin, 'admin:start-countdown', { roomId, hostToken, drawerId: drawer.playerId, word: 'kucing', duration: 30 })).ok, true);
  assert.equal((await emitAck(admin, 'admin:start-round', { roomId, hostToken })).ok, true);
  assert.equal((await emitAck(guesserOne.client, 'player:submit-answer', { roomId, playerId: guesserOne.playerId, playerToken: guesserOne.playerToken, answer: 'kucing' })).data.points, 100);
  const roundEnded = waitForState(screen, 'round_result');
  assert.equal((await emitAck(guesserTwo.client, 'player:submit-answer', { roomId, playerId: guesserTwo.playerId, playerToken: guesserTwo.playerToken, answer: 'KUCING' })).data.points, 90);
  const resultState = await roundEnded;
  assert.equal(resultState.result.drawer.bonus, 10);
  assert.deepEqual(resultState.leaderboard.map((item) => item.score), [100, 90, 10]);

  const finalStatePromise = waitForState(screen, 'finished');
  assert.equal((await emitAck(admin, 'admin:next-round', { roomId, hostToken })).ok, true);
  const finalState = await finalStatePromise;
  assert.equal(finalState.leaderboard.length, 3);
  assert.equal(finalState.leaderboard[0].name, 'Budi');
});
