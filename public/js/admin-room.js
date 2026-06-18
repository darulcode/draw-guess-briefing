const socket = io();
const roomId = GameUI.roomIdFromPath();
const hostToken = localStorage.getItem(`drawguess_host_${roomId}`);
let state = null;
let stopTimer = () => {};
let initializedDuration = false;

function setHidden(id, hidden) { document.getElementById(id).classList.toggle('hidden', hidden); }

function renderPlayers(players = []) {
  const list = document.getElementById('playerList');
  const select = document.getElementById('drawerSelect');
  const selected = select.value;
  document.getElementById('playerCount').textContent = `${players.length} orang`;
  list.innerHTML = players.length ? players.map((player, index) => `<li class="list-item" style="animation-delay:${index * 35}ms"><span class="avatar">${GameUI.escapeHtml(player.name.charAt(0).toUpperCase())}</span><span class="grow"><strong>${GameUI.escapeHtml(player.name)}</strong><br><small class="muted">${player.score} poin</small></span><span class="online-dot ${player.isOnline ? 'on' : ''}" title="${player.isOnline ? 'Online' : 'Offline'}"></span></li>`).join('') : '<li class="empty">Belum ada peserta.</li>';
  select.innerHTML = '<option value="">Pilih peserta...</option>' + players.map((player) => `<option value="${player.id}">${GameUI.escapeHtml(player.name)}</option>`).join('');
  if (players.some((player) => player.id === selected)) select.value = selected;
}

function renderAnswers(answers = []) {
  const feed = document.getElementById('answerFeed');
  feed.innerHTML = answers.length ? [...answers].reverse().map((answer) => `<div class="answer-row ${answer.isCorrect ? 'correct' : 'wrong'}"><strong>${GameUI.escapeHtml(answer.name)}</strong><span>${GameUI.escapeHtml(answer.answer)}</span><b>${answer.rolledBack ? 'dibatalkan' : answer.isCorrect ? `+${answer.points}` : 'belum'}</b></div>`).join('') : '<div class="empty">Jawaban akan muncul di sini.</div>';
}

function render(next) {
  state = next;
  setHidden('authError', true); setHidden('dashboard', false);
  document.getElementById('sessionTitle').textContent = state.name;
  document.title = `${state.name} | Host`;
  document.getElementById('roomCode').textContent = state.id;
  document.getElementById('qrImage').src = state.qrUrl;
  document.getElementById('joinUrl').textContent = state.joinUrl;
  document.getElementById('screenLink').href = `/screen/${state.id}`;
  document.getElementById('statusPill').className = `pill ${state.status}`;
  document.getElementById('statusPill').textContent = state.status.replace('_', ' ');
  document.getElementById('statusMetric').textContent = state.status.replace('_', ' ');
  document.getElementById('roundLabel').textContent = `Ronde ${state.currentRound} / ${state.maxRound}`;
  renderPlayers(state.players);
  renderAnswers(state.answers);
  document.getElementById('adminLeaderboard').innerHTML = GameUI.leaderboardHtml(state.leaderboard);
  if (!initializedDuration) { document.getElementById('roundDuration').value = String(state.duration); initializedDuration = true; }

  const active = state.status === 'countdown' || state.status === 'drawing';
  const result = state.status === 'round_result';
  document.getElementById('startRound').disabled = state.status !== 'waiting';
  document.getElementById('stopRound').disabled = !active;
  document.getElementById('skipRound').disabled = !active;
  document.getElementById('nextRound').disabled = !result;
  document.getElementById('nextRound').textContent = state.currentRound >= state.maxRound ? 'Tampilkan Juara' : 'Ronde Berikutnya';
  document.getElementById('drawerSelect').disabled = state.status !== 'waiting';
  document.getElementById('secretWord').disabled = state.status !== 'waiting';
  document.getElementById('roundDuration').disabled = state.status !== 'waiting';
  document.getElementById('randomWord').disabled = state.status !== 'waiting';
  const preview = document.getElementById('secretPreview');
  preview.classList.toggle('hidden', !state.secretWord || !active);
  preview.textContent = state.secretWord ? `Kata: ${state.secretWord.toUpperCase()}` : '';
  stopTimer();
  stopTimer = GameUI.setTimer(document.getElementById('timerMetric'), state.status === 'drawing' ? state.endsAt : null);
}

async function resume() {
  if (!hostToken) { setHidden('authError', false); setHidden('dashboard', true); return; }
  const response = await GameUI.socketAck(socket, 'admin:resume', { roomId, hostToken });
  if (!response?.ok) { setHidden('authError', false); setHidden('dashboard', true); return; }
  render(response.data.state);
}

socket.on('connect', resume);
socket.on('room:updated', render);
socket.on('game:finished', () => GameUI.toast('Game selesai. Podium tampil di layar pemain dan projector.'));

document.getElementById('copyLink').addEventListener('click', async () => {
  if (!state) return;
  await navigator.clipboard.writeText(state.joinUrl);
  GameUI.toast('Link join disalin.');
});

document.getElementById('randomWord').addEventListener('click', async () => {
  const response = await GameUI.socketAck(socket, 'admin:random-word', { roomId, hostToken });
  if (response?.ok) document.getElementById('secretWord').value = response.data.word;
  else GameUI.toast(response?.error || 'Gagal memilih kata.', 'error');
});

document.getElementById('startRound').addEventListener('click', async () => {
  const error = document.getElementById('controlError'); error.textContent = '';
  const response = await GameUI.socketAck(socket, 'admin:start-countdown', {
    roomId, hostToken,
    drawerId: document.getElementById('drawerSelect').value,
    word: document.getElementById('secretWord').value,
    duration: document.getElementById('roundDuration').value
  });
  if (!response?.ok) error.textContent = response?.error || 'Ronde gagal dimulai.';
  else document.getElementById('secretWord').value = '';
});

async function adminAction(event, confirmation) {
  if (confirmation && !confirm(confirmation)) return;
  const response = await GameUI.socketAck(socket, event, { roomId, hostToken });
  if (!response?.ok) GameUI.toast(response?.error || 'Aksi gagal.', 'error');
}
document.getElementById('stopRound').addEventListener('click', () => adminAction('admin:stop-round', 'Hentikan ronde dan hitung hasil sekarang?'));
document.getElementById('skipRound').addEventListener('click', () => adminAction('admin:skip-round', 'Lewati ronde? Semua poin ronde ini akan dibatalkan.'));
document.getElementById('nextRound').addEventListener('click', () => adminAction('admin:next-round'));
document.getElementById('resetButton').addEventListener('click', () => adminAction('admin:reset-game', 'Reset seluruh ronde dan skor? Peserta tetap berada di room.'));
