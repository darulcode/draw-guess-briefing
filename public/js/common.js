(function () {
  function roomIdFromPath() {
    return location.pathname.split('/').filter(Boolean).pop() || '';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function toast(message, type = '') {
    const element = document.getElementById('toast');
    if (!element) return;
    element.textContent = message;
    element.className = `toast ${type} show`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 2800);
  }

  function socketAck(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }

  function setTimer(element, endsAt) {
    if (!element) return () => {};
    const update = () => {
      const remaining = endsAt ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1000)) : 0;
      element.textContent = endsAt ? formatTime(remaining) : '--:--';
      element.classList.toggle('warning', remaining > 5 && remaining <= 15);
      element.classList.toggle('danger', remaining <= 5 && remaining > 0);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }

  function showCountdown(overlay, numberElement, endsAt) {
    if (!overlay || !numberElement || !endsAt) return () => {};
    overlay.classList.remove('hidden');
    let last = '';
    const update = () => {
      const remaining = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1000);
      const value = remaining > 0 ? String(remaining) : 'Mulai!';
      if (value !== last) {
        numberElement.textContent = value;
        numberElement.style.animation = 'none';
        requestAnimationFrame(() => { numberElement.style.animation = ''; });
        last = value;
      }
      if (remaining < 0) overlay.classList.add('hidden');
    };
    update();
    const timer = setInterval(update, 100);
    return () => { clearInterval(timer); overlay.classList.add('hidden'); };
  }

  function leaderboardHtml(items = [], limit) {
    const rows = limit ? items.slice(0, limit) : items;
    if (!rows.length) return '<div class="empty">Belum ada skor.</div>';
    return rows.map((item) => `<div class="rank-row"><span class="rank-number">${item.rank}</span><strong>${escapeHtml(item.name)}</strong><span>${item.score} poin</span></div>`).join('');
  }

  function resultHtml(state, projector = false) {
    const result = state.result;
    if (!result) return '<div class="empty">Hasil ronde belum tersedia.</div>';
    const skipped = result.status === 'skipped';
    const correctRows = result.correct.length
      ? result.correct.map((item) => `<div class="rank-row"><span class="rank-number">${item.rank}</span><strong>${escapeHtml(item.name)}</strong><span>+${item.points}</span></div>`).join('')
      : '<div class="empty">Belum ada jawaban benar.</div>';
    return `<div class="center"><span class="pill ${skipped ? 'round_result' : 'drawing'}">Ronde ${result.roundNumber} ${skipped ? 'dilewati' : 'selesai'}</span><h2 style="margin:18px 0 8px">${skipped ? 'Poin ronde dibatalkan' : 'Kata yang benar'}</h2><div class="result-word">${escapeHtml(result.word)}</div></div><div class="grid two" style="margin-top:28px;text-align:left"><div><h3>Urutan jawaban benar</h3>${correctRows}</div><div><h3>Poin penggambar</h3><div class="metric"><span>${escapeHtml(result.drawer?.name || '-')} · ${result.drawer?.correctCount || 0}/${result.drawer?.totalGuessers || 0} benar (${result.drawer?.percentage || 0}%)</span><strong>+${result.drawer?.score || 0} poin</strong></div><h3 style="margin-top:20px">Leaderboard sementara</h3>${leaderboardHtml(state.leaderboard, projector ? 8 : undefined)}</div></div>`;
  }

  function podiumHtml(items = []) {
    const byRank = Object.fromEntries(items.slice(0, 3).map((item) => [item.rank, item]));
    const place = (rank, className) => {
      const player = byRank[rank];
      if (!player) return `<div class="podium-place ${className}"><div class="podium-name">Belum ada</div><div class="podium-block">${rank}</div></div>`;
      return `<div class="podium-place ${className}"><div class="podium-name">${escapeHtml(player.name)}<br><small>${player.score} poin</small></div><div class="podium-block">${rank}</div></div>`;
    };
    return `<span class="eyebrow">Final leaderboard</span><h1 class="podium-title" style="margin:18px 0 0">Para juara hari ini</h1><div class="podium">${place(2, 'second')}${place(1, 'first')}${place(3, 'third')}</div>`;
  }

  window.GameUI = { escapeHtml, formatTime, leaderboardHtml, podiumHtml, resultHtml, roomIdFromPath, setTimer, showCountdown, socketAck, toast };
})();
