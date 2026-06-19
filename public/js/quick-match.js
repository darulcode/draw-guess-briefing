const socket = io();
const title = document.getElementById('matchTitle');
const status = document.getElementById('matchStatus');
const retry = document.getElementById('retryMatch');
const form = document.getElementById('quickMatchForm');
const nameInput = document.getElementById('quickMatchName');
const matchButton = document.getElementById('quickMatchButton');
let searching = false;

nameInput.value = localStorage.getItem('drawguess_public_name') || '';

async function resumePublicMatch() {
  const previous = JSON.parse(localStorage.getItem('drawguess_public_match') || 'null');
  if (!previous?.roomId || !previous?.playerId || !previous?.playerToken) return false;
  const response = await GameUI.socketAck(socket, 'player:resume', previous);
  if (!response?.ok || !response.data.state.isPublic) {
    localStorage.removeItem('drawguess_public_match');
    return false;
  }
  localStorage.setItem(`drawguess_player_${previous.roomId}`, JSON.stringify({ playerId: previous.playerId, playerToken: previous.playerToken }));
  location.replace(`/play/${previous.roomId}`);
  return true;
}

async function findMatch(name) {
  if (!socket.connected || searching) return;
  searching = true;
  form.classList.add('hidden');
  retry.classList.add('hidden');
  title.textContent = 'Mencari pemain...';
  status.textContent = 'Kami akan memasukkanmu ke room yang tersedia atau membuat room baru.';
  const response = await GameUI.socketAck(socket, 'public:quick-match', { name });
  if (!response?.ok) {
    searching = false;
    title.textContent = 'Belum berhasil masuk';
    status.textContent = response?.error || 'Quick Match sedang tidak tersedia.';
    retry.classList.remove('hidden');
    return;
  }

  const { roomId, playerId, playerToken, state } = response.data;
  localStorage.setItem('drawguess_public_name', name);
  localStorage.setItem(`drawguess_player_${roomId}`, JSON.stringify({ playerId, playerToken }));
  localStorage.setItem('drawguess_public_match', JSON.stringify({ roomId, playerId, playerToken }));
  title.textContent = state.status === 'waiting' ? `${state.playerCount}/${state.minPlayers} pemain ditemukan` : 'Match ditemukan!';
  status.textContent = 'Menyiapkan arena...';
  location.replace(`/play/${roomId}`);
}

socket.on('connect', async () => {
  matchButton.disabled = true;
  const resumed = await resumePublicMatch();
  if (!resumed) matchButton.disabled = false;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  findMatch(nameInput.value.trim());
});

retry.addEventListener('click', () => {
  searching = false;
  retry.classList.add('hidden');
  form.classList.remove('hidden');
  title.textContent = 'Siapa namamu?';
  status.textContent = 'Masukkan username, lalu kami akan mencarikan room yang tersedia.';
  nameInput.focus();
});
