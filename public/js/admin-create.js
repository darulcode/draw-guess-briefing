const socket = io();
const form = document.getElementById('createRoomForm');
const drawerMode = document.getElementById('drawerMode');
const adminPinField = document.getElementById('adminPinField');

function updateModeFields() {
  adminPinField.classList.toggle('hidden', drawerMode.value !== 'admin');
}
drawerMode.addEventListener('change', updateModeFields);
updateModeFields();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('createButton');
  const error = document.getElementById('formError');
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Membuat room...';
  const response = await GameUI.socketAck(socket, 'admin:create-room', {
    name: document.getElementById('sessionName').value,
    maxRound: document.getElementById('maxRound').value,
    duration: document.getElementById('duration').value,
    drawerMode: drawerMode.value,
    adminPin: document.getElementById('adminPin').value || '1234'
  });
  if (!response?.ok) {
    error.textContent = response?.error || 'Room gagal dibuat.';
    button.disabled = false;
    button.textContent = 'Buat Room Sekarang';
    return;
  }
  localStorage.setItem(`drawguess_host_${response.data.roomId}`, response.data.hostToken);
  location.href = `/admin/room/${response.data.roomId}`;
});
