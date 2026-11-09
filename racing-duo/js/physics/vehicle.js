/**
 * vehicle.js — Véhicule complet combinant :
 *  - Physique Cannon-es (RaycastVehicle : suspension, transfert de masse,
 *    roulis, collisions rigides et pentes 3D)
 *  - Calcul temps réel des statistiques :
 *      Stat_Finale = Paramètre_Global * Modificateur_Véhicule * Modificateur_Météo (* Adhérence_Générale)
 *  - Effets météo : réduction d'adhérence sous la pluie (0.75x) et poussée de vent en tempête
 *  - Synchronisation anti-saccades (interpolatedPosition / interpolatedQuaternion)
 *    exécutée AVANT la mise à jour des caméras
 *  - Zéro allocation mémoire par frame dans `updatePhysics()` et `syncVisuals()`
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG, computeVehicleStats } from '../config.js?v=25';
import { clamp, damp, moveTowards, wrapDelta } from '../core/utils.js?v=25';
import { soundManager } from '../core/audio.js?v=25';
import { CarModel } from '../gfx/carModel.js?v=25';
import { blobShadowTexture } from '../gfx/textures.js?v=25';

const C = CONFIG.car;
const B = CONFIG.boost;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _physQuat = new THREE.Quaternion();
const _exhaustWorld = new THREE.Vector3();
const _wheelWorld = new THREE.Vector3();
const _spawnPos = new THREE.Vector3();
const _spawnEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _spawnQuat = new THREE.Quaternion();

const _localBoostForce = new CANNON.Vec3();
const _localOrigin = new CANNON.Vec3(0, 0, 0);
const _latForceVec = new CANNON.Vec3();
const _dragForceVec = new CANNON.Vec3();
const _windForceVec = new CANNON.Vec3();
const _slopeForceVec = new CANNON.Vec3();

export class Vehicle {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} [opts.displayTag]
   * @param {string} [opts.shortTag]
   * @param {boolean} opts.isAI
   * @param {object} opts.carConfig   { bodyType, color, rims, rimFinish, spoiler }
   * @param {THREE.Scene} opts.scene
   * @param {CANNON.World} opts.world
   * @param {CANNON.Material} opts.chassisMat
   * @param {import('../track/trackLayout.js').TrackLayout} opts.layout
   * @param {THREE.Texture} [opts.envMap]
   */
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name || 'Pilote';
    this.displayTag = opts.displayTag || this.name;
    this.shortTag = opts.shortTag || this.displayTag;
    this.colorHex = opts.carConfig?.color || '#00e5ff';
    this.isAI = Boolean(opts.isAI);
    this.aiSpeedMultiplier = opts.aiSpeedMultiplier ?? 1.0;
    this.aiSteerRateMult = opts.aiSteerRateMult ?? 1.0;
    this.bodyType = opts.carConfig?.bodyType || 'supercar';
    this.scene = opts.scene;
    this.world = opts.world;
    this.layout = opts.layout;

    // Objets de travail pré-alloués par véhicule (zéro allocation GC à 60 Hz)
    this._projOut = { index: 0, s: 0, lateral: 0, dist: 0, y: 0, slope: 0 };
    this._statsOut = {
      topSpeed: C.topSpeed,
      enginePower: C.enginePower,
      maxEngineForce: C.maxEngineForce,
      frictionFront: C.frictionFront,
      frictionRear: C.frictionRear,
      lateralGripDamping: C.lateralGripDamping,
      brakeImpulse: C.brakeImpulse,
      dragCoef: C.dragCoef,
      windForce: [0, 0, 0],
    };

    // Modèle 3D
    this.model = new CarModel(opts.carConfig, { envMap: opts.envMap });
    this.root = this.model.root;
    this.scene.add(this.root);

    // Ombre portée douce au sol
    const shadowGeo = new THREE.PlaneGeometry(2.35, 4.75);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: blobShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.72,
    });
    this.shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowMesh.position.y = 0.02;
    this.scene.add(this.shadowMesh);

    // Corps rigide du châssis
    const [hx, hy, hz] = C.chassisHalfExtents;
    this.chassisBody = new CANNON.Body({
      mass: C.mass,
      material: opts.chassisMat,
      linearDamping: 0.01,
      angularDamping: C.angularDamping,
      collisionFilterGroup: 1,
      collisionFilterMask: 1 | 2,
    });
    this.chassisBody.allowSleep = false;
    this.chassisBody.addShape(
      new CANNON.Box(new CANNON.Vec3(hx, hy * 0.85, hz)),
      new CANNON.Vec3(0, 0.36, 0)
    );
    const bumperSphere = new CANNON.Sphere(0.26);
    this.chassisBody.addShape(bumperSphere, new CANNON.Vec3(0, 0.36, -hz + 0.28));
    this.chassisBody.addShape(bumperSphere, new CANNON.Vec3(0, 0.36, hz - 0.28));

    // Détection des chocs pour le moteur audio (joueurs humains)
    this._lastCollisionSoundTime = 0;
    this.chassisBody.addEventListener('collide', (ev) => {
      if (this.isAI) return;
      const now = performance.now();
      if (now - this._lastCollisionSoundTime < 150) return;
      const impactVel = ev.contact && typeof ev.contact.getImpactVelocityAlongNormal === 'function'
        ? Math.abs(ev.contact.getImpactVelocityAlongNormal())
        : 0;
      if (impactVel > 2.2) {
        this._lastCollisionSoundTime = now;
        const intensity = clamp((impactVel - 1.5) / 18, 0.14, 1.0);
        const pan = this.id === 'p1' ? -0.45 : this.id === 'p2' ? 0.45 : 0;
        soundManager.playCollision(intensity, pan);
      }
    });

    // RaycastVehicle Cannon-es
    this.raycastVehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    const wheelBaseOpts = {
      radius: C.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(1, 0, 0),
      suspensionStiffness: C.suspensionStiffness,
      suspensionRestLength: C.suspensionRestLength,
      dampingRelaxation: C.dampingRelaxation,
      dampingCompression: C.dampingCompression,
      maxSuspensionForce: C.maxSuspensionForce,
      maxSuspensionTravel: C.maxSuspensionTravel,
      rollInfluence: C.rollInfluence,
      useCustomSlidingRotationalSpeed: true,
      customSlidingRotationalSpeed: -25,
    };

    const wheelPositions = [
      [-C.wheelHalfTrack, C.connectionY, C.wheelFrontZ, C.frictionFront],
      [C.wheelHalfTrack, C.connectionY, C.wheelFrontZ, C.frictionFront],
      [-C.wheelHalfTrack, C.connectionY, C.wheelRearZ, C.frictionRear],
      [C.wheelHalfTrack, C.connectionY, C.wheelRearZ, C.frictionRear],
    ];

    for (const [wx, wy, wz, friction] of wheelPositions) {
      this.raycastVehicle.addWheel({
        ...wheelBaseOpts,
        frictionSlip: friction,
        chassisConnectionPointLocal: new CANNON.Vec3(wx, wy, wz),
      });
    }
    this.raycastVehicle.addToWorld(this.world);

    // État d'interpolation Physique -> Rendu
    this.prevPhysicsPos = new THREE.Vector3();
    this.currPhysicsPos = new THREE.Vector3();
    this.renderPosition = new THREE.Vector3();

    this.prevPhysicsQuat = new THREE.Quaternion();
    this.currPhysicsQuat = new THREE.Quaternion();
    this.renderQuaternion = new THREE.Quaternion();

    this.prevSuspension = [C.suspensionRestLength, C.suspensionRestLength, C.suspensionRestLength, C.suspensionRestLength];
    this.currSuspension = [C.suspensionRestLength, C.suspensionRestLength, C.suspensionRestLength, C.suspensionRestLength];

    // État dynamique et contrôles
    this.controls = { throttle: 0, brake: 0, steer: 0, boost: false, reset: false };
    this.steerAngle = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.speedKmh = 0;
    this.slipAngle = 0;
    this.isDrifting = false;
    this.onGrass = false;
    this.visualPitch = 0;
    this.visualRoll = 0;

    // Boost / Nitro & Malus Ralentisseur (-25% pendant 2,5s)
    this.boostEnergy = B.startEnergy;
    this.isBoosting = false;
    this.boostExhaustLatch = false;
    this.slowdownTimer = 0;
    this.slowdownFactor = B.slowdownFactor || 0.75;

    // Notifications HUD déclenchées EXCLUSIVEMENT au ramassage des jetons
    this.hudNotificationTimer = 0;
    this.hudNotificationText = '';
    this.hudNotificationType = 'boost'; // 'boost' | 'super' | 'slowdown'

    // État de course
    this.totalLaps = CONFIG.race.laps;
    this.lap = 1;
    this.nextCheckpoint = 1;
    this.checkpointsPassed = 0;
    this.trackIndex = 0;
    this.trackS = 0;
    this.trackLateral = 0;
    this.trackY = 0;
    this.trackSlope = 0;
    this.smoothedSlope = 0;
    this.raceProgress = 0;
    this.rank = 1;
    this.isWrongWay = false;
    this.wrongWayTimer = 0;
    this.upsideDownTimer = 0;

    this.lapStartTime = 0;
    this.currentLapTime = 0;
    this.bestLapTime = Infinity;
    this.finishTime = 0;
    this.finished = false;

    // Freinage automatique propre à +10..15m après la ligne d'arrivée & frein de parking verrouillé
    this.postFinishDistance = 0;
    this.postFinishTargetDistance = 12.0;
    this.finishCrossingPos = new THREE.Vector3();
    this.parkingLocked = false;
    this.parkedPos = new THREE.Vector3();
    this.parkedQuat = new THREE.Quaternion();
  }

  /**
   * Enregistre l'état physique précédent (position, quaternion, suspension) juste avant `world.step(fixedTimeStep)`.
   */
  savePreviousPhysicsState() {
    const body = this.chassisBody;
    this.prevPhysicsPos.set(body.position.x, body.position.y, body.position.z);
    this.prevPhysicsQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const wheels = this.raycastVehicle.wheelInfos;
    for (let i = 0; i < 4; i++) {
      this.prevSuspension[i] = this.currSuspension[i] ?? wheels[i].suspensionLength;
    }
  }

  /**
   * Capture l'état physique courant juste après `world.step(fixedTimeStep)` et valide les checkpoints / ligne d'arrivée.
   */
  afterPhysicsStep(dt, raceTime) {
    const body = this.chassisBody;
    this.currPhysicsPos.set(body.position.x, body.position.y, body.position.z);
    this.currPhysicsQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const wheels = this.raycastVehicle.wheelInfos;
    for (let i = 0; i < 4; i++) {
      this.raycastVehicle.updateWheelTransform(i);
      this.currSuspension[i] = clamp(wheels[i].suspensionLength, 0.08, C.suspensionRestLength + C.maxSuspensionTravel);
    }
    this._updateRaceProgress(dt, raceTime);
  }

  /**
   * Place la voiture à une position et orientation données (avant = `forward`)
   * et remet à zéro toutes les vitesses, forces et (si `resetRaceState`) compteurs de course.
   */
  setSpawn(position, forward, resetRaceState = false, initialForwardSpeed = 0) {
    const body = this.chassisBody;
    body.position.set(position.x, position.y, position.z);
    body.previousPosition.set(position.x, position.y, position.z);
    body.initPosition.set(position.x, position.y, position.z);
    body.interpolatedPosition.set(position.x, position.y, position.z);

    const proj = this.layout.project(position.x, position.z, undefined, position.y, this._projOut);
    const slope = proj.slope || 0;
    const yaw = Math.atan2(-forward.x, -forward.z);
    const pitch = Math.atan2(slope, 1);

    _spawnEuler.set(pitch, yaw, 0, 'YXZ');
    _spawnQuat.setFromEuler(_spawnEuler);
    body.quaternion.set(_spawnQuat.x, _spawnQuat.y, _spawnQuat.z, _spawnQuat.w);
    body.previousQuaternion.copy(body.quaternion);
    body.initQuaternion.copy(body.quaternion);
    body.interpolatedQuaternion.copy(body.quaternion);

    this.prevPhysicsPos.set(position.x, position.y, position.z);
    this.currPhysicsPos.set(position.x, position.y, position.z);
    this.renderPosition.set(position.x, position.y, position.z);

    this.prevPhysicsQuat.copy(_spawnQuat);
    this.currPhysicsQuat.copy(_spawnQuat);
    this.renderQuaternion.copy(_spawnQuat);

    if (initialForwardSpeed !== 0) {
      const len = Math.hypot(forward.x, forward.z) || 1;
      body.velocity.set(
        (forward.x / len) * initialForwardSpeed,
        slope * initialForwardSpeed,
        (forward.z / len) * initialForwardSpeed
      );
    } else {
      body.velocity.setZero();
    }
    body.angularVelocity.setZero();
    body.force.setZero();
    body.torque.setZero();
    body.wakeUp();

    this.steerAngle = 0;
    this.visualPitch = 0;
    this.visualRoll = 0;
    this.forwardSpeed = initialForwardSpeed;
    this.lateralSpeed = 0;
    this.speedKmh = Math.abs(initialForwardSpeed) * 3.6;
    this.slipAngle = 0;
    this.isDrifting = false;

    for (let i = 0; i < 4; i++) {
      this.raycastVehicle.setSteeringValue(0, i);
      this.raycastVehicle.applyEngineForce(0, i);
      this.raycastVehicle.setBrake(0, i);
      const w = this.raycastVehicle.wheelInfos[i];
      w.sliding = false;
      w.suspensionLength = C.suspensionRestLength;
      w.suspensionRelativeVelocity = 0;
      w.suspensionForce = 0;
      w.forwardImpulse = 0;
      w.sideImpulse = 0;
      this.prevSuspension[i] = C.suspensionRestLength;
      this.currSuspension[i] = C.suspensionRestLength;
    }

    this.trackIndex = proj.index;
    this.trackS = proj.s;
    this.trackLateral = proj.lateral;
    this.trackY = proj.y || 0;
    this.trackSlope = slope;
    this.smoothedSlope = slope;

    if (resetRaceState) {
      this.controls.throttle = 0;
      this.controls.brake = 0;
      this.controls.steer = 0;
      this.controls.boost = false;
      this.controls.reset = false;
      this.boostEnergy = B.startEnergy;
      this.isBoosting = false;
      this.boostExhaustLatch = false;
      this.slowdownTimer = 0;
      this.slowdownFactor = B.slowdownFactor || 0.75;
      this.hudNotificationTimer = 0;
      this.hudNotificationText = '';
      this.hudNotificationType = 'boost';
      this.lap = 1;
      this.nextCheckpoint = 1;
      this.checkpointsPassed = 0;
      this.raceProgress = proj.s > this.layout.length * 0.5 ? proj.s - this.layout.length : proj.s;
      this.lapStartTime = 0;
      this.currentLapTime = 0;
      this.bestLapTime = Infinity;
      this.finishTime = 0;
      this.finished = false;
      this.postFinishDistance = 0;
      this.postFinishTargetDistance = 12.0;
      this.finishCrossingPos.copy(position);
      this.parkingLocked = false;
      this.parkedPos.copy(position);
      this.parkedQuat.copy(_spawnQuat);
      this.isWrongWay = false;
      this.wrongWayTimer = 0;
      this.upsideDownTimer = 0;
      this.wheelSpin[0] = 0;
      this.wheelSpin[1] = 0;
      this.wheelSpin[2] = 0;
      this.wheelSpin[3] = 0;
    }

    this.syncVisuals(0, 0, null, 1.0);
  }

  /** Replace la voiture au centre de la piste à l'endroit actuel. */
  resetToTrack(relaunchSpeed = 0) {
    const sample = this.layout.sample(this.trackS, 0);
    _spawnPos.set(sample.position.x, sample.position.y + 0.65, sample.position.z);
    this.setSpawn(_spawnPos, sample.tangent, false, relaunchSpeed);
  }

  getForwardVector(out = _fwd) {
    return out.set(0, 0, -1).applyQuaternion(this.root.quaternion);
  }

  getRightVector(out = _right) {
    return out.set(1, 0, 0).applyQuaternion(this.root.quaternion);
  }

  /**
   * Déclenche une notification visuelle temporaire sur le HUD du joueur
   * (« BOOST +25% », « SUPER BOOST +40% » ou « RALENTISSEMENT -25% »).
   */
  triggerHudNotification(text, type = 'boost', duration = 1.6) {
    this.hudNotificationText = text;
    this.hudNotificationType = type;
    this.hudNotificationTimer = duration;
  }

  /**
   * Applique immédiatement le malus d'un jeton ralentisseur rouge :
   * -25% sur la vitesse actuelle et la puissance moteur pendant 2,5 secondes.
   */
  applySlowdownMalus(duration = 3.0, factor = 0.75) {
    this.slowdownTimer = duration;
    this.slowdownFactor = factor;
    this.chassisBody.velocity.x *= factor;
    this.chassisBody.velocity.z *= factor;
    this.forwardSpeed *= factor;
    this.speedKmh = Math.abs(this.forwardSpeed) * 3.6;
  }

  /**
   * Gestion de l'arrivée : freinage automatique progressif et linéaire sur 10 à 15 mètres
   * au-delà de la ligne d'arrivée, suivi du verrouillage complet du frein de parking.
   */
  _updatePostFinishAutoBrake(dt) {
    const body = this.chassisBody;
    const vel = body.velocity;
    const speedAbs = Math.hypot(vel.x, vel.y, vel.z);

    this.controls.throttle = 0;
    this.controls.brake = 0;
    this.controls.steer = 0;
    this.controls.boost = false;
    this.isBoosting = false;

    const stepDist = Math.max(0, this.forwardSpeed) * dt;
    const chordDist = Math.hypot(
      body.position.x - this.finishCrossingPos.x,
      body.position.z - this.finishCrossingPos.z
    );
    this.postFinishDistance = Math.max(this.postFinishDistance + stepDist, chordDist);

    if (
      !this.parkingLocked &&
      (this.postFinishDistance >= this.postFinishTargetDistance || this.speedKmh < 1.0 || speedAbs < 0.28)
    ) {
      this.parkingLocked = true;
      this.parkedPos.set(body.position.x, body.position.y, body.position.z);
      this.parkedQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }

    if (this.parkingLocked) {
      for (let i = 0; i < 4; i++) {
        this.raycastVehicle.applyEngineForce(0, i);
        this.raycastVehicle.setBrake(1e5, i);
        this.raycastVehicle.setSteeringValue(0, i);
      }
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);

      body.position.x = this.parkedPos.x;
      body.position.z = this.parkedPos.z;
      body.quaternion.set(this.parkedQuat.x, this.parkedQuat.y, this.parkedQuat.z, this.parkedQuat.w);

      this.forwardSpeed = 0;
      this.lateralSpeed = 0;
      this.speedKmh = 0;
      this.isDrifting = false;
      this.visualPitch = damp(this.visualPitch, 0, 12, dt);
      this.visualRoll = damp(this.visualRoll, 0, 12, dt);
      this.model.setBraking(true);
      this.model.setBoost(false);
      return;
    }

    const progress = clamp(this.postFinishDistance / Math.max(1, this.postFinishTargetDistance), 0, 1);
    const remainingDist = Math.max(0.35, this.postFinishTargetDistance - this.postFinishDistance);

    const tangent = this.layout.tangents[this.trackIndex];
    const crossYaw = _fwd.x * tangent.z - _fwd.z * tangent.x;
    const alignSteer = clamp(crossYaw * 0.45, -0.18, 0.18);
    this.steerAngle = moveTowards(this.steerAngle, alignSteer, C.steerReturnRate * dt);
    this.raycastVehicle.setSteeringValue(this.steerAngle, 0);
    this.raycastVehicle.setSteeringValue(this.steerAngle, 1);

    const brakeForce = 32 + 68 * progress;
    for (let i = 0; i < 4; i++) {
      this.raycastVehicle.applyEngineForce(0, i);
      this.raycastVehicle.setBrake(brakeForce, i);
    }

    const kinematicDecel = (speedAbs * speedAbs) / (2 * remainingDist);
    const linearDecel = Math.max(9.0 + 14.0 * progress, kinematicDecel);
    const newSpeed = Math.max(0, speedAbs - linearDecel * dt);
    if (speedAbs > 1e-4) {
      const ratio = newSpeed / speedAbs;
      vel.x *= ratio;
      vel.z *= ratio;
    }
    body.angularVelocity.scale(0.85, body.angularVelocity);

    this.forwardSpeed = newSpeed;
    this.speedKmh = newSpeed * 3.6;
    this.isDrifting = false;
    this.visualPitch = damp(this.visualPitch, -0.024 * (1 - progress * 0.5), 10, dt);
    this.visualRoll = damp(this.visualRoll, 0, 10, dt);
    this.model.setBraking(true);
    this.model.setBoost(false);
  }

  /**
   * Met à jour la physique du véhicule avant le pas de simulation Cannon-es (zéro allocation GC).
   */
  updatePhysics(dt, canDrive, raceTime, envContext = null) {
    const body = this.chassisBody;
    const q = body.quaternion;
    _physQuat.set(q.x, q.y, q.z, q.w);

    _fwd.set(0, 0, -1).applyQuaternion(_physQuat);
    _right.set(1, 0, 0).applyQuaternion(_physQuat);

    const vel = body.velocity;
    this.forwardSpeed = vel.x * _fwd.x + vel.y * _fwd.y + vel.z * _fwd.z;
    this.lateralSpeed = vel.x * _right.x + vel.y * _right.y + vel.z * _right.z;
    const speedAbs = Math.hypot(vel.x, vel.y, vel.z);
    this.speedKmh = Math.abs(this.forwardSpeed) * 3.6;

    // Projection sur la piste 3D (avec objet pré-alloué `this._projOut`)
    const proj = this.layout.project(body.position.x, body.position.z, this.trackIndex, body.position.y, this._projOut);
    this.trackIndex = proj.index;
    this.trackS = proj.s;
    this.trackLateral = proj.lateral;
    this.trackY = proj.y || 0;
    this.trackSlope = proj.slope || 0;
    this.onGrass = Math.abs(proj.lateral) > this.layout.halfWidth + 0.35;

    if (body.position.y < this.trackY - 3.5) {
      this.resetToTrack(0);
      return;
    }

    if (this.finished && !this.isAI) {
      this._updatePostFinishAutoBrake(dt);
      return;
    }

    if (this.controls.reset && canDrive) {
      this.controls.reset = false;
      this.resetToTrack(0);
      return;
    }

    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    if (upY < 0.25 && speedAbs < 3) {
      this.upsideDownTimer += dt;
      if (this.upsideDownTimer > 1.8) {
        this.upsideDownTimer = 0;
        this.resetToTrack(0);
        return;
      }
    } else {
      this.upsideDownTimer = 0;
    }

    if (!canDrive) {
      for (let i = 0; i < 4; i++) {
        this.raycastVehicle.applyEngineForce(0, i);
        this.raycastVehicle.setBrake(75, i);
        this.raycastVehicle.setSteeringValue(0, i);
      }
      this.model.setBraking(true);
      this.model.setBoost(false);
      return;
    }

    // Calcul temps réel des statistiques du véhicule dans `this._statsOut` (zéro allocation)
    const stats = computeVehicleStats(
      this.bodyType,
      envContext ? (envContext.weather || 'sunny') : 'sunny',
      envContext ? (envContext.globalGrip ?? 1.0) : 1.0,
      this._statsOut
    );

    const { throttle, brake, steer, boost } = this.controls;

    // 1) Direction
    const speedRatio = clamp(speedAbs / C.steerSpeedRef, 0, 1);
    const maxSteerNow = C.maxSteer + (C.minSteer - C.maxSteer) * Math.pow(speedRatio, 0.85);
    const targetSteer = clamp(steer, -1, 1) * maxSteerNow;
    const baseRate = Math.abs(targetSteer) > Math.abs(this.steerAngle) ? C.steerRate : C.steerReturnRate;
    const rate = baseRate * (this.isAI ? (this.aiSteerRateMult || 1.0) : 1.0);
    this.steerAngle = moveTowards(this.steerAngle, targetSteer, rate * dt);
    this.raycastVehicle.setSteeringValue(this.steerAngle, 0);
    this.raycastVehicle.setSteeringValue(this.steerAngle, 1);

    // 2) Système de Boost par Jetons
    if (this.slowdownTimer > 0) {
      this.slowdownTimer = Math.max(0, this.slowdownTimer - dt);
    }

    if (!boost) this.boostExhaustLatch = false;
    const wantsBoost = boost && !this.boostExhaustLatch && brake < 0.2 && this.forwardSpeed > -0.5;
    if (wantsBoost && this.boostEnergy > 0) {
      this.isBoosting = true;
      this.boostEnergy = Math.max(0, this.boostEnergy - (B.drain || (100 / 7.5)) * dt);
      if (this.boostEnergy <= 0.05) {
        this.boostEnergy = 0;
        this.isBoosting = false;
        this.boostExhaustLatch = true;
      }
    } else {
      this.isBoosting = false;
    }

    // 3) Moteur, freinage et marche arrière
    const boostMult = this.isBoosting ? (B.speedMultiplier || 1.15) : 1.0;
    const slowdownMult = this.slowdownTimer > 0 ? (this.slowdownFactor || 0.75) : 1.0;
    const aiSpeedMult = this.isAI ? (this.aiSpeedMultiplier || 1.0) : 1.0;
    const effectiveThrottle = this.isBoosting ? Math.max(throttle, 1.0) : throttle;
    const maxSpeed = stats.topSpeed * boostMult * slowdownMult * aiSpeedMult;
    const maxEngineForceNow = stats.maxEngineForce * boostMult * slowdownMult * Math.max(1.0, aiSpeedMult);
    const enginePowerNow = stats.enginePower * boostMult * slowdownMult * Math.max(1.0, aiSpeedMult * aiSpeedMult);
    let totalEngineForce = 0;
    let wheelBrake = 0;
    let brakingVisual = false;

    if (brake > 0.05 && !this.isBoosting) {
      if (this.forwardSpeed > 1.6) {
        wheelBrake = brake * stats.brakeImpulse;
        brakingVisual = true;
      } else {
        if (this.forwardSpeed > -C.maxReverseSpeed) {
          totalEngineForce = -brake * C.reverseForce;
        }
        brakingVisual = true;
      }
    } else if (effectiveThrottle > 0.05) {
      if (this.forwardSpeed < -1.0) {
        wheelBrake = effectiveThrottle * stats.brakeImpulse;
        brakingVisual = true;
      } else if (this.forwardSpeed < maxSpeed) {
        const vEff = Math.max(10, this.forwardSpeed);
        const baseForce = Math.min(maxEngineForceNow, enginePowerNow / vEff);
        const speedFade = clamp(1 - Math.pow(Math.max(0, this.forwardSpeed) / maxSpeed, 4), 0, 1);
        totalEngineForce = effectiveThrottle * baseForce * speedFade;
      } else if (this.slowdownTimer > 0) {
        wheelBrake = clamp((this.forwardSpeed - maxSpeed) * 8.0, 4.0, 28.0);
      }
    } else {
      wheelBrake = C.engineBrake;
    }

    const frontForce = totalEngineForce * C.frontTorqueShare * 0.5;
    const rearForce = totalEngineForce * (1 - C.frontTorqueShare) * 0.5;
    this.raycastVehicle.applyEngineForce(frontForce, 0);
    this.raycastVehicle.applyEngineForce(frontForce, 1);
    this.raycastVehicle.applyEngineForce(rearForce, 2);
    this.raycastVehicle.applyEngineForce(rearForce, 3);

    this.raycastVehicle.setBrake(wheelBrake * 1.15, 0);
    this.raycastVehicle.setBrake(wheelBrake * 1.15, 1);
    this.raycastVehicle.setBrake(wheelBrake * 0.85, 2);
    this.raycastVehicle.setBrake(wheelBrake * 0.85, 3);
    this.model.setBraking(brakingVisual);

    // 4) Adhérence latérale
    this.slipAngle = speedAbs > 4 ? Math.atan2(Math.abs(this.lateralSpeed), Math.abs(this.forwardSpeed)) : 0;
    const driftThreshold = this.bodyType === 'muscle' ? 0.19 : 0.24;
    this.isDrifting = speedAbs > 16 && this.slipAngle > driftThreshold;

    const grassFactor = this.onGrass ? C.grassFrictionFactor : 1.0;
    const frontBoostGrip = this.isBoosting ? 1.18 : 1.0;
    const muscleTailSlip = (this.bodyType === 'muscle' && effectiveThrottle > 0.6 && Math.abs(steer) > 0.55) ? 0.86 : 1.0;
    const violentTurnMod = (Math.abs(steer) > 0.85 && speedAbs > 32) ? 0.93 : 1.0;

    const wheels = this.raycastVehicle.wheelInfos;
    wheels[0].frictionSlip = stats.frictionFront * grassFactor * frontBoostGrip;
    wheels[1].frictionSlip = stats.frictionFront * grassFactor * frontBoostGrip;
    wheels[2].frictionSlip = stats.frictionRear * grassFactor * violentTurnMod * muscleTailSlip;
    wheels[3].frictionSlip = stats.frictionRear * grassFactor * violentTurnMod * muscleTailSlip;

    let wheelsOnGround = 0;
    for (let i = 0; i < 4; i++) if (wheels[i].isInContact) wheelsOnGround++;

    if (wheelsOnGround >= 2 && !this.onGrass && Math.abs(this.lateralSpeed) > 0.05) {
      const latGripForce = -this.lateralSpeed * C.mass * stats.lateralGripDamping;
      _latForceVec.set(_right.x * latGripForce, 0, _right.z * latGripForce);
      body.applyForce(_latForceVec);
    }

    if (wheelsOnGround >= 2 && Math.abs(this.steerAngle) > 0.005 && Math.abs(this.forwardSpeed) > 1.5) {
      const dirSign = this.forwardSpeed >= 0 ? 1 : -1;
      const speedFactor = clamp(Math.abs(this.forwardSpeed) / 28, 0.25, 1.35);
      body.torque.y += this.steerAngle * dirSign * speedFactor * C.mass * C.yawAssist;
    }

    // 4bis) Résistance gravitationnelle 3D continue et amortie (anti-saccades et anti-tremblements en montée pentue)
    this.smoothedSlope = damp(this.smoothedSlope, this.trackSlope, 6.5, dt);
    if (this.layout.hasRelief && wheelsOnGround >= 1 && Math.abs(this.smoothedSlope) > 0.003) {
      const t3 = (this.layout.tangents3D && this.layout.tangents3D[this.trackIndex])
        || this.layout.tangents[this.trackIndex];
      // Facteur de contact progressif pour éliminer tout sursaut binaire lors des décollages de roues
      const contactWeight = clamp(wheelsOnGround / 2.8, 0, 1);
      const slopeGravMag = -C.mass * CONFIG.physics.gravity * this.smoothedSlope * 0.60 * contactWeight;
      // Force alignée rigoureusement sur le vecteur 3D tangent (zéro couple parasite vertical)
      _slopeForceVec.set(t3.x * slopeGravMag, (t3.y || 0) * slopeGravMag, t3.z * slopeGravMag);
      body.applyForce(_slopeForceVec);
    }

    // 5) Poussée du Boost selon l'axe LOCAL avant (-Z)
    if (this.isBoosting && wheelsOnGround >= 1 && this.forwardSpeed < maxSpeed) {
      _localBoostForce.set(0, 0, -B.force);
      body.applyLocalForce(_localBoostForce, _localOrigin);
    }

    // 6) Forces aérodynamiques + Vecteur de vent météo
    if (speedAbs > 0.2) {
      const dragMag = stats.dragCoef * speedAbs * speedAbs + C.rollingResistance * speedAbs
        + (this.onGrass && wheelsOnGround > 0 ? C.mass * C.grassDrag : 0);
      const invV = 1 / speedAbs;
      _dragForceVec.set(
        -vel.x * invV * dragMag,
        -C.downforce * speedAbs * speedAbs,
        -vel.z * invV * dragMag
      );
      body.applyForce(_dragForceVec);
    }

    const wf = stats.windForce;
    const wx = wf[0], wy = wf[1], wz = wf[2];
    if (wx !== 0 || wz !== 0) {
      // Force et direction de vent 100% constantes et homogènes sur tout le circuit
      _windForceVec.set(wx, wy, wz);
      body.applyForce(_windForceVec);
    }

    // 7) Transfert de masse visuel
    const targetPitch = (brakingVisual && this.forwardSpeed > 2 ? -0.030 : 0)
      + (effectiveThrottle > 0.2 && this.forwardSpeed > 0.5 ? 0.020 : 0)
      + (this.isBoosting ? 0.018 : 0);
    const targetRoll = clamp(-this.lateralSpeed * 0.0065 - this.steerAngle * (speedAbs / 60) * 0.065, -0.075, 0.075);
    this.visualPitch = damp(this.visualPitch, targetPitch, 10, dt);
    this.visualRoll = damp(this.visualRoll, targetRoll, 10, dt);
  }

  _updateRaceProgress(dt, raceTime) {
    if (this.hudNotificationTimer > 0) {
      this.hudNotificationTimer = Math.max(0, this.hudNotificationTimer - dt);
    }

    const L = this.layout;
    const body = this.chassisBody;
    const proj = L.project(body.position.x, body.position.z, this.trackIndex, body.position.y, this._projOut);
    this.trackIndex = proj.index;
    this.trackS = proj.s;
    this.trackLateral = proj.lateral;
    this.trackY = proj.y || 0;
    this.trackSlope = proj.slope || 0;

    const t = L.tangents[this.trackIndex];
    this.getForwardVector(_fwd);
    const alignment = _fwd.x * t.x + _fwd.z * t.z;

    if (alignment < -0.35 && this.forwardSpeed > 2.5) {
      this.wrongWayTimer += dt;
      this.isWrongWay = this.wrongWayTimer > 0.65;
    } else {
      this.wrongWayTimer = Math.max(0, this.wrongWayTimer - dt * 2);
      if (this.wrongWayTimer < 0.2) this.isWrongWay = false;
    }

    if (this.finished) return;

    this.currentLapTime = Math.max(0, raceTime - this.lapStartTime);

    const numCP = CONFIG.track.numCheckpoints;
    const cpSpacing = L.length / numCP;

    if (this.nextCheckpoint > 0) {
      const targetS = this.nextCheckpoint * cpSpacing;
      const deltaS = wrapDelta(this.trackS, targetS, L.length);
      if (Math.abs(deltaS) < 22 && alignment > 0.1) {
        this.checkpointsPassed++;
        this.nextCheckpoint = (this.nextCheckpoint + 1) % numCP;
      }
    } else {
      const crossing = L.checkFinishLineCrossing(this.prevPhysicsPos, this.currPhysicsPos);
      if (crossing.crossed && alignment > 0.1) {
        const exactTime = Math.max(0, raceTime - dt * (1 - crossing.fraction));
        this.checkpointsPassed++;

        const lapTime = exactTime - this.lapStartTime;
        if (lapTime > 8 && lapTime < this.bestLapTime) this.bestLapTime = lapTime;
        this.lapStartTime = exactTime;
        this.currentLapTime = 0;

        if (this.lap >= this.totalLaps) {
          this.finished = true;
          this.finishTime = exactTime;
          this.postFinishDistance = 0;
          const slotOffset = this.id === 'p2' ? 2.0 : this.isAI ? 3.2 : 0;
          this.postFinishTargetDistance = 11.5 + slotOffset;
          this.finishCrossingPos.copy(this.currPhysicsPos);
          this.parkingLocked = false;
          this.controls.throttle = 0;
          this.controls.brake = 0;
          this.controls.steer = 0;
          this.controls.boost = false;
          this.isBoosting = false;
        } else {
          this.lap++;
        }
        this.nextCheckpoint = 1;
      }
    }

    let lapDist = this.trackS;
    if (this.nextCheckpoint === 1 && this.trackS > L.length * 0.5) {
      lapDist = this.trackS - L.length;
    } else if (this.nextCheckpoint === 0 && this.trackS < L.length * 0.25) {
      lapDist = L.length + this.trackS;
    }
    this.raceProgress = (this.lap - 1) * L.length + lapDist;
  }

  /**
   * Synchronise les transformations visuelles 3D (châssis, roues, ombre, particules)
   * par interpolation linéaire (`lerpVectors`) et sphérique (`slerpQuaternions`).
   */
  syncVisuals(dt, time, particles, alpha = 1.0) {
    const body = this.chassisBody;
    const tAlpha = typeof alpha === 'number' ? clamp(alpha, 0, 1) : 1.0;

    this.renderPosition.lerpVectors(this.prevPhysicsPos, this.currPhysicsPos, tAlpha);
    this.renderQuaternion.slerpQuaternions(this.prevPhysicsQuat, this.currPhysicsQuat, tAlpha);

    this.root.position.copy(this.renderPosition);
    this.root.quaternion.copy(this.renderQuaternion);

    this.model.body.rotation.x = this.visualPitch;
    this.model.body.rotation.z = this.visualRoll;
    this.model.setBoost(this.isBoosting, time);

    this.getForwardVector(_fwd);
    this.shadowMesh.position.set(this.renderPosition.x, this.trackY + 0.025, this.renderPosition.z);
    this.shadowMesh.rotation.y = Math.atan2(-_fwd.x, -_fwd.z);

    const wheels = this.raycastVehicle.wheelInfos;
    for (let i = 0; i < 4; i++) {
      const suspLen = this.prevSuspension[i] + (this.currSuspension[i] - this.prevSuspension[i]) * tAlpha;
      const localY = C.connectionY - suspLen;
      this.wheelSpin[i] -= (this.forwardSpeed * dt) / C.wheelRadius;
      const steer = i < 2 ? this.steerAngle : 0;
      this.model.setWheel(i, localY, steer, this.wheelSpin[i]);
    }

    if (particles && dt > 0) {
      const exList = this.model.exhaustLocal;
      if (this.isBoosting) {
        for (let i = 0; i < exList.length; i++) {
          _exhaustWorld.copy(exList[i]).applyQuaternion(this.root.quaternion).add(this.root.position);
          particles.emitBoost(_exhaustWorld, body.velocity);
          particles.emitBoost(_exhaustWorld, body.velocity);
        }
      }
      if (this.slowdownTimer > 0 && particles.emitSlowdown) {
        for (let i = 0; i < exList.length; i++) {
          _exhaustWorld.copy(exList[i]).applyQuaternion(this.root.quaternion).add(this.root.position);
          particles.emitSlowdown(_exhaustWorld, body.velocity);
        }
      }
      if (this.isDrifting && Math.random() < 0.75) {
        for (let wi = 2; wi <= 3; wi++) {
          const wp = wheels[wi].worldTransform.position;
          _wheelWorld.set(wp.x, wp.y - C.wheelRadius + 0.06, wp.z);
          particles.emitSmoke(_wheelWorld, clamp(this.slipAngle * 2.4, 0.6, 1.5));
        }
      } else if (this.onGrass && Math.abs(this.forwardSpeed) > 6 && Math.random() < 0.65) {
        for (let wi = 2; wi <= 3; wi++) {
          const wp = wheels[wi].worldTransform.position;
          _wheelWorld.set(wp.x, wp.y - C.wheelRadius + 0.06, wp.z);
          particles.emitDirt(_wheelWorld);
        }
      }
    }
  }

  dispose() {
    this.raycastVehicle.removeFromWorld(this.world);
    this.model.dispose();
    this.shadowMesh.geometry.dispose();
    this.shadowMesh.material.dispose();
    this.shadowMesh.removeFromParent();
  }
}
