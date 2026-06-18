const socket = io();
const roomId = GameUI.roomIdFromPath();
const session = JSON.parse(localStorage.getItem(`drawguess_player_${roomId}`) || 'null');
let state = null;
let secret = '';
let stopTimer = () => {};
let stopCountdown = () => {};
let previousStatus = '';

if (!session) location.replace(`/join/${roomId}`);

const canvas = new RealtimeCanvas(document.getElementById('gameCanvas'), {
  start: (stroke) => socket.emit('drawer:draw-start', { roomId, ...session, stroke }),
  move: (stroke) => socket.emit('drawer:draw-move', { roomId, ...session, stroke }),
  end: (stroke) => socket.emit('drawer:draw-end', { roomId, ...session, stroke })
});

function show(view) {
  for (const id of ['waitingView', 'gameView', 'resultView', 'finalView']) document.getElementById(id).classList.toggle('hidden', id !== view);
}

function render(next) {
  state = next;
  document.getElementById('scoreBadge').textContent = `${state.me.score} poin`;
  document.getElementById('roundBadge').textContent = state.currentRound ? `Ronde ${state.currentRound} / ${state.maxRound}` : 'Menunggu';
  stopTimer(); stopCountdown();
  if (state.status === 'waiting') {
    show('waitingView'); canvas.setEnabled(false); secret = '';
    document.getElementById('gameTitle').textContent = 'Room sedang bersiap';
    document.getElementById('waitingNames').innerHTML = (state.players || []).map((player) => `<span class="waiting-name">${GameUI.escapeHtml(player.name)}</span>`).join('');
    document.getElementById('playerTimer').textContent = '--:--';
    document.getElementById('guessInput').disabled = false;
    document.getElementById('guessButton').disabled = false;
    document.getElementById('guessInput').value = '';
    document.getElementById('answerStatus').className = 'answer-status';
    document.getElementById('answerStatus').textContent = '';
  } else if (state.status === 'countdown' || state.status === 'drawing') {
    show('gameView');
    const isDrawer = state.me.isDrawer;
    document.getElementById('gameTitle').textContent = isDrawer ? 'Saatnya menggambar!' : `Tebak gambar ${state.drawer?.name || ''}`;
    document.getElementById('roleBanner').textContent = isDrawer ? 'Kamu adalah penggambar ronde ini' : state.me.isEligibleGuesser ? `Penggambar: ${state.drawer?.name || '-'}` : 'Kamu masuk setelah ronde dimulai. Tunggu ronde berikutnya.';
    document.getElementById('drawerToolbar').classList.toggle('hidden', !isDrawer || state.status !== 'drawing');
    document.getElementById('guessForm').classList.toggle('hidden', isDrawer || !state.me.isEligibleGuesser || state.status !== 'drawing');
    document.getElementById('secretWord').classList.toggle('hidden', !isDrawer || !secret);
    document.getElementById('secretWord').textContent = secret ? `Kata: ${secret.toUpperCase()}` : '';
    canvas.setEnabled(isDrawer && state.status === 'drawing');
    if (state.canGuess) {
      document.getElementById('guessInput').disabled = false;
      document.getElementById('guessButton').disabled = false;
    }
    if (state.me.hasCorrect) {
      document.getElementById('guessForm').classList.remove('hidden');
      document.getElementById('guessInput').disabled = true;
      document.getElementById('guessButton').disabled = true;
      const status = document.getElementById('answerStatus'); status.className = 'answer-status correct'; status.textContent = 'Kamu sudah menjawab benar!';
    }
    if (state.status === 'countdown') stopCountdown = GameUI.showCountdown(document.getElementById('countdown'), document.getElementById('countdownNumber'), state.countdownEndsAt);
    if (state.status === 'drawing') stopTimer = GameUI.setTimer(document.getElementById('playerTimer'), state.endsAt);
  } else if (state.status === 'round_result') {
    show('resultView'); canvas.setEnabled(false); secret = '';
    document.getElementById('gameTitle').textContent = 'Ronde selesai';
    document.getElementById('resultView').innerHTML = GameUI.resultHtml(state);
    document.getElementById('playerTimer').textContent = '--:--';
    if (previousStatus !== 'round_result') Confetti.burst(1300, 65);
  } else if (state.status === 'finished') {
    show('finalView'); canvas.setEnabled(false);
    document.getElementById('gameTitle').textContent = 'Game selesai';
    document.getElementById('finalView').innerHTML = GameUI.podiumHtml(state.leaderboard);
    document.getElementById('playerTimer').textContent = '--:--';
    if (previousStatus !== 'finished') Confetti.burst(3500, 220);
  }
  previousStatus = state.status;
}

async function resume() {
  if (!session) return;
  const response = await GameUI.socketAck(socket, 'player:resume', { roomId, ...session });
  if (!response?.ok) { localStorage.removeItem(`drawguess_player_${roomId}`); location.replace(`/join/${roomId}`); return; }
  canvas.load(response.data.canvasHistory);
  render(response.data.state);
}

socket.on('connect', resume);
socket.on('room:updated', render);
socket.on('drawer:secret-word', ({ word }) => { secret = word; if (state) render(state); });
socket.on('canvas:draw-start', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-move', (stroke) => canvas.apply(stroke));
socket.on('canvas:draw-end', (stroke) => canvas.apply(stroke));
socket.on('canvas:clear', () => canvas.clear());
socket.on('answer:result', (result) => {
  const element = document.getElementById('answerStatus');
  element.className = `answer-status ${result.correct ? 'correct' : 'wrong'}`;
  element.textContent = result.message;
  if (result.correct) { document.getElementById('guessInput').disabled = true; document.getElementById('guessButton').disabled = true; Confetti.burst(1100, 55); }
  else { document.getElementById('guessInput').classList.add('shake'); setTimeout(() => document.getElementById('guessInput').classList.remove('shake'), 400); }
});

document.getElementById('guessForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('guessInput');
  const response = await GameUI.socketAck(socket, 'player:submit-answer', { roomId, ...session, answer: input.value });
  if (!response?.ok) GameUI.toast(response?.error || 'Jawaban gagal dikirim.', 'error');
  else if (!response.data.correct) { input.select(); }
});

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tool]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active'); canvas.tool = button.dataset.tool;
}));
document.getElementById('brushColor').addEventListener('input', (event) => { canvas.color = event.target.value; canvas.tool = 'brush'; });
document.getElementById('brushSize').addEventListener('input', (event) => { canvas.size = Number(event.target.value); });
document.getElementById('clearCanvas').addEventListener('click', () => {
  if (confirm('Bersihkan seluruh canvas?')) socket.emit('drawer:clear-canvas', { roomId, ...session });
});
