/**
 * chaseCamera.js — Caméra tierce personne fluide ("chase cam") sans saccades (anti-jitter) :
 *  - Doit être appelée APRÈS la synchronisation des meshes Three.js avec Cannon-es
 *  - Utilise un lissage exponentiel indépendant du framerate :
 *      factor = 1.0 - Math.exp(-decayRate * deltaTime)
 *  - Cible `camera.lookAt()` lissée légèrement devant la voiture sans à-coups angulaires
 *  - Tampon de profondeur stabilisé : `camera.near = 0.1` et `camera.far = 1000`
 */
import * as THREE from 'three';
import { CONFIG } from '../config.js?v=41';
import { clamp, damp } from '../core/utils.js?v=41';

const _fwd = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _targetLook = new THREE.Vector3();

export class ChaseCamera {
  constructor(aspect = 1) {
    const near = CONFIG.render.cameraNear || 0.1;
    const far = CONFIG.render.cameraFar || 3000;
    this.camera = new THREE.PerspectiveCamera(62, aspect, near, far);
    this.currentPos = new THREE.Vector3();
    this.currentLook = new THREE.Vector3();
    this.headingDir = new THREE.Vector3(0, 0, -1);
    this.smoothDistBack = 6.2;
    this.baseFov = 62;
    this.initialized = false;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Place immédiatement la caméra derrière la voiture (au départ ou après respawn). */
  snap(vehicle) {
    const pos = vehicle.renderPosition || vehicle.root.position;
    const quat = vehicle.renderQuaternion || vehicle.root.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
    else _fwd.normalize();

    this.headingDir.copy(_fwd);
    this.smoothDistBack = 6.2;

    this.currentPos.copy(pos).addScaledVector(this.headingDir, -this.smoothDistBack);
    this.currentPos.y = pos.y + 2.30;

    this.currentLook.copy(pos).addScaledVector(this.headingDir, 4.8);
    this.currentLook.y = pos.y + 0.80;

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);
    this.initialized = true;
  }

  /**
   * Met à jour la caméra en suivant strictement la position (`lerp`) et la rotation (`slerp`)
   * interpolées du véhicule (`vehicle.renderPosition` / `vehicle.renderQuaternion`),
   * jamais le body physique brut.
   */
  update(vehicle, deltaTime) {
    if (!this.initialized) {
      this.snap(vehicle);
      return;
    }

    const pos = vehicle.renderPosition || vehicle.root.position;
    const quat = vehicle.renderQuaternion || vehicle.root.quaternion;

    // Vecteur avant issu du quaternion interpolé (`slerp`) du véhicule
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
    else _fwd.normalize();

    // Lissage exponentiel de l'orientation de la caméra (sans saut de seuil angulaire)
    const dirDecay = 12.0;
    const dirAlpha = 1.0 - Math.exp(-dirDecay * deltaTime);
    this.headingDir.lerp(_fwd, dirAlpha).normalize();

    const v = vehicle.chassisBody.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    const targetDistBack = 6.15 + clamp(speed / 70, 0, 1) * 0.45 + (vehicle.isBoosting ? 0.35 : 0);
    this.smoothDistBack = damp(this.smoothDistBack, targetDistBack, 8.0, deltaTime);

    // Position cible de la caméra par rapport à la position interpolée `pos`
    _targetPos.copy(pos).addScaledVector(this.headingDir, -this.smoothDistBack);
    _targetPos.y = pos.y + 2.25 + clamp(speed / 90, 0, 1) * 0.15;

    // Point visé légèrement devant la position interpolée `pos`
    _targetLook.copy(pos).addScaledVector(this.headingDir, 4.8);
    _targetLook.y = pos.y + 0.78;

    // Suivi lissé haute fréquence de la cible interpolée
    const posDecay = 28.0;
    const lookDecay = 32.0;
    const posFactor = 1.0 - Math.exp(-posDecay * deltaTime);
    const lookFactor = 1.0 - Math.exp(-lookDecay * deltaTime);

    this.currentPos.lerp(_targetPos, posFactor);
    this.currentLook.lerp(_targetLook, lookFactor);

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);

    // Effet dynamique de FOV lissé
    const speedRatio = clamp(speed / CONFIG.car.topSpeed, 0, 1.2);
    const targetFov = this.baseFov + speedRatio * 7 + (vehicle.isBoosting ? 7 : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.02) {
      this.camera.fov = damp(this.camera.fov, targetFov, 7.5, deltaTime);
      this.camera.updateProjectionMatrix();
    }
  }
}
