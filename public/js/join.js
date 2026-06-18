const socket = io();
const roomId = GameUI.roomIdFromPath();
const storageKey = `drawguess_player_${roomId}`;
document.getElementById('joinRoomCode').textContent = roomId;
const playerName = document.getElementById('playerName');
const adminPinField = document.getElementById('joinAdminPinField');

function updateAdminPin() {
  const needsPin = playerName.value.trim().toLowerCase() === 'admin';
  adminPinField.classList.toggle('hidden', !needsPin);
  document.getElementById('joinAdminPin').required = needsPin;
}
playerName.addEventListener('input', updateAdminPin);

socket.on('connect', async () => {
  const existing = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (!existing) return;
  const response = await GameUI.socketAck(socket, 'player:resume', { roomId, ...existing });
  if (response?.ok) location.replace(`/play/${roomId}`);
  else localStorage.removeItem(storageKey);
});

document.getElementById('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('joinButton');
  const error = document.getElementById('joinError');
  error.textContent = ''; button.disabled = true;
  const response = await GameUI.socketAck(socket, 'player:join', { roomId, name: playerName.value, adminPin: document.getElementById('joinAdminPin').value });
  if (!response?.ok) {
    error.textContent = response?.error || 'Tidak dapat bergabung.';
    button.disabled = false;
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify({ playerId: response.data.playerId, playerToken: response.data.playerToken }));
  location.replace(`/play/${roomId}`);
});
