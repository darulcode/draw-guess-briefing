const socket = io();
const roomId = GameUI.roomIdFromPath();
const hostToken = localStorage.getItem(`drawguess_host_${roomId}`);
const screenPinKey = `drawguess_screen_pin_${roomId}`;
let screenPin = sessionStorage.getItem(screenPinKey) || '';
let state = null;
let isHost = false;
let stopTimer = () => {};
let stopCountdown = () => {};
let previousStatus = '';
const canvas = new RealtimeCanvas(document.getElementById('screenCanvas'));

function show(view) {
  for (const id of ['screenWaiting', 'screenGame', 'screenResult', 'screenFinal']) document.getElementById(id).classList.toggle('hidden', id !== view);
}

function renderHostControls() {
  const unlock = document.getElementById('screenUnlock');
  const action = document.getElementById('screenPrimaryAction');
  unlock.classList.toggle('hidden', isHost);
  if (!isHost || !state) { action.classList.add('hidden'); return; }
  const canStart = state.status === 'waiting';
  const canContinue = state.status === 'round_result';
  action.classList.toggle('hidden', !canStart && !canContinue);
  if (canStart) {
    action.textContent = 'Start Ronde';
    action.dataset.event = 'admin:start-countdown';
    action.className = 'btn success screen-primary-action';
  } else if (canContinue) {
    action.textContent = state.currentRound >= state.maxRound ? 'Tampilkan Juara' : 'Ronde Berikutnya';
    action.dataset.event = 'admin:next-round';
    action.className = 'btn secondary screen-primary-action';
  }
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
  renderHostControls();
  previousStatus = state.status;
}

socket.on('connect', async () => {
  const response = await GameUI.socketAck(socket, 'screen:watch', { roomId, hostToken, adminPin: screenPin });
  if (!response?.ok) { GameUI.toast(response?.error || 'Room tidak ditemukan.', 'error'); return; }
  isHost = response.data.isHost;
  canvas.load(response.data.canvasHistory); render(response.data.state);
});
socket.on('room:updated', render);
socket.on('canvas:draw-start', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-move', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-end', (stroke) => canvas.apply(stroke));
socket.on('canvas:clear', () => canvas.clear());

async function hostAction(event) {
  if (!isHost) return;
  const response = await GameUI.socketAck(socket, event, { roomId, hostToken, adminPin: screenPin });
  if (!response?.ok) GameUI.toast(response?.error || 'Aksi gagal.', 'error');
}

document.getElementById('screenPrimaryAction').addEventListener('click', (event) => hostAction(event.currentTarget.dataset.event));

document.getElementById('screenUnlock').addEventListener('click', () => {
  document.getElementById('screenPinModal').classList.remove('hidden');
  document.getElementById('screenHostPin').focus();
});
document.getElementById('screenPinCancel').addEventListener('click', () => document.getElementById('screenPinModal').classList.add('hidden'));
document.getElementById('screenPinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = document.getElementById('screenHostPin').value;
  const error = document.getElementById('screenPinError');
  error.textContent = '';
  const response = await GameUI.socketAck(socket, 'screen:authenticate-host', { roomId, adminPin: pin });
  if (!response?.ok) { error.textContent = response?.error || 'PIN host salah.'; return; }
  screenPin = pin;
  sessionStorage.setItem(screenPinKey, pin);
  isHost = true;
  document.getElementById('screenPinModal').classList.add('hidden');
  renderHostControls();
  GameUI.toast('Kontrol host aktif.');
});
