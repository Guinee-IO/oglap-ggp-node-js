// test.js — Full OGLAP engine test
import {
    // Init & state
    initOglap,
    loadOglap,
    checkOglap,
    getPackageVersion,
    getCountryProfile,
    getCountryCode,
    getCountrySW,
    getOglapPrefectures,
    getOglapPlaces,
    // Core functions
    parseLapCode,
    validateLapCode,
    getPlaceByLapCode,
    lapToCoordinates,
    coordinatesToLap,
    bboxFromGeometry,
    centroidFromBbox,
} from './oglap.js';

// ── Helpers ──
let passed = 0, failed = 0;
function section(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`); }
function log(label, value) { console.log(`  ${label}:`, value); }
function ok(label, value) { passed++; console.log(`  ✓ ${label}:`, value); }
function fail(label, value) { failed++; console.error(`  ✗ ${label}:`, value); }

// ══════════════════════════════════════════════════════════════
//  1. PRE-INIT STATE
// ══════════════════════════════════════════════════════════════
section('1. Pre-init state');

log('Package version', getPackageVersion());

const preCheck = checkOglap();
if (!preCheck.ok) ok('checkOglap() before init', preCheck.error);
else fail('checkOglap() should not be ok before init', preCheck);

// ══════════════════════════════════════════════════════════════
//  2. INIT (download mode)
// ══════════════════════════════════════════════════════════════
section('2. initOglap() — downloading latest');

const report = await initOglap({
    onProgress({ label, status, percent, step, totalSteps }) {
        if (status === 'downloading') {
            process.stdout.write(`\r  ↓ [${step}/${totalSteps}] ${label}: ${percent}%   `);
        } else if (status === 'cached') {
            console.log(`  ⚡ [${step}/${totalSteps}] ${label}: loaded from cache`);
        } else if (status === 'slow') {
            console.log(`\n  ⚠ Slow network detected for ${label}`);
        } else if (status === 'done') {
            console.log(`\r  ✓ [${step}/${totalSteps}] ${label}: done              `);
        } else if (status === 'error') {
            console.log(`\n  ✗ [${step}/${totalSteps}] ${label}: ERROR`);
        } else if (status === 'validating') {
            console.log(`  … Validating configuration`);
        }
    }
});

console.log('\n  --- Init report ---');
log('OK', report.ok);
log('Country', `${report.countryName} (${report.countryCode})`);
log('Bounds', report.bounds);
log('Data dir', report.dataDir);
if (report.dataLoaded) log('Places loaded', report.dataLoaded.message);
console.log('  --- Checks ---');
report.checks.forEach(c => {
    const icon = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
    console.log(`    ${icon} [${c.id}] ${c.message}`);
});

if (!report.ok) {
    fail('initOglap failed — cannot continue', report.error);
    process.exit(1);
}
ok('initOglap', 'success');

// ══════════════════════════════════════════════════════════════
//  3. STATE GETTERS
// ══════════════════════════════════════════════════════════════
section('3. State getters');

const postCheck = checkOglap();
postCheck.ok ? ok('checkOglap()', `ok, country=${postCheck.countryCode}`) : fail('checkOglap()', postCheck);

log('getCountryCode()', getCountryCode());
log('getCountrySW()', getCountrySW());

const profile = getCountryProfile();
log('getCountryProfile() schema', profile.schema_id);

const prefectures = getOglapPrefectures();
const prefKeys = Object.keys(prefectures);
log('getOglapPrefectures()', `${prefKeys.length} entries (first 5: ${prefKeys.slice(0, 5).join(', ')})`);

const places = getOglapPlaces();
log('getOglapPlaces()', `${places.length} places`);

// ══════════════════════════════════════════════════════════════
//  4. coordinatesToLap — encode GPS → LAP code
// ══════════════════════════════════════════════════════════════
section('4. coordinatesToLap — GPS → LAP');

const testCoords = [
    { name: 'Conakry center', lat: 9.5370, lon: -13.6785 },
    { name: 'Nzérékoré', lat: 7.7562, lon: -8.8179 },
    { name: 'Kankan', lat: 10.3854, lon: -9.3057 },
    { name: 'Labé', lat: 11.3183, lon: -12.2860 },
    { name: 'Kindia', lat: 10.0565, lon: -12.8665 },
];

const generatedLaps = [];
for (const { name, lat, lon } of testCoords) {
    try {
        const result = coordinatesToLap(lat, lon, places);
        if (result?.lapCode) {
            ok(`${name} (${lat}, ${lon})`, `${result.lapCode}  →  ${result.humanAddress}`);
            generatedLaps.push({ name, lat, lon, lap: result.lapCode, result });
        } else {
            fail(`${name} (${lat}, ${lon})`, 'returned null/undefined');
        }
    } catch (err) {
        fail(`${name} (${lat}, ${lon})`, err.message);
    }
}

// ══════════════════════════════════════════════════════════════
//  4b. coordinatesToLap — National grid (fallback for admin_level < 9)
// ══════════════════════════════════════════════════════════════
section('4b. coordinatesToLap — National grid');

const nationalTestCoords = [
    { name: 'Rural Siguiri (Kankan)', lat: 11.70, lon: -9.30 },
    { name: 'Rural Macenta (Nzérékoré)', lat: 8.40, lon: -9.40 },
    { name: 'Rural Boké (Boké)', lat: 11.20, lon: -14.20 },
    { name: 'Rural Faranah (Faranah)', lat: 10.10, lon: -10.80 },
];

const generatedNationalLaps = [];
for (const { name, lat, lon } of nationalTestCoords) {
    try {
        const result = coordinatesToLap(lat, lon, places);
        if (result?.lapCode) {
            if (result.isNationalGrid) {
                ok(`${name} (${lat}, ${lon})`, `${result.lapCode}  →  ${result.humanAddress}  [NATIONAL]`);
            } else {
                ok(`${name} (${lat}, ${lon})`, `${result.lapCode}  →  ${result.humanAddress}  [LOCAL — zone found]`);
            }
            generatedNationalLaps.push({ name, lat, lon, lap: result.lapCode, result });
        } else {
            fail(`${name} (${lat}, ${lon})`, 'returned null/undefined');
        }
    } catch (err) {
        fail(`${name} (${lat}, ${lon})`, err.message);
    }
}

// Verify at least one is actually national grid
const nationalCount = generatedNationalLaps.filter(g => g.result.isNationalGrid).length;
if (nationalCount > 0) {
    ok('National grid coverage', `${nationalCount}/${generatedNationalLaps.length} used national grid`);
} else {
    fail('National grid coverage', 'None of the test coordinates triggered national grid fallback — adjust coordinates');
}

// Merge into generatedLaps for sections 5-10
generatedLaps.push(...generatedNationalLaps);

// ══════════════════════════════════════════════════════════════
//  4c. coordinatesToLap — Out-of-bounds rejection
// ══════════════════════════════════════════════════════════════
section('4c. coordinatesToLap — Out-of-bounds rejection');

const outOfBoundsCoords = [
    // Far away — caught by bbox
    { name: 'Dakar, Senegal', lat: 14.6928, lon: -17.4467 },
    { name: 'Atlantic Ocean', lat: 9.00, lon: -18.00 },
    // Inside bbox but outside Guinea polygon — caught by country border check
    { name: 'Bamako, Mali', lat: 12.6392, lon: -8.0029 },
    { name: 'Freetown, Sierra Leone', lat: 8.4657, lon: -13.2317 },
    // Tricky: neighboring countries very close to Guinea border
    { name: 'Bissau, Guinea-Bissau', lat: 11.8617, lon: -15.5977 },
    { name: 'Monrovia, Liberia', lat: 6.3156, lon: -10.8074 },
    { name: 'Kédougou, Senegal (near GN border)', lat: 12.5605, lon: -12.1747 },
];

for (const { name, lat, lon } of outOfBoundsCoords) {
    try {
        const result = coordinatesToLap(lat, lon, places);
        if (result === null) {
            ok(`${name} (${lat}, ${lon})`, 'correctly rejected — outside country bounds');
        } else {
            fail(`${name} (${lat}, ${lon})`, `should be null but got ${result.lapCode}`);
        }
    } catch (err) {
        fail(`${name} (${lat}, ${lon})`, err.message);
    }
}

// ══════════════════════════════════════════════════════════════
//  5. parseLapCode — parse a LAP code into segments
// ══════════════════════════════════════════════════════════════
section('5. parseLapCode');

for (const { name, lap } of generatedLaps) {
    try {
        const parsed = parseLapCode(lap);
        parsed ? ok(`parse "${lap}"`, JSON.stringify(parsed)) : fail(`parse "${lap}"`, 'returned null');
    } catch (err) {
        fail(`parse "${lap}"`, err.message);
    }
}

// ══════════════════════════════════════════════════════════════
//  6. validateLapCode
// ══════════════════════════════════════════════════════════════
section('6. validateLapCode');

for (const { lap } of generatedLaps) {
    try {
        const result = validateLapCode(lap);
        // null = valid (no error), string = error message
        result === null ? ok(`validate "${lap}"`, 'valid') : fail(`validate "${lap}"`, result);
    } catch (err) {
        fail(`validate "${lap}"`, err.message);
    }
}

// Test with an invalid code — should return an error string
try {
    const bad = validateLapCode('QQ-ZZZ-GARBAGE');
    bad ? ok('validate invalid "QQ-ZZZ-GARBAGE"', bad) : fail('validate invalid should return error string', 'got null');
} catch (err) {
    ok('validate invalid throws', err.message);
}

// ══════════════════════════════════════════════════════════════
//  7. lapToCoordinates — decode LAP → GPS
// ══════════════════════════════════════════════════════════════
section('7. lapToCoordinates — LAP → GPS');

// lapToCoordinates(lapCode) — just pass the LAP code string
for (const { name, lat, lon, lap, result: encResult } of generatedLaps) {
    try {
        const parsed = parseLapCode(lap);
        const grid = parsed.isNationalGrid ? 'national' : 'local';
        const coords = lapToCoordinates(lap);
        if (coords) {
            const dist = Math.sqrt((coords.lat - lat) ** 2 + (coords.lon - lon) ** 2);
            ok(`decode "${lap}" [${grid}]`, `lat=${coords.lat.toFixed(6)}, lon=${coords.lon.toFixed(6)} (Δ≈${(dist * 111320).toFixed(1)}m from original)`);
        } else {
            fail(`decode "${lap}" [${grid}]`, 'returned null');
        }
    } catch (err) {
        fail(`decode "${lap}"`, err.message);
    }
}

// Test without country prefix (strip "GN-" from a code)
try {
    const sampleLap = generatedLaps[0]?.lap;
    if (sampleLap && sampleLap.startsWith(getCountryCode() + '-')) {
        const withoutCC = sampleLap.slice(getCountryCode().length + 1);
        const coords = lapToCoordinates(withoutCC);
        coords ? ok(`decode without CC "${withoutCC}"`, `lat=${coords.lat.toFixed(6)}, lon=${coords.lon.toFixed(6)}`)
               : fail(`decode without CC "${withoutCC}"`, 'returned null');
    }
} catch (err) {
    fail('decode without CC', err.message);
}

// ══════════════════════════════════════════════════════════════
//  8. getPlaceByLapCode — look up place from LAP code
// ══════════════════════════════════════════════════════════════
section('8. getPlaceByLapCode');

for (const { lap } of generatedLaps) {
    try {
        // getPlaceByLapCode returns { place, parsed, originLat?, originLon? }
        const match = getPlaceByLapCode(lap);
        if (match?.place) {
            const addr = match.place.address || {};
            const pName = addr.village || addr.town || addr.city || addr.suburb || '(unnamed)';
            ok(`lookup "${lap}"`, `place_id=${match.place.place_id}, name="${pName}"`);
        } else if (match) {
            ok(`lookup "${lap}"`, `matched (parsed: ${JSON.stringify(match.parsed)}, no place — likely national grid)`);
        } else {
            log(`lookup "${lap}"`, 'no match found');
        }
    } catch (err) {
        fail(`lookup "${lap}"`, err.message);
    }
}

// ══════════════════════════════════════════════════════════════
//  9. bboxFromGeometry & centroidFromBbox
// ══════════════════════════════════════════════════════════════
section('9. bboxFromGeometry & centroidFromBbox');

const samplePlace = places.find(p => p.geojson?.type === 'Polygon' || p.geojson?.type === 'MultiPolygon');
if (samplePlace) {
    try {
        const bbox = bboxFromGeometry(samplePlace.geojson);
        ok('bboxFromGeometry', JSON.stringify(bbox));

        const centroid = centroidFromBbox(bbox);
        ok('centroidFromBbox', JSON.stringify(centroid));
    } catch (err) {
        fail('bboxFromGeometry/centroidFromBbox', err.message);
    }
} else {
    log('skip', 'no polygon geometry found in places');
}

// ══════════════════════════════════════════════════════════════
//  10. Round-trip: encode → decode → re-encode
// ══════════════════════════════════════════════════════════════
section('10. Round-trip consistency');

for (const { name, lat, lon, lap, result: encResult } of generatedLaps) {
    try {
        const parsed = parseLapCode(lap);
        const grid = parsed.isNationalGrid ? 'national' : 'local';
        const decoded = lapToCoordinates(lap);
        if (!decoded) { fail(`round-trip ${name} [${grid}]`, 'decode returned null'); continue; }
        const reResult = coordinatesToLap(decoded.lat, decoded.lon, places);
        const reEncoded = reResult?.lapCode;
        if (reEncoded === lap) {
            ok(`${name} [${grid}]: encode→decode→encode`, `${lap} ✓`);
        } else {
            fail(`${name} [${grid}]: encode→decode→encode`, `${lap} → (${decoded.lat},${decoded.lon}) → ${reEncoded}`);
        }
    } catch (err) {
        fail(`round-trip ${name}`, err.message);
    }
}

// ══════════════════════════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════════════════════════
section('SUMMARY');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
