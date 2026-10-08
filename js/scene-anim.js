/* ==========================================================================
   Living scene
   --------------------------------------------------------------------------
   Brings a scene's painting to life in the browser. The painting itself is
   drawn by the graphics card (WebGL) with gentle, region-by-region effects:

     - "sway":    trees and palms move in a breeze
     - "sky":     soft clouds drift and their shadows pass
     - "ground":  dappled sunlight flickers through the leaves
     - "shimmer": heat haze rises off sun-baked surfaces
     - "figures": the people at work. Each moving part (an arm, a head, a
                  whole body) is a soft band along a short path that turns
                  about a joint, or slides, in a working rhythm.

   On top, a second canvas draws small moving things:

     - "smoke":   wisps curling up from chimneys
     - "birds":   birds gliding across the sky
     - "motes":   dust drifting in the light

   Every region is a box [left, top, right, bottom] in fractions of the
   picture (0 to 1), set in data/stops.json under the scene's "animate".
   If the browser can't do WebGL, the still picture shows with only the
   smoke, birds and dust on top. With "reduce motion" turned on, nothing moves.
   ========================================================================== */
(function () {
  'use strict';

  const MAX_SWAY = 6;
  const MAX_SHIMMER = 3;
  const MAX_PARTS = 24; // moving body parts; fewer on graphics cards with little room

  const VERT = `
    attribute vec2 pos;
    varying vec2 uv;
    void main() {
      uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
      gl_Position = vec4(pos, 0.0, 1.0);
    }`;

  const frag = (maxParts) => `
    precision highp float;
    varying vec2 uv;
    uniform sampler2D img;
    uniform float t;
    uniform float aspect;
    uniform int nSway;
    uniform vec4 sway[${MAX_SWAY}];
    uniform float swayAmp[${MAX_SWAY}];
    uniform int nShimmer;
    uniform vec4 shimmer[${MAX_SHIMMER}];
    uniform vec4 sky;
    uniform vec4 ground;
    uniform int nParts;
    uniform vec4 partPath[${Math.max(1, maxParts)}];  // path points a, b
    uniform vec4 partJoint[${Math.max(1, maxParts)}]; // path point c, joint
    uniform vec4 partMove[${Math.max(1, maxParts)}];  // width, turn, slide x, slide y
    uniform vec4 partBeat[${Math.max(1, maxParts)}];  // speed, phase, style, rests

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    // Soft-edged box: 1 inside r (x0, y0, x1, y1), fading to 0 over f.
    float box(vec4 r, vec2 p, float f) {
      if (r.z <= r.x || r.w <= r.y) return 0.0;
      vec2 a = smoothstep(r.xy - f, r.xy + f, p);
      vec2 b = 1.0 - smoothstep(r.zw - f, r.zw + f, p);
      return a.x * a.y * b.x * b.y;
    }

    float segDist(vec2 q, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float h = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      return length(q - a - ab * h);
    }
    // How far into its movement a part is at time t.
    //   style 0 "sway":  an easy to-and-fro, -1 to 1
    //   style 1 "chop":  a slow lift (0 to 1) and a quick strike back to rest
    //   style 2 "work":  a steady reach and return, 0 to 1
    // With "rests", the person stops for a moment now and then.
    float beat(vec4 b) {
      float x = t * b.x + b.y;
      float m;
      if (b.z < 0.5) {
        m = 0.75 * sin(6.2832 * x) + 0.25 * sin(6.2832 * x * 1.618 + 1.3);
      } else if (b.z < 1.5) {
        float f = fract(x);
        m = f < 0.78 ? smoothstep(0.0, 0.78, f) : 1.0 - smoothstep(0.78, 0.9, f);
      } else {
        m = 0.5 - 0.5 * cos(6.2832 * x);
      }
      if (b.w > 0.5) m *= smoothstep(-0.35, 0.25, sin(t * 0.23 + b.y * 9.1));
      return m;
    }

    void main() {
      vec2 p = uv;
      vec2 off = vec2(0.0);

      // Breeze in the trees: tops move more than the bottom of each region.
      for (int i = 0; i < ${MAX_SWAY}; i++) {
        if (i >= nSway) break;
        vec4 r = sway[i];
        float m = box(r, p, 0.05);
        if (m <= 0.0) continue;
        float top = clamp(1.0 - (p.y - r.y) / max(r.w - r.y, 0.001), 0.0, 1.0);
        float gust = 0.6 + 0.4 * sin(t * 0.37 + float(i) * 1.7);
        float wave = 0.6 * sin(t * 1.25 + p.y * 14.0 + p.x * 5.0)
                   + 0.4 * sin(t * 2.3 + p.x * 31.0 + p.y * 7.0);
        off.x += m * (0.25 + 0.75 * top) * swayAmp[i] * gust * wave;
        off.y += m * top * swayAmp[i] * 0.35 * sin(t * 1.9 + p.x * 22.0);
      }

      // Heat haze over sun-baked surfaces.
      for (int i = 0; i < ${MAX_SHIMMER}; i++) {
        if (i >= nShimmer) break;
        float m = box(shimmer[i], p, 0.04);
        off.x += m * 0.0011 * sin(p.y * 170.0 - t * 6.0) * noise(vec2(p.x * 40.0, t));
        off.y += m * 0.0008 * sin(p.x * 90.0 + t * 4.0);
      }

      // The people at work: each part turns about its joint or slides. The
      // picture is looked up "backwards", so a pixel shows what the part
      // would have left there after moving.
      vec2 q = vec2(p.x * aspect, p.y);
      vec2 fo = vec2(0.0);
      for (int i = 0; i < ${Math.max(1, maxParts)}; i++) {
        if (i >= nParts) break;
        vec4 ab = partPath[i];
        vec4 cj = partJoint[i];
        vec4 mv = partMove[i];
        float d = min(segDist(q, ab.xy, ab.zw), segDist(q, ab.zw, cj.xy));
        if (d >= mv.x) continue;
        float w = 1.0 - smoothstep(mv.x * 0.3, mv.x, d);
        float m = beat(partBeat[i]) * w;
        float a = -mv.y * m;
        vec2 r = q - cj.zw;
        vec2 src = cj.zw + vec2(r.x * cos(a) - r.y * sin(a), r.x * sin(a) + r.y * cos(a)) - mv.zw * m;
        fo += src - q;
      }
      off += vec2(fo.x / aspect, fo.y);

      vec3 c = texture2D(img, clamp(p + off, 0.001, 0.999)).rgb;

      // Clouds drifting across the sky, and their passing shadows.
      float sm = box(sky, p, 0.07);
      if (sm > 0.0) {
        vec2 q = vec2(p.x * aspect * 2.4 - t * 0.012, p.y * 5.0 + t * 0.002);
        c = mix(c, vec3(1.0, 0.985, 0.95), sm * smoothstep(0.55, 0.86, fbm(q)) * 0.24);
        c *= 1.0 - sm * smoothstep(0.38, 0.62, fbm(q * 1.4 + 7.3)) * 0.07;
      }

      // Dappled sunlight on the ground under the trees.
      float gm = box(ground, p, 0.07);
      if (gm > 0.0) {
        float d = fbm(vec2(p.x * aspect * 9.0 + t * 0.05, p.y * 9.0 - t * 0.03));
        c *= 1.0 + gm * (d - 0.5) * 0.14;
      }

      // The light itself breathes very slightly.
      c *= 1.0 + 0.012 * sin(t * 0.45);
      gl_FragColor = vec4(c, 1.0);
    }`;

  const rect = (r) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? r.map(Number) : null);
  const point = (p) => (Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) ? [+p[0], +p[1]] : null);

  let run = null;

  function start(stage, img, config) {
    stop();
    if (!stage || !img || !config) return false;
    const cfg = normalise(config);
    const glCanvas = document.createElement('canvas');
    const fxCanvas = document.createElement('canvas');
    glCanvas.className = 'scene-gl';
    fxCanvas.className = 'scene-fx';
    glCanvas.setAttribute('aria-hidden', 'true');
    fxCanvas.setAttribute('aria-hidden', 'true');
    stage.append(glCanvas, fxCanvas);

    const gl = setupGL(glCanvas, img, cfg);
    if (gl) stage.classList.add('is-living');
    else glCanvas.remove();

    run = {
      stage, img, cfg, gl, glCanvas, fxCanvas,
      fx: fxCanvas.getContext('2d'),
      t0: performance.now(),
      last: performance.now(),
      raf: 0,
      smoke: [],
      birds: cfg.birds.map((b, i) => newBird(b, i, true)),
      motes: []
    };
    resize();
    loop();
    return true;
  }

  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    run.stage.classList.remove('is-living');
    if (run.gl) {
      const ext = run.gl.ctx.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    run.glCanvas.remove();
    run.fxCanvas.remove();
    run = null;
  }

  function normalise(config) {
    const cfg = {
      sway: [], shimmer: [],
      sky: rect(config.sky) || [0, 0, 0, 0],
      ground: rect(config.ground) || [0, 0, 0, 0],
      smoke: [], birds: [], motes: null, parts: []
    };
    for (const s of Array.isArray(config.sway) ? config.sway : []) {
      const r = rect(s && s.box);
      if (r && cfg.sway.length < MAX_SWAY) cfg.sway.push({ box: r, amount: Number.isFinite(s.amount) ? s.amount : 1 });
    }
    for (const s of Array.isArray(config.shimmer) ? config.shimmer : []) {
      const r = rect(s);
      if (r && cfg.shimmer.length < MAX_SHIMMER) cfg.shimmer.push(r);
    }
    for (const s of Array.isArray(config.smoke) ? config.smoke : []) {
      const at = point(s);
      if (at) cfg.smoke.push(at);
    }
    for (const f of Array.isArray(config.figures) ? config.figures : []) {
      for (const pt of Array.isArray(f && f.parts) ? f.parts : []) {
        const path = (Array.isArray(pt && pt.path) ? pt.path : []).map(point).filter(Boolean).slice(0, 3);
        const joint = point(pt && pt.joint) || path[0];
        if (path.length < 2 || !joint || cfg.parts.length >= MAX_PARTS) continue;
        while (path.length < 3) path.push(path[path.length - 1]);
        const num = (v, d) => (Number.isFinite(v) ? v : d);
        const slide = point(pt.slide) || [0, 0];
        cfg.parts.push({
          path, joint, slide,
          width: Math.max(0.005, num(pt.width, 0.04)),
          turn: num(pt.turn, 0) * Math.PI / 180,
          speed: Math.max(0, num(pt.speed, num(f.speed, 0.3))),
          phase: num(pt.phase, num(f.phase, 0)),
          style: { sway: 0, chop: 1, work: 2 }[pt.style || f.style] ?? 0,
          rests: (pt.rests ?? f.rests) ? 1 : 0
        });
      }
    }
    const birds = config.birds || {};
    const band = rect(birds.band) || [0, 0.05, 1, 0.3];
    const count = Math.max(0, Math.min(8, Math.round(birds.count || 0)));
    for (let i = 0; i < count; i++) cfg.birds.push({ band });
    const motes = config.motes || {};
    if (rect(motes.box)) cfg.motes = { box: rect(motes.box), count: Math.max(0, Math.min(80, Math.round(motes.count || 30))) };
    return cfg;
  }

  function setupGL(canvas, img, cfg) {
    let ctx = null;
    try {
      ctx = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false }) ||
        canvas.getContext('experimental-webgl');
    } catch (e) { ctx = null; }
    if (!ctx) return null;
    const compile = (type, src) => {
      const sh = ctx.createShader(type);
      ctx.shaderSource(sh, src);
      ctx.compileShader(sh);
      if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
        console.warn('Living scene: shader did not compile.', ctx.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    // Each moving part needs 4 slots for its settings; leave room for the rest.
    const room = Math.floor(((ctx.getParameter(ctx.MAX_FRAGMENT_UNIFORM_VECTORS) || 16) - 28) / 4);
    const maxParts = Math.max(0, Math.min(MAX_PARTS, room, cfg.parts.length));
    const highp = ctx.getShaderPrecisionFormat &&
      ctx.getShaderPrecisionFormat(ctx.FRAGMENT_SHADER, ctx.HIGH_FLOAT);
    const src = frag(maxParts);
    const vs = compile(ctx.VERTEX_SHADER, VERT);
    const fs = compile(ctx.FRAGMENT_SHADER, highp && highp.precision > 0 ? src : src.replace('precision highp', 'precision mediump'));
    if (!vs || !fs) return null;
    const prog = ctx.createProgram();
    ctx.attachShader(prog, vs);
    ctx.attachShader(prog, fs);
    ctx.linkProgram(prog);
    if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
      console.warn('Living scene: shader did not link.', ctx.getProgramInfoLog(prog));
      return null;
    }
    ctx.useProgram(prog);

    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), ctx.STATIC_DRAW);
    const loc = ctx.getAttribLocation(prog, 'pos');
    ctx.enableVertexAttribArray(loc);
    ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);

    const tex = ctx.createTexture();
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
    try {
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, ctx.RGB, ctx.UNSIGNED_BYTE, img);
    } catch (e) {
      console.warn('Living scene: the picture could not be used for animation.', e);
      return null;
    }

    const u = (name) => ctx.getUniformLocation(prog, name);
    const uni = {
      t: u('t'), aspect: u('aspect'), nSway: u('nSway'), sway: u('sway'), swayAmp: u('swayAmp'),
      nShimmer: u('nShimmer'), shimmer: u('shimmer'), sky: u('sky'), ground: u('ground')
    };
    const aspect = (img.naturalWidth || 16) / (img.naturalHeight || 9);
    const parts = cfg.parts.slice(0, maxParts);
    const pp = new Float32Array(Math.max(1, maxParts) * 4);
    const pj = new Float32Array(Math.max(1, maxParts) * 4);
    const pm = new Float32Array(Math.max(1, maxParts) * 4);
    const pb = new Float32Array(Math.max(1, maxParts) * 4);
    parts.forEach((pt, i) => {
      // Across is stretched by the picture's shape so turns stay round.
      const [a, b, c] = pt.path;
      // A part may move only about a third of its width; any more and its soft
      // edge folds over and smears the picture, so bigger moves are scaled down.
      const reach = Math.max(...[a, b, c].map((q) => Math.hypot((q[0] - pt.joint[0]) * aspect, q[1] - pt.joint[1]))) + pt.width;
      const moves = Math.abs(pt.turn) * reach + Math.hypot(pt.slide[0] * aspect, pt.slide[1]);
      const k = moves > 0.35 * pt.width ? (0.35 * pt.width) / moves : 1;
      pp.set([a[0] * aspect, a[1], b[0] * aspect, b[1]], i * 4);
      pj.set([c[0] * aspect, c[1], pt.joint[0] * aspect, pt.joint[1]], i * 4);
      pm.set([pt.width, pt.turn * k, pt.slide[0] * aspect * k, pt.slide[1] * k], i * 4);
      pb.set([pt.speed, pt.phase, pt.style, pt.rests], i * 4);
    });
    ctx.uniform1i(u('nParts'), parts.length);
    ctx.uniform4fv(u('partPath'), pp);
    ctx.uniform4fv(u('partJoint'), pj);
    ctx.uniform4fv(u('partMove'), pm);
    ctx.uniform4fv(u('partBeat'), pb);
    const swayRects = new Float32Array(MAX_SWAY * 4);
    const swayAmps = new Float32Array(MAX_SWAY);
    cfg.sway.forEach((s, i) => { swayRects.set(s.box, i * 4); swayAmps[i] = 0.0032 * s.amount; });
    const shimRects = new Float32Array(MAX_SHIMMER * 4);
    cfg.shimmer.forEach((r, i) => shimRects.set(r, i * 4));
    ctx.uniform1i(u('img'), 0);
    ctx.uniform1i(uni.nSway, cfg.sway.length);
    ctx.uniform4fv(uni.sway, swayRects);
    ctx.uniform1fv(uni.swayAmp, swayAmps);
    ctx.uniform1i(uni.nShimmer, cfg.shimmer.length);
    ctx.uniform4fv(uni.shimmer, shimRects);
    ctx.uniform4fv(uni.sky, new Float32Array(cfg.sky));
    ctx.uniform4fv(uni.ground, new Float32Array(cfg.ground));
    ctx.uniform1f(uni.aspect, aspect);
    return { ctx, uni };
  }

  // Matches the canvases to the picture's size on screen.
  function resize() {
    if (!run) return;
    const r = run.stage.getBoundingClientRect();
    // The stage is scaled by the slow drift; use its layout size, not the scaled size.
    const w = run.stage.offsetWidth || r.width;
    const h = run.stage.offsetHeight || r.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    for (const c of [run.glCanvas, run.fxCanvas]) {
      c.width = Math.max(2, Math.round(w * dpr));
      c.height = Math.max(2, Math.round(h * dpr));
    }
    run.w = w;
    run.h = h;
    run.dpr = dpr;
    if (run.gl) run.gl.ctx.viewport(0, 0, run.glCanvas.width, run.glCanvas.height);
  }

  function loop() {
    if (!run) return;
    run.raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - run.last) / 1000);
    run.last = now;
    const t = (now - run.t0) / 1000;
    if (run.gl) {
      const { ctx, uni } = run.gl;
      ctx.uniform1f(uni.t, t);
      ctx.drawArrays(ctx.TRIANGLES, 0, 6);
    }
    drawEffects(t, dt);
  }

  /* ------------------------------------------------------------------------
     Smoke, birds and dust (2D canvas on top of the painting)
     ------------------------------------------------------------------------ */

  function newBird(b, i, initial) {
    const [x0, y0, x1, y1] = b.band;
    return {
      band: b.band,
      x: initial ? x0 + Math.random() * (x1 - x0) : x0 - 0.05,
      y: y0 + Math.random() * (y1 - y0),
      speed: 0.012 + Math.random() * 0.01,      // fraction of the width per second
      size: 0.009 + Math.random() * 0.006,      // fraction of the width
      phase: Math.random() * 10,
      bob: Math.random() * 6,
      delay: initial ? 0 : 2 + Math.random() * 10
    };
  }

  function drawEffects(t, dt) {
    const { fx, w, h, dpr, cfg } = run;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.clearRect(0, 0, w, h);

    // Smoke: soft puffs that rise, drift with the breeze, grow and fade.
    for (const at of cfg.smoke) {
      if (Math.random() < dt * 5) {
        run.smoke.push({ x: at[0], y: at[1], age: 0, life: 6 + Math.random() * 3, r: 0.006, dx: 0.004 + Math.random() * 0.004 });
      }
    }
    run.smoke = run.smoke.filter((p) => p.age < p.life);
    for (const p of run.smoke) {
      p.age += dt;
      const k = p.age / p.life;
      p.y -= dt * 0.012 * (1 - k * 0.5);
      p.x += dt * (p.dx + 0.006 * Math.sin(t * 0.8 + p.age));
      const radius = (p.r + k * 0.03) * w;
      const alpha = 0.16 * Math.sin(Math.PI * Math.min(1, k * 1.2)) * (1 - k);
      const g = fx.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, radius);
      g.addColorStop(0, `rgba(236, 230, 218, ${alpha})`);
      g.addColorStop(1, 'rgba(236, 230, 218, 0)');
      fx.fillStyle = g;
      fx.fillRect(p.x * w - radius, p.y * h - radius, radius * 2, radius * 2);
    }

    // Birds: mostly gliding, with the odd few wingbeats.
    fx.lineCap = 'round';
    fx.lineJoin = 'round';
    run.birds.forEach((b, i) => {
      if (b.delay > 0) { b.delay -= dt; return; }
      b.x += b.speed * dt;
      if (b.x > b.band[2] + 0.06) { run.birds[i] = newBird(b, i, false); return; }
      const flapping = Math.sin(t * 0.5 + b.phase) > 0.55;
      const lift = flapping ? Math.sin(t * 9 + b.phase) : 0.25 + 0.05 * Math.sin(t * 1.3 + b.phase);
      const y = b.y + 0.004 * Math.sin(t * 0.7 + b.bob);
      const s = b.size * w;
      const cx = b.x * w;
      const cy = y * h;
      fx.strokeStyle = 'rgba(38, 30, 26, 0.72)';
      fx.lineWidth = Math.max(1, s * 0.13);
      fx.beginPath();
      fx.moveTo(cx - s, cy - s * 0.35 * lift);
      fx.quadraticCurveTo(cx - s * 0.45, cy - s * 0.45 * lift - s * 0.1, cx, cy);
      fx.quadraticCurveTo(cx + s * 0.45, cy - s * 0.45 * lift - s * 0.1, cx + s, cy - s * 0.35 * lift);
      fx.stroke();
    });

    // Dust drifting and twinkling in the sunlight.
    if (cfg.motes) {
      const [x0, y0, x1, y1] = cfg.motes.box;
      while (run.motes.length < cfg.motes.count) {
        run.motes.push({ x: x0 + Math.random() * (x1 - x0), y: y0 + Math.random() * (y1 - y0), ph: Math.random() * 10, sp: 0.2 + Math.random() * 0.5 });
      }
      for (const m of run.motes) {
        m.x += dt * 0.004 * Math.sin(t * 0.3 * m.sp + m.ph);
        m.y -= dt * 0.002 * m.sp;
        if (m.y < y0) { m.y = y1; m.x = x0 + Math.random() * (x1 - x0); }
        const a = 0.35 + 0.35 * Math.sin(t * 2 * m.sp + m.ph);
        fx.fillStyle = `rgba(255, 246, 214, ${a.toFixed(3)})`;
        fx.beginPath();
        fx.arc(m.x * w, m.y * h, Math.max(0.6, w * 0.0011), 0, Math.PI * 2);
        fx.fill();
      }
    }
  }

  window.CacaoScene = { start, stop, resize };
})();
