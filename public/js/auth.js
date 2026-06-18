(function () {
  const page = document.body.dataset.authPage;
  const params = new URLSearchParams(location.search);
  const requestedNext = params.get('next') || (page === 'account' ? '/account' : '/admin');
  const next = requestedNext.startsWith('/') && !requestedNext.startsWith('//') && !requestedNext.includes('\\') ? requestedNext : '/';

  async function authState() {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    return response.json();
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    return response.json();
  }

  async function setupForm() {
    const state = await authState();
    const google = document.getElementById('googleAuth');
    const unavailable = document.getElementById('googleUnavailable');
    if (state.data.googleEnabled) {
      google.href = `/auth/google?next=${encodeURIComponent(next)}`;
      google.classList.remove('hidden');
    } else {
      unavailable.classList.remove('hidden');
    }
    const alternate = document.getElementById(page === 'login' ? 'signupLink' : 'loginLink');
    alternate.href = `${page === 'login' ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`;
    const queryError = params.get('error');
    if (queryError) document.getElementById('authError').textContent = queryError;

    document.getElementById('authForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = document.getElementById('authError');
      const button = document.getElementById('authSubmit');
      error.textContent = '';
      button.disabled = true;
      const payload = {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
        next
      };
      if (page === 'signup') {
        payload.displayName = document.getElementById('displayName').value;
        if (payload.password !== document.getElementById('confirmPassword').value) {
          error.textContent = 'Konfirmasi password tidak sama.';
          button.disabled = false;
          return;
        }
      }
      try {
        const result = await post(`/api/auth/${page}`, payload);
        if (!result.ok) throw new Error(result.error || 'Autentikasi gagal.');
        location.href = result.data.next || next;
      } catch (failure) {
        error.textContent = failure.message;
        button.disabled = false;
      }
    });
  }

  async function setupAccount() {
    const state = await authState();
    const user = state.data.user;
    if (!user) { location.href = '/login?next=/account'; return; }
    document.getElementById('accountName').textContent = user.displayName;
    document.getElementById('accountEmail').textContent = user.email;
    document.getElementById('passwordStatus').textContent = user.hasPassword ? 'Aktif' : 'Belum diatur';
    document.getElementById('googleStatus').textContent = user.hasGoogle ? 'Terhubung' : 'Belum terhubung';
    const avatar = document.getElementById('accountAvatar');
    if (user.avatarUrl) avatar.innerHTML = `<img src="${GameUI.escapeHtml(user.avatarUrl)}" alt="">`;
    else avatar.textContent = user.displayName.slice(0, 1).toUpperCase();
    if (!user.hasGoogle && state.data.googleEnabled) document.getElementById('connectGoogle').classList.remove('hidden');
    document.getElementById('logoutButton').addEventListener('click', async () => {
      await post('/api/auth/logout', {});
      location.href = '/';
    });
  }

  if (page === 'account') setupAccount().catch(() => GameUI.toast('Gagal memuat akun.', 'error'));
  else setupForm().catch(() => { document.getElementById('authError').textContent = 'Gagal memuat konfigurasi login.'; });
})();
