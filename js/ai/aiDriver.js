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
import { CONFIG, AI_BEHAVIOR_PROFILES, VEHICLE_MODIFIERS } from '../config.js?v=25';
import { clamp, damp, wrap, wrapDelta } from '../core/utils.js?v=25';

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
const TOKEN_CONE_DIST = 42.0; // port?e minimale (?tendue dynamiquement selon la vitesse)
const TOKEN_RANGE_MIN = 60.0;
const TOKEN_RANGE_MAX = 110.0;
const COS_TOKEN_CONE = Math.cos(65 * (Math.PI / 180)); // ~0.4226 (cône élargi à 65°) // ~0.5225
const COS_30_DEG = Math.cos(Math.PI / 6);                        // ~0.8660 (rayons diagonaux ±30°)
const SIN_30_DEG = Math.sin(Math.PI / 6);                        // 0.5000

// Facteur d'accélération de la prise de décision (-30% de latence temporelle -> 1 / 0.70 ≈ 1.43x)
const REACTION_SPEED_MULT = 1 / 0.70;
// Autorité et amplitude de déplacement latéral multipliées par ~2.5x (manœuvres incisives et opportunistes)
const LATERAL_STEERING_FORCE = 2.50;

// Zone morte de braquage (1.5° = 0.02618 rad) pour interdire les micro-oscillations en ligne droite
const STEER_DEADZONE_RAD = 1.5 * (Math.PI / 180); // ~0.02618

export class AIDriver {
  /**
   * @param {import('../physics/vehicle.js').Vehicle} vehicle
   * @param {import('../track/trackLayout.js').TrackLayout} layout
   * @param {object} opts { difficultyKey, skill, behaviorKey, preferredOffset }
   */
  constructor(vehicle, layout, opts = {}) {
    this.vehicle = vehicle;
    this.layout = layout;

    const diffKey = opts.difficultyKey || CONFIG.race.difficulty || 'normal';
    this.diffCfg = CONFIG.difficulty[diffKey] || CONFIG.difficulty.normal;
    this.difficultyKey = diffKey;
    this.behavior = AI_BEHAVIOR_PROFILES[opts.behaviorKey] || AI_BEHAVIOR_PROFILES.balanced;
    this.preferredOffset = opts.preferredOffset ?? 0;

    // Autorité de braquage latéral augmentée de +30% sur l'ensemble des niveaux (Facile, Moyen, Difficile)
    this.lateralSteeringForce = LATERAL_STEERING_FORCE;

    // Écart individuel à somme nulle autour de la moyenne du mode de difficulté
    this.speedDelta = Number(opts.speedDelta ?? 0);
    const vModTop = VEHICLE_MODIFIERS[this.vehicle.bodyType]?.topSpeed || 1.0;
    const bodyNorm = 1.0 / (0.25 + 0.75 * vModTop);

    // Intelligence et précision décisionnelle multipliées par 2 (selon la difficulté)
    if (diffKey === 'easy') {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 0.75;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 0.66, 0.84);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = 1.45 * (1 - this.speedDelta * 0.35);
      this.cornerSpeedFactor = 0.85 * (1 + this.speedDelta * 0.40);
      this.steerGain = 1.65;
      this.steerRateMult = 0.85;
      this.apexCut = 0.20;
      this.boostSeekWeight = 1.35;
      this.boostMaxLatDeviation = 4.5;
      this.boostThreshold = 18;
      this.boostMaxCurvature = 0.0035;
      this.corridorHalfWidth = 0.6; // Maintien d'une ligne stable et prévisible
      this.decisionRate = 1.2;
    } else if (diffKey === 'hard') {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 1.05;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 0.98, 1.12);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = 0.72 * (1 - this.speedDelta * 0.5);
      this.cornerSpeedFactor = 1.08 * (1 + this.speedDelta * 0.45);
      this.steerGain = 2.85;
      this.steerRateMult = 1.55;
      this.apexCut = Math.max(0.92, this.behavior.apexCut || 0.92);
      this.boostSeekWeight = 2.40;
      this.boostMaxLatDeviation = 7.5;
      this.boostThreshold = 2;
      this.boostMaxCurvature = 0.0095;
      this.corridorHalfWidth = this.behavior.corridorHalfWidth ?? 2.8;
      this.decisionRate = 2.5; // Analyse haute fréquence et réflexes chirurgicaux
    } else {
      const baseSpeed = this.diffCfg.maxSpeedFactor || 0.91;
      this.targetSpeedFactor = clamp(baseSpeed + this.speedDelta, 0.84, 0.98);
      this.maxSpeedFactor = this.targetSpeedFactor * bodyNorm;
      this.brakeLookaheadMult = (this.behavior.brakeLookaheadMult ?? 1.10) * (1 - this.speedDelta * 0.4);
      this.cornerSpeedFactor = (this.behavior.cornerSpeedFactor ?? 0.96) * (1 + this.speedDelta * 0.45);
      this.steerGain = 2.25;
      this.steerRateMult = 1.20;
      this.apexCut = Math.max(0.45, this.behavior.apexCut ?? 0.45);
      this.boostSeekWeight = 1.95;
      this.boostMaxLatDeviation = 6.2;
      this.boostThreshold = this.behavior.boostThreshold ?? 8;
      this.boostMaxCurvature = 0.0055;
      this.corridorHalfWidth = this.behavior.corridorHalfWidth ?? 1.6;
      this.decisionRate = 1.8;
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
    if (this.sampleTimer >= 0.7) {
      const pos = v.chassisBody.position;
      const vel = v.chassisBody.velocity;
      const speed = Math.hypot(vel.x, vel.z);
      const dx = pos.x - this.lastSampledPos.x;
      const dz = pos.z - this.lastSampledPos.z;
      const displacementRate = Math.hypot(dx, dz) / this.sampleTimer;

      if (speed < 1.0 || displacementRate < 1.0) {
        this.immobileSeconds += this.sampleTimer;
      } else {
        this.immobileSeconds = 0;
      }

      this.lastSampledPos.set(pos.x, pos.y, pos.z);
      this.sampleTimer = 0;

      if (this.immobileSeconds >= CONFIG.ai.unstuckTime) {
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

    const nearestIdx = L.findNearestIndex(pos.x, pos.z);
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
        const score = rarityWeight * (this.boostSeekWeight || 1.0) * (0.45 + 0.55 * proximityWeight + 0.90 * pathAlignment);
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
    out.priorityBoost = bestBoostScore > 0.15;
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
    const probeMaxDist = clamp(24.0 + Math.max(0, v.forwardSpeed) * 0.6, 24.0, 48.0);

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

    // b) Vérification complémentaire dans le couloir avant (< 20 m) pour les 7 véhicules
    const lookOvertakeDist = Math.max(probeMaxDist, 28.0 * (beh.overtakeAggression || 1.0));
    for (let i = 0; i < allVehicles.length; i++) {
      const other = allVehicles[i];
      if (!other || other === v) continue;
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
      const fullLaneShift = 4.2 * Math.min(2.5, this.lateralSteeringForce);
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

    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      const t = L.tangents[v.trackIndex];
      const cross = _fwd.x * t.z - _fwd.z * t.x;
      v.controls.throttle = 0;
      v.controls.brake = 0.85;
      v.controls.steer = cross >= 0 ? -0.95 : 0.95;
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

    const maxLat = L.halfWidth - 1.30;

    // 1) Ligne de course stable et tendue (élimination définitive du louvoiement sinusoïdal)
    const targetCorridorOffset = clamp(this.preferredOffset, -this.corridorHalfWidth, this.corridorHalfWidth);
    this.lateralOffset = damp(this.lateralOffset, targetCorridorOffset, 0.6 * this.decisionRate, dt);

    // 2) Détection des jetons de boost (attraction) et ralentisseurs rouges (répulsion) dans le cône < 32m, < 58,5°
    const tokenEval = this._evaluateTokensInFrontCone(tokens, pos, maxLat);
    const tokenDampRate = (tokenEval.priorityBoost ? 9.5 : 5.8) * REACTION_SPEED_MULT;
    this.tokenOffset = damp(this.tokenOffset, tokenEval.shift, tokenDampRate, dt);

    // 3) Dépassement dynamique incisif (latence de réaction réduite de 30%)
    const overtakeEval = this._evaluateDynamicOvertake(allVehicles, pos, maxLat);
    const targetOvertakeShift = overtakeEval.targetOvertakeShift;
    const emergencyBrake = overtakeEval.emergencyBrake;
    this.overtakeOffset = damp(
      this.overtakeOffset,
      targetOvertakeShift,
      7.2 * beh.overtakeAggression * REACTION_SPEED_MULT,
      dt
    );

    // Hiérarchie des décalages latéraux avec autorité accrue
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

    // Point de visée anticipé continu (échantillonnage spline fluide le long de s + lookDist)
    // Résout définitivement les micro-saccades causées par le saut discret d'index de waypoints
    const speed = Math.max(0, v.forwardSpeed);
    const lookDist = clamp(Math.max(16.0, speed * (1.05 + 0.15 * (this.decisionRate || 1.0))), 16.0, 78.0);
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
    const desiredLat = clamp(idealRacingLat + activeLatShift + apexShift, -maxLat, maxLat);

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
    const baseLook = (12 + speed * 0.75) * this.brakeLookaheadMult;
    const brakeLookSteps = Math.max(3, Math.round(baseLook / L.ds));
    let minProfileSpeed = Infinity;
    for (let s = 0; s <= brakeLookSteps; s += 2) {
      const idx = (v.trackIndex + s) % n;
      if (L.speedProfile[idx] < minProfileSpeed) minProfileSpeed = L.speedProfile[idx];
    }

    const maxAllowedSpeed = CONFIG.car.topSpeed * this.maxSpeedFactor;
    let targetSpeed = Math.min(maxAllowedSpeed, minProfileSpeed * this.cornerSpeedFactor);

    if (v.finished) {
      targetSpeed *= 0.88;
    }

    if (Math.abs(steerCmd) > 0.65 && this.difficultyKey !== 'hard') {
      targetSpeed *= 0.92;
    }

    const speedDiff = targetSpeed - speed;
    let throttle = 0;
    let brake = emergencyBrake;

    if (speedDiff > -0.8 && emergencyBrake < 0.1) {
      throttle = clamp(0.55 + speedDiff * 0.24, 0.30, 1.0);
      if (Math.abs(steerCmd) > 0.82 && speed > 26 && this.difficultyKey !== 'hard') throttle *= 0.72;
    } else if (speedDiff < -1.6) {
      brake = Math.max(brake, clamp(-speedDiff / 12, 0.18, 0.98));
      throttle = 0;
    } else {
      throttle = 0.22;
    }

    const curNow = Math.abs(L.racingCurvature[v.trackIndex]);
    const curAhead = Math.abs(curvAhead);
    const isCornerExit = this.difficultyKey === 'hard' && curAhead < curNow * 0.88 && curAhead < 0.012;
    const maxSteerForBoost = this.difficultyKey === 'hard' ? 0.38 : 0.22;
    const minSpeedForBoost = this.difficultyKey === 'hard' ? 15 : 22;

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
