/**
 * trackLayout.js — Géométrie 3D des 3 circuits :
 *  - Circuit 1 (`flat`)     : Plaine Technique (Plat)
 *  - Circuit 2 (`mountain`) : Col de Montagne (Relief 3D & Falaises)
 *  - Circuit 3 (`valley`)   : Vallée & Pont (Rivière, Viaduc/Tunnel, Boucle Hélicoïdale & Paddock)
 *
 * Calcule :
 *  - Ligne centrale échantillonnée en 3D (positions x/y/z, pentes, tangentes, normales, courbure)
 *  - Ligne idéale (trajectoire de course) par lissage contraint
 *  - Profil de vitesse cible pour l'IA tenant compte de la courbure ET de la pente (dénivelé)
 *  - Requêtes spatiales 3D distinguant le passage inférieur (tunnel/sous-pont) et le tablier supérieur du pont
 *  - Zéro allocation mémoire par frame (`_projScratch`, `_sampleOutScratch`, `_crossingScratch` pré-alloués)
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js?v=40';
import { clamp, wrap } from '../core/utils.js?v=40';

/** Circuit 1 : Tracé technique plat d'origine [x, y, z]. */
export const TRACK_POINTS_FLAT = [
  [-40, 0, 200], [80, 0, 200], [170, 0, 198],          // grande ligne droite (départ)
  [232, 0, 182], [258, 0, 138],                        // virage 1 rapide
  [248, 0, 84], [205, 0, 62],                          // virage 2
  [155, 0, 64], [126, 0, 66], [106, 0, 47], [80, 0, 40], // chicane
  [48, 0, 34], [14, 0, 6], [8, 0, -52],                // section centrale
  [40, 0, -102], [110, 0, -120], [192, 0, -126],       // section arrière
  [238, 0, -148], [262, 0, -184], [244, 0, -216], [204, 0, -224], // épingle
  [110, 0, -226], [-10, 0, -214], [-120, 0, -198],     // ligne droite opposée
  [-196, 0, -170], [-246, 0, -112], [-254, 0, -34],    // grande courbe
  [-226, 0, 36], [-252, 0, 104],                       // enchaînement (esses)
  [-232, 0, 170], [-160, 0, 200],                      // dernier virage
];

/**
 * Circuit 2 : "Col de Montagne" — Tracé alpin à fort dénivelé [x, y, z].
 */
export const TRACK_POINTS_MOUNTAIN = [
  [-45, 0, 210], [75, 0, 210], [175, 2, 206],          // départ dans la vallée
  [245, 9, 180], [272, 17, 125],                       // grande montée raide vers le col
  [255, 24, 62], [200, 27, 32],                        // corniche haute altitude (+27 m)
  [135, 26, 42], [85, 23, 18], [32, 18, -10],          // enchaînement sur la crête
  [-5, 12, -62], [28, 7, -118], [115, 11, -138],       // vallon suspendu
  [205, 16, -145], [262, 14, -182], [242, 7, -226],    // lacet du belvédère
  [175, 2, -236], [65, 0, -224], [-55, 0, -208],       // grande plongée rapide vers la vallée
  [-155, 4, -188], [-228, 12, -142], [-258, 19, -70],  // remontée du versant ouest
  [-242, 16, 10], [-212, 9, 78], [-245, 4, 142],       // descente sinueuse en S
  [-215, 1, 195], [-140, 0, 210],                      // retour vallée
];

/**
 * Circuit 3 : "Vallée & Pont" — Boucle asymétrique ultra-détaillée [x, y, z].
 */
export const TRACK_POINTS_VALLEY = [
  [-65, 3.5, 200], [55, 3.5, 200], [155, 3.5, 196],    // ligne droite départ / Paddock & Stands
  [228, 2.2, 165], [256, 0.8, 110], [242, 0.5, 48],    // plongée rapide vers la rivière Est
  [192, 0.5, 16], [150, 0.5, 24], [116, 0.5, -6], [76, 0.5, 0], // chicane technique des berges
  [34, 0.5, 0], [0, 0.5, 0], [-34, 0.5, 0], [-82, 0.5, 0],      // passage SOUS le pont (viaduc y = 0.5 m)
  [-152, 1.6, -18], [-212, 4.2, -72], [-228, 7.6, -146],        // entrée de la boucle hélicoïdale
  [-186, 10.6, -210], [-106, 12.8, -224], [-34, 13.8, -182],    // ascension hélicoïdale sur la falaise
  [0, 14.0, -122], [0, 14.0, -72], [0, 14.0, -34],              // alignement et entrée sur le grand Pont
  [0, 14.0, 0], [0, 14.0, 34], [0, 14.0, 74],                   // traversée SUR le Pont (y = 14.0 m)
  [-16, 12.0, 124], [-72, 8.8, 146], [-148, 6.0, 136],          // descente du pont vers le hameau Ouest
  [-210, 4.4, 156], [-198, 3.7, 194], [-138, 3.5, 200],         // épingle Ouest et retour Paddock
];

/**
 * Circuit 4 : "Lac & Végétation" — Reproduction fidèle du tracé manuscrit en "S" allongé [x, y, z] :
 *  - Ligne de départ intérieure (« départ ») sur le segment droit central
 *  - Lobe Nord autour du Lac (« LAKE ») : descente sous la rive sud, fer à cheval à plat à l'est,
 *    forte montée (rouge) au nord-est jusqu'à la crête, puis grande courbe nord-ouest en descente
 *  - Flanc Ouest en forte montée longeant la forêt dense (« végétation »), corridor central et boucle sud
 *  - Épingle Sud extérieure avec plongée en descente prononcée puis remontée sud-est et retour plat/descente
 */
export const TRACK_POINTS_LAKE = [
  // 1. Ligne de Départ / Arrivée (« départ », section droite de 140m pour la grille, altitude basse 8.0m)
  [-38, 8.0, -103], [38, 8.0, -55],
  // 2. Enchaînement de 3 virages moyens en S (esses rapides Est) en plongée vers le creux de la vallée (2.2m)
  [118, 5.0, -4], [152, 2.5, 68], [218, 2.2, 138], [196, 3.0, 224], [244, 6.0, 308],
  // 3. Forte « montée » abrupte (rouge en bas à droite) vers le sommet de l'épingle Sud (culmine à 62.0m !)
  [234, 24.0, 436], [156, 46.0, 534], [30, 62.0, 572],
  // 4. Grande plongée vertigineuse en « descente » (bleu en bas) de 62.0m jusqu'au creux Sud-Ouest (2.0m !)
  [-92, 44.0, 562], [-192, 18.0, 500], [-212, 4.5, 408], [-160, 2.0, 352],
  // 5. Boucle intérieure Sud en cuvette basse (2.0m -> 4.5m) au ras de la forêt dense
  [-92, 2.2, 382], [-30, 3.0, 454], [50, 3.5, 470], [96, 4.0, 416],
  // 6. Traversée centrale en S fluide (2.5m -> 6.0m) au coeur du couloir de « végétation »
  [76, 3.2, 332], [8, 2.5, 256], [-108, 3.0, 212], [-226, 5.5, 168],
  // 7. Flanc Ouest : forte « montée » abrupte (rouge à gauche, de 5.5m à 66.0m !) avec triple courbe en S fluide
  [-304, 20.0, 92], [-282, 36.0, 6], [-332, 52.0, -82], [-302, 62.0, -168], [-324, 66.0, -252],
  // 8. Grande courbe Nord-Ouest : plongée vertigineuse en « descente » (bleu en haut à gauche, de 66.0m à 2.5m !)
  [-286, 46.0, -368], [-218, 22.0, -458], [-128, 6.5, -502], [-32, 2.5, -518],
  // 9. Lobe Nord autour du Lac (« LAKE ») : forte « montée » (rouge en haut à droite, de 2.5m à 54.0m)
  [72, 14.0, -520], [192, 32.0, -498], [286, 48.0, -445], [332, 54.0, -365],
  // 10. Fer à cheval Est du Lac puis grande plongée en « descente » sous la rive Sud du Lac (54.0m -> 2.2m)
  [328, 52.0, -290], [272, 38.0, -235], [176, 18.0, -226],
  [72, 4.5, -235], [-38, 2.2, -248], [-134, 2.5, -260],
  // 11. Courbe Nord-Ouest en cuvette remontant légèrement vers la ligne droite de « départ » (8.0m)
  [-180, 5.0, -218], [-110, 8.0, -152],
];

/**
 * Circuit 5 : "Le Col de la Grotte" (Mountain Pass & Under-tunnel) — Format XL (longueur x1,5 / hauteur x2) [x, y, z] :
 *  1. Grande Ligne Droite (Départ/Arrivée) au niveau du sol (Y = 0) longeant le canyon Sud (z = 540)
 *  2. Ascension & Épingles de la Montagne Est (lacets serrés et chicanes à flanc de falaise, Y grimpe jusqu'à +71m)
 *  3. Piste Supérieure sur la crête rocheuse sommitale (Y = 71.2m, z = -52.5) avec glissières doublées et vue plongeante
 *  4. Grande descente rapide sur le versant Nord-Ouest plongeant vers l'entrée Nord du tunnel (Y -> 0.5m)
 *  5. Piste Inférieure & Long Tunnel Rocheux (x = 0, z de -158 à +33, Y = 0.5m) passant 70m EN DESSOUS de la crête sommitale
 *  6. Grand Pont / Viaduc à arches (x = 0, z de +78 à +186, Y culmine à 13.6m) enjambant la rivière animée du canyon avant le retour départ
 */
export const TRACK_POINTS_GROTTO = [
  // 1. Très Grande Ligne Droite du Canyon Sud (Départ / Arrivée à Y = 0, z = 540, ~825 m de pleine vitesse)
  [-255, 0.0, 540], [-98, 0.0, 540], [68, 0.0, 540], [232, 0.0, 540], [398, 0.0, 540],
  // 2. Grande Courbe Est & L'Ascension des Lacets Alpins (Y grimpe progressivement de 0 à +71.0m)
  [532, 3.6, 516], [652, 10.4, 429], [723, 19.0, 297], [693, 27.6, 162],
  [573, 35.0, 93], [492, 41.6, 6], [537, 48.0, -87],           // Épingle alpine 1 & corniche de falaise
  [663, 54.4, -156], [732, 60.4, -252], [672, 65.6, -351],    // Grande boucle orientale & Épingle 2
  [532, 68.8, -363], [387, 70.0, -285], [288, 70.6, -162], [207, 71.0, -78],
  // 3. La Piste Supérieure (Crête rocheuse sommitale à Y = 71.2m, passant 70m AU-DESSUS du tunnel en (0, -52.5))
  [123, 71.2, -54], [60, 71.2, -52.5], [0, 71.2, -52.5], [-60, 71.2, -52.5], [-123, 71.2, -54], [-207, 70.6, -66],
  // 4. Grande Descente Rapide & Vallée Nord-Ouest Haute Vitesse (Y plonge de 70.6m à 0.5m)
  [-327, 62.8, -102], [-468, 50.4, -162], [-608, 37.0, -231],
  [-708, 24.4, -333], [-723, 14.0, -453], [-633, 6.8, -552],
  [-483, 3.2, -582], [-308, 1.8, -552], [-158, 1.2, -477],
  [-48, 0.5, -366], [0, 0.5, -249],
  // 5. La Piste Inférieure & Le Long Tunnel Rocheux (x = 0, z de -158 à +33, Y = 0.5m, soit 70m SOUS la crête !)
  [0, 0.5, -158], [0, 0.5, -90], [0, 0.5, -30], [0, 0.5, 33],
  // 6. Le Grand Pont / Viaduc au-dessus de la rivière du canyon (x = 0, z de +78 à +186, Y culmine à 13.6m)
  [0, 6.8, 78], [0, 13.6, 132], [0, 8.0, 186],
  // 7. Grande Enchaînement Sud-Ouest du Canyon & Retour Ligne Droite (large rayon fluide vers z = 540)
  [-48, 3.2, 249], [-159, 1.2, 291], [-312, 0.4, 306], [-474, 0.0, 321],
  [-606, 0.0, 372], [-648, 0.0, 453], [-573, 0.0, 519], [-428, 0.0, 540],
];

export const CIRCUITS = {
  flat: {
    id: 'flat',
    name: 'Circuit 1 — Plaine Technique (Plat)',
    points: TRACK_POINTS_FLAT,
    hasRelief: false,
    hasBridge: false,
    hasTunnel: false,
  },
  mountain: {
    id: 'mountain',
    name: 'Circuit 2 — Col de Montagne (Relief)',
    points: TRACK_POINTS_MOUNTAIN,
    hasRelief: true,
    hasBridge: false,
    hasTunnel: false,
  },
  valley: {
    id: 'valley',
    name: 'Circuit 3 — Vallée & Pont (Viaduc & Rivière)',
    points: TRACK_POINTS_VALLEY,
    hasRelief: true,
    hasBridge: true,
    hasTunnel: false,
  },
  lake: {
    id: 'lake',
    name: 'Circuit 4 — Lac & Végétation',
    points: TRACK_POINTS_LAKE,
    hasRelief: true,
    hasBridge: false,
    hasTunnel: false,
  },
  grotto: {
    id: 'grotto',
    name: 'Circuit 5 — Le Col de la Grotte (Montagne & Tunnel)',
    points: TRACK_POINTS_GROTTO,
    hasRelief: true,
    hasBridge: true,
    hasTunnel: true,
  },
};

export class TrackLayout {
  constructor(circuitId = 'flat') {
    const circuit = CIRCUITS[circuitId] || CIRCUITS.flat;
    this.circuitId = circuit.id;
    this.hasRelief = circuit.hasRelief;
    this.hasBridge = Boolean(circuit.hasBridge);
    this.hasTunnel = Boolean(circuit.hasTunnel);

    const cfg = CONFIG.track;
    this.halfWidth = cfg.halfWidth;
    this.barrierDistance = cfg.halfWidth + cfg.barrierOffset;

    const rawPoints = circuit.points.map((p) =>
      p.length === 3 ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3(p[0], 0, p[1])
    );

    const curve = new THREE.CatmullRomCurve3(rawPoints, true, 'centripetal');
    this.curve = curve;

    // Longueur 2D/3D et échantillonnage régulier (multiple de 8 pour éviter tout décalage aux boucles)
    this.length = curve.getLength();
    const n = Math.max(64, Math.round(this.length / (cfg.sampleSpacing * 8)) * 8);
    this.count = n;
    this.ds = this.length / n;

    const pts = curve.getSpacedPoints(n);
    pts.length = n;

    // Lisse le profil d'altitude Y pour garantir un ruban continu sans cassure de pente ni tremblements
    const rawY = new Float32Array(n);
    for (let i = 0; i < n; i++) rawY[i] = Math.max(0, pts[i].y);
    let smoothY = rawY;
    if (this.hasRelief) {
      const passes = 4;
      const radius = 8;
      for (let p = 0; p < passes; p++) {
        smoothY = smoothLoop(smoothY, radius);
      }
    }
    for (let i = 0; i < n; i++) pts[i].y = Math.max(0, smoothY[i]);

    this.points = pts;
    this.tangents = new Array(n);    // tangente horizontale unitaire (tx, 0, tz)
    this.tangents3D = new Array(n);  // tangente 3D unitaire (tx, ty, tz)
    this.rights = new Array(n);      // vecteur droite horizontal (-tz, 0, tx)
    this.slopes = new Float32Array(n); // pente longitudinale dy/ds (+ = montée, - = descente)

    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const d3 = new THREE.Vector3().subVectors(b, a);
      const t3 = d3.clone().normalize();
      this.tangents3D[i] = t3;
      this.slopes[i] = (b.y - a.y) / (2 * this.ds);

      const t = new THREE.Vector3(d3.x, 0, d3.z).normalize();
      this.tangents[i] = t;
      this.rights[i] = new THREE.Vector3(-t.z, 0, t.x);
    }

    // Courbure horizontale signée (+ = virage à droite), lissée
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t0 = this.tangents[(i - 1 + n) % n], t1 = this.tangents[(i + 1) % n];
      const r = this.rights[i];
      raw[i] = ((t1.x - t0.x) * r.x + (t1.z - t0.z) * r.z) / (2 * this.ds);
    }
    this.curvature = smoothLoop(raw, 3);

    this.bounds = new THREE.Box3().setFromPoints(pts);

    // Volume déclencheur et plan orienté exacts de la ligne de départ/arrivée (Start/Finish Line)
    this.finishLine = {
      origin: this.points[0].clone(),
      normal: this.tangents[0].clone(),
      right: this.rights[0].clone(),
      halfWidth: this.barrierDistance + 1.5,
      halfHeight: 4.5,
      halfDepth: 6.0,
    };

    // Objets de travail pré-alloués pour éviter toute allocation dans la boucle 60 FPS
    this._projScratch = { index: 0, s: 0, lateral: 0, dist: 0, y: 0, slope: 0 };
    this._samplePosScratch = new THREE.Vector3();
    this._sampleTanScratch = new THREE.Vector3();
    this._sampleOutScratch = { position: this._samplePosScratch, tangent: this._sampleTanScratch, slope: 0 };
    this._crossingScratch = { crossed: false, fraction: 0 };

    this._computeRacingLine();
    this._computeSpeedProfile();
  }

  /* ------------------------------------------------------------------ */
  /*  Ligne idéale                                                       */
  /* ------------------------------------------------------------------ */

  _computeRacingLine() {
    const n = this.count;
    const step = 4;
    const m = Math.floor(n / step);
    const maxLat = this.halfWidth - CONFIG.ai.lineMargin;
    const cx = new Float32Array(m), cz = new Float32Array(m);
    const rx = new Float32Array(m), rz = new Float32Array(m);
    const px = new Float32Array(m), pz = new Float32Array(m);
    const lat = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      const p = this.points[k * step], r = this.rights[k * step];
      cx[k] = px[k] = p.x; cz[k] = pz[k] = p.z; rx[k] = r.x; rz[k] = r.z;
    }
    const nx = new Float32Array(m), nz = new Float32Array(m);
    const constrain = () => {
      for (let k = 0; k < m; k++) {
        let l = (nx[k] - cx[k]) * rx[k] + (nz[k] - cz[k]) * rz[k];
        l = clamp(l, -maxLat, maxLat);
        lat[k] = l;
        px[k] = cx[k] + rx[k] * l; pz[k] = cz[k] + rz[k] * l;
      }
    };
    for (let it = 0; it < 400; it++) {
      for (let k = 0; k < m; k++) {
        const a = (k - 1 + m) % m, b = (k + 1) % m;
        nx[k] = px[k] + 0.4 * ((px[a] + px[b]) * 0.5 - px[k]);
        nz[k] = pz[k] + 0.4 * ((pz[a] + pz[b]) * 0.5 - pz[k]);
      }
      constrain();
    }
    for (let it = 0; it < 1800; it++) {
      for (let k = 0; k < m; k++) {
        const a2 = (k - 2 + m) % m, a = (k - 1 + m) % m, b = (k + 1) % m, b2 = (k + 2) % m;
        const d4x = px[a2] - 4 * px[a] + 6 * px[k] - 4 * px[b] + px[b2];
        const d4z = pz[a2] - 4 * pz[a] + 6 * pz[k] - 4 * pz[b] + pz[b2];
        nx[k] = px[k] - 0.1 * d4x;
        nz[k] = pz[k] - 0.1 * d4z;
      }
      constrain();
    }
    this.racingLat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = i / step;
      const k0 = Math.floor(f) % m, k1 = (k0 + 1) % m, t = f - Math.floor(f);
      this.racingLat[i] = lat[k0] * (1 - t) + lat[k1] * t;
    }
    this.racingPoints = this.points.map((p, i) =>
      p.clone().addScaledVector(this.rights[i], this.racingLat[i]));
  }

  /** Profil de vitesse tenant compte de la courbure et de l'allongement du freinage en descente. */
  _computeSpeedProfile() {
    const n = this.count, rp = this.racingPoints, k = 3;
    const curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rp[(i - k + n) % n], b = rp[i], c = rp[(i + k) % n];
      const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z, acx = c.x - a.x, acz = c.z - a.z;
      const cross = abx * bcz - abz * bcx;
      const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
      curv[i] = den > 1e-6 ? Math.abs(2 * cross / den) : 0;
    }
    this.racingCurvature = smoothLoop(curv, 3);

    const { lateralAccel, brakeDecel, maxSpeed } = CONFIG.ai;
    const g = CONFIG.physics.gravity;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.max(this.racingCurvature[i], 1e-5);
      const slopeMod = this.slopes[i] < -0.02 ? 0.92 : 1.0;
      v[i] = Math.min(maxSpeed, Math.sqrt((lateralAccel * slopeMod) / c));
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let j = n - 1; j >= 0; j--) {
        const i = j, nxt = (j + 1) % n;
        const effDecel = Math.max(4.2, brakeDecel + g * this.slopes[i]);
        v[i] = Math.min(v[i], Math.sqrt(v[nxt] * v[nxt] + 2 * effDecel * this.ds));
      }
    }
    this.speedProfile = v;
  }

  /* ------------------------------------------------------------------ */
  /*  Requêtes spatiales 3D (avec distinction pont / passage inférieur)  */
  /* ------------------------------------------------------------------ */

  findNearestIndex(x, z, hint = -1, window = 65, y = undefined) {
    const n = this.count, pts = this.points;
    const hasY = typeof y === 'number' && Number.isFinite(y);
    let best = -1, bestD = Infinity;
    if (hint >= 0) {
      for (let o = -window; o <= window; o++) {
        const i = (hint + o + n) % n, p = pts[i];
        const dy = hasY ? (p.y - y) : 0;
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) + dy * dy * 7.5;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD < 32 * 32) return best;
    }
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const dy = hasY ? (p.y - y) : 0;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) + dy * dy * 9.0;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Indique si la position 3D `(x, y, z)` se trouve à l'intérieur du tunnel rocheux (ou sous le viaduc).
   * Permet d'activer l'effet sonore d'écho/réverbération dans le tunnel.
   */
  isInTunnel(x, y, z) {
    if (this.circuitId === 'grotto') {
      return Math.abs(x) <= 14.0 && z >= -156 && z <= 36 && y <= 12.0;
    }
    if (this.circuitId === 'valley') {
      return Math.abs(x) <= 16.0 && Math.abs(z) <= 14.0 && y <= 5.5;
    }
    return false;
  }

  project(x, z, hint = -1, yOrOut = undefined, maybeOut = undefined) {
    let y = undefined;
    let out = maybeOut || this._projScratch;
    if (typeof yOrOut === 'number') {
      y = yOrOut;
    } else if (yOrOut && typeof yOrOut === 'object') {
      out = yOrOut;
    }

    const i = this.findNearestIndex(x, z, hint, 65, y);
    const n = this.points.length;
    const p = this.points[i], t = this.tangents[i], r = this.rights[i];
    const dx = x - p.x, dz = z - p.z;
    const along = clamp(dx * t.x + dz * t.z, -this.ds, this.ds);
    const pAdj = along >= 0 ? this.points[(i + 1) % n] : this.points[(i - 1 + n) % n];
    const frac = Math.min(1, Math.abs(along) / (this.ds || 1));
    out.index = i;
    out.s = wrap(i * this.ds + dx * t.x + dz * t.z, this.length);
    out.lateral = dx * r.x + dz * r.z;
    out.dist = Math.hypot(dx, dz);
    out.y = Math.max(0, p.y + (pAdj.y - p.y) * frac);
    out.slope = this.slopes[i];
    out.tangent = t;
    return out;
  }

  sample(s, lateral = 0, outPos = this._samplePosScratch, outTan = this._sampleTanScratch) {
    const n = this.count;
    const f = wrap(s, this.length) / this.ds;
    const i0 = Math.floor(f) % n, i1 = (i0 + 1) % n, t = f - Math.floor(f);
    outPos.lerpVectors(this.points[i0], this.points[i1], t);
    outTan.lerpVectors(this.tangents[i0], this.tangents[i1], t).normalize();
    outPos.x += -outTan.z * lateral;
    outPos.z += outTan.x * lateral;
    const slope = this.slopes[i0] * (1 - t) + this.slopes[i1] * t;
    const res = this._sampleOutScratch;
    res.position = outPos;
    res.tangent = outTan;
    res.slope = slope;
    return res;
  }

  distanceToCenterline(x, z) {
    let best = Infinity;
    const pts = this.points;
    for (let i = 0; i < this.count; i += 2) {
      const p = pts[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /**
   * Vérifie si le segment [prevPos -> currPos] traverse le plan orienté et le volume déclencheur
   * exacts de la ligne de départ/arrivée (Start/Finish Line au marquage au sol `points[0]`).
   */
  checkFinishLineCrossing(prevPos, currPos) {
    const fl = this.finishLine;
    const ox = fl.origin.x, oy = fl.origin.y, oz = fl.origin.z;
    const nx = fl.normal.x, nz = fl.normal.z;
    const rx = fl.right.x, rz = fl.right.z;

    const dx0 = prevPos.x - ox, dz0 = prevPos.z - oz;
    const dx1 = currPos.x - ox, dz1 = currPos.z - oz;

    const d0 = dx0 * nx + dz0 * nz;
    const d1 = dx1 * nx + dz1 * nz;
    const out = this._crossingScratch;

    if (d0 < 0 && d1 >= 0 && d0 >= -15 && d1 <= 15) {
      const denom = d1 - d0;
      const frac = denom > 1e-5 ? clamp(-d0 / denom, 0, 1) : 1.0;
      const ix = prevPos.x + (currPos.x - prevPos.x) * frac;
      const iy = prevPos.y + (currPos.y - prevPos.y) * frac;
      const iz = prevPos.z + (currPos.z - prevPos.z) * frac;

      const lat = (ix - ox) * rx + (iz - oz) * rz;
      const vert = Math.abs(iy - oy);
      if (Math.abs(lat) <= fl.halfWidth && vert <= fl.halfHeight) {
        out.crossed = true;
        out.fraction = frac;
        return out;
      }
    }
    out.crossed = false;
    out.fraction = 0;
    return out;
  }
}

function smoothLoop(arr, radius) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let o = -radius; o <= radius; o++) s += arr[(i + o + n) % n];
    out[i] = s / (2 * radius + 1);
  }
  return out;
}
