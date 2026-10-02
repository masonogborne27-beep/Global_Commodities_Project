# Cacao & Empire: An Interactive Map

An animated world map that follows cacao and chocolate through the French empire, 1450–1800. It is built around one question:

> How did early modern empires help create and shape a globalized economy?

Our case study is French cacao production in Martinique. The viewer follows six stops in order: Martinique → West Africa → Nantes & Bordeaux → Bayonne → Paris & Versailles → the rest of Europe. At the end, the map zooms out to show the whole trade network.

It is a plain HTML/CSS/JavaScript site with no build step, so it runs on GitHub Pages as-is.

```
index.html          page structure (title card, map, panel, Sources dialog)
css/style.css       all styling (colors are variables at the top)
js/main.js          map drawing and animation; you shouldn't need to edit this
data/stops.json     ALL historical content: text, dates, coordinates, images, sources
data/routes.json    the trade routes drawn between places
assets/images/      images used in the panels
```

---

## Editing the content (`data/stops.json`)

**All the history lives in `data/stops.json`.** The code shows whatever is in that file, so you can rewrite everything without touching any code.

Any text that starts with `TODO` shows up **highlighted in yellow** on the site. That way you can see what still needs writing. Replace every `TODO` before you present.

### The file has four parts

| Part | What it controls |
|---|---|
| `intro` | The opening title card: `title`, `subtitle`, `question`, `authors`, `buttonLabel`, and the starting `yearLabel`. |
| `stops` | The six stops, in order. |
| `conclusion` | The closing panel shown with the full network: `title`, `yearLabel`, `narrative`, `thesis`, `sources` (and optional `images`). |
| `generalSources` | Sources for the whole project that don't belong to one stop. |

### One stop, field by field

```json
{
  "id": "martinique",              // short unique name, no spaces. routes.json refers to it
  "order": 1,                      // position in the tour
  "title": "…",                    // big heading in the panel
  "place": "Saint-Pierre, Martinique",
  "dateRange": "…",                // e.g. "1660–1750"
  "yearLabel": "c. 1660",          // shown in the Year badge at the top left
  "coordinates": [-61.176, 14.743],
  "zoom": 10,                      // how close the map zooms (bigger = closer)
  "markers": [                     // the clickable dot(s) for this stop
    { "id": "saint-pierre", "name": "Saint-Pierre",
      "coordinates": [-61.176, 14.743], "labelPosition": "right" }
  ],
  "narrative": ["Paragraph 1", "Paragraph 2", "Paragraph 3"],
  "images": [
    { "src": "assets/images/my-picture.jpg",
      "alt": "Describe what the picture shows, for blind users",
      "caption": "What the viewer should notice",
      "credit": "Artist, title, collection or museum",
      "license": "Public domain" }
  ],
  "traded": { "goodsOut": ["…"], "goodsIn": ["…"] },
  "globalization": "The 'Connection to globalization' box",
  "sources": [
    { "citation": "Author. Title. Publisher, Year.", "url": "https://…" }
  ]
}
```

(The `//` notes are only explanations for this README. **Don't put comments in the real JSON file**, because JSON doesn't allow them.)

**Coordinates are `[longitude, latitude]`**, in that order. This is the opposite of how Google Maps shows them. West longitudes and south latitudes are negative. Example: Paris is `[2.352, 48.857]`.

- **Several places in one stop.** Stop 3 (Nantes + Bordeaux), stop 5 (Paris + Versailles) and stop 6 (Madrid, Seville, Amsterdam, London, Turin) each list several `markers`. Clicking any of them opens the same panel. The map zooms to fit all of that stop's markers. To add a place, add another `{ "id", "name", "coordinates" }` entry.
- **`labelPosition`** can be `"left"`, `"right"`, `"top"`, or `"bottom"`. Use it if a place name covers something.
- **`zoom`** is an upper limit. The map zooms in only as far as it can while still fitting that stop's markers and routes. Around `8` shows a region, and `25` shows a few cities.
- **`narrative`** is a list, and each item becomes one paragraph.
- **`sources`** entries can be `{ "citation": "…", "url": "…" }` or just a plain text string. `url` can be left as `""`.
- **To reorder, add, or remove stops**, change the `order` numbers or add or delete whole `{ … }` stop blocks. The "Stop X of Y" counter and the Next buttons update automatically.

### JSON rules that trip people up

- Every piece of text is in **double quotes**: `"like this"`.
- Items are separated by **commas**, but there is **no comma after the last item** in a list or block.
- If the site shows "has a formatting mistake", paste the file into <https://jsonlint.com>. It points to the exact line.
- To use a double quote inside text, write `\"`, or just use curly quotes (“ ”).

---

## Editing the routes (`data/routes.json`)

Each route is one animated line on the map.

```json
{
  "id": "goree-nantes",
  "from": "goree",                  // a marker id, a stop id, or [longitude, latitude]
  "to": "nantes",
  "type": "ocean",                  // "ocean" (dashed line + ship) or "land" (dotted line)
  "goods": ["What this route carried"],
  "revealedAt": "atlantic-ports",   // the stop id where this route draws itself
  "bend": 0.2,                      // curve: 0 = straight, negative = curve the other way
  "via": [[-21, 28], [-12, 45]]     // optional points the line must pass through
}
```

- **Direction matters.** The arrowhead (and the ship) travels from `from` to `to`, so you can show the real direction of trade, even when the tour visits the places in a different order.
- **`revealedAt`** decides which stop draws the route. Several routes can share a stop, and they all draw at once.
- **`via`** lets you steer a sea route around land. The Gorée → Nantes and Gorée → Bordeaux routes use it to go around Spain. When `via` is used, `bend` is ignored.
- **A place that isn't a stop** (for example, a Spanish American port) can be a route end. Write `[longitude, latitude]` instead of a marker id, or `{ "name": "Veracruz", "coordinates": [-96.13, 19.19] }` so its name shows in the panel.
- The goods for each route are listed in that stop's panel under "Routes shown here".

---

## Adding images

1. Find a public-domain or openly licensed image (Wikimedia Commons, or museum open-access collections such as the Met, Rijksmuseum, Getty, or Gallica/BnF). Write down the artist, title, collection, and license.
2. Save it into `assets/images/`. Use a short file name with no spaces, e.g. `saint-pierre-map-1720.jpg`. Big photos load slowly, so try to keep each one under about 500 KB and roughly 1600 px wide.
3. In `data/stops.json`, change that image's `"src"` to `"assets/images/saint-pierre-map-1720.jpg"` and fill in `alt`, `caption`, `credit`, and `license`.
4. Each stop can have 1–3 images. To add one, copy a whole `{ "src": … }` block. To remove one, delete its block (mind the commas!).

The `alt` text is read aloud by screen readers, so describe what is *in* the picture (e.g. "Engraving of enslaved workers drying cacao beans on a plantation terrace"). If a picture can't be found, the panel says "Image not found" with the path, so you can spot typos. Every credit and license also appears in the **Sources** dialog automatically.

You can delete `placeholder-landscape.svg` and `placeholder-portrait.svg` once nothing uses them.

---

## Preview locally

The page loads its data with JavaScript, so **double-clicking `index.html` won't work**. The browser blocks the data files and the page shows an error. Run a tiny local web server instead, from the project folder:

```bash
python3 -m http.server 8000
```

(On Windows it may be `python -m http.server 8000`.) Then open <http://localhost:8000> in your browser. Press Ctrl+C in the terminal to stop the server.

Another option: open the folder in VS Code, install the **Live Server** extension, right-click `index.html`, and choose "Open with Live Server".

After you edit a JSON file, just reload the page. An internet connection is needed, because the map library and outlines load from a CDN.

---

## Publish with GitHub Pages

1. Commit and push the files to GitHub (they must be on the branch you choose below, e.g. `main`).
2. On GitHub, open the repository → **Settings** → **Pages** (left sidebar).
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose the branch (e.g. `main`) and the folder **`/ (root)`**, then click **Save**.
5. Wait a minute or two, then refresh the page. The site's address appears at the top, usually `https://<your-username>.github.io/<repository-name>/`.

Every push to that branch updates the live site automatically within a few minutes. The empty `.nojekyll` file tells GitHub to serve the files exactly as they are.

---

## Using the map

- **Mouse / touch.** Click the glowing marker to go to the next stop. Visited stops stay clickable. You can drag to pan and scroll or pinch to zoom.
- **Keyboard:**
  - **Tab** moves between markers and buttons, and **Enter** opens a stop.
  - **Esc** closes the panel or the Sources dialog.
  - Focus moves into the panel when it opens and returns to the map when it closes.
- **Phones.** The panel becomes a bottom sheet. Drag its handle up or down, or tap it to expand.
- **Reduced motion.** If the computer is set to "reduce motion", the map jumps between stops instead of flying, and routes appear without animation.

## Credits for the tools

Map outlines: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via [world-atlas](https://github.com/topojson/world-atlas). Built with [D3.js](https://d3js.org/). Fonts: IM Fell English and EB Garamond from Google Fonts. Modern country borders are shown faintly for orientation only; they are not the borders of 1450–1800.
