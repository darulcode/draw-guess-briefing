const socket = io();
const title = document.getElementById('matchTitle');
const status = document.getElementById('matchStatus');
const retry = document.getElementById('retryMatch');
let searching = false;

async function findMatch() {
  if (!socket.connected || searching) return;
  searching = true;
  retry.classList.add('hidden');
  title.textContent = 'Mencari pemain...';
  status.textContent = 'Kami akan memasukkanmu ke room yang tersedia atau membuat room baru.';
  const response = await GameUI.socketAck(socket, 'public:quick-match', {});
  if (!response?.ok) {
    searching = false;
    title.textContent = 'Belum berhasil masuk';
    status.textContent = response?.error || 'Quick Match sedang tidak tersedia.';
    retry.classList.remove('hidden');
    return;
  }

  const { roomId, playerId, playerToken, state } = response.data;
  localStorage.setItem(`drawguess_player_${roomId}`, JSON.stringify({ playerId, playerToken }));
  localStorage.setItem('drawguess_public_match', JSON.stringify({ roomId, playerId }));
  title.textContent = state.status === 'waiting' ? `${state.playerCount}/${state.minPlayers} pemain ditemukan` : 'Match ditemukan!';
  status.textContent = 'Menyiapkan arena...';
  location.replace(`/play/${roomId}`);
}

socket.on('connect', findMatch);
retry.addEventListener('click', findMatch);
