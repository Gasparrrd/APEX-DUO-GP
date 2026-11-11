/**
 * garageScene.js — Scène 3D du Garage / Salon Partagé (1 à 4 joueurs) :
 *  - Showroom 3D éclairé avec plateau tournant principal et jusqu'à 3 podiums secondaires.
 *  - En mode « Multijoueur en Ligne » (2 à 4 joueurs) :
 *      * La voiture du joueur local occupe le plateau principal (`turntable`) pour une personnalisation 360° confortable.
 *      * Les voitures des autres slots (Hôte et Invités 2, 3, 4) occupent les podiums environnants.
 *      * Projection 3D -> 2D temps réel des badges flottants au-dessus de chaque podium
 *        affichant le pseudonyme, le modèle et le statut (« EN ATTENTE » / « PRÊT » / « BOT IA »).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CarModel, GROUND_OFFSET } from '../gfx/carModel.js?v=42';
import { garageFloorTexture, blobShadowTexture } from '../gfx/textures.js?v=42';
import { DEFAULT_PLAYER_CARS } from '../config.js?v=42';

const _anchor3D = new THREE.Vector3();

export class GarageScene {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} studioEnvMap
   * @param {object[]} playerConfigs  [p1Config, p2Config, p3Config, p4Config]
   */
  constructor(renderer, studioEnvMap, playerConfigs) {
    this.renderer = renderer;
    this.envMap = studioEnvMap;
    this.playerConfigs = playerConfigs;
    while (this.playerConfigs.length < 4) {
      const idx = this.playerConfigs.length;
      this.playerConfigs.push({ ...(DEFAULT_PLAYER_CARS[idx] || DEFAULT_PLAYER_CARS[0]) });
    }

    this.activePlayer = 0; // 0 = Slot 1 (Hôte), 1..3 = Slots 2..4 (Invités)
    this.isOnlineLobby = false;
    this.offlinePlayerCount = 2;
    this.slotOccupied = [true, false, false, false];
    this.visibleSlots = [0, 1];
    this.visibleCarCount = 2;
    this._lastCameraCarCount = -1;
    this._desiredCamDist = 6.15;
    this._desiredCamElev = 1.85;
    this._desiredTarget = new THREE.Vector3(0, 0.65, 0);
    this._camTransitionRemaining = 0;

    this.slotPodiumAnchors = [
      new THREE.Vector3(0, 1.55, 0),
      new THREE.Vector3(-4.4, 1.45, 3.3),
      new THREE.Vector3(4.6, 1.45, 3.6),
      new THREE.Vector3(0, 1.45, 6.2),
    ];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1017);
    this.scene.fog = new THREE.FogExp2(0x0d1017, 0.020);

    this.camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(3.9, 1.85, -4.6);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 0.65, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.9;
    this.controls.maxDistance = 16.0;
    this.controls.minPolarAngle = 0.22;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.75;
    this.controls.update();

    this._buildShowroom();
    this._buildCars();
  }

  _buildShowroom() {
    const floorTex = garageFloorTexture();
    floorTex.repeat.set(28, 28);
    const floorGeo = new THREE.PlaneGeometry(80, 80);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.35,
      metalness: 0.25,
      envMap: this.envMap,
      envMapIntensity: 0.65,
    });
    this.scene.add(new THREE.Mesh(floorGeo, floorMat));

    const padGeo = new THREE.CylinderGeometry(2.9, 3.05, 0.14, 64);
    padGeo.translate(0, 0.07, 0);
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x1c212b,
      metalness: 0.65,
      roughness: 0.28,
      envMap: this.envMap,
    });

    const ringGeo = new THREE.RingGeometry(2.78, 2.86, 64);
    ringGeo.rotateX(-Math.PI / 2);

    // Podium 0 : Emplacement principal central
    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);
    this.turntable.add(new THREE.Mesh(padGeo, padMat));

    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x29b6f6, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, this.ringMat);
    ring.position.y = 0.145;
    this.turntable.add(ring);

    // Podium 1 : Second emplacement (arrière-gauche)
    this.secondaryPod = new THREE.Group();
    this.secondaryPod.position.set(-3.55, 0, 2.65);
    this.secondaryPod.rotation.y = 0.48;
    this.scene.add(this.secondaryPod);

    const pod2 = new THREE.Mesh(padGeo, padMat);
    pod2.scale.set(0.86, 0.8, 0.86);
    this.secondaryPod.add(pod2);

    this.secondaryRingMat = new THREE.MeshBasicMaterial({ color: 0xfb8c00, side: THREE.DoubleSide });
    const ring2 = new THREE.Mesh(ringGeo, this.secondaryRingMat);
    ring2.scale.set(0.86, 0.86, 0.86);
    ring2.position.y = 0.12;
    this.secondaryPod.add(ring2);

    // Podium 2 : Troisième emplacement (arrière-droite, pour le Slot 3 en ligne)
    this.thirdPod = new THREE.Group();
    this.thirdPod.position.set(3.55, 0, 2.65);
    this.thirdPod.rotation.y = -0.48;
    this.thirdPod.visible = false;
    this.scene.add(this.thirdPod);

    const pod3 = new THREE.Mesh(padGeo, padMat);
    pod3.scale.set(0.84, 0.8, 0.84);
    this.thirdPod.add(pod3);

    this.thirdRingMat = new THREE.MeshBasicMaterial({ color: 0x00c853, side: THREE.DoubleSide });
    const ring3 = new THREE.Mesh(ringGeo, this.thirdRingMat);
    ring3.scale.set(0.84, 0.84, 0.84);
    ring3.position.y = 0.12;
    this.thirdPod.add(ring3);

    // Podium 3 : Quatrième emplacement (fond central, pour le Slot 4 en ligne)
    this.fourthPod = new THREE.Group();
    this.fourthPod.position.set(0, 0, 4.65);
    this.fourthPod.rotation.y = 0.0;
    this.fourthPod.visible = false;
    this.scene.add(this.fourthPod);

    const pod4 = new THREE.Mesh(padGeo, padMat);
    pod4.scale.set(0.82, 0.8, 0.82);
    this.fourthPod.add(pod4);

    this.fourthRingMat = new THREE.MeshBasicMaterial({ color: 0x8e24aa, side: THREE.DoubleSide });
    const ring4 = new THREE.Mesh(ringGeo, this.fourthRingMat);
    ring4.scale.set(0.82, 0.82, 0.82);
    ring4.position.y = 0.12;
    this.fourthPod.add(ring4);

    this.podiums = [this.turntable, this.secondaryPod, this.thirdPod, this.fourthPod];
    this.ringMats = [this.ringMat, this.secondaryRingMat, this.thirdRingMat, this.fourthRingMat];

    // Arche lumineuse de studio au-dessus du plateau
    const archMat = new THREE.MeshBasicMaterial({ color: 0xe3f2fd });
    const lightBarGeo = new THREE.BoxGeometry(3.8, 0.08, 0.28);
    for (const z of [-1.2, 0, 1.2]) {
      const bar = new THREE.Mesh(lightBarGeo, archMat);
      bar.position.set(0, 4.4, z);
      this.scene.add(bar);
    }

    const hemi = new THREE.HemisphereLight(0xdbe9ff, 0x181c24, 1.0);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(5, 8, -5);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x90caf9, 1.1);
    fillLight.position.set(-6, 5, 4);
    this.scene.add(fillLight);

    const rimLight = new THREE.PointLight(0xffb74d, 1.6, 16);
    rimLight.position.set(0, 3.2, 4.5);
    this.scene.add(rimLight);
  }

  _buildCars() {
    const shadowGeo = new THREE.PlaneGeometry(2.4, 4.8);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: blobShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
    });

    this.carModels = [0, 1, 2, 3].map((idx) => {
      const holder = new THREE.Group();
      const model = new CarModel(this.playerConfigs[idx], { envMap: this.envMap });
      model.root.position.y = -GROUND_OFFSET;
      const sh = new THREE.Mesh(shadowGeo, shadowMat);
      sh.position.y = 0.01;
      holder.add(model.root, sh);
      return { holder, model };
    });

    this._layoutCars();
  }

  /**
   * Retourne les positions et rotations des podiums selon le nombre exact de voitures (1 à 4)
   * afin d'assurer un espacement harmonieux et sans chevauchement.
   */
  _getPodiumLayoutForCount(count) {
    if (count <= 1) {
      return [
        { x: 0, y: 0, z: 0, rotY: 0 },
      ];
    }
    if (count === 2) {
      return [
        { x: 0, y: 0, z: 0, rotY: 0 },
        { x: -4.4, y: 0, z: 3.3, rotY: 0.45 },
      ];
    }
    if (count === 3) {
      return [
        { x: 0, y: 0, z: 0, rotY: 0 },
        { x: -4.6, y: 0, z: 3.6, rotY: 0.46 },
        { x: 4.6, y: 0, z: 3.6, rotY: -0.46 },
      ];
    }
    return [
      { x: 0, y: 0, z: 0, rotY: 0 },
      { x: -4.9, y: 0, z: 3.2, rotY: 0.48 },
      { x: 4.9, y: 0, z: 3.2, rotY: -0.48 },
      { x: 0, y: 0, z: 6.2, rotY: 0.0 },
    ];
  }

  /**
   * Ajuste automatiquement le recul / dézoom et le point de visée de la caméra du salon
   * selon le nombre de voitures présentes (1, 2, 3 ou 4) pour offrir la même visibilité
   * que dans le salon hors-ligne.
   */
  _updateCameraFramingForCount(count, immediate = false) {
    const clampedCount = Math.max(1, Math.min(4, count || 1));
    let dist = 6.15;
    let elev = 1.85;
    let tx = 0;
    let ty = 0.65;
    let tz = 0;

    if (clampedCount === 1) {
      dist = 6.15;
      elev = 1.85;
      tx = 0;
      ty = 0.65;
      tz = 0;
    } else if (clampedCount === 2) {
      dist = 7.65;
      elev = 2.15;
      tx = -0.95;
      ty = 0.70;
      tz = 0.85;
    } else if (clampedCount === 3) {
      dist = 9.60;
      elev = 2.55;
      tx = 0;
      ty = 0.78;
      tz = 1.45;
    } else {
      dist = 11.25;
      elev = 2.95;
      tx = 0;
      ty = 0.85;
      tz = 2.25;
    }

    this._desiredCamDist = dist;
    this._desiredCamElev = elev;
    this._desiredTarget.set(tx, ty, tz);

    if (immediate || this._lastCameraCarCount === -1) {
      this._lastCameraCarCount = clampedCount;
      this._camTransitionRemaining = 0;
      this._applyDesiredCameraFraming(1.0);
    } else if (this._lastCameraCarCount !== clampedCount) {
      this._lastCameraCarCount = clampedCount;
      this._camTransitionRemaining = 0.65;
    }
  }

  _applyDesiredCameraFraming(alpha = 1.0) {
    if (!this.controls || !this.camera) return;
    const curTarget = this.controls.target;
    const offset = this.camera.position.clone().sub(curTarget);
    let horizLen = Math.hypot(offset.x, offset.z);
    let dirX = 3.9 / Math.hypot(3.9, -4.6);
    let dirZ = -4.6 / Math.hypot(3.9, -4.6);
    if (horizLen > 0.001) {
      dirX = offset.x / horizLen;
      dirZ = offset.z / horizLen;
    }

    curTarget.lerp(this._desiredTarget, alpha);

    const curDist = offset.length() || 6.15;
    const nextDist = curDist + (this._desiredCamDist - curDist) * alpha;
    const curElev = offset.y;
    const nextElev = curElev + (this._desiredCamElev - curElev) * alpha;
    const nextHoriz = Math.sqrt(Math.max(1.0, nextDist * nextDist - nextElev * nextElev));

    this.camera.position.set(
      curTarget.x + dirX * nextHoriz,
      curTarget.y + nextElev,
      curTarget.z + dirZ * nextHoriz
    );
    this.controls.update();
  }

  _layoutCars() {
    if (!this.carModels || !this.podiums) return;

    // 1. Détacher toutes les voitures des podiums avant de recomposer la scène
    for (let i = 0; i < 4; i++) {
      const holder = this.carModels[i]?.holder;
      if (holder && holder.parent) {
        holder.parent.remove(holder);
      }
    }

    // 2. Déterminer la liste exacte des slots visibles (de 1 à 4)
    let visibleSlots = [];
    if (this.isOnlineLobby) {
      const mainSlot = (this.activePlayer >= 0 && this.activePlayer <= 3) ? this.activePlayer : 0;
      if (this.slotOccupied[mainSlot]) {
        visibleSlots.push(mainSlot);
      }
      for (let s = 0; s < 4; s++) {
        if (s !== mainSlot && this.slotOccupied[s]) {
          visibleSlots.push(s);
        }
      }
      if (visibleSlots.length === 0) {
        visibleSlots.push(mainSlot);
      }
    } else {
      const offlineCount = this.offlinePlayerCount === 2 ? 2 : 1;
      const mainIdx = (offlineCount === 2 && this.activePlayer === 1) ? 1 : 0;
      visibleSlots.push(mainIdx);
      if (offlineCount === 2) {
        visibleSlots.push(1 - mainIdx);
      }
    }

    this.visibleSlots = visibleSlots;
    const count = visibleSlots.length;
    this.visibleCarCount = count;

    const layout = this._getPodiumLayoutForCount(count);

    // 3. Positionner uniquement les podiums nécessaires (0 .. count - 1) et masquer les autres
    for (let podIdx = 0; podIdx < 4; podIdx++) {
      const pod = this.podiums[podIdx];
      if (!pod) continue;

      if (podIdx < count) {
        const slotIdx = visibleSlots[podIdx];
        const cfg = layout[podIdx] || layout[0];
        pod.visible = true;
        pod.position.set(cfg.x, cfg.y, cfg.z);
        if (podIdx > 0) {
          pod.rotation.y = cfg.rotY;
        }

        const carHolder = this.carModels[slotIdx].holder;
        pod.add(carHolder);
        carHolder.position.set(0, podIdx === 0 ? 0.14 : 0.11, 0);
        carHolder.rotation.set(0, 0, 0);

        if (this.ringMats[podIdx]) {
          this.ringMats[podIdx].color.set(this.playerConfigs[slotIdx]?.color || '#1e88e5');
        }
        this.slotPodiumAnchors[slotIdx].set(cfg.x, cfg.y + (podIdx === 0 ? 1.55 : 1.45), cfg.z);
      } else {
        pod.visible = false;
      }
    }

    this._updateCameraFramingForCount(count, this._lastCameraCarCount === -1);
  }

  /** Change le joueur actuellement édité (0..3). */
  setActivePlayer(playerIndex) {
    if (playerIndex < 0 || playerIndex > 3) return;
    this.activePlayer = playerIndex;
    this._layoutCars();
  }

  /**
   * Active ou désactive explicitement le mode Salon Multijoueur en Ligne (podiums + badges 3D).
   */
  setOnlineLobbyMode(isOnline) {
    this.isOnlineLobby = Boolean(isOnline);
    this._layoutCars();
  }

  /**
   * Met à jour les emplacements occupés dans le salon multijoueur (tableau de 4 booléens)
   * et ajuste immédiatement le nombre de voitures, leur espacement et le recul caméra.
   */
  setOnlineLobbyState(occupiedFlags, activePlayerIndex = this.activePlayer) {
    this.isOnlineLobby = true;
    if (Array.isArray(occupiedFlags) && occupiedFlags.length >= 4) {
      this.slotOccupied = [
        Boolean(occupiedFlags[0]),
        Boolean(occupiedFlags[1]),
        Boolean(occupiedFlags[2]),
        Boolean(occupiedFlags[3]),
      ];
    }
    if (typeof activePlayerIndex === 'number' && activePlayerIndex >= 0 && activePlayerIndex <= 3) {
      this.activePlayer = activePlayerIndex;
    }
    this._layoutCars();
  }

  /**
   * Configure l'affichage des emplacements 3D du garage (hors-ligne et en ligne).
   */
  setPlayerCount(count, isOnline = this.isOnlineLobby, occupiedFlags = null) {
    this.isOnlineLobby = Boolean(isOnline);
    if (this.isOnlineLobby) {
      if (Array.isArray(occupiedFlags) && occupiedFlags.length >= 4) {
        this.slotOccupied = [
          Boolean(occupiedFlags[0]),
          Boolean(occupiedFlags[1]),
          Boolean(occupiedFlags[2]),
          Boolean(occupiedFlags[3]),
        ];
      } else {
        const c = Math.max(1, Math.min(4, Number(count) || 1));
        this.slotOccupied = [0, 1, 2, 3].map((i) => i < c);
        if (this.activePlayer >= 0 && this.activePlayer <= 3) {
          this.slotOccupied[this.activePlayer] = true;
        }
      }
      this._layoutCars();
      return;
    }

    this.offlinePlayerCount = (count === 2) ? 2 : 1;
    if (this.offlinePlayerCount <= 1 && this.activePlayer !== 0) {
      this.activePlayer = 0;
    }
    this._layoutCars();
  }

  /** Applique instantanément les modifications de personnalisation au véhicule indiqué (0..3). */
  updateCarConfig(playerIndex, partialConfig) {
    if (playerIndex < 0 || playerIndex > 3 || !partialConfig) return;
    Object.assign(this.playerConfigs[playerIndex], partialConfig);
    this.carModels[playerIndex].model.apply(this.playerConfigs[playerIndex]);
    this._layoutCars();
  }

  setEnabled(enabled) {
    this.controls.enabled = enabled;
  }

  onResize(width, height) {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Projette les positions 3D au-dessus des podiums en mode Salon Multijoueur.
   * Affiche uniquement les badges des joueurs réellement présents dans le salon.
   */
  _updateFloating3DTags() {
    const tagIds = ['garage-tag-host', 'garage-tag-guest', 'garage-tag-slot-2', 'garage-tag-slot-3'];

    if (!this.isOnlineLobby) {
      for (let i = 0; i < tagIds.length; i++) {
        const el = document.getElementById(tagIds[i]);
        if (el) el.classList.add('hidden');
      }
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const visibleSet = new Set(this.visibleSlots || []);

    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const tagEl = document.getElementById(tagIds[slotIdx]);
      if (!tagEl) continue;

      if (!visibleSet.has(slotIdx)) {
        tagEl.classList.add('hidden');
        continue;
      }

      _anchor3D.copy(this.slotPodiumAnchors[slotIdx]);
      _anchor3D.project(this.camera);
      if (_anchor3D.z < 1.0) {
        const sx = (_anchor3D.x * 0.5 + 0.5) * w;
        const sy = (-_anchor3D.y * 0.5 + 0.5) * h;
        tagEl.style.left = `${sx}px`;
        tagEl.style.top = `${sy}px`;
        tagEl.classList.remove('hidden');
      } else {
        tagEl.classList.add('hidden');
      }
    }
  }

  render(dt) {
    if (this._camTransitionRemaining > 0) {
      const step = Math.min(1.0, (dt || 0.016) * 6.5);
      this._applyDesiredCameraFraming(step);
      this._camTransitionRemaining = Math.max(0, this._camTransitionRemaining - (dt || 0.016));
    }
    this.controls.update();
    const activeModel = this.carModels[this.activePlayer]?.model;
    if (activeModel) activeModel.setBoost(false, 0);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.renderer.render(this.scene, this.camera);
    this._updateFloating3DTags();
  }
}
