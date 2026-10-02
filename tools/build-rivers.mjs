// Builds data/rivers.json from Natural Earth (public domain) river data.
//
// You do NOT need to run this to edit the site. It is here so the file in
// data/ can be rebuilt (for example, to cover a new region).
//
//   node tools/build-rivers.mjs
//
// Needs Node 18+ (for fetch). Add a region by adding a bounding box to REGIONS:
// [west, south, east, north] in degrees.

import { writeFile } from 'node:fs/promises';

const SOURCES = [
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_europe.geojson'
];

const REGIONS = [
  [-63, 12.5, -59.5, 16.5],   // Martinique and the Windward Islands
  [-19, 12.5, -11, 17],       // Senegal coast and the Gambia
  [-10.5, 36, 10.5, 54.5]     // France, Iberia, the Low Countries, England, northern Italy
];

// Natural Earth uses some local-language names and has a few broken accents;
// show the English names.
const NAME_FIXES = {
  Tejo: 'Tagus', Tajo: 'Tagus', Duero: 'Douro', Rhin: 'Rhine', Rhein: 'Rhine',
  Donau: 'Danube', Schelde: 'Scheldt', Mosel: 'Moselle', 'Sénégal': 'Senegal',
  'Le gave de Pau': 'Gave de Pau', Rhne: 'Rhône', Zncara: 'Záncara', Sane: 'Saône'
};

const round = (n) => Math.round(n * 1000) / 1000;

function walk(coords, fn) {
  if (typeof coords[0] === 'number') return fn(coords);
  coords.forEach((c) => walk(c, fn));
}

function bbox(geometry) {
  let w = 180, s = 90, e = -180, n = -90;
  walk(geometry.coordinates, ([x, y]) => {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  });
  return [w, s, e, n];
}

const touches = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function roundCoords(coords) {
  return typeof coords[0] === 'number' ? [round(coords[0]), round(coords[1])] : coords.map(roundCoords);
}

const seen = new Set();
const features = [];

for (const url of SOURCES) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const json = await res.json();
  for (const f of json.features) {
    if (!f.geometry) continue;
    const box = bbox(f.geometry);
    if (!REGIONS.some((r) => touches(box, r))) continue;
    const p = f.properties;
    const key = `${p.name || ''}|${box.map(round).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    features.push({
      type: 'Feature',
      properties: {
        name: p.name ? (NAME_FIXES[p.name] || p.name) : null,
        min_zoom: p.min_zoom ?? 6,
        min_label: p.min_label ?? (p.min_zoom ?? 6) + 1
      },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) }
    });
  }
}

await writeFile('data/rivers.json', JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Wrote data/rivers.json with ${features.length} rivers.`);
