const crypto = require('node:crypto');

const ROOM_STATES = Object.freeze(['waiting', 'countdown', 'drawing', 'round_result', 'finished']);
const TRANSITIONS = Object.freeze({
  waiting: ['countdown'],
  countdown: ['drawing', 'round_result'],
  drawing: ['round_result'],
  round_result: ['waiting', 'finished'],
  finished: ['waiting']
});

function normalizeAnswer(value) {
  return String(value ?? '').trim().toLocaleLowerCase('id-ID').replace(/\s+/g, ' ');
}

function validateName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Nama wajib diisi.' };
  if (name.length < 2) return { ok: false, error: 'Nama minimal 2 karakter.' };
  if (name.length > 20) return { ok: false, error: 'Nama maksimal 20 karakter.' };
  return { ok: true, name };
}

function getPointsByRank(rank) {
  const points = [100, 90, 80, 70, 60, 50, 40, 30, 20];
  return points[rank - 1] || 10;
}

function getDrawerBonus(correctCount) {
  return Math.min(Math.max(Number(correctCount) || 0, 0) * 5, 50);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeTokenEquals(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function canTransition(from, to) {
  return ROOM_STATES.includes(from) && TRANSITIONS[from]?.includes(to);
}

function leaderboard(players) {
  return [...players]
    .sort((a, b) => b.score - a.score || a.joinedAt.localeCompare(b.joinedAt) || a.name.localeCompare(b.name))
    .map((player, index) => ({ rank: index + 1, id: player.id, name: player.name, score: player.score }));
}

function sanitizeStroke(type, payload = {}) {
  if (!['start', 'move', 'end'].includes(type)) return null;
  if (type === 'end') return { type };
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (type === 'move') return { type, x, y };
  const tool = payload.tool === 'eraser' ? 'eraser' : 'brush';
  const color = /^#[0-9a-f]{6}$/i.test(payload.color) ? payload.color : '#17152b';
  const size = Math.min(Math.max(Number(payload.size) || 5, 1), 40);
  return { type, x, y, tool, color, size };
}

module.exports = {
  ROOM_STATES,
  canTransition,
  getDrawerBonus,
  getPointsByRank,
  hashToken,
  leaderboard,
  normalizeAnswer,
  safeTokenEquals,
  sanitizeStroke,
  validateName
};
