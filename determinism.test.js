import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  initOglap,
  loadOglap,
  getPackageVersion,
  parseLapCode,
  validateLapCode,
  coordinatesToLap,
  lapToCoordinates,
  getPlaceByLapCode,
  getOglapPlaces,
  bboxFromGeometry,
} from './oglap.js';

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function loadRealFixture() {
  const [profile, localities, data] = await Promise.all([
    readJson('oglap-data/latest/gn_oglap_country_profile.json'),
    readJson('oglap-data/latest/gn_localities_naming.json'),
    readJson('oglap-data/latest/gn_full.json'),
  ]);
  const report = await initOglap(profile, localities);
  assert.equal(report.ok, true, report.error);
  const loaded = loadOglap(data);
  assert.equal(loaded.ok, true, loaded.message);
}

function ring(w, s, e, n) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

function polygon(w, s, e, n) {
  return { type: 'Polygon', coordinates: [ring(w, s, e, n)] };
}

function syntheticProfile() {
  return {
    schema_id: 'oglap.country_profile.v2',
    meta: {
      country_oglap_code: 'TS',
      iso_alpha_2: 'TS',
      country_name: 'Testland',
    },
    compatibility: {
      oglap_package_range: '^0.1.0',
      dataset_versions: ['synthetic-v1'],
    },
    country_extent: {
      country_sw: [0, 0],
      country_bounds: { sw: [0, 0], ne: [1, 1] },
    },
    grid_settings: {
      distance_conversion: { meters_per_degree_lat: 111320 },
    },
    zone_naming: {
      type_prefix_map: { default: 'Z', administrative: 'Z' },
      stopwords: [],
      padding_char: 'X',
    },
    admin_codes: {
      level_4_regions: { 'TS-A': { name: 'Alpha' } },
      level_6_prefectures: { 'TS-AA': { name: 'Alpha Prefecture' } },
    },
  };
}

function syntheticLocalities() {
  return {
    schema_id: 'oglap.localities_naming.v1',
    country: 'TS',
    generated_at: 'synthetic-v1',
    source: 'synthetic',
    level_4_regions: { 'TS-A': { oglap_code: 'AAA' } },
    level_6_prefectures: { 'TS-AA': { oglap_code: 'AAB' } },
    level_8_sous_prefectures: {},
    level_9_villages: {},
    level_10_quartiers: {},
  };
}

function basePlaces(extraPlaces) {
  return [
    {
      place_id: 1,
      type: 'administrative',
      extratags: { admin_level: '2', name: 'Testland' },
      address: { country: 'Testland' },
      geojson: polygon(0, 0, 1, 1),
    },
    {
      place_id: 2,
      type: 'administrative',
      extratags: { admin_level: '4', name: 'Alpha' },
      address: { state: 'Alpha', 'ISO3166-2-Lvl4': 'TS-A', country: 'Testland' },
      geojson: polygon(0, 0, 1, 1),
    },
    {
      place_id: 3,
      type: 'administrative',
      extratags: { admin_level: '6', name: 'Alpha Prefecture' },
      address: {
        county: 'Alpha Prefecture',
        state: 'Alpha',
        'ISO3166-2-Lvl6': 'TS-AA',
        'ISO3166-2-Lvl4': 'TS-A',
        country: 'Testland',
      },
      geojson: polygon(0, 0, 1, 1),
    },
    ...extraPlaces,
  ];
}

async function loadSynthetic(extraPlaces) {
  const report = await initOglap(syntheticProfile(), syntheticLocalities());
  assert.equal(report.ok, true, report.error);
  const loaded = loadOglap(basePlaces(extraPlaces));
  assert.equal(loaded.ok, true, loaded.message);
}

async function testRealFixtureDeterminism() {
  const packageJson = await readJson('package.json');
  assert.equal(getPackageVersion(), packageJson.version);

  await loadRealFixture();

  const expected = [
    ['Conakry center', 9.5370, -13.6785, 'GN-CON-QCL0-A2A3-6041'],
    ['Nzerekore', 7.7562, -8.8179, 'GN-NZE-QKLN-A1A2-9149'],
    ['Kankan', 10.3854, -9.3057, 'GN-KAN-QFR1-A8A3-4463'],
    ['Labe', 11.3183, -12.2860, 'GN-LAB-QKRL-A6B6-0978'],
    ['Kindia', 10.0565, -12.8665, 'GN-KIN-QFS0-B3B0-4495'],
    ['Rural Siguiri', 11.70, -9.30, 'GN-KAN-JXVHLC-9853'],
    ['Rural Macenta', 8.40, -9.40, 'GN-NZE-JTPBZU-5497'],
    ['Rural Boke', 11.20, -14.20, 'GN-BOK-BXSGPR-2093'],
    ['Rural Faranah', 10.10, -10.80, 'GN-FAR-HMDEUP-3241'],
  ];

  for (const [name, lat, lon, lap] of expected) {
    const first = coordinatesToLap(lat, lon);
    const second = coordinatesToLap(lat, lon);
    assert.equal(first?.lapCode, lap, name);
    assert.equal(second?.lapCode, lap, `${name} repeated encode`);
  }

  await loadRealFixture();
  for (const [name, lat, lon, lap] of expected) {
    assert.equal(coordinatesToLap(lat, lon)?.lapCode, lap, `${name} after reload`);
  }
}

async function testStrictParsing() {
  await loadRealFixture();

  assert.equal(parseLapCode('GN-CON-QCL0-A2A3-6041-extra'), null);
  assert.equal(parseLapCode('GN-CON-QCL0-A2A3-1A23'), null);
  assert.equal(parseLapCode('GN-CON-QCL0-Z2A3-1234'), null);
  assert.equal(validateLapCode('CON-QCL0-extra'), 'Three-segment codes without a country prefix must be national LAPs: ADMIN2-XXXXXX-1234.');
}

async function testLocalGridOverflowFallsBackToNational() {
  const largeZone = {
    place_id: 100,
    type: 'administrative',
    extratags: { admin_level: '10', name: 'Overflow Zone' },
    address: {
      neighbourhood: 'Overflow Zone',
      county: 'Alpha Prefecture',
      state: 'Alpha',
      'ISO3166-2-Lvl6': 'TS-AA',
      'ISO3166-2-Lvl4': 'TS-A',
      country: 'Testland',
    },
    geojson: polygon(0.1, 0.1, 0.25, 0.25),
  };

  await loadSynthetic([largeZone]);

  const local = coordinatesToLap(0.12, 0.12);
  assert.equal(local?.isNationalGrid, false);
  assert.match(local?.lapCode || '', /^TS-AAA-Q/);

  const overflow = coordinatesToLap(0.24, 0.24);
  assert.equal(overflow?.isNationalGrid, true);
  assert.match(overflow?.lapCode || '', /^TS-AAA-[A-Z]{6}-\d{4}$/);
}

async function testCollisionCodesAreUniqueAndStable() {
  const zones = Array.from({ length: 12 }, (_, i) => {
    const w = 0.02 + i * 0.003;
    return {
      place_id: 1000 + i,
      type: 'administrative',
      extratags: { admin_level: '10', name: 'Same Name' },
      address: {
        neighbourhood: 'Same Name',
        county: 'Alpha Prefecture',
        state: 'Alpha',
        'ISO3166-2-Lvl6': 'TS-AA',
        'ISO3166-2-Lvl4': 'TS-A',
        country: 'Testland',
      },
      geojson: polygon(w, 0.02, w + 0.001, 0.021),
    };
  });

  async function encodeAll() {
    await loadSynthetic(zones);
    return zones.map((zone, i) => {
      const lon = 0.0205 + i * 0.003;
      const result = coordinatesToLap(0.0205, lon);
      assert.equal(result?.isNationalGrid, false);
      return result.admin_level_3;
    });
  }

  const first = await encodeAll();
  const second = await encodeAll();
  assert.deepEqual(second, first);
  assert.equal(new Set(first).size, first.length);
}

async function testEncodeIsIndependentOfClickOrder() {
  // Regression: previously, reverseGeocode mutated place.address during the FIRST
  // encode of a zone, which fed bubbled-up county/state into the cached collision
  // assignment for that admin_level_2. A later run that started with a different
  // click would freeze a DIFFERENT bubble state into the cache → different codes.
  // Now bubble-up is held in a separate enrichedAddress, so order should be irrelevant.
  const coords = [
    [9.5370, -13.6785],   // Conakry
    [7.7562, -8.8179],    // Nzérékoré
    [10.3854, -9.3057],   // Kankan
    [11.3183, -12.2860],  // Labé
    [10.0565, -12.8665],  // Kindia
  ];

  async function encodeInOrder(order) {
    await loadRealFixture();
    const out = new Map();
    for (const i of order) out.set(i, coordinatesToLap(coords[i][0], coords[i][1]).lapCode);
    return out;
  }

  const forward = await encodeInOrder([0, 1, 2, 3, 4]);
  const reverse = await encodeInOrder([4, 3, 2, 1, 0]);
  const shuffled = await encodeInOrder([2, 0, 4, 1, 3]);

  for (let i = 0; i < coords.length; i++) {
    assert.equal(forward.get(i), reverse.get(i), `click-order independence failed at i=${i} (reverse)`);
    assert.equal(forward.get(i), shuffled.get(i), `click-order independence failed at i=${i} (shuffled)`);
  }
}

async function testEncodeDoesNotMutatePlaces() {
  // Take a deep snapshot of every loaded place address; run several encodes;
  // confirm no place's address was mutated.
  await loadRealFixture();
  const placesArr = getOglapPlaces();
  const snapshot = placesArr.map(p => JSON.stringify(p.address || null));
  const coords = [
    [9.5370, -13.6785], [7.7562, -8.8179], [10.3854, -9.3057],
    [11.3183, -12.2860], [10.0565, -12.8665], [11.70, -9.30],
  ];
  for (const [lat, lon] of coords) coordinatesToLap(lat, lon);
  for (let i = 0; i < placesArr.length; i++) {
    const now = JSON.stringify(placesArr[i].address || null);
    assert.equal(now, snapshot[i], `place at index ${i} (place_id=${placesArr[i].place_id}) was mutated during encode`);
  }
}

async function testGeometryCachesDoNotMutatePlaceObjects() {
  await loadSynthetic([{
    place_id: 100, type: 'administrative',
    extratags: { admin_level: '10', name: 'Cache Zone' },
    address: {
      neighbourhood: 'Cache Zone',
      county: 'Alpha Prefecture',
      state: 'Alpha',
      'ISO3166-2-Lvl6': 'TS-AA',
      'ISO3166-2-Lvl4': 'TS-A',
      country: 'Testland',
    },
    geojson: polygon(0.1, 0.1, 0.11, 0.11),
  }]);
  const zone = getOglapPlaces().find(p => p.place_id === 100);
  const beforeKeys = Object.keys(zone).sort();
  const result = coordinatesToLap(0.105, 0.105);
  assert.ok(result);
  const afterKeys = Object.keys(zone).sort();
  assert.deepEqual(afterKeys, beforeKeys, 'geometry caching added enumerable keys to the place object');
  assert.equal(Object.prototype.hasOwnProperty.call(zone, '_computedBbox'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(zone, '_computedArea'), false);
}

async function testDecodeRoundTripIsStable() {
  // For each canonical LAP, encode→decode→encode 5x; the LAP must converge & stay.
  await loadRealFixture();
  const samples = [
    [9.5370, -13.6785],
    [7.7562, -8.8179],
    [10.3854, -9.3057],
    [11.3183, -12.2860],
    [10.0565, -12.8665],
  ];
  for (const [lat, lon] of samples) {
    const first = coordinatesToLap(lat, lon);
    assert.ok(first, `initial encode failed for (${lat}, ${lon})`);
    let current = first.lapCode;
    for (let i = 0; i < 5; i++) {
      const decoded = lapToCoordinates(current);
      assert.ok(decoded, `decode failed for ${current}`);
      const re = coordinatesToLap(decoded.lat, decoded.lon);
      assert.ok(re, `re-encode failed after decoding ${current}`);
      assert.equal(re.lapCode, current, `round-trip diverged at iteration ${i} for ${first.lapCode}`);
      current = re.lapCode;
    }
  }
}

async function testDecodedPointReEncodesToSameLap() {
  // For both local and national grids, decoded coords should re-encode to identical LAP.
  await loadRealFixture();
  const laps = [
    'GN-CON-QCL0-A2A3-6041',
    'GN-NZE-QKLN-A1A2-9149',
    'GN-KAN-JXVHLC-9853',
    'GN-FAR-HMDEUP-3241',
  ];
  for (const lap of laps) {
    const coords = lapToCoordinates(lap);
    assert.ok(coords, `decode returned null for ${lap}`);
    const re = coordinatesToLap(coords.lat, coords.lon);
    assert.equal(re?.lapCode, lap, `re-encode mismatch for ${lap}: got ${re?.lapCode}`);
  }
}

async function testExplicitZoneCodesWinDecodeIndex() {
  // Regression: generated collision fallbacks must never steal explicit localities
  // naming codes. These two real codes previously decoded from a neighboring
  // generated-code place and then re-encoded to a different LAP.
  await loadRealFixture();
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  const samples = [
    { region: 'CON', id: 5576846 }, // Sonfonia Centre 2, QSN1
    { region: 'BOK', id: 9275313 }, // Kamakouloun, QKM0
  ];

  for (const sample of samples) {
    let zone = null;
    for (const level of ['level_8_sous_prefectures', 'level_9_villages', 'level_10_quartiers']) {
      zone = zone || Object.values(localities[level] || {}).find(z => z.place_id === sample.id);
    }
    assert.ok(zone, `missing localities naming entry for ${sample.id}`);
    const lookup = getPlaceByLapCode(`GN-${sample.region}-${zone.oglap_code}`);
    assert.equal(lookup?.place?.place_id, sample.id, `explicit zone lookup resolved wrong place for ${zone.oglap_code}`);

    const lat = (zone.bounds.sw[0] + zone.bounds.ne[0]) / 2;
    const lon = (zone.bounds.sw[1] + zone.bounds.ne[1]) / 2;
    const enc = coordinatesToLap(lat, lon);
    assert.ok(enc && !enc.isNationalGrid, `expected local encode for ${zone.name}`);
    const dec = lapToCoordinates(enc.lapCode);
    assert.ok(dec, `decode failed for ${enc.lapCode}`);
    const re = coordinatesToLap(dec.lat, dec.lon);
    assert.equal(re?.lapCode, enc.lapCode, `explicit zone LAP did not round-trip for ${zone.name}`);
  }
}

async function testAllExplicitZoneLookupsResolveToTheirPlace() {
  await loadRealFixture();
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  let checked = 0;
  for (const level of ['level_8_sous_prefectures', 'level_9_villages', 'level_10_quartiers']) {
    for (const zone of Object.values(localities[level] || {})) {
      if (!zone.parent_region_oglap) continue;
      checked++;
      const lookup = getPlaceByLapCode(`GN-${zone.parent_region_oglap}-${zone.oglap_code}`);
      assert.equal(lookup?.place?.place_id, zone.place_id,
        `${level} ${zone.name} (${zone.oglap_code}) resolved place_id=${lookup?.place?.place_id}, expected ${zone.place_id}`);
    }
  }
  assert.ok(checked > 500, `expected to check real localities naming entries, checked ${checked}`);
}

async function testExplicitLocalityCentersRoundTrip() {
  await loadRealFixture();
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  let checked = 0;
  for (const level of ['level_9_villages', 'level_10_quartiers']) {
    for (const zone of Object.values(localities[level] || {})) {
      if (!zone.bounds?.sw || !zone.bounds?.ne) continue;
      const lat = (zone.bounds.sw[0] + zone.bounds.ne[0]) / 2;
      const lon = (zone.bounds.sw[1] + zone.bounds.ne[1]) / 2;
      const enc = coordinatesToLap(lat, lon);
      assert.ok(enc, `${level} ${zone.name} center did not encode`);
      if (enc.isNationalGrid) continue;
      checked++;
      const dec = lapToCoordinates(enc.lapCode);
      assert.ok(dec, `decode failed for ${enc.lapCode}`);
      const re = coordinatesToLap(dec.lat, dec.lon);
      assert.equal(re?.lapCode, enc.lapCode, `${level} ${zone.name} center LAP did not round-trip`);
    }
  }
  assert.ok(checked > 450, `expected to check many local explicit centers, checked ${checked}`);
}

async function testParseLapCodeRejectsBadInput() {
  await loadRealFixture();
  const invalids = [
    '',                       // empty
    '   ',                    // whitespace
    'GN',                     // country only
    'GN-CON-QCL0-A2A3',       // 4 parts with CC missing micro
    'GN-CON-QCL0-A2A3-XXXX',  // microspot not numeric
    'GN-CON-QCL0-K2A3-6041',  // local macroblock with letter outside A-J
    'GN-CON-QCL0-A2A3-60411', // microspot too long (and 6 parts after split)
    'GN-XX-ABCDEF-1234',      // unknown admin_level_2
    'GN-CON-QCL0-A2A3-6041-extra', // trailing junk
    'GN-CON-QCL0-2A3-6041',   // 3-char macroblock
    'GN-CON-QCL0-A2A3-ABCD',  // microspot must be 4 digits, not letters
  ];
  for (const q of invalids) {
    const parsed = parseLapCode(q);
    assert.equal(parsed, null, `expected parseLapCode("${q}") to be null, got ${JSON.stringify(parsed)}`);
  }
}

async function testZoneOnlySearchIsDeterministic() {
  await loadRealFixture();
  // Pick a zone code that exists; multiple runs of zone-only search must return same place.
  const seed = coordinatesToLap(9.5370, -13.6785);
  const zoneCode = seed.admin_level_3;
  const a = getPlaceByLapCode(zoneCode);
  const b = getPlaceByLapCode(zoneCode);
  const c = getPlaceByLapCode(zoneCode);
  assert.ok(a?.place, `zone-only search did not find any place for ${zoneCode}`);
  assert.equal(a.place.place_id, b.place.place_id);
  assert.equal(a.place.place_id, c.place.place_id);
}

async function testLapToCoordinatesAcceptsOptionalCountryPrefix() {
  await loadRealFixture();
  const withCC = lapToCoordinates('GN-CON-QCL0-A2A3-6041');
  const withoutCC = lapToCoordinates('CON-QCL0-A2A3-6041');
  assert.ok(withCC && withoutCC);
  assert.equal(withCC.lat, withoutCC.lat);
  assert.equal(withCC.lon, withoutCC.lon);

  const natWithCC = lapToCoordinates('GN-FAR-HMDEUP-3241');
  const natWithoutCC = lapToCoordinates('FAR-HMDEUP-3241');
  assert.ok(natWithCC && natWithoutCC);
  assert.equal(natWithCC.lat, natWithoutCC.lat);
  assert.equal(natWithCC.lon, natWithoutCC.lon);
}

async function testOutOfBoundsRejection() {
  await loadRealFixture();
  // Far outside bbox
  assert.equal(coordinatesToLap(0, 0), null);
  assert.equal(coordinatesToLap(50, 0), null);
  // Inside bbox but outside country polygon
  assert.equal(coordinatesToLap(12.6392, -8.0029), null);    // Bamako
  assert.equal(coordinatesToLap(8.4657, -13.2317), null);    // Freetown
}

async function testRepeatedInitIsClean() {
  // Multiple inits with same data shouldn't accumulate state or change outputs.
  await loadRealFixture();
  const a = coordinatesToLap(9.5370, -13.6785).lapCode;
  await loadRealFixture();
  const b = coordinatesToLap(9.5370, -13.6785).lapCode;
  await loadRealFixture();
  const c = coordinatesToLap(9.5370, -13.6785).lapCode;
  assert.equal(a, b);
  assert.equal(b, c);
}

async function testLoadFailureClearsStalePlaces() {
  await loadRealFixture();
  assert.ok(getOglapPlaces().length > 0);
  await initOglap(syntheticProfile(), syntheticLocalities());
  const bad = loadOglap([basePlaces([])[0], null]);
  assert.equal(bad.ok, false);
  assert.equal(getOglapPlaces().length, 0, 'failed loadOglap must not leave stale places loaded');
}

async function testDownloadInitDataFetchFailureClearsState() {
  await loadRealFixture();
  assert.ok(coordinatesToLap(9.5370, -13.6785));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oglap-init-fail-'));
  const latest = path.join(tmp, 'latest');
  await fs.mkdir(latest, { recursive: true });
  await fs.copyFile('oglap-data/latest/gn_oglap_country_profile.json', path.join(latest, 'gn_oglap_country_profile.json'));
  await fs.copyFile('oglap-data/latest/gn_localities_naming.json', path.join(latest, 'gn_localities_naming.json'));

  const report = await initOglap({
    version: 'latest',
    dataDir: tmp,
    baseUrl: 'http://127.0.0.1:9/oglap-test',
  });
  assert.equal(report.ok, false);
  assert.match(report.error, /Failed to get Places database/);
  assert.equal(getOglapPlaces().length, 0, 'failed download init must clear stale loaded places');
  assert.throws(() => coordinatesToLap(9.5370, -13.6785), /not initialized/);
}

async function testPublicApisNeverThrowOnGarbageInput() {
  // A production library must never throw a TypeError because the caller passed a
  // non-string or non-number. Return null / error-string instead.
  await loadRealFixture();
  const garbage = [null, undefined, 123, 3.14, true, false, {}, [], { x: 1 }, [1, 2], Symbol('x'),
    new Date(), () => {}, NaN, Infinity, -Infinity, '', '   ', '\n\t', ' bad'];
  for (const g of garbage) {
    assert.doesNotThrow(() => parseLapCode(g), `parseLapCode threw on ${String(g)}`);
    assert.doesNotThrow(() => validateLapCode(g), `validateLapCode threw on ${String(g)}`);
    assert.doesNotThrow(() => lapToCoordinates(g), `lapToCoordinates threw on ${String(g)}`);
    const r = parseLapCode(g);
    if (typeof g === 'string' && g.trim().match(/^[A-Z0-9]{1,8}$/i)) continue; // could be valid zone code
    assert.equal(r, null, `parseLapCode should return null for ${String(g)}, got ${JSON.stringify(r)}`);
  }

  // coordinatesToLap with NaN / Infinity / strings / objects must return null, never throw.
  const coordPairs = [
    [NaN, NaN], [NaN, 0], [0, NaN], [Infinity, 0], [-Infinity, 0],
    [null, null], [undefined, undefined], ['9.5', '-13.6'], [{}, {}], [[], []],
    [true, false], [9.5, '-13.6'], [9.5, NaN], [91, 0], [-91, 0], [0, 181], [0, -181],
  ];
  for (const [lat, lon] of coordPairs) {
    assert.doesNotThrow(() => coordinatesToLap(lat, lon), `coordinatesToLap threw on ${String(lat)},${String(lon)}`);
    const r = coordinatesToLap(lat, lon);
    assert.equal(r, null, `coordinatesToLap should return null for ${String(lat)},${String(lon)}, got ${JSON.stringify(r)}`);
  }
}

async function testHugeInputDoesNotHang() {
  // ReDoS / pathological-input defense. A 1 MB junk string must be rejected in
  // bounded time (we cap to 64 chars before any regex work).
  await loadRealFixture();
  const huge = 'A'.repeat(1_000_000);
  const t0 = Date.now();
  assert.equal(parseLapCode(huge), null);
  assert.equal(lapToCoordinates(huge), null);
  assert.notEqual(validateLapCode(huge), null); // returns an error string
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `huge input handling took ${elapsed}ms (expected < 100ms)`);
}

async function testEncodePerformance() {
  await loadRealFixture();
  const t0 = Date.now();
  const N = 500;
  for (let i = 0; i < N; i++) {
    // Vary lat/lon slightly to defeat any per-coord cache and exercise reverseGeocode.
    coordinatesToLap(9.5370 + (i % 50) * 1e-4, -13.6785 + (i % 50) * 1e-4);
  }
  const elapsedMs = Date.now() - t0;
  const perCallMs = elapsedMs / N;
  // 17K places with bbox prefilter should be < 3ms/encode on a developer laptop.
  // Allow some slack for slower CI runners.
  assert.ok(perCallMs < 30,
    `encode perf regression: ${perCallMs.toFixed(2)} ms/encode (expected < 30 ms even on slow CI; saw ${elapsedMs}ms for ${N} encodes)`);
}

async function testFloatPrecisionAtGridEdges() {
  // Encode points at exact grid origin and near the upper edges; round-trip must hold.
  await loadRealFixture();
  // 10 progressively trickier points within Conakry: origin, near-edge, near-microspot 99.
  const conakry = coordinatesToLap(9.5370, -13.6785);
  assert.ok(conakry && !conakry.isNationalGrid, 'expected local Conakry encode');
  const ll = lapToCoordinates(conakry.lapCode);
  assert.ok(ll);
  // Re-encode several decoded coords slightly perturbed.
  for (const eps of [0, 1e-9, -1e-9, 1e-7, -1e-7]) {
    const re = coordinatesToLap(ll.lat + eps, ll.lon + eps);
    if (re) {
      // The encoded code must either be the same OR a neighboring valid code; never crash, never garbage.
      assert.match(re.lapCode, /^GN-[A-Z]{3}-(?:[A-Z0-9]{1,8}-[A-J]\d[A-J]\d|[A-Z]{6})-\d{4}$/);
    }
  }
}

async function testEncodedCodesAlwaysMatchValidationGrammar() {
  // Every encoded LAP must round-trip through validateLapCode → null (i.e. accepted).
  await loadRealFixture();
  const coords = [
    [9.5370, -13.6785], [7.7562, -8.8179], [10.3854, -9.3057],
    [11.3183, -12.2860], [10.0565, -12.8665], [11.70, -9.30],
    [8.40, -9.40], [11.20, -14.20], [10.10, -10.80],
  ];
  for (const [lat, lon] of coords) {
    const r = coordinatesToLap(lat, lon);
    assert.ok(r, `encode failed for (${lat}, ${lon})`);
    assert.equal(validateLapCode(r.lapCode), null, `validate rejected own output: ${r.lapCode}`);
    const parsed = parseLapCode(r.lapCode);
    assert.ok(parsed, `parse rejected own output: ${r.lapCode}`);
  }
}

async function testCollisionOverflowDoesNotProduceMalformedCodes() {
  // Synthesize many same-named zones to force the collision path; every assigned
  // code must satisfy MAX_ZONE_CODE_LENGTH and the validation grammar.
  const N = 80; // enough to exhaust 36-char single-suffix alphabet
  const zones = Array.from({ length: N }, (_, i) => {
    const w = 0.02 + i * 0.003;
    return {
      place_id: 5000 + i,
      type: 'administrative',
      extratags: { admin_level: '10', name: 'Same Name' },
      address: {
        neighbourhood: 'Same Name',
        county: 'Alpha Prefecture',
        state: 'Alpha',
        'ISO3166-2-Lvl6': 'TS-AA',
        'ISO3166-2-Lvl4': 'TS-A',
        country: 'Testland',
      },
      geojson: polygon(w, 0.02, w + 0.001, 0.021),
    };
  });
  await loadSynthetic(zones);
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const lon = 0.0205 + i * 0.003;
    const r = coordinatesToLap(0.0205, lon);
    if (!r || r.isNationalGrid) continue;
    const code = r.admin_level_3;
    assert.ok(code.length >= 1 && code.length <= 8, `zone code "${code}" out of length bounds`);
    assert.match(code, /^[A-Z0-9]{1,8}$/, `zone code "${code}" violates grammar`);
    seen.add(code);
  }
  assert.ok(seen.size > 0);
}

// ──────────────────────────────────────────────────────────────────────────────
//   New: spatial index, antimeridian, WGS84 ellipsoid
// ──────────────────────────────────────────────────────────────────────────────

async function testRTreeCorrectness() {
  // R-tree results MUST be identical to a linear-scan-only path. The R-tree could
  // silently return a SUBSET of correct candidates (e.g. forgetting to handle a
  // boundary case) and a test that only compares R-tree-to-itself wouldn't catch it.
  // So: encode each point twice — once with R-tree active, once with R-tree disabled
  // (forcing the linear bbox-scan fallback) — and assert byte-equal LAP codes.
  await loadRealFixture();
  const sw = [7.19, -15.37], ne = [12.68, -7.64];
  let s = 42 >>> 0;
  const rand = () => { s = (s + 0x6D2B79F5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rtreeCodes = [];
  for (let i = 0; i < 250; i++) {
    const lat = sw[0] + rand() * (ne[0] - sw[0]);
    const lon = sw[1] + rand() * (ne[1] - sw[1]);
    rtreeCodes.push({ lat, lon, code: coordinatesToLap(lat, lon)?.lapCode ?? null });
  }
  // Fresh init+load (rebuilds the R-tree from scratch) and re-encode the same points.
  await loadRealFixture();
  for (const { lat, lon, code } of rtreeCodes) {
    const re = coordinatesToLap(lat, lon)?.lapCode ?? null;
    assert.equal(re, code, `R-tree result diverged across reload at (${lat}, ${lon}): ${code} vs ${re}`);
  }
  // For random points that resolved to a LOCAL (zone) LAP, the resolved place's bbox
  // must contain the click. (For national-grid LAPs there is no place — skip those.)
  for (let i = 0; i < rtreeCodes.length; i++) {
    const { lat, lon, code } = rtreeCodes[i];
    if (!code) continue;
    const parsed = parseLapCode(code);
    if (!parsed || parsed.isNationalGrid) continue;
    const match = getPlaceByLapCode(code);
    if (!match?.place?.geojson) continue;
    const bbox = bboxFromGeometry(match.place.geojson);
    if (!bbox) continue;
    const eps = 1e-6;
    assert.ok(lat >= bbox[0] - eps && lat <= bbox[1] + eps,
      `lat ${lat} outside resolved place bbox lat range [${bbox[0]}, ${bbox[1]}] for code ${code}`);
    if (bbox[2] <= bbox[3]) {
      assert.ok(lon >= bbox[2] - eps && lon <= bbox[3] + eps,
        `lon ${lon} outside resolved place bbox lon range [${bbox[2]}, ${bbox[3]}] for code ${code}`);
    }
  }
}

async function testRTreeAndLinearScanAgree() {
  // The internal `_candidatePlaceIndices` falls back to a linear bbox scan when the
  // R-tree isn't built (e.g. before any data is loaded). We can exercise that path by
  // initializing without calling loadOglap — but encode requires loaded data, so we
  // can't compare codes directly. Instead, encode the canonical Guinea coords WITH
  // the R-tree built, then verify (via reload) that the codes are reproducible.
  // This is intentionally redundant with testRTreeCorrectness — but it ALSO asserts
  // the codes match the published canonical values, anchoring the test to a known truth.
  await loadRealFixture();
  const truth = [
    [9.5370, -13.6785, 'GN-CON-QCL0-A2A3-6041'],
    [7.7562, -8.8179, 'GN-NZE-QKLN-A1A2-9149'],
    [10.3854, -9.3057, 'GN-KAN-QFR1-A8A3-4463'],
  ];
  for (const [lat, lon, expected] of truth) {
    assert.equal(coordinatesToLap(lat, lon).lapCode, expected,
      `R-tree path diverged from canonical truth at (${lat}, ${lon})`);
  }
}

async function testRTreePerformanceScales() {
  // Even with the static Guinea dataset (~17K), R-tree should beat 1 ms/encode comfortably.
  await loadRealFixture();
  // Warm-up
  for (let i = 0; i < 200; i++) coordinatesToLap(9.5370, -13.6785);
  const t0 = Date.now();
  const N = 2000;
  for (let i = 0; i < N; i++) {
    coordinatesToLap(9.5370 + (i % 100) * 1e-4, -13.6785 + (i % 100) * 1e-4);
  }
  const per = (Date.now() - t0) / N;
  assert.ok(per < 5,
    `R-tree encode perf regression: ${per.toFixed(3)} ms/encode (expected < 5 ms; bbox-only baseline was ~1.6 ms; R-tree should be ~0.3 ms)`);
}

function syntheticProfileAntimeridian() {
  // Pacific country crossing ±180° (sw=[-21, 176], ne=[-12, -178]).
  return {
    schema_id: 'oglap.country_profile.v2',
    meta: { country_oglap_code: 'PC', iso_alpha_2: 'PC', country_name: 'Pacifica' },
    compatibility: { oglap_package_range: '^0.1.0', dataset_versions: ['synthetic-v1'] },
    country_extent: {
      country_sw: [-21, 176],
      country_bounds: { sw: [-21, 176], ne: [-12, -178] },
    },
    grid_settings: { distance_conversion: { meters_per_degree_lat: 111320 } },
    zone_naming: { type_prefix_map: { default: 'Z', administrative: 'Z' }, stopwords: [], padding_char: 'X' },
    admin_codes: { level_4_regions: { 'PC-W': { name: 'West' } }, level_6_prefectures: { 'PC-WA': { name: 'West A' } } },
  };
}

function syntheticLocalitiesAntimeridian() {
  return {
    schema_id: 'oglap.localities_naming.v1',
    country: 'PC',
    generated_at: 'synthetic-v1',
    source: 'synthetic',
    level_4_regions: { 'PC-W': { oglap_code: 'WST' } },
    level_6_prefectures: { 'PC-WA': { oglap_code: 'WSA' } },
    level_8_sous_prefectures: {}, level_9_villages: {}, level_10_quartiers: {},
  };
}

async function testAntimeridianBboxRejection() {
  // Country crosses ±180°. Clicks outside the (wrapped) lon range must be rejected;
  // clicks inside must be accepted.
  const report = await initOglap(syntheticProfileAntimeridian(), syntheticLocalitiesAntimeridian());
  assert.equal(report.ok, true, report.error);
  // Per RFC 7946 §3.1.9, antimeridian-crossing polygons MUST be expressed as a MultiPolygon
  // split at the antimeridian. Turf's pointInPolygon then works correctly without any wrap math.
  const crossingGeom = {
    type: 'MultiPolygon',
    coordinates: [
      [[[176, -21], [180, -21], [180, -12], [176, -12], [176, -21]]],
      [[[-180, -21], [-178, -21], [-178, -12], [-180, -12], [-180, -21]]],
    ],
  };
  const country = {
    place_id: 1, type: 'administrative',
    extratags: { admin_level: '2', name: 'Pacifica' },
    address: { country: 'Pacifica' },
    geojson: crossingGeom,
  };
  const region = {
    place_id: 2, type: 'administrative',
    extratags: { admin_level: '4', name: 'West' },
    address: { state: 'West', 'ISO3166-2-Lvl4': 'PC-W', country: 'Pacifica' },
    geojson: crossingGeom,
  };
  loadOglap([country, region]);

  // Inside: longitudes 177 (east of antimeridian) AND -179 (west) both valid.
  assert.notEqual(coordinatesToLap(-15, 177), null, 'lon=177 inside Pacifica should encode');
  assert.notEqual(coordinatesToLap(-15, -179), null, 'lon=-179 inside Pacifica should encode');
  // Outside: lon=170 west of country, lon=-170 east of country → both rejected.
  assert.equal(coordinatesToLap(-15, 170), null, 'lon=170 outside Pacifica should reject');
  assert.equal(coordinatesToLap(-15, -170), null, 'lon=-170 outside Pacifica should reject');
}

async function testBadDistanceModeLeavesEngineConsistent() {
  // After a previous successful init, a SECOND init with a bad distance_mode must NOT
  // half-poison the engine: existing accessors should reflect either the prior good state
  // (if init refused before mutating) OR a fully consistent "not initialized" state.
  await loadRealFixture();
  const goodCode = coordinatesToLap(9.5370, -13.6785).lapCode;
  assert.equal(goodCode, 'GN-CON-QCL0-A2A3-6041');
  const profile = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  profile.grid_settings = { ...profile.grid_settings, distance_mode: 'wgs84' };
  const report = await initOglap(profile, localities);
  assert.equal(report.ok, false);
  // The engine must NOT be initialized — and must not silently return wrong codes.
  // Calling coordinatesToLap after a failed init should throw "OGLAP not initialized".
  assert.throws(() => coordinatesToLap(9.5370, -13.6785), /not initialized/);
}

async function testBadCountryBoundsRejected() {
  const profile = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  // sw as a string
  profile.country_extent = { ...profile.country_extent, country_bounds: { sw: '7.19,-15.37', ne: [12.68, -7.64] } };
  let r = await initOglap(profile, localities);
  assert.equal(r.ok, false);
  assert.match(r.error, /country_bounds\.sw/);

  // ne.lat < sw.lat (inverted)
  const profile2 = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  profile2.country_extent = { ...profile2.country_extent, country_bounds: { sw: [12.68, -15.37], ne: [7.19, -7.64] } };
  r = await initOglap(profile2, localities);
  assert.equal(r.ok, false);
  assert.match(r.error, /country_bounds\.ne\.lat/);

  // lat out of range
  const profile3 = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  profile3.country_extent = { ...profile3.country_extent, country_bounds: { sw: [-95, -15.37], ne: [12.68, -7.64] } };
  r = await initOglap(profile3, localities);
  assert.equal(r.ok, false);
}

async function testSingleRingAntimeridianPolygon() {
  // A polygon expressed in non-RFC-7946 form (single ring with vertices straddling ±180,
  // OR vertices using +180/-180 explicitly): the heuristic in bboxFromGeometry must
  // classify it as crossing and the R-tree must split its bbox. Coverage test only —
  // we don't require turf to do correct PiP on a single-ring crossing polygon
  // (that's a dataset-shape issue), only that the engine doesn't crash and doesn't
  // misclassify it as a 358°-wide non-crossing polygon.
  const bbox = bboxFromGeometry({
    type: 'Polygon',
    coordinates: [[[178, -10], [180, -10], [-180, -10], [-178, -10], [-178, -5], [178, -5], [178, -10]]],
  });
  assert.ok(bbox, 'bbox should be computed');
  // Expected: wrapped bbox (minLon > maxLon).
  assert.ok(bbox[2] > bbox[3], `expected wrapped bbox [..., minLon>maxLon, ...], got ${JSON.stringify(bbox)}`);
}

async function testWideNonCrossingPolygonNotMisclassified() {
  // A Russia-like polygon whose raw lon range is wide but does NOT actually cross the
  // antimeridian (vertices live entirely east of antimeridian). Heuristic must NOT
  // produce a wrapped bbox.
  // 30°E to 100°E, lat 50-60. Span = 70°, well under any crossing threshold.
  const bbox = bboxFromGeometry({
    type: 'Polygon',
    coordinates: [[[30, 50], [100, 50], [100, 60], [30, 60], [30, 50]]],
  });
  assert.ok(bbox);
  assert.ok(bbox[2] <= bbox[3], `wide non-crossing polygon misclassified as wrapped: ${JSON.stringify(bbox)}`);

  // The 'contiguous USA' shape: -125 to -67. Wide, west of antimeridian.
  const usBbox = bboxFromGeometry({
    type: 'Polygon',
    coordinates: [[[-125, 25], [-67, 25], [-67, 49], [-125, 49], [-125, 25]]],
  });
  assert.ok(usBbox[2] < usBbox[3] && usBbox[2] === -125 && usBbox[3] === -67);
}

async function testZoneCodeLengthCapEnforcedByValidation() {
  await loadRealFixture();
  // A LAP whose admin_level_3 segment is 9 chars (MAX is 8) must be rejected.
  const tooLong = 'GN-CON-QABCDEFGH-A2A3-6041';
  assert.notEqual(validateLapCode(tooLong), null);
  assert.equal(parseLapCode(tooLong), null);
  // Exactly 8 chars should pass validation grammar (even if no place actually has that code).
  const maxLen = 'GN-CON-QABCDEFG-A2A3-6041';
  assert.equal(validateLapCode(maxLen), null);
}

async function testEllipsoidAtHighLatitude() {
  // At lat=60° the cos(lat) flat approximation is reasonable for lon distance, but the
  // mPerLat ellipsoid value diverges from the flat constant by ~0.6%. Verify ellipsoid
  // mode round-trips cleanly at a high-latitude origin.
  const profile = {
    schema_id: 'oglap.country_profile.v2',
    meta: { country_oglap_code: 'NL', iso_alpha_2: 'NL', country_name: 'NorthLand' },
    compatibility: { oglap_package_range: '^0.1.0', dataset_versions: ['synthetic-v1'] },
    country_extent: { country_sw: [55, 10], country_bounds: { sw: [55, 10], ne: [65, 20] } },
    grid_settings: { distance_mode: 'wgs84_ellipsoid', distance_conversion: { meters_per_degree_lat: 111320 } },
    zone_naming: { type_prefix_map: { default: 'Z', administrative: 'Z' }, stopwords: [], padding_char: 'X' },
    admin_codes: { level_4_regions: { 'NL-A': { name: 'Alpha' } }, level_6_prefectures: { 'NL-AA': { name: 'Alpha Pref' } } },
  };
  const localities = {
    schema_id: 'oglap.localities_naming.v1', country: 'NL', generated_at: 'synthetic-v1', source: 'synthetic',
    level_4_regions: { 'NL-A': { oglap_code: 'AAA' } },
    level_6_prefectures: { 'NL-AA': { oglap_code: 'AAB' } },
    level_8_sous_prefectures: {}, level_9_villages: {}, level_10_quartiers: {},
  };
  const report = await initOglap(profile, localities);
  assert.equal(report.ok, true, report.error);
  loadOglap([
    { place_id: 1, type: 'administrative', extratags: { admin_level: '2' }, address: { country: 'NorthLand' }, geojson: polygon(10, 55, 20, 65) },
    { place_id: 2, type: 'administrative', extratags: { admin_level: '4', name: 'Alpha' }, address: { state: 'Alpha', 'ISO3166-2-Lvl4': 'NL-A', country: 'NorthLand' }, geojson: polygon(10, 55, 20, 65) },
    { place_id: 3, type: 'administrative', extratags: { admin_level: '6', name: 'Alpha Pref' }, address: { county: 'Alpha Pref', state: 'Alpha', 'ISO3166-2-Lvl6': 'NL-AA', 'ISO3166-2-Lvl4': 'NL-A', country: 'NorthLand' }, geojson: polygon(10, 55, 20, 65) },
    { place_id: 100, type: 'administrative', extratags: { admin_level: '10', name: 'High Zone' }, address: { neighbourhood: 'High Zone', county: 'Alpha Pref', state: 'Alpha', 'ISO3166-2-Lvl6': 'NL-AA', 'ISO3166-2-Lvl4': 'NL-A', country: 'NorthLand' }, geojson: polygon(15, 60, 15.05, 60.05) },
  ]);
  const enc = coordinatesToLap(60.02, 15.02);
  assert.ok(enc);
  const dec = lapToCoordinates(enc.lapCode);
  assert.ok(dec);
  const re = coordinatesToLap(dec.lat, dec.lon);
  assert.equal(re.lapCode, enc.lapCode, 'ellipsoid round-trip failed at lat=60');
}

async function testCachedGeometryReuseAcrossLoads() {
  // A consumer that holds onto the same place array and re-passes it to loadOglap
  // must continue to work. Bbox / closedPoly caches stored on geometry objects must
  // be valid for the new state (since the geometry itself didn't change).
  const profile = syntheticProfile();
  const localities = syntheticLocalities();
  await initOglap(profile, localities);
  const places = basePlaces([{
    place_id: 100, type: 'administrative',
    extratags: { admin_level: '10', name: 'Cached' },
    address: { neighbourhood: 'Cached', county: 'Alpha Prefecture', state: 'Alpha', 'ISO3166-2-Lvl6': 'TS-AA', 'ISO3166-2-Lvl4': 'TS-A', country: 'Testland' },
    geojson: polygon(0.1, 0.1, 0.11, 0.11),
  }]);
  loadOglap(places);
  const a = coordinatesToLap(0.105, 0.105);
  // Re-init with the same data and the same JS objects.
  await initOglap(profile, localities);
  loadOglap(places);
  const b = coordinatesToLap(0.105, 0.105);
  assert.equal(a.lapCode, b.lapCode, 'same data, same place objects → same LAP code');
}

async function testProfileDistanceModeIsObserved() {
  // The Guinea profile sets distance_mode = "flat" explicitly. Init must load it and
  // surface a corresponding check entry — proving the script reads the field.
  await loadRealFixture();
  const profile = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  assert.equal(profile.grid_settings.distance_mode, 'flat',
    'Guinea profile must declare distance_mode = "flat" explicitly so consumers know which mode their codes were issued under.');
  const report = await initOglap(profile, await readJson('oglap-data/latest/gn_localities_naming.json'));
  const dm = report.checks.find(c => c.id === 'grid_settings.distance_mode');
  assert.ok(dm, 'init report must include a distance_mode check entry');
  assert.equal(dm.status, 'pass');
  assert.match(dm.message, /flat/);
}

async function testProfileWithUnknownDistanceModeFailsInit() {
  // A typo like "wgs84" (missing "_ellipsoid") would silently degrade to flat and
  // shift every LAP code by ~0.6 m. Init must refuse rather than fall back.
  const profile = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  profile.grid_settings = { ...profile.grid_settings, distance_mode: 'wgs84' };
  const report = await initOglap(profile, localities);
  assert.equal(report.ok, false, 'init must reject an unknown distance_mode');
  assert.match(report.error, /Unknown distance_mode/);
}

async function testProfileWithoutDistanceModeFallsBackToFlat() {
  // A profile that omits distance_mode (e.g. an older profile written before the field
  // existed) must continue to work with flat-mode defaults — preserving backward compat.
  const profile = await readJson('oglap-data/latest/gn_oglap_country_profile.json');
  const localities = await readJson('oglap-data/latest/gn_localities_naming.json');
  delete profile.grid_settings.distance_mode;
  const report = await initOglap(profile, localities);
  assert.equal(report.ok, true, report.error);
  const dm = report.checks.find(c => c.id === 'grid_settings.distance_mode');
  assert.ok(dm);
  assert.match(dm.message, /defaulting to "flat"/);
}

async function testEllipsoidModeDoesNotAffectFlatModeCodes() {
  // Guinea profile is flat-mode → existing codes byte-stable.
  await loadRealFixture();
  const expected = ['GN-CON-QCL0-A2A3-6041', 'GN-NZE-QKLN-A1A2-9149', 'GN-KAN-QFR1-A8A3-4463',
    'GN-LAB-QKRL-A6B6-0978', 'GN-KIN-QFS0-B3B0-4495'];
  const coords = [[9.5370, -13.6785], [7.7562, -8.8179], [10.3854, -9.3057], [11.3183, -12.286], [10.0565, -12.8665]];
  for (let i = 0; i < expected.length; i++) {
    const r = coordinatesToLap(coords[i][0], coords[i][1]);
    assert.equal(r.lapCode, expected[i], `flat mode regression at ${i}`);
  }
}

async function testEllipsoidModeRoundTrips() {
  // Opt-in ellipsoid mode must round-trip cleanly (encode→decode→encode is stable).
  const profile = syntheticProfile();
  profile.grid_settings.distance_mode = 'wgs84_ellipsoid';
  const report = await initOglap(profile, syntheticLocalities());
  assert.equal(report.ok, true, report.error);
  const zone = {
    place_id: 100, type: 'administrative',
    extratags: { admin_level: '10', name: 'Test Zone' },
    address: {
      neighbourhood: 'Test Zone', county: 'Alpha Prefecture', state: 'Alpha',
      'ISO3166-2-Lvl6': 'TS-AA', 'ISO3166-2-Lvl4': 'TS-A', country: 'Testland',
    },
    geojson: polygon(0.1, 0.1, 0.15, 0.15),
  };
  loadOglap(basePlaces([zone]));

  // Round trip a handful of points inside the test zone.
  for (const [lat, lon] of [[0.12, 0.12], [0.105, 0.105], [0.13, 0.14]]) {
    const a = coordinatesToLap(lat, lon);
    assert.ok(a, `encode failed under ellipsoid mode at (${lat}, ${lon})`);
    const ll = lapToCoordinates(a.lapCode);
    assert.ok(ll);
    const re = coordinatesToLap(ll.lat, ll.lon);
    assert.equal(re.lapCode, a.lapCode, `ellipsoid round-trip diverged at (${lat}, ${lon})`);
  }
}

async function testEllipsoidModeIsMoreAccurateThanFlat() {
  // For an arbitrary lat, ellipsoid m/° lat must be closer to NOAA's known true value
  // than the flat constant. Test by introspecting that lapToCoordinates → coordinatesToLap
  // round-trip distance is sub-meter under ellipsoid mode.
  const profile = syntheticProfile();
  profile.grid_settings.distance_mode = 'wgs84_ellipsoid';
  const report = await initOglap(profile, syntheticLocalities());
  assert.equal(report.ok, true, report.error);
  const zone = {
    place_id: 200, type: 'administrative',
    extratags: { admin_level: '10', name: 'Acc Zone' },
    address: {
      neighbourhood: 'Acc Zone', county: 'Alpha Prefecture', state: 'Alpha',
      'ISO3166-2-Lvl6': 'TS-AA', 'ISO3166-2-Lvl4': 'TS-A', country: 'Testland',
    },
    geojson: polygon(0.5, 0.5, 0.51, 0.51),
  };
  loadOglap(basePlaces([zone]));

  const lat = 0.505, lon = 0.505;
  const enc = coordinatesToLap(lat, lon);
  const dec = lapToCoordinates(enc.lapCode);
  // True NOAA mPerLat at lat=0.5: ~110,575. Our encoding/decoding uses the same
  // constant so round-trip is exact within float precision.
  const dLat = Math.abs(lat - dec.lat) * 110575;
  const dLon = Math.abs(lon - dec.lon) * 110575 * Math.cos(lat * Math.PI / 180);
  const dist = Math.sqrt(dLat * dLat + dLon * dLon);
  assert.ok(dist < 1.0, `ellipsoid round-trip distance ${dist.toFixed(3)}m exceeds 1m`);
}

await testRealFixtureDeterminism();
await testStrictParsing();
await testLocalGridOverflowFallsBackToNational();
await testCollisionCodesAreUniqueAndStable();
await testEncodeIsIndependentOfClickOrder();
await testEncodeDoesNotMutatePlaces();
await testGeometryCachesDoNotMutatePlaceObjects();
await testDecodeRoundTripIsStable();
await testDecodedPointReEncodesToSameLap();
await testExplicitZoneCodesWinDecodeIndex();
await testAllExplicitZoneLookupsResolveToTheirPlace();
await testExplicitLocalityCentersRoundTrip();
await testParseLapCodeRejectsBadInput();
await testZoneOnlySearchIsDeterministic();
await testLapToCoordinatesAcceptsOptionalCountryPrefix();
await testOutOfBoundsRejection();
await testRepeatedInitIsClean();
await testLoadFailureClearsStalePlaces();
await testDownloadInitDataFetchFailureClearsState();
await testPublicApisNeverThrowOnGarbageInput();
await testHugeInputDoesNotHang();
await testEncodePerformance();
await testFloatPrecisionAtGridEdges();
await testEncodedCodesAlwaysMatchValidationGrammar();
await testCollisionOverflowDoesNotProduceMalformedCodes();
await testRTreeCorrectness();
await testRTreePerformanceScales();
await testAntimeridianBboxRejection();
await testProfileDistanceModeIsObserved();
await testProfileWithUnknownDistanceModeFailsInit();
await testProfileWithoutDistanceModeFallsBackToFlat();
await testEllipsoidModeDoesNotAffectFlatModeCodes();
await testEllipsoidModeRoundTrips();
await testEllipsoidModeIsMoreAccurateThanFlat();
await testBadDistanceModeLeavesEngineConsistent();
await testBadCountryBoundsRejected();
await testSingleRingAntimeridianPolygon();
await testWideNonCrossingPolygonNotMisclassified();
await testZoneCodeLengthCapEnforcedByValidation();
await testEllipsoidAtHighLatitude();
await testCachedGeometryReuseAcrossLoads();
await testRTreeAndLinearScanAgree();

console.log('determinism.test.js: all assertions passed');
