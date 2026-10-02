/* ==========================================================================
   Detail layer
   --------------------------------------------------------------------------
   While the camera is moving, the page shows the simple base map. When the
   camera comes to rest, this file redraws the visible area on a canvas with
   much more detail and fades it in:

     - sharp coastlines (Natural Earth 10m land)
     - rivers (data/rivers.json)
     - terrain: real elevation turned into hill shading, plus lighter
       shallow water around the coasts (Terrain Tiles on AWS, loaded live)
     - antique-style water lines along the coasts
     - place labels (data/labels.json, plus river names)

   If anything here fails to load (for example, no internet for the terrain
   tiles), the map simply keeps working without that part.
   ========================================================================== */
(function () {
  'use strict';

  const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const MAX_TILE_ZOOM = 12;   // finest terrain tiles to use
  const MAX_TILES = 36;       // most tiles fetched for one view
  const TILE_CACHE_MAX = 90;  // tiles kept in memory
  const TILE_TIMEOUT_MS = 9000;
  const LAND10_ZOOM = 4.2;    // use the sharper 10m coastline from this map zoom level up

  const COLORS = {
    sea: '#a4b7b7',
    land: '#ead8ae',
    coast: '#8b6b3e',
    border: 'rgba(139, 107, 62, 0.5)',
    river: 'rgba(60, 100, 116, 0.92)',
    grid: 'rgba(80, 60, 30, 0.16)'
  };

  const LABEL_FONT = { ocean: 24, sea: 18, island: 15, region: 15, mountain: 14, river: 13, place: 14 };
  const LABEL_PRIORITY = { ocean: 1, sea: 2, island: 3, region: 3, mountain: 4, place: 5, river: 6 };

  let host = null;
  let ctx = null;
  let timer = null;
  let token = 0;
  let scratch = null;
  let labelItems = [];
  const tileCache = new Map();

  const data = { land50: [], land10: null, borders: null, rivers: [], riverLabels: [] };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ------------------------------------------------------------------------
     Setup and loading
     ------------------------------------------------------------------------ */

  function init(options) {
    host = options;
    ctx = host.canvas.getContext('2d');
    data.land50 = splitPolygons(host.land50);
    data.borders = host.borders50;
    if (host.tileUrl == null) host.tileUrl = TILE_URL;
    loadExtras();
  }

  async function loadExtras() {
    const tasks = [
      fetchJSON(host.land10Url).then((topo) => {
        const land = topojson.feature(topo, topo.objects.land);
        data.land10 = splitPolygons(land);
      }),
      fetchJSON(host.riversUrl).then((json) => {
        data.rivers = (json.features || []).filter((f) => f && f.geometry);
        data.riverLabels = riverLabelCandidates(data.rivers);
      }),
      fetchJSON(host.labelsUrl).then((json) => {
        labelItems = (json.labels || [])
          .filter((l) => l && l.name && Array.isArray(l.coordinates) && l.coordinates.length >= 2)
          .map((l) => ({
            kind: 'custom',
            name: String(l.name),
            type: LABEL_FONT[l.type] ? l.type : 'place',
            ll: [+l.coordinates[0], +l.coordinates[1]],
            minZoom: Number.isFinite(l.minZoom) ? l.minZoom : 0,
            maxZoom: Number.isFinite(l.maxZoom) ? l.maxZoom : Infinity,
            angle: Number.isFinite(l.rotate) ? l.rotate : 0
          }));
      })
    ];
    // Each part is optional: a failure just means that part isn't drawn.
    const results = await Promise.allSettled(tasks);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`Detail layer: part ${i + 1} did not load.`, r.reason);
    });
    schedule(0);
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  // Splits a land feature into one entry per polygon, each with its bounding
  // box, so polygons far off screen can be skipped when redrawing.
  function splitPolygons(feature) {
    const out = [];
    const geoms = feature.type === 'FeatureCollection'
      ? feature.features.map((f) => f.geometry)
      : [feature.type === 'Feature' ? feature.geometry : feature];
    for (const geom of geoms) {
      if (!geom) continue;
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const coordinates of polys) {
        const g = { type: 'Polygon', coordinates };
        // The 10m data has a degenerate sliver that d3 reads as "the whole globe";
        // no real land mass is bigger than a hemisphere, so skip anything that is.
        if (d3.geoArea(g) > 2 * Math.PI) continue;
        out.push({ g, b: d3.geoBounds(g) });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------------
     Scheduling: hide while moving, redraw when still
     ------------------------------------------------------------------------ */

  function hide() {
    token++;
    clearTimeout(timer);
    if (!host) return;
    host.canvas.classList.remove('is-ready');
    host.labelsLayer.classList.remove('is-ready');
  }

  function schedule(delay) {
    if (!host) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      render().catch((err) => console.warn('Detail layer: could not draw this view.', err));
    }, delay == null ? 140 : delay);
  }

  /* ------------------------------------------------------------------------
     View helpers
     ------------------------------------------------------------------------ */

  // A projection that maps longitude/latitude straight to screen pixels for
  // the current camera position (the base map projection plus the zoom).
  function viewProjection(clip) {
    const s = host.state;
    const base = s.projection;
    const t = s.transform;
    const tr = base.translate();
    const p = d3.geoNaturalEarth1()
      .scale(base.scale() * t.k)
      .translate([t.x + t.k * tr[0], t.y + t.k * tr[1]]);
    if (clip) p.clipExtent([[-30, -30], [s.width + 30, s.height + 30]]);
    return p;
  }

  // Map zoom level in the same units as web map tiles (z = 0 is the whole world in 256px).
  const zoomLevel = (proj) => Math.log2((2 * Math.PI * proj.scale() * 0.8707) / 256);

  function viewBounds(proj, W, H) {
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity, ok = 0;
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 14; i++) {
        const ll = proj.invert([(i * W) / 14, (j * H) / 8]);
        if (!ll || !isFinite(ll[0]) || !isFinite(ll[1]) || Math.abs(ll[0]) > 180.01 || Math.abs(ll[1]) > 90.01) continue;
        ok++;
        w = Math.min(w, ll[0]); e = Math.max(e, ll[0]);
        s = Math.min(s, ll[1]); n = Math.max(n, ll[1]);
      }
    }
    if (ok < 4) return [-180, -90, 180, 90];
    const padX = (e - w) * 0.05 + 0.05;
    const padY = (n - s) * 0.05 + 0.05;
    return [Math.max(-180, w - padX), Math.max(-90, s - padY), Math.min(180, e + padX), Math.min(90, n + padY)];
  }

  function visiblePolygons(polys, b) {
    const out = [];
    for (const p of polys) {
      const [[pw, ps], [pe, pn]] = p.b;
      if (pw > pe || (pe >= b[0] && pw <= b[2] && pn >= b[1] && ps <= b[3])) out.push(p.g);
    }
    return out;
  }

  function path2D(geoPath, geometry) {
    const d = geoPath(geometry);
    return d ? new Path2D(d) : new Path2D();
  }

  // Metres on the ground for one screen pixel at the middle of the view.
  function metresPerPixel(proj, W, H) {
    const a = proj.invert([W / 2, H / 2]);
    const b = proj.invert([W / 2 + 1, H / 2]);
    if (!a || !b || !isFinite(a[0]) || !isFinite(b[0])) return 500;
    return Math.max(1, d3.geoDistance(a, b) * 6371000);
  }

  /* ------------------------------------------------------------------------
     Terrain tiles
     ------------------------------------------------------------------------ */

  function decodeTile(img) {
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = scratch.height = 256;
    }
    const c = scratch.getContext('2d', { willReadFrequently: true });
    c.clearRect(0, 0, 256, 256);
    c.drawImage(img, 0, 0, 256, 256);
    const px = c.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    }
    return out;
  }

  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let promise = tileCache.get(key);
    if (promise) {
      tileCache.delete(key); // move to the end so it is kept longest
      tileCache.set(key, promise);
      return promise;
    }
    promise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try { resolve(decodeTile(img)); } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = host.tileUrl(z, x, y);
    });
    tileCache.set(key, promise);
    while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    return promise;
  }

  const MERC_LAT = 85.0511;
  const tileY = (lat, n) => (0.5 - Math.atanh(Math.sin((clamp(lat, -MERC_LAT, MERC_LAT) * Math.PI) / 180)) / (2 * Math.PI)) * n;
  const tileX = (lon, n) => ((lon + 180) / 360) * n;

  function chooseTiles(bounds, z) {
    for (; z >= 0; z--) {
      const n = 2 ** z;
      const x0 = clamp(Math.floor(tileX(bounds[0], n)), 0, n - 1);
      const x1 = clamp(Math.floor(tileX(bounds[2], n)), 0, n - 1);
      const y0 = clamp(Math.floor(tileY(bounds[3], n)), 0, n - 1);
      const y1 = clamp(Math.floor(tileY(bounds[1], n)), 0, n - 1);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) {
        const list = [];
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) list.push({ z, x, y });
        return { z, n, list };
      }
    }
    return { z: 0, n: 1, list: [{ z: 0, x: 0, y: 0 }] };
  }

  async function loadElevation(bounds, wantZoom) {
    const z = clamp(Math.round(wantZoom), 0, MAX_TILE_ZOOM);
    const { z: tz, n, list } = chooseTiles(bounds, z);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TILE_TIMEOUT_MS));
    const arrays = await Promise.race([Promise.all(list.map((t) => loadTile(t.z, t.x, t.y))), timeout]);
    const grid = new Map();
    if (arrays) list.forEach((t, i) => { if (arrays[i]) grid.set(t.y * n + t.x, arrays[i]); });
    return { z: tz, n, grid };
  }

  // Elevation in metres at a longitude/latitude (bilinear), or NaN if unknown.
  function sampleElevation(src, lon, lat) {
    const size = 256 * src.n;
    const gx = ((lon + 180) / 360) * size - 0.5;
    const gy = tileY(lat, src.n) * 256 - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const a = pixel(src, x0, y0, size), b = pixel(src, x0 + 1, y0, size);
    const c = pixel(src, x0, y0 + 1, size), d = pixel(src, x0 + 1, y0 + 1, size);
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    return top + (bottom - top) * fy;
  }

  function pixel(src, x, y, size) {
    x = clamp(x, 0, size - 1);
    y = clamp(y, 0, size - 1);
    const tile = src.grid.get((y >> 8) * src.n + (x >> 8));
    return tile ? tile[(y & 255) * 256 + (x & 255)] : NaN;
  }

  /* ------------------------------------------------------------------------
     Relief: hill shading for land, shallow/deep tint for the sea
     ------------------------------------------------------------------------ */

  function buildRelief(proj, W, H, step, src, mpp) {
    const w = Math.ceil(W / step);
    const h = Math.ceil(H / step);
    const elev = new Float32Array(w * h).fill(NaN);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const ll = proj.invert([i * step, j * step]);
        if (!ll || !isFinite(ll[0]) || !isFinite(ll[1]) || Math.abs(ll[0]) > 180 || Math.abs(ll[1]) > 90) continue;
        elev[j * w + i] = sampleElevation(src, ll[0], ll[1]);
      }
    }

    const cell = step * mpp;                                 // metres per relief pixel
    const exaggeration = clamp(Math.sqrt(cell / 150), 1.7, 14);
    const land = new ImageData(w, h);
    const sea = new ImageData(w, h);
    const L = land.data;
    const S = sea.data;
    const cz = Math.cos(Math.PI / 4);
    const sz = Math.sin(Math.PI / 4);
    const light = (3 * Math.PI) / 4;                         // light from the north-west
    const up = (i, j) => { const v = elev[j * w + i]; return v > 0 ? v : 0; };

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = j * w + i;
        const e = elev[idx];
        if (e !== e) continue;
        const o = idx * 4;

        if (e < 0) {
          const depth = -e;
          const shallow = Math.pow(clamp(1 - depth / 220, 0, 1), 1.25) * 0.4;
          const deep = clamp((depth - 1500) / 3200, 0, 1) * 0.2;
          if (shallow >= deep) { S[o] = 234; S[o + 1] = 243; S[o + 2] = 238; S[o + 3] = shallow * 255; }
          else { S[o] = 52; S[o + 1] = 78; S[o + 2] = 90; S[o + 3] = deep * 255; }
        }

        if (i === 0 || j === 0 || i === w - 1 || j === h - 1) continue;
        const a = up(i - 1, j - 1), b = up(i, j - 1), c = up(i + 1, j - 1);
        const d = up(i - 1, j), f = up(i + 1, j);
        const g = up(i - 1, j + 1), hh = up(i, j + 1), ii = up(i + 1, j + 1);
        const sum = a + b + c + d + f + g + hh + ii;
        if (sum !== sum) continue;
        const dx = (((c + 2 * f + ii) - (a + 2 * d + g)) / (8 * cell)) * exaggeration;
        const dy = (((a + 2 * b + c) - (g + 2 * hh + ii)) / (8 * cell)) * exaggeration; // north is positive
        const slope = Math.atan(Math.hypot(dx, dy));
        const aspect = Math.atan2(-dy, -dx);
        const shade = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(light - aspect);
        const flat = cz;
        if (shade < flat) {
          L[o] = 84; L[o + 1] = 52; L[o + 2] = 26; L[o + 3] = clamp((flat - shade) * 1.55, 0, 0.58) * 255;
        } else {
          L[o] = 255; L[o + 1] = 250; L[o + 2] = 232; L[o + 3] = clamp((shade - flat) * 1.2, 0, 0.36) * 255;
        }
        // A little extra brown on high ground.
        if (e > 400) {
          const hi = clamp((e - 400) / 2600, 0, 1) * 0.16;
          if (L[o + 3] < hi * 255 && shade < flat + 0.05) { L[o] = 120; L[o + 1] = 84; L[o + 2] = 46; L[o + 3] = hi * 255; }
        }
      }
    }
    return { land: toCanvas(land), sea: toCanvas(sea), w, h, step };
  }

  function toCanvas(imageData) {
    const c = document.createElement('canvas');
    c.width = imageData.width;
    c.height = imageData.height;
    c.getContext('2d').putImageData(imageData, 0, 0);
    return c;
  }

  /* ------------------------------------------------------------------------
     Drawing
     ------------------------------------------------------------------------ */

  async function render() {
    const my = ++token;
    const t0 = performance.now();
    const s = host.state;
    if (!s.projection || !s.width) return;
    const W = s.width;
    const H = s.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const proj = viewProjection(false);
    const clipProj = viewProjection(true);
    const z = zoomLevel(proj);
    const bounds = viewBounds(proj, W, H);
    const step = W * H > 1.2e6 ? 3 : 2;

    // Terrain first (it needs the network), then draw everything in one go.
    let relief = null;
    let t1 = performance.now();
    try {
      const src = await loadElevation(bounds, z - Math.log2(step) + 0.3);
      if (my !== token) return;
      t1 = performance.now();
      if (src.grid.size) relief = buildRelief(proj, W, H, step, src, metresPerPixel(proj, W, H));
    } catch (err) {
      console.warn('Detail layer: terrain not drawn.', err);
    }
    if (my !== token) return;
    const t2 = performance.now();

    const canvas = host.canvas;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap({ proj, clipProj, z, bounds, relief, W, H });

    canvas.classList.add('is-ready');
    placeLabels(proj, z, W, H);
    host.labelsLayer.classList.add('is-ready');
    const t3 = performance.now();
    // Handy when tuning: how long each part of the last redraw took (milliseconds).
    window.CacaoDetail.lastRender = {
      tiles: Math.round(t1 - t0), relief: Math.round(t2 - t1), draw: Math.round(t3 - t2), mapZoom: +z.toFixed(2)
    };
  }

  function drawMap({ proj, clipProj, z, bounds, relief, W, H }) {
    const geoPath = d3.geoPath(clipProj);
    const polys = data.land10 && z >= LAND10_ZOOM ? data.land10 : data.land50;
    const land = path2D(geoPath, { type: 'GeometryCollection', geometries: visiblePolygons(polys, bounds) });

    // Sea, with lighter shallows and darker deeps.
    ctx.fillStyle = COLORS.sea;
    ctx.fillRect(0, 0, W, H);
    if (relief) smoothDraw(relief.sea, relief, W, H);

    // Graticule, with spacing that suits the zoom.
    const pxPerDegree = (proj.scale() * 0.8707 * Math.PI) / 180;
    const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find((v) => v * pxPerDegree >= 130) || 30;
    const grat = d3.geoGraticule().step([step, step]).extent([
      [Math.floor(bounds[0] / step) * step - step, Math.max(-90, Math.floor(bounds[1] / step) * step - step)],
      [Math.ceil(bounds[2] / step) * step + step, Math.min(90, Math.ceil(bounds[3] / step) * step + step)]
    ]);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.8;
    ctx.stroke(path2D(geoPath, grat()));

    // Water lines along the coast, like an engraved chart.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [width, alpha] of [[20, 0.06], [13, 0.08], [8, 0.11], [4, 0.17]]) {
      ctx.strokeStyle = `rgba(242, 247, 243, ${alpha})`;
      ctx.lineWidth = width;
      ctx.stroke(land);
    }

    // Land.
    ctx.fillStyle = COLORS.land;
    ctx.fill(land);
    if (relief) {
      ctx.save();
      ctx.clip(land);
      smoothDraw(relief.land, relief, W, H);
      ctx.restore();
    }

    // Borders (modern, for orientation only), fading out when zoomed in close.
    if (data.borders && z < 8.5) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 0.7;
      ctx.stroke(path2D(geoPath, data.borders));
      ctx.setLineDash([]);
    }

    drawRivers(geoPath, z);

    ctx.strokeStyle = COLORS.coast;
    ctx.lineWidth = z > 6 ? 1.4 : 1;
    ctx.stroke(land);
  }

  function smoothDraw(canvas, relief, W, H) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, relief.w * relief.step, relief.h * relief.step);
  }

  function drawRivers(geoPath, z) {
    ctx.strokeStyle = COLORS.river;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of data.rivers) {
      const minZoom = f.properties.min_zoom;
      if (z < minZoom - 0.5) continue;
      ctx.lineWidth = clamp(0.7 + (z - minZoom) * 0.42, 0.7, 2.8);
      ctx.stroke(path2D(geoPath, f.geometry));
    }
  }

  /* ------------------------------------------------------------------------
     Labels
     ------------------------------------------------------------------------ */

  function lineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    }
    return total;
  }

  function pointAlong(coords, fraction) {
    const target = lineLength(coords) * fraction;
    let run = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
      if (run + seg >= target && seg > 0) {
        const t = (target - run) / seg;
        return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
      }
      run += seg;
    }
    return coords[coords.length - 1];
  }

  function riverLabelCandidates(features) {
    const out = [];
    for (const f of features) {
      const name = f.properties.name;
      if (!name) continue;
      const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let best = null;
      let bestLength = 0;
      for (const part of parts) {
        const length = lineLength(part);
        if (length > bestLength) { bestLength = length; best = part; }
      }
      if (!best || bestLength < 0.2) continue;
      out.push({
        kind: 'river',
        name,
        type: 'river',
        ll: pointAlong(best, 0.5),
        from: pointAlong(best, 0.42),
        to: pointAlong(best, 0.58),
        minLabel: f.properties.min_label
      });
    }
    return out;
  }

  function labelElement(item) {
    if (!item.el) {
      item.el = document.createElement('span');
      item.el.className = `map-label label-${item.type}`;
      item.el.textContent = item.name;
      host.labelsLayer.append(item.el);
    }
    return item.el;
  }

  function placeLabels(proj, z, W, H) {
    const s = host.state;
    const kRel = s.transform.k / s.kScale;
    const candidates = [];
    // Labels stay inside the part of the map you can actually see (not under the panel or top bar).
    const area = host.visibleRect ? host.visibleRect() : { x0: 0, y0: 0, x1: W, y1: H };
    const inArea = (p) => p && p[0] > area.x0 && p[0] < area.x1 && p[1] > area.y0 && p[1] < area.y1;

    for (const item of labelItems) {
      if (kRel < item.minZoom || kRel > item.maxZoom) continue;
      const p = proj(item.ll);
      if (!inArea(p)) continue;
      candidates.push({ item, x: p[0], y: p[1], angle: item.angle });
    }
    for (const item of data.riverLabels) {
      if (z < item.minLabel) continue;
      const p = proj(item.ll);
      if (!inArea(p)) continue;
      const a = proj(item.from);
      const b = proj(item.to);
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (chord < item.name.length * 4.2) continue;
      let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      candidates.push({ item, x: p[0], y: p[1], angle });
    }
    candidates.sort((p, q) => (LABEL_PRIORITY[p.item.type] - LABEL_PRIORITY[q.item.type]) ||
      ((p.item.minLabel || 0) - (q.item.minLabel || 0)));

    // Keep out of the way of the stop markers, then of labels already placed.
    const taken = [];
    for (const r of host.blockers ? host.blockers() : []) {
      taken.push({ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 });
    }
    const t = s.transform;
    for (const m of s.markers) {
      if (!m.base) continue;
      const x = t.x + t.k * m.base[0];
      const y = t.y + t.k * m.base[1];
      const room = String(m.name || '').length * 8.5 + 24;
      const side = m.labelPosition === 'left' ? [x - room, x + 18] : [x - 18, x + room];
      taken.push({ x0: side[0], x1: side[1], y0: y - 18, y1: y + 18 });
    }

    const shown = new Set();
    for (const c of candidates) {
      const size = LABEL_FONT[c.item.type];
      const spacing = c.item.type === 'ocean' ? 1.5 : c.item.type === 'sea' ? 1.35 : 1;
      const w = c.item.name.length * size * 0.5 * spacing + 6;
      const h = size * 1.3;
      const rad = (c.angle * Math.PI) / 180;
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      const box = { x0: c.x - bw / 2, x1: c.x + bw / 2, y0: c.y - bh / 2, y1: c.y + bh / 2 };
      if (box.x0 < area.x0 + 4 || box.x1 > area.x1 - 4 || box.y0 < area.y0 + 4 || box.y1 > area.y1 - 4) continue;
      if (taken.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
      taken.push(box);
      const node = labelElement(c.item);
      node.style.display = '';
      node.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) translate(-50%, -50%) rotate(${c.angle.toFixed(1)}deg)`;
      shown.add(c.item);
    }

    for (const item of [...labelItems, ...data.riverLabels]) {
      if (!shown.has(item) && item.el) item.el.style.display = 'none';
    }
  }

  window.CacaoDetail = { init, hide, schedule };
})();
