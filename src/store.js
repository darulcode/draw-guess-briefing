const path = require('node:path');
const fs = require('fs-extra');

const EMPTY_DB = { users: [], sessions: [], rooms: [], players: [], rounds: [], answers: [] };

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(EMPTY_DB);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.ensureDir(path.dirname(this.filePath));
    if (!(await fs.pathExists(this.filePath))) await fs.writeJson(this.filePath, EMPTY_DB, { spaces: 2 });
    const loaded = await fs.readJson(this.filePath);
    this.data = { ...structuredClone(EMPTY_DB), ...loaded };
    for (const key of Object.keys(EMPTY_DB)) if (!Array.isArray(this.data[key])) this.data[key] = [];
    return this;
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2) + '\n';
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.move(temporary, this.filePath, { overwrite: true });
    });
    return this.writeQueue;
  }

  room(id) { return this.data.rooms.find((room) => room.id === id); }
  roomPlayers(id) { return this.data.players.filter((player) => player.roomId === id); }
  roomRounds(id) { return this.data.rounds.filter((round) => round.roomId === id); }
  currentRound(room) { return this.data.rounds.find((round) => round.roomId === room.id && round.roundNumber === room.currentRound); }
  roundAnswers(roomId, roundNumber) { return this.data.answers.filter((answer) => answer.roomId === roomId && answer.roundNumber === roundNumber); }
}

module.exports = { JsonStore };
