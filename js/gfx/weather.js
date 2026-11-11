/**
 * weather.js — Système météo dynamique et immersion pluvieuse globale :
 *  - Résolution du mode 'random' au lancement de la session
 *  - Volume de particules dense (boîte englobante de 60m x 40m x 60m) centré en permanence
 *    sur chaque caméra active (Mode Solo et Écran Scindé 2 Viewports)
 *  - Repositionnement continu sur la position X/Y/Z de la caméra avec recyclage vertical
 *    (`wrap around` du plancher bas vers le plafond haut de la boîte) et bouclage X/Z
 *  - Rendu des gouttes sous forme de segments étirés (`THREE.LineSegments`) inclinés selon le vent
 *  - Ambiance mouillée : brouillard exponentiel dense (`THREE.FogExp2(0x22262a, 0.015)`),
 *    assombrissement de la lumière directionnelle et réduction de la `roughness` de l'asphalte
 *    pour simuler les reflets d'une chaussée détrempée.
 */
import * as THREE from 'three';
import { CONFIG, WEATHER_MODIFIERS } from '../config.js?v=41';

const BOX_WIDTH = 60;   // Largeur X du volume centré caméra (m)
const BOX_HEIGHT = 40;  // Hauteur Y du volume centré caméra (m)
const BOX_DEPTH = 60;   // Profondeur Z du volume centré caméra (m)
const DROPS_PER_VOLUME = 1500;
const MAX_VIEWPORTS = 2;

export class WeatherSystem {
  constructor(scene, lights) {
    this.scene = scene;
    this.lights = lights; // { sun, hemi }
    this.requestedWeather = 'sunny';
    this.activeWeather = 'sunny';
    this.windTime = 0;

    this._buildCameraRainVolumes();
  }

  /**
   * Crée un volume dense de gouttes (`THREE.LineSegments`, 60m x 40m x 60m) par caméra active.
   */
  _buildCameraRainVolumes() {
    this.rainGroup = new THREE.Group();
    this.rainGroup.name = 'cameraRainVolumes';
    this.rainGroup.visible = false;
    this.scene.add(this.rainGroup);

    this.rainMat = new THREE.LineBasicMaterial({
      color: 0xd4e8ff,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    });

    this.volumes = [];
    const halfW = BOX_WIDTH * 0.5;
    const halfH = BOX_HEIGHT * 0.5;
    const halfD = BOX_DEPTH * 0.5;

    for (let v = 0; v < MAX_VIEWPORTS; v++) {
      const drops = new Float32Array(DROPS_PER_VOLUME * 3);
      const linePositions = new Float32Array(DROPS_PER_VOLUME * 2 * 3);

      for (let i = 0; i < DROPS_PER_VOLUME; i++) {
        const x = (Math.random() - 0.5) * BOX_WIDTH;
        const y = (Math.random() - 0.5) * BOX_HEIGHT;
        const z = (Math.random() - 0.5) * BOX_DEPTH;

        drops[i * 3] = x;
        drops[i * 3 + 1] = y;
        drops[i * 3 + 2] = z;

        const k = i * 6;
        linePositions[k] = x;
        linePositions[k + 1] = y;
        linePositions[k + 2] = z;
        linePositions[k + 3] = x;
        linePositions[k + 4] = y - 1.1;
        linePositions[k + 5] = z;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

      const mesh = new THREE.LineSegments(geometry, this.rainMat);
      mesh.frustumCulled = false;
      mesh.visible = v === 0;
      this.rainGroup.add(mesh);

      this.volumes.push({
        mesh,
        geometry,
        drops,
        lastCamPos: new THREE.Vector3(),
        initialized: false,
        halfW,
        halfH,
        halfD,
      });
    }
  }

  /**
   * Applique une condition météo ('sunny' | 'rain' | 'storm' | 'random').
   * Active `THREE.FogExp2(0x22262a, 0.015)` et réduit la `roughness` de la piste sous la pluie.
   */
  setWeather(weatherKey = 'sunny', roadMaterials = []) {
    this.requestedWeather = weatherKey;
    if (weatherKey === 'random') {
      const choices = ['sunny', 'rain', 'storm'];
      this.activeWeather = choices[Math.floor(Math.random() * choices.length)];
    } else if (WEATHER_MODIFIERS[weatherKey]) {
      this.activeWeather = weatherKey;
    } else {
      this.activeWeather = 'sunny';
    }

    const cfg = WEATHER_MODIFIERS[this.activeWeather];
    const isWet = this.activeWeather === 'rain' || this.activeWeather === 'storm';

    this.scene.background.setHex(cfg.skyColor);

    if (isWet) {
      // Brouillard exponentiel dense en condition pluvieuse (0x22262a, 0.015)
      const density = cfg.fogExp2Density || 0.015;
      this.scene.fog = new THREE.FogExp2(0x22262a, density);
    } else {
      this.scene.fog = new THREE.Fog(
        cfg.fogColor,
        cfg.fogNear ?? CONFIG.render.fogNear,
        cfg.fogFar ?? CONFIG.render.fogFar
      );
    }

    if (this.lights.sun) this.lights.sun.intensity = cfg.sunIntensity;
    if (this.lights.hemi) this.lights.hemi.intensity = cfg.hemiIntensity;

    for (const mat of roadMaterials) {
      if (mat) {
        mat.roughness = cfg.roadRoughness;
        mat.metalness = cfg.roadMetalness ?? (isWet ? 0.26 : 0.06);
        mat.envMapIntensity = isWet ? 1.65 : 1.0;
        mat.needsUpdate = true;
      }
    }

    this.rainGroup.visible = isWet;
    this.rainMat.opacity = this.activeWeather === 'storm' ? 0.68 : 0.54;

    for (const vol of this.volumes) {
      vol.initialized = false;
    }

    return this.activeWeather;
  }

  /**
   * Sélectionne le volume de pluie correspondant au viewport en cours de rendu
   * (0 = écran principal / joueur 1, 1 = écran droit / joueur 2 en écran scindé).
   */
  prepareForViewport(viewportIndex = 0) {
    if (!this.rainGroup.visible) return;
    for (let i = 0; i < this.volumes.length; i++) {
      this.volumes[i].mesh.visible = (i === viewportIndex);
    }
  }

  /**
   * Met à jour les volumes de particules (60m x 40m x 60m) centrés sur chaque caméra active.
   * Dès qu'une goutte franchit le plancher bas du volume (-20m), sa hauteur est réinitialisée
   * en haut de la boîte (+20m, wrap-around), et les coordonnées X/Z bouclent dans [-30m, +30m].
   *
   * @param {number} dt
   * @param {Array<THREE.Camera|THREE.Vector3>} cameraAnchors
   */
  update(dt, cameraAnchors) {
    if (!this.rainGroup.visible || !cameraAnchors) return;

    const list = Array.isArray(cameraAnchors) ? cameraAnchors : [cameraAnchors];
    if (list.length === 0) return;

    this.windTime += dt;
    const isStorm = this.activeWeather === 'storm';
    const breeze = 0.85 + 0.15 * Math.sin(this.windTime * 1.4);

    // Vecteur vitesse des gouttes (incliné selon le vent)
    const vx = (isStorm ? 8.5 : 2.6) * breeze;
    const vy = isStorm ? -36.0 : -29.0;
    const vz = (isStorm ? -6.2 : -1.8) * breeze;

    // Longueur du segment étiré (THREE.LineSegments) orienté selon le vecteur de chute et de vent
    const streakTime = isStorm ? 0.048 : 0.040;
    const streakDx = vx * streakTime;
    const streakDy = vy * streakTime;
    const streakDz = vz * streakTime;

    const halfW = BOX_WIDTH * 0.5;
    const halfH = BOX_HEIGHT * 0.5;
    const halfD = BOX_DEPTH * 0.5;

    const activeCount = Math.min(list.length, this.volumes.length);
    for (let vIdx = 0; vIdx < activeCount; vIdx++) {
      const anchor = list[vIdx];
      if (!anchor) continue;
      const camPos = anchor.position || anchor;
      const vol = this.volumes[vIdx];

      if (!vol.initialized) {
        vol.lastCamPos.copy(camPos);
        vol.initialized = true;
      }

      // Déplacement de la caméra depuis la frame précédente (pour garder les gouttes ancrées dans l'air)
      const camDx = clampProp(camPos.x - vol.lastCamPos.x, -BOX_WIDTH, BOX_WIDTH);
      const camDy = clampProp(camPos.y - vol.lastCamPos.y, -BOX_HEIGHT, BOX_HEIGHT);
      const camDz = clampProp(camPos.z - vol.lastCamPos.z, -BOX_DEPTH, BOX_DEPTH);
      vol.lastCamPos.copy(camPos);

      // Repositionne la boîte englobante 60m x 40m x 60m exactement sur la caméra active
      vol.mesh.position.set(camPos.x, camPos.y, camPos.z);

      const drops = vol.drops;
      const posAttr = vol.geometry.attributes.position;
      const arr = posAttr.array;

      const stepX = vx * dt - camDx;
      const stepY = vy * dt - camDy;
      const stepZ = vz * dt - camDz;

      for (let i = 0; i < DROPS_PER_VOLUME; i++) {
        const i3 = i * 3;
        let x = drops[i3] + stepX;
        let y = drops[i3 + 1] + stepY;
        let z = drops[i3 + 2] + stepZ;

        // Wrap-around vertical : dès qu'une goutte franchit le plancher bas (-20m), retour en haut (+20m)
        if (y < -halfH) {
          y += BOX_HEIGHT;
          if (y < -halfH) y = halfH - Math.random() * 4;
          x = (Math.random() - 0.5) * BOX_WIDTH;
          z = (Math.random() - 0.5) * BOX_DEPTH;
        } else if (y > halfH) {
          y -= BOX_HEIGHT;
        }

        // Wrap-around horizontal X / Z dans la boîte de 60m x 60m autour de la caméra
        if (x < -halfW) x += BOX_WIDTH;
        else if (x > halfW) x -= BOX_WIDTH;

        if (z < -halfD) z += BOX_DEPTH;
        else if (z > halfD) z -= BOX_DEPTH;

        drops[i3] = x;
        drops[i3 + 1] = y;
        drops[i3 + 2] = z;

        const k = i * 6;
        arr[k] = x;
        arr[k + 1] = y;
        arr[k + 2] = z;
        arr[k + 3] = x - streakDx;
        arr[k + 4] = y - streakDy;
        arr[k + 5] = z - streakDz;
      }

      posAttr.needsUpdate = true;
    }
  }
}

function clampProp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
