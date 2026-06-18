(function () {
  function burst(duration = 2200, amount = 130) {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const context = canvas.getContext('2d');
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    context.scale(devicePixelRatio, devicePixelRatio);
    const colors = ['#7557ff', '#3dd9eb', '#ffd84d', '#ff8a4c', '#31cc88', '#ff5e71'];
    const pieces = Array.from({ length: amount }, () => ({
      x: innerWidth * (.2 + Math.random() * .6), y: -20 - Math.random() * 150,
      vx: (Math.random() - .5) * 8, vy: 3 + Math.random() * 6,
      size: 5 + Math.random() * 9, spin: Math.random() * Math.PI, rotation: (Math.random() - .5) * .25,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));
    const start = performance.now();
    function frame(now) {
      context.clearRect(0, 0, innerWidth, innerHeight);
      for (const piece of pieces) {
        piece.x += piece.vx; piece.y += piece.vy; piece.vy += .05; piece.spin += piece.rotation;
        context.save(); context.translate(piece.x, piece.y); context.rotate(piece.spin); context.fillStyle = piece.color;
        context.fillRect(-piece.size / 2, -piece.size / 3, piece.size, piece.size * .65); context.restore();
      }
      if (now - start < duration) requestAnimationFrame(frame); else context.clearRect(0, 0, innerWidth, innerHeight);
    }
    requestAnimationFrame(frame);
  }
  window.Confetti = { burst };
})();
