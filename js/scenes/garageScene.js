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
import { CarModel, GROUND_OFFSET } from '../gfx/carModel.js?v=25';
import { garageFloorTexture, blobShadowTexture } from '../gfx/textures.js?v=25';
import { DEFAULT_PLAYER_CARS } from '../config.js?v=25';

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
    this.slotOccupied = [true, false, false, false];
    this.slotPodiumAnchors = [
      new THREE.Vector3(0, 1.55, 0),
      new THREE.Vector3(-3.55, 1.45, 2.65),
      new THREE.Vector3(3.55, 1.45, 2.65),
      new THREE.Vector3(0, 1.45, 4.55),
    ];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1017);
    this.scene.fog = new THREE.FogExp2(0x0d1017, 0.032);

    this.camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(3.9, 1.85, -4.6);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 0.65, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.9;
    this.controls.maxDistance = 8.5;
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

  _layoutCars() {
    if (this.isOnlineLobby) {
      // Le joueur local (activePlayer) est sur le plateau principal (Podium 0) pour personnaliser sa voiture de près
      const mainSlot = this.activePlayer;
      const otherSlots = [0, 1, 2, 3].filter((s) => s !== mainSlot);
      const slotOrder = [mainSlot, ...otherSlots];

      for (let podIdx = 0; podIdx < 4; podIdx++) {
        const slotIdx = slotOrder[podIdx];
        const pod = this.podiums[podIdx];
        const carHolder = this.carModels[slotIdx].holder;
        pod.add(carHolder);
        carHolder.position.set(0, podIdx === 0 ? 0.14 : 0.11, 0);
        carHolder.rotation.set(0, 0, 0);
        if (this.ringMats[podIdx]) {
          this.ringMats[podIdx].color.set(this.playerConfigs[slotIdx]?.color || '#1e88e5');
        }
        this.slotPodiumAnchors[slotIdx].copy(pod.position);
        this.slotPodiumAnchors[slotIdx].y += (podIdx === 0 ? 1.55 : 1.45);
      }

      this.secondaryPod.visible = true;
      this.thirdPod.visible = true;
      this.fourthPod.visible = true;
      return;
    }

    // Mode Hors-Ligne (Solo, Écran Scindé 2J, Spectateur)
    this.thirdPod.visible = false;
    this.fourthPod.visible = false;

    const mainIdx = this.activePlayer === 1 ? 1 : 0;
    const otherIdx = 1 - mainIdx;

    const mainCar = this.carModels[mainIdx].holder;
    const otherCar = this.carModels[otherIdx].holder;

    this.turntable.add(mainCar);
    mainCar.position.set(0, 0.14, 0);
    mainCar.rotation.set(0, 0, 0);

    this.secondaryPod.add(otherCar);
    otherCar.position.set(0, 0.11, 0);
    otherCar.rotation.set(0, 0, 0);

    this.ringMat.color.set(this.playerConfigs[mainIdx].color);
    if (this.secondaryRingMat) {
      this.secondaryRingMat.color.set(this.playerConfigs[otherIdx].color);
    }
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
   * Configure l'affichage des emplacements 3D du garage.
   */
  setPlayerCount(count, isOnline = this.isOnlineLobby) {
    this.isOnlineLobby = Boolean(isOnline);
    this.secondaryPod.visible = (count === 2 || this.isOnlineLobby);
    this.thirdPod.visible = this.isOnlineLobby;
    this.fourthPod.visible = this.isOnlineLobby;
    if (!this.isOnlineLobby && count <= 1 && this.activePlayer !== 0) {
      this.setActivePlayer(0);
    } else {
      this._layoutCars();
    }
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

    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const tagEl = document.getElementById(tagIds[slotIdx]);
      if (!tagEl) continue;

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
    this.controls.update();
    const activeModel = this.carModels[this.activePlayer]?.model;
    if (activeModel) activeModel.setBoost(false, 0);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.renderer.render(this.scene, this.camera);
    this._updateFloating3DTags();
  }
}
