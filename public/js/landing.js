document.getElementById('join').addEventListener('submit', (event) => {
  event.preventDefault();
  const roomId = document.getElementById('roomId').value.trim();
  if (!/^\d{6}$/.test(roomId)) return GameUI.toast('Room ID harus 6 digit.', 'error');
  location.href = `/join/${roomId}`;
});

(async function renderAuth() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json();
    const user = result.data.user;
    document.getElementById(user ? 'authUser' : 'authGuest').classList.remove('hidden');
    if (!user) return;
    document.getElementById('accountName').textContent = user.displayName;
    document.getElementById('accountInitial').textContent = user.displayName.slice(0, 1).toUpperCase();
    document.getElementById('landingLogout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      location.reload();
    });
  } catch {
    document.getElementById('authGuest').classList.remove('hidden');
  }
})();
