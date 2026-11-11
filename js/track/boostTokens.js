/**
 * boostTokens.js — Système de Jetons de Boost et de Ralentisseurs (Malus Rouge) avec Cycle Anti-Snowball :
 *  - 6 jetons de boost répartis aléatoirement le long du circuit lors de `resetRace()` :
 *      * 5 jetons standards (bleu/cyan translucide) -> +25% de jauge (« BOOST +25% »)
 *      * 1 jeton rare unique (doré/orange translucide) -> +40% de jauge (« SUPER BOOST +40% »)
 *  - 4 jetons « Ralentisseur » (malus rouge vif translucide `color: 0xff1122, opacity: 0.7, transparent: true`)
 *    placés à des positions aléatoires fixes distinctes des jetons de boost :
 *      * Au contact d'un véhicule (joueur ou bot), inflige -25% sur la vitesse actuelle
 *        et la puissance moteur pendant 2,5 secondes (« RALENTISSEMENT -25% »)
 *  - Cycle Dynamique d'Apparition/Disparition Aléatoire (Anti-Snowball) sur chaque jeton :
 *      1. Phase ACTIVE (visible et ramassable) : durée aléatoire tirée entre 3 et 10 secondes.
 *         Si personne ne le prend à la fin de ce délai, il disparaît et passe en COOLDOWN.
 *      2. Phase COOLDOWN (invisible et inactif) : durée aléatoire tirée entre 3 et 10 secondes
 *         avant de réapparaître en phase ACTIVE.
 *      3. Collecte anticipée : si une voiture ramasse un jeton pendant sa phase active, il bascule
 *         immédiatement en phase COOLDOWN (3 à 10s aléatoires) avant sa prochaine apparition.
 *      4. Synchronisation en ligne : l'Hôte calcule l'état d'apparition des jetons et transmet
 *         les bits d'état (`tokenMask`) dans le paquet réseau 30 Hz.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, computeRankBoostBonus } from '../config.js?v=41';
import { clamp } from '../core/utils.js?v=41';
import { soundManager } from '../core/audio.js?v=41';

const B = CONFIG.boost;

function randomActiveDuration() {
  const minT = B.activeMinTime ?? 3.0;
  const maxT = B.activeMaxTime ?? 10.0;
  return minT + Math.random() * (maxT - minT);
}

function randomCooldownDuration() {
  const minT = B.cooldownMinTime ?? 3.0;
  const maxT = B.cooldownMaxTime ?? 10.0;
  return minT + Math.random() * (maxT - minT);
}

export class BoostTokenSystem {
  /**
   * @param {import('./trackLayout.js').TrackLayout} layout
   * @param {THREE.Scene} scene
   */
  constructor(layout, scene) {
    this.layout = layout;
    this.scene = scene;

    this.root = new THREE.Group();
    this.root.name = 'boostTokens';
    this.scene.add(this.root);

    // Diamètre = 1/5 de la largeur de la piste (largeur = 2 * halfWidth = 14m -> diamètre = 2.8m, rayon = 1.4m)
    const trackWidth = (this.layout.halfWidth || 7) * 2;
    this.tokenDiameter = trackWidth * 0.20;
    this.tokenRadius = this.tokenDiameter * 0.5;

    this.boostCount = B.tokenCount ?? 8;
    this.slowdownCount = B.slowdownTokenCount ?? 9;

    this._buildSharedAssets();
    this.tokens = [];
    this._createTokenPool(this.boostCount + this.slowdownCount);
  }

  _buildSharedAssets() {
    const r = this.tokenRadius;

    // Combinaison d'un tore 3D et d'un cylindre aplati hexagonal pour rendre la rotation Y très lisible
    const torus = new THREE.TorusGeometry(r * 0.78, r * 0.14, 12, 24);
    torus.rotateX(Math.PI * 0.38);

    const coreDisc = new THREE.CylinderGeometry(r * 0.56, r * 0.56, 0.22, 6);

    const innerFin = new THREE.BoxGeometry(r * 1.45, 0.14, 0.18);

    this.tokenGeometry = mergeGeometries([
      torus.toNonIndexed(),
      coreDisc.toNonIndexed(),
      innerFin.toNonIndexed(),
    ]);
    this.tokenGeometry.computeVertexNormals();

    // 1) Matériau Standard Boost (Bleu / Cyan translucide, opacity: 0.7)
    this.normalMaterial = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: 0x00b8d4,
      emissiveIntensity: 1.15,
      roughness: 0.18,
      metalness: 0.35,
      transparent: true,
      opacity: 0.7,
    });

    // 2) Matériau Rare Boost (Doré / Orange translucide, opacity: 0.75)
    this.rareMaterial = new THREE.MeshStandardMaterial({
      color: 0xffd600,
      emissive: 0xff6d00,
      emissiveIntensity: 1.65,
      roughness: 0.12,
      metalness: 0.55,
      transparent: true,
      opacity: 0.75,
    });

    // 3) Matériau Ralentisseur / Malus Rouge (Rouge vif translucide, color: 0xff1122, opacity: 0.7, transparent: true)
    this.slowdownMaterial = new THREE.MeshStandardMaterial({
      color: 0xff1122,
      emissive: 0xd50018,
      emissiveIntensity: 1.35,
      roughness: 0.20,
      metalness: 0.35,
      transparent: true,
      opacity: 0.7,
    });

    // Halo additionnel pour le jeton rare (+40%) et le jeton ralentisseur (-25%)
    this.haloGeo = new THREE.TorusGeometry(r * 1.02, r * 0.06, 8, 28);
    this.haloGeo.rotateX(Math.PI * 0.5);

    this.rareHaloMat = new THREE.MeshBasicMaterial({
      color: 0xffab00,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.slowdownHaloMat = new THREE.MeshBasicMaterial({
      color: 0xff1122,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  _createTokenPool(totalCount) {
    for (let i = 0; i < totalCount; i++) {
      const group = new THREE.Group();

      const mesh = new THREE.Mesh(this.tokenGeometry, this.normalMaterial);
      group.add(mesh);

      const halo = new THREE.Mesh(this.haloGeo, this.rareHaloMat);
      halo.visible = false;
      group.add(halo);

      this.root.add(group);

      this.tokens.push({
        index: i,
        kind: 'boost', // 'boost' | 'slowdown'
        group,
        mesh,
        halo,
        isRare: false,
        bonus: B.normalBonus || 25,
        active: true,
        phaseTimer: randomActiveDuration(), // Durée de la phase courante (ACTIVE ou COOLDOWN : 3 à 10s)
        respawnTimer: 0,
        position: new THREE.Vector3(),
        trackS: 0,
        lateral: 0,
      });
    }
  }

  /**
   * Met à jour la référence de tracé si le joueur a changé de circuit.
   */
  setLayout(layout) {
    this.layout = layout;
  }

  /**
   * Tire au sort les positions fixes des 6 jetons de boost (5 standards +25%, 1 rare +40%)
   * et des 4 jetons ralentisseurs rouges (-25%) le long du circuit lors de `resetRace()`.
   * Chaque jeton démarre avec son propre cycle autonome (Phase ACTIVE de 3 à 10s aléatoires).
   */
  randomizeForRace() {
    const L = this.layout;
    const boostCount = this.boostCount;
    const slowdownCount = this.slowdownCount;
    const totalSlots = boostCount + slowdownCount;

    const usableStartS = 52; // Évite la grille de départ immédiate
    const usableLen = Math.max(220, L.length - 72);
    const segmentLen = usableLen / totalSlots;
    const maxLat = (L.halfWidth || 7) * 0.58;

    const slotOrder = Array.from({ length: totalSlots }, (_, idx) => idx);
    for (let i = slotOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slotOrder[i], slotOrder[j]] = [slotOrder[j], slotOrder[i]];
    }

    const rareBoostIdx = Math.floor(Math.random() * boostCount);

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      const slotIdx = slotOrder[i];
      const s = (usableStartS + (slotIdx + 0.18 + Math.random() * 0.64) * segmentLen) % L.length;
      const lateral = (Math.random() * 2 - 1) * maxLat;
      const sample = L.sample(s, lateral);

      token.trackS = s;
      token.lateral = lateral;
      token.position.set(sample.position.x, sample.position.y + 0.30, sample.position.z);

      if (i < boostCount) {
        token.kind = 'boost';
        token.isRare = (i === rareBoostIdx);
        token.bonus = token.isRare ? (B.rareBonus || 40) : (B.normalBonus || 25);
        token.mesh.material = token.isRare ? this.rareMaterial : this.normalMaterial;
        token.halo.material = this.rareHaloMat;
        token.halo.visible = token.isRare;
      } else {
        token.kind = 'slowdown';
        token.isRare = false;
        token.bonus = 0;
        token.mesh.material = this.slowdownMaterial;
        token.halo.material = this.slowdownHaloMat;
        token.halo.visible = true;
      }

      token.active = true;
      token.phaseTimer = randomActiveDuration();
      token.respawnTimer = 0;
      token.group.position.copy(token.position);
      token.group.visible = true;
      token.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
    }
  }

  /** Exporte la disposition actuelle des 10 jetons pour synchronisation réseau Hôte -> Invité. */
  exportTokenLayout() {
    return this.tokens.map((t) => ({
      trackS: t.trackS,
      lateral: t.lateral,
      kind: t.kind,
      isRare: t.isRare,
      bonus: t.bonus,
    }));
  }

  /** Applique côté Invité la disposition exacte des jetons générée par l'Hôte. */
  applyTokenLayout(layoutList) {
    if (!Array.isArray(layoutList)) return;
    const L = this.layout;
    for (let i = 0; i < Math.min(this.tokens.length, layoutList.length); i++) {
      const src = layoutList[i];
      const token = this.tokens[i];
      const sample = L.sample(src.trackS, src.lateral);

      token.trackS = src.trackS;
      token.lateral = src.lateral;
      token.position.set(sample.position.x, sample.position.y + 0.30, sample.position.z);
      token.kind = src.kind || 'boost';
      token.isRare = Boolean(src.isRare);
      token.bonus = src.bonus ?? (token.isRare ? 40 : 25);

      if (token.kind === 'boost') {
        token.mesh.material = token.isRare ? this.rareMaterial : this.normalMaterial;
        token.halo.material = this.rareHaloMat;
        token.halo.visible = token.isRare;
      } else {
        token.mesh.material = this.slowdownMaterial;
        token.halo.material = this.slowdownHaloMat;
        token.halo.visible = true;
      }

      token.active = true;
      token.phaseTimer = randomActiveDuration();
      token.respawnTimer = 0;
      token.group.position.copy(token.position);
      token.group.visible = true;
    }
  }

  /** Synchronise l'état actif/inactif des jetons à partir du masque binaire (`tokenMask`) reçu de l'Hôte. */
  applyNetworkMask(mask) {
    for (let i = 0; i < this.tokens.length; i++) {
      const isActive = Boolean(mask & (1 << i));
      const token = this.tokens[i];
      if (token.localGuestCooldown > 0 && isActive) {
        continue;
      }
      if (!isActive) {
        token.localGuestCooldown = 0;
      }
      token.active = isActive;
      token.group.visible = isActive;
    }
  }

  /** Désactive immédiatement côté Hôte un jeton ramassé par l'Invité pour synchroniser le masque réseau. */
  deactivateTokenFromNetwork(tokenIndex) {
    const idx = Math.round(tokenIndex);
    if (idx < 0 || idx >= this.tokens.length) return;
    const token = this.tokens[idx];
    if (!token || !token.active) return;
    token.active = false;
    token.phaseTimer = randomCooldownDuration();
    token.respawnTimer = token.phaseTimer;
    token.group.visible = false;
  }

  /**
   * Calcule le gain de boost proportionnel à la place dans la course :
   *  - Jeton bleu standard : 5 * place (ex. 4ème -> 4 * 5 = +20%)
   *  - Jeton doré (gold)   : 10 * place (ex. 4ème -> 4 * 10 = +40%)
   */
  _computeTokenBoostBonus(vehicle, isRare) {
    return computeRankBoostBonus(vehicle?.rank || 1, Boolean(isRare));
  }

  /**
   * Mise à jour côté Invité (0 ms de latence au ramassage) :
   * Anime les jetons actifs et détecte instantanément la collecte par le véhicule de l'Invité.
   * Retourne l'index du jeton collecté (ou -1 si aucun).
   */
  updateGuestTokens(dt, localPlayer, particles = null) {
    const pickupRadius = this.tokenRadius + 0.95;
    const pickupRadiusSq = pickupRadius * pickupRadius;
    let pickedIdx = -1;

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.localGuestCooldown > 0) {
        token.localGuestCooldown = Math.max(0, token.localGuestCooldown - dt);
      }
      if (!token.active) continue;

      token.mesh.rotation.y += dt * 2.0;
      if (token.halo.visible) {
        token.halo.rotation.z -= dt * 1.5;
      }

      if (localPlayer && !localPlayer.finished && pickedIdx < 0) {
        const vp = localPlayer.chassisBody.position;
        const tx = token.position.x;
        const ty = token.position.y;
        const tz = token.position.z;
        if (Math.abs(vp.y - ty) <= 2.5) {
          const dx = vp.x - tx;
          const dz = vp.z - tz;
          if (dx * dx + dz * dz <= pickupRadiusSq) {
            pickedIdx = i;
            token.active = false;
            token.localGuestCooldown = 0.75;
            token.group.visible = false;

            if (token.kind === 'slowdown') {
              localPlayer.applySlowdownMalus(B.slowdownDuration || 3.0, B.slowdownFactor || 0.75);
              localPlayer.triggerHudNotification('RALENTISSEMENT -25%', 'slowdown', 2.0);
              if (soundManager.playSlowdownPickup) soundManager.playSlowdownPickup(0);
            } else {
              const bonus = this._computeTokenBoostBonus(localPlayer, token.isRare);
              localPlayer.boostEnergy = clamp(localPlayer.boostEnergy + bonus, 0, B.maxEnergy || 100);
              const label = token.isRare ? `SUPER BOOST +${bonus}%` : `BOOST +${bonus}%`;
              const notifType = token.isRare ? 'super' : 'boost';
              localPlayer.triggerHudNotification(label, notifType, 1.6);
              if (soundManager.playBoostPickup) soundManager.playBoostPickup(token.isRare, 0);
            }
          }
        }
      }
    }
    return pickedIdx;
  }

  /**
   * Anime la rotation des jetons (`rotation.y += dt * 2`), gère le cycle dynamique
   * ACTIVE (3–10s) <-> COOLDOWN (3–10s) et teste la collision physique avec tous les véhicules.
   *
   * @param {number} dt
   * @param {Array<import('../physics/vehicle.js').Vehicle>} vehicles
   * @param {import('../gfx/particles.js').ParticleSystem} [particles]
   */
  update(dt, vehicles, particles = null) {
    const pickupRadius = this.tokenRadius + 0.95;
    const pickupRadiusSq = pickupRadius * pickupRadius;

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];

      // 1) Phase COOLDOWN (invisible et inactif pendant 3 à 10s aléatoires)
      if (!token.active) {
        token.phaseTimer -= dt;
        token.respawnTimer = token.phaseTimer;
        if (token.phaseTimer <= 0) {
          token.active = true;
          token.phaseTimer = randomActiveDuration();
          token.respawnTimer = 0;
          token.group.visible = true;
        }
        continue;
      }

      // 2) Phase ACTIVE (visible et ramassable pendant 3 à 10s aléatoires) :
      //    si personne ne le prend à la fin de ce délai, il disparaît et passe en COOLDOWN (3 à 10s)
      token.phaseTimer -= dt;
      if (token.phaseTimer <= 0) {
        token.active = false;
        token.phaseTimer = randomCooldownDuration();
        token.respawnTimer = token.phaseTimer;
        token.group.visible = false;
        continue;
      }

      // Rotation continue sur lui-même (rotation.y += dt * 2)
      token.mesh.rotation.y += dt * 2.0;
      if (token.halo.visible) {
        token.halo.rotation.z -= dt * 1.5;
      }

      if (particles && token.isRare && Math.random() < 0.35) {
        const angle = Math.random() * Math.PI * 2;
        const rx = token.position.x + Math.cos(angle) * (this.tokenRadius * 0.75);
        const rz = token.position.z + Math.sin(angle) * (this.tokenRadius * 0.75);
        particles.spawn(
          rx, token.position.y + 0.1, rz,
          (Math.random() - 0.5) * 0.8, 0.9 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8,
          0.35, 0.14, 0.02,
          1.0, 0.78, 0.12
        );
      }

      // 3) Collecte anticipée au contact d'un véhicule : bascule immédiatement en phase COOLDOWN (3 à 10s)
      const tx = token.position.x;
      const ty = token.position.y;
      const tz = token.position.z;

      for (let vIdx = 0; vIdx < vehicles.length; vIdx++) {
        const v = vehicles[vIdx];
        if (!v || v.finished) continue;

        const vp = v.chassisBody.position;
        const dy = Math.abs(vp.y - ty);
        if (dy > 2.5) continue;

        const dx = vp.x - tx;
        const dz = vp.z - tz;
        if (dx * dx + dz * dz <= pickupRadiusSq) {
          token.active = false;
          token.phaseTimer = randomCooldownDuration();
          token.respawnTimer = token.phaseTimer;
          token.group.visible = false;

          if (token.kind === 'slowdown') {
            v.applySlowdownMalus(B.slowdownDuration || 3.0, B.slowdownFactor || 0.75);
            v.triggerHudNotification('RALENTISSEMENT -25%', 'slowdown', 2.0);

            if (particles) {
              for (let k = 0; k < 16; k++) {
                particles.spawn(
                  tx + (Math.random() - 0.5) * 0.8,
                  ty + (Math.random() - 0.5) * 0.4,
                  tz + (Math.random() - 0.5) * 0.8,
                  (Math.random() - 0.5) * 5.2,
                  1.4 + Math.random() * 2.8,
                  (Math.random() - 0.5) * 5.2,
                  0.36 + Math.random() * 0.20,
                  0.19, 0.03,
                  1.0, 0.07, 0.13
                );
              }
            }

            if (!v.isAI && soundManager.playSlowdownPickup) {
              const pan = v.id === 'p1' ? -0.45 : v.id === 'p2' ? 0.45 : 0;
              soundManager.playSlowdownPickup(pan);
            }
          } else {
            const bonus = this._computeTokenBoostBonus(v, token.isRare);
            v.boostEnergy = clamp(v.boostEnergy + bonus, 0, B.maxEnergy || 100);
            const label = token.isRare ? `SUPER BOOST +${bonus}%` : `BOOST +${bonus}%`;
            const notifType = token.isRare ? 'super' : 'boost';
            v.triggerHudNotification(label, notifType, 1.6);

            if (particles) {
              const cR = token.isRare ? 1.0 : 0.0;
              const cG = token.isRare ? 0.78 : 0.90;
              const cB = token.isRare ? 0.12 : 1.0;
              for (let k = 0; k < 14; k++) {
                particles.spawn(
                  tx + (Math.random() - 0.5) * 0.8,
                  ty + (Math.random() - 0.5) * 0.4,
                  tz + (Math.random() - 0.5) * 0.8,
                  (Math.random() - 0.5) * 5.0,
                  1.5 + Math.random() * 3.0,
                  (Math.random() - 0.5) * 5.0,
                  0.32 + Math.random() * 0.18,
                  0.18, 0.03,
                  cR, cG, cB
                );
              }
            }

            if (!v.isAI && soundManager.playBoostPickup) {
              const pan = v.id === 'p1' ? -0.45 : v.id === 'p2' ? 0.45 : 0;
              soundManager.playBoostPickup(token.isRare, pan);
            }
          }
          break;
        }
      }
    }
  }

  dispose() {
    this.tokenGeometry.dispose();
    this.normalMaterial.dispose();
    this.rareMaterial.dispose();
    this.slowdownMaterial.dispose();
    this.haloGeo.dispose();
    this.rareHaloMat.dispose();
    this.slowdownHaloMat.dispose();
    this.root.removeFromParent();
  }
}
