/**
 * raceScene.js — Scène principale de course :
 *  - Support des 4 modes :
 *      1. 1 Joueur (Solo plein écran)
 *      2. 2 Joueurs (Écran scindé local)
 *      3. Mode Spectateur (Salon ou Fin de course, 100% plein écran)
 *      4. 2J en Ligne P2P (WebRTC / PeerJS) :
 *         - Chaque joueur dispose de son propre écran 100% plein écran et pilote en ZQSD + Espace/Shift
 *         - Hôte : simulation Cannon-es faisant autorité + diffusion binaire 30 Hz
 *         - Invité : prédiction locale (client-side prediction) + réconciliation et interpolation continue lerp/slerp à 60 FPS
 *  - Pseudos flottants en course au-dessus de tous les véhicules (Joueur 1, Joueur 2, BOT 1..5) dans tous les modes
 *  - Zéro allocation mémoire par frame dans `update(dt)` et `render()`
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG, CONTROLS, BOT_PROFILES, AI_BOT_NAMES, AI_BEHAVIOR_PROFILES, WEATHER_MODIFIERS, MAX_TOTAL_CARS } from '../config.js?v=33';
import { TrackLayout } from '../track/trackLayout.js?v=33';
import { TrackBuilder } from '../track/trackBuilder.js?v=33';
import { BoostTokenSystem } from '../track/boostTokens.js?v=33';
import { Vehicle } from '../physics/vehicle.js?v=33';
import { AIDriver, generateBotAIProfiles } from '../ai/aiDriver.js?v=33';
import { ChaseCamera } from '../gfx/chaseCamera.js?v=33';
import { ParticleSystem } from '../gfx/particles.js?v=33';
import { WeatherSystem } from '../gfx/weather.js?v=33';
import { soundManager } from '../core/audio.js?v=33';
import { HEADER_FLOATS, VEHICLE_FLOATS } from '../net/networkManager.js?v=33';
import { clamp } from '../core/utils.js?v=33';

const _tmpQuatA = new THREE.Quaternion();
const _tmpQuatB = new THREE.Quaternion();
const _tagWorldPos = new THREE.Vector3();
const _netFwd = new THREE.Vector3();
const _netRight = new THREE.Vector3();

export class RaceScene {
  constructor(renderer, envMap, input, hud, callbacks = {}) {
    this.renderer = renderer;
    this.envMap = envMap;
    this.input = input;
    this.hud = hud;
    this.onFinishCallback = callbacks.onFinish || (() => {});
    this.network = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x6ea8df);
    this.scene.environment = this.envMap;
    this.scene.fog = new THREE.Fog(0x8ec2ef, CONFIG.render.fogNear, CONFIG.render.fogFar);

    this._setupLights();

    // Monde physique Cannon-es (SAPBroadphase optimisé pour 7 véhicules simultanés)
    this.world = new CANNON.World();
    this.world.gravity.set(0, -CONFIG.physics.gravity, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = CONFIG.physics.solverIterations;
    this.world.defaultContactMaterial.friction = 0.02;
    this.world.defaultContactMaterial.restitution = 0.15;

    this.materials = this._createPhysicsMaterials();

    // Système météo et particules
    this.weatherSystem = new WeatherSystem(this.scene, {
      sun: this.sunLight,
      hemi: this.hemiLight,
    });
    this.particles = new ParticleSystem(this.scene);

    // Circuit initial & système de jetons (6 boosts + 4 ralentisseurs rouges)
    this.currentCircuitId = 'flat';
    this.layout = new TrackLayout('flat');
    this.track = new TrackBuilder(this.layout, this.scene, this.world, this.materials);
    this.boostTokens = new BoostTokenSystem(this.layout, this.scene);
    this.hud.initMinimap(this.layout);

    // Caméras tierce personne (near = 0.1, far = 1000)
    const halfAspect = (window.innerWidth * 0.5) / Math.max(1, window.innerHeight);
    this.cam1 = new ChaseCamera(halfAspect);
    this.cam2 = new ChaseCamera(halfAspect);

    this.playerCount = 2; // 0 = Spectateur Salon, 1 = Solo, 2 = Écran Scindé ou 2J en Ligne
    this.isOnline = false;
    this.onlineRole = null; // 'host' | 'guest' | null
    this.myOnlineSlot = 0;
    this.playersBySlot = {};
    this.localPlayer = null;
    this.remoteGuestControls = { throttle: 0, brake: 0, steer: 0, boost: false, reset: false };
    this.remoteGuestControlsBySlot = {};

    this.isSpectator = false;
    this.spectatorTarget = null;

    this.activeWeather = 'sunny';
    
    this.vehicles = [];
    this.standings = [];
    this.players = [];
    this.aiDrivers = [];
    this.gridSpawns = [];
    this.lastPlayerConfigs = null;
    this.lastRaceSettings = null;

    // Objets de travail pré-alloués pour éviter toute allocation GC dans update()
    this._envContext = { weather: 'sunny', globalGrip: 1.0 };
    this._activeCameras1 = [this.cam1.camera.position];
    this._activeCameras2 = [this.cam1.camera.position, this.cam2.camera.position];
    this._singleAudioTarget = [null];
    this._spectatorInfoOut = { target: null, canShowResults: false };

    // Étiquettes DOM flottantes des pseudos en course (viewport 0 = plein écran ou moitié gauche, viewport 1 = moitié droite)
    this._nameTagElsVp0 = [];
    this._nameTagElsVp1 = [];

    this.state = 'idle'; // 'countdown' | 'racing' | 'finished'
    this.resultsShownOnce = false;
    this.countdownTimer = 0;
    this.raceTime = 0;
    this.elapsedTime = 0;
    this.physicsAccumulator = 0;
    this.firstPlayerFinishTime = null;
  }

  /** Lie le gestionnaire réseau P2P WebRTC / PeerJS. */
  setNetworkManager(network) {
    this.network = network;
  }

  /** Reçoit côté Hôte les contrôles clavier temps réel (30 Hz) envoyés par un Invité. */
  setRemoteGuestControls(ctrl) {
    if (!ctrl) return;
    const slotIdx = typeof ctrl.slotIndex === 'number' ? ctrl.slotIndex : 1;
    if (!this.remoteGuestControlsBySlot[slotIdx]) {
      this.remoteGuestControlsBySlot[slotIdx] = { throttle: 0, brake: 0, steer: 0, boost: false, reset: false };
    }
    const target = this.remoteGuestControlsBySlot[slotIdx];
    target.throttle = ctrl.throttle || 0;
    target.brake = ctrl.brake || 0;
    target.steer = ctrl.steer || 0;
    target.boost = Boolean(ctrl.boost);
    if (ctrl.reset) target.reset = true;

    this.remoteGuestControls.throttle = ctrl.throttle || 0;
    this.remoteGuestControls.brake = ctrl.brake || 0;
    this.remoteGuestControls.steer = ctrl.steer || 0;
    this.remoteGuestControls.boost = Boolean(ctrl.boost);
    if (ctrl.reset) this.remoteGuestControls.reset = true;
  }

  /** Applique un événement clé fiable/ordonné reçu via le DataChannel de contrôle. */
  applyRaceEvent(msg) {
    if (!this.isOnline || !msg || !msg.event) return;
    if (msg.event === 'RACE_GO' && this.state === 'countdown') {
      this.state = 'racing';
      this.countdownTimer = 0;
      this.track.setStartLights('go');
      this.hud.setCountdown('PARTEZ !', true);
      soundManager.playCountdownBeep(true);
    } else if (msg.event === 'LAP_OR_FINISH') {
      const v = this.playersBySlot ? this.playersBySlot[msg.slotIndex] : null;
      if (v && v !== this.localPlayer) {
        if (typeof msg.lap === 'number' && msg.lap > v.lap) {
          v.lap = msg.lap;
        }
        if (msg.finished && !v.finished) {
          v.finished = true;
          v.finishTime = msg.finishTime || this.raceTime;
          v.finishCrossingPos.copy(v.chassisBody.position);
          this._updateStandings();
        }
      }
    }
  }

  /**
   * Gestion propre des déconnexions en pleine course :
   * La voiture du joueur déconnecté est immédiatement reprise par un bot IA sans interrompre la course.
   */
  handlePlayerDisconnect(slotIndex, playerName = '') {
    if (!this.isOnline) return;
    const v = this.playersBySlot ? this.playersBySlot[slotIndex] : null;
    if (!v || v === this.localPlayer || v.isAI) return;

    v.isAI = true;
    v.isNetDriven = false;
    v.hasNetTarget = false;
    const baseName = v.shortTag || playerName || 'PILOTE';
    const botLabel = baseName.includes('(BOT)') ? baseName : `${baseName} (BOT)`;
    v.shortTag = botLabel;
    v.displayTag = botLabel;
    this._initRaceNameTagElements();

    if (this.onlineRole === 'host') {
      const diffKey = CONFIG.race.difficulty || 'normal';
      const diffCfg = CONFIG.difficulty[diffKey] || CONFIG.difficulty.normal;
      const ai = new AIDriver(v, this.layout, {
        difficultyKey: diffKey,
        skill: diffCfg.skill || 0.9,
        behaviorKey: 'balanced',
        speedDelta: 0,
        preferredOffset: 0,
      });
      this.aiDrivers.push(ai);
    }
  }

  applyGuestNetworkInput(ctrl) {
    this.setRemoteGuestControls(ctrl);
  }

  _setupLights() {
    this.hemiLight = new THREE.HemisphereLight(0xd6ecff, 0x3b4d2b, 1.05);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff6e5, 1.95);
    this.sunLight.position.set(140, 220, 90);
    this.sunLight.castShadow = false;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 260;
    const dShadow = 55;
    this.sunLight.shadow.camera.left = -dShadow;
    this.sunLight.shadow.camera.right = dShadow;
    this.sunLight.shadow.camera.top = dShadow;
    this.sunLight.shadow.camera.bottom = -dShadow;
    this.scene.add(this.sunLight);

    const backLight = new THREE.DirectionalLight(0x90caf9, 0.55);
    backLight.position.set(-120, 90, -140);
    this.scene.add(backLight);
  }

  _createPhysicsMaterials() {
    const groundMat = new CANNON.Material('ground');
    const chassisMat = new CANNON.Material('chassis');
    const barrierMat = new CANNON.Material('barrier');

    this.world.addContactMaterial(new CANNON.ContactMaterial(chassisMat, barrierMat, {
      friction: 0.015,
      restitution: 0.25,
    }));

    this.world.addContactMaterial(new CANNON.ContactMaterial(chassisMat, chassisMat, {
      friction: 0.04,
      restitution: 0.35,
    }));

    this.world.addContactMaterial(new CANNON.ContactMaterial(chassisMat, groundMat, {
      friction: 0.12,
      restitution: 0.0,
    }));

    return { groundMat, chassisMat, barrierMat };
  }

  /** Change ou reconstruit le circuit si l'utilisateur a choisi un autre tracé. */
  _ensureCircuit(circuitId = 'flat') {
    if (this.currentCircuitId === circuitId && this.track) return;
    this._clearVehicles();
    if (this.track) this.track.dispose();
    this.currentCircuitId = circuitId;
    this.layout = new TrackLayout(circuitId);
    this.track = new TrackBuilder(this.layout, this.scene, this.world, this.materials);
    if (this.boostTokens) this.boostTokens.setLayout(this.layout);
    this.hud.initMinimap(this.layout);
  }

  /**
   * Démarre une course avec les configurations des joueurs et les paramètres du salon.
   * Supporte jusqu'à 7 véhicules sur la grille en quinconce (2 joueurs + 5 bots).
   */
  startRace(playerConfigs, raceSettings = {}) {
    this.lastPlayerConfigs = playerConfigs.map((c) => ({ ...c }));
    this.lastRaceSettings = { ...raceSettings };

    let circuitId = raceSettings.circuit || CONFIG.race.circuit || 'flat';
    if (circuitId === 'random') {
      const circuits = ['flat', 'mountain', 'valley', 'lake', 'grotto'];
      circuitId = circuits[Math.floor(Math.random() * circuits.length)];
    }
    this._ensureCircuit(circuitId);
    this._clearVehicles();

    this.isOnline = Boolean(raceSettings.isOnline);
    this.onlineRole = this.isOnline ? (raceSettings.onlineRole || 'host') : null;
    this.myOnlineSlot = this.isOnline
      ? Number(raceSettings.myOnlineSlot ?? (this.onlineRole === 'guest' ? 1 : 0))
      : 0;
    this.playersBySlot = {};
    this.remoteGuestControlsBySlot = {};
    this.remoteGuestControls.throttle = 0;
    this.remoteGuestControls.brake = 0;
    this.remoteGuestControls.steer = 0;
    this.remoteGuestControls.boost = false;
    this.remoteGuestControls.reset = false;

    const onlineHumanSlots = (this.isOnline && Array.isArray(raceSettings.humanSlots) && raceSettings.humanSlots.length >= 1)
      ? raceSettings.humanSlots
      : null;

    const rawMode = this.isOnline
      ? (onlineHumanSlots ? onlineHumanSlots.length : 1)
      : Number(raceSettings.playerCount ?? CONFIG.race.playerCount);
    const playerCount = this.isOnline
      ? Math.min(4, Math.max(1, rawMode))
      : ((rawMode === 0 || rawMode === 1) ? rawMode : 2);
    const laps = Number(raceSettings.laps ?? CONFIG.race.laps);
    const numBots = Number(raceSettings.bots ?? CONFIG.race.bots);
    const diffKey = raceSettings.difficulty ?? CONFIG.race.difficulty ?? 'normal';
    const diffCfg = CONFIG.difficulty[diffKey] || CONFIG.difficulty.normal;
    const skill = diffCfg.skill;

    this.playerCount = playerCount;
    this.isSpectator = (playerCount === 0);
    CONFIG.race.playerCount = playerCount;
    CONFIG.race.laps = laps;
    CONFIG.race.circuit = circuitId;
    CONFIG.race.weather = raceSettings.weather || 'sunny';
    CONFIG.race.difficulty = diffKey;

    const maxTotalCars = CONFIG.race.maxTotalCars || MAX_TOTAL_CARS || 10;
    const minBots = playerCount === 0 ? 2 : 0;
    const maxBotsAllowed = Math.max(0, maxTotalCars - playerCount);
    const botCount = Math.min(maxBotsAllowed, Math.max(minBots, numBots));

    let botAIProfiles = Array.isArray(raceSettings.botAIProfiles) && raceSettings.botAIProfiles.length === botCount
      ? raceSettings.botAIProfiles.map((p) => ({ ...p }))
      : null;

    if (!botAIProfiles && botCount > 0) {
      botAIProfiles = generateBotAIProfiles(botCount, diffKey);
      this.lastRaceSettings.botAIProfiles = botAIProfiles.map((p) => ({ ...p }));
    }

    // Attribution aléatoire de pseudonymes uniques et distinctifs depuis le pool de noms réalistes
    let botNamesPool = Array.isArray(raceSettings.botNames) && raceSettings.botNames.length === botCount
      ? [...raceSettings.botNames]
      : null;

    if (!botNamesPool) {
      const candidates = [...(AI_BOT_NAMES || ['Vortex', 'Falcon', 'Apex', 'Phantom', 'Spectre', 'Titan', 'Pulse', 'Nova', 'Zephyr', 'Cobalt'])];
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      botNamesPool = candidates.slice(0, botCount);
      this.lastRaceSettings.botNames = [...botNamesPool];
    }

    const gridEntries = [];
    for (let b = 0; b < botCount; b++) {
      const aiProfile = botAIProfiles ? botAIProfiles[b] : null;
      gridEntries.push({
        type: 'bot',
        botIdx: b,
        assignedName: botNamesPool[b] || `BOT ${b + 1}`,
        behaviorKey: aiProfile?.behaviorKey || 'balanced',
        speedDelta: aiProfile?.speedDelta || 0,
        aiProfile,
      });
    }
    if (this.isOnline && onlineHumanSlots) {
      onlineHumanSlots.forEach((hs, idx) => {
        const sIdx = typeof hs.slotIndex === 'number' ? hs.slotIndex : idx;
        const baseCfg = hs.carConfig || this.lastPlayerConfigs[sIdx] || this.lastPlayerConfigs[0];
        gridEntries.push({
          type: 'player',
          playerIdx: idx,
          onlineSlotIndex: sIdx,
          cfg: { ...baseCfg, name: hs.name || baseCfg?.name || `PILOTE ${sIdx + 1}` },
        });
      });
    } else {
      if (this.playerCount >= 1) {
        gridEntries.push({ type: 'player', playerIdx: 0, onlineSlotIndex: 0, cfg: this.lastPlayerConfigs[0] });
      }
      if (this.playerCount >= 2) {
        gridEntries.push({ type: 'player', playerIdx: 1, onlineSlotIndex: 1, cfg: this.lastPlayerConfigs[1] });
      }
    }

    this.gridSpawns = [];

    gridEntries.forEach((entry, slotIndex) => {
      const spawn = this.track.getStartTransform(slotIndex);
      this.gridSpawns.push(spawn);

      if (entry.type === 'player') {
        const pIdx = entry.playerIdx;
        const onlineSlot = typeof entry.onlineSlotIndex === 'number' ? entry.onlineSlotIndex : pIdx;
        const defaultTag = `JOUEUR ${onlineSlot + 1}`;
        const rawName = (entry.cfg?.name || defaultTag).trim();
        const displayTag = rawName && rawName !== 'HÔTE' && rawName !== 'INVITÉ'
          ? rawName
          : (this.isOnline ? rawName : defaultTag);
        const v = new Vehicle({
          id: `p${onlineSlot + 1}`,
          name: displayTag,
          displayTag,
          shortTag: displayTag,
          isAI: false,
          carConfig: entry.cfg,
          scene: this.scene,
          world: this.world,
          chassisMat: this.materials.chassisMat,
          layout: this.layout,
          envMap: this.envMap,
        });
        v.totalLaps = laps;
        v.onlineSlotIndex = onlineSlot;
        v._lastSyncedLap = 1;
        v._lastSyncedFinished = false;
        v.netTargetPos = new THREE.Vector3();
        v.netTargetQuat = new THREE.Quaternion();
        v.netVel = new THREE.Vector3();
        v.netTargetSpeed = 0;
        v.hasNetTarget = false;
        v.isNetDriven = false;
        this.players[pIdx] = v;
        this.playersBySlot[onlineSlot] = v;
        this.vehicles.push(v);
      } else {
        const botName = entry.assignedName || `BOT ${entry.botIdx + 1}`;
        const profile = {
          ...(BOT_PROFILES[entry.botIdx % BOT_PROFILES.length] || BOT_PROFILES[0]),
          name: botName,
        };
        const shortTag = botName.toUpperCase();
        const displayTag = botName.toUpperCase();
        const v = new Vehicle({
          id: `bot_${entry.botIdx + 1}`,
          name: botName,
          displayTag,
          shortTag,
          isAI: true,
          carConfig: profile,
          scene: this.scene,
          world: this.world,
          chassisMat: this.materials.chassisMat,
          layout: this.layout,
          envMap: this.envMap,
        });
        v.totalLaps = laps;
        v.netTargetPos = new THREE.Vector3();
        v.netTargetQuat = new THREE.Quaternion();
        v.netVel = new THREE.Vector3();
        v.netTargetSpeed = 0;
        v.hasNetTarget = false;
        v.isNetDriven = false;
        this.vehicles.push(v);

        const ai = new AIDriver(v, this.layout, {
          difficultyKey: diffKey,
          skill,
          behaviorKey: entry.behaviorKey,
          speedDelta: entry.speedDelta || 0,
          preferredOffset: entry.aiProfile?.preferredOffset ?? ((entry.botIdx % 2 === 0 ? -1 : 1) * 1.1),
          aiProfile: entry.aiProfile,
        });
        this.aiDrivers.push(ai);
      }
    });

    if (this.isOnline) {
      this.localPlayer = this.playersBySlot[this.myOnlineSlot] || (this.onlineRole === 'guest' ? this.players[1] : this.players[0]);
    } else {
      this.localPlayer = null;
    }

    this.standings = [...this.vehicles];
    this._initRaceNameTagElements();
    this.resetRace(raceSettings.tokenLayout || null);
  }

  /**
   * Initialise les étiquettes DOM flottantes des pseudos au-dessus de tous les véhicules (Joueur 1, Joueur 2, BOT 1..5).
   */
  _initRaceNameTagElements() {
    const vp0 = document.getElementById('race-nametags-vp0');
    const vp1 = document.getElementById('race-nametags-vp1');
    if (!vp0 || !vp1) return;

    vp0.innerHTML = '';
    vp1.innerHTML = '';
    this._nameTagElsVp0 = [];
    this._nameTagElsVp1 = [];

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const label = v.shortTag || v.displayTag || v.name;

      const el0 = document.createElement('div');
      el0.className = `race-car-nametag ${v.isAI ? 'is-bot' : 'is-player'}`;
      el0.textContent = label;
      vp0.appendChild(el0);
      this._nameTagElsVp0.push(el0);

      const el1 = document.createElement('div');
      el1.className = `race-car-nametag ${v.isAI ? 'is-bot' : 'is-player'}`;
      el1.textContent = label;
      vp1.appendChild(el1);
      this._nameTagElsVp1.push(el1);
    }
  }

  /**
   * Projette les coordonnées 3D `(pos.x, pos.y + 1.0, pos.z)` de chaque véhicule vers l'écran 2D
   * (en plein écran ou par viewport gauche/droite en écran scindé).
   */
  _updateRaceNameTags() {
    const vp0 = document.getElementById('race-nametags-vp0');
    const vp1 = document.getElementById('race-nametags-vp1');
    if (!vp0 || !vp1 || this._nameTagElsVp0.length !== this.vehicles.length) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const isSplit = !this.isOnline && !this.isSpectator && this.playerCount === 2;

    vp0.classList.toggle('split-vp-left', isSplit);
    vp1.classList.toggle('hidden', !isSplit);
    vp1.classList.toggle('split-vp-right', isSplit);

    if (!isSplit) {
      this._projectTagsForViewport(this.cam1.camera, this._nameTagElsVp0, w, h, false);
    } else {
      const halfW = Math.floor(w * 0.5);
      const rightW = w - halfW;
      this._projectTagsForViewport(this.cam1.camera, this._nameTagElsVp0, halfW, h, true);
      this._projectTagsForViewport(this.cam2.camera, this._nameTagElsVp1, rightW, h, true);
    }
  }

  _projectTagsForViewport(camera, tagElements, vpWidth, vpHeight, isCompactSplit) {
    camera.updateMatrixWorld();
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const el = tagElements[i];
      if (!v || !el) continue;

      const pos = v.renderPosition;
      const dx = pos.x - camera.position.x;
      const dy = pos.y - camera.position.y;
      const dz = pos.z - camera.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      // Masque les étiquettes trop éloignées (> 185m)
      if (distSq > 185 * 185) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }

      // Pseudo abaissé légèrement au-dessus du toit (0.72 m pour le joueur, toit à ~0.56 m)
      // afin de dégager la vue vers l'avant sans toucher la carrosserie de la voiture
      const tagHeightOffset = v.isAI ? 0.84 : 0.72;
      _tagWorldPos.set(pos.x, pos.y + tagHeightOffset, pos.z);
      _tagWorldPos.project(camera);

      if (_tagWorldPos.z < -1 || _tagWorldPos.z > 1) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }

      const sx = (_tagWorldPos.x * 0.5 + 0.5) * vpWidth;
      const sy = (-_tagWorldPos.y * 0.5 + 0.5) * vpHeight;

      if (sx < -40 || sx > vpWidth + 40 || sy < -20 || sy > vpHeight + 20) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }

      if (el.style.display !== 'block') el.style.display = 'block';
      el.classList.toggle('compact-split', isCompactSplit);
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  /**
   * Réinitialise intégralement la course.
   */
  resetRace(providedTokenLayout = null) {
    if (this.vehicles.length === 0 && this.lastPlayerConfigs) {
      this.startRace(this.lastPlayerConfigs, this.lastRaceSettings || {});
      return;
    }

    const laps = CONFIG.race.laps;

    const requestedWeather = this.lastRaceSettings?.weather || CONFIG.race.weather || 'sunny';
    this.activeWeather = this.weatherSystem.setWeather(requestedWeather, this.track.roadMaterials);
    const weatherLabel = WEATHER_MODIFIERS[this.activeWeather]?.label || 'Ensoleillé';

    if (this.world.contacts) this.world.contacts.length = 0;
    if (this.world.frictionEquations) this.world.frictionEquations.length = 0;

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const spawn = this.gridSpawns[i] || this.track.getStartTransform(i);
      v.totalLaps = laps;
      v.setSpawn(spawn.position, spawn.forward, true, 0);
      if (v.netTargetPos) v.netTargetPos.copy(spawn.position);
      if (v.netTargetQuat) v.netTargetQuat.copy(v.renderQuaternion);
      if (v.netVel) v.netVel.set(0, 0, 0);
      v.netTargetSpeed = 0;
      v.hasNetTarget = false;
      v.isNetDriven = false;
    }

    for (const ai of this.aiDrivers) {
      ai.reset();
    }

    if (this.boostTokens) {
      if (providedTokenLayout) {
        this.boostTokens.applyTokenLayout(providedTokenLayout);
      } else {
        this.boostTokens.randomizeForRace();
      }
    }

    const engineSound = this.lastRaceSettings?.engineSound || CONFIG.race.engineSound || 'thermal';
    soundManager.setEngineSoundMode(engineSound);

    this.isSpectator = (this.playerCount === 0);
    this.resultsShownOnce = false;
    this._updateStandings();

    this.spectatorTarget = this.standings[0] || this.vehicles[0] || null;

    this.onResize(window.innerWidth, window.innerHeight);
    if (this.isSpectator && this.spectatorTarget) {
      this.cam1.snap(this.spectatorTarget);
    } else if (this.isOnline && this.localPlayer) {
      this.cam1.snap(this.localPlayer);
    } else {
      if (this.players[0]) this.cam1.snap(this.players[0]);
      if (this.playerCount === 2 && this.players[1]) this.cam2.snap(this.players[1]);
    }

    const hudModeCount = this.isOnline ? 1 : this.playerCount;
    this.hud.setPlayerCount(hudModeCount, this.isSpectator);
    this.hud.setEnvironmentBadge(weatherLabel);
    this.hud.resetForNewRace(laps);

    this.state = 'countdown';
    this.countdownTimer = 3.6;
    this._lastCountdownBeepSec = null;
    this.raceTime = 0;
    this.physicsAccumulator = 0;
    this.firstPlayerFinishTime = null;
    this.track.setStartLights(0);
    const windVec = WEATHER_MODIFIERS[this.activeWeather]?.windForce || null;
    this.hud.update(this.players, this.vehicles, 0, this._getSpectatorInfo(), this.localPlayer, this.activeWeather, windVec);
    this._updateRaceNameTags();
  }

  /**
   * Applique côté Invité un paquet binaire 30 Hz reçu de l'Hôte :
   *  - Ne déclenche AUCUN rendu asynchrone hors de `requestAnimationFrame`
   *  - Stocke les cibles `[posX, posY, posZ, quatX, quatY, quatZ, quatW, speed, boostActive]`
   *    pour interpolation continue (`lerp` / `slerp`) à 60 FPS dans `update(dt)`
   */
  /**
   * Côté Hôte : reçoit l'état physique 45 Hz de la voiture Invité (p2).
   * Garantit une synchronisation fluide par Dead-Reckoning sans latence côté Invité.
   */
  applyGuestState(st) {
    if (!this.isOnline || this.onlineRole !== 'host' || !st) return;
    const slotIdx = typeof st.slotIndex === 'number' ? st.slotIndex : 1;
    const v = (this.playersBySlot && this.playersBySlot[slotIdx]) ? this.playersBySlot[slotIdx] : this.players[1];
    if (!v || v.isAI) return;

    if (st.pickedTokenIdx >= 0 && this.boostTokens) {
      this.boostTokens.deactivateTokenFromNetwork(st.pickedTokenIdx);
    }

    const {
      px, py, pz, qx, qy, qz, qw,
      forwardSpeed, steerAngle, boostEnergy,
      flags, slowdownTimer, lap, progOrFinish, lateralSpeed,
    } = st;

    v.isNetDriven = true;
    v.netTargetPos.set(px, py, pz);
    v.netTargetQuat.set(qx, qy, qz, qw);
    v.netTargetSpeed = forwardSpeed;

    _netFwd.set(0, 0, -1).applyQuaternion(v.netTargetQuat);
    _netRight.set(1, 0, 0).applyQuaternion(v.netTargetQuat);
    const latSpd = lateralSpeed || 0;
    v.netVel.set(
      _netFwd.x * forwardSpeed + _netRight.x * latSpd,
      _netFwd.y * forwardSpeed + _netRight.y * latSpd,
      _netFwd.z * forwardSpeed + _netRight.z * latSpd
    );

    v.forwardSpeed = forwardSpeed;
    v.lateralSpeed = latSpd;
    v.speedKmh = Math.abs(forwardSpeed) * 3.6;
    v.steerAngle = steerAngle;
    v.boostEnergy = boostEnergy;
    v.slowdownTimer = slowdownTimer;
    v.lap = lap;
    v.isBoosting = Boolean(flags & 1);
    v.isDrifting = Boolean(flags & 2);
    v.isWrongWay = Boolean(flags & 8);
    v.parkingLocked = Boolean(flags & 16);

    const isFinished = Boolean(flags & 4);
    if (isFinished) {
      if (!v.finished) {
        v.finished = true;
        v.finishCrossingPos.set(px, py, pz);
      }
      v.finishTime = progOrFinish;
    } else {
      v.finished = false;
      v.raceProgress = progOrFinish;
    }

    const notifCode = (flags >> 5) & 3;
    if (notifCode > 0 && v.hudNotificationTimer <= 0.05) {
      const type = notifCode === 2 ? 'super' : notifCode === 3 ? 'slowdown' : 'boost';
      const text = notifCode === 2
        ? 'SUPER BOOST +40%'
        : notifCode === 3
          ? 'RALENTISSEMENT -25%'
          : 'BOOST +25%';
      v.triggerHudNotification(text, type, 1.5);
    }

    if (!v.hasNetTarget) {
      v.hasNetTarget = true;
      v.prevPhysicsPos.set(px, py, pz);
      v.currPhysicsPos.set(px, py, pz);
      v.prevPhysicsQuat.set(qx, qy, qz, qw);
      v.currPhysicsQuat.set(qx, qy, qz, qw);
    }
  }

  /**
   * Applique côté Invité un paquet binaire 45 Hz reçu de l'Hôte :
   *  - La voiture locale de l'Invité (`this.localPlayer`) reste 100% sous autorité locale
   *    (0 ms de latence d'entrée, zéro rubber-banding, zéro saccade caméra).
   *  - Les voitures distantes (Hôte + Bots IA) sont extrapolées par vecteur vitesse (Dead-Reckoning)
   *    et interpolées (`lerp` / `slerp`) à 60+ FPS.
   */
  applyHostSnapshot(view) {
    if (!this.isOnline || this.onlineRole !== 'guest' || this.vehicles.length === 0) return;

    const stateCode = Math.round(view[2]);
    this.countdownTimer = view[3];
    this.raceTime = view[4];
    const tokenMask = Math.round(view[5]);
    const count = Math.min(this.vehicles.length, Math.round(view[6]));

    if (stateCode === 1 && this.state !== 'countdown') {
      this.state = 'countdown';
    } else if (stateCode === 2 && this.state === 'countdown') {
      this.state = 'racing';
      this.track.setStartLights('go');
      this.hud.setCountdown('PARTEZ !', true);
      soundManager.playCountdownBeep(true);
    } else if (stateCode === 3 && this.state === 'racing' && this.localPlayer?.finished) {
      this.state = 'finished';
    }

    if (this.boostTokens) {
      this.boostTokens.applyNetworkMask(tokenMask);
    }

    for (let i = 0; i < count; i++) {
      const v = this.vehicles[i];
      if (!v) continue;
      const base = HEADER_FLOATS + i * VEHICLE_FLOATS;

      const px = view[base + 0];
      const py = view[base + 1];
      const pz = view[base + 2];
      const qx = view[base + 3];
      const qy = view[base + 4];
      const qz = view[base + 5];
      const qw = view[base + 6];
      const fwdSpeed = view[base + 7];
      const boostActive = view[base + 8] > 0.5;
      const steerAngle = view[base + 9];
      const boostEnergy = view[base + 10];
      const flags = Math.round(view[base + 11]);
      const slowdownTimer = view[base + 12];
      const lap = Math.round(view[base + 13]);
      const rank = Math.round(view[base + 14]);
      const progOrFinish = view[base + 15];

      v.rank = rank;

      // Le véhicule local de l'Invité (p2) est simulé localement à 60 Hz sans écrasement réseau
      if (v === this.localPlayer) {
        continue;
      }

      v.isNetDriven = true;
      v.boostEnergy = boostEnergy;
      v.slowdownTimer = slowdownTimer;
      v.lap = lap;

      const isFinished = Boolean(flags & 4);
      if (isFinished) {
        if (!v.finished) {
          v.finished = true;
          v.finishCrossingPos.set(px, py, pz);
        }
        v.finishTime = progOrFinish;
      } else {
        v.finished = false;
        v.raceProgress = progOrFinish;
      }

      const notifCode = (flags >> 5) & 3;
      if (notifCode > 0 && v.hudNotificationTimer <= 0.05) {
        const type = notifCode === 2 ? 'super' : notifCode === 3 ? 'slowdown' : 'boost';
        const text = notifCode === 2
          ? 'SUPER BOOST +40%'
          : notifCode === 3
            ? 'RALENTISSEMENT -25%'
            : 'BOOST +25%';
        v.triggerHudNotification(text, type, 1.5);
      }

      v.netTargetPos.set(px, py, pz);
      v.netTargetQuat.set(qx, qy, qz, qw);
      v.netTargetSpeed = fwdSpeed;

      _netFwd.set(0, 0, -1).applyQuaternion(v.netTargetQuat);
      v.netVel.set(_netFwd.x * fwdSpeed, _netFwd.y * fwdSpeed, _netFwd.z * fwdSpeed);

      v.forwardSpeed = fwdSpeed;
      v.speedKmh = Math.abs(fwdSpeed) * 3.6;
      v.steerAngle = steerAngle;
      v.isBoosting = boostActive;
      v.isDrifting = Boolean(flags & 2);
      v.isWrongWay = Boolean(flags & 8);
      v.parkingLocked = Boolean(flags & 16);

      if (!v.hasNetTarget) {
        v.hasNetTarget = true;
        v.prevPhysicsPos.set(px, py, pz);
        v.currPhysicsPos.set(px, py, pz);
        v.prevPhysicsQuat.set(qx, qy, qz, qw);
        v.currPhysicsQuat.set(qx, qy, qz, qw);
      }
    }
  }

  /**
   * Extrapolation continue par vecteur vitesse 3D (Dead-Reckoning) + lissage exponentiel
   * pour un véhicule piloté par le réseau (supprime les saccades 30/45 Hz et le bug de gravité).
   */
  _interpolateRemoteVehicle(v, dt, canDrive) {
    if (!v || !v.hasNetTarget) return;

    if (canDrive && !v.parkingLocked && Math.abs(v.forwardSpeed) > 0.08) {
      v.netTargetPos.x += v.netVel.x * dt;
      v.netTargetPos.y += v.netVel.y * dt;
      v.netTargetPos.z += v.netVel.z * dt;
    }

    const interpFactor = 1.0 - Math.exp(-22.0 * dt);
    v.currPhysicsPos.lerp(v.netTargetPos, interpFactor);
    v.prevPhysicsPos.copy(v.currPhysicsPos);

    v.currPhysicsQuat.slerp(v.netTargetQuat, interpFactor);
    v.prevPhysicsQuat.copy(v.currPhysicsQuat);

    const body = v.chassisBody;
    body.position.set(v.currPhysicsPos.x, v.currPhysicsPos.y, v.currPhysicsPos.z);
    body.quaternion.set(v.currPhysicsQuat.x, v.currPhysicsQuat.y, v.currPhysicsQuat.z, v.currPhysicsQuat.w);
    body.velocity.set(v.netVel.x, v.netVel.y, v.netVel.z);
    body.angularVelocity.set(0, 0, 0);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);

    const proj = this.layout.project(v.currPhysicsPos.x, v.currPhysicsPos.z, v.trackIndex, v.currPhysicsPos.y, v._projOut);
    v.trackIndex = proj.index;
    v.trackS = proj.s;
    v.trackLateral = proj.lateral;
    v.trackY = proj.y || 0;
    v.trackSlope = proj.slope || 0;
    v.model.setBraking(false);
    v.model.setBoost(v.isBoosting);
  }

  /**
   * Bascule la scène en Mode Spectateur plein écran (100% largeur / 100% hauteur).
   */
  enterSpectatorMode() {
    this._updateStandings();
    this.isSpectator = true;
    this.spectatorTarget = this.standings[0] || this.vehicles[0] || null;

    this.hud.setPlayerCount(this.playerCount, true);
    this.onResize(window.innerWidth, window.innerHeight);
    if (this.spectatorTarget) {
      this.cam1.snap(this.spectatorTarget);
    }
    const windVec = WEATHER_MODIFIERS[this.activeWeather]?.windForce || null;
    this.hud.update(this.players, this.vehicles, this.raceTime, this._getSpectatorInfo(), this.localPlayer, this.activeWeather, windVec);
  }

  /**
   * Change la voiture suivie par la caméra spectateur.
   */
  cycleSpectatorTarget(dir = 1) {
    const list = this.standings && this.standings.length > 0 ? this.standings : this.vehicles;
    if (!list || list.length === 0) return;

    const currentIdx = list.indexOf(this.spectatorTarget);
    const nextIdx = ((currentIdx < 0 ? 0 : currentIdx) + dir + list.length) % list.length;
    this.spectatorTarget = list[nextIdx];
  }

  _getSpectatorInfo() {
    if (!this.isSpectator) return null;
    if (!this.spectatorTarget || !this.vehicles.includes(this.spectatorTarget)) {
      this.spectatorTarget = this.standings[0] || this.vehicles[0] || null;
    }
    this._spectatorInfoOut.target = this.spectatorTarget;
    this._spectatorInfoOut.canShowResults = this.resultsShownOnce || this.state === 'finished';
    return this._spectatorInfoOut;
  }

  _clearVehicles() {
    for (const v of this.vehicles) v.dispose();
    this.vehicles.length = 0;
    this.standings.length = 0;
    this.players.length = 0;
    this.playersBySlot = {};
    this.aiDrivers.length = 0;
    this.gridSpawns.length = 0;
    this._nameTagElsVp0.length = 0;
    this._nameTagElsVp1.length = 0;
    this.spectatorTarget = null;
    this.localPlayer = null;
  }

  onResize(width, height) {
    const h = Math.max(1, height);
    if (this.isOnline || this.isSpectator || this.playerCount <= 1) {
      this.cam1.setAspect(width / h);
    } else {
      const halfAspect = (width * 0.5) / h;
      this.cam1.setAspect(halfAspect);
      this.cam2.setAspect(halfAspect);
    }
  }

  /**
   * Boucle de mise à jour temps réel (exécutée exclusivement dans `requestAnimationFrame`).
   */
  update(dt) {
    this.elapsedTime += dt;
    this.track.update(this.elapsedTime);

    if (this.state === 'countdown') {
      this.countdownTimer -= dt;
      const elapsed = 3.6 - this.countdownTimer;
      if (this.countdownTimer > 0) {
        const lightsOn = Math.min(5, Math.max(1, Math.ceil((elapsed / 3.0) * 5)));
        this.track.setStartLights(lightsOn);
        const sec = Math.min(3, Math.ceil(this.countdownTimer));
        if (sec !== this._lastCountdownBeepSec) {
          this._lastCountdownBeepSec = sec;
          soundManager.playCountdownBeep(false);
        }
        this.hud.setCountdown(String(sec), false);
      } else {
        this.state = 'racing';
        this.track.setStartLights('go');
        this.hud.setCountdown('PARTEZ !', true);
        soundManager.playCountdownBeep(true);
        if (this.isOnline && this.onlineRole === 'host' && this.network) {
          this.network.sendRaceEvent({ event: 'RACE_GO', raceTime: 0 });
        }
      }
    } else if (this.state === 'racing' || this.state === 'finished') {
      this.raceTime += dt;
      if (this.raceTime > 1.1) this.hud.hideCountdown();
    }

    const canDrive = (this.state === 'racing' || this.state === 'finished');

    if (this.isSpectator) {
      if (this.input.wasPressed(CONTROLS.spectator.prev)) {
        this.cycleSpectatorTarget(-1);
      } else if (this.input.wasPressed(CONTROLS.spectator.next)) {
        this.cycleSpectatorTarget(1);
      }
    }

    // 1) Lecture des contrôles des joueurs (Local ou En Ligne P2P)
    if (this.isOnline) {
      const localCtrl = this.input.getPlayerControls('p1');
      if (this.localPlayer) {
        if (!this.localPlayer.finished && !this.isSpectator) {
          this.localPlayer.controls = localCtrl;
        } else {
          this._applyFinishedCruise(this.localPlayer);
        }
      }
      if (this.onlineRole === 'host') {
        for (let i = 0; i < this.players.length; i++) {
          const p = this.players[i];
          if (!p || p === this.localPlayer || p.isAI || p.isNetDriven) continue;
          const slotCtrl = this.remoteGuestControlsBySlot[p.onlineSlotIndex] || this.remoteGuestControls;
          if (!p.finished && slotCtrl) {
            p.controls.throttle = slotCtrl.throttle || 0;
            p.controls.brake = slotCtrl.brake || 0;
            p.controls.steer = slotCtrl.steer || 0;
            p.controls.boost = Boolean(slotCtrl.boost);
            p.controls.reset = Boolean(slotCtrl.reset);
            slotCtrl.reset = false;
          } else {
            this._applyFinishedCruise(p);
          }
        }
      }
    } else if (!this.isSpectator) {
      if (this.players[0]) {
        if (!this.players[0].finished) {
          this.players[0].controls = this.input.getPlayerControls('p1');
        } else {
          this._applyFinishedCruise(this.players[0]);
        }
      }
      if (this.playerCount === 2 && this.players[1]) {
        if (!this.players[1].finished) {
          this.players[1].controls = this.input.getPlayerControls('p2');
        } else {
          this._applyFinishedCruise(this.players[1]);
        }
      }
    } else {
      for (let i = 0; i < this.players.length; i++) {
        if (this.players[i]) this._applyFinishedCruise(this.players[i]);
      }
    }

    // 2) Boucle de simulation physique à pas fixe (1/60s)
    const FIXED_TIME_STEP = 1 / 60;
    this.physicsAccumulator = Math.min(this.physicsAccumulator + dt, FIXED_TIME_STEP * 5);

    this._envContext.weather = this.activeWeather;
    
    if (this.isOnline && this.onlineRole === 'guest') {
      // Côté Invité :
      // - Simulation physique 100% locale sur sa propre voiture (players[1]) : 0 ms de latence, zéro rubber-banding
      // - Extrapolation Dead-Reckoning + interpolation lerp/slerp à 60+ FPS sur la voiture Hôte et les bots IA
      while (this.physicsAccumulator + 1e-7 >= FIXED_TIME_STEP) {
        if (this.localPlayer) {
          this.localPlayer.savePreviousPhysicsState();
          this.localPlayer.updatePhysics(FIXED_TIME_STEP, canDrive, this.raceTime, this._envContext);
        }
        for (let i = 0; i < this.vehicles.length; i++) {
          const rv = this.vehicles[i];
          if (rv !== this.localPlayer && rv.hasNetTarget) {
            rv.chassisBody.position.set(rv.currPhysicsPos.x, rv.currPhysicsPos.y, rv.currPhysicsPos.z);
            rv.chassisBody.quaternion.set(rv.currPhysicsQuat.x, rv.currPhysicsQuat.y, rv.currPhysicsQuat.z, rv.currPhysicsQuat.w);
            rv.chassisBody.velocity.set(rv.netVel.x, rv.netVel.y, rv.netVel.z);
            rv.chassisBody.angularVelocity.set(0, 0, 0);
            rv.chassisBody.force.set(0, 0, 0);
          }
        }
        this.world.step(FIXED_TIME_STEP);
        if (this.localPlayer) {
          this.localPlayer.afterPhysicsStep(FIXED_TIME_STEP, this.raceTime);
        }
        this.physicsAccumulator = Math.max(0, this.physicsAccumulator - FIXED_TIME_STEP);
      }

      for (let i = 0; i < this.vehicles.length; i++) {
        const v = this.vehicles[i];
        if (v === this.localPlayer || !v.hasNetTarget) continue;
        this._interpolateRemoteVehicle(v, dt, canDrive);
      }
    } else {
      // Côté Hôte (ou Hors Ligne) : simulation physique Cannon-es (avec p2 extrapolée si pilotée en direct par l'Invité)
      while (this.physicsAccumulator + 1e-7 >= FIXED_TIME_STEP) {
        for (let i = 0; i < this.vehicles.length; i++) {
          const v = this.vehicles[i];
          if (this.isOnline && v.isNetDriven) continue;
          v.savePreviousPhysicsState();
        }

        if (canDrive) {
          const activeTokens = this.boostTokens ? this.boostTokens.tokens : null;
          for (let i = 0; i < this.aiDrivers.length; i++) {
            this.aiDrivers[i].update(FIXED_TIME_STEP, this.vehicles, activeTokens);
          }
        }

        for (let i = 0; i < this.vehicles.length; i++) {
          const v = this.vehicles[i];
          if (this.isOnline && v.isNetDriven) {
            v.chassisBody.position.set(v.currPhysicsPos.x, v.currPhysicsPos.y, v.currPhysicsPos.z);
            v.chassisBody.quaternion.set(v.currPhysicsQuat.x, v.currPhysicsQuat.y, v.currPhysicsQuat.z, v.currPhysicsQuat.w);
            v.chassisBody.velocity.set(v.netVel.x, v.netVel.y, v.netVel.z);
            v.chassisBody.angularVelocity.set(0, 0, 0);
            v.chassisBody.force.set(0, 0, 0);
            continue;
          }
          v.updatePhysics(FIXED_TIME_STEP, canDrive, this.raceTime, this._envContext);
        }

        this.world.step(FIXED_TIME_STEP);

        for (let i = 0; i < this.vehicles.length; i++) {
          const v = this.vehicles[i];
          if (this.isOnline && v.isNetDriven) continue;
          v.afterPhysicsStep(FIXED_TIME_STEP, this.raceTime);
        }

        this.physicsAccumulator = Math.max(0, this.physicsAccumulator - FIXED_TIME_STEP);
      }

      if (this.isOnline && this.onlineRole === 'host') {
        for (let i = 0; i < this.players.length; i++) {
          const guestCar = this.players[i];
          if (guestCar && guestCar !== this.localPlayer && guestCar.isNetDriven && guestCar.hasNetTarget) {
            this._interpolateRemoteVehicle(guestCar, dt, canDrive);
          }
        }
        if (this.network) {
          this.network.broadcastHostPhysicsState(this, dt);
        }
      }
    }

    // 3) Interpolation linéaire (lerp position) et sphérique (slerp rotation)
    const alpha = this.physicsAccumulator / FIXED_TIME_STEP;
    for (let i = 0; i < this.vehicles.length; i++) {
      this.vehicles[i].syncVisuals(dt, this.elapsedTime, this.particles, alpha);
    }

    // 4) Mise à jour des caméras ChaseCam APRÈS syncVisuals
    if (this.isSpectator) {
      const target = this._getSpectatorInfo()?.target;
      if (target) this.cam1.update(target, dt);
    } else if (this.isOnline && this.localPlayer) {
      this.cam1.update(this.localPlayer, dt);
    } else {
      if (this.players[0]) this.cam1.update(this.players[0], dt);
      if (this.playerCount === 2 && this.players[1]) {
        this.cam2.update(this.players[1], dt);
      }
    }

    // 5) Jetons sur la piste (cycle dynamique 3–10s), particules, météo et audio
    if (this.boostTokens) {
      if (this.isOnline && this.onlineRole === 'guest') {
        const pickedIdx = this.boostTokens.updateGuestTokens(dt, this.localPlayer, this.particles);
        if (this.network && this.localPlayer) {
          this.network.sendGuestState(this.localPlayer, pickedIdx, dt);
        }
      } else {
        this.boostTokens.update(dt, this.vehicles, this.particles);
      }
    }
    this.particles.update(dt);

    const activeCameras = (!this.isOnline && !this.isSpectator && this.playerCount === 2)
      ? this._activeCameras2
      : this._activeCameras1;
    this.weatherSystem.update(dt, activeCameras);

    if (this.isSpectator && this.spectatorTarget) {
      this._singleAudioTarget[0] = this.spectatorTarget;
      soundManager.updateRaceAudio(this._singleAudioTarget, 1, false);
    } else if (this.isOnline && this.localPlayer) {
      this._singleAudioTarget[0] = this.localPlayer;
      soundManager.updateRaceAudio(this._singleAudioTarget, 1, this.state === 'finished');
    } else {
      soundManager.updateRaceAudio(this.players, this.playerCount, this.state === 'finished');
    }

    // 6) Classement temps réel, étiquettes de pseudos 3D -> 2D et détection de fin de course
    if (this.isOnline && this.localPlayer && this.network) {
      const me = this.localPlayer;
      if (me.lap > (me._lastSyncedLap || 1) || (me.finished && !me._lastSyncedFinished)) {
        me._lastSyncedLap = me.lap;
        me._lastSyncedFinished = Boolean(me.finished);
        this.network.sendRaceEvent({
          event: 'LAP_OR_FINISH',
          slotIndex: this.myOnlineSlot,
          lap: me.lap,
          finished: Boolean(me.finished),
          finishTime: me.finishTime || 0,
        });
      }
    }
    this._updateStandings();
    this._updateRaceNameTags();
    const windVec = WEATHER_MODIFIERS[this.activeWeather]?.windForce || null;
    this.hud.update(this.players, this.vehicles, this.raceTime, this._getSpectatorInfo(), this.localPlayer, this.activeWeather, windVec);

    if (this.state === 'racing') {
      this._checkRaceEnd();
    }
  }

  _applyFinishedCruise(vehicle) {
    vehicle.controls.throttle = 0;
    vehicle.controls.brake = 0;
    vehicle.controls.steer = 0;
    vehicle.controls.boost = false;
    vehicle.controls.reset = false;
  }

  _updateStandings() {
    if (this.standings.length !== this.vehicles.length) {
      this.standings = [...this.vehicles];
    }
    this.standings.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.raceProgress - a.raceProgress;
    });
    for (let i = 0; i < this.standings.length; i++) {
      this.standings[i].rank = i + 1;
    }
  }

  _checkRaceEnd() {
    if (this.playerCount === 0) {
      const allBotsFinished = this.vehicles.length > 0 && this.vehicles.every((v) => v.finished);
      if (allBotsFinished && !this.resultsShownOnce) {
        this.state = 'finished';
        this.resultsShownOnce = true;
        this._updateStandings();
        this.onFinishCallback(this.standings);
      }
      return;
    }

    if (this.isOnline && this.localPlayer) {
      const me = this.localPlayer;
      const meStopped = Boolean(me.finished) && (me.parkingLocked || (this.raceTime - me.finishTime) >= 1.9);
      if (meStopped && !this.resultsShownOnce) {
        this.resultsShownOnce = true;
        this._updateStandings();
        this.onFinishCallback(this.standings);
      }
      return;
    }

    const p1 = this.players[0];
    const p2 = this.players[1];
    const p1Done = Boolean(p1?.finished);
    const p2Done = this.playerCount === 1 ? true : Boolean(p2?.finished);

    if ((p1Done || (this.playerCount === 2 && p2Done)) && this.firstPlayerFinishTime === null) {
      this.firstPlayerFinishTime = this.raceTime;
    }

    const timeoutReached = this.firstPlayerFinishTime !== null
      && (this.raceTime - this.firstPlayerFinishTime) >= CONFIG.race.finishTimeout;

    const p1Stopped = p1Done && (p1.parkingLocked || (this.raceTime - p1.finishTime) >= 1.9);
    const p2Stopped = this.playerCount === 1
      ? true
      : (p2Done && (p2.parkingLocked || (this.raceTime - p2.finishTime) >= 1.9));

    if ((p1Stopped && p2Stopped) || timeoutReached) {
      if (!this.resultsShownOnce) {
        this.state = 'finished';
        this.resultsShownOnce = true;
        this._updateStandings();
        this.onFinishCallback(this.standings);
      }
    }
  }

  /**
   * Un seul appel `renderer.render()` par frame en plein écran (Solo, Spectateur, 2J en Ligne).
   */
  render() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (this.isOnline || this.isSpectator || this.playerCount <= 1) {
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, w, h);
      this.weatherSystem.prepareForViewport?.(0);
      this.renderer.render(this.scene, this.cam1.camera);
      return;
    }

    const halfW = Math.floor(w * 0.5);
    const rightW = w - halfW;

    this.renderer.setScissorTest(true);

    this.renderer.setViewport(0, 0, halfW, h);
    this.renderer.setScissor(0, 0, halfW, h);
    this.weatherSystem.prepareForViewport?.(0);
    this.renderer.render(this.scene, this.cam1.camera);

    this.renderer.setViewport(halfW, 0, rightW, h);
    this.renderer.setScissor(halfW, 0, rightW, h);
    this.weatherSystem.prepareForViewport?.(1);
    this.renderer.render(this.scene, this.cam2.camera);

    this.renderer.setScissorTest(false);
  }
}
