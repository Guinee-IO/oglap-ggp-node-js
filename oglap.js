/**
 * @file oglap.js
 * @description OGLAP Protocol Core Logic.
 * @version 0.1.0
 * This module strictly adheres to the Global Grid Protocol (GGP) specifications,
 * converting geographic coordinates into human-readable, deterministic alphanumeric
 * OGLAP codes (e.g., GN-CKY-QKPC-B4A4-2798 / GN-CKY-QFEAA4-2798), and vice versa.
 *
 * Security & Performance notes:
 * - O(N) spatial lookups optimized via internal object geometry caching (`_computedBbox`, `_computedArea`).
 * - Regex operations safely scoped to bounded string inputs to prevent ReDoS.
 * - Entire dataset runs statically in memory, suitable for clientside or serverless environments.
 *
 * @module OGLAP
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import area from '@turf/area';

// --- PACKAGE IDENTITY ---
const PACKAGE_VERSION = '0.1.0';

// --- INITIALIZATION STATE ---
let _initialized = false;
let _initReport = null;

// --- INITIAL STATE ---
let COUNTRY_PROFILE = {};
let COUNTRY_CODE = 'GN';

/**
 * Creates a flat key-value map from a complex profile table extracting 'oglap_code'.
 * @param {Object} table - The profile table containing deeply nested code entries.
 * @returns {Object<string, string>} A map of ISO codes to OGLAP codes.
 */
function mapFromCodeTable(table = {}) {
  return Object.fromEntries(
    Object.entries(table)
      .map(([iso, entry]) => [iso, entry?.oglap_code])
      .filter(([, code]) => typeof code === 'string' && code.trim())
  );
}

let OGLAP_COUNTRY_REGIONS = {};
let OGLAP_COUNTRY_REGIONS_REVERSE = {};
let OGLAP_COUNTRY_PREFECTURES = {};

/** @type {Map<string|number, string>} Cache mapping place_id to specific zone codes */
let OGLAP_ZONE_CODES_BY_ID = new Map();

let ZONE_TYPE_PREFIX_DEFAULT = 'Z';
let ZONE_TYPE_PREFIX = {};
let GGP_STOPWORDS = new Set();
let GGP_PAD_CHAR = 'X';
let COUNTRY_SW = [0, 0];
let COUNTRY_BOUNDS = { sw: [7.19, -15.37], ne: [12.68, -7.64] };
/** @type {Object|null} Cached country border polygon (admin_level 2) for boundary checks */
let COUNTRY_BORDER_GEOJSON = null;
let METERS_PER_DEGREE_LAT = 111320;

/** @returns {string} Current OGLAP package version */
export function getPackageVersion() { return PACKAGE_VERSION; }
/** @returns {Object} Current active country profile */
export function getCountryProfile() { return COUNTRY_PROFILE; }
/** @returns {string} 2-letter Country OGLAP code (e.g. "GN") */
export function getCountryCode() { return COUNTRY_CODE; }
/** @returns {number[]} The SW boundary constraint [Lat, Lon] for the country */
export function getCountrySW() { return COUNTRY_SW; }
/** @returns {Object<string, string>} A map of Prefectures codes */
export function getOglapPrefectures() { return OGLAP_COUNTRY_PREFECTURES; }

/**
 * Quick status check. Returns the last init report, or a not-initialized stub if never called.
 * @returns {{ ok: boolean, checks: Array, error: string|null, countryCode: string|null, countryName: string|null, bounds: number[][]|null }}
 */
export function checkOglap() {
  if (_initReport) return _initReport;
  return { ok: false, countryCode: null, countryName: null, bounds: null, checks: [], error: 'initOglap has not been called yet.' };
}

// --- SEMVER HELPERS ---

/**
 * Parses a semver string "MAJOR.MINOR.PATCH" into [major, minor, patch].
 * Returns null if the string is not a valid semver.
 */
function parseSemver(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Checks if `version` satisfies the caret range `^range`.
 * ^MAJOR.MINOR.PATCH means >=MAJOR.MINOR.PATCH and <(MAJOR+1).0.0 (when MAJOR>0).
 * ^0.MINOR.PATCH means >=0.MINOR.PATCH and <0.(MINOR+1).0 (when MAJOR=0).
 */
function satisfiesCaret(version, range) {
  const v = parseSemver(version);
  const r = parseSemver(range);
  if (!v || !r) return false;
  // version must be >= range
  for (let i = 0; i < 3; i++) {
    if (v[i] > r[i]) break;
    if (v[i] < r[i]) return false;
  }
  // version must be < next breaking change
  if (r[0] > 0) return v[0] === r[0];
  if (r[1] > 0) return v[0] === 0 && v[1] === r[1];
  return v[0] === 0 && v[1] === 0 && v[2] === r[2];
}

// --- REMOTE DATA ---
const OGLAP_S3_BASE = 'https://s3.guinee.io/oglap/ggp';
const OGLAP_REMOTE_FILES = [
  { key: 'profile', name: 'gn_oglap_country_profile.json', label: 'Country profile', timeoutMs: 30000 },
  { key: 'localities', name: 'gn_localities_naming.json', label: 'Localities naming', timeoutMs: 60000 },
  { key: 'data', name: 'gn_full.json', label: 'Places database', timeoutMs: 300000 },
];
const _SLOW_BPS = 50 * 1024; // 50 KB/s
const _SLOW_WINDOW_MS = 5000;

// --- LOCAL DATA STORAGE ---
const OGLAP_DATA_DIR_DEFAULT = 'oglap-data';

/** @private Lazily loaded Node.js modules for file I/O. */
let _fsmod = null;
let _pathmod = null;

/**
 * Dynamically imports Node.js fs and path modules.
 * Only called in download mode — has no effect on browser-only (direct mode) usage.
 * @private
 * @returns {Promise<{ fs: object, path: object }>}
 */
async function _getNodeModules() {
  if (_fsmod && _pathmod) return { fs: _fsmod, path: _pathmod };
  try {
    _fsmod = await import('node:fs/promises');
    _pathmod = await import('node:path');
    // Handle default exports when behind an ESM wrapper
    if (_fsmod.default && typeof _fsmod.default.mkdir === 'function') _fsmod = _fsmod.default;
    if (_pathmod.default && typeof _pathmod.default.resolve === 'function') _pathmod = _pathmod.default;
    return { fs: _fsmod, path: _pathmod };
  } catch {
    throw new Error('File system access requires a Node.js-compatible runtime (Node, Bun, Deno).');
  }
}

/**
 * Creates a directory recursively if it doesn't exist.
 * @private
 */
async function _ensureDir(dirPath) {
  const { fs } = await _getNodeModules();
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Checks whether a file exists at the given path.
 * @private
 */
async function _fileExists(filePath) {
  const { fs } = await _getNodeModules();
  try { await fs.access(filePath); return true; } catch { return false; }
}

/**
 * Reads and JSON-parses a file from disk.
 * @private
 */
async function _readJsonFile(filePath) {
  const { fs } = await _getNodeModules();
  const text = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(text);
}

/**
 * Writes text content to a file on disk.
 * @private
 */
async function _writeFile(filePath, content) {
  const { fs } = await _getNodeModules();
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Fetch URL with streaming progress, slow-network detection, and timeout.
 * @private
 * @param {string} url
 * @param {{ onChunk?: Function, timeoutMs?: number }} opts
 * @returns {Promise<string>} Response body as text.
 */
async function _fetchWithProgress(url, { onChunk, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError'
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s`
      : `Network error: ${err.message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  // Fallback for environments without streaming
  if (!res.body?.getReader) {
    const text = await res.text();
    clearTimeout(timer);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, winStart = Date.now(), winBytes = 0;
  for (; ;) {
    let rd;
    try { rd = await reader.read(); } catch (e) { clearTimeout(timer); throw new Error(`Download interrupted: ${e.message}`); }
    if (rd.done) break;
    chunks.push(rd.value);
    loaded += rd.value.length;
    winBytes += rd.value.length;
    const now = Date.now(), elapsed = now - winStart;
    let slow = false;
    if (elapsed >= _SLOW_WINDOW_MS) {
      slow = (winBytes / elapsed) * 1000 < _SLOW_BPS;
      winStart = now; winBytes = 0;
    }
    if (onChunk) onChunk({ loaded, total, percent: total ? Math.round((loaded / total) * 1000) / 10 : 0, slow });
  }
  clearTimeout(timer);
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder().decode(buf);
}

// --- INIT VALIDATION ---

/**
 * Validates profile and localities naming, applies engine state if valid.
 * @private
 */
function _validateAndApply(profile, localitiesNaming, priorChecks = []) {
  const checks = [...priorChecks];
  let fatal = false;

  function pass(id, msg) { checks.push({ id, status: 'pass', message: msg }); }
  function warn(id, msg) { checks.push({ id, status: 'warn', message: msg }); }
  function fail(id, msg) { checks.push({ id, status: 'fail', message: msg }); fatal = true; }

  // ── 1. Profile presence & schema ──────────────────────────────────
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('profile.present', 'Country profile is missing or not a valid object.');
    return { ok: false, countryCode: null, countryName: null, bounds: null, checks, error: 'Country profile is missing.' };
  }
  pass('profile.present', 'Country profile loaded.');

  const profileSchema = profile.schema_id;
  if (profileSchema !== 'oglap.country_profile.v2') {
    fail('profile.schema', `Expected schema "oglap.country_profile.v2", got "${profileSchema || '(none)'}".`);
  } else {
    pass('profile.schema', `Profile schema: ${profileSchema}`);
  }

  // ── 2. Profile required fields ────────────────────────────────────
  const meta = profile.meta;
  if (!meta?.country_oglap_code && !meta?.iso_alpha_2) {
    fail('profile.meta.country_code', 'Profile meta missing both country_oglap_code and iso_alpha_2.');
  } else {
    pass('profile.meta.country_code', `Country code: ${meta.country_oglap_code || meta.iso_alpha_2}`);
  }

  if (!profile.country_extent?.country_sw || !profile.country_extent?.country_bounds) {
    fail('profile.country_extent', 'Profile missing country_extent (country_sw or country_bounds).');
  } else {
    pass('profile.country_extent', 'Country extent defined.');
  }

  if (!profile.grid_settings) {
    fail('profile.grid_settings', 'Profile missing grid_settings section.');
  } else {
    pass('profile.grid_settings', 'Grid settings present.');
  }

  if (!profile.zone_naming?.type_prefix_map) {
    fail('profile.zone_naming', 'Profile missing zone_naming.type_prefix_map.');
  } else {
    pass('profile.zone_naming', `Zone naming rules loaded (${Object.keys(profile.zone_naming.type_prefix_map).length} type prefixes).`);
  }

  // ── 3. Package version compatibility ──────────────────────────────
  const compat = profile.compatibility;
  if (!compat) {
    warn('profile.compatibility', 'Profile has no compatibility section — skipping version checks.');
  } else {
    const range = compat.oglap_package_range;
    if (!range || typeof range !== 'string') {
      warn('compat.package_range', 'No oglap_package_range specified in profile — skipping package version check.');
    } else {
      const rangeBase = range.replace(/^\^/, '');
      if (satisfiesCaret(PACKAGE_VERSION, rangeBase)) {
        pass('compat.package_range', `Package v${PACKAGE_VERSION} satisfies required range "${range}".`);
      } else {
        fail('compat.package_range', `Package v${PACKAGE_VERSION} does NOT satisfy required range "${range}". Update the OGLAP package or use a compatible profile.`);
      }
    }
  }

  // ── 4. Localities naming presence & schema ────────────────────────
  if (!localitiesNaming || typeof localitiesNaming !== 'object' || Array.isArray(localitiesNaming)) {
    fail('localities.present', 'Localities naming data is missing or not a valid object.');
    return { ok: false, countryCode: null, countryName: null, bounds: null, checks, error: 'Localities naming data is missing.' };
  }
  pass('localities.present', 'Localities naming data loaded.');

  const locSchema = localitiesNaming.schema_id;
  if (locSchema !== 'oglap.localities_naming.v1') {
    fail('localities.schema', `Expected localities schema "oglap.localities_naming.v1", got "${locSchema || '(none)'}".`);
  } else {
    pass('localities.schema', `Localities schema: ${locSchema}`);
  }

  // ── 5. Country code alignment ─────────────────────────────────────
  const profileCountry = meta?.country_oglap_code || meta?.iso_alpha_2;
  const locCountry = localitiesNaming.country;
  if (profileCountry && locCountry && profileCountry !== locCountry) {
    fail('compat.country_match', `Country mismatch: profile="${profileCountry}", localities="${locCountry}".`);
  } else if (profileCountry && locCountry) {
    pass('compat.country_match', `Country codes match: "${profileCountry}".`);
  }

  // ── 6. Dataset version compatibility ──────────────────────────────
  const datasetVersions = compat?.dataset_versions;
  const locGeneratedAt = localitiesNaming.generated_at;
  if (!datasetVersions || !Array.isArray(datasetVersions) || datasetVersions.length === 0) {
    warn('compat.dataset_version', 'Profile has no dataset_versions list — skipping dataset compatibility check.');
  } else if (!locGeneratedAt) {
    fail('compat.dataset_version', 'Localities naming has no generated_at timestamp — cannot verify dataset compatibility.');
  } else if (!datasetVersions.includes(locGeneratedAt)) {
    fail('compat.dataset_version', `Localities naming timestamp "${locGeneratedAt}" is not in profile's compatible dataset_versions [${datasetVersions.join(', ')}].`);
  } else {
    pass('compat.dataset_version', `Localities naming dataset version "${locGeneratedAt}" is compatible with profile.`);
  }

  // ── 7. Localities naming references expected source db ────────────
  const locSource = localitiesNaming.source;
  if (!locSource) {
    warn('localities.source', 'Localities naming has no source field — cannot verify which gn_full database was used.');
  } else {
    pass('localities.source', `Localities naming was generated from source: "${locSource}".`);
  }

  // ── 8. Localities naming structural check (admin levels) ──────────
  const hasL4 = localitiesNaming.level_4_regions && Object.keys(localitiesNaming.level_4_regions).length > 0;
  const hasL6 = localitiesNaming.level_6_prefectures && Object.keys(localitiesNaming.level_6_prefectures).length > 0;
  const hasZones = (
    (localitiesNaming.level_8_sous_prefectures && Object.keys(localitiesNaming.level_8_sous_prefectures).length > 0) ||
    (localitiesNaming.level_9_villages && Object.keys(localitiesNaming.level_9_villages).length > 0) ||
    (localitiesNaming.level_10_quartiers && Object.keys(localitiesNaming.level_10_quartiers).length > 0)
  );
  if (!hasL4) {
    fail('localities.level_4', 'Localities naming has no level_4_regions entries — regions cannot be resolved.');
  } else {
    pass('localities.level_4', `Level 4 regions: ${Object.keys(localitiesNaming.level_4_regions).length} entries.`);
  }
  if (!hasL6) {
    warn('localities.level_6', 'Localities naming has no level_6_prefectures — prefecture resolution will use fallbacks.');
  } else {
    pass('localities.level_6', `Level 6 prefectures: ${Object.keys(localitiesNaming.level_6_prefectures).length} entries.`);
  }
  if (!hasZones) {
    warn('localities.zones', 'Localities naming has no zone entries (levels 8/9/10) — local grid addressing will be unavailable.');
  } else {
    const count =
      Object.keys(localitiesNaming.level_8_sous_prefectures || {}).length +
      Object.keys(localitiesNaming.level_9_villages || {}).length +
      Object.keys(localitiesNaming.level_10_quartiers || {}).length;
    pass('localities.zones', `Zone entries (levels 8/9/10): ${count} total.`);
  }

  // ── If any fatal check failed, abort before applying state ────────
  if (fatal) {
    return {
      ok: false,
      countryCode: profileCountry || null,
      countryName: meta?.country_name || null,
      bounds: null,
      checks,
      error: checks.filter(c => c.status === 'fail').map(c => c.message).join(' ')
    };
  }

  // ── All checks passed — apply state ───────────────────────────────
  COUNTRY_PROFILE = profile;
  COUNTRY_CODE = profileCountry || 'GN';

  OGLAP_COUNTRY_REGIONS = mapFromCodeTable(localitiesNaming.level_4_regions);

  OGLAP_COUNTRY_REGIONS_REVERSE = Object.fromEntries(
    Object.entries(OGLAP_COUNTRY_REGIONS).map(([iso, code]) => [code, iso])
  );

  OGLAP_COUNTRY_PREFECTURES = mapFromCodeTable(localitiesNaming.level_6_prefectures);

  // Cache zone codes by ID (levels 8, 9, 10)
  OGLAP_ZONE_CODES_BY_ID.clear();
  const zones = [
    ...(Object.values(localitiesNaming.level_8_sous_prefectures || {})),
    ...(Object.values(localitiesNaming.level_9_villages || {})),
    ...(Object.values(localitiesNaming.level_10_quartiers || {}))
  ];
  for (const z of zones) {
    if (z.place_id && z.oglap_code) {
      OGLAP_ZONE_CODES_BY_ID.set(z.place_id.toString(), z.oglap_code);
      OGLAP_ZONE_CODES_BY_ID.set(Number(z.place_id), z.oglap_code);
    }
  }

  const { default: defaultZone = 'Z', ...prefixMap } = profile.zone_naming?.type_prefix_map || {};
  ZONE_TYPE_PREFIX_DEFAULT = defaultZone;
  ZONE_TYPE_PREFIX = prefixMap;

  GGP_STOPWORDS = new Set(
    (profile.zone_naming?.stopwords || []).map((s) => String(s).toUpperCase())
  );
  GGP_PAD_CHAR = profile.zone_naming?.padding_char || 'X';

  COUNTRY_SW = profile.country_extent?.country_sw || [7.19, -15.37];
  COUNTRY_BOUNDS = {
    sw: profile.country_extent?.country_bounds?.sw || [7.19, -15.37],
    ne: profile.country_extent?.country_bounds?.ne || [12.68, -7.64],
  };
  METERS_PER_DEGREE_LAT = profile.grid_settings?.distance_conversion?.meters_per_degree_lat || 111320;

  const boundsArr = [COUNTRY_BOUNDS.sw, COUNTRY_BOUNDS.ne];

  return {
    ok: true,
    countryCode: COUNTRY_CODE,
    countryName: meta?.country_name || 'Country',
    bounds: boundsArr,
    checks,
    error: null
  };
}

/**
 * Initialize the OGLAP engine.
 *
 * **Download mode** (recommended for standalone use):
 * Downloads required files from S3, saves them to a local `oglap-data/{version}/`
 * folder, and loads them into the engine. On subsequent calls, files are loaded
 * directly from the local cache (skipping the download) unless `forceDownload` is set.
 * ```js
 * // Simplest — downloads latest version:
 * const report = await initOglap();
 *
 * // With options:
 * const report = await initOglap({
 *   version: 'v1.0.0',         // pin a specific version (default: 'latest')
 *   dataDir: './oglap-data',    // local cache folder (default)
 *   forceDownload: false,       // set true to re-download even if cached
 *   onProgress: ({ label, step, totalSteps, percent, status }) => { ... }
 * });
 * ```
 *
 * **Direct mode** (when data is already loaded in memory):
 * ```js
 * const report = await initOglap(profileObj, localitiesNamingObj);
 * // then load places separately:
 * loadOglap(placesArray);
 * ```
 *
 * @param {Object} [profileOrOptions] - Country profile object (direct mode), options hash (download mode), or omit for latest.
 * @param {string} [profileOrOptions.version='latest'] - Dataset version to fetch (e.g. 'latest', 'v1.0.0').
 * @param {string} [profileOrOptions.dataDir='oglap-data'] - Local folder for cached data files.
 * @param {boolean} [profileOrOptions.forceDownload=false] - Re-download all files even if they exist locally.
 * @param {string} [profileOrOptions.baseUrl] - Override the S3 base URL.
 * @param {Function} [profileOrOptions.onProgress] - Progress callback.
 * @param {Object} [localitiesNaming] - Localities naming object (direct mode only).
 * @returns {Promise<{ ok: boolean, countryCode: string|null, countryName: string|null, bounds: number[][]|null, checks: Array, error: string|null, dataDir?: string, dataLoaded?: Object }>}
 */
export async function initOglap(profileOrOptions, localitiesNaming) {
  _initialized = false;
  _initReport = null;

  // ── Direct mode: initOglap(profileObj, localitiesObj) ──
  const isDirect = localitiesNaming !== undefined ||
    (profileOrOptions != null && typeof profileOrOptions === 'object' && 'schema_id' in profileOrOptions);

  if (isDirect) {
    const report = _validateAndApply(profileOrOptions, localitiesNaming);
    _initialized = report.ok;
    _initReport = report;
    return report;
  }

  // ── Download mode: initOglap({ version, onProgress, baseUrl, dataDir, forceDownload }) ──
  const opts = profileOrOptions || {};
  const version = opts.version || 'latest';
  const baseUrl = opts.baseUrl || OGLAP_S3_BASE;
  const dataDir = opts.dataDir || OGLAP_DATA_DIR_DEFAULT;
  const forceDownload = !!opts.forceDownload;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
  const vUrl = `${baseUrl}/${version}`;
  const checks = [];
  const loaded = {};

  // ── Resolve & create local data directory: oglap-data/{version}/ ──
  let versionDir;
  try {
    const { path } = await _getNodeModules();
    versionDir = path.resolve(dataDir, version);
    await _ensureDir(versionDir);
    checks.push({ id: 'storage.dir', status: 'pass', message: `Data directory ready: ${versionDir}` });
  } catch (err) {
    checks.push({ id: 'storage.dir', status: 'fail', message: `Cannot create data directory: ${err.message}` });
    _initReport = { ok: false, countryCode: null, countryName: null, bounds: null, checks, error: checks.at(-1).message };
    return _initReport;
  }

  // ── Helper: get a file — from local cache or download + save ──
  async function getFile(fileSpec, step, totalSteps) {
    const { path } = await _getNodeModules();
    const filePath = path.join(versionDir, fileSpec.name);

    // Try local cache first (unless forced)
    if (!forceDownload && await _fileExists(filePath)) {
      onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps, status: 'cached', loaded: 0, total: 0, percent: 100 });
      try {
        const parsed = await _readJsonFile(filePath);
        checks.push({ id: `local.${fileSpec.key}`, status: 'pass', message: `${fileSpec.label}: loaded from local cache.` });
        return parsed;
      } catch (readErr) {
        // Local file corrupted — fall through to re-download
        checks.push({ id: `local.${fileSpec.key}`, status: 'warn', message: `Local ${fileSpec.label} is invalid (${readErr.message}), re-downloading.` });
      }
    }

    // Download from S3
    let slowNotified = false;
    onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps, status: 'downloading', loaded: 0, total: 0, percent: 0 });
    const text = await _fetchWithProgress(`${vUrl}/${fileSpec.name}`, {
      timeoutMs: fileSpec.timeoutMs,
      onChunk({ loaded: ld, total: tot, percent: pct, slow }) {
        if (slow && !slowNotified) {
          slowNotified = true;
          onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps, status: 'slow', loaded: ld, total: tot, percent: pct });
        }
        onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps, status: 'downloading', loaded: ld, total: tot, percent: pct });
      },
    });

    // Parse JSON
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`Invalid JSON in ${fileSpec.name}: ${e.message}`); }

    // Save to local cache
    try {
      await _writeFile(filePath, text);
      checks.push({ id: `save.${fileSpec.key}`, status: 'pass', message: `${fileSpec.label}: downloaded and saved to ${filePath}` });
    } catch (saveErr) {
      checks.push({ id: `save.${fileSpec.key}`, status: 'warn', message: `${fileSpec.label}: downloaded but failed to save locally (${saveErr.message}).` });
    }

    onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps, status: 'done', loaded: 0, total: 0, percent: 100 });
    return parsed;
  }

  // ── Helper: report file retrieval failure ──
  function fileFail(fileSpec, step, err) {
    onProgress({ file: fileSpec.name, label: fileSpec.label, step, totalSteps: 3, status: 'error', loaded: 0, total: 0, percent: 0, error: err.message });
    checks.push({ id: `fetch.${fileSpec.key}`, status: 'fail', message: `Failed to get ${fileSpec.label}: ${err.message}` });
    _initReport = { ok: false, countryCode: null, countryName: null, bounds: null, checks, error: checks.at(-1).message, dataDir: versionDir };
    return _initReport;
  }

  // Step 1/3: Country profile
  try {
    loaded.profile = await getFile(OGLAP_REMOTE_FILES[0], 1, 3);
  } catch (err) {
    return fileFail(OGLAP_REMOTE_FILES[0], 1, err);
  }

  // Step 2/3: Localities naming
  try {
    loaded.localities = await getFile(OGLAP_REMOTE_FILES[1], 2, 3);
  } catch (err) {
    return fileFail(OGLAP_REMOTE_FILES[1], 2, err);
  }

  // Validate profile + localities before fetching the large data file
  onProgress({ file: '', label: 'Validating configuration', step: 0, totalSteps: 0, status: 'validating', loaded: 0, total: 0, percent: 0 });
  const report = _validateAndApply(loaded.profile, loaded.localities, checks);
  if (!report.ok) {
    _initReport = report;
    report.dataDir = versionDir;
    return report;
  }
  _initialized = true;

  // Step 3/3: Places database (large file)
  try {
    loaded.data = await getFile(OGLAP_REMOTE_FILES[2], 3, 3);
  } catch (err) {
    const f = OGLAP_REMOTE_FILES[2];
    onProgress({ file: f.name, label: f.label, step: 3, totalSteps: 3, status: 'error', loaded: 0, total: 0, percent: 0, error: err.message });
    report.checks.push({ id: `fetch.${f.key}`, status: 'fail', message: `Failed to get ${f.label}: ${err.message}` });
    report.ok = false;
    report.error = `Failed to get ${f.label}: ${err.message}`;
    report.dataDir = versionDir;
    _initReport = report;
    return report;
  }

  // Load places into engine
  const loadResult = loadOglap(loaded.data);
  report.checks.push({ id: 'data.load', status: loadResult.ok ? 'pass' : 'fail', message: loadResult.message });
  if (!loadResult.ok) {
    report.ok = false;
    report.error = loadResult.message;
  }
  report.dataLoaded = loadResult;
  report.dataDir = versionDir;
  _initReport = report;
  return report;
}

// --- DATA & CACHE ---
let places = [];
let lapSearchIndex = null;
let upperAdminLetterCache = new Map();
let adminLevel6PlacesCache = null;

/**
 * Loads geojson places into the in-memory engine. Clears existing search and geometry caches.
 * Validates that initOglap was called first, and that data is a non-empty array
 * of objects with the expected shape (place_id, geojson or address).
 *
 * @param {Array<Object>} data - Array of place objects from OGLAP source (e.g. gn_full.json).
 * @returns {{ ok: boolean, count: number, message: string }}
 */
export function loadOglap(data) {
  lapSearchIndex = null;
  upperAdminLetterCache.clear();
  adminLevel6PlacesCache = null;

  if (!_initialized) {
    places = [];
    return { ok: false, count: 0, message: 'Cannot load data: initOglap must be called first with a valid profile and localities naming.' };
  }
  if (!Array.isArray(data)) {
    places = [];
    return { ok: false, count: 0, message: 'Data must be an array of place objects.' };
  }
  if (data.length === 0) {
    places = [];
    return { ok: false, count: 0, message: 'Data array is empty — no places to load.' };
  }

  // Spot-check: first entry should look like a place object
  const sample = data[0];
  if (typeof sample !== 'object' || sample === null) {
    places = [];
    return { ok: false, count: 0, message: 'Data entries are not valid objects.' };
  }
  const hasGeometry = !!sample.geojson;
  const hasAddress = !!sample.address;
  const hasPlaceId = sample.place_id != null;
  if (!hasPlaceId && !hasGeometry && !hasAddress) {
    places = [];
    return { ok: false, count: 0, message: 'Data entries do not appear to be OGLAP place objects (missing place_id, geojson, and address).' };
  }

  places = data;

  // Cache the country border polygon (admin_level 2) for boundary checks
  COUNTRY_BORDER_GEOJSON = null;
  const countryPlace = data.find(p =>
    (p.extratags?.admin_level === '2' || p.extratags?.admin_level === 2) &&
    (p.geojson?.type === 'Polygon' || p.geojson?.type === 'MultiPolygon')
  );
  if (countryPlace) {
    COUNTRY_BORDER_GEOJSON = countryPlace.geojson;
  }

  const withGeometry = data.filter(p => p.geojson).length;
  return {
    ok: true,
    count: data.length,
    message: `Loaded ${data.length} places (${withGeometry} with geometry).`
  };
}

/**
 * Retrieves the currently loaded geography places.
 * @returns {Array<Object>}
 */
export function getOglapPlaces() { return places; }

// ——— Grid & reference stability (basemap- and language-independent) ———
// - Origin: zone bbox SW from our reference data (gn_full.json), never from map tiles or labels.
// - Meters per degree: fixed WGS84 approximation (111320, 111320*cos(lat)); same everywhere.
// - ADMIN_LEVEL_2/ADMIN_LEVEL_3 codes: from OGLAP-GN tables + GGP naming rules applied to our data only.
// - LAP codes are therefore stable regardless of which basemap is shown or its language.


function metersPerDegreeLat() {
  return METERS_PER_DEGREE_LAT;
}

function metersPerDegreeLon(latDeg) {
  const latRad = (latDeg * Math.PI) / 180;
  return METERS_PER_DEGREE_LAT * Math.cos(latRad);
}

/**
 * GGP Section 6: Name normalization — uppercase, remove accents, hyphens/underscores to space, remove punctuation.
 */
function normalizeNameForGGP(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[-_]/g, ' ')
    .replace(/['.,\/()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GGP Section 7: Remove stopwords from token list (French + locality fillers).
 */
function removeStopwords(tokens) {
  return tokens.filter((t) => t.length > 0 && !GGP_STOPWORDS.has(t));
}

/** Consonants only (A,E,I,O,U,Y excluded) for abbreviation. */
const CONSONANTS = new Set('BCDFGHJKLMNPQRSTVWXZ');

/**
 * Two-letter consonant abbreviation from significant tokens (reduces collision e.g. Boulbinet vs Boussoura).
 * Chars 2–3 of zone code = first 2 consonants in order from the name.
 */
function consonantAbbrev2(significantTokens) {
  const str = significantTokens.join('');
  const cons = [];
  for (const c of str.toUpperCase()) {
    if (CONSONANTS.has(c)) cons.push(c);
    if (cons.length >= 2) break;
  }
  if (cons.length >= 2) return cons.join('');
  if (cons.length === 1) return cons[0] + GGP_PAD_CHAR;
  return GGP_PAD_CHAR + GGP_PAD_CHAR;
}

/**
 * First letter of direct upper admin subdivision (prefecture/county or region).
 * Used as 4th char of zone code to tie zone to parent admin.
 */
function getAdminLevel6IsoFromAddress(address) {
  return address?.['ISO3166-2-Lvl6'] || address?.['ISO3166-2-lvl6'] || null;
}

function normalizedFirstLetter(name) {
  const normalized = normalizeNameForGGP(name || '');
  const match = normalized.match(/[A-Z]/);
  return match ? match[0] : null;
}

function stripPrefecturePrefix(name) {
  return String(name || '').replace(/^(Préfecture|Prefecture)\s+(de\s+)?/i, '').trim();
}

/** Infer prefecture-level admin name by point containment (admin_level=6). */
function getAdminLevel6NameFromContainment(lon, lat) {
  if (!Array.isArray(places) || places.length === 0) return null;
  if (!adminLevel6PlacesCache) {
    adminLevel6PlacesCache = places.filter((p) => {
      const level = p.extratags?.admin_level != null ? parseInt(p.extratags.admin_level, 10) : 0;
      return level === 6;
    });
  }
  for (const place of adminLevel6PlacesCache) {
    if (!place?.geojson) continue;
    if (!pointInGeometry(lon, lat, place.geojson)) continue;
    const pAddress = place.address || {};
    const iso6 = getAdminLevel6IsoFromAddress(pAddress);
    const profileName = iso6 ? COUNTRY_PROFILE?.admin_codes?.level_6_prefectures?.[iso6]?.name : null;
    if (profileName) return profileName;
    return stripPrefecturePrefix(pAddress.county || pAddress.state || place.display_name?.split(',')[0] || '');
  }
  return null;
}

function upperAdminFirstLetter(address, place = null) {
  const cacheKey = place?.place_id;
  if (cacheKey != null && upperAdminLetterCache.has(cacheKey)) {
    return upperAdminLetterCache.get(cacheKey);
  }

  const countyName = stripPrefecturePrefix(address?.county);
  let resolved = normalizedFirstLetter(countyName);
  if (!resolved) resolved = normalizedFirstLetter(address?.state);

  if (!resolved) {
    const iso6 = getAdminLevel6IsoFromAddress(address || {});
    const profilePrefName = iso6 ? COUNTRY_PROFILE?.admin_codes?.level_6_prefectures?.[iso6]?.name : null;
    resolved = normalizedFirstLetter(stripPrefecturePrefix(profilePrefName || ''));
  }

  if (!resolved && place) {
    const centroid = centroidFromPlace(place);
    if (centroid) {
      const [lat, lon] = centroid;
      const prefByContainment = getAdminLevel6NameFromContainment(lon, lat);
      resolved = normalizedFirstLetter(stripPrefecturePrefix(prefByContainment || ''));
      if (!resolved) {
        const regionIso = getAdminLevel2IsoWithFallback(lat, lon, place, { skipSampling: true });
        const regionName = COUNTRY_PROFILE?.admin_codes?.level_4_regions?.[regionIso]?.name;
        resolved = normalizedFirstLetter(regionName);
      }
    }
  }

  if (!resolved) resolved = GGP_PAD_CHAR;
  if (cacheKey != null) upperAdminLetterCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Zone key = 2 consonants from name + 1 letter from direct upper admin (4th char).
 * Format: [Type][Consonant][Consonant][UpperAdmin].
 */
function nameKeyFromTokens(significantTokens, address, place = null) {
  if (!significantTokens.length) return 'XXX';
  const two = consonantAbbrev2(significantTokens);
  const upper = address ? upperAdminFirstLetter(address, place) : GGP_PAD_CHAR;
  return (two + upper).slice(0, 3);
}

/**
 * GGP Fallback A: when base key collides, use 2 consonants + first letter of state (if different from county).
 */
function nameKeyFallbackA(significantTokens, address) {
  if (!significantTokens.length || !address?.state) return null;
  const two = consonantAbbrev2(significantTokens);
  const stateFirst = (address.state || '').slice(0, 1).toUpperCase();
  if (!/[A-Z]/.test(stateFirst)) return null;
  return (two + stateFirst).slice(0, 3);
}

/**
 * Get significant tokens for a zone name (normalize + stopwords). Returns array in document order.
 */
function getSignificantTokens(name) {
  const normalized = normalizeNameForGGP(name);
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return removeStopwords(tokens);
}

/**
 * GGP Zone code = [PREFIX] + [KEY3]. KEY3 = 2 consonants + 1 upper-admin letter.
 */
function zoneCodeFromNameAndType(name, typePrefix, address) {
  const prefix = typePrefix || 'Z';
  const significant = getSignificantTokens(name);
  if (!significant.length) return prefix + 'XXX';
  const key = nameKeyFromTokens(significant, address, null);
  return prefix + key;
}

/** 
 * Computes and caches the bounding box of a place.
 * @param {Object} place
 * @returns {number[]|null} [minLat, maxLat, minLon, maxLon]
 */
function getCachedBbox(place) {
  if (!place || !place.geojson) return null;
  if (place._computedBbox) return place._computedBbox;
  place._computedBbox = bboxFromGeometry(place.geojson);
  return place._computedBbox;
}

/** 
 * Computes and caches the centroid [lat, lon] of a place from its geometry bbox.
 * @param {Object} place
 * @returns {number[]|null}
 */
function centroidFromPlace(place) {
  const bbox = getCachedBbox(place);
  return bbox ? centroidFromBbox(bbox) : null;
}

/**
 * Get base code and optional fallback A code for a place (for collision resolution).
 * Zone key = 2 consonants from name + 1 letter from direct upper admin (prefecture/county).
 */
function getPlaceZoneCandidates(place) {
  const address = place.address || {};
  const name =
    address.quarter || address.neighbourhood || address.suburb ||
    address.village || address.hamlet || address.town || address.city ||
    (place.display_name && place.display_name.split(',')[0]?.trim()) || '';
  const placeType = place.type || place.addresstype || '';
  const adminLevel = place.extratags?.admin_level != null
    ? parseInt(place.extratags.admin_level, 10) : undefined;
  const prefix = getTypePrefixForZone(placeType, adminLevel);
  const significant = getSignificantTokens(name);
  if (!significant.length) return { prefix, baseCode: prefix + 'XXX', fallbackCode: null };
  const baseKey = nameKeyFromTokens(significant, address, place);
  const baseCode = prefix + baseKey;
  const fallbackKey = nameKeyFallbackA(significant, address);
  const fallbackCode = fallbackKey ? prefix + fallbackKey : null;
  return { prefix, baseCode, fallbackCode };
}

/** Resolve type prefix from OSM place type and admin_level (GGP Section 5). */
function getTypePrefixForZone(placeType, adminLevel) {
  const key = (placeType || '').toLowerCase();
  if (adminLevel === 8) return 'S'; // Commune / Sous-préfecture
  if (adminLevel === 10) return 'Q'; // Quartier boundary
  if (ZONE_TYPE_PREFIX[key]) return ZONE_TYPE_PREFIX[key];
  return ZONE_TYPE_PREFIX_DEFAULT;
}

/**
 * GGP Section 10 — Collision avoidance: build deterministic assignment of zone codes per ADMIN_LEVEL_2.
 * For each place in the same ADMIN_LEVEL_2: try base code, then fallback A, then base[0:3]+digit 0–9.
 * Uses effective ADMIN_LEVEL_2 (from address, then region containment, then sampling) so all places get a bucket.
 */
function buildAdminLevel2ZoneAssignments(admin_level_2_Iso) {
  const isoKey = admin_level_2_Iso || '';
  const inAdminLevel2 = places.filter((p) => effectiveAdminLevel2IsoForPlace(p, { skipSampling: true }) === isoKey);
  const sorted = [...inAdminLevel2].sort((a, b) => (a.place_id || 0) - (b.place_id || 0));
  const used = new Set();
  const digitCountByBase = new Map(); // base prefix (3 chars) -> next digit to use
  const assignment = new Map(); // place_id -> finalCode

  for (const place of sorted) {
    const { baseCode, fallbackCode } = getPlaceZoneCandidates(place);
    const prefix3 = baseCode.slice(0, 3);
    let finalCode = null;
    if (!used.has(baseCode)) {
      finalCode = baseCode;
    } else if (fallbackCode && !used.has(fallbackCode)) {
      finalCode = fallbackCode;
    } else {
      const next = digitCountByBase.get(prefix3) ?? 0;
      const digit = Math.min(9, next);
      digitCountByBase.set(prefix3, next + 1);
      finalCode = prefix3 + String(digit);
    }
    used.add(finalCode);
    assignment.set(place.place_id, finalCode);
  }
  return assignment;
}

/** Get effective ADMIN_LEVEL_2 ISO for a place (for grouping). skipSampling=true when building index (faster). */
function effectiveAdminLevel2IsoForPlace(place, opts = {}) {
  const cen = centroidFromPlace(place);
  if (cen) return getAdminLevel2IsoWithFallback(cen[0], cen[1], place, opts);
  return getAdminLevel2IsoFromAddress(place.address || {}) || null;
}

/** Get ADMIN_LEVEL_3 zone code for a place, respecting manual localities naming overrides first, with fallback to mathematical collision resolution within its ADMIN_LEVEL_2. */
function getAdminLevel3CodeWithCollision(place) {
  if (!place) return null;
  // Use explicit zone code from localities naming data if present!
  if (place.place_id && OGLAP_ZONE_CODES_BY_ID.has(place.place_id)) {
    return OGLAP_ZONE_CODES_BY_ID.get(place.place_id);
  }
  const admin_level_2_Iso = effectiveAdminLevel2IsoForPlace(place);
  const assignments = buildAdminLevel2ZoneAssignments(admin_level_2_Iso);
  return assignments.get(place.place_id) ?? getPlaceZoneCandidates(place).baseCode;
}

/** Get ADMIN_LEVEL_3 zone code from address/type/name/adminLevel (no collision; used when no place context). */
function getAdminLevel3Code(address, placeType, displayName, adminLevel) {
  const name =
    address?.quarter ||
    address?.neighbourhood ||
    address?.suburb ||
    address?.village ||
    address?.hamlet ||
    address?.town ||
    address?.city ||
    (displayName && displayName.split(',')[0]?.trim()) ||
    '';
  const prefix = getTypePrefixForZone(placeType, adminLevel);
  return zoneCodeFromNameAndType(name, prefix, address);
}

// ——— Macroblock dual strategy ———
// Local (zone, admin_level ≥ 9):  4-char LetterDigitLetterDigit, 100 m cells, 1 m microspot.
// National (fallback):            6-char XXXYYY (A-Z per axis, 26³ = 17 576 per axis),
//                                 100 m cells, 1 m microspot.
// Grid capacity: 17 576 × 100 m = 1 757.6 km per axis — enough for any country.
const ALPHA3_MAX = 26 ** 3; // 17 576
const NATIONAL_CELL_SIZE_M = 100;
const NATIONAL_MICRO_SCALE = 1;

/** Encode integer 0..17 575 as 3 A-Z letters (AAA..ZZZ). */
function encodeAlpha3(n) {
  const val = Math.max(0, Math.min(Math.floor(n), ALPHA3_MAX - 1));
  const c2 = val % 26;
  const c1 = Math.floor(val / 26) % 26;
  const c0 = Math.floor(val / 676);
  return String.fromCharCode(65 + c0, 65 + c1, 65 + c2);
}

/** Decode 3 A-Z letters to integer; returns -1 if invalid. */
function decodeAlpha3(str) {
  if (!str || str.length !== 3) return -1;
  const u = str.toUpperCase();
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const c = u.charCodeAt(i) - 65;
    if (c < 0 || c > 25) return -1;
    n = n * 26 + c;
  }
  return n;
}

/** Letter encoding for local macroblock: 0→A, 1→B, … 9→J. */
function macroLetter(n) {
  return String.fromCharCode(65 + Math.min(9, Math.max(0, Math.floor(n))));
}

/** Encode local macroblock (zone): eastBlocks, northBlocks (100 m) → 4-char e.g. C2E6. */
function encodeLocalMacroblock(eastBlocks, northBlocks) {
  const eTens = Math.floor(eastBlocks / 10);
  const eUnits = Math.floor(eastBlocks % 10);
  const nTens = Math.floor(northBlocks / 10);
  const nUnits = Math.floor(northBlocks % 10);
  return (
    macroLetter(eTens) + eUnits +
    macroLetter(nTens) + nUnits
  );
}

/** Encode national macroblock: eastKm, northKm → 6-char XXXYYY. */
function encodeNationalMacroblock(eastKm, northKm) {
  return encodeAlpha3(eastKm) + encodeAlpha3(northKm);
}

/** Encode microspot: 0–99 east, 0–99 north → 4 digits e.g. 5020. */
function encodeMicrospot(eastM, northM) {
  const e = Math.min(99, Math.max(0, Math.round(eastM)));
  const n = Math.min(99, Math.max(0, Math.round(northM)));
  return String(e).padStart(2, '0') + String(n).padStart(2, '0');
}

/** Decode local macroblock letter (A=0 … J=9). */
function decodeMacroLetter(c) {
  if (!/^[A-J]$/i.test(c)) return 0;
  return c.toUpperCase().charCodeAt(0) - 65;
}

/**
 * Decode macroblock string.
 * 6-char (XXXYYY, all A-Z): national → { blockEast: eastKm, blockNorth: northKm }.
 * 4-char (LetterDigitLetterDigit): local → { blockEast, blockNorth } in 100 m blocks.
 */
function decodeMacroblock(str) {
  if (!str || str.length < 4) return null;
  const u = str.toUpperCase();
  if (u.length === 6 && /^[A-Z]{6}$/.test(u)) {
    const eastKm = decodeAlpha3(u.slice(0, 3));
    const northKm = decodeAlpha3(u.slice(3, 6));
    if (eastKm < 0 || northKm < 0) return null;
    return { blockEast: eastKm, blockNorth: northKm };
  }
  if (u.length >= 4 && /^[A-J]\d[A-J]\d$/.test(u.slice(0, 4))) {
    const blockEast = decodeMacroLetter(u[0]) * 10 + parseInt(u[1], 10);
    const blockNorth = decodeMacroLetter(u[2]) * 10 + parseInt(u[3], 10);
    if (Number.isNaN(blockNorth)) return null;
    return { blockEast, blockNorth };
  }
  return null;
}

/** Decode microspot string "9921" → { eastM, northM } (meters within the 100 m block). */
function decodeMicrospot(str) {
  if (!str || str.length !== 4) return null;
  const eastM = parseInt(str.slice(0, 2), 10);
  const northM = parseInt(str.slice(2, 4), 10);
  if (Number.isNaN(eastM) || Number.isNaN(northM)) return null;
  return { eastM, northM };
}

/**
 * Decodes a LAP code string into WGS84 [lat, lon] coordinates.
 * The country code prefix is optional since the country is implicit from the current profile.
 *
 * Accepted formats:
 * - National with CC:    "GN-FAR-HMDEUP-3241"
 * - National without CC: "FAR-HMDEUP-3241"
 * - Local with CC:       "GN-CON-QCL0-A2A3-6041"
 * - Local without CC:    "CON-QCL0-A2A3-6041"
 *
 * @param {string} lapCode - The LAP code string to decode.
 * @returns {{lat: number, lon: number}|null} Decoded WGS84 coordinates, or null if invalid/unresolvable.
 */
function lapToCoordinates(lapCode) {
  if (!_initialized) throw new Error('OGLAP not initialized. Call initOglap() with a valid profile and localities naming first.');

  const parsed = parseLapCode(lapCode);
  if (!parsed || !parsed.macroblock || !parsed.microspot) return null;

  const macro = decodeMacroblock(parsed.macroblock);
  const micro = decodeMicrospot(parsed.microspot);
  if (!macro || !micro) return null;

  let originLat, originLon;
  if (parsed.isNationalGrid) {
    originLat = COUNTRY_SW[0];
    originLon = COUNTRY_SW[1];
  } else {
    // Local grid: resolve zone origin from the place's bbox
    const match = getPlaceByLapCode(lapCode);
    if (!match?.place) return null;
    const bbox = getCachedBbox(match.place);
    if (!bbox) return null;
    originLat = bbox[0]; // minLat
    originLon = bbox[2]; // minLon
  }

  const mPerLat = metersPerDegreeLat();
  const isNational = parsed.macroblock.length === 6;
  const cellSize = isNational ? NATIONAL_CELL_SIZE_M : 100;
  const microScale = isNational ? NATIONAL_MICRO_SCALE : 1;
  const eastM = macro.blockEast * cellSize + micro.eastM * microScale;
  const northM = macro.blockNorth * cellSize + micro.northM * microScale;
  const lat = originLat + northM / mPerLat;
  const lon = originLon + eastM / metersPerDegreeLon(originLat);
  return { lat, lon };
}

/**
 * Compute LAP code segments.
 * Local:    COUNTRY-ADMIN2-ADMIN3-MACROBLOCK(4)-MICROSPOT  (100 m cells, 1 m micro)
 * National: COUNTRY-ADMIN2-MACROBLOCK(6)-MICROSPOT         (100 m cells, 1 m micro)
 */
function computeLAP(lat, lon, originLat, originLon, admin_level_2_Code, admin_level_3_code, useNationalGrid = false) {
  const mPerLat = metersPerDegreeLat();
  const mPerLon = metersPerDegreeLon(originLat);
  const northM = (lat - originLat) * mPerLat;
  const eastM = (lon - originLon) * mPerLon;

  // JS Float64 precision loss compensation when parsing exact grid boundaries
  const EPSILON = 1e-4;
  const northMEps = northM + EPSILON;
  const eastMEps = eastM + EPSILON;

  const admin2 = admin_level_2_Code;

  if (useNationalGrid) {
    const blockEastN = Math.max(0, Math.floor(eastMEps / NATIONAL_CELL_SIZE_M));
    const blockNorthN = Math.max(0, Math.floor(northMEps / NATIONAL_CELL_SIZE_M));
    const inCellEast = Math.floor((eastMEps - blockEastN * NATIONAL_CELL_SIZE_M) / NATIONAL_MICRO_SCALE);
    const inCellNorth = Math.floor((northMEps - blockNorthN * NATIONAL_CELL_SIZE_M) / NATIONAL_MICRO_SCALE);
    const macroblock = encodeNationalMacroblock(blockEastN, blockNorthN);
    const microspot = encodeMicrospot(inCellEast, inCellNorth);
    return {
      country: COUNTRY_CODE,
      admin_level_2: admin2,
      admin_level_3: null,
      macroblock,
      microspot,
      isNationalGrid: true,
      lapCode: `${COUNTRY_CODE}-${admin2}-${macroblock}-${microspot}`,
    };
  }

  const blockEast = Math.floor(eastMEps / 100);
  const blockNorth = Math.floor(northMEps / 100);
  const inBlockEast = eastMEps - blockEast * 100;
  const inBlockNorth = northMEps - blockNorth * 100;
  const macroblock = encodeLocalMacroblock(blockEast, blockNorth);
  const microspot = encodeMicrospot(inBlockEast, inBlockNorth);

  return {
    country: COUNTRY_CODE,
    admin_level_2: admin2,
    admin_level_3: admin_level_3_code || null,
    macroblock,
    microspot,
    isNationalGrid: false,
    lapCode: `${COUNTRY_CODE}-${admin2}-${admin_level_3_code}-${macroblock}-${microspot}`,
  };
}

/** Extract the most meaningful name from a place object. */
function getPlaceName(place) {
  if (!place) return 'Unknown';
  if (place.extratags?.name) return place.extratags.name;
  if (place.address?.neighbourhood) return place.address.neighbourhood;
  if (place.address?.suburb) return place.address.suburb;
  if (place.address?.village) return place.address.village;
  if (place.address?.city) return place.address.city;
  if (place.address?.town) return place.address.town;
  if (place.address?.county) return place.address.county;
  if (place.address?.state) return place.address.state;
  return 'Unknown';
}

/** Bbox [minLat, maxLat, minLon, maxLon] from GeoJSON geometry. */
function bboxFromGeometry(geometry) {
  if (!geometry?.coordinates) return null;
  const c = geometry.coordinates;
  const type = geometry.type;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  function add(lon, lat) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (type === 'Point') {
    add(c[0], c[1]);
  } else if (type === 'Polygon') {
    c.forEach(ring => ring.forEach(p => add(p[0], p[1])));
  } else if (type === 'MultiPolygon') {
    c.forEach(poly => poly.forEach(ring => ring.forEach(p => add(p[0], p[1]))));
  }
  if (minLat === Infinity) return null;
  return [minLat, maxLat, minLon, maxLon];
}

/** Centroid [lat, lon] from bbox [minLat, maxLat, minLon, maxLon]. */
function centroidFromBbox(bbox) {
  if (!bbox || bbox.length < 4) return null;
  return [(bbox[0] + bbox[1]) / 2, (bbox[2] + bbox[3]) / 2];
}

/** Build search index: key "${admin_level_2_Iso}_${admin_level_3_code}" -> first place with that zone code. Uses effective ADMIN_LEVEL_2. */
function buildLapSearchIndex() {
  if (lapSearchIndex) return lapSearchIndex;
  lapSearchIndex = new Map();
  const isoToAssignment = new Map();
  for (const place of places) {
    const iso = effectiveAdminLevel2IsoForPlace(place, { skipSampling: true });

    let code = OGLAP_ZONE_CODES_BY_ID.has(place.place_id)
      ? OGLAP_ZONE_CODES_BY_ID.get(place.place_id)
      : null;

    if (!code) {
      if (!isoToAssignment.has(iso)) {
        isoToAssignment.set(iso, buildAdminLevel2ZoneAssignments(iso));
      }
      code = isoToAssignment.get(iso).get(place.place_id);
    }

    if (!code) continue;
    const key = `${iso}_${code}`;
    if (!lapSearchIndex.has(key)) lapSearchIndex.set(key, place);
  }
  return lapSearchIndex;
}

/**
 * Parses a raw search query string into structured LAP components.
 * Supports multiple valid formats (country code prefix is optional):
 * - National LAP:  "GN-CKY-ABCABC-2798" or "CKY-ABCABC-2798"
 * - Local LAP:     "GN-CKY-QKPC-B4A4-2798" or "CKY-QKPC-B4A4-2798"
 * - Zone search:   "GN-CKY-QKAR", "CKY QKAR", "QKAR"
 *
 * @param {string} query - The raw user input string.
 * @returns {{ admin_level_2_Iso?: string, admin_level_3_code?: string|null, macroblock?: string, microspot?: string, isNationalGrid?: boolean }|null} Structured components or null if parsing fails.
 */
function parseLapCode(query) {
  const q = (query || '').trim();
  if (!q) return null;
  const parts = q.split(/[\s-]+/).filter(Boolean).map((p) => p.toUpperCase());

  // National LAP with CC: GN-ADMIN2-XXXYYY-MICRO (4 parts, macroblock = 6 chars all A-Z)
  if (parts.length >= 4 && parts[0] === COUNTRY_CODE) {
    const admin2Code = parts[1];
    const maybeMacro = parts[2];
    const maybeMicro = parts[3];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso && maybeMacro.length === 6 && /^[A-Z]{6}$/.test(maybeMacro) && maybeMicro.length === 4 && /^\d{4}$/.test(maybeMicro)) {
      return { admin_level_2_Iso: admin2Iso, admin_level_3_code: null, macroblock: maybeMacro, microspot: maybeMicro, isNationalGrid: true };
    }
  }

  // Local LAP with CC: GN-ADMIN2-ADMIN3-MACRO-MICRO (5 parts, macroblock = 4 chars)
  if (parts.length >= 5 && parts[0] === COUNTRY_CODE) {
    const admin2Code = parts[1];
    const admin3Code = parts[2];
    const macroblock = parts[3];
    const microspot = parts[4];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso && admin3Code.length >= 1 && macroblock.length === 4 && microspot.length === 4) {
      return { admin_level_2_Iso: admin2Iso, admin_level_3_code: admin3Code, macroblock, microspot, isNationalGrid: false };
    }
  }

  // National LAP without CC: ADMIN2-XXXYYY-MICRO (3 parts, macroblock = 6 chars all A-Z)
  if (parts.length === 3 && parts[0] !== COUNTRY_CODE) {
    const admin2Code = parts[0];
    const maybeMacro = parts[1];
    const maybeMicro = parts[2];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso && maybeMacro.length === 6 && /^[A-Z]{6}$/.test(maybeMacro) && maybeMicro.length === 4 && /^\d{4}$/.test(maybeMicro)) {
      return { admin_level_2_Iso: admin2Iso, admin_level_3_code: null, macroblock: maybeMacro, microspot: maybeMicro, isNationalGrid: true };
    }
  }

  // Local LAP without CC: ADMIN2-ADMIN3-MACRO-MICRO (4 parts, macroblock = 4 chars)
  if (parts.length === 4 && parts[0] !== COUNTRY_CODE) {
    const admin2Code = parts[0];
    const admin3Code = parts[1];
    const macroblock = parts[2];
    const microspot = parts[3];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso && admin3Code.length >= 1 && macroblock.length === 4 && microspot.length === 4) {
      return { admin_level_2_Iso: admin2Iso, admin_level_3_code: admin3Code, macroblock, microspot, isNationalGrid: false };
    }
  }

  // Zone search with country prefix: GN-ADMIN2-ADMIN3
  if (parts.length >= 3 && parts[0] === COUNTRY_CODE) {
    const admin2Code = parts[1];
    const admin3Code = parts[2];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso && admin3Code.length >= 1) return { admin_level_2_Iso: admin2Iso, admin_level_3_code: admin3Code };
  }

  // Zone search shorthand: ADMIN2 ADMIN3
  if (parts.length === 2 && parts[0].length <= 4 && parts[1].length <= 4) {
    const admin2Code = parts[0];
    const admin3Code = parts[1];
    const admin2Iso = OGLAP_COUNTRY_REGIONS_REVERSE[admin2Code];
    if (admin2Iso) return { admin_level_2_Iso: admin2Iso, admin_level_3_code: admin3Code };
  }

  // Zone code only
  if (parts.length === 1 && parts[0].length <= 4) {
    return { admin_level_3_code: parts[0] };
  }
  return null;
}

/**
 * Validates a LAP or zone search input format before costly parsing and spatial lookups.
 * Accepts: full LAP with or without country prefix (national or local), zone search.
 *
 * @param {string} query - The raw user input string.
 * @returns {string|null} Returns `null` if the format is perfectly valid, or a descriptive error message string if invalid.
 */
function validateLapCode(query) {
  const q = (query || '').trim();
  if (!q) return 'Enter a LAP code or zone code to search.';

  const parts = q.split(/[\s-]+/).filter(Boolean).map((p) => p.toUpperCase());
  if (parts.length > 5) return `Invalid format: too many segments. Use e.g. GN-CKY-QKPC-B4A4-2798 (local) or GN-CKY-XXXYYY-2798 (national) or zone code QKAR.`;

  // 5 parts: CC-ADMIN2-ADMIN3-MACRO-MICRO (local with CC)
  if (parts.length === 5) {
    if (parts[0] !== COUNTRY_CODE) return `LAP code must start with country code "${COUNTRY_CODE}" when using 5-segment format.`;
    const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[1]];
    if (!admin2) return `Unknown region code "${parts[1]}". Use a valid ADMIN_LEVEL_2 code (e.g. CKY).`;
    if (!parts[2] || parts[2].length < 1) return 'Zone (ADMIN_LEVEL_3) code is required.';
    if (parts[3].length !== 4) return 'Local macroblock must be 4 characters (e.g. B4A4).';
    if (!/^[A-J]\d[A-J]\d$/i.test(parts[3])) return 'Local macroblock format: letter-digit-letter-digit (e.g. B4A4).';
    if (parts[4].length !== 4 || !/^\d{4}$/.test(parts[4])) return 'Microspot must be 4 digits (e.g. 2798).';
    return null;
  }

  // 4 parts: CC-ADMIN2-MACRO6-MICRO (national with CC) OR ADMIN2-ADMIN3-MACRO4-MICRO (local without CC)
  if (parts.length === 4) {
    if (parts[0] === COUNTRY_CODE) {
      // National with CC: GN-ADMIN2-XXXYYY-MICRO
      const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[1]];
      if (!admin2) return `Unknown region code "${parts[1]}". Use a valid ADMIN_LEVEL_2 code (e.g. CKY).`;
      if (parts[2].length !== 6 || !/^[A-Z]{6}$/.test(parts[2])) return 'National macroblock must be 6 letters (e.g. ABCDEF).';
      if (parts[3].length !== 4 || !/^\d{4}$/.test(parts[3])) return 'Microspot must be 4 digits (e.g. 2798).';
      return null;
    }
    // Local without CC: ADMIN2-ADMIN3-MACRO4-MICRO
    const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[0]];
    if (!admin2) return `Unknown region code "${parts[0]}". Use a valid ADMIN_LEVEL_2 code (e.g. CKY).`;
    if (!parts[1] || parts[1].length < 1) return 'Zone (ADMIN_LEVEL_3) code is required.';
    if (parts[2].length !== 4) return 'Local macroblock must be 4 characters (e.g. B4A4).';
    if (!/^[A-J]\d[A-J]\d$/i.test(parts[2])) return 'Local macroblock format: letter-digit-letter-digit (e.g. B4A4).';
    if (parts[3].length !== 4 || !/^\d{4}$/.test(parts[3])) return 'Microspot must be 4 digits (e.g. 2798).';
    return null;
  }

  // 3 parts: ADMIN2-MACRO6-MICRO (national without CC) OR CC-ADMIN2-ADMIN3 (zone search)
  if (parts.length === 3) {
    if (parts[0] === COUNTRY_CODE) {
      // Zone search: GN-ADMIN2-ADMIN3
      const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[1]];
      if (!admin2) return `Unknown region code "${parts[1]}". Use a valid ADMIN_LEVEL_2 code (e.g. CKY).`;
      if (!parts[2] || parts[2].length < 1) return 'Zone code is required.';
      return null;
    }
    // National without CC: ADMIN2-XXXYYY-MICRO
    const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[0]];
    if (admin2 && parts[1].length === 6 && /^[A-Z]{6}$/.test(parts[1]) && parts[2].length === 4 && /^\d{4}$/.test(parts[2])) {
      return null;
    }
    // Could be zone search without CC — fall through
    if (admin2) return null; // loose zone search
    return `Unknown region code "${parts[0]}". Use a valid ADMIN_LEVEL_2 code (e.g. CKY).`;
  }

  if (parts.length === 2) {
    const admin2 = OGLAP_COUNTRY_REGIONS_REVERSE[parts[0]];
    if (!admin2) return `Unknown region code "${parts[0]}". Use e.g. CKY QKAR.`;
    if (!parts[1] || parts[1].length > 4) return 'Zone code must be 1–4 characters.';
    return null;
  }

  if (parts.length === 1) {
    if (parts[0].length > 4) return 'Zone code only must be 1–4 characters (e.g. QKAR).';
    return null;
  }

  return 'Invalid LAP or zone format. Use full LAP (GN-CKY-...), or zone code (e.g. QKAR).';
}

/** Find first place matching the LAP search query. Returns { place, parsed, originLat?, originLon? } or null. National grid LAPs resolve directly without a place. */
function getPlaceByLapCode(query) {
  if (!_initialized) throw new Error('OGLAP not initialized. Call initOglap() with a valid profile and localities naming first.');
  const parsed = parseLapCode(query);
  if (!parsed) return null;
  if (parsed.isNationalGrid && parsed.admin_level_2_Iso) {
    return { place: null, parsed, originLat: COUNTRY_SW[0], originLon: COUNTRY_SW[1] };
  }
  if (places.length === 0) return null;
  buildLapSearchIndex();
  let place = null;
  if (parsed.admin_level_2_Iso && parsed.admin_level_3_code) {
    const key = `${parsed.admin_level_2_Iso}_${parsed.admin_level_3_code}`;
    place = lapSearchIndex.get(key) || null;
  } else if (parsed.admin_level_3_code) {
    for (const [key, p] of lapSearchIndex) {
      if (key.endsWith('_' + parsed.admin_level_3_code)) {
        place = p;
        break;
      }
    }
  }
  if (!place) return null;
  return { place, parsed };
}

/** Ensure each ring's first and last coordinate are the same (Turf requirement). */
function closeRings(geometry) {
  if (!geometry?.coordinates) return geometry;
  const closeRing = (ring) => {
    if (!ring || ring.length < 3) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return [...ring, [first[0], first[1]]];
    }
    return ring;
  };
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map(closeRing),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((poly) => poly.map(closeRing)),
    };
  }
  return geometry;
}

/** Check if point [lon, lat] is inside GeoJSON geometry. */
function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  const pt = { type: 'Point', coordinates: [lon, lat] };
  let poly;
  if (geometry.type === 'Polygon') {
    poly = closeRings({ type: 'Polygon', coordinates: geometry.coordinates });
  } else if (geometry.type === 'MultiPolygon') {
    poly = closeRings({ type: 'MultiPolygon', coordinates: geometry.coordinates });
  } else {
    return false;
  }
  try {
    return booleanPointInPolygon(pt, poly);
  } catch (_) {
    return false;
  }
}

/** Find smallest containing feature for (lon, lat) and return it + bbox for origin. */
function reverseGeocode(lon, lat) {
  const containing = [];
  for (const place of places) {
    const geo = place.geojson;
    if (!geo) continue;
    if (geo.type === 'Point' || geo.type === 'MultiPoint') continue;
    if (pointInGeometry(lon, lat, geo)) {
      const poly = geo.type === 'Polygon'
        ? closeRings({ type: 'Polygon', coordinates: geo.coordinates })
        : closeRings({ type: 'MultiPolygon', coordinates: geo.coordinates });
      try {
        if (place._computedArea === undefined) {
          place._computedArea = area(poly);
        }
        containing.push({
          place,
          area: place._computedArea,
        });
      } catch (_) {
        // skip if area() fails (e.g. invalid geometry)
      }
    }
  }
  if (containing.length === 0) return null;
  containing.sort((a, b) => a.area - b.area);

  // Best (smallest) feature
  const best = containing[0].place;

  // Ensure the best place has its address object initialized
  if (!best.address) best.address = {};

  // Bubble up missing hierarchical addressing properties from enclosing areas
  for (let i = 1; i < containing.length; i++) {
    const parent = containing[i].place;
    const parentAddr = parent.address || {};
    const parentLevel = parent.extratags?.admin_level ? parseInt(parent.extratags.admin_level, 10) : null;
    const parentName = getPlaceName(parent);

    if (!best.address.country && parentAddr.country) best.address.country = parentAddr.country;

    // Admin Level 4 -> State/Region
    if (!best.address.state) {
      if (parentAddr.state) best.address.state = parentAddr.state;
      else if (parentLevel === 4) best.address.state = parentName;
    }

    // Admin Level 6 -> County/Prefecture
    if (!best.address.county) {
      if (parentAddr.county) best.address.county = parentAddr.county;
      else if (parentLevel === 6) best.address.county = parentName;
    }

    // Admin Level 8 -> City/Town/Sub-prefecture
    if (!best.address.city && !best.address.town && !best.address.village) {
      if (parentAddr.city) best.address.city = parentAddr.city;
      else if (parentAddr.town) best.address.town = parentAddr.town;
      else if (parentLevel === 8) best.address.city = parentName;
    }
  }

  // Fallback country if still missing
  if (!best.address.country) best.address.country = COUNTRY_PROFILE?.meta?.country_name || 'Guinée';

  const bbox = getCachedBbox(best);
  const originLat = bbox ? bbox[0] : COUNTRY_SW[0];
  const originLon = bbox ? bbox[2] : COUNTRY_SW[1];
  return {
    place: best,
    originLat,
    originLon,
    bbox,
  };
}

/** Get ADMIN_LEVEL_2 OGLAP code from address (ISO3166-2-Lvl4). */
function getAdminLevel2Code(address) {
  const iso4 = address?.['ISO3166-2-Lvl4'] || address?.['ISO3166-2-lvl4'];
  return (iso4 && OGLAP_COUNTRY_REGIONS[iso4]) || null;
}

/** Get ADMIN_LEVEL_2 ISO from address. */
function getAdminLevel2IsoFromAddress(address) {
  return address?.['ISO3166-2-Lvl4'] || address?.['ISO3166-2-lvl4'] || null;
}

/** Find region (admin_level 4) that contains the point; return its ISO or null. */
function getAdminLevel2FromRegionContainment(lon, lat) {
  for (const place of places) {
    const level = place.extratags?.admin_level != null ? parseInt(place.extratags.admin_level, 10) : 0;
    if (level !== 4) continue;
    const iso = getAdminLevel2IsoFromAddress(place.address || {});
    if (!iso) continue;
    if (pointInGeometry(lon, lat, place.geojson)) return iso;
  }
  return null;
}

/** Sample 3–7 points in 500m–1km radius; return majority ADMIN_LEVEL_2 ISO or null. */
function getAdminLevel2BySampling(lon, lat, numSamples = 5, radiusM = 750) {
  const mPerLat = metersPerDegreeLat();
  const mPerLon = metersPerDegreeLon(lat);
  const counts = new Map();
  const angles = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 2 * Math.PI;
    const eastM = radiusM * Math.cos(angle);
    const northM = radiusM * Math.sin(angle);
    const dLat = northM / mPerLat;
    const dLon = eastM / mPerLon;
    const lat2 = lat + dLat;
    const lon2 = lon + dLon;
    let iso = getAdminLevel2FromRegionContainment(lon2, lat2);
    if (!iso) {
      const rev = reverseGeocode(lon2, lat2);
      if (rev) iso = getAdminLevel2IsoFromAddress(rev.place.address || {});
    }
    if (iso) counts.set(iso, (counts.get(iso) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [iso, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = iso;
    }
  }
  return best;
}

/** ADMIN_LEVEL_2 OGLAP code with fallbacks: address → region containment → sampling (optional) → null. */
function getAdminLevel2WithFallback(lat, lon, place, opts = {}) {
  const { skipSampling = false } = opts;
  const address = place?.address || {};
  let iso = getAdminLevel2IsoFromAddress(address);
  if (iso) return OGLAP_COUNTRY_REGIONS[iso];
  iso = getAdminLevel2FromRegionContainment(lon, lat);
  if (iso) return OGLAP_COUNTRY_REGIONS[iso];
  if (!skipSampling) {
    iso = getAdminLevel2BySampling(lon, lat, 5, 750);
    if (iso) return OGLAP_COUNTRY_REGIONS[iso];
  }
  return null;
}

/** ADMIN_LEVEL_2 ISO with same fallbacks (for grouping / collision). skipSampling=true for fast index build. */
function getAdminLevel2IsoWithFallback(lat, lon, place, opts = {}) {
  const { skipSampling = false } = opts;
  const address = place?.address || {};
  let iso = getAdminLevel2IsoFromAddress(address);
  if (iso) return iso;
  iso = getAdminLevel2FromRegionContainment(lon, lat);
  if (iso) return iso;
  if (!skipSampling) {
    iso = getAdminLevel2BySampling(lon, lat, 5, 750);
    if (iso) return iso;
  }
  return null;
}

/** True if place has admin_level ≥ 9 AND meaningful name tokens (use zone grid); else use national grid. */
function useZoneGridForPlace(place) {
  if (!place?.extratags?.admin_level) return false;
  const level = parseInt(place.extratags.admin_level, 10);
  if (level < 9) return false;
  // If place has a pre-assigned zone code in localities naming, use local grid
  const pid = place.place_id;
  if (pid != null && (OGLAP_ZONE_CODES_BY_ID.has(pid) || OGLAP_ZONE_CODES_BY_ID.has(String(pid)))) return true;
  // Check if place has meaningful name tokens for zone code generation
  const address = place.address || {};
  const name = address.quarter || address.neighbourhood || address.suburb ||
      address.village || address.hamlet || address.town || address.city ||
      (place.display_name && place.display_name.split(',')[0]?.trim()) || '';
  const significant = getSignificantTokens(name);
  return significant.length > 0;
}

/**
 * Build OGLAP address and LAP code from reverse result and click.
 * Local grid when place has admin_level ≥ 9 (zone origin, ADMIN3 segment).
 * National grid otherwise (country origin, XXXYYY macroblock, no ADMIN3).
 */
function buildOGLAPResult(lat, lon, rev) {
  const useZone = rev?.place && useZoneGridForPlace(rev.place);
  const useNational = !useZone;
  let originLat, originLon, admin_level_2, admin_level_3, displayName, address, pcode;

  if (useZone) {
    originLat = rev.originLat;
    originLon = rev.originLon;
    admin_level_2 = getAdminLevel2WithFallback(lat, lon, rev.place);
    if (!admin_level_2) return null;
    admin_level_3 = getAdminLevel3CodeWithCollision(rev.place);
    address = rev.place.address || {};
    displayName = getPlaceName(rev.place);
    const pcodeRaw = rev.place.extratags?.['unocha:pcode'];
    pcode = typeof pcodeRaw === 'string' && pcodeRaw.trim()
      ? pcodeRaw.split(';').map((s) => s.trim()).filter(Boolean)
      : [];
  } else {
    originLat = COUNTRY_SW[0];
    originLon = COUNTRY_SW[1];
    admin_level_2 = getAdminLevel2WithFallback(lat, lon, rev?.place ?? null);
    if (!admin_level_2) return null;
    admin_level_3 = null;
    address = rev?.place?.address || {};
    displayName = getPlaceName(rev?.place);
    pcode = [];
  }

  const lap = computeLAP(lat, lon, originLat, originLon, admin_level_2, admin_level_3, useNational);

  const addressParts = (useNational
    ? [
      `${lap.macroblock}-${lap.microspot}`,
      address?.county || address?.state || address?.city || address?.town || address?.village,
      address?.country,
    ]
    : [
      displayName !== 'Unknown'
        ? `${lap.macroblock}-${lap.microspot} ${displayName}`
        : `${lap.macroblock}-${lap.microspot}`,
      address?.county || address?.state || address?.city || address?.town || address?.village, // Admin2 fallback
      address?.country,
    ]).filter(Boolean);

  const humanAddress = [...new Set(addressParts)].join(', ');

  return {
    lapCode: lap.lapCode,
    country: lap.country,
    admin_level_2: lap.admin_level_2,
    admin_level_3: lap.admin_level_3,
    macroblock: lap.macroblock,
    microspot: lap.microspot,
    isNationalGrid: lap.isNationalGrid,
    displayName,
    address: address || {},
    humanAddress,
    originLat,
    originLon,
    pcode,
  };
}

/**
 * Draw a grid of lines at a given cell size (in meters).
 * Uses a single mPerLon (at originLat) for all conversions so that lines stay
 * at fixed positions regardless of zoom or pan — no per-row variation.
 * Returns array of line coordinate pairs, or [] if too many lines.
 */

/**
 * Convert raw WGS84 Latitude and Longitude to a structured, fully-qualified OGLAP Code object.
 * This combines reverseGeocoding containment checks and grid projection into a single SDK function.
 * 
 * @param {number} lat - Latitude in decimal degrees
 * @param {number} lon - Longitude in decimal degrees
 * @returns {{
 *   lapCode: string, country: string, admin_level_2: string, admin_level_3: string|null,
 *   macroblock: string, microspot: string, isNationalGrid: boolean,
 *   displayName: string, address: Object, humanAddress: string,
 *   originLat: number, originLon: number, pcode: string[]
 * }} The resulting structured OGLAP place block.
 */
function coordinatesToLap(lat, lon) {
  if (!_initialized) throw new Error('OGLAP not initialized. Call initOglap() with a valid profile and localities naming first.');

  // Fast reject: coordinates outside the country bounding box
  const { sw, ne } = COUNTRY_BOUNDS;
  if (lat < sw[0] || lat > ne[0] || lon < sw[1] || lon > ne[1]) {
    return null;
  }

  // Precise reject: coordinates must fall inside the country border polygon (admin_level 2)
  if (COUNTRY_BORDER_GEOJSON && !pointInGeometry(lon, lat, COUNTRY_BORDER_GEOJSON)) {
    return null;
  }

  const rev = reverseGeocode(lon, lat);
  return buildOGLAPResult(lat, lon, rev);
}

export {
  parseLapCode,
  validateLapCode,
  getPlaceByLapCode,
  lapToCoordinates,
  coordinatesToLap,
  bboxFromGeometry,
  centroidFromBbox,
};