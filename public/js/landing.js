document.getElementById('join').addEventListener('submit', (event) => {
  event.preventDefault();
  const roomId = document.getElementById('roomId').value.trim();
  if (!/^\d{6}$/.test(roomId)) return GameUI.toast('Room ID harus 6 digit.', 'error');
  location.href = `/join/${roomId}`;
});
