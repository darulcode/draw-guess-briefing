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

test('alur admin PIN, word bank, scoring persentase, dan penggambar otomatis', { timeout: 20000 }, async (context) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'draw-guess-test-'));
  const dbPath = path.join(temp, 'db.json');
  await fs.writeFile(dbPath, JSON.stringify({ rooms: [], players: [], rounds: [], answers: [] }));
  const game = await createGameServer({ dbPath, port: 0, countdownMs: 5000, tickMs: 20, test: true });
  const address = await game.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  const wordBank = new Set(JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'words.json'))).map((entry) => entry.word.toLowerCase()));
  const clients = [];
  context.after(async () => {
    for (const client of clients) client.disconnect();
    await game.close();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const admin = await connect(url); clients.push(admin);
  const created = await emitAck(admin, 'admin:create-room', { name: 'Mode Admin', maxRound: 3, duration: 30, drawerMode: 'admin', adminPin: '1234' });
  assert.equal(created.ok, true);
  const { roomId, hostToken } = created.data;
  const legacyAdminPage = await fetch(`${url}/admin/room/${roomId}`, { redirect: 'manual' });
  assert.equal(legacyAdminPage.status, 302);
  assert.equal(legacyAdminPage.headers.get('location'), `/screen/${roomId}`);

  const adminPlayerClient = await connect(url); clients.push(adminPlayerClient);
  const wrongPin = await emitAck(adminPlayerClient, 'player:join', { roomId, name: 'admin', adminPin: '9999' });
  assert.equal(wrongPin.ok, false);
  assert.equal(wrongPin.error, 'PIN admin salah.');

  async function join(client, name, adminPin) {
    const response = await emitAck(client, 'player:join', { roomId, name, adminPin });
    assert.equal(response.ok, true);
    return { client, playerId: response.data.playerId, playerToken: response.data.playerToken };
  }

  const adminPlayer = await join(adminPlayerClient, 'Admin', '1234');
  const budiClient = await connect(url); clients.push(budiClient);
  const sariClient = await connect(url); clients.push(sariClient);
  const budi = await join(budiClient, 'Budi');
  const sari = await join(sariClient, 'Sari');
  const screen = await connect(url); clients.push(screen);
  const publicScreen = await emitAck(screen, 'screen:watch', { roomId });
  assert.equal(publicScreen.ok, true);
  assert.equal(publicScreen.data.isHost, false);
  const hostScreen = await connect(url); clients.push(hostScreen);
  const authenticatedScreen = await emitAck(hostScreen, 'screen:watch', { roomId, hostToken });
  assert.equal(authenticatedScreen.ok, true);
  assert.equal(authenticatedScreen.data.isHost, true);

  async function startAdminRound() {
    let secretWord = null;
    adminPlayer.client.once('drawer:secret-word', ({ word }) => { secretWord = word; });
    const started = await emitAck(admin, 'admin:start-countdown', { roomId, hostToken });
    assert.equal(started.ok, true);
    assert.equal(started.data.state.drawer.id, adminPlayer.playerId);
    assert.equal(wordBank.has(started.data.state.secretWord), true);
    assert.equal((await emitAck(admin, 'admin:start-round', { roomId, hostToken })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secretWord, started.data.state.secretWord);
    return secretWord;
  }

  const firstWord = await startAdminRound();
  const playerView = await emitAck(budi.client, 'player:resume', { roomId, playerId: budi.playerId, playerToken: budi.playerToken });
  const screenView = await emitAck(screen, 'screen:watch', { roomId });
  assert.equal(playerView.data.state.status, 'drawing');
  assert.equal('secretWord' in playerView.data.state, false);
  assert.equal('leaderboard' in playerView.data.state, false);
  assert.equal('secretWord' in screenView.data.state, false);
  assert.equal('leaderboard' in screenView.data.state, false);

  assert.equal((await emitAck(budi.client, 'drawer:draw-start', { roomId, playerId: budi.playerId, playerToken: budi.playerToken, stroke: { x: .2, y: .2, color: '#7557ff', size: 5 } })).ok, false);
  assert.equal((await emitAck(adminPlayer.client, 'drawer:draw-start', { roomId, playerId: adminPlayer.playerId, playerToken: adminPlayer.playerToken, stroke: { x: .2, y: .2, color: '#7557ff', size: 5 } })).ok, true);
  assert.equal((await emitAck(budi.client, 'player:submit-answer', { roomId, playerId: budi.playerId, playerToken: budi.playerToken, answer: firstWord })).data.points, 100);
  assert.equal((await emitAck(admin, 'admin:skip-round', { roomId, hostToken })).ok, true);
  const afterSkip = await emitAck(admin, 'admin:resume', { roomId, hostToken });
  assert.equal(afterSkip.data.state.players.find((item) => item.id === budi.playerId).score, 0);

  assert.equal((await emitAck(admin, 'admin:next-round', { roomId, hostToken })).ok, true);
  const secondWord = await startAdminRound();
  assert.notEqual(secondWord, firstWord);
  assert.equal((await emitAck(budi.client, 'player:submit-answer', { roomId, playerId: budi.playerId, playerToken: budi.playerToken, answer: secondWord })).data.points, 100);
  assert.equal((await emitAck(admin, 'admin:stop-round', { roomId, hostToken })).ok, true);
  const halfResult = await emitAck(admin, 'admin:resume', { roomId, hostToken });
  assert.equal(halfResult.data.state.result.drawer.percentage, 50);
  assert.equal(halfResult.data.state.result.drawer.score, 50);

  assert.equal((await emitAck(admin, 'admin:next-round', { roomId, hostToken })).ok, true);
  const thirdWord = await startAdminRound();
  const roundEnded = waitForState(screen, 'round_result');
  assert.equal((await emitAck(budi.client, 'player:submit-answer', { roomId, playerId: budi.playerId, playerToken: budi.playerToken, answer: thirdWord })).data.points, 100);
  assert.equal((await emitAck(sari.client, 'player:submit-answer', { roomId, playerId: sari.playerId, playerToken: sari.playerToken, answer: thirdWord.toUpperCase() })).data.points, 90);
  const fullResult = await roundEnded;
  assert.equal(fullResult.result.drawer.percentage, 100);
  assert.equal(fullResult.result.drawer.score, 100);
  assert.deepEqual(fullResult.leaderboard.map((item) => item.score), [200, 150, 90]);

  const finalStatePromise = waitForState(screen, 'finished');
  assert.equal((await emitAck(admin, 'admin:next-round', { roomId, hostToken })).ok, true);
  assert.equal((await finalStatePromise).leaderboard[0].name, 'Budi');

  const manualRoom = await emitAck(admin, 'admin:create-room', { name: 'Mode Manual', maxRound: 1, duration: 30, drawerMode: 'manual' });
  assert.equal(manualRoom.ok, true);
  const manualRoomId = manualRoom.data.roomId;
  const manualHostToken = manualRoom.data.hostToken;
  const linaClient = await connect(url); clients.push(linaClient);
  const rakaClient = await connect(url); clients.push(rakaClient);
  const lina = await emitAck(linaClient, 'player:join', { roomId: manualRoomId, name: 'Lina' });
  const raka = await emitAck(rakaClient, 'player:join', { roomId: manualRoomId, name: 'Raka' });
  assert.equal(lina.ok && raka.ok, true);
  const manualStart = await emitAck(admin, 'admin:start-countdown', { roomId: manualRoomId, hostToken: manualHostToken });
  assert.equal(manualStart.ok, true);
  assert.equal([lina.data.playerId, raka.data.playerId].includes(manualStart.data.state.drawer.id), true);
  assert.equal(wordBank.has(manualStart.data.state.secretWord), true);
});
