/* ============================================================
   NV BRAIN — the NeuroVault mark as an interactive neural net.
   Node positions sampled from the logo (nv-brain-points.js).
   On load the nodes assemble into the logo shape, then rest
   STATIC. On mouse-move, nearby nodes lean toward the cursor and
   branch-lines reach out to it; they ease back when the cursor
   leaves. Vanilla canvas, no deps, respects reduced-motion.
   Usage: NVBrain.init('#nv-brain');
   ============================================================ */
(function (root) {
  'use strict';

  function init(sel) {
    var cv = document.querySelector(sel);
    var PTS = root.NV_BRAIN_POINTS;
    if (!cv || !PTS || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var W, H, S, ox, oy, nodes = null, edges = [], pulses = [], start = performance.now();
    var mActive = false, mpx = 0, mpy = 0;

    function resize() {
      var r = cv.getBoundingClientRect();
      var dpr = Math.min(root.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      S = Math.min(W, H) * 0.88; ox = (W - S) / 2; oy = (H - S) / 2;
      if (nodes) for (var i = 0; i < nodes.length; i++) { nodes[i].bx = ox + PTS[i].x * S; nodes[i].by = oy + PTS[i].y * S; }
    }

    function build() {
      nodes = PTS.map(function (p) {
        var bx = ox + p.x * S, by = oy + p.y * S;
        var ang = Math.random() * 6.2832, rad = S * (0.45 + Math.random() * 0.55);
        return {
          bx: bx, by: by,
          x: reduce ? bx : W / 2 + Math.cos(ang) * rad,
          y: reduce ? by : H / 2 + Math.sin(ang) * rad,
          t: p.t
        };
      });
      edges = []; var K = 3, seen = {}, maxD2 = (S * 0.135) * (S * 0.135);
      for (var i = 0; i < nodes.length; i++) {
        var ds = [];
        for (var j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          var dx = nodes[i].bx - nodes[j].bx, dy = nodes[i].by - nodes[j].by;
          ds.push([dx * dx + dy * dy, j]);
        }
        ds.sort(function (a, b) { return a[0] - b[0]; });
        for (var k = 0; k < K && k < ds.length; k++) {
          if (ds[k][0] > maxD2) break;
          var j2 = ds[k][1], key = i < j2 ? i + '_' + j2 : j2 + '_' + i;
          if (!seen[key]) { seen[key] = 1; edges.push([i, j2]); }
        }
      }
    }

    function frame(now) {
      var t = (now - start) / 1000;
      var intro = Math.min(1, t / 1.5), e = 1 - Math.pow(1 - intro, 3);
      var settling = intro < 1;
      ctx.clearRect(0, 0, W, H);
      var i, n, R = Math.min(W, H) * 0.36;

      // node targets: base, plus a lean toward the cursor when near
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        var tx = n.bx, ty = n.by;
        if (mActive && !reduce) {
          var dx = mpx - n.bx, dy = mpy - n.by, d = Math.sqrt(dx * dx + dy * dy);
          if (d < R) { var pull = 0.45 * (1 - d / R); tx = n.bx + dx * pull; ty = n.by + dy * pull; }
        }
        var k = settling ? 0.07 : 0.16;
        n.x += (tx - n.x) * k; n.y += (ty - n.y) * k;
      }

      // static connections
      ctx.lineWidth = 0.7;
      for (i = 0; i < edges.length; i++) {
        var a = nodes[edges[i][0]], b = nodes[edges[i][1]];
        ctx.strokeStyle = 'rgba(90,160,255,' + (0.085 * e) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }

      // firing signals — quick bright "shots" darting across the web
      if (!reduce && !settling && edges.length && Math.random() < 0.5) {
        var ed = edges[(Math.random() * edges.length) | 0];
        pulses.push({ a: ed[0], b: ed[1], t: 0, sp: 0.024 + Math.random() * 0.02 });
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1.4;
      for (i = pulses.length - 1; i >= 0; i--) {
        var pu = pulses[i]; pu.t += pu.sp;
        if (pu.t >= 1) { pulses.splice(i, 1); continue; }
        var na = nodes[pu.a], nb = nodes[pu.b];
        var t1 = pu.t, t0 = Math.max(0, pu.t - 0.2);
        var gx1 = na.x + (nb.x - na.x) * t1, gy1 = na.y + (nb.y - na.y) * t1;
        var gx0 = na.x + (nb.x - na.x) * t0, gy0 = na.y + (nb.y - na.y) * t0;
        var glow = 1 - Math.abs(0.5 - pu.t) * 2;
        ctx.strokeStyle = 'rgba(150,205,255,' + (0.8 * glow) + ')';
        ctx.beginPath(); ctx.moveTo(gx0, gy0); ctx.lineTo(gx1, gy1); ctx.stroke();
        ctx.fillStyle = 'rgba(195,228,255,' + (0.95 * glow) + ')';
        ctx.beginPath(); ctx.arc(gx1, gy1, 1.7, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // branch lines reaching toward the cursor + a glow node at the mouse
      if (mActive && !reduce && !settling) {
        var near = [];
        for (i = 0; i < nodes.length; i++) {
          n = nodes[i];
          var ddx = mpx - n.x, ddy = mpy - n.y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dd < R) near.push([dd, i]);
        }
        near.sort(function (p, q) { return p[0] - q[0]; });
        var lim = Math.min(14, near.length);
        ctx.lineWidth = 0.9;
        for (i = 0; i < lim; i++) {
          n = nodes[near[i][1]];
          var op = (1 - near[i][0] / R) * 0.55;
          ctx.strokeStyle = 'rgba(130,190,255,' + op + ')';
          ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(mpx, mpy); ctx.stroke();
        }
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(150,200,255,0.9)';
        ctx.beginPath(); ctx.arc(mpx, mpy, 3.2, 0, 6.2832); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      // nodes
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        ctx.fillStyle = n.t === 'brain'
          ? 'rgba(60,135,250,' + (0.95 * e) + ')'
          : 'rgba(216,231,255,' + (0.9 * e) + ')';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.t === 'brain' ? 1.55 : 1.2, 0, 6.2832); ctx.fill();
      }

      requestAnimationFrame(frame);
    }

    resize(); build();
    if (!reduce) {
      root.addEventListener('mousemove', function (ev) {
        var r = cv.getBoundingClientRect();
        var x = ev.clientX - r.left, y = ev.clientY - r.top;
        var m = Math.min(r.width, r.height) * 0.36;
        mActive = x > -m && x < r.width + m && y > -m && y < r.height + m;
        mpx = x; mpy = y;
      });
    }
    root.addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }

  root.NVBrain = { init: init };
})(typeof window !== 'undefined' ? window : this);
