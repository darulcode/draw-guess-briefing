const { createGameServer } = require('./src/game-server');

createGameServer()
  .then(async (game) => {
    const address = await game.listen();
    console.log(`\nDraw & Guess siap di http://localhost:${address.port}`);
    console.log(`QR/jaringan lokal: ${game.baseUrl}\n`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
