/**
 * particles.js — Système de particules poolé en un seul draw call (InstancedMesh).
 * Gère :
 *  - les traînées lumineuses et étincelles du boost (nitro)
 *  - la fumée de pneus lors des dérapages / freinages appuyés
 *  - les projections d'herbe/terre hors-piste
 */
import * as THREE from 'three';

const MAX_PARTICLES = 600;
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

export class ParticleSystem {
  constructor(scene) {
    this.max = MAX_PARTICLES;
    this.cursor = 0;

    // Données par particule (tableaux typés pour éviter le GC)
    this.px = new Float32Array(this.max);
    this.py = new Float32Array(this.max);
    this.pz = new Float32Array(this.max);
    this.vx = new Float32Array(this.max);
    this.vy = new Float32Array(this.max);
    this.vz = new Float32Array(this.max);
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.s0 = new Float32Array(this.max);
    this.s1 = new Float32Array(this.max);
    this.cr = new Float32Array(this.max);
    this.cg = new Float32Array(this.max);
    this.cb = new Float32Array(this.max);

    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // Initialise toutes les instances à l'échelle 0
    _scale.set(0, 0, 0);
    _mat.compose(_pos, _quat, _scale);
    for (let i = 0; i < this.max; i++) {
      this.mesh.setMatrixAt(i, _mat);
      this.mesh.setColorAt(i, _col.setRGB(1, 1, 1));
    }
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** Émet une particule. */
  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
  }

  /** Traînée lumineuse de boost à l'arrière d'un échappement. */
  emitBoost(worldPos, carVel) {
    const jx = (Math.random() - 0.5) * 0.08;
    const jy = (Math.random() - 0.5) * 0.08;
    const jz = (Math.random() - 0.5) * 0.08;
    const hot = Math.random() > 0.35;
    const r = hot ? 0.25 : 1.0;
    const g = hot ? 0.82 : 0.65;
    const b = 1.0;
    this.spawn(
      worldPos.x + jx, worldPos.y + jy, worldPos.z + jz,
      carVel.x * 0.25 + (Math.random() - 0.5) * 1.5,
      carVel.y * 0.25 + 0.4 + Math.random() * 0.8,
      carVel.z * 0.25 + (Math.random() - 0.5) * 1.5,
      0.16 + Math.random() * 0.14,
      0.13, 0.02,
      r, g, b
    );
  }

  /** Traînée de particules rouges temporaire lorsqu'un véhicule subit le malus Ralentisseur (-25%). */
  emitSlowdown(worldPos, carVel) {
    const jx = (Math.random() - 0.5) * 0.22;
    const jy = (Math.random() - 0.5) * 0.14;
    const jz = (Math.random() - 0.5) * 0.22;
    const bright = Math.random() > 0.3;
    const r = 1.0;
    const g = bright ? 0.12 : 0.04;
    const b = bright ? 0.18 : 0.06;
    this.spawn(
      worldPos.x + jx, worldPos.y + jy, worldPos.z + jz,
      carVel.x * 0.20 + (Math.random() - 0.5) * 1.6,
      carVel.y * 0.20 + 0.5 + Math.random() * 0.9,
      carVel.z * 0.20 + (Math.random() - 0.5) * 1.6,
      0.22 + Math.random() * 0.18,
      0.15, 0.03,
      r, g, b
    );
  }

  /** Fumée de pneu (drift ou freinage fort). */
  emitSmoke(worldPos, intensity = 1) {
    const c = 0.82 + Math.random() * 0.12;
    this.spawn(
      worldPos.x + (Math.random() - 0.5) * 0.2,
      worldPos.y + 0.05,
      worldPos.z + (Math.random() - 0.5) * 0.2,
      (Math.random() - 0.5) * 1.4,
      0.6 + Math.random() * 0.9,
      (Math.random() - 0.5) * 1.4,
      0.35 + Math.random() * 0.25,
      0.12 * intensity,
      0.42 * intensity,
      c, c, c
    );
  }

  /** Projection d'herbe / poussière hors-piste. */
  emitDirt(worldPos) {
    this.spawn(
      worldPos.x + (Math.random() - 0.5) * 0.25,
      worldPos.y + 0.08,
      worldPos.z + (Math.random() - 0.5) * 0.25,
      (Math.random() - 0.5) * 2.2,
      1.2 + Math.random() * 1.6,
      (Math.random() - 0.5) * 2.2,
      0.28 + Math.random() * 0.18,
      0.10, 0.22,
      0.42, 0.52, 0.28
    );
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      any = true;
      const age = this.age[i] + dt;
      if (age >= life) {
        this.life[i] = 0;
        _scale.set(0, 0, 0);
        _mat.compose(_pos, _quat, _scale);
        this.mesh.setMatrixAt(i, _mat);
        continue;
      }
      this.age[i] = age;
      const t = age / life;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.vx[i] *= 0.96;
      this.vz[i] *= 0.96;

      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const fade = 1 - t * t;
      _pos.set(this.px[i], this.py[i], this.pz[i]);
      _scale.setScalar(s * fade);
      _mat.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _mat);
      _col.setRGB(this.cr[i] * fade, this.cg[i] * fade, this.cb[i] * fade);
      this.mesh.setColorAt(i, _col);
    }
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
