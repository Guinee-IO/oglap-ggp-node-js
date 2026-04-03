# oglap-ggp-node-js

Implémentation Node.js du protocole **OGLAP** (Offline Grid Location Addressing Protocol) — un système d'adressage déterministe basé sur une grille, conçu pour les régions où les adresses postales formelles sont inexistantes ou peu fiables.

OGLAP génère des **codes LAP** compacts et lisibles (ex. `GN-CKY-QKAR-B4A4-2798`) qui identifient de façon unique n'importe quelle coordonnée à l'intérieur d'un pays configuré, hors ligne et sans API externe.

---

## Fonctionnalités

- **Coordonnées → code LAP** — encoder toute position GPS en adresse LAP structurée
- **Code LAP → coordonnées** — décoder un code LAP vers son centre géographique
- **Geocodage inversé** — trouver la région administrative, zone et lieu contenant une coordonnée
- **Parsing & validation de code LAP** — analyser des codes partiels ou complets, valider le format et le contenu
- **Boîte englobante et centroïde** — calculer bbox et centre à partir de géométries GeoJSON
- **Entièrement hors ligne** — aucune connexion requise une fois les données chargées

---

## Format du code LAP

Un code LAP encode une localisation à quatre niveaux hiérarchiques :

### Grille locale (5 segments)
```
GN  - CKY  - QKAR - B4A4 - 2798
│      │      │      │      └─ Microspot   — 4 chiffres, offset métrique (XX = est, YY = nord)
│      │      │      └─────── Macrobloc   — 4 chars [A-J][0-9][A-J][0-9], blocs ~100 m dans la zone
│      │      └────────────── Zone        — 4 chars, dérivé du nom de lieu local
│      └───────────────────── Région      — 3 chars, code de région administrative
└──────────────────────────── Pays        — code ISO alpha-2 du pays
```

### Grille nationale (4 segments)
Utilisée quand une coordonnée se situe en dehors des limites administratives de niveau 8 et au-dessus :
```
GN  - CKY  - AABCDE - 4250
│      │      │        └─ Microspot   — 4 chiffres
│      │      └────────── Macrobloc   — 6 lettres, grille kilométrique nationale
│      └──────────────── Région
└─────────────────────── Pays
```

---

## Démarrage

### 1. Ajouter la dépendance

```bash
npm install oglap-ggp-node-js
```

### 2. Préparer les données

Le package nécessite trois fichiers JSON :

| Fichier | Description |
|---|---|
| `{country_code}_oglap_country_profile.json` | Paramètres de grille, codes admin, règles de nommage |
| `{country_code}_localities_naming.json` | Géométries GeoJSON des lieux (régions, zones, localités) |
| `{country_code}_full.json` | Correspondances place-ID → code OGLAP |

### 3. Initialiser avant toute utilisation

Appeler `initOglap` une seule fois au démarrage de l'application, avant toute autre fonction :

**Mode téléchargement (recommandé)** — les données sont téléchargées et mises en cache localement :

```js
import { initOglap } from 'oglap-ggp-node-js';

const report = await initOglap({
  version: 'latest',
  dataDir: 'oglap-data',      // dossier de cache local
  forceDownload: false,
  onProgress({ label, status, percent, step, totalSteps }) {
    if (status === 'downloading') process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label}: ${percent}%`);
    if (status === 'cached')      console.log(`⚡ [${step}/${totalSteps}] ${label}: depuis le cache`);
    if (status === 'done')        console.log(`\r✓ [${step}/${totalSteps}] ${label}: terminé`);
    if (status === 'error')       console.log(`✗ [${step}/${totalSteps}] ${label}: erreur`);
  }
});

if (!report.ok) throw new Error(report.error);
```

**Mode direct** — pour les environnements sans accès disque (serverless, edge) :

```js
import { initOglap, loadOglap } from 'oglap-ggp-node-js';

const profile    = await fetch('/data/country_profile.json').then(r => r.json());
const localities = await fetch('/data/localities_naming.json').then(r => r.json());
const places     = await fetch('/data/oglap_data.json').then(r => r.json());

const report = await initOglap(profile, localities);
if (!report.ok) throw new Error(report.error);

const loaded = loadOglap(places);
console.log(`${loaded.count} lieux chargés`);
```

---

## Utilisation

### Encoder des coordonnées en code LAP

```js
import { coordinatesToLap } from 'oglap-ggp-node-js';

const result = coordinatesToLap(9.5370, -13.6773); // lat, lon — Conakry, Guinée

console.log(result.lapCode);        // GN-CKY-QKAR-B4A4-2798
console.log(result.humanAddress);   // Quartier Almamya, Conakry, Kindia, Guinée
console.log(result.admin_level_2);  // CKY  (code de région)
console.log(result.admin_level_3);  // QKAR (code de zone)
console.log(result.macroblock);     // B4A4
console.log(result.microspot);      // 2798
console.log(result.isNationalGrid); // false
console.log(result.originLat);      // latitude d'origine de la bbox
console.log(result.originLon);      // longitude d'origine de la bbox
```

Retourne `null` si les coordonnées sont hors du territoire.

### Décoder un code LAP en coordonnées

```js
import { lapToCoordinates } from 'oglap-ggp-node-js';

const coords = lapToCoordinates('GN-CKY-QKAR-B4A4-2798');

if (coords) {
  console.log(`lat: ${coords.lat}, lon: ${coords.lon}`);
  // lat: 9.5370..., lon: -13.6773...
}

// Le préfixe pays est optionnel
const coords2 = lapToCoordinates('CKY-QKAR-B4A4-2798');
```

### Parser et valider un code LAP

```js
import { validateLapCode, parseLapCode } from 'oglap-ggp-node-js';

// Valider — retourne un message d'erreur, ou null si valide
const error = validateLapCode('GN-CKY-QKAR-B4A4-2798');
if (error) {
  console.log('Invalide :', error);
} else {
  console.log('Code valide');
}

// Parser en composants
const parsed = parseLapCode('GN-CKY-QKAR-B4A4-2798');
if (parsed) {
  console.log(parsed.admin_level_2_Iso);  // code ISO de la région
  console.log(parsed.admin_level_3_code); // code de zone : QKAR
  console.log(parsed.macroblock);         // B4A4
  console.log(parsed.microspot);          // 2798
  console.log(parsed.isNationalGrid);     // false
}

// Les codes partiels sont aussi supportés
parseLapCode('GN-CKY-QKAR'); // région + zone seulement
parseLapCode('QKAR');         // zone seulement
```

### Résoudre un code LAP vers un lieu

```js
import { getPlaceByLapCode } from 'oglap-ggp-node-js';

const resolved = getPlaceByLapCode('GN-CKY-QKAR-B4A4-2798');

if (resolved) {
  console.log(resolved.originLat); // latitude d'origine de la bbox
  console.log(resolved.originLon); // longitude d'origine de la bbox

  if (resolved.place) {
    const addr = resolved.place.address;
    const name = addr?.village ?? addr?.town ?? addr?.city ?? resolved.place.display_name;
    console.log(name); // nom du lieu lisible
  }

  // Accéder aux composants parsés
  console.log(resolved.parsed.macroblock); // B4A4
  console.log(resolved.parsed.microspot);  // 2798
}
```

### Boîte englobante et centroïde

```js
import { bboxFromGeometry, centroidFromBbox } from 'oglap-ggp-node-js';

const geometry = {
  type: 'Polygon',
  coordinates: [[
    [-13.70, 9.50],
    [-13.65, 9.50],
    [-13.65, 9.55],
    [-13.70, 9.55],
    [-13.70, 9.50],
  ]]
};

const bbox = bboxFromGeometry(geometry);
// [minLat, maxLat, minLon, maxLon]

if (bbox) {
  const center = centroidFromBbox(bbox);
  // [lat, lon] du point central de la bbox
  console.log(`Centre : ${center[0]}, ${center[1]}`);
}
```

### Accéder aux métadonnées du pays

```js
import { getCountryCode, getCountrySW, getOglapPrefectures } from 'oglap-ggp-node-js';

console.log(getCountryCode()); // "GN"
console.log(getCountrySW());   // [lat, lon] du coin sud-ouest

const prefectures = getOglapPrefectures();
// { [isoCode]: prefectureOglapCode, ... }
```

---

## Modèles de données

### Résultat de `coordinatesToLap`

| Champ | Type | Description |
|---|---|---|
| `lapCode` | `string` | Code LAP complet, ex. `GN-CKY-QKAR-B4A4-2798` |
| `country` | `string` | Code pays, ex. `GN` |
| `admin_level_2` | `string` | Code de région, ex. `CKY` |
| `admin_level_3` | `string\|null` | Code de zone, ex. `QKAR` |
| `macroblock` | `string` | Composant macrobloc |
| `microspot` | `string` | Composant microspot |
| `isNationalGrid` | `boolean` | `true` si grille nationale utilisée |
| `displayName` | `string` | Nom du lieu issu du geocodage inversé |
| `humanAddress` | `string` | Adresse complète lisible |
| `address` | `object` | Composants d'adresse structurés |
| `originLat` | `number` | Latitude d'origine de la bbox |
| `originLon` | `number` | Longitude d'origine de la bbox |
| `pcode` | `string[]` | P-codes UNOCHA pour la localisation |

### Résultat de `parseLapCode`

| Champ | Type | Description |
|---|---|---|
| `admin_level_2_Iso` | `string\|undefined` | Code ISO de la région |
| `admin_level_3_code` | `string\|undefined` | Code de zone |
| `macroblock` | `string\|undefined` | Composant macrobloc |
| `microspot` | `string\|undefined` | Composant microspot |
| `isNationalGrid` | `boolean` | `true` si grille nationale |

### Résultat de `getPlaceByLapCode`

| Champ | Type | Description |
|---|---|---|
| `place` | `object\|null` | Données OSM du lieu |
| `parsed` | `object` | Composants LAP parsés |
| `originLat` | `number\|undefined` | Latitude d'origine de la bbox |
| `originLon` | `number\|undefined` | Longitude d'origine de la bbox |

### Rapport de `initOglap`

| Champ | Type | Description |
|---|---|---|
| `ok` | `boolean` | Initialisation réussie |
| `countryCode` | `string\|null` | Ex. `GN` |
| `countryName` | `string\|null` | Ex. `Guinée` |
| `bounds` | `number[][]\|null` | `[[swLat, swLon], [neLat, neLon]]` |
| `checks` | `Array` | Résultats de validation (`pass`, `warn`, `fail`) |
| `error` | `string\|null` | Message d'erreur si `!ok` |
| `dataDir` | `string\|undefined` | Dossier de cache local |
| `dataLoaded` | `object\|undefined` | Résultat du chargement des lieux |

---

## Exemple complet de bout en bout

```js
import {
  initOglap,
  checkOglap,
  coordinatesToLap,
  lapToCoordinates,
  getPlaceByLapCode,
  validateLapCode,
  parseLapCode,
} from 'oglap-ggp-node-js';

class LocationService {
  static #initialized = false;

  static async init() {
    if (this.#initialized) return;

    const report = await initOglap({
      onProgress({ label, status, percent, step, totalSteps }) {
        if (status === 'downloading') process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label}: ${percent}%`);
        if (status === 'cached')      console.log(`⚡ [${step}/${totalSteps}] ${label}: depuis le cache`);
        if (status === 'done')        console.log(`\r✓ [${step}/${totalSteps}] ${label}: terminé`);
        if (status === 'error')       console.log(`✗ [${step}/${totalSteps}] ${label}: erreur`);
      }
    });

    if (!report.ok) throw new Error(`Initialisation OGLAP échouée : ${report.error}`);
    this.#initialized = true;
  }

  /** Encoder la position GPS de l'utilisateur */
  static encodePosition(lat, lon) {
    const result = coordinatesToLap(lat, lon);
    return result?.lapCode ?? null;
  }

  /** Partager une localisation : retourne le code LAP et l'adresse lisible */
  static shareLocation(lat, lon) {
    const result = coordinatesToLap(lat, lon);
    if (!result) return null;
    return {
      code:  result.lapCode,
      label: result.humanAddress,
    };
  }

  /** Naviguer vers un code LAP en le convertissant en coordonnées */
  static decodeToCoords(lapCode) {
    return lapToCoordinates(lapCode); // { lat, lon } ou null
  }

  /** Valider la saisie d'un code LAP par l'utilisateur */
  static validateInput(input) {
    return validateLapCode(input); // null = valide, string = message d'erreur
  }

  /** Résoudre un code LAP vers les détails du lieu */
  static resolvePlace(lapCode) {
    const resolved = getPlaceByLapCode(lapCode);
    if (!resolved?.place) return null;

    const addr = resolved.place.address ?? {};
    return {
      name:      addr.village ?? addr.town ?? addr.city ?? resolved.place.display_name,
      adminCode: resolved.parsed.admin_level_3_code,
      originLat: resolved.originLat,
      originLon: resolved.originLon,
    };
  }
}

// Utilisation
await LocationService.init();

// Encoder le centre de Conakry
const code = LocationService.encodePosition(9.5370, -13.6773);
console.log(code); // GN-CKY-QKAR-B4A4-2798

// Décoder
const coords = LocationService.decodeToCoords(code);
console.log(coords); // { lat: 9.537..., lon: -13.677... }

// Partager
const share = LocationService.shareLocation(9.5370, -13.6773);
console.log(share.label); // Quartier Almamya, Conakry, Kindia, Guinée

// Valider la saisie utilisateur
const err = LocationService.validateInput('GN-CKY-QKAR-B4A4-2798');
console.log(err); // null (valide)

// Résoudre un lieu
const place = LocationService.resolvePlace('GN-CKY-QKAR-B4A4-2798');
console.log(place.name); // Quartier Almamya
```

---

## Exécuter les tests

```bash
node test.js
```

---

## Informations complémentaires

- **Protocole** : OGLAP est conçu pour la Guinée (`GN`) mais configurable pour tout pays via le fichier profil JSON.
- **Offline-first** : tout l'encodage et décodage est effectué localement avec les données chargées — aucun réseau requis.
- **Déterministe** : les mêmes coordonnées produisent toujours le même code LAP, à données identiques.
- **Bugs** : signaler les problèmes dans le dépôt principal Kiraa.
