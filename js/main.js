/* ==========================================================================
   Cacao & Empire: interactive map
   --------------------------------------------------------------------------
   All historical content comes from data/stops.json and data/routes.json.
   This file only knows how to draw and animate whatever is in those files.
   ========================================================================== */
(function () {
  'use strict';

  const CONFIG = {
    stopsUrl: 'data/stops.json',
    routesUrl: 'data/routes.json',
    atlasUrl: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
    land10Url: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-10m.json', // sharper coastlines when zoomed in
    riversUrl: 'data/rivers.json',
    labelsUrl: 'data/labels.json',
    maxZoom: 2500,        // furthest the map can zoom (same units as "zoom" in stops.json)
    flyMs: 1700,          // camera move to a stop
    oceanDrawMs: 2600,    // time for an ocean route (and its ship) to draw
    landDrawMs: 1500,     // time for a land route to draw
    finaleFlyMs: 2200,    // zoom out at the end
    finaleStaggerMs: 450, // delay between each stop's routes in the finale
    defaultBend: 0.2,     // how curved a route is if routes.json doesn't say
    defaultZoom: 6,       // max zoom for a stop if stops.json doesn't say
    sceneSettleMs: 900,   // pause on the close-up before diving into a stop's scene
    sceneDiveMs: 1500,    // the dive from the map into the scene
    sceneLeaveMs: 1100    // climbing back out of the scene to the map
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 720px)');
  const ms = (n) => (reduceMotion.matches ? 0 : n);
  const $ = (sel) => document.querySelector(sel);

  const els = {
    map: $('#map'),
    mapSvg: $('#map-svg'),
    routesLayer: $('#routes-layer'),
    shipsLayer: $('#ships-layer'),
    markers: $('#markers'),
    detailCanvas: $('#detail-canvas'),
    labels: $('#labels'),
    topbar: $('.topbar'),
    topbarTitle: $('#topbar-title'),
    year: $('#year'),
    overviewBtn: $('#overview-btn'),
    sourcesBtn: $('#sources-btn'),
    hint: $('#hint'),
    panel: $('#panel'),
    panelBody: $('#panel-body'),
    panelFooter: $('#panel-footer'),
    panelClose: $('#panel-close'),
    panelHandle: $('#panel-handle'),
    titleCard: $('#title-card'),
    titleTitle: $('#title-card-title'),
    titleSubtitle: $('#title-card-subtitle'),
    titleQuestion: $('#title-card-question'),
    titleAuthors: $('#title-card-authors'),
    titleError: $('#title-card-error'),
    begin: $('#begin-btn'),
    sourcesDialog: $('#sources-dialog'),
    sourcesBody: $('#sources-body'),
    sourcesClose: $('#sources-close'),
    scene: $('#scene'),
    sceneStage: $('#scene-stage'),
    sceneImg: $('#scene-img'),
    sceneHotspots: $('#scene-hotspots'),
    sceneBack: $('#scene-back'),
    sceneCaption: $('#scene-caption'),
    scenePopover: $('#scene-popover')
  };

  const state = {
    data: null,
    stops: [],
    routes: [],
    markers: [],
    markerById: new Map(),
    stopById: new Map(),
    projection: null,
    zoom: null,
    gMap: null,
    transform: null,
    width: 0,
    height: 0,
    kScale: 1,
    kMin: 0.5,
    kMax: 100,
    land: null,
    borders: null,
    reached: -1,      // highest stop index the visitor has reached
    current: null,    // stop index, 'finale', or null
    finished: false,
    started: false,
    scene: null,      // the stop whose scene is showing, or null
    nav: 0            // increases on every navigation, so older animations can stop
  };

  /* ------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------ */

  const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  const isTodo = (s) => typeof s === 'string' && /^\s*TODO/i.test(s);
  const validCoords = (c) =>
    Array.isArray(c) && c.length >= 2 && Number.isFinite(+c[0]) && Number.isFinite(+c[1]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const delay = (t) => new Promise((resolve) => setTimeout(resolve, t));

  // Text node, or a highlighted span if the text is still a TODO placeholder.
  function text(value) {
    const str = value == null ? '' : String(value);
    if (isTodo(str)) {
      const span = document.createElement('span');
      span.className = 'todo';
      span.textContent = str;
      return span;
    }
    return document.createTextNode(str);
  }

  // Tiny element builder: el('p', { class: 'x' }, 'text', childNode, ...)
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? text(child) : child);
    }
    return node;
  }

  function paragraphs(value) {
    let list = asArray(value);
    if (list.length === 1 && typeof list[0] === 'string') list = list[0].split(/\n\s*\n/);
    return list.filter((p) => p != null && String(p).trim() !== '').map((p) => el('p', null, p));
  }

  /* ------------------------------------------------------------------------
     Loading
     ------------------------------------------------------------------------ */

  async function loadJSON(url) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-cache' });
    } catch (e) {
      throw new Error(`Could not load ${url}.`);
    }
    if (!res.ok) throw new Error(`Could not load ${url} (error ${res.status}).`);
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `${url} has a formatting mistake, so it could not be read. ` +
        `Paste it into a JSON checker such as jsonlint.com to find the problem. (Details: ${e.message})`
      );
    }
  }

  function showError(err) {
    console.error(err);
    const box = els.titleError;
    box.hidden = false;
    box.replaceChildren(
      el('strong', null, 'The map could not start. '),
      document.createTextNode(err.message)
    );
    if (location.protocol === 'file:') {
      box.append(el('p', null,
        'It looks like index.html was opened straight from your computer. Browsers block the data files ' +
        'when you do that. Start a local web server instead (see "Preview locally" in README.md).'));
    }
    els.begin.hidden = true;
    if (els.titleTitle.textContent === 'Loading…') els.titleTitle.textContent = 'Cacao & Empire';
  }

  async function init() {
    els.map.inert = true;
    els.topbar.inert = true;

    if (!window.d3 || !window.topojson) {
      showError(new Error('The map libraries (D3 and TopoJSON) did not load. Check your internet connection and reload.'));
      return;
    }

    let data, routesData, world;
    try {
      [data, routesData, world] = await Promise.all([
        loadJSON(CONFIG.stopsUrl),
        loadJSON(CONFIG.routesUrl),
        d3.json(CONFIG.atlasUrl).catch(() => {
          throw new Error('Could not download the world map outline. Check your internet connection and reload.');
        })
      ]);
    } catch (err) {
      showError(err);
      return;
    }

    state.data = data || {};
    try {
      prepareStops(state.data);
      prepareRoutes(routesData);
      fillTitleCard(state.data.intro || {});
      buildMap(world);
      if (window.CacaoDetail) {
        CacaoDetail.init({
          canvas: els.detailCanvas,
          baseLayer: state.gMap.node(),
          labelsLayer: els.labels,
          state,
          land50: state.land,
          borders50: state.borders,
          land10Url: CONFIG.land10Url,
          riversUrl: CONFIG.riversUrl,
          labelsUrl: CONFIG.labelsUrl,
          // The view drawn as one big background picture of the whole tour.
          overviewTransform: () => (state.markers.length ? fitTransform(allFramePts(), 4, false) : null),
          // Where labels may go, and what they should keep clear of.
          visibleRect: () => viewRect(isPanelOpen()),
          blockers: () => ['.legend', '.compass']
            .map((sel) => document.querySelector(sel))
            .filter((node) => node && node.getClientRects().length)
            .map((node) => node.getBoundingClientRect())
        });
      }
      buildMarkers();
      buildRoutes();
      buildSources();
      bindUI();
      resize();
      showOverview(0);
      updateMarkers();
    } catch (err) {
      showError(err);
      return;
    }
    els.begin.disabled = false;
  }

  /* ------------------------------------------------------------------------
     Data preparation
     ------------------------------------------------------------------------ */

  function prepareStops(data) {
    const raw = asArray(data.stops);
    if (!raw.length) throw new Error('data/stops.json has no "stops" list.');

    state.stops = raw
      .map((stop, i) => ({ stop, i }))
      .sort((a, b) => ((a.stop.order ?? a.i + 1) - (b.stop.order ?? b.i + 1)) || a.i - b.i)
      .map((o) => o.stop);

    state.stops.forEach((stop, index) => {
      stop.index = index;
      if (!stop.id) stop.id = `stop-${index + 1}`;
      state.stopById.set(stop.id, stop);

      let markers = asArray(stop.markers).filter((m) => m && validCoords(m.coordinates));
      if (!markers.length && validCoords(stop.coordinates)) {
        markers = [{ id: stop.id, name: stop.place || stop.title, coordinates: stop.coordinates }];
      }
      if (!markers.length) {
        console.warn(`stops.json: stop "${stop.id}" has no valid coordinates, so it has no marker.`);
      }
      stop.markers = markers.map((m, j) => {
        const c = [+m.coordinates[0], +m.coordinates[1]];
        if (Math.abs(c[1]) > 90) {
          console.warn(`stops.json: marker "${m.name}" has latitude ${c[1]}. Coordinates must be [longitude, latitude].`);
        }
        return {
          ...m,
          coordinates: c,
          id: m.id || `${stop.id}-${j + 1}`,
          name: m.name || stop.place || stop.title || '',
          stop
        };
      });
      // Extra points to include when zooming in close (see "frame" in the README).
      stop.frame = asArray(stop.frame).filter(validCoords).map((c) => [+c[0], +c[1]]);
      // A picture the camera dives into after the close-up (see "Adding a scene" in the README).
      const sc = stop.scene;
      if (sc && typeof sc === 'object' && typeof sc.image === 'string' && sc.image.trim()) {
        sc.hotspots = asArray(sc.hotspots)
          .filter((h) => h && Number.isFinite(+h.x) && Number.isFinite(+h.y))
          .map((h) => ({ ...h, x: clamp(+h.x, 0, 1), y: clamp(+h.y, 0, 1), label: h.label || 'TODO: label' }));
      } else {
        if (sc) console.warn(`stops.json: stop "${stop.id}" has a "scene" without an "image", so it is ignored.`);
        stop.scene = null;
      }
      stop.markers.forEach((m) => {
        state.markers.push(m);
        if (!state.markerById.has(m.id)) state.markerById.set(m.id, m);
      });
    });
  }

  // A route end can be a marker id, a marker name, a stop id,
  // [longitude, latitude], or { "name": "...", "coordinates": [lon, lat] }.
  function resolvePoint(ref) {
    if (validCoords(ref)) return { name: `${ref[1]}, ${ref[0]}`, coordinates: [+ref[0], +ref[1]] };
    if (typeof ref === 'string') {
      const key = ref.trim().toLowerCase();
      const byId = state.markerById.get(ref.trim());
      if (byId) return byId;
      const byName = state.markers.find((m) => String(m.name).toLowerCase() === key);
      if (byName) return byName;
      const stop = state.stopById.get(ref.trim());
      if (stop && stop.markers[0]) return stop.markers[0];
    }
    if (ref && typeof ref === 'object' && validCoords(ref.coordinates)) {
      return { name: ref.name || '', coordinates: [+ref.coordinates[0], +ref.coordinates[1]] };
    }
    return null;
  }

  function prepareRoutes(json) {
    let list = asArray(json && json.routes);
    if (!list.length) {
      // No routes written yet: connect each stop to the one before it.
      list = state.stops.slice(1).map((stop, i) => ({
        from: state.stops[i].markers[0] && state.stops[i].markers[0].id,
        to: stop.markers[0] && stop.markers[0].id,
        type: 'ocean',
        revealedAt: stop.id
      }));
    }

    list.forEach((r, i) => {
      const label = r.id ? `"${r.id}"` : `#${i + 1}`;
      const from = resolvePoint(r.from);
      const to = resolvePoint(r.to);
      if (!from || !to) {
        console.warn(`routes.json: route ${label} has a "from" or "to" that doesn't match any marker id, marker name, stop id, or [longitude, latitude]. Skipped.`);
        return;
      }
      const stop = state.stopById.get(r.revealedAt) || to.stop;
      if (!stop) {
        console.warn(`routes.json: route ${label} has revealedAt "${r.revealedAt}", which isn't a stop id. Skipped.`);
        return;
      }
      state.routes.push({
        id: r.id || `route-${i + 1}`,
        label: r.label,
        from,
        to,
        stop,
        type: r.type === 'land' ? 'land' : 'ocean',
        goods: asArray(r.goods),
        bend: Number.isFinite(r.bend) ? r.bend : CONFIG.defaultBend,
        via: asArray(r.via).filter(validCoords).map((c) => [+c[0], +c[1]]),
        state: 'hidden',
        progress: 0
      });
    });
  }

  const routesFor = (stop) => state.routes.filter((r) => r.stop === stop);

  /* ------------------------------------------------------------------------
     Map drawing
     ------------------------------------------------------------------------ */

  function buildMap(world) {
    const obj = world.objects.countries;
    const land = topojson.merge(world, obj.geometries);
    const borders = topojson.mesh(world, obj, (a, b) => a !== b);
    state.land = land;
    state.borders = borders;

    const svg = d3.select(els.mapSvg);
    state.gMap = svg.append('g').attr('class', 'map-layer');
    state.gMap.append('path').datum({ type: 'Sphere' }).attr('class', 'sphere');
    state.gMap.append('path').datum(d3.geoGraticule().step([15, 15])()).attr('class', 'graticule');
    state.gMap.append('path').datum(land).attr('class', 'land');
    state.gMap.append('path').datum(borders).attr('class', 'borders');

    state.transform = d3.zoomIdentity;
    state.zoom = d3.zoom()
      .scaleExtent([0.5, CONFIG.maxZoom])
      // The detailed map moves with the camera every frame, and draws a fresh,
      // sharp picture of the view once the camera stops.
      .on('start.detail', () => window.CacaoDetail && CacaoDetail.setMoving(true))
      .on('end.detail', () => window.CacaoDetail && CacaoDetail.setMoving(false))
      .on('zoom', (event) => {
        state.transform = event.transform;
        state.gMap.attr('transform', event.transform);
        updateOverlay();
        if (window.CacaoDetail) CacaoDetail.frame();
      });
    svg.call(state.zoom).on('dblclick.zoom', null);
  }

  function resize() {
    state.width = window.innerWidth;
    state.height = window.innerHeight;

    state.projection = d3.geoNaturalEarth1()
      .fitExtent([[12, 12], [state.width - 12, state.height - 12]], { type: 'Sphere' });
    const path = d3.geoPath(state.projection);
    state.gMap.selectAll('path').attr('d', path);

    // Zoom values in stops.json are for a ~1200px-wide world, so phones zoom in further.
    // Don't let the view zoom out or pan past the edge of the world.
    const b = path.bounds({ type: 'Sphere' });
    const worldW = b[1][0] - b[0][0];
    const worldH = b[1][1] - b[0][1];
    state.kScale = Math.max(1, 1200 / worldW);
    state.kMin = Math.max(state.width / worldW, state.height / worldH);
    state.kMax = CONFIG.maxZoom * state.kScale;
    state.zoom
      .extent([[0, 0], [state.width, state.height]])
      .scaleExtent([state.kMin, state.kMax])
      .translateExtent(b);

    state.markers.forEach((m) => { m.base = state.projection(m.coordinates); });
    state.routes.forEach(computeRouteBase);
    if (window.CacaoDetail) CacaoDetail.reset();
    reframe();
    layoutScene();
    prefetchAhead();
  }

  function computeRouteBase(r) {
    const p = state.projection;
    const p0 = p(r.from.coordinates);
    const p1 = p(r.to.coordinates);
    if (r.via.length) {
      r.base = { type: 'via', pts: [p0, ...r.via.map(p), p1] };
    } else {
      // Control point is pushed sideways ("bend") from the midpoint.
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const c = [(p0[0] + p1[0]) / 2 + dy * r.bend, (p0[1] + p1[1]) / 2 - dx * r.bend];
      r.base = { type: 'quad', pts: [p0, c, p1] };
    }
  }

  // Points (in map units) that should be visible when framing a route.
  function routeFramePts(r) {
    if (r.base.type === 'quad') {
      const [a, c, b] = r.base.pts;
      return [a, b, [0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1]]];
    }
    return r.base.pts;
  }

  const catmull = d3.line().curve(d3.curveCatmullRom.alpha(0.5));

  function routePathD(r) {
    const t = state.transform;
    const pts = r.base.pts.map((pt) => t.apply(pt));
    if (r.base.type === 'quad') {
      const [a, c, b] = pts;
      return `M${a[0]},${a[1]}Q${c[0]},${c[1]} ${b[0]},${b[1]}`;
    }
    return catmull(pts);
  }

  /* ------------------------------------------------------------------------
     Camera
     ------------------------------------------------------------------------ */

  function viewRect(withPanel) {
    const top = els.topbar.offsetHeight;
    const W = state.width;
    const H = state.height;
    if (withPanel) {
      if (mobile.matches) return { x0: 0, y0: top, x1: W, y1: H - els.panel.offsetHeight };
      return { x0: 0, y0: top, x1: W - els.panel.offsetWidth, y1: H };
    }
    return { x0: 0, y0: top, x1: W, y1: H };
  }

  function fitTransform(pts, maxZoom, withPanel) {
    const r = viewRect(withPanel);
    const pad = mobile.matches ? 44 : 90;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const availW = Math.max(60, r.x1 - r.x0 - 2 * pad);
    const availH = Math.max(60, r.y1 - r.y0 - 2 * pad);
    const kCap = (Number.isFinite(maxZoom) ? maxZoom : CONFIG.defaultZoom) * state.kScale;
    const k = clamp(Math.min(kCap, availW / Math.max(x1 - x0, 1e-6), availH / Math.max(y1 - y0, 1e-6)), state.kMin, state.kMax);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const t = d3.zoomIdentity.translate((r.x0 + r.x1) / 2 - k * cx, (r.y0 + r.y1) / 2 - k * cy).scale(k);
    return state.zoom.constrain()(t, state.zoom.extent()(), state.zoom.translateExtent());
  }

  function flyTo(transform, duration) {
    return new Promise((resolve) => {
      const svg = d3.select(els.mapSvg);
      svg.interrupt();
      if (!duration) {
        svg.call(state.zoom.transform, transform);
        resolve();
        return;
      }
      svg.transition()
        .duration(duration)
        .ease(d3.easeCubicInOut)
        .call(state.zoom.transform, transform)
        .on('end', resolve)
        .on('interrupt', resolve);
    });
  }

  // The close-up view of a stop: its markers plus any extra "frame" points.
  function stopFramePts(stop) {
    const pts = stop.markers.map((m) => m.base);
    stop.frame.forEach((c) => pts.push(state.projection(c)));
    return pts;
  }

  // The wider view used while a route draws itself.
  function routesFramePts(routes) {
    const pts = [];
    routes.forEach((r) => pts.push(...routeFramePts(r)));
    return pts;
  }

  function allFramePts() {
    const pts = state.markers.map((m) => m.base);
    state.routes.forEach((r) => pts.push(...routeFramePts(r)));
    return pts;
  }

  function showOverview(duration) {
    if (!state.markers.length) return Promise.resolve();
    return flyTo(fitTransform(allFramePts(), 4, false), duration);
  }

  // Re-frame the current view without animation (used after a resize).
  function reframe() {
    if (!state.markers.length) return;
    if (state.current === 'finale') flyTo(fitTransform(allFramePts(), 6, isPanelOpen()), 0);
    else if (typeof state.current === 'number') {
      const stop = state.stops[state.current];
      flyTo(fitTransform(stopFramePts(stop), stop.zoom, isPanelOpen()), 0);
    } else showOverview(0);
  }

  /* ------------------------------------------------------------------------
     Overlay: markers and routes (drawn in screen space so they stay crisp)
     ------------------------------------------------------------------------ */

  function buildMarkers() {
    state.stops.forEach((stop) => {
      stop.markers.forEach((m) => {
        const pos = ['left', 'right', 'top', 'bottom'].includes(m.labelPosition) ? m.labelPosition : 'right';
        m.el = el('button', { type: 'button', class: `marker label-${pos}` },
          el('span', { class: 'marker-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'marker-label', 'aria-hidden': 'true' }, m.name)
        );
        m.el.addEventListener('click', () => onMarker(stop.index));
        els.markers.append(m.el);
      });
    });
  }

  function updateMarkers() {
    const n = state.stops.length;
    const next = state.started && !state.finished ? state.reached + 1 : -1;
    state.markers.forEach((m) => {
      const i = m.stop.index;
      const visited = i <= state.reached;
      const isNext = i === next;
      const locked = !visited && !isNext;
      const current = state.current === i;
      const b = m.el;
      b.classList.toggle('is-visited', visited);
      b.classList.toggle('is-next', isNext);
      b.classList.toggle('is-locked', locked);
      b.classList.toggle('is-current', current);
      b.disabled = locked;
      b.style.zIndex = isNext ? 3 : current ? 2 : 1;
      if (current) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');

      const title = m.stop.title && !isTodo(m.stop.title) ? `: ${m.stop.title}` : '';
      const status = isNext ? ' (next stop)' : visited ? ' (visited)' : ' (not reached yet)';
      b.setAttribute('aria-label', `Stop ${i + 1} of ${n}, ${m.name}${title}${status}`);
    });
  }

  function onMarker(index) {
    if (state.current === index && isPanelOpen()) {
      focusPanel();
      return;
    }
    goToStop(index);
  }

  function buildRoutes() {
    const layer = d3.select(els.routesLayer);
    const ships = d3.select(els.shipsLayer);
    state.routes.forEach((r) => {
      r.g = layer.append('g').attr('class', `route ${r.type} is-hidden`);
      r.halo = r.g.append('path').attr('class', 'route-halo');
      r.line = r.g.append('path').attr('class', 'route-line');
      r.ship = ships.append('g').attr('class', 'ship').style('opacity', 0);
      r.ship.append('g').attr('class', 'ship-bob').append('use')
        .attr('href', '#ship')
        .attr('x', -34).attr('y', -45)
        .attr('width', 72).attr('height', 57);
    });
  }

  function updateOverlay() {
    const t = state.transform;
    for (const m of state.markers) {
      if (!m.base || !m.el) continue;
      const [x, y] = t.apply(m.base);
      m.el.style.transform = `translate(${x}px, ${y}px)`;
    }
    for (const r of state.routes) renderRoute(r);
  }

  function renderRoute(r) {
    if (r.state === 'hidden' || !r.base) return;
    const d = routePathD(r);
    r.halo.attr('d', d);
    r.line.attr('d', d);
    if (r.state === 'drawing') {
      const L = r.line.node().getTotalLength();
      const dash = `${L * r.progress} ${L + 10}`;
      r.halo.style('stroke-dasharray', dash);
      r.line.style('stroke-dasharray', dash);
    }
    if (r.shipOn) placeShip(r);
  }

  function placeShip(r) {
    const node = r.line.node();
    const L = node.getTotalLength();
    const at = clamp(L * r.shipT, 0, L);
    const p = node.getPointAtLength(at);
    const ahead = node.getPointAtLength(Math.min(L, at + 2));
    const behind = node.getPointAtLength(Math.max(0, at - 2));
    const flip = ahead.x - behind.x < 0 ? -1 : 1;
    // The ship is drawn around its waterline at (0, 8) and faces right, so flip it
    // when the route runs west.
    const size = mobile.matches ? 0.62 : 0.85;
    r.ship.attr('transform', `translate(${p.x},${p.y}) scale(${flip * size},${size}) translate(0,-8)`);
  }

  function animateRoute(r, duration) {
    stopRouteAnim(r);
    return new Promise((resolve) => {
      r.state = 'drawing';
      r.progress = 0;
      r.g.classed('is-hidden', false);
      r.line.classed('flow', false).attr('marker-end', null);
      r.shipOn = r.type === 'ocean' && duration > 0;
      r.shipT = 0;
      r.ship.style('opacity', r.shipOn ? 1 : 0);

      r.finish = () => {
        r.timer = null;
        r.finish = null;
        r.state = 'drawn';
        r.progress = 1;
        r.halo.style('stroke-dasharray', null);
        r.line.style('stroke-dasharray', null).classed('flow', true).attr('marker-end', `url(#arrow-${r.type})`);
        r.shipT = 1;
        renderRoute(r);
        r.shipOn = false;
        r.ship.style('opacity', 0);
        resolve();
      };

      if (!duration) {
        r.finish();
        return;
      }
      renderRoute(r);
      r.timer = d3.timer((elapsed) => {
        const t = Math.min(1, elapsed / duration);
        r.progress = d3.easeCubicInOut(t);
        r.shipT = r.progress;
        renderRoute(r);
        if (t >= 1) {
          r.timer.stop();
          r.finish();
        }
      });
    });
  }

  function stopRouteAnim(r) {
    if (r.timer) r.timer.stop();
    if (r.finish) r.finish();
  }

  function hideRoute(r) {
    stopRouteAnim(r);
    r.state = 'hidden';
    r.g.classed('is-hidden', true).classed('is-dim', false);
    r.shipOn = false;
    r.ship.style('opacity', 0);
  }

  // Make sure every route belonging to a reached stop is on the map.
  function syncRoutes(except) {
    state.routes.forEach((r) => {
      stopRouteAnim(r);
      if (except && except.includes(r)) return;
      if (r.stop.index <= state.reached && r.state === 'hidden') animateRoute(r, 0);
    });
  }

  function highlightRoutes(active) {
    state.routes.forEach((r) => r.g.classed('is-dim', !!active && !active.includes(r)));
  }

  /* ------------------------------------------------------------------------
     Tour navigation
     ------------------------------------------------------------------------ */

  // Where the camera goes for a stop: a close-up of the place, and (for a new
  // stop with routes) a wider "lead" view that shows the routes first.
  function planStop(stop, isNew) {
    const own = routesFor(stop);
    const closeUp = fitTransform(stopFramePts(stop), stop.zoom, true);
    let lead = null;
    if (isNew && own.length) {
      lead = fitTransform(routesFramePts(own), CONFIG.defaultZoom, false);
      // If the close-up already shows the whole route, skip the lead view.
      if (Math.abs(Math.log(lead.k / closeUp.k)) < 0.25) lead = null;
    }
    return { own, closeUp, lead };
  }

  const finaleTransform = () => fitTransform(allFramePts(), 6, true);

  // Draw the detailed map for the next stop in the background, so the camera
  // arrives on a finished picture.
  function prefetchAhead() {
    if (!window.CacaoDetail || !state.markers.length) return;
    const next = typeof state.current === 'number' ? state.current + 1 : state.reached + 1;
    const views = [];
    if (next < state.stops.length) {
      const plan = planStop(state.stops[next], next === state.reached + 1 && !state.finished);
      if (plan.lead) views.push(plan.lead);
      views.push(plan.closeUp);
      preloadScene(state.stops[next]);
    } else if (next === state.stops.length) {
      views.push(finaleTransform());
    }
    CacaoDetail.prefetch(views);
  }

  async function goToStop(index) {
    const stop = state.stops[index];
    if (!stop || index > state.reached + 1) return;
    const token = ++state.nav;
    await leaveScene(true);
    if (token !== state.nav) return;
    const isNew = index === state.reached + 1 && !state.finished;
    const { own, closeUp, lead } = planStop(stop, isNew);
    preloadScene(stop);
    if (window.CacaoDetail) CacaoDetail.prefetch([lead, closeUp].filter(Boolean));
    if (index > state.reached) state.reached = index;
    state.current = index;

    syncRoutes(isNew ? own : null);
    if (isNew) own.forEach(hideRoute);
    highlightRoutes(own.length ? own : null);

    hideHint();
    els.overviewBtn.hidden = false;
    updateMarkers();
    setYear(stop.yearLabel);
    closePanel();

    const drawRoutes = () => Promise.all(own.map((r) =>
      animateRoute(r, ms(r.type === 'ocean' ? CONFIG.oceanDrawMs : CONFIG.landDrawMs))));

    // A new stop with routes: first frame the whole route and let it draw itself
    // (the ship sails), then fly in close on the place.
    if (lead) {
      await flyTo(lead, ms(CONFIG.flyMs));
      if (token !== state.nav) return;
      await drawRoutes();
      if (token !== state.nav) return;
    }

    renderStopPanel(stop);
    openPanel();
    await flyTo(closeUp, ms(CONFIG.flyMs));
    if (token !== state.nav) return;

    if (isNew && !lead) await drawRoutes();
    if (token !== state.nav) return;
    // Give the arrival a moment to settle before drawing the next stop in the background.
    setTimeout(() => { if (token === state.nav) prefetchAhead(); }, 1200);

    // Then keep going: dive from the map into this stop's picture.
    if (stop.scene) {
      await delay(ms(CONFIG.sceneSettleMs));
      if (token !== state.nav) return;
      await enterScene(stop, token);
    }
  }

  async function goToFinale() {
    const token = ++state.nav;
    await leaveScene(true);
    if (token !== state.nav) return;
    state.reached = state.stops.length - 1;
    state.current = 'finale';
    state.finished = true;
    syncRoutes();
    highlightRoutes(null);
    hideHint();
    updateMarkers();
    const conclusion = state.data.conclusion || {};
    setYear(conclusion.yearLabel);

    closePanel();
    await flyTo(finaleTransform(), ms(CONFIG.finaleFlyMs));
    if (token !== state.nav) return;

    renderConclusionPanel();
    openPanel();

    if (!ms(1)) return; // reduced motion: routes are already all showing
    // Redraw the whole network, one stop's routes after another.
    state.routes.forEach(hideRoute);
    const groups = d3.groups(state.routes, (r) => r.stop.index).sort((a, b) => a[0] - b[0]);
    for (const [, routes] of groups) {
      if (token !== state.nav) return;
      routes.forEach((r) => animateRoute(r, r.type === 'ocean' ? CONFIG.oceanDrawMs : CONFIG.landDrawMs));
      await delay(CONFIG.finaleStaggerMs);
    }
  }

  function goToOverview() {
    ++state.nav;
    leaveScene(true);
    state.current = null;
    syncRoutes();
    highlightRoutes(null);
    closePanel();
    updateMarkers();
    showOverview(ms(CONFIG.flyMs));
    showHint();
    prefetchAhead();
  }

  function restart() {
    ++state.nav;
    leaveScene(true);
    state.reached = -1;
    state.current = null;
    state.finished = false;
    state.routes.forEach(hideRoute);
    closePanel();
    els.overviewBtn.hidden = true;
    setYear((state.data.intro || {}).yearLabel);
    updateMarkers();
    showOverview(ms(CONFIG.flyMs));
    showHint();
    focusNextMarker();
    prefetchAhead();
  }

  function setYear(label) {
    if (label == null || label === '') return;
    els.year.textContent = label;
    els.year.classList.remove('flip');
    void els.year.offsetWidth; // restart the animation
    els.year.classList.add('flip');
  }

  function focusNextMarker() {
    const stop = state.stops[state.reached + 1] || state.stops[typeof state.current === 'number' ? state.current : 0];
    const m = stop && stop.markers[0];
    if (m) m.el.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------------
     Scene: a period picture the camera dives into after a stop's close-up
     ------------------------------------------------------------------------ */

  function preloadScene(stop) {
    const sc = stop && stop.scene;
    if (!sc || sc.loader) return;
    const img = new Image();
    sc.loader = new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => { console.warn(`Scene image not found: ${sc.image}`); resolve(false); };
    });
    img.src = sc.image;
    sc.img = img;
  }

  const sceneOrigin = (stop) => {
    const m = stop.markers[0];
    return m && m.base ? state.transform.apply(m.base) : [state.width / 2, state.height / 2];
  };

  // Sizes the picture to cover the screen and works out the slow drift ("pan").
  function layoutScene() {
    const stop = state.scene;
    if (!stop) return;
    const sc = stop.scene;
    const nw = (sc.img && sc.img.naturalWidth) || 1600;
    const nh = (sc.img && sc.img.naturalHeight) || 1000;
    // Fill the part of the screen the panel doesn't cover, so every hotspot can be seen.
    const r = viewRect(isPanelOpen());
    const W = Math.max(120, r.x1 - r.x0);
    const H = Math.max(120, r.y1 - r.y0);
    const fit = Math.max(W / nw, H / nh);
    const sw = nw * fit;
    const sh = nh * fit;
    const stage = els.sceneStage;
    stage.style.width = `${sw}px`;
    stage.style.height = `${sh}px`;
    stage.style.left = `${r.x0 + W / 2}px`;
    stage.style.top = `${r.y0 + H / 2}px`;
    els.sceneCaption.style.bottom = `${state.height - r.y1 + 10}px`;

    const pan = sc.pan || {};
    const frac = (v, fallback) => (validCoords(v) ? [clamp(+v[0], 0, 1), clamp(+v[1], 0, 1)] : fallback);
    const from = frac(pan.from, [0.5, 0.5]);
    const to = frac(pan.to, from);
    const zoom0 = Number.isFinite(pan.zoomFrom) ? clamp(pan.zoomFrom, 1, 2.5) : 1.08;
    const zoom1 = Number.isFinite(pan.zoomTo) ? clamp(pan.zoomTo, 1, 2.5) : 1.2;
    // Shift so the chosen point sits at the centre, without showing an edge.
    const offset = (f, k) => [
      clamp((0.5 - f[0]) * sw * k, -Math.max(0, (sw * k - W) / 2), Math.max(0, (sw * k - W) / 2)),
      clamp((0.5 - f[1]) * sh * k, -Math.max(0, (sh * k - H) / 2), Math.max(0, (sh * k - H) / 2))
    ];
    // Soften the drift until every hotspot stays in view at both ends of it.
    let s0 = zoom0;
    let s1 = zoom1;
    let x0, y0, x1, y1;
    const inView = (k, tx, ty) => sc.hotspots.every((h) =>
      Math.abs((h.x - 0.5) * sw * k + tx) <= W / 2 - 28 && Math.abs((h.y - 0.5) * sh * k + ty) <= H / 2 - 28);
    for (let i = 0; i < 80; i++) {
      [x0, y0] = offset(from, s0);
      [x1, y1] = offset(to, s1);
      if ((inView(s0, x0, y0) && inView(s1, x1, y1)) || (s0 === 1 && s1 === 1)) break;
      s0 = Math.max(1, s0 - 0.02);
      s1 = Math.max(1, s1 - 0.02);
    }
    stage.style.setProperty('--kb-x0', `${x0}px`);
    stage.style.setProperty('--kb-y0', `${y0}px`);
    stage.style.setProperty('--kb-s0', s0);
    stage.style.setProperty('--kb-x1', `${x1}px`);
    stage.style.setProperty('--kb-y1', `${y1}px`);
    stage.style.setProperty('--kb-s1', s1);
    stage.style.setProperty('--kb-dur', `${Number.isFinite(pan.seconds) ? clamp(pan.seconds, 5, 300) : 45}s`);
  }

  function renderSceneCaption(stop) {
    const sc = stop.scene;
    const bits = [];
    if (sc.credit) bits.push(text(sc.credit));
    if (sc.license) bits.push(bits.length ? ' · ' : '', text(sc.license));
    if (sc.sourceUrl) bits.push(' ', el('a', { href: sc.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source'));
    els.sceneCaption.replaceChildren(
      el('span', { class: 'scene-kicker' }, sc.year ? `A scene from ${sc.year}` : 'A scene'),
      el('span', { class: 'scene-title' }, sc.title || stop.place || ''),
      bits.length ? el('span', { class: 'scene-credit' }, bits) : null
    );
  }

  function renderHotspots(stop) {
    els.sceneHotspots.replaceChildren(...stop.scene.hotspots.map((h) => {
      const btn = el('button', {
        type: 'button',
        class: 'hotspot',
        style: `left:${(h.x * 100).toFixed(2)}%;top:${(h.y * 100).toFixed(2)}%`,
        'aria-label': h.label,
        'aria-expanded': 'false'
      }, el('span', { class: 'hotspot-name', 'aria-hidden': 'true' }, h.label));
      btn.addEventListener('click', () => toggleHotspot(h, btn));
      return btn;
    }));
  }

  let hotspotFollow = null;

  function toggleHotspot(h, btn) {
    if (btn.classList.contains('is-open')) { closeHotspot(); return; }
    closeHotspot();
    const pop = els.scenePopover;
    pop.replaceChildren(
      el('button', { type: 'button', class: 'panel-close', 'aria-label': 'Close', onclick: closeHotspot }, '×'),
      el('h4', null, h.label),
      ...paragraphs(h.text || '')
    );
    pop.hidden = false;
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    pop.returnTo = btn;
    const place = () => {
      if (pop.hidden) return;
      const r = btn.getBoundingClientRect();
      const area = viewRect(isPanelOpen()); // keep the note out from under the panel
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      let left = r.right + 10;
      if (left + pw > area.x1 - 10) left = r.left - pw - 10;
      if (left < area.x0 + 10) left = area.x0 + 10;
      let top = r.top - 12;
      if (top + ph > area.y1 - 10) top = area.y1 - 10 - ph;
      if (top < area.y0 + 8) top = area.y0 + 8;
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      hotspotFollow = requestAnimationFrame(place);
    };
    place();
    pop.querySelector('h4').setAttribute('tabindex', '-1');
    pop.querySelector('h4').focus({ preventScroll: true });
  }

  function focusAfterScene() {
    const btn = els.panel.querySelector('.scene-section .btn');
    if (isPanelOpen() && btn) btn.focus({ preventScroll: true });
    else if (isPanelOpen()) focusPanel();
    else focusNextMarker();
  }

  function closeHotspot() {
    const pop = els.scenePopover;
    if (hotspotFollow) cancelAnimationFrame(hotspotFollow);
    hotspotFollow = null;
    if (pop.hidden) return;
    pop.hidden = true;
    const open = els.sceneHotspots.querySelector('.hotspot.is-open');
    if (open) { open.classList.remove('is-open'); open.setAttribute('aria-expanded', 'false'); }
    if (pop.returnTo && document.contains(pop.returnTo)) pop.returnTo.focus({ preventScroll: true });
    pop.returnTo = null;
  }

  async function enterScene(stop, token) {
    const sc = stop.scene;
    if (!sc || state.scene === stop) return;
    preloadScene(stop);
    state.scene = stop;
    const ok = await sc.loader;
    if (token !== state.nav || state.scene !== stop) return;
    if (!ok) { state.scene = null; return; }

    const scene = els.scene;
    els.sceneImg.src = sc.image;
    els.sceneImg.alt = sc.alt || '';
    renderHotspots(stop);
    renderSceneCaption(stop);
    closeHotspot();
    if (mobile.matches) els.panel.style.setProperty('--sheet-h', '34dvh');
    layoutScene();

    const [ox, oy] = sceneOrigin(stop);
    scene.style.transformOrigin = `${ox}px ${oy}px`;
    scene.classList.remove('is-leaving', 'is-panning');
    scene.classList.add('is-active');
    const dive = ms(CONFIG.sceneDiveMs);
    if (dive) {
      // Start tiny at the marker, then grow to fill the screen while the map
      // keeps rushing in toward the same point.
      scene.style.transition = 'none';
      scene.style.transform = 'scale(0.04)';
      scene.style.opacity = '0';
      void scene.offsetWidth;
      scene.style.transition = '';
      scene.classList.add('is-diving');
      scene.style.transform = 'scale(1)';
      scene.style.opacity = '1';
      const m = stop.markers[0];
      if (m && m.base) {
        const k = Math.min(state.transform.k * 2.4, state.kMax);
        const t = d3.zoomIdentity.translate(ox - k * m.base[0], oy - k * m.base[1]).scale(k);
        flyTo(state.zoom.constrain()(t, state.zoom.extent()(), state.zoom.translateExtent()), dive);
      }
      await delay(dive);
      if (state.scene !== stop) return;
      scene.classList.remove('is-diving');
    } else {
      scene.style.transform = '';
      scene.style.opacity = '';
    }
    scene.classList.add('is-panning');
    scene.inert = false;
    scene.setAttribute('aria-hidden', 'false');
    els.map.inert = true;
    document.body.classList.add('in-scene');
    layoutScene();
    if (sc.year) setYear(sc.year);
  }

  // Back out of the scene to the map. "fast" is used when the tour moves on
  // to another stop, so the scene just shrinks away while the camera leaves.
  async function leaveScene(fast) {
    const stop = state.scene;
    if (!stop) return;
    state.scene = null;
    closeHotspot();
    const scene = els.scene;
    document.body.classList.remove('in-scene');
    els.map.inert = !state.started;
    scene.inert = true;
    scene.setAttribute('aria-hidden', 'true');
    scene.classList.remove('is-panning', 'is-diving');
    if (mobile.matches) els.panel.style.setProperty('--sheet-h', '');
    setYear(stop.yearLabel);

    const dur = ms(fast ? 450 : CONFIG.sceneLeaveMs);
    if (dur && scene.classList.contains('is-active')) {
      const [ox, oy] = sceneOrigin(stop);
      scene.style.transformOrigin = `${ox}px ${oy}px`;
      scene.classList.add('is-leaving');
      if (fast) scene.style.transition = `transform ${dur}ms ease-in, opacity ${dur * 0.7}ms ease`;
      scene.style.transform = 'scale(0.04)';
      scene.style.opacity = '0';
      if (!fast) flyTo(fitTransform(stopFramePts(stop), stop.zoom, isPanelOpen()), dur);
      await delay(dur);
      if (state.scene) return; // a new scene started meanwhile
    }
    scene.classList.remove('is-active', 'is-leaving');
    scene.style.transition = '';
    scene.style.transform = '';
    scene.style.opacity = '';
    if (!fast) {
      els.sceneImg.removeAttribute('src');
      els.sceneHotspots.replaceChildren();
      focusAfterScene();
    }
  }

  /* ------------------------------------------------------------------------
     Hint bar
     ------------------------------------------------------------------------ */

  function showHint() {
    if (!state.started || isPanelOpen()) return;
    const next = !state.finished && state.stops[state.reached + 1];
    els.hint.replaceChildren();
    if (next) {
      const place = next.place && !isTodo(next.place) ? next.place : (next.markers[0] || {}).name || 'the next stop';
      els.hint.append(state.reached < 0
        ? `Click the glowing marker to begin in ${place} (or press Tab, then Enter).`
        : `Next stop: ${place}. Click the glowing marker.`);
    } else if (!state.finished) {
      els.hint.append('Every stop visited. ',
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: goToFinale }, 'See the whole network →'));
    } else {
      els.hint.append('Click any marker to revisit a stop. ',
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: goToFinale }, 'Closing summary'));
    }
    els.hint.hidden = false;
  }

  function hideHint() {
    els.hint.hidden = true;
  }

  /* ------------------------------------------------------------------------
     Panel
     ------------------------------------------------------------------------ */

  const isPanelOpen = () => els.panel.classList.contains('is-open');

  function openPanel() {
    els.panel.inert = false;
    els.panel.classList.add('is-open');
    document.body.classList.add('panel-open');
    hideHint();
    focusPanel();
    layoutScene();
  }

  function closePanel(opts) {
    const wasOpen = isPanelOpen();
    els.panel.classList.remove('is-open');
    els.panel.inert = true;
    document.body.classList.remove('panel-open');
    layoutScene();
    if (opts && opts.returnFocus && wasOpen) {
      showHint();
      focusNextMarker();
    }
  }

  function focusPanel() {
    const heading = document.getElementById('panel-title');
    if (heading) heading.focus({ preventScroll: true });
  }

  function metaLine(place, dates) {
    const bits = [];
    if (place) bits.push(el('span', { class: 'place' }, place));
    if (dates) bits.push(el('span', { class: 'dates' }, dates));
    return bits.length ? el('p', { class: 'panel-meta' }, bits) : null;
  }

  function figures(images) {
    const list = asArray(images).filter((img) => img && img.src);
    if (!list.length) return null;
    return el('div', { class: 'figures' }, list.map((img) => {
      if (!img.alt) console.warn(`stops.json: image "${img.src}" has no "alt" text.`);
      const image = el('img', { src: img.src, alt: img.alt || '', loading: 'lazy', decoding: 'async' });
      image.addEventListener('error', () => {
        image.replaceWith(el('div', { class: 'img-missing' }, `Image not found: ${img.src}`));
      });
      const creditBits = [];
      if (img.credit) creditBits.push('Credit: ', text(img.credit));
      if (img.license) creditBits.push(creditBits.length ? ' · ' : '', 'License: ', text(img.license));
      return el('figure', { class: 'figure' },
        image,
        el('figcaption', null,
          img.caption ? el('span', { class: 'caption' }, img.caption) : null,
          creditBits.length ? el('span', { class: 'credit' }, creditBits) : null
        )
      );
    }));
  }

  function tradedSection(traded) {
    if (!traded) return null;
    const out = asArray(traded.goodsOut);
    const inn = asArray(traded.goodsIn);
    if (!out.length && !inn.length) return null;
    const col = (title, items) => el('div', { class: 'traded-col' },
      el('h4', null, title),
      items.length ? el('ul', null, items.map((g) => el('li', null, g))) : el('p', null, '—'));
    return el('section', { class: 'traded' },
      el('h3', null, 'What was traded'),
      el('div', { class: 'traded-cols' }, col('Goods out', out), col('Goods in', inn)));
  }

  function routesSection(routes) {
    if (!routes.length) return null;
    return el('section', { class: 'routes-here' },
      el('h3', null, routes.length > 1 ? 'Routes shown here' : 'Route shown here'),
      el('ul', { class: 'route-list' }, routes.map((r) => el('li', null,
        el('span', { class: 'route-name' }, r.label || `${r.from.name} → ${r.to.name}`),
        el('span', { class: `route-type ${r.type}` }, r.type === 'ocean' ? 'by sea' : 'overland'),
        r.goods.length ? el('div', null, 'Carried: ', text(r.goods.join('; '))) : null
      )))
    );
  }

  function sceneSection(stop) {
    const sc = stop.scene;
    if (!sc) return null;
    const creditBits = [];
    if (sc.credit) creditBits.push('Credit: ', text(sc.credit));
    if (sc.license) creditBits.push(creditBits.length ? ' · ' : '', 'License: ', text(sc.license));
    if (sc.sourceUrl) creditBits.push(' ', el('a', { href: sc.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source'));
    return el('section', { class: 'scene-section' },
      el('h3', null, 'The scene'),
      sc.caption ? el('p', null, sc.caption) : null,
      creditBits.length ? el('p', { class: 'credit' }, creditBits) : null,
      el('button', {
        type: 'button',
        class: 'btn btn-secondary',
        onclick: () => { if (state.scene !== stop) enterScene(stop, state.nav); }
      }, 'View the scene →'));
  }

  function callout(title, body) {
    if (!body) return null;
    return el('aside', { class: 'callout' }, el('h3', null, title), paragraphs(body));
  }

  function sourceItem(src) {
    if (typeof src === 'string') return el('li', null, src);
    if (!src) return null;
    return el('li', null,
      text(src.citation || src.title || ''),
      src.url ? [' ', el('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, 'Link')] : null);
  }

  function sourcesSection(title, sources) {
    const list = asArray(sources);
    if (!list.length) return null;
    return el('section', { class: 'stop-sources' },
      el('h3', null, title),
      el('ol', { class: 'source-list' }, list.map(sourceItem)));
  }

  function setFooter(...buttons) {
    els.panelFooter.replaceChildren(...buttons.filter(Boolean));
  }

  function setPanelBody(...parts) {
    els.panelBody.replaceChildren(...parts.flat().filter(Boolean));
    els.panelBody.scrollTop = 0;
  }

  function renderStopPanel(stop) {
    const n = state.stops.length;
    const i = stop.index;
    setPanelBody(
      el('p', { class: 'panel-kicker' }, `Stop ${i + 1} of ${n}`),
      el('h2', { class: 'panel-title', id: 'panel-title', tabindex: '-1' }, stop.title || stop.place || ''),
      metaLine(stop.place, stop.dateRange),
      el('div', { class: 'panel-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'narrative' }, paragraphs(stop.narrative)),
      figures(stop.images),
      sceneSection(stop),
      tradedSection(stop.traded),
      routesSection(routesFor(stop)),
      callout('Connection to globalization', stop.globalization),
      sourcesSection('Sources for this stop', stop.sources)
    );

    const prev = i > 0
      ? el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => goToStop(i - 1) }, '← Previous')
      : null;
    let next;
    if (i < n - 1) {
      const target = state.stops[i + 1];
      next = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        'aria-label': `Next stop: ${target.place || target.title || ''}`,
        onclick: () => goToStop(i + 1)
      }, 'Next stop →');
    } else {
      next = el('button', { type: 'button', class: 'btn btn-primary', onclick: goToFinale }, 'See the whole network →');
    }
    setFooter(prev, next);
  }

  function renderConclusionPanel() {
    const c = state.data.conclusion || {};
    setPanelBody(
      el('p', { class: 'panel-kicker' }, 'Journey’s end'),
      el('h2', { class: 'panel-title', id: 'panel-title', tabindex: '-1' }, c.title || 'The whole network'),
      metaLine(null, c.yearLabel),
      el('div', { class: 'panel-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'narrative' }, paragraphs(c.narrative)),
      figures(c.images),
      callout('Our thesis', c.thesis),
      el('section', null,
        el('h3', null, 'Revisit a stop'),
        el('ol', { class: 'source-list' }, state.stops.map((s) => el('li', null,
          el('a', {
            href: '#',
            onclick: (e) => { e.preventDefault(); goToStop(s.index); }
          }, s.place || s.title || `Stop ${s.index + 1}`))))),
      sourcesSection('Sources', c.sources)
    );
    setFooter(
      el('button', { type: 'button', class: 'btn btn-secondary', onclick: restart }, '↺ Start over'),
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: () => { closePanel({ returnFocus: true }); }
      }, 'Explore the map')
    );
  }

  /* ------------------------------------------------------------------------
     Title card and Sources dialog
     ------------------------------------------------------------------------ */

  function fillTitleCard(intro) {
    const title = intro.title || 'Cacao & Empire';
    document.title = title;
    els.titleTitle.replaceChildren(text(title));
    els.topbarTitle.replaceChildren(text(title));
    els.titleSubtitle.replaceChildren(text(intro.subtitle || ''));
    els.titleQuestion.replaceChildren(text(intro.question || ''));
    els.titleAuthors.replaceChildren(text(intro.authors || ''));
    els.titleSubtitle.hidden = !intro.subtitle;
    els.titleQuestion.hidden = !intro.question;
    els.titleAuthors.hidden = !intro.authors;
    if (intro.buttonLabel) els.begin.textContent = intro.buttonLabel;
    if (intro.yearLabel) els.year.textContent = intro.yearLabel;
  }

  function start() {
    state.started = true;
    els.map.inert = false;
    els.topbar.inert = false;
    els.titleCard.classList.add('is-leaving');
    setTimeout(() => { els.titleCard.hidden = true; }, ms(900));
    updateMarkers();
    showHint();
    focusNextMarker();
    prefetchAhead();
  }

  function buildSources() {
    const body = els.sourcesBody;
    body.replaceChildren();

    state.stops.forEach((stop) => {
      const sources = asArray(stop.sources);
      const images = asArray(stop.images).filter((img) => img && img.src);
      body.append(el('h3', null, `${stop.index + 1}. `, text(stop.place || stop.title || '')));
      if (sources.length) {
        body.append(el('h4', null, 'Sources'), el('ol', { class: 'source-list' }, sources.map(sourceItem)));
      }
      if (stop.scene) images.push({ ...stop.scene, src: stop.scene.image, caption: `Scene: ${stop.scene.title || stop.scene.image}` });
      if (images.length) {
        body.append(el('h4', null, 'Image credits'), el('ul', { class: 'source-list' }, images.map((img) =>
          el('li', null,
            text(img.caption || img.alt || img.src), ': ',
            text(img.credit || 'credit missing'), ' (', text(img.license || 'license missing'), ')',
            img.sourceUrl ? [' ', el('a', { href: img.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source')] : null))));
      }
      if (!sources.length && !images.length) body.append(el('p', null, 'No sources listed yet.'));
    });

    const c = state.data.conclusion || {};
    const cImages = asArray(c.images).filter((img) => img && img.src);
    if (asArray(c.sources).length || cImages.length) {
      body.append(el('h3', null, 'Conclusion'));
      if (asArray(c.sources).length) body.append(el('ol', { class: 'source-list' }, asArray(c.sources).map(sourceItem)));
      if (cImages.length) {
        body.append(el('h4', null, 'Image credits'), el('ul', { class: 'source-list' }, cImages.map((img) =>
          el('li', null, text(img.caption || img.src), ': ', text(img.credit || ''), ' (', text(img.license || ''), ')'))));
      }
    }

    const general = asArray(state.data.generalSources);
    if (general.length) {
      body.append(el('h3', null, 'General sources'), el('ol', { class: 'source-list' }, general.map(sourceItem)));
    }

    body.append(el('h3', null, 'Map data'), el('ul', { class: 'source-list' },
      el('li', null, 'Coastlines, rivers and borders: Natural Earth (public domain), via the world-atlas package. Modern borders are shown only for reference.'),
      el('li', null, 'Terrain shading and sea depth: Terrain Tiles (Mapzen) on AWS Open Data, built from SRTM, GMTED2010, ETOPO1 and other public elevation data. Full list of data sources: github.com/tilezen/joerd/blob/master/docs/attribution.md'),
      el('li', null, 'Place and river names on the map are modern names, shown only to help find your way around.'),
      el('li', null, 'Map made with D3.js.')));
  }

  /* ------------------------------------------------------------------------
     Mobile bottom sheet: drag the handle to resize, tap to expand/shrink
     ------------------------------------------------------------------------ */

  function bindSheetDrag() {
    const handle = els.panelHandle;
    const panel = els.panel;
    const snaps = [0.35, 0.58, 0.88];
    let startY = 0;
    let startH = 0;
    let dragging = false;
    let moved = false;
    let suppressClick = false;

    const setHeight = (value) => panel.style.setProperty('--sheet-h', value);

    handle.addEventListener('pointerdown', (e) => {
      if (!mobile.matches) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startH = panel.offsetHeight;
      handle.setPointerCapture(e.pointerId);
      panel.classList.add('is-dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 5) moved = true;
      setHeight(`${clamp(startH - dy, 80, window.innerHeight - 70)}px`);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      if (!moved) return;
      suppressClick = true;
      const frac = panel.offsetHeight / window.innerHeight;
      if (frac < 0.2) {
        setHeight('');
        closePanel({ returnFocus: true });
        return;
      }
      const nearest = snaps.reduce((a, b) => (Math.abs(b - frac) < Math.abs(a - frac) ? b : a));
      setHeight(`${nearest * 100}dvh`);
      setTimeout(layoutScene, 50);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      const frac = panel.offsetHeight / window.innerHeight;
      setHeight(frac > 0.7 ? '' : '88dvh');
      setTimeout(layoutScene, 50);
    });
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */

  function bindUI() {
    els.begin.addEventListener('click', start);
    els.panelClose.addEventListener('click', () => closePanel({ returnFocus: true }));
    els.overviewBtn.addEventListener('click', goToOverview);

    els.sourcesBtn.addEventListener('click', () => els.sourcesDialog.showModal());
    els.sourcesClose.addEventListener('click', () => els.sourcesDialog.close());
    els.sourcesDialog.addEventListener('click', (e) => {
      if (e.target === els.sourcesDialog) els.sourcesDialog.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || els.sourcesDialog.open) return;
      if (!els.scenePopover.hidden) closeHotspot();
      else if (state.scene) leaveScene(false);
      else if (isPanelOpen()) closePanel({ returnFocus: true });
    });
    els.sceneBack.addEventListener('click', () => leaveScene(false));
    els.scene.addEventListener('click', (e) => {
      if (!els.scenePopover.hidden && !els.scenePopover.contains(e.target) && !e.target.closest('.hotspot')) closeHotspot();
    });

    bindSheetDrag();

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
  }

  init();
})();
