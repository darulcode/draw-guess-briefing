const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransition,
  getDrawerBonus,
  getPointsByRank,
  hashToken,
  leaderboard,
  normalizeAnswer,
  safeTokenEquals,
  sanitizeStroke,
  validateName
} = require('../src/game-utils');

test('normalisasi jawaban mengabaikan kapital dan spasi berlebih', () => {
  assert.equal(normalizeAnswer('  UANG   Tunai '), 'uang tunai');
  assert.equal(normalizeAnswer('PAYUNG'), normalizeAnswer(' payung '));
});

test('validasi nama menerapkan batas 2 sampai 20 karakter', () => {
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('A').ok, false);
  assert.equal(validateName('A'.repeat(21)).ok, false);
  assert.deepEqual(validateName('  Ahmad   Fauzi  '), { ok: true, name: 'Ahmad Fauzi' });
});

test('poin mengikuti urutan dan rank sepuluh ke atas mendapat 10', () => {
  assert.deepEqual([1, 2, 3, 9, 10, 20].map(getPointsByRank), [100, 90, 80, 20, 10, 10]);
});

test('bonus penggambar adalah lima per jawaban dengan batas 50', () => {
  assert.equal(getDrawerBonus(0), 0);
  assert.equal(getDrawerBonus(5), 25);
  assert.equal(getDrawerBonus(15), 50);
});

test('state machine hanya menerima transisi yang diizinkan', () => {
  assert.equal(canTransition('waiting', 'countdown'), true);
  assert.equal(canTransition('drawing', 'round_result'), true);
  assert.equal(canTransition('drawing', 'finished'), false);
  assert.equal(canTransition('finished', 'waiting'), true);
});

test('token diverifikasi terhadap hash tanpa menyimpan token asli', () => {
  const hash = hashToken('rahasia');
  assert.equal(safeTokenEquals('rahasia', hash), true);
  assert.equal(safeTokenEquals('salah', hash), false);
});

test('leaderboard stabil untuk skor seri', () => {
  const players = [
    { id: 'b', name: 'Budi', score: 100, joinedAt: '2026-01-01T00:00:02Z' },
    { id: 'a', name: 'Ahmad', score: 100, joinedAt: '2026-01-01T00:00:01Z' }
  ];
  assert.deepEqual(leaderboard(players).map((item) => item.name), ['Ahmad', 'Budi']);
});

test('stroke canvas menolak koordinat dan warna tidak valid', () => {
  assert.equal(sanitizeStroke('start', { x: 2, y: 0 }), null);
  assert.deepEqual(sanitizeStroke('start', { x: .2, y: .7, color: 'red', size: 99 }), {
    type: 'start', x: .2, y: .7, tool: 'brush', color: '#17152b', size: 40
  });
  assert.deepEqual(sanitizeStroke('end'), { type: 'end' });
});
