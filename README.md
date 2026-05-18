# oglap-ggp-node

> Node.js SDK for the **OGLAP** protocol — Offline Grid Location Addressing for the Guinea Grid Profile (GGP).

🇫🇷 **Version française** → [README.fr.md](README.fr.md)

Convert GPS coordinates into compact, deterministic, human-readable address codes (e.g. `GN-CON-QYTC-B0B1-2282`) and back — fully offline, with no external API. Designed for regions where formal postal addressing is sparse or unreliable.

[![npm version](https://img.shields.io/npm/v/oglap-ggp-node.svg)](https://www.npmjs.com/package/oglap-ggp-node)
[![license](https://img.shields.io/npm/l/oglap-ggp-node.svg)](LICENSE)

---

## Table of contents

- [Why OGLAP?](#why-oglap)
- [The LAP code format](#the-lap-code-format)
- [Installation](#installation)
- [Initialization (required)](#initialization-required)
- [Core API](#core-api)
  - [`coordinatesToLap` — encode GPS → LAP](#coordinatestolap--encode-gps--lap)
  - [`lapToCoordinates` — decode LAP → GPS](#laptocoordinates--decode-lap--gps)
  - [`parseLapCode` — break a code into components](#parselapcode--break-a-code-into-components)
  - [`validateLapCode` — validate a code](#validatelapcode--validate-a-code)
  - [`getPlaceByLapCode` — look up the underlying place](#getplacebylapcode--look-up-the-underlying-place)
  - [`bboxFromGeometry` & `centroidFromBbox`](#bboxfromgeometry--centroidfrombbox)
  - [State & metadata helpers](#state--metadata-helpers)
- [Data files & caching](#data-files--caching)
- [End-to-end example](#end-to-end-example)
- [Browser usage](#browser-usage)
- [Performance notes](#performance-notes)
- [Testing](#testing)
- [Versioning & compatibility](#versioning--compatibility)
- [License](#license)

---

## Why OGLAP?

In many parts of the world, conventional street addresses don't exist or aren't reliable enough to route deliveries, dispatch emergency services, or share a location with a friend. OGLAP solves this by carving the country into a deterministic grid and giving every ~1 m × 1 m cell a short, copy-pasteable code.

- **Offline-first** — works without network once reference data is cached.
- **Deterministic** — same coordinates always produce the same code; same code always decodes back to the same point.
- **Hierarchical** — the prefix reveals the country / region / zone, so the code is meaningful even when truncated.
- **Human-readable** — uppercase A–Z and digits only, no ambiguous characters.

---

## The LAP code format

A LAP code encodes a location at four hierarchical levels. Two grid strategies coexist:

### Local grid (5 segments — used inside named administrative zones)

```
GN  - CON  - QYTC - B0B1 - 2282
│      │      │      │      └─ Microspot   — 4 digits, ~1 m offset inside the macroblock
│      │      │      └─────── Macroblock   — 4 chars [A–J][0–9][A–J][0–9], ~100 m cell inside the zone
│      │      └────────────── Zone         — 4 chars, immediate admin level ≥8 (e.g. QYTC for Yattaya-Fossedè)
│      └───────────────────── Region       — 3 chars, immediate admin level 4 or 6 (e.g. CON for Conakry)
└──────────────────────────── Country      — ISO alpha-2 (e.g. GN for Guinea)
```

### National grid (4 segments — fallback for rural areas without admin level ≥8 coverage)

```
GN  - NZE  - AABCDE - 4250
│      │      │        └─ Microspot   — 4 digits, ~1 m offset
│      │      └────────── Macroblock   — 6 letters, country-wide kilometric grid
│      └──────────────── Region       — 3 chars (e.g. NZE for Nzérékoré)
└─────────────────────── Country      — ISO alpha-2
```

The SDK transparently picks the right grid based on whether the input coordinate falls inside a named admin level ≥8 polygon.

---

## Installation

```bash
npm install oglap-ggp-node
# or
pnpm add oglap-ggp-node
# or
yarn add oglap-ggp-node
```

Requires **Node.js ≥ 18** (uses native `fetch`, ES Modules, `WeakMap`).

The package is published as an **ES Module** — use `import` syntax. If you need CommonJS, use dynamic `import()`.

---

## Initialization (required)

You must call `initOglap()` **once** at application startup before any encoding/decoding function. On first run it downloads three JSON files from the OGLAP CDN (`https://s3.guinee.io/oglap/ggp/latest/`) and caches them under `oglap-data/<version>/`. Subsequent runs load from the cache instantly.

```js
import { initOglap } from 'oglap-ggp-node';

const report = await initOglap({
  version: 'latest',          // 'latest' (default) or a pinned dataset version
  dataDir: 'oglap-data',      // local cache directory (default: 'oglap-data')
  forceDownload: false,       // re-download even if cache is present
  onProgress({ label, status, percent, step, totalSteps }) {
    // status ∈ 'downloading' | 'cached' | 'slow' | 'validating' | 'done' | 'error'
    if (status === 'downloading') {
      process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label}: ${percent}%`);
    } else if (status === 'cached') {
      console.log(`⚡ [${step}/${totalSteps}] ${label}: loaded from cache`);
    } else if (status === 'done') {
      console.log(`✓ [${step}/${totalSteps}] ${label}: ready`);
    } else if (status === 'error') {
      console.error(`✗ [${step}/${totalSteps}] ${label}: error`);
    }
  },
});

if (!report.ok) throw new Error(`OGLAP init failed: ${report.error}`);
```

### Init report shape

| Field         | Type                  | Description                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `ok`          | `boolean`             | `true` if initialization succeeded                                          |
| `countryCode` | `string \| null`      | Active country code, e.g. `"GN"`                                            |
| `countryName` | `string \| null`      | Display name, e.g. `"Guinea"`                                               |
| `bounds`      | `number[][] \| null`  | `[[swLat, swLon], [neLat, neLon]]`                                          |
| `checks`      | `Array<Check>`        | Per-step validation results — each `{ id, status, message }`                |
| `error`       | `string \| null`      | First fatal error message if `!ok`                                          |
| `dataDir`     | `string`              | Resolved local cache directory                                              |
| `dataLoaded`  | `{ ok, count, message }` | Places loaded into the in-memory engine                                  |

### Direct mode (bring your own data)

If you already have the JSON files in memory (e.g. fetched yourself or bundled with the app), skip the download:

```js
import { initOglap } from 'oglap-ggp-node';
import profile from './my-profile.json' with { type: 'json' };
import localities from './my-localities.json' with { type: 'json' };
import places from './my-places.json' with { type: 'json' };
import { loadOglap } from 'oglap-ggp-node';

const report = await initOglap(profile, localities);
if (!report.ok) throw new Error(report.error);

loadOglap(places); // load the places database into the engine
```

---

## Core API

All functions below are **synchronous** (no network, pure in-memory computation) except `initOglap`.

### `coordinatesToLap` — encode GPS → LAP

```js
import { coordinatesToLap } from 'oglap-ggp-node';

const result = coordinatesToLap(9.5370, -13.6773); // lat, lon

console.log(result.lapCode);        // 'GN-CON-QYTC-B0B1-2282'
console.log(result.humanAddress);   // 'B0B1-2282, Yattaya Fossedè, Conakry, Guinea'
console.log(result.isNationalGrid); // false
```

Returns `null` if the coordinates fall outside the country (verified via 3-layer check: bounding box → country polygon → admin polygon).

**Result shape:**

| Field            | Type        | Description                                                            |
| ---------------- | ----------- | ---------------------------------------------------------------------- |
| `lapCode`        | `string`    | Full code, e.g. `"GN-CON-QYTC-B0B1-2282"`                              |
| `country`        | `string`    | Country code, e.g. `"GN"`                                              |
| `admin_level_2`  | `string`    | Region code, e.g. `"CON"`                                              |
| `admin_level_3`  | `string\|null` | Zone code (null when national-grid)                                 |
| `macroblock`     | `string`    | Macroblock segment                                                     |
| `microspot`      | `string`    | Microspot segment                                                      |
| `isNationalGrid` | `boolean`   | `true` if national-grid (rural) was used                               |
| `displayName`    | `string`    | Reverse-geocoded display name                                          |
| `humanAddress`   | `string`    | Comma-joined human-readable address                                    |
| `address`        | `object`    | Structured address components                                          |
| `originLat`      | `number`    | Latitude origin of the macroblock bounding box                         |
| `originLon`      | `number`    | Longitude origin of the macroblock bounding box                        |
| `pcode`          | `string[]`  | UNOCHA P-codes for the matched admin units (when available)            |

### `lapToCoordinates` — decode LAP → GPS

```js
import { lapToCoordinates } from 'oglap-ggp-node';

const coords = lapToCoordinates('GN-CON-QYTC-B0B1-2282');
// { lat: 9.5370, lon: -13.6773 }

// The country prefix is optional:
lapToCoordinates('CON-QYTC-B0B1-2282'); // same result
```

Returns `null` if the code is structurally invalid or references an unknown region/zone.

### `parseLapCode` — break a code into components

```js
import { parseLapCode } from 'oglap-ggp-node';

const parsed = parseLapCode('GN-CON-QYTC-B0B1-2282');
// {
//   admin_level_2_Iso:  'GN-C',   // ISO key of the region (CON resolves to its OSM-style key)
//   admin_level_3_code: 'QYTC',   // zone short code
//   macroblock:         'B0B1',
//   microspot:          '2282',
//   isNationalGrid:     false,
// }

// Partial codes also parse:
parseLapCode('GN-CON-QYTC'); // region + zone only — returns { admin_level_2_Iso, admin_level_3_code }
parseLapCode('QYTC');        // zone only          — returns { admin_level_3_code }
```

> **Note:** the country code (`GN`) is *not* a field on the parsed object — it's implicit and you can read it with `getCountryCode()`. The region segment (e.g. `CON`) is exposed as `admin_level_2_Iso` (the OSM-style ISO key, e.g. `GN-C`), not as the 3-letter LAP short code. Use `getOglapPrefectures()` to map between the two if you need the short code.

### `validateLapCode` — validate a code

```js
import { validateLapCode } from 'oglap-ggp-node';

validateLapCode('GN-CON-QYTC-B0B1-2282'); // → null  (valid)
validateLapCode('GN-XXX-INVALID');        // → 'Unknown region code "XXX"'
```

Returns `null` for valid codes, or an English error message string for invalid ones.

### `getPlaceByLapCode` — look up the underlying place

```js
import { getPlaceByLapCode } from 'oglap-ggp-node';

const resolved = getPlaceByLapCode('GN-CON-QYTC-B0B1-2282');
// {
//   place: { place_id, address: { ... }, geojson: { ... }, display_name, ... },
//   parsed: { admin_level_2_Iso, admin_level_3_code, ... },
//   // originLat, originLon are present only when isNationalGrid is true
// }

const name = resolved.place.address.village
          ?? resolved.place.address.town
          ?? resolved.place.address.city
          ?? resolved.place.display_name;
```

For national-grid codes, `place` is `null` (they do not bind to a named place) and the response carries `originLat`/`originLon` set to the country's south-west origin point — usable as a coarse fallback location.

### `bboxFromGeometry` & `centroidFromBbox`

Geometry helpers for working with GeoJSON shapes the SDK loads internally.

```js
import { bboxFromGeometry, centroidFromBbox } from 'oglap-ggp-node';

const geometry = {
  type: 'Polygon',
  coordinates: [[[-13.70, 9.50], [-13.65, 9.50], [-13.65, 9.55], [-13.70, 9.55], [-13.70, 9.50]]],
};

const bbox = bboxFromGeometry(geometry);   // [minLat, maxLat, minLon, maxLon]
const center = centroidFromBbox(bbox);     // [lat, lon]
```

### State & metadata helpers

```js
import {
  checkOglap,
  getPackageVersion,
  getCountryCode,
  getCountrySW,
  getCountryProfile,
  getOglapPrefectures,
  getOglapPlaces,
} from 'oglap-ggp-node';

checkOglap();                // → init report (the same shape initOglap returned)
getPackageVersion();         // → '0.1.2'
getCountryCode();            // → 'GN'
getCountrySW();              // → [7.19, -15.37]
getCountryProfile();         // → the loaded country profile object
getOglapPrefectures();       // → { 'GN.CON': 'CON', 'GN.NZE': 'NZE', ... }
getOglapPlaces();            // → Place[]   (the loaded places array — use sparingly, large)
```

---

## Data files & caching

The SDK loads three reference files from `https://s3.guinee.io/oglap/ggp/<version>/`:

| File                                | Size  | Description                                                              |
| ----------------------------------- | ----- | ------------------------------------------------------------------------ |
| `gn_oglap_country_profile.json`     | ~3 KB | Grid parameters, admin codes, naming rules, compatibility range          |
| `gn_localities_naming.json`         | ~300 KB | Naming table for regions / prefectures / zones                         |
| `gn_full.json`                      | ~37 MB | Places database with GeoJSON polygons                                   |

By default they are cached to `./oglap-data/latest/`. The cache directory is **gitignored** in this repo and should be gitignored in yours too — these files are reproducibly downloaded by `initOglap()`.

The first call to `initOglap()` will display a progress callback while downloading; subsequent calls in the same process or across restarts hit the cache (`status === 'cached'`).

To force a re-download (e.g. after a dataset update is published):

```js
await initOglap({ forceDownload: true });
```

---

## End-to-end example

```js
import {
  initOglap,
  coordinatesToLap,
  lapToCoordinates,
  validateLapCode,
  getPlaceByLapCode,
} from 'oglap-ggp-node';

class LocationService {
  static #ready = false;

  static async init() {
    if (this.#ready) return;
    const report = await initOglap({
      onProgress({ label, status, percent, step, totalSteps }) {
        if (status === 'downloading') process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label}: ${percent}%`);
        if (status === 'cached')      console.log(`⚡ [${step}/${totalSteps}] ${label}: cached`);
        if (status === 'done')        console.log(`✓ [${step}/${totalSteps}] ${label}: ready`);
      },
    });
    if (!report.ok) throw new Error(`OGLAP init failed: ${report.error}`);
    this.#ready = true;
  }

  /** Encode the user's GPS position into a LAP code. */
  static encode(lat, lon) {
    return coordinatesToLap(lat, lon)?.lapCode ?? null;
  }

  /** Decode a LAP code into a {lat, lon} pair. */
  static decode(code) {
    return lapToCoordinates(code); // null if invalid
  }

  /** Validate user-typed input. Returns null if valid, an error string otherwise. */
  static validate(code) {
    return validateLapCode(code);
  }

  /** Resolve a LAP code into a human-readable place card. */
  static resolve(code) {
    const r = getPlaceByLapCode(code);
    if (!r?.place) return null;
    const a = r.place.address ?? {};
    return {
      name:      a.village ?? a.town ?? a.city ?? r.place.display_name,
      adminCode: r.parsed.admin_level_3_code,
      originLat: r.originLat,
      originLon: r.originLon,
    };
  }
}

await LocationService.init();

const code = LocationService.encode(9.660147, -13.588009);
console.log(code);                       // 'GN-CON-QYTC-B0B1-2282'
console.log(LocationService.decode(code)); // { lat: ~9.660, lon: ~-13.588 }
console.log(LocationService.validate(code)); // null  (valid)
console.log(LocationService.resolve(code));  // { name: 'Yattaya Fossedè', ... }
```

---

## Browser usage

The SDK is browser-compatible if you bring your own data (the bundled `_download.js` path uses Node's `fs`). Use direct mode:

```js
import { initOglap, loadOglap, coordinatesToLap } from 'oglap-ggp-node';

const [profile, localities, places] = await Promise.all([
  fetch('/oglap/gn_oglap_country_profile.json').then(r => r.json()),
  fetch('/oglap/gn_localities_naming.json').then(r => r.json()),
  fetch('/oglap/gn_full.json').then(r => r.json()),
]);

const report = await initOglap(profile, localities);
if (!report.ok) throw new Error(report.error);
loadOglap(places);

const code = coordinatesToLap(9.5370, -13.6773).lapCode;
```

> ⚠️ The `gn_full.json` places database is ~37 MB uncompressed. For browser use, serve it pre-gzipped and consider lazy-loading after first paint.

---

## Performance notes

- **R-tree spatial index** — `coordinatesToLap` uses a [Flatbush](https://github.com/mourner/flatbush) R-tree built once at `loadOglap()` time. Reverse-geocoding a single coordinate is O(log N) candidate lookup + a small polygon-in-polygon check.
- **Non-mutating geometry caches** — bbox and area calculations are memoized via `WeakMap` keyed on the input place object. The SDK never mutates inputs.
- **Bounded regex** — all regex scans run against bounded, sanitized strings — no ReDoS exposure on malformed user input.
- **Serverless-friendly** — pure in-memory state, no globals leak between requests as long as you reuse the module across invocations.

---

## Testing

The repo ships two test scripts:

```bash
npm test                       # runs both test.js and determinism.test.js
node test.js                   # functional test — encode, decode, parse, validate, round-trips
node determinism.test.js       # exhaustive determinism & stability checks
```

Both reuse the cached `oglap-data/` if present.

---

## Versioning & compatibility

The SDK declares a compatibility range with the country-profile dataset via a semver caret. The currently published `gn_oglap_country_profile.json` requires the SDK to satisfy `^0.1.0` — so this package follows the 0.1.x line. Major bumps in the dataset schema will be accompanied by a major bump here.

You can inspect the loaded compatibility range at runtime:

```js
import { getCountryProfile } from 'oglap-ggp-node';
console.log(getCountryProfile().compatibility);
// { oglap_package_range: '^0.1.0', dataset_versions: ['2026-02-21T14:13:02.414Z'] }
```

If `initOglap()` fails with a compatibility error, either downgrade the SDK or update your cached dataset (`forceDownload: true`).

---

## License

ISC — see [LICENSE](LICENSE).

Issues and contributions: <https://github.com/Guinee-IO/oglap-ggp-node-js/issues>
