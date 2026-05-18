# oglap-ggp-node

> SDK Node.js du protocole **OGLAP** — Offline Grid Location Addressing pour le profil Guinée (GGP).

🇬🇧 **English version** → [README.md](README.md)

Convertit des coordonnées GPS en codes d'adresse compacts, déterministes et lisibles (ex. `GN-CON-QYTC-B0B1-2282`) et inversement — entièrement hors ligne, sans API externe. Conçu pour les régions où l'adressage postal formel est rare ou peu fiable.

[![npm version](https://img.shields.io/npm/v/oglap-ggp-node.svg)](https://www.npmjs.com/package/oglap-ggp-node)
[![licence](https://img.shields.io/npm/l/oglap-ggp-node.svg)](LICENSE)

---

## Sommaire

- [Pourquoi OGLAP ?](#pourquoi-oglap-)
- [Format du code LAP](#format-du-code-lap)
- [Installation](#installation)
- [Initialisation (obligatoire)](#initialisation-obligatoire)
- [API principale](#api-principale)
  - [`coordinatesToLap` — encoder GPS → LAP](#coordinatestolap--encoder-gps--lap)
  - [`lapToCoordinates` — décoder LAP → GPS](#laptocoordinates--décoder-lap--gps)
  - [`parseLapCode` — parser un code en composants](#parselapcode--parser-un-code-en-composants)
  - [`validateLapCode` — valider un code](#validatelapcode--valider-un-code)
  - [`getPlaceByLapCode` — retrouver le lieu sous-jacent](#getplacebylapcode--retrouver-le-lieu-sous-jacent)
  - [`bboxFromGeometry` & `centroidFromBbox`](#bboxfromgeometry--centroidfrombbox)
  - [État et métadonnées](#état-et-métadonnées)
- [Fichiers de données et cache](#fichiers-de-données-et-cache)
- [Exemple complet de bout en bout](#exemple-complet-de-bout-en-bout)
- [Utilisation dans le navigateur](#utilisation-dans-le-navigateur)
- [Performances](#performances)
- [Tests](#tests)
- [Versionnage et compatibilité](#versionnage-et-compatibilité)
- [Licence](#licence)

---

## Pourquoi OGLAP ?

Dans de nombreuses régions du monde, les adresses postales classiques n'existent pas ou ne sont pas fiables pour livrer un colis, dépêcher des secours ou partager sa position. OGLAP résout ce problème en découpant le pays en une grille déterministe et en attribuant à chaque cellule d'environ 1 m × 1 m un code court, copiable-collable.

- **Hors ligne d'abord** — fonctionne sans réseau une fois les données mises en cache.
- **Déterministe** — les mêmes coordonnées produisent toujours le même code ; le même code redonne toujours le même point.
- **Hiérarchique** — le préfixe révèle pays / région / zone, donc le code reste utile même tronqué.
- **Lisible** — uniquement A–Z majuscules et chiffres, aucun caractère ambigu.

---

## Format du code LAP

Un code LAP encode une localisation sur quatre niveaux hiérarchiques. Deux stratégies de grille coexistent :

### Grille locale (5 segments — à l'intérieur des zones administratives nommées)

```
GN  - CON  - QYTC - B0B1 - 2282
│      │      │      │      └─ Microspot   — 4 chiffres, offset métrique ~1 m dans le macrobloc
│      │      │      └─────── Macrobloc    — 4 chars [A–J][0–9][A–J][0–9], cellule ~100 m dans la zone
│      │      └────────────── Zone         — 4 chars, niveau administratif ≥8 immédiat (ex. QYTC pour Yattaya-Fossedè)
│      └───────────────────── Région       — 3 chars, niveau administratif 4 ou 6 immédiat (ex. CON pour Conakry)
└──────────────────────────── Pays         — code ISO alpha-2 (ex. GN pour Guinée)
```

### Grille nationale (4 segments — repli pour les zones rurales sans découpage de niveau ≥8)

```
GN  - NZE  - AABCDE - 4250
│      │      │        └─ Microspot   — 4 chiffres, offset ~1 m
│      │      └────────── Macrobloc    — 6 lettres, grille kilométrique nationale
│      └──────────────── Région       — 3 chars (ex. NZE pour Nzérékoré)
└─────────────────────── Pays         — code ISO alpha-2
```

Le SDK choisit automatiquement la bonne grille selon que la coordonnée se trouve à l'intérieur d'un polygone administratif nommé de niveau ≥8 ou non.

---

## Installation

```bash
npm install oglap-ggp-node
# ou
pnpm add oglap-ggp-node
# ou
yarn add oglap-ggp-node
```

Requiert **Node.js ≥ 18** (utilise `fetch` natif, les ES Modules et `WeakMap`).

Le paquet est publié en **ES Module** — utilisez la syntaxe `import`. Pour CommonJS, utilisez `import()` dynamique.

---

## Initialisation (obligatoire)

Appelez `initOglap()` **une seule fois** au démarrage de l'application, avant toute fonction d'encodage/décodage. Au premier appel, trois fichiers JSON sont téléchargés depuis le CDN OGLAP (`https://s3.guinee.io/oglap/ggp/latest/`) et mis en cache dans `oglap-data/<version>/`. Les appels suivants se font instantanément depuis le cache.

```js
import { initOglap } from 'oglap-ggp-node';

const report = await initOglap({
  version: 'latest',          // 'latest' (par défaut) ou une version épinglée
  dataDir: 'oglap-data',      // dossier de cache local (défaut : 'oglap-data')
  forceDownload: false,       // forcer le téléchargement même si le cache est présent
  onProgress({ label, status, percent, step, totalSteps }) {
    // status ∈ 'downloading' | 'cached' | 'slow' | 'validating' | 'done' | 'error'
    if (status === 'downloading') {
      process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label} : ${percent}%`);
    } else if (status === 'cached') {
      console.log(`⚡ [${step}/${totalSteps}] ${label} : chargé depuis le cache`);
    } else if (status === 'done') {
      console.log(`✓ [${step}/${totalSteps}] ${label} : prêt`);
    } else if (status === 'error') {
      console.error(`✗ [${step}/${totalSteps}] ${label} : erreur`);
    }
  },
});

if (!report.ok) throw new Error(`Échec d'initialisation OGLAP : ${report.error}`);
```

### Structure du rapport d'initialisation

| Champ         | Type                  | Description                                                                |
| ------------- | --------------------- | -------------------------------------------------------------------------- |
| `ok`          | `boolean`             | `true` si l'initialisation a réussi                                        |
| `countryCode` | `string \| null`      | Code pays actif, ex. `"GN"`                                                |
| `countryName` | `string \| null`      | Nom affiché, ex. `"Guinea"`                                                |
| `bounds`      | `number[][] \| null`  | `[[swLat, swLon], [neLat, neLon]]`                                         |
| `checks`      | `Array<Check>`        | Résultats de validation par étape — chacun `{ id, status, message }`       |
| `error`       | `string \| null`      | Premier message d'erreur fatal si `!ok`                                    |
| `dataDir`     | `string`              | Dossier de cache local résolu                                              |
| `dataLoaded`  | `{ ok, count, message }` | Lieux chargés dans le moteur en mémoire                                 |

### Mode direct (apportez vos propres données)

Si vous avez déjà les fichiers JSON en mémoire (par exemple récupérés vous-même ou embarqués dans l'application), ignorez le téléchargement :

```js
import { initOglap, loadOglap } from 'oglap-ggp-node';
import profile from './mon-profil.json' with { type: 'json' };
import localities from './mes-localites.json' with { type: 'json' };
import places from './mes-lieux.json' with { type: 'json' };

const report = await initOglap(profile, localities);
if (!report.ok) throw new Error(report.error);

loadOglap(places); // charge la base de lieux dans le moteur
```

---

## API principale

Toutes les fonctions ci-dessous sont **synchrones** (pas de réseau, calcul pur en mémoire) sauf `initOglap`.

### `coordinatesToLap` — encoder GPS → LAP

```js
import { coordinatesToLap } from 'oglap-ggp-node';

const result = coordinatesToLap(9.5370, -13.6773); // lat, lon

console.log(result.lapCode);        // 'GN-CON-QYTC-B0B1-2282'
console.log(result.humanAddress);   // 'B0B1-2282, Yattaya Fossedè, Conakry, Guinée'
console.log(result.isNationalGrid); // false
```

Retourne `null` si les coordonnées sont hors du pays (vérification en 3 couches : bbox → polygone pays → polygone administratif).

**Structure du résultat :**

| Champ            | Type        | Description                                                            |
| ---------------- | ----------- | ---------------------------------------------------------------------- |
| `lapCode`        | `string`    | Code complet, ex. `"GN-CON-QYTC-B0B1-2282"`                            |
| `country`        | `string`    | Code pays, ex. `"GN"`                                                  |
| `admin_level_2`  | `string`    | Code de région, ex. `"CON"`                                            |
| `admin_level_3`  | `string\|null` | Code de zone (null en grille nationale)                             |
| `macroblock`     | `string`    | Segment macrobloc                                                      |
| `microspot`      | `string`    | Segment microspot                                                      |
| `isNationalGrid` | `boolean`   | `true` si la grille nationale (rurale) a été utilisée                  |
| `displayName`    | `string`    | Nom issu du géocodage inversé                                          |
| `humanAddress`   | `string`    | Adresse lisible avec séparateurs                                       |
| `address`        | `object`    | Composants d'adresse structurés                                        |
| `originLat`      | `number`    | Latitude d'origine de la bbox du macrobloc                             |
| `originLon`      | `number`    | Longitude d'origine de la bbox du macrobloc                            |
| `pcode`          | `string[]`  | P-codes UNOCHA des unités administratives correspondantes              |

### `lapToCoordinates` — décoder LAP → GPS

```js
import { lapToCoordinates } from 'oglap-ggp-node';

const coords = lapToCoordinates('GN-CON-QYTC-B0B1-2282');
// { lat: 9.5370, lon: -13.6773 }

// Le préfixe pays est optionnel :
lapToCoordinates('CON-QYTC-B0B1-2282'); // même résultat
```

Retourne `null` si le code est structurellement invalide ou référence une région/zone inconnue.

### `parseLapCode` — parser un code en composants

```js
import { parseLapCode } from 'oglap-ggp-node';

const parsed = parseLapCode('GN-CON-QYTC-B0B1-2282');
// {
//   admin_level_2_Iso:  'GN-C',   // clé ISO de la région (CON résout vers sa clé style OSM)
//   admin_level_3_code: 'QYTC',   // code court de la zone
//   macroblock:         'B0B1',
//   microspot:          '2282',
//   isNationalGrid:     false,
// }

// Les codes partiels sont aussi acceptés :
parseLapCode('GN-CON-QYTC'); // région + zone uniquement — retourne { admin_level_2_Iso, admin_level_3_code }
parseLapCode('QYTC');        // zone uniquement          — retourne { admin_level_3_code }
```

> **Note :** le code pays (`GN`) n'est *pas* un champ de l'objet parsé — il est implicite et accessible via `getCountryCode()`. Le segment région (ex. `CON`) est exposé sous `admin_level_2_Iso` (clé ISO style OSM, ex. `GN-C`), pas sous le code court à 3 lettres. Utilisez `getOglapPrefectures()` pour faire le lien entre les deux si vous avez besoin du code court.

### `validateLapCode` — valider un code

```js
import { validateLapCode } from 'oglap-ggp-node';

validateLapCode('GN-CON-QYTC-B0B1-2282'); // → null  (valide)
validateLapCode('GN-XXX-INVALID');        // → 'Unknown region code "XXX"'
```

Retourne `null` pour un code valide, ou une chaîne de message d'erreur en cas d'invalidité.

### `getPlaceByLapCode` — retrouver le lieu sous-jacent

```js
import { getPlaceByLapCode } from 'oglap-ggp-node';

const resolved = getPlaceByLapCode('GN-CON-QYTC-B0B1-2282');
// {
//   place: { place_id, address: { ... }, geojson: { ... }, display_name, ... },
//   parsed: { admin_level_2_Iso, admin_level_3_code, ... },
//   // originLat, originLon ne sont présents que lorsque isNationalGrid vaut true
// }

const nom = resolved.place.address.village
         ?? resolved.place.address.town
         ?? resolved.place.address.city
         ?? resolved.place.display_name;
```

Pour les codes en grille nationale, `place` vaut `null` (ils ne se rattachent à aucun lieu nommé) et la réponse contient `originLat`/`originLon` égaux au point d'origine sud-ouest du pays — utilisables comme position de repli grossière.

### `bboxFromGeometry` & `centroidFromBbox`

Helpers de géométrie pour manipuler les formes GeoJSON chargées en interne.

```js
import { bboxFromGeometry, centroidFromBbox } from 'oglap-ggp-node';

const geometrie = {
  type: 'Polygon',
  coordinates: [[[-13.70, 9.50], [-13.65, 9.50], [-13.65, 9.55], [-13.70, 9.55], [-13.70, 9.50]]],
};

const bbox = bboxFromGeometry(geometrie);   // [minLat, maxLat, minLon, maxLon]
const centre = centroidFromBbox(bbox);      // [lat, lon]
```

### État et métadonnées

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

checkOglap();                // → rapport d'initialisation (même structure que celui retourné par initOglap)
getPackageVersion();         // → '0.1.2'
getCountryCode();            // → 'GN'
getCountrySW();              // → [7.19, -15.37]
getCountryProfile();         // → objet profil pays chargé
getOglapPrefectures();       // → { 'GN.CON': 'CON', 'GN.NZE': 'NZE', ... }
getOglapPlaces();            // → Place[]   (tableau de lieux chargé — volumineux, à utiliser avec parcimonie)
```

---

## Fichiers de données et cache

Le SDK charge trois fichiers de référence depuis `https://s3.guinee.io/oglap/ggp/<version>/` :

| Fichier                             | Taille  | Description                                                            |
| ----------------------------------- | ------- | ---------------------------------------------------------------------- |
| `gn_oglap_country_profile.json`     | ~3 Ko   | Paramètres de grille, codes admin, règles de nommage, plage de compat. |
| `gn_localities_naming.json`         | ~300 Ko | Table de nommage des régions / préfectures / zones                     |
| `gn_full.json`                      | ~37 Mo  | Base de lieux avec polygones GeoJSON                                   |

Par défaut, ils sont mis en cache dans `./oglap-data/latest/`. Ce dossier est **gitignoré** dans ce dépôt et devrait l'être également dans le vôtre — les fichiers sont retéléchargés de façon reproductible par `initOglap()`.

Le premier appel à `initOglap()` affiche un callback de progression pendant le téléchargement ; les appels suivants utilisent le cache (`status === 'cached'`).

Pour forcer un nouveau téléchargement (par ex. après publication d'une mise à jour de jeu de données) :

```js
await initOglap({ forceDownload: true });
```

---

## Exemple complet de bout en bout

```js
import {
  initOglap,
  coordinatesToLap,
  lapToCoordinates,
  validateLapCode,
  getPlaceByLapCode,
} from 'oglap-ggp-node';

class LocationService {
  static #pret = false;

  static async init() {
    if (this.#pret) return;
    const report = await initOglap({
      onProgress({ label, status, percent, step, totalSteps }) {
        if (status === 'downloading') process.stdout.write(`\r↓ [${step}/${totalSteps}] ${label} : ${percent}%`);
        if (status === 'cached')      console.log(`⚡ [${step}/${totalSteps}] ${label} : en cache`);
        if (status === 'done')        console.log(`✓ [${step}/${totalSteps}] ${label} : prêt`);
      },
    });
    if (!report.ok) throw new Error(`Échec init OGLAP : ${report.error}`);
    this.#pret = true;
  }

  /** Encoder la position GPS de l'utilisateur en code LAP. */
  static encode(lat, lon) {
    return coordinatesToLap(lat, lon)?.lapCode ?? null;
  }

  /** Décoder un code LAP en couple {lat, lon}. */
  static decode(code) {
    return lapToCoordinates(code); // null si invalide
  }

  /** Valider la saisie utilisateur. Retourne null si valide, sinon une chaîne d'erreur. */
  static valider(code) {
    return validateLapCode(code);
  }

  /** Résoudre un code LAP en fiche lisible. */
  static resoudre(code) {
    const r = getPlaceByLapCode(code);
    if (!r?.place) return null;
    const a = r.place.address ?? {};
    return {
      nom:       a.village ?? a.town ?? a.city ?? r.place.display_name,
      codeAdmin: r.parsed.admin_level_3_code,
      originLat: r.originLat,
      originLon: r.originLon,
    };
  }
}

await LocationService.init();

const code = LocationService.encode(9.660147, -13.588009);
console.log(code);                          // 'GN-CON-QYTC-B0B1-2282'
console.log(LocationService.decode(code));  // { lat: ~9.660, lon: ~-13.588 }
console.log(LocationService.valider(code)); // null  (valide)
console.log(LocationService.resoudre(code));// { nom: 'Yattaya Fossedè', ... }
```

---

## Utilisation dans le navigateur

Le SDK est compatible navigateur si vous apportez vos propres données (le chemin `_download.js` interne utilise le `fs` de Node). Utilisez le mode direct :

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

> ⚠️ La base `gn_full.json` fait ~37 Mo non compressés. Pour un usage navigateur, servez-la pré-gzippée et envisagez un chargement différé après le premier rendu.

---

## Performances

- **Index spatial R-tree** — `coordinatesToLap` utilise un R-tree [Flatbush](https://github.com/mourner/flatbush) construit une seule fois lors de `loadOglap()`. Le géocodage inversé d'une coordonnée est en O(log N) pour la sélection de candidats + une petite vérification polygone-dans-polygone.
- **Caches de géométrie non mutants** — les calculs de bbox et d'aire sont mémoïsés via des `WeakMap` clés sur les objets de lieu en entrée. Le SDK ne mute jamais les entrées.
- **Regex bornés** — toutes les expressions régulières s'appliquent à des chaînes bornées et nettoyées — pas d'exposition ReDoS sur entrée utilisateur malformée.
- **Adapté serverless** — état purement en mémoire, aucune fuite entre requêtes tant que le module est réutilisé entre invocations.

---

## Tests

Le dépôt embarque deux scripts de test :

```bash
npm test                       # exécute test.js et determinism.test.js
node test.js                   # tests fonctionnels — encode, décode, parse, valide, allers-retours
node determinism.test.js       # vérifications exhaustives de déterminisme et stabilité
```

Les deux réutilisent `oglap-data/` si présent.

---

## Versionnage et compatibilité

Le SDK déclare une plage de compatibilité avec le jeu de données du profil pays via un caret semver. Le fichier `gn_oglap_country_profile.json` actuellement publié exige que le SDK satisfasse `^0.1.0` — ce paquet suit donc la ligne 0.1.x. Les bumps majeurs du schéma du jeu de données s'accompagneront d'un bump majeur ici.

Vous pouvez inspecter la plage de compatibilité chargée à l'exécution :

```js
import { getCountryProfile } from 'oglap-ggp-node';
console.log(getCountryProfile().compatibility);
// { oglap_package_range: '^0.1.0', dataset_versions: ['2026-02-21T14:13:02.414Z'] }
```

Si `initOglap()` échoue avec une erreur de compatibilité, rétrogradez le SDK ou mettez à jour votre jeu de données en cache (`forceDownload: true`).

---

## Licence

ISC — voir [LICENSE](LICENSE).

Issues et contributions : <https://github.com/Guinee-IO/oglap-ggp-node-js/issues>
