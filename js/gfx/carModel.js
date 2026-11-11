/**
 * carModel.js — Modèles 3D procéduraux des 3 silhouettes de voitures :
 *  - Modèle A (`supercar`) : Supercar (profil bas, roues intégrées sous les ailes, prises d'air)
 *  - Modèle B (`formula`)  : Monoplace / Formule (nez effilé, roues découvertes F1 reliées
 *                            au châssis par des bras de suspension géométriques cylindriques)
 *  - Modèle C (`muscle`)   : Muscle Car / GT (silhouette massive, roues intégrées sous les ailes,
 *                            capot long avec prise d'air surélevée, fastback)
 *
 * Chaque châssis possède sa propre calibration de roues (`trackHalfWidth`, `wheelScale`)
 * et son point d'ancrage local exact pour l'aileron (`spoilerMountPoint: THREE.Vector3`).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js?v=41';

const C = CONFIG.car;

export const BODY_TYPES = {
  supercar: 'Modèle A — Supercar',
  formula:  'Modèle B — Monoplace',
  muscle:   'Modèle C — Muscle GT',
};

export const RIM_TYPES = {
  sport: 'Sport 5 branches',
  multi: 'Multi-rayons',
  star:  'Étoile 6 doubles',
  disc:  'Disque plein',
};

export const RIM_FINISHES = {
  silver: { label: 'Argent', color: 0xd9dce0, metalness: 1.0, roughness: 0.22 },
  black:  { label: 'Noir',   color: 0x1e1f22, metalness: 0.6, roughness: 0.35 },
  gold:   { label: 'Or',     color: 0xd4a937, metalness: 1.0, roughness: 0.25 },
};

export const SPOILER_TYPES = { none: 'Aucun', lip: 'Becquet', gt: 'Aileron GT' };

/**
 * Spécifications géométriques par châssis :
 *  - `trackHalfWidth` : demi-voie latérale X des roues (intégrées sous les ailes pour Supercar/Muscle,
 *                       apparentes pour Monoplace)
 *  - `wheelScale`     : facteur d'échelle du diamètre/largeur des roues
 *  - `spoilerMountPoint` : point d'ancrage exact (Vector3) sur le coffre/capot arrière du châssis
 *  - `strutHeight`    : hauteur des montants verticaux de l'aileron GT au-dessus du point d'ancrage
 *  - `wingWidth`      : envergure de l'aileron adaptée à la carrosserie
 */
export const CHASSIS_SPECS = {
  supercar: {
    trackHalfWidth: 0.74,
    wheelScale: 0.91,
    spoilerMountPoint: new THREE.Vector3(0, 0.79, 1.96),
    strutHeight: 0.32,
    wingWidth: 1.80,
    strutSpread: 0.48,
  },
  formula: {
    trackHalfWidth: 0.85,
    wheelScale: 0.98,
    spoilerMountPoint: new THREE.Vector3(0, 0.44, 1.94),
    strutHeight: 0.46,
    wingWidth: 1.66,
    strutSpread: 0.20,
  },
  muscle: {
    trackHalfWidth: 0.75,
    wheelScale: 0.92,
    spoilerMountPoint: new THREE.Vector3(0, 0.84, 1.96),
    strutHeight: 0.28,
    wingWidth: 1.78,
    strutSpread: 0.50,
  },
};

/** Compression statique de la suspension (cannon : force = k * x * masse). */
const STATIC_COMPRESSION = CONFIG.physics.gravity / (4 * C.suspensionStiffness);
/** Hauteur du centre de roue au repos, dans le repère châssis. */
export const WHEEL_REST_Y = C.connectionY - (C.suspensionRestLength - STATIC_COMPRESSION);
/** Position du sol dans le repère châssis au repos. */
export const GROUND_OFFSET = WHEEL_REST_Y - C.wheelRadius;

/* ------------------------------------------------------------------------ */
/*  Géométries partagées (créées une seule fois et mises en cache)          */
/* ------------------------------------------------------------------------ */
const geoCache = new Map();
function cachedGeo(key, fn) {
  if (!geoCache.has(key)) {
    const g = fn();
    if (g) g.userData.shared = true;
    geoCache.set(key, g);
  }
  return geoCache.get(key);
}

const box = (w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
};

const cyl = (rt, rb, h, segs, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.CylinderGeometry(rt, rb, h, segs);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
};

/**
 * Crée un bras de suspension cylindrique (Three.js CylinderGeometry) reliant
 * deux points 3D `p1` (ancrage châssis) et `p2` (porte-moyeu de roue).
 */
function strutBetween(x1, y1, z1, x2, y2, z2, radius = 0.022) {
  const p1 = new THREE.Vector3(x1, y1, z1);
  const p2 = new THREE.Vector3(x2, y2, z2);
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const len = dir.length();
  const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
  const g = new THREE.CylinderGeometry(radius, radius, len, 8);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const mat = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(mat);
  return g;
}

/** Extrude un profil latéral (x du Shape = z de la voiture) sur la largeur. */
function extrudeProfile(shape, width, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments: 14,
  });
  g.rotateY(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

/* ======================================================================== */
/*  MODÈLE A : SUPERCAR (aile AV enveloppante pleine, épaulement AR continu)*/
/* ======================================================================== */
function supercarBodyGeo() {
  return cachedGeo('body_supercar', () => {
    const fz = C.wheelFrontZ, rz = C.wheelRearZ;
    const wy = 0.33, by = 0.22;
    const arFront = 0.37; // Sommet d'arche AV à y = 0.70 (sous le capot/aile à y = 0.78)
    const arRear = 0.38;  // Sommet d'arche AR à y = 0.71 (sous l'épaulement continu à y = 0.78)

    const dyF = by - wy, dxF = Math.sqrt(arFront * arFront - dyF * dyF), a0F = Math.atan2(dyF, dxF);
    const dyR = by - wy, dxR = Math.sqrt(arRear * arRear - dyR * dyR), a0R = Math.atan2(dyR, dxR);

    // Châssis monocoque : capot plongeant enveloppant pleinement l'aile avant (y = 0.78 au-dessus de fz)
    // et épaulement arrière parfaitement aligné dans le prolongement de la ligne de caisse (y = 0.78)
    const s = new THREE.Shape();
    s.moveTo(-2.14, by);
    s.lineTo(-2.22, 0.35);
    s.quadraticCurveTo(-2.12, 0.56, -1.72, 0.73);   // galbe d'aile avant plein et profilé
    s.quadraticCurveTo(-1.32, 0.78, -0.78, 0.78);   // surface pleine au-dessus de la roue avant (y = 0.78)
    s.lineTo(2.14, 0.78);                           // ligne de caisse et épaulement arrière continus sans marche
    s.lineTo(2.18, 0.44);
    s.lineTo(2.06, by);
    s.lineTo(rz + dxR, by);
    s.absarc(rz, wy, arRear, a0R, Math.PI - a0R, false);   // passage de roue arrière net (sommet y = 0.71)
    s.lineTo(fz + dxF, by);
    s.absarc(fz, wy, arFront, a0F, Math.PI - a0F, false);  // passage de roue avant enveloppé (sommet y = 0.70)

    const monocoque = extrudeProfile(s, 1.92, 0.06);

    // Calotte de toit peinte posée à y = 1.165 (offset +0.015 au-dessus du cockpit vitré à y = 1.15)
    const roofCap = box(1.24, 0.04, 0.78, 0, 1.165, 0.34);

    return mergeGeometries([monocoque.toNonIndexed(), roofCap.toNonIndexed()]);
  });
}

function supercarCabinGeo() {
  return cachedGeo('cabin_supercar', () => {
    // Cockpit profilé monobloc posé à y = 0.79 (offset +0.01 au-dessus de la ligne de caisse à y = 0.78)
    const s = new THREE.Shape();
    s.moveTo(-0.76, 0.79);
    s.lineTo(-0.08, 1.13);                          // pare-brise profilé
    s.quadraticCurveTo(0.38, 1.15, 0.82, 1.13);     // dôme goutte d'eau (sommet y = 1.15)
    s.lineTo(1.68, 0.79);                           // verrière moteur inclinée
    s.closePath();
    return extrudeProfile(s, 1.42, 0.04);
  });
}

function supercarBlackGeo() {
  return cachedGeo('black_supercar', () => {
    // Sous-ensemble 3 : Diffuseur arrière intégré & aérodynamisme carbone (offset >= 0.01, zéro débordement roues)
    const parts = [
      // Prise d'air frontale en retrait net (z = -2.23, hors volume capot)
      box(1.32, 0.11, 0.06, 0, 0.30, -2.23),
      // Lame avant (splitter carbone) sous le châssis (y = 0.19, offset -0.01 sous by = 0.22)
      box(1.88, 0.035, 0.32, 0, 0.19, -2.06),
      // Jupes latérales carbone strictement limitées entre les roues AV et AR (z = -0.80 .. +0.76)
      box(0.06, 0.07, 1.56, 0.94, 0.20, -0.02),
      box(0.06, 0.07, 1.56, -0.94, 0.20, -0.02),
      // Écopes latérales NACA décalées de +0.012 à l'extérieur des flancs (x = ±0.965)
      box(0.04, 0.22, 0.58, 0.965, 0.54, 0.38, 0, 0.08, 0),
      box(0.04, 0.22, 0.58, -0.965, 0.54, 0.38, 0, -0.08, 0),
      // Rétroviseurs profilés sur tiges externes (x = ±1.02)
      box(0.20, 0.08, 0.13, 1.02, 0.88, -0.44),
      box(0.20, 0.08, 0.13, -1.02, 0.88, -0.44),
      // Diffuseur arrière intégré sous la poupe (z = 1.94 .. 2.20, derrière les roues AR)
      box(1.64, 0.12, 0.22, 0, 0.25, 2.10),
      box(0.03, 0.14, 0.24, -0.58, 0.23, 2.12),
      box(0.03, 0.14, 0.24, -0.20, 0.23, 2.12),
      box(0.03, 0.14, 0.24, 0.20, 0.23, 2.12),
      box(0.03, 0.14, 0.24, 0.58, 0.23, 2.12),
    ];
    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  });
}

/* ======================================================================== */
/*  MODÈLE B : MONOPLACE / FORMULE (roues apparentes + bras de suspension)  */
/* ======================================================================== */
function formulaBodyGeo() {
  return cachedGeo('body_formula', () => {
    const parts = [
      // Nez effilé plongeant
      box(0.44, 0.20, 1.35, 0, 0.36, -1.55, 0.11, 0, 0),
      box(0.32, 0.14, 0.65, 0, 0.28, -2.18, 0.08, 0, 0),
      // Monocoque centrale étroite
      box(0.64, 0.42, 2.25, 0, 0.46, 0.05),
      // Queue / boîte de vitesses arrière (offre une base solide à y=0.44, z=1.94 pour l'aileron)
      box(0.52, 0.26, 0.95, 0, 0.36, 1.62),
      // Pontons latéraux profilés (sidepods) entre les roues AV et AR
      box(1.34, 0.35, 1.38, 0, 0.42, 0.24),
      box(1.16, 0.27, 0.52, 0, 0.40, 1.04, -0.12, 0, 0),
      // Capot moteur + aileron de requin (shark fin) + prise d'air haute (airbox)
      box(0.42, 0.38, 1.25, 0, 0.78, 0.68, -0.18, 0, 0),
      box(0.06, 0.32, 0.92, 0, 0.92, 1.04),
      // Volets supérieurs de l'aileron avant imposant
      box(1.74, 0.04, 0.34, 0, 0.20, -2.30, 0.08, 0, 0),
      box(0.05, 0.22, 0.44, 0.87, 0.25, -2.28),
      box(0.05, 0.22, 0.44, -0.87, 0.25, -2.28),
    ];
    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  });
}

function formulaCabinGeo() {
  return cachedGeo('cabin_formula', () => {
    const visor = box(0.32, 0.24, 0.34, 0, 0.82, -0.05);
    const screen = box(0.48, 0.12, 0.28, 0, 0.72, -0.38, 0.45, 0, 0);
    return mergeGeometries([visor.toNonIndexed(), screen.toNonIndexed()]);
  });
}

function formulaBlackGeo() {
  return cachedGeo('black_formula', () => {
    const fz = C.wheelFrontZ;
    const rz = C.wheelRearZ;
    const wx = CHASSIS_SPECS.formula.trackHalfWidth - 0.08;
    const parts = [
      // Fond plat carbone (floor)
      box(1.44, 0.04, 2.15, 0, 0.20, 0.22),
      // Lame principale d'aileron avant carbone
      box(1.78, 0.035, 0.42, 0, 0.16, -2.32),
      // Halo de sécurité au-dessus du cockpit
      box(0.48, 0.05, 0.68, 0, 0.92, -0.08),
      cyl(0.026, 0.026, 0.28, 8, 0, 0.80, -0.38, 0.35, 0, 0),
      // Écopes de pontons noires
      box(1.36, 0.25, 0.08, 0, 0.44, -0.44),
      // Diffuseur arrière
      box(1.12, 0.18, 0.32, 0, 0.24, 2.02),
    ];

    // Bras de suspension géométriques (doubles triangles A-arm + tirant pushrod) pour les 4 roues F1
    for (const side of [-1, 1]) {
      const cxFront = side * 0.20;
      const cxRear = side * 0.24;
      const hx = side * wx;

      // Train avant : triangle supérieur (2 bras), triangle inférieur (2 bras) + pushrod diagonal
      parts.push(
        strutBetween(cxFront, 0.43, fz - 0.22, hx, 0.41, fz, 0.019),
        strutBetween(cxFront, 0.43, fz + 0.24, hx, 0.41, fz, 0.019),
        strutBetween(cxFront, 0.26, fz - 0.22, hx, 0.26, fz, 0.021),
        strutBetween(cxFront, 0.26, fz + 0.24, hx, 0.26, fz, 0.021),
        strutBetween(cxFront, 0.52, fz + 0.05, hx, 0.28, fz, 0.016),
      );

      // Train arrière : triangle supérieur (2 bras), triangle inférieur (2 bras) + pushrod diagonal
      parts.push(
        strutBetween(cxRear, 0.45, rz - 0.26, hx, 0.42, rz, 0.021),
        strutBetween(cxRear, 0.45, rz + 0.20, hx, 0.42, rz, 0.021),
        strutBetween(cxRear, 0.27, rz - 0.26, hx, 0.27, rz, 0.023),
        strutBetween(cxRear, 0.27, rz + 0.20, hx, 0.27, rz, 0.023),
        strutBetween(cxRear, 0.56, rz - 0.05, hx, 0.29, rz, 0.017),
      );
    }

    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  });
}

/* ======================================================================== */
/*  MODÈLE C : MUSCLE GT (aile AV et capot fusionnés sans décroché ni bloc) */
/* ======================================================================== */
function muscleBodyGeo() {
  return cachedGeo('body_muscle', () => {
    const fz = C.wheelFrontZ, rz = C.wheelRearZ;
    const wy = 0.33, by = 0.24, ar = 0.38; // Sommet d'arche à y = 0.71 (strictement sous la ligne capot/aile à y = 0.84)
    const dy = by - wy, dx = Math.sqrt(ar * ar - dy * dy), a0 = Math.atan2(dy, dx);

    // Volume monobloc fusionnant l'aile avant et la tranche du capot sans aucune plaque superposée
    const s = new THREE.Shape();
    s.moveTo(-2.14, by);
    s.lineTo(-2.18, 0.40);                          // pare-chocs avant massif
    s.lineTo(-2.06, 0.41);                          // retrait de calandre creusée (profondeur 12 cm)
    s.lineTo(-2.06, 0.63);                          // fond du logement de calandre
    s.lineTo(-2.18, 0.65);                          // casquette supérieure de calandre
    s.quadraticCurveTo(-2.12, 0.80, -1.78, 0.835);  // jonction fluide aile avant / capot
    s.lineTo(-0.44, 0.84);                          // ligne de capot et d'aile avant parfaitement alignée (y = 0.84)
    s.lineTo(2.14, 0.84);                           // ceinture de caisse et coffre continus sans décroché (y = 0.84)
    s.lineTo(2.16, 0.42);
    s.lineTo(2.08, by);
    s.lineTo(rz + dx, by);
    s.absarc(rz, wy, ar, a0, Math.PI - a0, false);  // passage de roue arrière intégré (sommet y = 0.71)
    s.lineTo(fz + dx, by);
    s.absarc(fz, wy, ar, a0, Math.PI - a0, false);  // passage de roue avant intégré (sommet y = 0.71)

    const main = extrudeProfile(s, 1.92, 0.05);

    // Pavillon rigide peint posé à y = 1.24 (offset +0.015 au-dessus du bloc cockpit à y = 1.225)
    const roofPanel = box(1.38, 0.04, 0.94, 0, 1.24, 0.44);

    return mergeGeometries([
      main.toNonIndexed(),
      roofPanel.toNonIndexed(),
    ]);
  });
}

function muscleCabinGeo() {
  return cachedGeo('cabin_muscle', () => {
    // Cockpit rigide d'un seul bloc posé à y = 0.85 (offset +0.01 au-dessus de la ceinture de caisse à y = 0.84)
    const s = new THREE.Shape();
    s.moveTo(-0.42, 0.85);
    s.lineTo(0.02, 1.225);                          // pare-brise franc
    s.lineTo(0.88, 1.225);                          // toit plat rigide
    s.lineTo(1.84, 0.85);                           // lunette fastback inclinée d'un seul tenant
    s.closePath();
    return extrudeProfile(s, 1.50, 0.035);
  });
}

function muscleBlackGeo() {
  return cachedGeo('black_muscle', () => {
    const parts = [
      // Fond de calandre creusée en retrait (z = -2.075, offset +0.015 devant la paroi à z = -2.06)
      box(1.56, 0.21, 0.03, 0, 0.52, -2.075),
      // Barres verticales de calandre dans la cavité (z = -2.10)
      box(0.03, 0.19, 0.03, -0.34, 0.52, -2.10),
      box(0.03, 0.19, 0.03, 0.0, 0.52, -2.10),
      box(0.03, 0.19, 0.03, 0.34, 0.52, -2.10),
      // Spoiler avant (chin spoiler) sous le pare-chocs (y = 0.20, offset -0.01 sous by = 0.24)
      box(1.88, 0.06, 0.26, 0, 0.20, -2.06),
      // Bas de caisse strictement contenus entre les roues AV et AR (z = -0.80 .. +0.76)
      box(0.06, 0.08, 1.56, 0.93, 0.21, -0.02),
      box(0.06, 0.08, 1.56, -0.93, 0.21, -0.02),
      // Rétroviseurs latéraux externes (x = ±1.02)
      box(0.22, 0.10, 0.14, 1.02, 0.94, -0.30),
      box(0.22, 0.10, 0.14, -1.02, 0.94, -0.30),
      // Bandeau arrière noir mat (z = 2.175, offset +0.015 derrière la caisse à z = 2.16)
      box(1.74, 0.17, 0.02, 0, 0.66, 2.175),
      // Pare-chocs / diffuseur arrière (z = 2.12, sous la caisse)
      box(1.62, 0.12, 0.20, 0, 0.25, 2.12),
    ];
    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  });
}

function headlightGeometry(bodyType = 'supercar') {
  return cachedGeo(`headlights_${bodyType}`, () => {
    if (bodyType === 'formula') {
      return mergeGeometries([
        box(0.26, 0.05, 0.08, 0, 0.34, -2.42),
        box(0.06, 0.10, 0.16, 0.87, 0.28, -2.42),
        box(0.06, 0.10, 0.16, -0.87, 0.28, -2.42),
      ]);
    }
    if (bodyType === 'muscle') {
      // Doubles optiques logées dans la calandre creusée (z = -2.115, offset +0.04 devant le fond à -2.075)
      return mergeGeometries([
        box(0.18, 0.12, 0.03, 0.64, 0.52, -2.115),
        box(0.15, 0.11, 0.03, 0.44, 0.52, -2.115),
        box(0.18, 0.12, 0.03, -0.64, 0.52, -2.115),
        box(0.15, 0.11, 0.03, -0.44, 0.52, -2.115),
      ]);
    }
    // Optiques Supercar affleurantes sur le galbe du nez avant (offset externe franc)
    return mergeGeometries([
      box(0.42, 0.055, 0.08, 0.62, 0.54, -2.08, 0.38, 0, 0),
      box(0.42, 0.055, 0.08, -0.62, 0.54, -2.08, 0.38, 0, 0),
    ]);
  });
}

function taillightGeometry(bodyType = 'supercar') {
  return cachedGeo(`taillights_${bodyType}`, () => {
    if (bodyType === 'formula') {
      return mergeGeometries([
        box(0.12, 0.16, 0.06, 0, 0.38, 2.15),
        box(0.50, 0.04, 0.05, 0, 0.48, 2.02),
      ]);
    }
    if (bodyType === 'muscle') {
      // Feux tri-barres décalés à z = 2.195 (+0.02 derrière le bandeau noir à z = 2.175, zéro z-fighting)
      return mergeGeometries([
        box(0.09, 0.14, 0.02, 0.70, 0.66, 2.195),
        box(0.09, 0.14, 0.02, 0.55, 0.66, 2.195),
        box(0.09, 0.14, 0.02, 0.40, 0.66, 2.195),
        box(0.09, 0.14, 0.02, -0.70, 0.66, 2.195),
        box(0.09, 0.14, 0.02, -0.55, 0.66, 2.195),
        box(0.09, 0.14, 0.02, -0.40, 0.66, 2.195),
      ]);
    }
    // Bandeau LED Supercar décalé à z = 2.195 (+0.015 derrière la poupe à z = 2.18)
    return mergeGeometries([
      box(0.48, 0.07, 0.025, 0.58, 0.67, 2.195),
      box(0.48, 0.07, 0.025, -0.58, 0.67, 2.195),
      box(0.96, 0.03, 0.025, 0, 0.67, 2.195),
    ]);
  });
}

function exhaustGeometry() {
  return cachedGeo('exhaust', () => {
    const parts = [-0.42, 0.42].map((x) => {
      const g = new THREE.CylinderGeometry(0.065, 0.065, 0.22, 12, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(x, 0.27, 2.2);
      return g;
    });
    return mergeGeometries(parts);
  });
}

/**
 * Géométrie de l'aileron en coordonnées locales relatives à `spoilerMountPoint` (0, 0, 0 = surface du coffre/châssis).
 * Ainsi l'aileron repose toujours exactement sur la carrosserie sans jamais flotter dans les airs.
 */
function spoilerGeometry(type, bodyType = 'supercar') {
  if (type === 'none') return null;
  const spec = CHASSIS_SPECS[bodyType] || CHASSIS_SPECS.supercar;
  return cachedGeo(`spoiler_${type}_${bodyType}`, () => {
    if (type === 'lip') {
      const lipW = bodyType === 'formula' ? 1.38 : 1.62;
      return mergeGeometries([
        box(lipW, 0.06, 0.26, 0, 0.04, 0.02, -0.26),
        box(lipW * 0.85, 0.05, 0.14, 0, 0.0, 0.0), // embase de contact directe avec le coffre
      ]);
    }
    if (type === 'gt') {
      const h = spec.strutHeight;
      const w = spec.wingWidth;
      return mergeGeometries([
        box(w, 0.05, 0.44, 0, h, 0.0, 0.12),              // lame principale de l'aileron
        box(0.04, 0.26, 0.50, w * 0.5, h - 0.03, 0.0),    // dérive latérale droite (endplate)
        box(0.04, 0.26, 0.50, -w * 0.5, h - 0.03, 0.0),   // dérive latérale gauche (endplate)
      ]);
    }
    return null;
  });
}

/**
 * Montants verticaux (supports) de l'aileron GT allant de y = -0.04 (ancrés dans le châssis)
 * jusqu'à y = spec.strutHeight (sous la lame de l'aileron).
 */
function spoilerStrutGeometry(bodyType = 'supercar') {
  const spec = CHASSIS_SPECS[bodyType] || CHASSIS_SPECS.supercar;
  return cachedGeo(`spoilerStruts_${bodyType}`, () => {
    const h = spec.strutHeight + 0.04;
    const cy = spec.strutHeight * 0.5 - 0.02;
    const sx = spec.strutSpread;
    return mergeGeometries([
      box(0.045, h, 0.15, sx, cy, 0.02, -0.10),
      box(0.045, h, 0.15, -sx, cy, 0.02, -0.10),
      // Platines de fixation à la base sur le coffre
      box(0.10, 0.03, 0.22, sx, 0.0, 0.02),
      box(0.10, 0.03, 0.22, -sx, 0.0, 0.02),
    ]);
  });
}

/* --- Roues (calibrées et affleurantes) ------------------------------------ */

function tireGeometry() {
  return cachedGeo('tire', () => {
    const r = C.wheelRadius;
    const hw = C.wheelWidth * 0.44; // pneu profilé affleurant la jante
    const pts = [
      new THREE.Vector2(0.240, -hw), new THREE.Vector2(r - 0.035, -hw),
      new THREE.Vector2(r - 0.008, -hw + 0.026), new THREE.Vector2(r, -hw + 0.052),
      new THREE.Vector2(r, hw - 0.052), new THREE.Vector2(r - 0.008, hw - 0.026),
      new THREE.Vector2(r - 0.035, hw), new THREE.Vector2(0.240, hw),
    ];
    const g = new THREE.LatheGeometry(pts, 28);
    g.rotateZ(-Math.PI / 2);
    return g;
  });
}

function spoke(a, w, x = 0.068, depth = 0.028, len = 0.195, r = 0.142) {
  const g = new THREE.BoxGeometry(depth, len, w);
  g.translate(0, r, 0);
  g.rotateX(a);
  g.translate(x, 0, 0);
  return g;
}

function rimGeometry(type) {
  return cachedGeo(`rim_${type}`, () => {
    const parts = [];
    const barrel = new THREE.CylinderGeometry(0.240, 0.240, 0.20, 24, 1, true);
    barrel.rotateZ(Math.PI / 2);
    parts.push(barrel);
    const lip = new THREE.TorusGeometry(0.238, 0.015, 6, 28);
    lip.rotateY(Math.PI / 2); lip.translate(0.088, 0, 0);
    parts.push(lip);
    const hub = new THREE.CylinderGeometry(0.052, 0.066, 0.05, 12);
    hub.rotateZ(Math.PI / 2); hub.translate(0.078, 0, 0);
    parts.push(hub);
    const TAU = Math.PI * 2;
    if (type === 'sport') {
      for (let k = 0; k < 5; k++) parts.push(spoke(k * TAU / 5, 0.058));
    } else if (type === 'multi') {
      for (let k = 0; k < 10; k++) parts.push(spoke(k * TAU / 10, 0.025, 0.068, 0.024));
    } else if (type === 'star') {
      for (let k = 0; k < 6; k++) {
        parts.push(spoke(k * TAU / 6 - 0.11, 0.028));
        parts.push(spoke(k * TAU / 6 + 0.11, 0.028));
      }
    } else {
      const d = new THREE.CylinderGeometry(0.232, 0.232, 0.02, 28);
      d.rotateZ(Math.PI / 2); d.translate(0.068, 0, 0);
      parts.push(d);
      const ring = new THREE.TorusGeometry(0.162, 0.013, 6, 24);
      ring.rotateY(Math.PI / 2); ring.translate(0.080, 0, 0);
      parts.push(ring);
    }
    return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  });
}

function brakeDiscGeometry() {
  return cachedGeo('brakeDisc', () => {
    const g = new THREE.CylinderGeometry(0.195, 0.195, 0.028, 20);
    g.rotateZ(Math.PI / 2); g.translate(-0.015, 0, 0);
    return g;
  });
}

function caliperGeometry() {
  return cachedGeo('caliper', () => box(0.065, 0.105, 0.15, 0.015, 0.155, 0.045, -0.5, 0, 0));
}

function flameGeometry() {
  return cachedGeo('flame', () => {
    const g = new THREE.ConeGeometry(0.1, 1, 10, 1, true);
    g.translate(0, -0.5, 0);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

/* ------------------------------------------------------------------------ */
/*  Matériaux partagés                                                      */
/* ------------------------------------------------------------------------ */
let SHARED = null;
function sharedMaterials() {
  if (SHARED) return SHARED;
  const mk = (m) => { m.userData.shared = true; return m; };
  SHARED = {
    glass: mk(new THREE.MeshStandardMaterial({ color: 0x0b0f16, metalness: 0.9, roughness: 0.06 })),
    black: mk(new THREE.MeshStandardMaterial({ color: 0x121315, metalness: 0.2, roughness: 0.65 })),
    tire: mk(new THREE.MeshStandardMaterial({ color: 0x19191b, metalness: 0.0, roughness: 0.9 })),
    headlight: mk(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 1.5 })),
    caliper: mk(new THREE.MeshStandardMaterial({ color: 0xc62828, metalness: 0.3, roughness: 0.4 })),
    disc: mk(new THREE.MeshStandardMaterial({ color: 0x7a7e84, metalness: 0.8, roughness: 0.4 })),
    chrome: mk(new THREE.MeshStandardMaterial({ color: 0xcfcfcf, metalness: 1.0, roughness: 0.2, side: THREE.DoubleSide })),
  };
  return SHARED;
}

export function setSharedCarEnvMap(envMap) {
  const s = sharedMaterials();
  for (const k in s) { s[k].envMap = envMap; s[k].needsUpdate = true; }
}

/* ------------------------------------------------------------------------ */
/*  Classe CarModel                                                         */
/* ------------------------------------------------------------------------ */
export class CarModel {
  /**
   * @param {object} cfg  { bodyType, color, rims, rimFinish, spoiler }
   * @param {object} opts { envMap }
   */
  constructor(cfg = {}, { envMap = null } = {}) {
    const S = sharedMaterials();
    this.envMap = envMap;
    this.root = new THREE.Group();
    this.root.name = 'car';
    this.body = new THREE.Group();
    this.body.position.y = GROUND_OFFSET;
    this.root.add(this.body);

    this.paint = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, envMap,
    });
    this.rimMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, envMap });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.6 });
    this.flameMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    const add = (geo, mat, parent = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      return m;
    };

    // Meshes de carrosserie dynamiques selon bodyType ('supercar' | 'formula' | 'muscle')
    this.bodyMesh = add(supercarBodyGeo(), this.paint);
    this.cabinMesh = add(supercarCabinGeo(), S.glass);
    this.blackMesh = add(supercarBlackGeo(), S.black);
    this.headlightMesh = add(headlightGeometry('supercar'), S.headlight);
    this.taillightMesh = add(taillightGeometry('supercar'), this.tailMat);
    add(exhaustGeometry(), S.chrome);

    // Flammes de boost (une par échappement)
    this.flames = [-0.42, 0.42].map((x) => {
      const f = add(flameGeometry(), this.flameMat);
      f.position.set(x, 0.27, 2.3);
      f.visible = false;
      return f;
    });
    this.exhaustLocal = [-0.42, 0.42].map((x) => new THREE.Vector3(x, 0.27 + GROUND_OFFSET, 2.35));

    // Aileron ancré dynamiquement sur `spoilerMountPoint`
    this.spoilerGroup = new THREE.Group();
    this.spoilerGroup.position.copy(CHASSIS_SPECS.supercar.spoilerMountPoint);
    this.body.add(this.spoilerGroup);

    // Roues : 0 AvG, 1 AvD, 2 ArG, 3 ArD
    this.wheels = [];
    const initTrack = CHASSIS_SPECS.supercar.trackHalfWidth;
    const layout = [
      [-initTrack, C.wheelFrontZ], [initTrack, C.wheelFrontZ],
      [-initTrack, C.wheelRearZ], [initTrack, C.wheelRearZ],
    ];
    for (const [x, z] of layout) {
      const root = new THREE.Group();
      root.position.set(x, WHEEL_REST_Y, z);
      const mirror = new THREE.Group();
      if (x < 0) mirror.scale.x = -1;
      root.add(mirror);
      const spin = new THREE.Group();
      mirror.add(spin);
      add(tireGeometry(), S.tire, spin);
      const rim = add(rimGeometry('sport'), this.rimMat, spin);
      add(brakeDiscGeometry(), S.disc, spin);
      add(caliperGeometry(), S.caliper, mirror);
      this.root.add(root);
      this.wheels.push({ root, mirror, spin, rim, mirrored: x < 0, baseZ: z });
    }

    this.cfg = {};
    this.apply({
      bodyType: 'supercar',
      color: '#1e88e5',
      rims: 'sport',
      rimFinish: 'silver',
      spoiler: 'gt',
      ...cfg,
    });
  }

  /** Applique une configuration complète. */
  apply(cfg) {
    if (cfg.bodyType !== undefined) this.setBodyType(cfg.bodyType);
    if (cfg.color !== undefined) this.setColor(cfg.color);
    if (cfg.rims !== undefined || cfg.rimFinish !== undefined) {
      this.setRims(cfg.rims ?? this.cfg.rims, cfg.rimFinish ?? this.cfg.rimFinish);
    }
    if (cfg.spoiler !== undefined) this.setSpoiler(cfg.spoiler);
  }

  /**
   * Change la silhouette de carrosserie ('supercar' | 'formula' | 'muscle'),
   * recalibre la voie/taille des roues et repositionne le point d'ancrage de l'aileron.
   */
  setBodyType(type = 'supercar') {
    if (!BODY_TYPES[type]) type = 'supercar';
    this.cfg.bodyType = type;

    if (type === 'formula') {
      this.bodyMesh.geometry = formulaBodyGeo();
      this.cabinMesh.geometry = formulaCabinGeo();
      this.blackMesh.geometry = formulaBlackGeo();
    } else if (type === 'muscle') {
      this.bodyMesh.geometry = muscleBodyGeo();
      this.cabinMesh.geometry = muscleCabinGeo();
      this.blackMesh.geometry = muscleBlackGeo();
    } else {
      this.bodyMesh.geometry = supercarBodyGeo();
      this.cabinMesh.geometry = supercarCabinGeo();
      this.blackMesh.geometry = supercarBlackGeo();
    }

    this.headlightMesh.geometry = headlightGeometry(type);
    this.taillightMesh.geometry = taillightGeometry(type);

    // Calibration des roues (voie latérale X et diamètre sous les ailes)
    const spec = CHASSIS_SPECS[type] || CHASSIS_SPECS.supercar;
    for (const w of this.wheels) {
      w.root.position.x = (w.mirrored ? -1 : 1) * spec.trackHalfWidth;
      w.root.scale.setScalar(spec.wheelScale);
    }

    // Ancrage dynamique de l'aileron sur le point précis du châssis
    this.spoilerGroup.position.copy(spec.spoilerMountPoint);
    if (this.cfg.spoiler) {
      this.setSpoiler(this.cfg.spoiler);
    }
  }

  setColor(hex) {
    this.cfg.color = hex;
    this.paint.color.set(hex);
  }

  setRims(type = 'sport', finish = 'silver') {
    if (!RIM_TYPES[type]) type = 'sport';
    if (!RIM_FINISHES[finish]) finish = 'silver';
    this.cfg.rims = type; this.cfg.rimFinish = finish;
    const geo = rimGeometry(type);
    for (const w of this.wheels) w.rim.geometry = geo;
    const f = RIM_FINISHES[finish];
    this.rimMat.color.setHex(f.color);
    this.rimMat.metalness = f.metalness;
    this.rimMat.roughness = f.roughness;
  }

  setSpoiler(type = 'none') {
    if (!SPOILER_TYPES[type]) type = 'none';
    this.cfg.spoiler = type;
    const bodyType = this.cfg.bodyType || 'supercar';
    const spec = CHASSIS_SPECS[bodyType] || CHASSIS_SPECS.supercar;

    this.spoilerGroup.position.copy(spec.spoilerMountPoint);
    this.spoilerGroup.clear();

    const geo = spoilerGeometry(type, bodyType);
    if (geo) this.spoilerGroup.add(new THREE.Mesh(geo, this.paint));
    if (type === 'gt') {
      this.spoilerGroup.add(new THREE.Mesh(spoilerStrutGeometry(bodyType), sharedMaterials().black));
    }
  }

  setEnvMap(envMap) {
    this.envMap = envMap;
    for (const m of [this.paint, this.rimMat]) { m.envMap = envMap; m.needsUpdate = true; }
  }

  setBraking(on) {
    this.tailMat.emissiveIntensity = on ? 3.2 : 0.6;
  }

  setBoost(on, t = 0) {
    for (let i = 0; i < 2; i++) {
      const f = this.flames[i];
      f.visible = on;
      if (on) {
        const k = 0.8 + 0.35 * Math.sin(t * 60 + i * 2.1) + 0.2 * Math.random();
        f.scale.set(1 + 0.2 * Math.random(), 1 + 0.2 * Math.random(), k);
      }
    }
    if (on) this.flameMat.color.setHSL(0.55 + Math.random() * 0.05, 1, 0.6 + Math.random() * 0.1);
  }

  setWheel(i, y, steer, spin) {
    const w = this.wheels[i];
    w.root.position.y = y;
    w.root.rotation.y = steer;
    w.spin.rotation.x = spin;
  }

  dispose() {
    this.paint.dispose(); this.rimMat.dispose(); this.tailMat.dispose(); this.flameMat.dispose();
    this.root.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
    this.root.removeFromParent();
  }
}
