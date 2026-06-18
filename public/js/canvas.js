(function () {
  class RealtimeCanvas {
    constructor(canvas, callbacks = {}) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.callbacks = callbacks;
      this.enabled = false;
      this.tool = 'brush';
      this.color = '#7557ff';
      this.size = 6;
      this.drawing = false;
      this.current = null;
      this.history = [];
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement);
      canvas.addEventListener('pointerdown', (event) => this.pointerStart(event));
      canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
      window.addEventListener('pointerup', () => this.pointerEnd());
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (this.canvas.width === width && this.canvas.height === height) return;
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.replay();
    }

    point(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1), y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1) };
    }

    pointerStart(event) {
      if (!this.enabled) return;
      event.preventDefault();
      this.canvas.setPointerCapture?.(event.pointerId);
      const point = this.point(event);
      const stroke = { type: 'start', ...point, tool: this.tool, color: this.color, size: this.size };
      this.drawing = true;
      this.apply(stroke);
      this.callbacks.start?.(stroke);
    }

    pointerMove(event) {
      if (!this.enabled || !this.drawing) return;
      event.preventDefault();
      const stroke = { type: 'move', ...this.point(event) };
      this.apply(stroke);
      this.callbacks.move?.(stroke);
    }

    pointerEnd() {
      if (!this.enabled || !this.drawing) return;
      this.drawing = false;
      const stroke = { type: 'end' };
      this.apply(stroke);
      this.callbacks.end?.(stroke);
    }

    apply(stroke, record = true) {
      if (!stroke) return;
      if (record) this.history.push(stroke);
      const rect = this.canvas.getBoundingClientRect();
      if (stroke.type === 'start') {
        this.current = { x: stroke.x * rect.width, y: stroke.y * rect.height, tool: stroke.tool, color: stroke.color, size: stroke.size };
        this.context.beginPath();
        this.context.arc(this.current.x, this.current.y, Math.max(1, stroke.size / 2), 0, Math.PI * 2);
        this.context.fillStyle = stroke.tool === 'eraser' ? '#fff' : stroke.color;
        this.context.fill();
      } else if (stroke.type === 'move' && this.current) {
        const next = { x: stroke.x * rect.width, y: stroke.y * rect.height };
        this.context.beginPath();
        this.context.moveTo(this.current.x, this.current.y);
        this.context.lineTo(next.x, next.y);
        this.context.lineCap = 'round';
        this.context.lineJoin = 'round';
        this.context.lineWidth = this.current.tool === 'eraser' ? this.current.size * 2 : this.current.size;
        this.context.strokeStyle = this.current.tool === 'eraser' ? '#fff' : this.current.color;
        this.context.stroke();
        this.current.x = next.x;
        this.current.y = next.y;
      } else if (stroke.type === 'end') {
        this.current = null;
      }
    }

    load(history = []) { this.history = [...history]; this.replay(); }
    replay() {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.current = null;
      for (const stroke of this.history) this.apply(stroke, false);
    }
    clear() { this.history = []; this.current = null; this.context.clearRect(0, 0, this.canvas.width, this.canvas.height); }
    setEnabled(value) { this.enabled = Boolean(value); this.canvas.parentElement.classList.toggle('locked', !this.enabled); }
  }

  window.RealtimeCanvas = RealtimeCanvas;
})();
