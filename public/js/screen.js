const socket = io();
const roomId = GameUI.roomIdFromPath();
let state = null;
let stopTimer = () => {};
let stopCountdown = () => {};
let previousStatus = '';
const canvas = new RealtimeCanvas(document.getElementById('screenCanvas'));

function show(view) {
  for (const id of ['screenWaiting', 'screenGame', 'screenResult', 'screenFinal']) document.getElementById(id).classList.toggle('hidden', id !== view);
}

function render(next) {
  state = next; stopTimer(); stopCountdown();
  document.getElementById('screenTitle').textContent = state.name;
  document.getElementById('screenStatus').textContent = state.status.replace('_', ' ');
  if (state.status === 'waiting') {
    show('screenWaiting'); canvas.clear();
    document.getElementById('screenRoomCode').textContent = state.id;
    document.getElementById('screenQr').src = state.qrUrl;
    document.getElementById('screenPlayerCount').textContent = state.playerCount;
    document.getElementById('screenParticipants').innerHTML = (state.players || []).map((player, index) => `<span class="screen-participant" style="animation-delay:${index * 45}ms">${GameUI.escapeHtml(player.name)}</span>`).join('');
  } else if (state.status === 'countdown' || state.status === 'drawing') {
    show('screenGame');
    document.getElementById('screenRound').textContent = `${state.currentRound} / ${state.maxRound}`;
    document.getElementById('screenDrawer').textContent = state.drawer?.name || '-';
    document.getElementById('screenCorrect').textContent = state.correctCount;
    if (state.status === 'countdown') stopCountdown = GameUI.showCountdown(document.getElementById('screenCountdown'), document.getElementById('screenCountdownNumber'), state.countdownEndsAt);
    if (state.status === 'drawing') stopTimer = GameUI.setTimer(document.getElementById('screenTimer'), state.endsAt);
  } else if (state.status === 'round_result') {
    show('screenResult');
    document.getElementById('screenResult').innerHTML = `<div class="card">${GameUI.resultHtml(state, true)}</div>`;
    if (previousStatus !== 'round_result') Confetti.burst(1400, 75);
  } else if (state.status === 'finished') {
    show('screenFinal');
    document.getElementById('screenFinal').innerHTML = GameUI.podiumHtml(state.leaderboard);
    if (previousStatus !== 'finished') Confetti.burst(4200, 280);
  }
  previousStatus = state.status;
}

socket.on('connect', async () => {
  const response = await GameUI.socketAck(socket, 'screen:watch', { roomId });
  if (!response?.ok) { GameUI.toast(response?.error || 'Room tidak ditemukan.', 'error'); return; }
  canvas.load(response.data.canvasHistory); render(response.data.state);
});
socket.on('room:updated', render);
socket.on('canvas:draw-start', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-move', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-end', (stroke) => canvas.apply(stroke));
socket.on('canvas:clear', () => canvas.clear());
