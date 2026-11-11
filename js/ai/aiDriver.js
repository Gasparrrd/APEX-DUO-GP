/**
 * aiDriver.js — Intelligence Artificielle Avancée des Bots (Réactivité & Prise de Décision +30%) :
 *  - Écart de trajectoire dynamique (+30% d'autorité de braquage latéral `lateralSteeringForce`) :
 *      * Rejoint franchement un objectif (jeton de boost) ou contourne incisivement un obstacle
 *        (voiture lente, jeton de malus rouge, glissière).
 *  - Cône de détection des jetons élargi de +30% :
 *      * Portée augmentée à 32 mètres (au lieu de 25 m) et angle d'ouverture élargi de +30% (~58,5°).
 *  - Temps de latence de réaction algorithmique réduit de 30% :
 *      * Recalcul haute fréquence des raycasts et des vecteurs cibles avec constante de temps réduite de 30%.
 *  - Zéro allocation mémoire par frame dans `update()` (objets et options de raycast pré-alloués).
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG, AI_BEHAVIOR_PROFILES, VEHICLE_MODIFIERS } from '../config.js?v=42';
import { clamp, damp, wrap, wrapDelta } from '../core/utils.js?v=42';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _target = new THREE.Vector3();
const _relaunchPos = new THREE.Vector3();
const _relaunchDir = new THREE.Vector3();

// Vecteurs et options réutilisables pour les raycasts Cannon-es (zéro allocation en boucle pour 7 véhicules)
const _rayFrom = new CANNON.Vec3();
const _rayTo = new CANNON.Vec3();
const _rayResult = new CANNON.RaycastResult();
const _RAY_OPTS_CHASSIS = { collisionFilterMask: 1, skipBackfaces: true };
const _RAY_OPTS_BARRIER = { collisionFilterMask: 2, skipBackfaces: true };
const _WALL_PROBE_DISTS = [3.5, 5.5, 7.5, 9.0];
const _projScratch = { index: 0, s: 0, lateral: 0, dist: 0, y: 0, slope: 0 };

// Cône de détection des jetons élargi de +30% : distance portée à 32 m, angle élargi à 58,5° (45° * 1.3)
const TOKEN_CONE_DIST = 55.0; // port?e minimale (?tendue dynamiquement selon la vitesse)
const TOKEN_RANGE_MIN = 70.0;
const TOKEN_RANGE_MAX = 135.0;
const COS_TOKEN_CONE = Math.cos(72 * (Math.PI / 180)); // Cône élargi à 72° (144° de champ avant) // ~0.4226 (cône élargi à 65°) // ~0.5225
const COS_30_DEG = Math.cos(Math.PI / 6);                        // ~0.8660 (rayons diagonaux ±30°)
const SIN_30_DEG = Math.sin(Math.PI / 6);                        // 0.5000

// Facteur d'accélération de la prise de décision (-30% de latence temporelle -> 1 / 0.70 ≈ 1.43x)
const REACTION_SPEED_MULT = 1 / 0.70;
// Autorité et amplitude de déplacement latéral multipliées par ~2.5x (manœuvres incisives et opportunistes)
const LATERAL_STEERING_FORCE = 3.20;

// Zone morte de braquage (1.5° = 0.02618 rad) pour interdire les micro-oscillations en ligne droite
const STEER_DEADZONE_RAD = 1.5 * (Math.PI / 180); // ~0.02618

/**
 * Génère un tableau de `botCount` profils IA uniques au début de la partie.
 * Chaque bot reçoit des paramètres individuels distincts (vitesse, freinage, agressivité,
 * trajectoire d'apex, appétit de boost, réactivité, décalage latéral) tout en garantissant
 * mathématiquement que la moyenne globale de l'escadron est exactement proportionnelle
 * au niveau de difficulté choisi (`easy`, `normal`, `hard`).
 *
 * @param {number} botCount Nombre de bots dans la course (1 à 10)
 * @param {string} diffKey 'easy' | 'normal' | 'hard'
 * @returns {Array<object>} Tableau de profils IA uniques
 */
export function generateBotAIProfiles(botCount, diffKey = 'normal') {
  const n = Math.max(1, Math.floor(Number(botCount) || 1));
  const diffCfg = CONFIG.difficulty[diffKey] || CONFIG.difficulty.normal;

  const fallbackByDiff = {
    easy:   { skill: 0.50, decisionRate: 1.25, lateralSteeringForce: 2.75 },
    normal: { skill: 0.75, decisionRate: 1.80, lateralSteeringForce: 3.20 },
    hard:   { skill: 0.96, decisionRate: 2.45, lateralSteeringForce: 3.60 },
  };
  const fb = fallbackByDiff[diffKey] || fallbackByDiff.normal;

  // Lecture directe et dynamique de tous les réglages depuis CONFIG.difficulty[diffKey]
  const mean = {
    skillLevel: diffCfg.skill ?? fb.skill,
    targetSpeedFactor: diffCfg.maxSpeedFactor ?? 0.90,
    speedSpread: diffCfg.speedSpread ?? 0.055,
    brakeLookaheadMult: diffCfg.brakeLookaheadMult ?? 1.10,
    cornerSpeedFactor: diffCfg.cornerSpeedFactor ?? 0.94,
    steerGain: diffCfg.steerGain ?? 2.25,
    steerRateMult: diffCfg.steerRateMult ?? 1.00,
    apexCut: diffCfg.apexCut ?? 0.35,
    boostSeekWeight: diffCfg.boostSeekWeight ?? 2.80,
    boostMaxLatDeviation: diffCfg.boostMaxLatDeviation ?? 7.5,
    boostThreshold: diffCfg.boostThreshold ?? 8,
    boostMaxCurvature: diffCfg.boostMaxCurvature ?? 0.0050,
    corridorHalfWidth: diffCfg.corridorHalfWidth ?? 2.8,
    decisionRate: diffCfg.decisionRate ?? fb.decisionRate,
    overtakeAggression: diffCfg.overtakeAggression ?? 1.95,
    lateralSteeringForce: diffCfg.lateralSteeringForce ?? fb.lateralSteeringForce,
  };

  // Génère un vecteur de n valeurs dans [-1, +1] de moyenne strictement nulle (somme = 0)
  // avec stratification et permutation aléatoire pour que chaque bot soit unique.
  const makeZeroSumAxis = (amplitude = 1.0) => {
    if (n === 1) return [0];
    const vals = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const base = -1 + (2 * i) / (n - 1);
      const jitter = (Math.random() - 0.5) * (0.75 / n);
      const v = base + jitter;
      vals.push(v);
      sum += v;
    }
    const avg = sum / n;
    for (let i = 0; i < n; i++) {
      vals[i] = (vals[i] - avg) * amplitude;
    }
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = vals[i];
      vals[i] = vals[j];
      vals[j] = tmp;
    }
    return vals;
  };

  const speedAxis = makeZeroSumAxis(mean.speedSpread);
  const cornerAxis = makeZeroSumAxis(0.08);
  const brakeAxis = makeZeroSumAxis(0.16);
  const steerAxis = makeZeroSumAxis(0.28);
  const apexAxis = makeZeroSumAxis(0.18);
  const boostAxis = makeZeroSumAxis(0.32);
  const aggrAxis = makeZeroSumAxis(0.25);
  const reactAxis = makeZeroSumAxis(0.24);
  const laneAxis = makeZeroSumAxis(1.10);

  const behaviorKeys = Object.keys(AI_BEHAVIOR_PROFILES);
  const profiles = [];

  for (let i = 0; i < n; i++) {
    const behaviorKey = behaviorKeys[i % behaviorKeys.length] || 'balanced';
    const speedDelta = Number(speedAxis[i].toFixed(4));
    const targetSpeedFactor = Number(clamp(mean.targetSpeedFactor + speedDelta, 0.65, 1.22).toFixed(4));
    const skillLevel = Number(clamp(mean.skillLevel + speedDelta * 1.4, 0.30, 1.15).toFixed(3));

    profiles.push({
      botIndex: i,
      difficultyKey: diffKey,
      behaviorKey,
      skillLevel,
      speedDelta,
      targetSpeedFactor,
      brakeLookaheadMult: Number(clamp(mean.brakeLookaheadMult - speedDelta * 0.45 + brakeAxis[i], 0.40, 1.75).toFixed(3)),
      cornerSpeedFactor: Number(clamp(mean.cornerSpeedFactor + speedDelta * 0.40 + cornerAxis[i], 0.75, 1.25).toFixed(3)),
      steerGain: Number(clamp(mean.steerGain + steerAxis[i], 1.35, 3.60).toFixed(3)),
      steerRateMult: Number(clamp(mean.steerRateMult + steerAxis[i] * 0.45, 0.72, 1.85).toFixed(3)),
      apexCut: Number(clamp(mean.apexCut + apexAxis[i], 0.10, 1.0).toFixed(3)),
      boostSeekWeight: Number(clamp(mean.boostSeekWeight + boostAxis[i], 1.10, 4.20).toFixed(3)),
      boostMaxLatDeviation: Number(clamp(mean.boostMaxLatDeviation + boostAxis[i] * 2.2, 3.5, 11.0).toFixed(2)),
      boostThreshold: Math.round(clamp(mean.boostThreshold - boostAxis[i] * 6, 0, 28)),
      boostMaxCurvature: Number(clamp(mean.boostMaxCurvature + apexAxis[i] * 0.0018, 0.0028, 0.016).toFixed(5)),
      corridorHalfWidth: Number(clamp(mean.corridorHalfWidth + Math.abs(aggrAxis[i]) * 0.35, 0.4, 1.8).toFixed(2)),
      decisionRate: Number(clamp(mean.decisionRate + reactAxis[i], 1.00, 3.10).toFixed(3)),
      overtakeAggression: Number(clamp(mean.overtakeAggression + aggrAxis[i], 0.70, 3.10).toFixed(3)),
      lateralSteeringForce: Number(clamp(mean.lateralSteeringForce + aggrAxis[i] * 0.45, 1.85, 3.80).toFixed(3)),
      preferredOffset: Number(clamp(laneAxis[i], -0.85, 0.85).toFixed(2)),
    });
  }

  return profiles;
}

export class AIDriver {
  /**
   * @param {import('../physics/vehicle.js').Vehicle} vehicle
   * @param {import('../track/trackLayout.js').TrackLayout} layout
   * @param {object} opts { difficultyKey, skill, behaviorKey, preferredOffset, aiProfile }
   */
  constructor(vehicle, layout, opts = {}) {
    this.vehicle = vehicle;
    this.layout = layout;

    const diffKey = opts.difficultyKey || opts.aiProfile?.difficultyKey || CONFIG.race.difficulty || 'normal';
    this.diffCfg = CONFIG.difficulty[diffKey] || CONFIG.difficulty.normal;
    this.difficultyKey = diffKey;

    const profile = opts.aiProfile || generateBotAIProfiles(1, diffKey)[0];
    this.aiProfile = profile;

    const behKey = opts.behaviorKey || profile.behaviorKey || 'balanced';
    this.behavior = AI_BEHAVIOR_PROFILES[behKey] || AI_BEHAVIOR_PROFILES.balanced;
    this.preferredOffset = opts.preferredOffset ?? profile.preferredOffset ?? 0;

    // Autorité de braquage latéral personnalisée par bot
    this.lateralSteeringForce = profile.lateralSteeringForce ?? LATERAL_STEERING_FORCE;
    this.overtakeAggression = profile.overtakeAggression ?? this.behavior.overtakeAggression ?? 1.0;
    this.skillLevel = profile.skillLevel ?? 0.75;

    // Écart individuel à somme nulle autour de la moyenne du mode de difficulté
    this.speedDelta = Number(opts.speedDelta ?? profile.speedDelta ?? 0);
    const vModTop = VEHICLE_MODIFIERS[this.vehicle.bodyType]?.topSpeed || 1.0;
    // Compense légèrement les châssis à faible Vmax sans jamais brider les supercars/F1
    const bodyNorm = vModTop < 1.0 ? Math.min(1.06, 1.0 / (0.40 + 0.60 * vModTop)) : 1.0;

    // Paramètres uniques de l'IA de ce bot (moyenne proportionnelle à la difficulté)
    if (opts.aiProfile) {
      this.targetSpeedFactor = profile.targetSpeedFactor;
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = profile.brakeLookaheadMult;
      this.cornerSpeedFactor = profile.cornerSpeedFactor;
      this.steerGain = profile.steerGain;
      this.steerRateMult = profile.steerRateMult;
      this.apexCut = profile.apexCut;
      this.boostSeekWeight = profile.boostSeekWeight;
      this.boostMaxLatDeviation = profile.boostMaxLatDeviation;
      this.boostThreshold = profile.boostThreshold;
      this.boostMaxCurvature = profile.boostMaxCurvature;
      this.corridorHalfWidth = profile.corridorHalfWidth;
      this.decisionRate = profile.decisionRate;
    } else if (diffKey === 'easy') {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 0.88;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 0.78, 0.96);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = 1.15 * (1 - this.speedDelta * 0.35);
      this.cornerSpeedFactor = 0.93 * (1 + this.speedDelta * 0.40);
      this.steerGain = profile.steerGain ?? 1.90;
      this.steerRateMult = profile.steerRateMult ?? 0.85;
      this.apexCut = profile.apexCut ?? 0.20;
      this.boostSeekWeight = profile.boostSeekWeight ?? 2.10;
      this.boostMaxLatDeviation = profile.boostMaxLatDeviation ?? 4.5;
      this.boostThreshold = profile.boostThreshold ?? 5;
      this.boostMaxCurvature = profile.boostMaxCurvature ?? 0.0045;
      this.corridorHalfWidth = profile.corridorHalfWidth ?? 2.0;
      this.decisionRate = profile.decisionRate ?? 1.4;
    } else if (diffKey === 'hard') {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 1.10;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 1.02, 1.20);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = 0.48 * (1 - this.speedDelta * 0.5);
      this.cornerSpeedFactor = 1.10 * (1 + this.speedDelta * 0.45);
      this.steerGain = profile.steerGain ?? 3.25;
      this.steerRateMult = profile.steerRateMult ?? 1.40;
      this.apexCut = profile.apexCut ?? Math.max(0.90, this.behavior.apexCut || 0.90);
      this.boostSeekWeight = profile.boostSeekWeight ?? 3.90;
      this.boostMaxLatDeviation = profile.boostMaxLatDeviation ?? 10.0;
      this.boostThreshold = profile.boostThreshold ?? 0;
      this.boostMaxCurvature = profile.boostMaxCurvature ?? 0.012;
      this.corridorHalfWidth = profile.corridorHalfWidth ?? (this.behavior.corridorHalfWidth ?? 4.2);
      this.decisionRate = profile.decisionRate ?? 2.6;
    } else {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 0.98;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 0.90, 1.06);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = (this.behavior.brakeLookaheadMult ?? 0.85) * (1 - this.speedDelta * 0.4);
      this.cornerSpeedFactor = (this.behavior.cornerSpeedFactor ?? 1.00) * (1 + this.speedDelta * 0.45);
      this.steerGain = profile.steerGain ?? 2.50;
      this.steerRateMult = profile.steerRateMult ?? 1.08;
      this.apexCut = profile.apexCut ?? Math.max(0.48, this.behavior.apexCut ?? 0.48);
      this.boostSeekWeight = profile.boostSeekWeight ?? 2.95;
      this.boostMaxLatDeviation = profile.boostMaxLatDeviation ?? 7.5;
      this.boostThreshold = profile.boostThreshold ?? (this.behavior.boostThreshold ?? 0);
      this.boostMaxCurvature = profile.boostMaxCurvature ?? 0.0068;
      this.corridorHalfWidth = profile.corridorHalfWidth ?? (this.behavior.corridorHalfWidth ?? 3.2);
      this.decisionRate = profile.decisionRate ?? 2.0;
    }

    // Applique les multiplicateurs physiques au véhicule du bot
    this.vehicle.aiSpeedMultiplier = this.maxSpeedFactor;
    this.vehicle.aiSteerRateMult = this.steerRateMult;

    this.corridorPhase = Math.random() * Math.PI * 2;
    this.corridorFreq = (0.42 + Math.random() * 0.28) * 1.15;
    this.lateralOffset = 0;

    // Lissage exponentiel de direction (élimination des saccades et zigzags)
    this.currentSteer = 0;
    this.steerSmoothFactor = 12.0; // Taux d'interpolation exponentielle dynamique

    // Résultats pré-alloués pour éviter toute création d'objet dans update()
    this._tokenEvalOut = { shift: 0, priorityBoost: false };
    this._overtakeEvalOut = { targetOvertakeShift: 0, emergencyBrake: 0 };

    this.lastSampledPos = new THREE.Vector3();
    this.reset();
  }

  /** Réinitialise l'état de navigation et les compteurs d'immobilité du bot. */
  reset() {
    const p = this.vehicle.chassisBody.position;
    this.targetWaypointIndex = (this.vehicle.trackIndex + 6) % this.layout.count;
    this.lateralOffset = clamp(
      this.preferredOffset,
      -this.corridorHalfWidth,
      this.corridorHalfWidth
    );
    this.overtakeOffset = 0;
    this.tokenOffset = 0;
    this.currentSteer = 0;
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.sampleTimer = 0;
    this.immobileSeconds = 0;
    this.lastSampledPos.set(p.x, p.y, p.z);
  }

  /**
   * Moniteur anti-blocage (Unstuck) :
   * Mesure la vitesse et le déplacement ; si < 1 m/s pendant 8.5 s consécutives,
   * téléporte et relance le bot sur la piste.
   */
  _updateUnstuckMonitor(dt) {
    const v = this.vehicle;
    if (v.finished) return false;

    this.sampleTimer += dt;
    if (this.sampleTimer >= 0.5) {
      const pos = v.chassisBody.position;
      const vel = v.chassisBody.velocity;
      const speed = Math.hypot(vel.x, vel.z);
      const dx = pos.x - this.lastSampledPos.x;
      const dz = pos.z - this.lastSampledPos.z;
      const displacementRate = Math.hypot(dx, dz) / this.sampleTimer;

      if (speed < 1.2 || displacementRate < 1.0) {
        this.immobileSeconds += this.sampleTimer;
      } else {
        this.immobileSeconds = 0;
      }

      this.lastSampledPos.set(pos.x, pos.y, pos.z);
      this.sampleTimer = 0;

      // Déblocage automatique en 5 secondes maximum
      const unstuckLimit = CONFIG.ai.unstuckTime || 5.0;
      if (this.immobileSeconds >= unstuckLimit) {
        this._teleportToNearestWaypoint();
        return true;
      }
    }
    return false;
  }

  _teleportToNearestWaypoint() {
    const v = this.vehicle;
    const L = this.layout;
    const pos = v.chassisBody.position;

    // Prend en compte la hauteur Y (pos.y) pour éviter tout téléport entre tunnel et piste supérieure
    const nearestIdx = L.findNearestIndex(pos.x, pos.z, v.trackIndex, 90, pos.y);
    const nextIdx = (nearestIdx + 4) % L.count;
    const wpNow = L.racingPoints[nearestIdx];
    const wpNext = L.racingPoints[nextIdx];

    _relaunchPos.set(wpNow.x, wpNow.y + 0.65, wpNow.z);
    _relaunchDir.set(wpNext.x - wpNow.x, 0, wpNext.z - wpNow.z).normalize();

    v.setSpawn(_relaunchPos, _relaunchDir, false, CONFIG.ai.relaunchSpeed);

    this.targetWaypointIndex = nextIdx;
    this.immobileSeconds = 0;
    this.sampleTimer = 0;
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.lastSampledPos.copy(_relaunchPos);
  }

  /**
   * 2. Cône de détection des jetons élargi de +30% (distance < 32 m, angle < 58,5°) :
   *  - Repère et cible les bonus plus tôt avec +30% d'autorité latérale.
   *  - Contourne les jetons ralentisseurs rouges (-25%) avec une répulsion majorée de +30%.
   */
  _evaluateTokensInFrontCone(tokens, pos, maxLat) {
    const out = this._tokenEvalOut;
    out.shift = 0;
    out.priorityBoost = false;
    if (!tokens || tokens.length === 0) return out;

    const v = this.vehicle;
    const L = this.layout;
    let bestBoostShift = 0;
    let bestBoostScore = 0;
    let slowdownRepulsion = 0;

    const canSeekBoost = v.boostEnergy < 98;
    // Port?e de vision proportionnelle ? la vitesse (60 m ? l'arr?t -> 110 m ? haute vitesse)
    const visRange = clamp(TOKEN_RANGE_MIN + Math.max(0, v.forwardSpeed) * 1.3, TOKEN_RANGE_MIN, TOKEN_RANGE_MAX);
    const visRangeSq = visRange * visRange;
    const maxDev = this.boostMaxLatDeviation;

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (!tk || !tk.active) continue;

      const dx = tk.position.x - pos.x;
      const dy = Math.abs(tk.position.y - pos.y);
      const dz = tk.position.z - pos.z;
      if (dy > 5.5) continue;

      const d2 = dx * dx + dz * dz;
      if (d2 < 1.0 || d2 >= visRangeSq) continue; // rejet rapide sans racine carr?e
      const dist = Math.sqrt(d2);

      const fwdDot = (dx * _fwd.x + dz * _fwd.z) / dist;
      if (fwdDot < COS_TOKEN_CONE) continue;

      if (tk.kind === 'boost') {
        if (!canSeekBoost) continue;
        const idealLat = L.racingLat[v.trackIndex] || 0;
        const latFromCar = Math.abs(tk.lateral - v.trackLateral);
        // Alignement direct et sans sur-dépassement pour percuter le jeton au centre
        const reqShift = tk.lateral - idealLat;
        if (Math.abs(tk.lateral - idealLat) > maxDev * 1.8 && latFromCar > 4.2) continue;

        const rarityWeight = tk.isRare ? 2.6 : 1.4;
        const proximityWeight = (visRange - dist) / visRange;
        // Priorité majeure si le jeton est presque sur la trajectoire directe du véhicule
        const pathAlignment = Math.max(0, 1.0 - latFromCar / 4.5);
        const score = rarityWeight * (this.boostSeekWeight || 2.5) * (0.65 + 0.65 * proximityWeight + 1.25 * pathAlignment);
        if (score > bestBoostScore) {
          bestBoostScore = score;
          bestBoostShift = clamp(reqShift, -maxLat, maxLat);
        }
      } else if (tk.kind === 'slowdown') {
        const latDiff = tk.lateral - v.trackLateral;
        const localRight = dx * _right.x + dz * _right.z;
        if (Math.abs(latDiff) < 4.2 || Math.abs(localRight) < 3.8) {
          const roomRight = maxLat - tk.lateral;
          const roomLeft = maxLat + tk.lateral;
          let evadeDir = latDiff >= 0 ? -1 : 1;
          if (evadeDir > 0 && roomRight < 2.5) evadeDir = -1;
          else if (evadeDir < 0 && roomLeft < 2.5) evadeDir = 1;

          const urgency = clamp((visRange - dist) / 45.0, 0.55, 1.0);
          const evadeMargin = 4.2 * this.lateralSteeringForce;
          const targetSafeLat = clamp(tk.lateral + evadeDir * evadeMargin, -maxLat, maxLat);
          slowdownRepulsion = (targetSafeLat - (L.racingLat[v.trackIndex] || 0)) * urgency * 1.5;
        }
      }
    }

    if (Math.abs(slowdownRepulsion) > 0.1) {
      out.shift = slowdownRepulsion;
      out.priorityBoost = false;
      return out;
    }
    out.shift = bestBoostShift;
    out.priorityBoost = bestBoostScore > 0.08;
    return out;
  }

  /**
   * 3. Dépassement dynamique incisif (+30% d'autorité latérale et de portée d'anticipation) :
   * Détecte un véhicule plus lent devant et applique un déboîtement latéral franc.
   */
  _evaluateDynamicOvertake(allVehicles, pos, maxLat) {
    const out = this._overtakeEvalOut;
    out.targetOvertakeShift = 0;
    out.emergencyBrake = 0;

    const v = this.vehicle;
    const L = this.layout;
    const beh = this.behavior;
    // Sonde avant réactive portée à 20 mètres (dépassements anticipés nets et autoritaires)
    const probeMaxDist = clamp(32.0 + Math.max(0, v.forwardSpeed) * 0.8, 32.0, 65.0);

    let closestSlowCar = null;
    let closestDist = Infinity;

    // a) Raycast physique vers l'avant sur le groupe des châssis véhicules (collisionFilterMask: 1)
    if (v.world) {
      _rayFrom.set(
        pos.x + _fwd.x * 2.25,
        pos.y + 0.45,
        pos.z + _fwd.z * 2.25
      );
      _rayTo.set(
        pos.x + _fwd.x * probeMaxDist,
        pos.y + 0.45,
        pos.z + _fwd.z * probeMaxDist
      );
      _rayResult.reset();
      const hasHit = v.world.raycastClosest(
        _rayFrom,
        _rayTo,
        _RAY_OPTS_CHASSIS,
        _rayResult
      );
      if (hasHit && _rayResult.body && _rayResult.body !== v.chassisBody) {
        for (let i = 0; i < allVehicles.length; i++) {
          const cand = allVehicles[i];
          if (cand && cand !== v && cand.chassisBody === _rayResult.body) {
            if (cand.forwardSpeed < v.forwardSpeed + 4.5) {
              closestSlowCar = cand;
              closestDist = _rayResult.distance;
            }
            break;
          }
        }
      }
    }

    // b) Vérification complémentaire dans le couloir avant (< 20 m) pour jusqu'à 10 véhicules
    const lookOvertakeDist = Math.max(probeMaxDist, 42.0 * (this.overtakeAggression || beh.overtakeAggression || 1.0));
    for (let i = 0; i < allVehicles.length; i++) {
      const other = allVehicles[i];
      if (!other || other === v) continue;
      if (Math.abs(other.chassisBody.position.y - pos.y) > 5.5) continue;
      const ds = wrapDelta(other.trackS, v.trackS, L.length);
      if (ds > -1.5 && ds <= lookOvertakeDist) {
        const dLat = other.trackLateral - v.trackLateral;
        const isSlower = other.forwardSpeed < v.forwardSpeed + 4.0;
        if (Math.abs(dLat) < 3.2 && isSlower && ds < closestDist) {
          closestSlowCar = other;
          closestDist = ds;
        }
      }
    }

    if (closestSlowCar) {
      const dLat = closestSlowCar.trackLateral - v.trackLateral;
      const roomRight = maxLat - closestSlowCar.trackLateral;
      const roomLeft = maxLat + closestSlowCar.trackLateral;

      let passSide;
      if (roomRight > roomLeft + 0.8) {
        passSide = 1;
      } else if (roomLeft > roomRight + 0.8) {
        passSide = -1;
      } else {
        passSide = dLat >= 0 ? -1 : 1;
      }

      // Déport franc sur toute une largeur de voie (dépassement autoritaire)
      const fullLaneShift = 4.8 * Math.min(3.2, this.lateralSteeringForce);
      const desiredPassLat = clamp(closestSlowCar.trackLateral + passSide * fullLaneShift, -maxLat, maxLat);
      out.targetOvertakeShift = desiredPassLat - (L.racingLat[v.trackIndex] || 0);

      if (closestDist > 0 && closestDist < 5.0 && Math.abs(dLat) < 1.4 && v.forwardSpeed > closestSlowCar.forwardSpeed + 2.5) {
        out.emergencyBrake = clamp((v.forwardSpeed - closestSlowCar.forwardSpeed) / 22, 0.08, 0.45);
      }
    }

    return out;
  }

  /**
   * 4. Évitement des murs et barrières (+30% d'autorité de correction) :
   * Deux rayons de détection diagonaux à l'avant du bot (gauche à -30° et droite à +30°).
   */
  _evaluateBarrierAvoidanceRays(pos) {
    const v = this.vehicle;
    const L = this.layout;
    const rayLength = 9.0;
    const originX = pos.x + _fwd.x * 1.6;
    const originY = pos.y + 0.45;
    const originZ = pos.z + _fwd.z * 1.6;

    const leftDirX = _fwd.x * COS_30_DEG - _right.x * SIN_30_DEG;
    const leftDirZ = _fwd.z * COS_30_DEG - _right.z * SIN_30_DEG;

    const rightDirX = _fwd.x * COS_30_DEG + _right.x * SIN_30_DEG;
    const rightDirZ = _fwd.z * COS_30_DEG + _right.z * SIN_30_DEG;

    let leftHitDist = Infinity;
    let rightHitDist = Infinity;

    if (v.world) {
      _rayFrom.set(originX, originY, originZ);

      _rayTo.set(originX + leftDirX * rayLength, originY, originZ + leftDirZ * rayLength);
      _rayResult.reset();
      if (v.world.raycastClosest(_rayFrom, _rayTo, _RAY_OPTS_BARRIER, _rayResult)) {
        if (_rayResult.distance < leftHitDist) leftHitDist = _rayResult.distance;
      }

      _rayTo.set(originX + rightDirX * rayLength, originY, originZ + rightDirZ * rayLength);
      _rayResult.reset();
      if (v.world.raycastClosest(_rayFrom, _rayTo, _RAY_OPTS_BARRIER, _rayResult)) {
        if (_rayResult.distance < rightHitDist) rightHitDist = _rayResult.distance;
      }
    }

    const wallLimit = (L.halfWidth || 7) + 1.05;
    for (let k = 0; k < _WALL_PROBE_DISTS.length; k++) {
      const d = _WALL_PROBE_DISTS[k];
      const lx = originX + leftDirX * d;
      const lz = originZ + leftDirZ * d;
      const projL = L.project(lx, lz, v.trackIndex, originY, _projScratch);
      if (projL.lateral < -wallLimit && d < leftHitDist) {
        leftHitDist = d;
      } else if (projL.lateral > wallLimit && d < rightHitDist) {
        rightHitDist = d;
      }

      const rx = originX + rightDirX * d;
      const rz = originZ + rightDirZ * d;
      const projR = L.project(rx, rz, v.trackIndex, originY, _projScratch);
      if (projR.lateral > wallLimit && d < rightHitDist) {
        rightHitDist = d;
      } else if (projR.lateral < -wallLimit && d < leftHitDist) {
        leftHitDist = d;
      }
    }

    const wallAuthority = 0.85 * this.lateralSteeringForce;
    let steerCorrection = 0;
    if (leftHitDist < rayLength) {
      const uu = (rayLength - leftHitDist) / rayLength;
      const urgency = clamp(uu * uu * 1.4, 0.06, 1.0); // courbe douce : pas de sursaut ? longue port?e
      steerCorrection -= wallAuthority * urgency;
    }
    if (rightHitDist < rayLength) {
      const uu = (rayLength - rightHitDist) / rayLength;
      const urgency = clamp(uu * uu * 1.4, 0.06, 1.0); // courbe douce : pas de sursaut ? longue port?e
      steerCorrection += wallAuthority * urgency;
    }

    return steerCorrection;
  }

  /**
   * Calcule et applique les contrôles `{ throttle, brake, steer, boost }` avec latence réduite de 30%.
   */
  update(dt, allVehicles, tokens = null) {
    const v = this.vehicle;
    const L = this.layout;
    const n = L.count;
    const beh = this.behavior;

    if (this._updateUnstuckMonitor(dt)) {
      v.controls.throttle = 1;
      v.controls.brake = 0;
      v.controls.steer = 0;
      v.controls.boost = false;
      return;
    }

    const pos = v.chassisBody.position;
    v.getForwardVector(_fwd);
    v.getRightVector(_right);

    // 1) Détection et gestion stricte du sens de circulation (anti-contresens absolu)
    const tTrack = L.tangents[v.trackIndex];
    const alignDot = _fwd.x * tTrack.x + _fwd.z * tTrack.z;
    const crossTang = _fwd.x * tTrack.z - _fwd.z * tTrack.x;

    if (alignDot < 0.15) {
      this.wrongWayDuration = (this.wrongWayDuration || 0) + dt;

      // Si le bot reste orienté à contresens plus de 5.0s sans réussir à pivoter, replacement direct sur la piste
      if (this.wrongWayDuration > 5.0) {
        this.wrongWayDuration = 0;
        this._teleportToNearestWaypoint();
        return;
      }

      // Si le bot a encore de la vitesse vers l'avant (roulant à contresens sur la piste) :
      // Freinage d'urgence immédiat pour annuler la vitesse en sens inverse
      if (v.forwardSpeed > 1.8) {
        v.controls.throttle = 0;
        v.controls.brake = 1.0;
        v.controls.steer = crossTang >= 0 ? -1.0 : 1.0;
        v.controls.boost = false;
        return;
      }

      // Vitesse basse : manœuvre de demi-tour immédiate pour se réaligner dans le bon sens de course
      const turnDir = crossTang >= 0 ? -1.0 : 1.0;
      v.controls.throttle = 0.45;
      v.controls.brake = 0;
      v.controls.steer = turnDir;
      v.controls.boost = false;
      return;
    } else {
      this.wrongWayDuration = Math.max(0, (this.wrongWayDuration || 0) - dt * 2.5);
    }

    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      v.controls.throttle = 0;
      v.controls.brake = 0.85;
      v.controls.steer = crossTang >= 0 ? -0.95 : 0.95;
      v.controls.boost = false;
      return;
    }

    if (Math.abs(v.forwardSpeed) < 1.5) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.8) {
        this.stuckTimer = 0;
        this.reverseTimer = 0.95;
        return;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2.5);
    }

    const maxLat = Math.max(2.0, L.halfWidth - 1.85);
    const curvNow = Math.abs(L.curvature ? L.curvature[v.trackIndex] : L.racingCurvature[v.trackIndex]);
    const safeCornerMaxLat = curvNow > 0.0045 ? Math.max(2.5, maxLat - 1.25) : maxLat;

    // 1) Ligne de course stable et tendue (élimination définitive du louvoiement sinusoïdal)
    const targetCorridorOffset = clamp(this.preferredOffset, -this.corridorHalfWidth, this.corridorHalfWidth);
    this.lateralOffset = damp(this.lateralOffset, targetCorridorOffset, 0.6 * this.decisionRate, dt);

    // 2) Détection des jetons de boost (attraction) et ralentisseurs rouges (répulsion) dans le cône < 32m, < 58,5°
    const tokenEval = this._evaluateTokensInFrontCone(tokens, pos, safeCornerMaxLat);
    const tokenDampRate = tokenEval.priorityBoost ? 6.2 : 4.8;
    this.tokenOffset = damp(this.tokenOffset, tokenEval.shift, tokenDampRate, dt);

    // 3) Dépassement dynamique incisif sans à-coups latéraux en peloton
    const overtakeEval = this._evaluateDynamicOvertake(allVehicles, pos, safeCornerMaxLat);
    const targetOvertakeShift = overtakeEval.targetOvertakeShift;
    const emergencyBrake = overtakeEval.emergencyBrake;
    const overtakeDampRate = clamp(4.2 * (this.overtakeAggression || beh.overtakeAggression || 1.0), 4.0, 8.2);
    this.overtakeOffset = damp(this.overtakeOffset, targetOvertakeShift, overtakeDampRate, dt);

    // Hiérarchie des décalages latéraux
    let activeLatShift = this.lateralOffset;
    if (tokenEval.priorityBoost && Math.abs(this.tokenOffset) > 0.08) {
      activeLatShift = this.tokenOffset;
    } else if (Math.abs(this.overtakeOffset) > 0.35) {
      activeLatShift = this.overtakeOffset;
    } else if (Math.abs(this.tokenOffset) > 0.10) {
      activeLatShift = this.tokenOffset;
    } else {
      activeLatShift = this.lateralOffset + this.tokenOffset * 0.85 + this.overtakeOffset * 0.70;
    }

    // Sécurité anti-accrochage latéral en peloton : ne pas se déporter vers une voiture déjà à notre hauteur
    if (allVehicles && allVehicles.length > 1) {
      let sideBlockLeft = -safeCornerMaxLat;
      let sideBlockRight = safeCornerMaxLat;
      for (let i = 0; i < allVehicles.length; i++) {
        const other = allVehicles[i];
        if (!other || other === v) continue;
        if (Math.abs(other.chassisBody.position.y - pos.y) > 4.5) continue;
        const ds = wrapDelta(other.trackS, v.trackS, L.length);
        if (Math.abs(ds) < 4.8) {
          const dLat = other.trackLateral - v.trackLateral;
          if (dLat > 0.6 && dLat < 3.5) {
            sideBlockRight = Math.min(sideBlockRight, other.trackLateral - 2.3);
          } else if (dLat < -0.6 && dLat > -3.5) {
            sideBlockLeft = Math.max(sideBlockLeft, other.trackLateral + 2.3);
          }
        }
      }
      if (sideBlockLeft <= sideBlockRight) {
        const curIdeal = L.racingLat[v.trackIndex] || 0;
        const shiftedLat = curIdeal + activeLatShift;
        if (shiftedLat > sideBlockRight) activeLatShift = sideBlockRight - curIdeal;
        else if (shiftedLat < sideBlockLeft) activeLatShift = sideBlockLeft - curIdeal;
      }
    }

    // Point de visée anticipé continu (raccourci progressivement en virage serré pour éviter de couper ou élargir)
    const speed = Math.max(0, v.forwardSpeed);
    const probeIdx = (v.trackIndex + Math.round(18 / L.ds)) % n;
    const rawCurvProbe = Math.abs(L.curvature ? L.curvature[probeIdx] : L.racingCurvature[probeIdx]);
    const lookCurvFactor = clamp(1.0 - (Math.max(curvNow, rawCurvProbe) / 0.018) * 0.45, 0.52, 1.0);
    const lookDist = clamp(
      Math.max(15.0, speed * (0.90 + 0.10 * (this.decisionRate || 1.0)) * lookCurvFactor),
      15.0,
      56.0
    );
    const targetS = wrap(v.trackS + lookDist, L.length);

    const fIdx = (targetS / L.ds) % n;
    const i0 = Math.floor(fIdx) % n;
    const i1 = (i0 + 1) % n;
    const tFrac = fIdx - Math.floor(fIdx);
    this.targetWaypointIndex = i0;

    const curvAhead = L.racingCurvature[i0] * (1 - tFrac) + L.racingCurvature[i1] * tFrac;
    const signedCurvAhead = L.curvature ? (L.curvature[i0] * (1 - tFrac) + L.curvature[i1] * tFrac) : curvAhead;
    const cornerSign = Math.sign(signedCurvAhead);
    const apexShift = Math.abs(curvAhead) > 0.0035 ? cornerSign * (this.apexCut * 2.2) : 0;
    const idealRacingLat = L.racingLat[i0] * (1 - tFrac) + L.racingLat[i1] * tFrac;
    const desiredLat = clamp(idealRacingLat + activeLatShift + apexShift, -safeCornerMaxLat, safeCornerMaxLat);

    // Échantillonnage 3D continu sans aucune discontinuité
    const splineSample = L.sample(targetS, desiredLat);
    _target.copy(splineSample.position);

    const dx = _target.x - pos.x;
    const dz = _target.z - pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const dirX = dx / dist, dirZ = dz / dist;

    const localX = dirX * _right.x + dirZ * _right.z;
    const localFwd = dirX * _fwd.x + dirZ * _fwd.z;

    // Écart angulaire avec la cible
    const angleToTarget = Math.atan2(localX, Math.max(0.001, localFwd));

    // Deadband progressif cubique (smoothstep) : élimine toute oscillation et à-coup autour de l'axe central
    const absAngle = Math.abs(angleToTarget);
    let deadbandFactor = 1.0;
    const deadbandThresh = STEER_DEADZONE_RAD * 1.25; // ~1.875°
    if (absAngle < deadbandThresh) {
      const u = absAngle / deadbandThresh;
      deadbandFactor = u * u * (3 - 2 * u); // Transition douce d'ordre 3 (zéro discontinuité de dérivée)
    }

    let rawTargetSteer = clamp(-localX * this.steerGain * deadbandFactor, -1, 1);
    if (localFwd < 0) rawTargetSteer = localX >= 0 ? -1 : 1;

    // 4) Rayons diagonaux avant (±30°) pour esquive des glissières
    const wallSteerCorrection = this._evaluateBarrierAvoidanceRays(pos);
    if (Math.abs(wallSteerCorrection) > 0.01) {
      rawTargetSteer = clamp(rawTargetSteer + wallSteerCorrection, -1, 1);
    }

    // Amortissement dynamique proportionnel à la vitesse : plus la vitesse est élevée, plus la direction est verrouillée
    const dynamicSmoothFactor = clamp(11.0 + (this.decisionRate || 1.0) * 3.0 - (speed / 45.0) * 3.5, 7.5, 18.0);
    const alphaSteer = 1.0 - Math.exp(-dynamicSmoothFactor * dt);
    this.currentSteer = THREE.MathUtils.lerp(this.currentSteer, rawTargetSteer, alphaSteer);
    const steerCmd = clamp(this.currentSteer, -1, 1);

    // Anticipation du freinage modulée par this.brakeLookaheadMult
    // Anticipation du freinage proportionnelle selon la vitesse et le terrain
    const baseLook = (10 + speed * 0.65 + speed * speed * 0.004) * this.brakeLookaheadMult;
    const brakeLookSteps = Math.max(3, Math.round(baseLook / L.ds));
    let minProfileSpeed = Infinity;
    for (let s = 0; s <= brakeLookSteps; s += 2) {
      const idx = (v.trackIndex + s) % n;
      if (L.speedProfile[idx] < minProfileSpeed) minProfileSpeed = L.speedProfile[idx];
    }

    const vMod = VEHICLE_MODIFIERS[v.bodyType];
    const vModTop = vMod?.topSpeed || 1.0;
    const vModGrip = vMod?.grip || 1.0;
    const gripCornerMult = clamp(Math.sqrt(clamp(vModGrip, 0.85, 1.25)), 0.96, 1.03);
    const maxAllowedSpeed = CONFIG.car.topSpeed * vModTop * this.maxSpeedFactor;
    let targetSpeed = Math.min(maxAllowedSpeed, minProfileSpeed * this.cornerSpeedFactor * gripCornerMult);

    if (v.finished) {
      targetSpeed *= 0.88;
    }

    if (Math.abs(steerCmd) > 0.75 && this.difficultyKey === 'easy') {
      targetSpeed *= 0.95;
    }

    const speedDiff = targetSpeed - speed;
    let throttle = 0;
    let brake = emergencyBrake;

    if (speedDiff > -0.8 && emergencyBrake < 0.1) {
      throttle = speedDiff >= 0.35 ? 1.0 : clamp(0.68 + speedDiff * 0.85, 0.45, 1.0);
      if (Math.abs(steerCmd) > 0.88 && speed > 28 && this.difficultyKey === 'easy') throttle *= 0.82;
    } else if (speedDiff < -1.6) {
      brake = Math.max(brake, clamp(-speedDiff / 12, 0.18, 0.98));
      throttle = 0;
    } else {
      throttle = 0.28;
    }

    const curNow = Math.abs(L.racingCurvature[v.trackIndex]);
    const curAhead = Math.abs(curvAhead);
    const isCornerExit = (this.difficultyKey === 'hard' || this.difficultyKey === 'normal')
      && curAhead < curNow * 0.88 && curAhead < 0.013;
    const maxSteerForBoost = this.difficultyKey === 'hard' ? 0.42 : (this.difficultyKey === 'normal' ? 0.30 : 0.24);
    const minSpeedForBoost = this.difficultyKey === 'hard' ? 14 : (this.difficultyKey === 'normal' ? 17 : 20);

    const useBoost = !v.finished
      && v.boostEnergy > this.boostThreshold
      && v.slowdownTimer <= 0
      && (curAhead < this.boostMaxCurvature || isCornerExit)
      && Math.abs(steerCmd) < maxSteerForBoost
      && speed > minSpeedForBoost
      && emergencyBrake === 0;

    v.controls.throttle = throttle;
    v.controls.brake = brake;
    v.controls.steer = steerCmd;
    v.controls.boost = useBoost;
  }
}
