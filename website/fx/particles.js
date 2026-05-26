/**
 * particles.js — Lightweight canvas-based particle system
 *
 * Usage:
 *   <canvas id="particles"></canvas>
 *   <script src="particles.js"></script>
 *   <script>
 *     // Basic floating particles
 *     Particles.create('#particles', {
 *       count: 80,
 *       color: '#6366f1',
 *       connect: true,       // draw lines between nearby particles
 *       connectDistance: 120,
 *       speed: 0.5,
 *       size: { min: 1, max: 3 },
 *       opacity: 0.6,
 *     });
 *
 *     // Interactive: particles react to mouse
 *     Particles.create('#particles', {
 *       count: 60,
 *       interactive: true,     // mouse repels particles
 *       interactRadius: 100,
 *     });
 *
 *     // Presets
 *     Particles.create('#particles', Particles.presets.starfield);
 *     Particles.create('#particles', Particles.presets.snow);
 *     Particles.create('#particles', Particles.presets.fireflies);
 *   </script>
 *
 * No dependencies. Respects prefers-reduced-motion (reduces count & speed).
 */

(function (global) {
  'use strict';

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * @param {string|HTMLCanvasElement} target - Canvas selector or element
   * @param {Object} [opts]
   * @returns {{ destroy: function, resize: function }}
   */
  function create(target, opts) {
    opts = opts || {};

    const canvas = typeof target === 'string'
      ? document.querySelector(target)
      : target;

    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      console.warn('Particles: target must be a <canvas> element');
      return { destroy: function () {}, resize: function () {} };
    }

    const ctx = canvas.getContext('2d');
    let width, height;
    let particles = [];
    let mouse = { x: -9999, y: -9999 };
    let destroyed = false;
    let rafId;

    // Options with defaults
    const count = prefersReducedMotion ? Math.min(opts.count || 80, 20) : (opts.count || 80);
    const color = opts.color || '#ffffff';
    const speed = prefersReducedMotion ? (opts.speed || 0.5) * 0.3 : (opts.speed || 0.5);
    const sizeMin = (opts.size && opts.size.min) || 1;
    const sizeMax = (opts.size && opts.size.max) || 3;
    const opacity = opts.opacity ?? 0.6;
    const connect = opts.connect !== false;
    const connectDistance = opts.connectDistance || 120;
    const connectOpacity = opts.connectOpacity || 0.15;
    const interactive = opts.interactive || false;
    const interactRadius = opts.interactRadius || 100;
    const drift = opts.drift || 0; // horizontal drift (-1 to 1)
    const gravity = opts.gravity || 0; // downward pull
    const fadeEdge = opts.fadeEdge || 0; // fade near canvas edges (px)
    const shape = opts.shape || 'circle'; // 'circle' | 'square' | 'star'

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
    }

    function init() {
      particles = [];
      for (let i = 0; i < count; i++) {
        particles.push(createParticle());
      }
    }

    function createParticle() {
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * speed * 2,
        vy: (Math.random() - 0.5) * speed * 2,
        size: sizeMin + Math.random() * (sizeMax - sizeMin),
        opacity: opacity * (0.5 + Math.random() * 0.5),
      };
    }

    function update() {
      for (const p of particles) {
        p.x += p.vx + drift * speed;
        p.y += p.vy + gravity;

        // Wrap around edges
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        if (p.y > height + 10) p.y = -10;

        // Mouse interaction
        if (interactive) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < interactRadius && dist > 0) {
            const force = (interactRadius - dist) / interactRadius;
            p.vx += (dx / dist) * force * 0.5;
            p.vy += (dy / dist) * force * 0.5;
          }
        }

        // Dampen velocity
        p.vx *= 0.99;
        p.vy *= 0.99;

        // Re-add base velocity if too slow
        const currentSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (currentSpeed < speed * 0.2) {
          p.vx += (Math.random() - 0.5) * speed * 0.5;
          p.vy += (Math.random() - 0.5) * speed * 0.5;
        }
      }
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);

      // Draw connections
      if (connect) {
        for (let i = 0; i < particles.length; i++) {
          for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < connectDistance) {
              const lineOpacity = connectOpacity * (1 - dist / connectDistance);
              ctx.beginPath();
              ctx.strokeStyle = hexToRgba(color, lineOpacity);
              ctx.lineWidth = 0.5;
              ctx.moveTo(particles[i].x, particles[i].y);
              ctx.lineTo(particles[j].x, particles[j].y);
              ctx.stroke();
            }
          }
        }
      }

      // Draw particles
      for (const p of particles) {
        let pOpacity = p.opacity;

        // Fade near edges
        if (fadeEdge > 0) {
          const edgeFade = Math.min(
            p.x / fadeEdge,
            (width - p.x) / fadeEdge,
            p.y / fadeEdge,
            (height - p.y) / fadeEdge,
            1
          );
          pOpacity *= Math.max(0, edgeFade);
        }

        ctx.fillStyle = hexToRgba(color, pOpacity);

        if (shape === 'square') {
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        } else if (shape === 'star') {
          drawStar(ctx, p.x, p.y, p.size);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function drawStar(ctx, cx, cy, r) {
      const spikes = 4;
      const outerRadius = r;
      const innerRadius = r * 0.4;
      let rot = Math.PI / 2 * 3;
      const step = Math.PI / spikes;

      ctx.beginPath();
      ctx.moveTo(cx, cy - outerRadius);
      for (let i = 0; i < spikes; i++) {
        ctx.lineTo(cx + Math.cos(rot) * outerRadius, cy + Math.sin(rot) * outerRadius);
        rot += step;
        ctx.lineTo(cx + Math.cos(rot) * innerRadius, cy + Math.sin(rot) * innerRadius);
        rot += step;
      }
      ctx.lineTo(cx, cy - outerRadius);
      ctx.closePath();
      ctx.fill();
    }

    function loop() {
      if (destroyed) return;
      update();
      draw();
      rafId = requestAnimationFrame(loop);
    }

    // Event listeners
    function onMouseMove(e) {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    }

    function onMouseLeave() {
      mouse.x = -9999;
      mouse.y = -9999;
    }

    function onResize() {
      resize();
    }

    // Setup
    resize();
    init();
    loop();

    if (interactive) {
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mouseleave', onMouseLeave);
    }
    window.addEventListener('resize', onResize);

    return {
      destroy: function () {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mouseleave', onMouseLeave);
        window.removeEventListener('resize', onResize);
      },
      resize: resize,
    };
  }

  /* ============================================================
     HELPERS
     ============================================================ */

  function hexToRgba(hex, alpha) {
    if (hex.startsWith('rgb')) {
      return hex.replace(')', ', ' + alpha + ')').replace('rgb', 'rgba');
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* ============================================================
     PRESETS
     ============================================================ */

  var presets = {
    network: {
      count: 80,
      color: '#6366f1',
      connect: true,
      connectDistance: 120,
      speed: 0.3,
      size: { min: 1, max: 2 },
      opacity: 0.6,
      interactive: true,
      interactRadius: 150,
    },
    starfield: {
      count: 150,
      color: '#ffffff',
      connect: false,
      speed: 0.2,
      size: { min: 0.5, max: 2 },
      opacity: 0.8,
      shape: 'star',
    },
    snow: {
      count: 100,
      color: '#ffffff',
      connect: false,
      speed: 0.3,
      size: { min: 1, max: 4 },
      opacity: 0.7,
      gravity: 0.3,
      drift: 0.2,
      fadeEdge: 50,
    },
    fireflies: {
      count: 30,
      color: '#fbbf24',
      connect: false,
      speed: 0.4,
      size: { min: 1, max: 3 },
      opacity: 0.8,
      fadeEdge: 30,
    },
    bubbles: {
      count: 40,
      color: '#60a5fa',
      connect: false,
      speed: 0.2,
      size: { min: 2, max: 6 },
      opacity: 0.3,
      gravity: -0.15,
    },
  };

  /* ============================================================
     EXPORTS
     ============================================================ */

  var Particles = {
    create: create,
    presets: presets,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Particles;
  } else {
    global.Particles = Particles;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
