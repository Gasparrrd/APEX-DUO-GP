/**
 * main.js — Point d'entrée de l'application Web 3D (100% Statique / GitHub Pages Ready) :
 *  - Initialise le moteur de rendu Three.js (`outputColorSpace = THREE.SRGBColorSpace`, `logarithmicDepthBuffer: false`)
 *  - Architecture P2P WebRTC via PeerJS CDN (2 à 4 joueurs humains, Hôte / Clients sans serveur Node.js)
 *  - Détection automatique de `?room=CODE` dans l'URL avec connexion immédiate au salon
 *  - Remplissage dynamique des slots libres par des bots IA et reprise par un bot IA en cas de déconnexion en course
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CONFIG, DEFAULT_PLAYER_CARS, VEHICLE_MODIFIERS, MAX_TOTAL_CARS, getVehicleDisplayStats } from './config.js?v=35';
import { InputManager } from './core/input.js?v=35';
import { setSharedCarEnvMap } from './gfx/carModel.js?v=35';
import { GarageScene } from './scenes/garageScene.js?v=35';
import { RaceScene } from './scenes/raceScene.js?v=35';
import { HUDController } from './ui/hud.js?v=35';
import { soundManager } from './core/audio.js?v=35';
import { NetworkManager } from './net/networkManager.js?v=35';

const DIFF_BY_STEP = { 1: 'easy', 2: 'normal', 3: 'hard' };
const DIFF_LABEL_BY_KEY = { easy: 'Facile', normal: 'Moyen', hard: 'Difficile' };
const STEP_BY_DIFF = { easy: 1, normal: 2, hard: 3 };

const PLAYER_COUNT_BY_MODE = {
  SOLO: 1,
  SPLIT: 2,
  SPECTATOR: 0,
  ONLINE: 2,
};

const WEATHER_ID_BY_KEY = {
  SUNNY: 'sunny',
  RAIN: 'rain',
  STORM: 'storm',
  RANDOM: 'random',
};

const WEATHER_KEY_BY_ID = {
  sunny: 'SUNNY',
  rain: 'RAIN',
  storm: 'STORM',
  random: 'RANDOM',
};

class RacingApp {
  constructor() {
    this.canvas = document.getElementById('webgl-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.envMap = pmrem.fromScene(envScene, 0.04).texture;
    envScene.dispose();
    pmrem.dispose();
    setSharedCarEnvMap(this.envMap);

    this.playerConfigs = [
      { ...DEFAULT_PLAYER_CARS[0], name: 'HÔTE' },
      { ...DEFAULT_PLAYER_CARS[1], name: 'JOUEUR 2' },
      { ...(DEFAULT_PLAYER_CARS[2] || DEFAULT_PLAYER_CARS[0]), name: 'JOUEUR 3' },
      { ...(DEFAULT_PLAYER_CARS[3] || DEFAULT_PLAYER_CARS[1]), name: 'JOUEUR 4' },
    ];

    // Variables d'état UI strictement indépendantes
    this.currentGameMode = 'SPLIT'; // 'SOLO' | 'SPLIT' | 'SPECTATOR' | 'ONLINE'
    this.currentWeather = 'SUNNY';  // 'SUNNY' | 'RAIN' | 'STORM' | 'RANDOM'

    this.raceSettings = {
      playerCount: PLAYER_COUNT_BY_MODE[this.currentGameMode],
      circuit: CONFIG.race.circuit || 'flat',
      weather: WEATHER_ID_BY_KEY[this.currentWeather],
      engineSound: CONFIG.race.engineSound || 'thermal',
      laps: CONFIG.race.laps,
      bots: CONFIG.race.bots,
      difficulty: CONFIG.race.difficulty,
    };
    soundManager.setEngineSoundMode(this.raceSettings.engineSound);

    this.input = new InputManager();
    this.hud = new HUDController();

    this.garageScene = new GarageScene(this.renderer, this.envMap, this.playerConfigs);
    this.raceScene = new RaceScene(this.renderer, this.envMap, this.input, this.hud, {
      onFinish: (standings) => this._onRaceFinished(standings),
    });

    // Gestionnaire réseau P2P Temps Réel (WebRTC DataChannel + PeerJS CDN à 30 Hz, 2 à 4 joueurs)
    this.network = new NetworkManager({
      onPeerReady: (roomId, inviteUrl, badgeText) => this._onNetPeerReady(roomId, inviteUrl, badgeText),
      onPeerError: (err) => this._onNetPeerError(err),
      onPeerConnected: () => this._onNetPeerConnected(),
      onPeerDisconnected: () => this._onNetPeerDisconnected(),
      onHostLeft: (reason) => this._onHostDisconnected(reason),
      onGuestLeft: (slotIdx, playerName) => this._onGuestLeftGroup(slotIdx, playerName),
      onPlayerMidRaceDisconnect: (slotIdx, playerName) => this._onPlayerMidRaceDisconnect(slotIdx, playerName),
      onLobbyStateChange: (info) => this._onNetLobbyStateChange(info),
      onRemoteCarUpdate: (idx, carCfg, senderName) => this._onNetRemoteCarUpdate(idx, carCfg, senderName),
      onGuestReadyChange: (ready, guestCar, guestName) => this._onNetGuestReadyChange(ready, guestCar, guestName),
      onRaceSettingsUpdate: (settings) => this._onNetRaceSettingsUpdate(settings),
      onStartOnlineRace: (payload) => this._onNetStartOnlineRace(payload),
      onResetOnlineRace: (payload) => this._onNetStartOnlineRace(payload),
      onSnapshot: (snap) => this.raceScene.applyHostSnapshot(snap),
      onGuestInput: (inp) => this.raceScene.setRemoteGuestControls(inp),
      onGuestState: (st) => this.raceScene.applyGuestState(st),
      onRaceEvent: (ev) => this.raceScene.applyRaceEvent(ev),
    });
    this.raceScene.setNetworkManager(this.network);

    this.gameState = 'LOBBY'; // 'LOBBY' | 'RACING' | 'PAUSED' | 'RESULTS'
    this.isPaused = false;
    this._pauseDebounceUntil = 0;
    this.activeGaragePlayer = 0;
    this._copyFeedbackTimer = null;
    this._toastTimer = null;

    this._bindUI();
    this._syncCustomizerUI();
    this._refreshGameModeUI();
    this._refreshWeatherUI();
    this._updateWaitingRoomSlotsUI();

    window.addEventListener('resize', () => this._onResize());

    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ==========================================================================
  // 1. ÉCOUTEURS UI STRICTEMENT DÉCOUPLÉS (MODES DE JEU VS MÉTÉO VS CIRCUIT)
  // ==========================================================================

  _bindUI() {
    // Bouton « 🎲 Tout Aléatoire » du salon (réservé à l'Hôte en mode En Ligne)
    const btnAllRandom = document.getElementById('btn-all-random');
    if (btnAllRandom) {
      btnAllRandom.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
        this.applyAllRandomSettings();
      });
    }

    // Bouton « ❌ Quitter le groupe » centré tout en haut du salon
    const btnLeaveGroup = document.getElementById('btn-leave-group');
    if (btnLeaveGroup) {
      btnLeaveGroup.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.leaveOnlineGroup();
      });
    }

    // Onglets du panneau droit (Paramètres vs Contrôles AZERTY)
    document.querySelectorAll('[data-lobby-tab]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const tab = btn.dataset.lobbyTab;
        document.querySelectorAll('[data-lobby-tab]').forEach((b) => {
          b.classList.toggle('active', b.dataset.lobbyTab === tab);
        });
        document.getElementById('lobby-panel-settings').classList.toggle('hidden', tab !== 'settings');
        document.getElementById('lobby-panel-controls').classList.toggle('hidden', tab !== 'controls');
      });
    });

    // Sélection Joueur 1 / Joueur 2 dans le garage
    document.querySelectorAll('[data-player-tab]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const idx = Number(btn.dataset.playerTab);
        if (this.currentGameMode === 'ONLINE') {
          const myOnlineIdx = this.network.role === 'guest' ? (this.network.mySlotIndex || 1) : 0;
          this.activeGaragePlayer = myOnlineIdx;
          this.garageScene.setActivePlayer(myOnlineIdx);
          this._syncCustomizerUI();
          return;
        } else if (this.raceSettings.playerCount <= 1 && idx === 1) {
          return;
        }
        this.activeGaragePlayer = idx;
        this.garageScene.setActivePlayer(idx);
        this._syncCustomizerUI();
      });
    });

    // Groupe A : Sélecteur de Mode de Jeu (#game-mode-selector button)
    const gameModeButtons = document.querySelectorAll('#game-mode-selector button[data-game-mode]');
    gameModeButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const modeKey = btn.dataset.gameMode;
        this.setGameMode(modeKey);
      });
    });

    // Groupe B : Sélecteur de Météo (#weather-selector button)
    const weatherButtons = document.querySelectorAll('#weather-selector button[data-weather-mode]');
    weatherButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
        const weatherKey = btn.dataset.weatherMode;
        this.setWeatherMode(weatherKey);
      });
    });

    // Groupe C : Sélecteur de Circuit (#circuit-selector button)
    document.querySelectorAll('#circuit-selector button[data-circuit-id]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
        this.setCircuitMode(btn.dataset.circuitId);
      });
    });

    // Groupe D : Sélecteur de Son Moteur (#engine-sound-selector button)
    document.querySelectorAll('#engine-sound-selector button[data-engine-sound]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const mode = btn.dataset.engineSound === 'electric' ? 'electric' : 'thermal';
        this.raceSettings.engineSound = mode;
        CONFIG.race.engineSound = mode;
        soundManager.setEngineSoundMode(mode);
        document.querySelectorAll('#engine-sound-selector button[data-engine-sound]').forEach((b) => {
          b.classList.toggle('active', b.dataset.engineSound === mode);
        });
        this._broadcastRaceSettingsIfHost();
      });
    });

    // Groupe E : Personnalisation du véhicule (Carrosserie, Couleur, Jantes, Aileron)
    document.querySelectorAll('#body-type-selector button[data-body-type]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (this._isGuestCustomizerLocked()) return;
        const bodyType = btn.dataset.bodyType;
        this.garageScene.updateCarConfig(this.activeGaragePlayer, { bodyType });
        this._broadcastLocalCarIfOnline();
        this._syncCustomizerUI();
        this._updateWaitingRoomSlotsUI();
      });
    });

    const colorInput = document.getElementById('car-color-input');
    const colorHexLabel = document.getElementById('car-color-hex');
    colorInput.addEventListener('input', (e) => {
      if (this._isGuestCustomizerLocked()) return;
      const hex = e.target.value;
      colorHexLabel.textContent = hex.toUpperCase();
      this.garageScene.updateCarConfig(this.activeGaragePlayer, { color: hex });
      this._updateSwatchSelection(hex);
      this._updatePlayerTabBadges();
      this._broadcastLocalCarIfOnline();
      this._updateWaitingRoomSlotsUI();
    });

    document.querySelectorAll('[data-color-preset]').forEach((swatch) => {
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        if (this._isGuestCustomizerLocked()) return;
        const hex = swatch.dataset.colorPreset;
        colorInput.value = hex;
        colorHexLabel.textContent = hex.toUpperCase();
        this.garageScene.updateCarConfig(this.activeGaragePlayer, { color: hex });
        this._updateSwatchSelection(hex);
        this._updatePlayerTabBadges();
        this._broadcastLocalCarIfOnline();
        this._updateWaitingRoomSlotsUI();
      });
    });

    document.querySelectorAll('#rim-type-selector button[data-rim-type]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (this._isGuestCustomizerLocked()) return;
        const rims = btn.dataset.rimType;
        this.garageScene.updateCarConfig(this.activeGaragePlayer, { rims });
        this._broadcastLocalCarIfOnline();
        this._syncCustomizerUI();
      });
    });

    document.querySelectorAll('#rim-finish-selector button[data-rim-finish]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (this._isGuestCustomizerLocked()) return;
        const rimFinish = btn.dataset.rimFinish;
        this.garageScene.updateCarConfig(this.activeGaragePlayer, { rimFinish });
        this._broadcastLocalCarIfOnline();
        this._syncCustomizerUI();
      });
    });

    document.querySelectorAll('#spoiler-type-selector button[data-spoiler-type]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (this._isGuestCustomizerLocked()) return;
        const spoiler = btn.dataset.spoilerType;
        this.garageScene.updateCarConfig(this.activeGaragePlayer, { spoiler });
        this._broadcastLocalCarIfOnline();
        this._syncCustomizerUI();
      });
    });

    // Contrôles du Salon Multijoueur P2P (100% Statique via PeerJS)
    const tabHost = document.getElementById('tab-online-role-host');
    const tabJoin = document.getElementById('tab-online-role-join');
    const hostPanel = document.getElementById('online-host-panel');
    const joinPanel = document.getElementById('online-join-panel');
    const guestPanel = document.getElementById('online-guest-panel');

    if (tabHost && tabJoin && hostPanel && joinPanel) {
      tabHost.addEventListener('click', (e) => {
        e.preventDefault();
        tabHost.classList.add('active');
        tabJoin.classList.remove('active');
        hostPanel.classList.remove('hidden');
        joinPanel.classList.add('hidden');
        if (guestPanel) guestPanel.classList.add('hidden');
        if (this.network && this.network.role !== 'host') {
          const hostNameInput = document.getElementById('online-host-name');
          const hostName = (hostNameInput && hostNameInput.value.trim()) ? hostNameInput.value.trim() : 'HÔTE';
          this.playerConfigs[0].name = hostName;
          this.activeGaragePlayer = 0;
          this.garageScene.setActivePlayer(0);
          this.network.initHost(hostName, this.playerConfigs[0], this.raceSettings);
          this._syncGarageCarsAndCamera();
          this._update3DPodiumBadges();
          this._syncCustomizerUI();
          this._updateWaitingRoomSlotsUI();
          this._refreshOnlineStatusUI();
        }
      });

      tabJoin.addEventListener('click', (e) => {
        e.preventDefault();
        tabJoin.classList.add('active');
        tabHost.classList.remove('active');
        if (this.network && this.network.role === 'guest') {
          this.network.leaveGroup();
          this.activeGaragePlayer = 0;
          this.garageScene.setActivePlayer(0);
        }
        joinPanel.classList.remove('hidden');
        hostPanel.classList.add('hidden');
        if (guestPanel) guestPanel.classList.add('hidden');
        this._refreshOnlineStatusUI();
        const joinInput = document.getElementById('online-join-code-input');
        if (joinInput) {
          setTimeout(() => joinInput.focus(), 40);
        }
      });
    }

    const btnGuestLeavePanel = document.getElementById('btn-guest-leave-panel');
    if (btnGuestLeavePanel) {
      btnGuestLeavePanel.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.leaveOnlineGroup();
      });
    }

    const hostNameInput = document.getElementById('online-host-name');
    if (hostNameInput) {
      hostNameInput.addEventListener('input', (e) => {
        const name = e.target.value.trim().slice(0, 18) || 'HÔTE';
        this.playerConfigs[0].name = name;
        this.garageScene.updateCarConfig(0, { name });
        this.network.setHostName(name, this.playerConfigs[0]);
        this._update3DPodiumBadges();
        this._updateWaitingRoomSlotsUI();
        this._refreshOnlineStatusUI();
      });
    }

    const btnCopyCode = document.getElementById('btn-copy-code');
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._copyRoomCodeToClipboard();
      });
    }

    const btnCopyInvite = document.getElementById('btn-copy-invite');
    if (btnCopyInvite) {
      btnCopyInvite.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._copyInviteLinkToClipboard();
      });
    }

    const btnSubmitJoin = document.getElementById('btn-submit-join-code');
    const joinCodeInput = document.getElementById('online-join-code-input');
    const joinNameInput = document.getElementById('online-join-name');

    const handleManualJoin = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const rawValue = (joinCodeInput?.value || '').trim();
      if (!rawValue) {
        joinCodeInput?.focus();
        return;
      }
      const pseudo = (joinNameInput?.value || '').trim().slice(0, 18) || 'PILOTE';
      this._joinOnlineRoomAsGuest(rawValue, pseudo);
    };

    if (btnSubmitJoin) {
      btnSubmitJoin.addEventListener('click', handleManualJoin);
    }
    if (joinCodeInput) {
      joinCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleManualJoin(e);
        }
      });
    }

    const guestNameInput = document.getElementById('online-guest-name');
    if (guestNameInput) {
      guestNameInput.addEventListener('input', (e) => {
        if (this._isGuestCustomizerLocked()) return;
        const name = e.target.value.trim().slice(0, 18) || 'PILOTE';
        const myIdx = this.network.mySlotIndex || 1;
        this.playerConfigs[myIdx].name = name;
        this.garageScene.updateCarConfig(myIdx, { name });
        this.network.setGuestName(name, this.playerConfigs[myIdx]);
        this._update3DPodiumBadges();
        this._updateWaitingRoomSlotsUI();
        this._refreshOnlineStatusUI();
      });
    }

    const btnGuestReady = document.getElementById('btn-guest-ready');
    if (btnGuestReady) {
      btnGuestReady.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.network.role !== 'guest') return;
        const myIdx = this.network.mySlotIndex || 1;
        const nextReady = !this.network.guestReady;
        if (guestNameInput && guestNameInput.value.trim()) {
          this.playerConfigs[myIdx].name = guestNameInput.value.trim().slice(0, 18);
        }
        this.network.setGuestReady(nextReady, this.playerConfigs[myIdx]);
        console.log(`[P2P Guest Slot ${myIdx + 1}] Statut Prêt basculé ->`, nextReady);
        this._update3DPodiumBadges();
        this._updateWaitingRoomSlotsUI();
        this._syncCustomizerUI();
        this._refreshOnlineStatusUI();
      });
    }

    // Modale d'accueil optionnelle pour l'invité
    const btnModalJoin = document.getElementById('btn-guest-modal-join');
    const modalNameInput = document.getElementById('guest-modal-name-input');
    const confirmGuestJoin = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      const pseudo = (modalNameInput && modalNameInput.value.trim())
        ? modalNameInput.value.trim().slice(0, 18)
        : 'PILOTE';
      const modal = document.getElementById('guest-join-modal');
      if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
      }
      this._joinOnlineRoomAsGuest(this._pendingRoomId, pseudo);
    };
    if (btnModalJoin) {
      btnModalJoin.addEventListener('click', confirmGuestJoin);
    }
    if (modalNameInput) {
      modalNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          confirmGuestJoin(e);
        }
      });
    }

    // Réglages des volumes sonores (Musique du salon & Moteur/Bruitages)
    const volMusicSlider = document.getElementById('setting-vol-music');
    const volMusicVal = document.getElementById('setting-vol-music-val');
    if (volMusicSlider && volMusicVal) {
      volMusicSlider.addEventListener('input', (e) => {
        const pct = Number(e.target.value);
        volMusicVal.textContent = `${pct}%`;
        soundManager.setLobbyMusicVolume(pct / 100);
      });
    }

    const volEngineSlider = document.getElementById('setting-vol-engine');
    const volEngineVal = document.getElementById('setting-vol-engine-val');
    if (volEngineSlider && volEngineVal) {
      volEngineSlider.addEventListener('input', (e) => {
        const pct = Number(e.target.value);
        volEngineVal.textContent = `${pct}%`;
        soundManager.setEngineVolume(pct / 100);
      });
    }

    const diffSlider = document.getElementById('setting-diff-slider');
    const diffVal = document.getElementById('setting-diff-val');
    diffSlider.addEventListener('input', (e) => {
      if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
      const step = Number(e.target.value);
      const diffKey = DIFF_BY_STEP[step] || 'normal';
      this.raceSettings.difficulty = diffKey;
      diffVal.textContent = DIFF_LABEL_BY_KEY[diffKey];
      this._broadcastRaceSettingsIfHost();
    });

    document.getElementById('setting-laps').addEventListener('change', (e) => {
      if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
      this.raceSettings.laps = Number(e.target.value);
      this._broadcastRaceSettingsIfHost();
    });
    document.getElementById('setting-bots').addEventListener('change', (e) => {
      if (this.currentGameMode === 'ONLINE' && this.network.role === 'guest') return;
      this.raceSettings.bots = Number(e.target.value);
      this._broadcastRaceSettingsIfHost();
    });

    // Boutons de lancement / fin de course
    document.getElementById('btn-start-race').addEventListener('click', (event) => {
      event.preventDefault();
      this._onClickStartRace();
    });
    document.getElementById('btn-restart-race').addEventListener('click', (event) => {
      event.preventDefault();
      this._onClickRestartRace();
    });
    document.getElementById('btn-back-garage').addEventListener('click', (event) => {
      event.preventDefault();
      this.returnToGarage();
    });

    // 2. GESTION ANTI-REBOND (DEBOUNCE) DU BOUTON ET DU MENU PAUSE
    const btnHudPause = document.getElementById('btn-hud-pause');
    if (btnHudPause) {
      btnHudPause.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        btnHudPause.blur();
        this.togglePause(event);
      });
    }

    const btnPauseResume = document.getElementById('btn-pause-resume');
    if (btnPauseResume) {
      btnPauseResume.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        btnPauseResume.blur();
        this.resumeFromPause();
      });
    }

    const btnPauseRestart = document.getElementById('btn-pause-restart');
    if (btnPauseRestart) {
      btnPauseRestart.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        btnPauseRestart.blur();
        this.resumeFromPause();
        this._onClickRestartRace();
      });
    }

    const btnPauseGarage = document.getElementById('btn-pause-garage');
    if (btnPauseGarage) {
      btnPauseGarage.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        btnPauseGarage.blur();
        this.returnToGarage();
      });
    }

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' || event.key === 'Escape') {
        if (event.repeat) return;
        if (this.gameState === 'RACING' || this.gameState === 'PAUSED') {
          event.preventDefault();
          event.stopPropagation();
          this.togglePause(event);
        }
      }
    });

    // Boutons Mode Spectateur
    const btnSpectate = document.getElementById('btn-spectate-race');
    if (btnSpectate) {
      btnSpectate.addEventListener('click', (event) => {
        event.preventDefault();
        this.enterSpectatorFromResults();
      });
    }
    const btnSpecPrev = document.getElementById('btn-spec-prev');
    if (btnSpecPrev) {
      btnSpecPrev.addEventListener('click', (event) => {
        event.preventDefault();
        this.raceScene.cycleSpectatorTarget(-1);
      });
    }
    const btnSpecNext = document.getElementById('btn-spec-next');
    if (btnSpecNext) {
      btnSpecNext.addEventListener('click', (event) => {
        event.preventDefault();
        this.raceScene.cycleSpectatorTarget(1);
      });
    }
    const btnSpecResults = document.getElementById('btn-spec-results');
    if (btnSpecResults) {
      btnSpecResults.addEventListener('click', (event) => {
        event.preventDefault();
        this._onRaceFinished(this.raceScene.standings);
      });
    }
  }

  /**
   * Retourne le nombre actuel de joueurs humains actifs (0 en Spectateur, 1 en Solo, 2 en Split, 1 à 4 en Ligne).
   */
  _getActiveHumanPlayerCount() {
    if (this.currentGameMode === 'ONLINE') {
      const n = this.network ? this.network.getConnectedPlayerCount() : 1;
      return Math.max(1, Math.min(4, n));
    }
    if (this.currentGameMode === 'SPECTATOR') return 0;
    if (this.currentGameMode === 'SOLO') return 1;
    return 2;
  }

  /**
   * Met à jour dynamiquement la liste déroulante des bots (`#setting-bots`)
   * pour ne jamais dépasser la capacité maximale de 10 voitures au total (joueurs humains + bots).
   */
  _updateBotSelectorOptions() {
    const humanCount = this._getActiveHumanPlayerCount();
    const maxTotal = CONFIG.race.maxTotalCars || MAX_TOTAL_CARS || 10;
    const maxBots = Math.max(0, maxTotal - humanCount);
    const minBots = humanCount === 0 ? 2 : 0;

    const clampedBots = Math.max(minBots, Math.min(maxBots, Number(this.raceSettings.bots ?? 3)));
    this.raceSettings.bots = clampedBots;
    CONFIG.race.bots = clampedBots;

    const botsSel = document.getElementById('setting-bots');
    if (botsSel) {
      const prevKey = `${minBots}_${maxBots}`;
      if (botsSel.dataset.rangeKey !== prevKey) {
        botsSel.innerHTML = '';
        for (let b = minBots; b <= maxBots; b++) {
          const opt = document.createElement('option');
          opt.value = String(b);
          opt.textContent = `${b} ${b <= 1 ? 'Bot' : 'Bots'}`;
          botsSel.appendChild(opt);
        }
        botsSel.dataset.rangeKey = prevKey;
      }
      botsSel.value = String(clampedBots);
    }
  }

  /**
   * Synchronise le nombre exact de voitures affichées dans le salon 3D (de 1 à 4),
   * leur espacement et le recul automatique de la caméra.
   */
  _syncGarageCarsAndCamera() {
    if (!this.garageScene) return;
    if (this.currentGameMode === 'ONLINE') {
      const slots = this.network?.slots || [];
      const occupiedFlags = [0, 1, 2, 3].map((i) => Boolean(slots[i] && slots[i].occupied));
      if (!occupiedFlags.some(Boolean)) {
        const myIdx = (this.activeGaragePlayer >= 0 && this.activeGaragePlayer <= 3) ? this.activeGaragePlayer : 0;
        occupiedFlags[myIdx] = true;
      }
      this.garageScene.setOnlineLobbyState(occupiedFlags, this.activeGaragePlayer);
    } else {
      const count = this.raceSettings.playerCount;
      this.garageScene.setPlayerCount(count, false);
      this.garageScene.setActivePlayer(this.activeGaragePlayer);
    }
  }

  /**
   * Fonction dédiée exclusivement au changement de Mode de Jeu (`SOLO` | `SPLIT` | `SPECTATOR` | `ONLINE`).
   */
  setGameMode(modeKey, options = {}) {
    const validModes = ['SOLO', 'SPLIT', 'SPECTATOR', 'ONLINE'];
    const normalizedMode = validModes.includes(modeKey) ? modeKey : 'SPLIT';

    this.currentGameMode = normalizedMode;
    this.raceSettings.playerCount = PLAYER_COUNT_BY_MODE[normalizedMode];

    console.log(
      `[UI Mode] Mode de jeu sélectionné : ${this.currentGameMode} (playerCount=${this.raceSettings.playerCount}) | Météo conservée : ${this.currentWeather}`
    );

    if (normalizedMode === 'ONLINE') {
      if (!options.skipHostInit && this.network.role === 'offline') {
        const tabHost = document.getElementById('tab-online-role-host');
        const tabJoin = document.getElementById('tab-online-role-join');
        if (tabHost && tabJoin) {
          tabHost.classList.add('active');
          tabJoin.classList.remove('active');
        }
        this._prepareHostUIBeforeOpen();
        const hostNameInput = document.getElementById('online-host-name');
        const hostName = (hostNameInput && hostNameInput.value.trim()) ? hostNameInput.value.trim() : 'HÔTE';
        this.playerConfigs[0].name = hostName;
        this.network.initHost(hostName, this.playerConfigs[0], this.raceSettings);
      }
      this.activeGaragePlayer = this.network.role === 'guest' ? (this.network.mySlotIndex || 1) : 0;
      this._syncGarageCarsAndCamera();
      this._update3DPodiumBadges();
      this._updateWaitingRoomSlotsUI();
    } else {
      if (this.network && (this.network.active || this.network.role !== 'offline')) {
        this.network.leaveGroup();
        try {
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (_) {}
      }
      const count = this.raceSettings.playerCount;
      if (count <= 1 && this.activeGaragePlayer !== 0) {
        this.activeGaragePlayer = 0;
      }
      this._syncGarageCarsAndCamera();
    }

    this._updateBotSelectorOptions();
    this._refreshGameModeUI();
    this._syncCustomizerUI();
    this._refreshOnlineStatusUI();
  }

  /**
   * Quitte proprement le groupe en ligne :
   *  - Ferme la connexion WebRTC et détruit l'instance PeerJS (`conn.close()`, `peer.destroy()`)
   *  - Nettoie l'URL du navigateur sans recharger la page (`window.history.replaceState({}, document.title, window.location.pathname)`)
   *  - Réinitialise l'état du salon en mode « 1 Joueur (Solo) » par défaut
   */
  leaveOnlineGroup(toastMessage = '') {
    console.log('[P2P Group] Déconnexion propre du groupe en ligne -> retour en mode 1 Joueur (Solo)');
    this.network.leaveGroup();

    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (_) {}

    const modal = document.getElementById('guest-join-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }

    this.activeGaragePlayer = 0;
    this.playerConfigs[0].name = 'JOUEUR 1';
    this.playerConfigs[1].name = 'JOUEUR 2';
    this.playerConfigs[2].name = 'JOUEUR 3';
    this.playerConfigs[3].name = 'JOUEUR 4';

    if (this.gameState !== 'LOBBY') {
      this.returnToGarage();
    }

    this.setGameMode('SOLO');

    if (toastMessage) {
      this._showLobbyToast(toastMessage);
    }
  }

  _onHostDisconnected(reason = "L'hôte s'est déconnecté") {
    console.warn("[P2P Guest] Notification de déconnexion de l'Hôte :", reason);
    this.leaveOnlineGroup(reason);
  }

  _onGuestLeftGroup(slotIdx, playerName = 'Un joueur') {
    this._showLobbyToast(`${playerName} a quitté le salon`);
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshOnlineStatusUI();
  }

  _onPlayerMidRaceDisconnect(slotIdx, playerName = 'Joueur') {
    if (this.gameState === 'RACING' || this.gameState === 'PAUSED') {
      this.raceScene.handlePlayerDisconnect(slotIdx, playerName);
    }
    this._showLobbyToast(`${playerName} s'est déconnecté — voiture reprise par un Bot IA`);
  }

  _showLobbyToast(message, durationMs = 4200) {
    const banner = document.getElementById('lobby-toast-banner');
    if (!banner || !message) return;
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
    }
    banner.textContent = `⚠ ${message}`;
    banner.classList.remove('hidden');
    this._toastTimer = setTimeout(() => {
      banner.classList.add('hidden');
      this._toastTimer = null;
    }, durationMs);
  }

  /**
   * Fonction dédiée exclusivement au changement de Météo (`SUNNY` | `RAIN` | `STORM` | `RANDOM`).
   */
  setWeatherMode(weatherKey, options = {}) {
    const upper = String(weatherKey || 'SUNNY').toUpperCase();
    const normalizedWeather = WEATHER_ID_BY_KEY[upper] ? upper : (WEATHER_KEY_BY_ID[String(weatherKey).toLowerCase()] || 'SUNNY');

    this.currentWeather = normalizedWeather;
    this.raceSettings.weather = WEATHER_ID_BY_KEY[normalizedWeather];

    console.log(
      `[UI Météo] Météo sélectionnée : ${this.currentWeather} (${this.raceSettings.weather}) | Mode de jeu conservé : ${this.currentGameMode}`
    );

    this._refreshWeatherUI();

    if (!options.fromNetwork) {
      this._broadcastRaceSettingsIfHost();
    }
  }

  /**
   * Mode Tout Aléatoire : tire au sort le circuit et la météo,
   * sans modifier les autres réglages (son moteur, difficulté, tours, nombre de bots, voitures).
   */
  applyAllRandomSettings() {
    const circuits = ['flat', 'mountain', 'valley', 'lake', 'grotto'];
    const randomCircuit = circuits[Math.floor(Math.random() * circuits.length)];
    this.setCircuitMode(randomCircuit);

    const weathers = ['SUNNY', 'RAIN', 'STORM'];
    const randomWeather = weathers[Math.floor(Math.random() * weathers.length)];
    this.setWeatherMode(randomWeather);

    this._broadcastRaceSettingsIfHost();
    this._showLobbyToast('🎲 Aléatoire : Circuit et Météo sélectionnés !');
    console.log('[Lobby] Mode Tout Aléatoire appliqué (circuit, météo) :', this.raceSettings);
  }

  /**
   * Fonction dédiée au changement de Circuit (`flat` | `mountain` | `valley` | `lake` | `random`).
   */
  setCircuitMode(circuitId, options = {}) {
    this.raceSettings.circuit = circuitId || 'flat';
    console.log(`[UI Circuit] Circuit sélectionné : ${this.raceSettings.circuit} | Mode : ${this.currentGameMode} | Météo : ${this.currentWeather}`);

    document.querySelectorAll('#circuit-selector button[data-circuit-id]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.circuitId === this.raceSettings.circuit);
    });

    if (!options.fromNetwork) {
      this._broadcastRaceSettingsIfHost();
    }
  }

  _refreshGameModeUI() {
    document.querySelectorAll('#game-mode-selector button[data-game-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.gameMode === this.currentGameMode);
    });

    const isOnline = this.currentGameMode === 'ONLINE';
    const onlineBox = document.getElementById('online-lobby-box');
    if (onlineBox) {
      onlineBox.classList.toggle('hidden', !isOnline);
    }

    this._updateLeaveGroupButtonVisibility();
  }

  _updateLeaveGroupButtonVisibility() {
    const btnLeaveGroup = document.getElementById('btn-leave-group');
    if (!btnLeaveGroup) return;
    const isP2PActive = Boolean(this.network && (this.network.active || this.network.connected));
    const showLeave = this.currentGameMode === 'ONLINE' || isP2PActive;
    btnLeaveGroup.classList.toggle('hidden', !showLeave);
  }

  _refreshWeatherUI() {
    document.querySelectorAll('#weather-selector button[data-weather-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.weatherMode === this.currentWeather);
    });
  }

  // ==========================================================================
  // 2. LOGIQUE DU MENU PAUSE (BASCULE STRICTE & FERMETURE EXPLICITE)
  // ==========================================================================

  togglePause(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }

    const now = performance.now();
    if (now < this._pauseDebounceUntil) {
      return;
    }
    this._pauseDebounceUntil = now + 180;

    if (this.gameState !== 'RACING' && this.gameState !== 'PAUSED') {
      return;
    }

    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.gameState = 'PAUSED';
      this.input.clearAll();
      soundManager.silenceRaceAudio();
      const pauseOverlay = document.getElementById('pause-overlay');
      if (pauseOverlay) {
        pauseOverlay.classList.remove('hidden');
        pauseOverlay.style.display = 'flex';
      }
      console.log('[UI Pause] Jeu mis en pause (isPaused = true)');
    } else {
      this.resumeFromPause();
    }
  }

  resumeFromPause() {
    this.isPaused = false;
    this.gameState = 'RACING';
    this.input.clearAll();
    this._pauseDebounceUntil = performance.now() + 180;
    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    this.lastTime = performance.now();
    console.log('[UI Pause] Course reprise (isPaused = false)');
  }

  // ==========================================================================
  // 3. RÉSEAU P2P (WEBRTC / PEERJS) & SALLE D'ATTENTE DYNAMIQUE 2 À 4 JOUEURS
  // ==========================================================================

  _prepareHostUIBeforeOpen() {
    const netBadge = document.getElementById('online-net-badge');
    const urlInput = document.getElementById('online-invite-url');
    const codeInput = document.getElementById('online-room-code');
    const btnCopy = document.getElementById('btn-copy-invite');
    const btnCopyCode = document.getElementById('btn-copy-code');
    if (netBadge) {
      netBadge.textContent = 'Initialisation…';
      netBadge.classList.remove('ready');
    }
    if (urlInput) {
      urlInput.value = 'Génération du salon…';
    }
    if (codeInput) {
      codeInput.value = 'Génération…';
    }
    if (btnCopy) {
      btnCopy.disabled = true;
    }
    if (btnCopyCode) {
      btnCopyCode.disabled = true;
    }
  }

  _onNetPeerReady(roomId, inviteUrl, badgeText = 'Salon prêt') {
    const netBadge = document.getElementById('online-net-badge');
    const urlInput = document.getElementById('online-invite-url');
    const codeInput = document.getElementById('online-room-code');
    const btnCopy = document.getElementById('btn-copy-invite');
    const btnCopyCode = document.getElementById('btn-copy-code');

    if (netBadge) {
      netBadge.textContent = badgeText || 'Salon prêt';
      netBadge.classList.add('ready');
    }
    if (urlInput && inviteUrl) {
      urlInput.value = inviteUrl;
    }
    if (codeInput && roomId) {
      codeInput.value = roomId;
    }
    if (btnCopy) {
      btnCopy.disabled = false;
    }
    if (btnCopyCode) {
      btnCopyCode.disabled = false;
    }

    // Ne pollue pas la barre d'adresse de l'Hôte avec ?room=... pour éviter qu'un F5 ne le bascule en Invité
    if (this.network.role === 'host') {
      try {
        if (window.location.search.includes('room=')) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (_) {}
    }

    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshOnlineStatusUI();
  }

  _copyRoomCodeToClipboard() {
    const btnCopy = document.getElementById('btn-copy-code');
    const codeInput = document.getElementById('online-room-code');
    const code = (this.network?.roomId || codeInput?.value || '').trim();

    if (!code || code.startsWith('Génération')) {
      return;
    }

    const fallbackCopy = (text) => {
      const tempTextArea = document.createElement('textarea');
      tempTextArea.value = text;
      tempTextArea.setAttribute('readonly', '');
      tempTextArea.style.position = 'fixed';
      tempTextArea.style.top = '0';
      tempTextArea.style.left = '-9999px';
      tempTextArea.style.opacity = '0';
      document.body.appendChild(tempTextArea);
      tempTextArea.focus();
      tempTextArea.select();
      tempTextArea.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        console.warn('[Clipboard Fallback Error]', err);
      }
      document.body.removeChild(tempTextArea);
      return ok;
    };

    const showCopiedFeedback = () => {
      if (!btnCopy) return;
      if (this._copyCodeTimer) clearTimeout(this._copyCodeTimer);
      btnCopy.textContent = '✅ Code copié !';
      btnCopy.classList.add('copied');
      console.log('[UI Clipboard] Code de salon copié :', code);
      this._copyCodeTimer = setTimeout(() => {
        btnCopy.textContent = '🔑 Copier le code';
        btnCopy.classList.remove('copied');
        this._copyCodeTimer = null;
      }, 2000);
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      navigator.clipboard.writeText(code).then(showCopiedFeedback).catch(() => {
        fallbackCopy(code);
        showCopiedFeedback();
      });
    } else {
      fallbackCopy(code);
      showCopiedFeedback();
    }
  }

  _onNetPeerError(err) {
    console.warn('[P2P Status] Avertissement PeerJS :', err?.type || err);
    if (err?.type === 'room-full' && err?.message) {
      this._showLobbyToast(err.message);
    }
    this._refreshOnlineStatusUI();
  }

  _copyInviteLinkToClipboard() {
    const btnCopy = document.getElementById('btn-copy-invite');
    const urlInput = document.getElementById('online-invite-url');
    const inviteUrl = this.network.getInviteUrl() || (urlInput ? urlInput.value : '');

    if (!inviteUrl || inviteUrl.startsWith('Génération')) {
      return;
    }

    const fallbackCopyViaTextarea = (text) => {
      const tempTextArea = document.createElement('textarea');
      tempTextArea.value = text;
      tempTextArea.setAttribute('readonly', '');
      tempTextArea.style.position = 'fixed';
      tempTextArea.style.top = '0';
      tempTextArea.style.left = '-9999px';
      tempTextArea.style.opacity = '0';
      document.body.appendChild(tempTextArea);
      tempTextArea.focus();
      tempTextArea.select();
      tempTextArea.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        console.warn('[Clipboard Fallback Error]', err);
      }
      document.body.removeChild(tempTextArea);
      return ok;
    };

    const showCopiedFeedback = () => {
      if (!btnCopy) return;
      if (this._copyFeedbackTimer) {
        clearTimeout(this._copyFeedbackTimer);
      }
      btnCopy.textContent = '✅ Lien copié !';
      btnCopy.classList.add('copied');
      console.log('[UI Clipboard] Lien d’invitation copié :', inviteUrl);
      this._copyFeedbackTimer = setTimeout(() => {
        btnCopy.textContent = '📋 Copier le lien d’invitation';
        btnCopy.classList.remove('copied');
        this._copyFeedbackTimer = null;
      }, 2000);
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      navigator.clipboard.writeText(inviteUrl)
        .then(() => {
          showCopiedFeedback();
        })
        .catch(() => {
          fallbackCopyViaTextarea(inviteUrl);
          showCopiedFeedback();
        });
    } else {
      fallbackCopyViaTextarea(inviteUrl);
      showCopiedFeedback();
    }
  }

  _joinOnlineRoomAsGuest(roomId, guestPseudo) {
    const cleanRoomId = NetworkManager.normalizeRoomCode(roomId || '');
    if (!cleanRoomId) return;

    const pseudo = (guestPseudo || 'PILOTE').trim().slice(0, 18) || 'PILOTE';
    this.playerConfigs[1].name = pseudo;

    const guestNameInput = document.getElementById('online-guest-name');
    if (guestNameInput) guestNameInput.value = pseudo;

    const joinCodeInput = document.getElementById('online-join-code-input');
    if (joinCodeInput) joinCodeInput.value = cleanRoomId;

    const tabHost = document.getElementById('tab-online-role-host');
    const tabJoin = document.getElementById('tab-online-role-join');
    if (tabHost && tabJoin) {
      tabJoin.classList.add('active');
      tabHost.classList.remove('active');
    }

    this.activeGaragePlayer = 1;
    this.garageScene.updateCarConfig(1, { name: pseudo });

    this.network.initGuest(cleanRoomId, pseudo, this.playerConfigs[1]);
    this.setGameMode('ONLINE', { skipHostInit: true });
    console.log('[P2P Guest] Connexion directe au salon :', cleanRoomId, '| Pseudo :', pseudo);
  }

  _isGuestCustomizerLocked() {
    return Boolean(this.network && this.network.role === 'guest' && this.network.guestReady);
  }

  _broadcastLocalCarIfOnline() {
    if (!this.network || this.network.role === 'offline') return;
    const idx = this.network.role === 'guest' ? (this.network.mySlotIndex || 1) : 0;
    this.network.sendCarCustomization(idx, this.playerConfigs[idx]);
  }

  _broadcastRaceSettingsIfHost() {
    if (this.network && this.network.role === 'host') {
      this.network.sendRaceSettings(this.raceSettings);
    }
  }

  _onNetPeerConnected() {
    if (this.network.role === 'host') {
      this.network.sendHostWelcome(this.playerConfigs[0], this.raceSettings);
    }
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshOnlineStatusUI();
  }

  _onNetPeerDisconnected() {
    this._syncGarageCarsAndCamera();
    this._updateBotSelectorOptions();
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshOnlineStatusUI();
  }

  _onNetLobbyStateChange(info) {
    if (!info) return;

    if (Array.isArray(info.slots)) {
      for (let i = 0; i < 4; i++) {
        const s = info.slots[i];
        const isMyGuestSlot = this.network.role === 'guest' && i === this.network.mySlotIndex;
        const isMyHostSlot = this.network.role === 'host' && i === 0;
        const sCar = s ? (s.carConfig || s.car) : null;
        if (s && s.occupied && sCar) {
          if (!isMyGuestSlot && !isMyHostSlot) {
            this.garageScene.updateCarConfig(i, {
              ...sCar,
              name: s.name || sCar.name || `JOUEUR ${i + 1}`,
            });
          } else {
            this.playerConfigs[i].name = s.name || this.playerConfigs[i].name;
          }
        }
      }
    }

    if (this.network.role === 'guest') {
      const assignedIdx = this.network.mySlotIndex || 1;
      if (this.activeGaragePlayer !== assignedIdx) {
        const prevCfg = { ...this.playerConfigs[this.activeGaragePlayer] };
        this.activeGaragePlayer = assignedIdx;
        this.garageScene.updateCarConfig(assignedIdx, prevCfg);
        this.garageScene.setActivePlayer(assignedIdx);
      }
    }

    this._syncGarageCarsAndCamera();
    this._updateBotSelectorOptions();

    if (info.raceSettings && this.network.role === 'guest') {
      this._applySyncedRaceSettings(info.raceSettings);
    }

    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._syncCustomizerUI();
    this._refreshOnlineStatusUI();
  }

  _onNetRemoteCarUpdate(targetIndex, carCfg, senderName) {
    if (!carCfg) return;
    const slotIdx = Math.max(0, Math.min(3, Number(targetIndex) || 0));
    this.garageScene.updateCarConfig(slotIdx, {
      ...carCfg,
      name: senderName || carCfg.name || (slotIdx === 0 ? 'HÔTE' : `JOUEUR ${slotIdx + 1}`),
    });
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._syncCustomizerUI();
    this._refreshOnlineStatusUI();
  }

  _onNetGuestReadyChange(ready, guestCar, guestName) {
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshOnlineStatusUI();
  }

  _onNetRaceSettingsUpdate(settings) {
    if (this.network.role === 'guest' && settings) {
      this._applySyncedRaceSettings(settings);
    }
  }

  _applySyncedRaceSettings(settings) {
    if (settings.circuit) {
      this.setCircuitMode(settings.circuit, { fromNetwork: true });
    }
    if (settings.weather) {
      const wKey = WEATHER_KEY_BY_ID[String(settings.weather).toLowerCase()] || 'SUNNY';
      this.setWeatherMode(wKey, { fromNetwork: true });
    }
    if (settings.difficulty) {
      this.raceSettings.difficulty = settings.difficulty;
      const diffSlider = document.getElementById('setting-diff-slider');
      const diffVal = document.getElementById('setting-diff-val');
      const step = STEP_BY_DIFF[settings.difficulty] || 2;
      if (diffSlider) diffSlider.value = String(step);
      if (diffVal) diffVal.textContent = DIFF_LABEL_BY_KEY[settings.difficulty] || 'Moyen';
    }
    if (typeof settings.laps === 'number') {
      this.raceSettings.laps = settings.laps;
      const lapsSel = document.getElementById('setting-laps');
      if (lapsSel) lapsSel.value = String(settings.laps);
    }
    if (typeof settings.bots === 'number') {
      this.raceSettings.bots = settings.bots;
      this._updateBotSelectorOptions();
    }
    if (settings.engineSound) {
      this.raceSettings.engineSound = settings.engineSound;
      CONFIG.race.engineSound = settings.engineSound;
      soundManager.setEngineSoundMode(settings.engineSound);
      document.querySelectorAll('#engine-sound-selector button[data-engine-sound]').forEach((b) => {
        b.classList.toggle('active', b.dataset.engineSound === settings.engineSound);
      });
    }
  }

  /**
   * Met à jour les 4 cartes de la salle d'attente dynamique (`#online-slot-0` à `#online-slot-3`) :
   *  - Affiche le pseudo, le modèle de voiture choisi (`Supercar`, `Monoplace`, `Muscle GT`), la pastille couleur et le statut (`PRÊT` / `PAS PRÊT` / `LIBRE`).
   */
  _updateWaitingRoomSlotsUI() {
    const slots = this.network?.slots || [];
    const connectedCount = this.network ? this.network.getConnectedPlayerCount() : 1;

    const counterEl = document.getElementById('online-players-counter');
    if (counterEl) {
      counterEl.textContent = `${connectedCount} / 4 JOUEURS`;
    }

    for (let i = 0; i < 4; i++) {
      const card = document.getElementById(`online-slot-${i}`);
      if (!card) continue;

      const s = slots[i];
      const occupied = Boolean(s && s.occupied);
      const isMe = (this.network?.role === 'host' && i === 0)
        || (this.network?.role === 'guest' && i === (this.network?.mySlotIndex || 1));

      card.classList.toggle('occupied', occupied);
      card.classList.toggle('empty-slot', !occupied);
      card.classList.toggle('is-me', Boolean(occupied && isMe));

      const dotEl = card.querySelector('.slot-color-dot');
      const nameEl = card.querySelector('.slot-name');
      const carEl = card.querySelector('.slot-car');
      const statusEl = card.querySelector('.slot-status');

      if (occupied) {
        const carCfg = s.carConfig || s.car || this.playerConfigs[i] || DEFAULT_PLAYER_CARS[i] || DEFAULT_PLAYER_CARS[0];
        const bodyType = carCfg.bodyType || 'supercar';
        const modelLabel = VEHICLE_MODIFIERS[bodyType]?.label || 'Supercar GT';
        const colorHex = carCfg.color || '#00e5ff';
        const rawName = s.name || this.playerConfigs[i]?.name || (i === 0 ? 'HÔTE' : `JOUEUR ${i + 1}`);

        if (dotEl) {
          dotEl.style.background = colorHex;
          dotEl.style.color = colorHex;
        }
        if (nameEl) {
          nameEl.textContent = isMe ? `${rawName} (VOUS)` : rawName;
        }
        if (carEl) {
          carEl.textContent = `${modelLabel} · ${colorHex.toUpperCase()}`;
        }
        if (statusEl) {
          if (i === 0) {
            statusEl.textContent = 'HÔTE · PRÊT';
            statusEl.className = 'slot-status status-pill ready';
          } else if (s.ready) {
            statusEl.textContent = 'PRÊT';
            statusEl.className = 'slot-status status-pill ready';
          } else {
            statusEl.textContent = 'PAS PRÊT';
            statusEl.className = 'slot-status status-pill waiting';
          }
        }
      } else {
        if (dotEl) {
          dotEl.style.background = '#546e7a';
          dotEl.style.color = 'transparent';
        }
        if (nameEl) {
          nameEl.textContent = `Slot ${i + 1} disponible`;
        }
        if (carEl) {
          carEl.textContent = 'Remplacé par un Bot IA si vacant';
        }
        if (statusEl) {
          statusEl.textContent = 'LIBRE';
          statusEl.className = 'slot-status status-pill waiting';
        }
      }
    }
  }

  _update3DPodiumBadges() {
    const slots = this.network?.slots || [];

    const badgeIds = [
      { pseudo: 'tag-host-pseudo', status: 'tag-host-status', defaultName: 'HÔTE' },
      { pseudo: 'tag-guest-pseudo', status: 'tag-guest-status', defaultName: 'EN ATTENTE D’UN JOUEUR…' },
      { pseudo: 'tag-slot2-pseudo', status: 'tag-slot2-status', defaultName: 'SLOT 3 LIBRE' },
      { pseudo: 'tag-slot3-pseudo', status: 'tag-slot3-status', defaultName: 'SLOT 4 LIBRE' },
    ];

    for (let i = 0; i < 4; i++) {
      const pseudoEl = document.getElementById(badgeIds[i].pseudo);
      const statusEl = document.getElementById(badgeIds[i].status);
      const s = slots[i];
      const occupied = Boolean(s && s.occupied);

      if (i === 0) {
        const hostName = s?.name || this.playerConfigs[0]?.name || this.network?.hostName || 'HÔTE';
        if (pseudoEl) pseudoEl.textContent = hostName;
        if (statusEl) {
          statusEl.textContent = 'PRÊT · HÔTE';
          statusEl.className = 'tag-3d-status status-ready';
        }
      } else if (occupied) {
        const pName = s.name || this.playerConfigs[i]?.name || `JOUEUR ${i + 1}`;
        if (pseudoEl) pseudoEl.textContent = pName;
        if (statusEl) {
          statusEl.textContent = s.ready ? 'PRÊT' : 'PAS PRÊT';
          statusEl.className = `tag-3d-status ${s.ready ? 'status-ready' : 'status-waiting'}`;
        }
      } else {
        if (pseudoEl) pseudoEl.textContent = badgeIds[i].defaultName;
        if (statusEl) {
          statusEl.textContent = 'EN ATTENTE';
          statusEl.className = 'tag-3d-status status-waiting';
        }
      }
    }
  }

  _refreshOnlineStatusUI() {
    const isOnlineMode = this.currentGameMode === 'ONLINE';
    const isGuest = Boolean(this.network && this.network.role === 'guest');
    const isHost = Boolean(this.network && this.network.role === 'host');
    const guestReady = Boolean(this.network && this.network.guestReady);
    const canStartOnline = Boolean(this.network && this.network.canStartOnlineRace());
    const connectedCount = this.network ? this.network.getConnectedPlayerCount() : 1;

    this._updateLeaveGroupButtonVisibility();
    this._updateWaitingRoomSlotsUI();
    this._updateBotSelectorOptions();

    const onlineBox = document.getElementById('online-lobby-box');
    const roleTabs = document.querySelector('.online-role-tabs');
    const hostPanel = document.getElementById('online-host-panel');
    const joinPanel = document.getElementById('online-join-panel');
    const guestPanel = document.getElementById('online-guest-panel');

    if (onlineBox) {
      onlineBox.classList.toggle('hidden', !isOnlineMode);
    }
    if (roleTabs) {
      roleTabs.classList.remove('hidden');
    }
    if (guestPanel) {
      guestPanel.classList.toggle('hidden', !isGuest);
    }
    if (hostPanel && joinPanel) {
      if (isGuest) {
        hostPanel.classList.add('hidden');
        joinPanel.classList.add('hidden');
      } else {
        const isTabJoin = document.getElementById('tab-online-role-join')?.classList.contains('active');
        hostPanel.classList.toggle('hidden', isTabJoin);
        joinPanel.classList.toggle('hidden', !isTabJoin);
      }
    }

    const guestRoomCodeEl = document.getElementById('online-guest-room-code');
    if (guestRoomCodeEl && this.network?.roomId) {
      guestRoomCodeEl.textContent = this.network.roomId;
    }

    const tabReadyDot = document.getElementById('online-tab-ready-dot');
    const startReadyDot = document.getElementById('btn-start-ready-dot');
    const showGreenNotif = isHost && canStartOnline;
    if (tabReadyDot) tabReadyDot.classList.toggle('hidden', !showGreenNotif);
    if (startReadyDot) startReadyDot.classList.toggle('hidden', !(showGreenNotif && isOnlineMode));

    const hostGuestStatus = document.getElementById('online-guest-status');
    const pLabel = connectedCount > 1 ? 'JOUEURS' : 'JOUEUR';
    if (hostGuestStatus) {
      if (canStartOnline) {
        hostGuestStatus.textContent = `PRÊT À LANCER (${connectedCount} ${pLabel}) !`;
        hostGuestStatus.className = 'status-pill ready';
      } else {
        hostGuestStatus.textContent = `ATTENTE QUE TOUS SOIENT PRÊTS (${connectedCount}/4)…`;
        hostGuestStatus.className = 'status-pill waiting';
      }
    }

    const hostDisplayName = document.getElementById('online-host-display-name');
    if (hostDisplayName) {
      hostDisplayName.textContent = this.playerConfigs[0].name || this.network?.hostName || 'HÔTE';
    }
    const guestConnStatus = document.getElementById('online-guest-conn-status');
    if (guestConnStatus) {
      const slotLabel = `SLOT ${(this.network?.mySlotIndex || 1) + 1}`;
      if (guestReady) {
        guestConnStatus.textContent = `${slotLabel} · PRÊT (ATTENTE HÔTE)`;
        guestConnStatus.className = 'status-pill ready';
      } else if (this.network && this.network.connected) {
        guestConnStatus.textContent = `${slotLabel} · CONNECTÉ P2P (${connectedCount}/4)`;
        guestConnStatus.className = 'status-pill ready';
      } else {
        guestConnStatus.textContent = 'CONNEXION WEBRTC P2P…';
        guestConnStatus.className = 'status-pill waiting';
      }
    }

    const btnGuestReady = document.getElementById('btn-guest-ready');
    const guestNameInput = document.getElementById('online-guest-name');
    const locked = this._isGuestCustomizerLocked();
    if (btnGuestReady) {
      btnGuestReady.classList.toggle('hidden', !(isOnlineMode && isGuest));
      btnGuestReady.classList.toggle('is-ready', guestReady);
      btnGuestReady.textContent = guestReady
        ? '✕ PAS PRÊT (MODIFIER MA VOITURE)'
        : '✓ SE METTRE PRÊT';
    }
    if (guestNameInput) {
      guestNameInput.disabled = locked;
    }

    // Verrouillage des paramètres de session réservés à l'Hôte lorsque le joueur est Invité
    const hostOnlyElements = [
      document.getElementById('btn-all-random'),
      document.getElementById('circuit-selector'),
      document.getElementById('weather-selector'),
      document.getElementById('setting-diff-slider'),
      document.getElementById('setting-laps'),
      document.getElementById('setting-bots'),
    ];
    hostOnlyElements.forEach((el) => {
      if (el) {
        el.classList.toggle('host-only-locked', Boolean(isOnlineMode && isGuest));
      }
    });

    const btnStart = document.getElementById('btn-start-race');
    const startLabel = document.getElementById('btn-start-label');
    const startLock = document.getElementById('btn-start-lock');
    const startArrow = document.getElementById('btn-start-arrow');
    if (btnStart && startLabel) {
      if (isOnlineMode) {
        if (isGuest) {
          startLabel.textContent = 'EN ATTENTE DU LANCEMENT PAR L’HÔTE';
          btnStart.classList.add('locked-guest');
          btnStart.classList.remove('disabled-cta', 'online-ready-cta');
          btnStart.disabled = true;
          if (startLock) startLock.classList.remove('hidden');
          if (startArrow) startArrow.classList.add('hidden');
        } else {
          startLabel.textContent = canStartOnline
            ? `LANCER LA COURSE (${connectedCount} ${pLabel})`
            : `ATTENTE QUE TOUS SOIENT PRÊTS (${connectedCount}/4)`;
          btnStart.classList.remove('locked-guest');
          btnStart.classList.toggle('disabled-cta', !canStartOnline);
          btnStart.classList.toggle('online-ready-cta', canStartOnline);
          btnStart.disabled = !canStartOnline;
          if (startLock) startLock.classList.add('hidden');
          if (startArrow) startArrow.classList.remove('hidden');
        }
      } else {
        startLabel.textContent = 'LANCER LA COURSE';
        btnStart.classList.remove('locked-guest', 'disabled-cta', 'online-ready-cta');
        btnStart.disabled = false;
        if (startLock) startLock.classList.add('hidden');
        if (startArrow) startArrow.classList.remove('hidden');
      }
    }
  }

  _syncCustomizerUI() {
    const isOnlineMode = this.currentGameMode === 'ONLINE';
    const isGuest = Boolean(this.network && this.network.role === 'guest');
    const cfg = this.playerConfigs[this.activeGaragePlayer] || this.playerConfigs[0];
    const modeCount = this.raceSettings.playerCount;
    const isSoloOrSpec = !isOnlineMode && modeCount <= 1;

    const titleP1 = document.getElementById('tab-title-p1');
    const titleP2 = document.getElementById('tab-title-p2');
    const subP1 = document.getElementById('tab-sub-p1');
    const subP2 = document.getElementById('tab-sub-p2');

    if (isOnlineMode) {
      const mySlot = isGuest ? (this.network.mySlotIndex || 1) : 0;
      const myName = this.playerConfigs[mySlot]?.name || (isGuest ? 'PILOTE' : 'HÔTE');
      if (titleP1) titleP1.textContent = `${myName} (SLOT ${mySlot + 1})`;
      if (titleP2) titleP2.textContent = 'SALON P2P (2 À 4J)';
      if (subP1) subP1.textContent = 'Votre voiture · Plein Écran (ZQSD)';
      if (subP2) subP2.textContent = 'Voir la salle d’attente à droite';
    } else {
      if (titleP1) titleP1.textContent = 'JOUEUR 1';
      if (titleP2) titleP2.textContent = 'JOUEUR 2';
      if (subP1) {
        subP1.textContent = modeCount === 0
          ? 'Mode Spectateur (IA)'
          : modeCount === 1
            ? 'Plein Écran (ZQSD)'
            : 'Écran Gauche (ZQSD)';
      }
      if (subP2) subP2.textContent = 'Écran Droite (OKLM)';
    }

    document.querySelectorAll('[data-player-tab]').forEach((btn) => {
      const idx = Number(btn.dataset.playerTab);
      if (isOnlineMode) {
        btn.classList.toggle('active', idx === 0);
        btn.classList.toggle('disabled-tab', idx !== 0);
      } else {
        btn.classList.toggle('active', idx === this.activeGaragePlayer);
        btn.classList.toggle('disabled-tab', idx === 1 && isSoloOrSpec);
      }
    });

    const customizerPanel = document.getElementById('garage-customizer-panel');
    const lockBanner = document.getElementById('guest-lock-banner');
    const locked = this._isGuestCustomizerLocked();
    if (customizerPanel) customizerPanel.classList.toggle('locked-by-ready', locked);
    if (lockBanner) lockBanner.classList.toggle('hidden', !locked);

    const ctrlColP2 = document.getElementById('ctrl-col-p2');
    if (ctrlColP2) ctrlColP2.style.opacity = (isSoloOrSpec || isOnlineMode) ? '0.35' : '1';

    const bodyType = cfg.bodyType || 'supercar';
    document.querySelectorAll('#body-type-selector button[data-body-type]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.bodyType === bodyType);
    });

    this._updateVehicleStatBars(bodyType);

    const colorInput = document.getElementById('car-color-input');
    const colorHexLabel = document.getElementById('car-color-hex');
    colorInput.value = cfg.color;
    colorHexLabel.textContent = cfg.color.toUpperCase();
    this._updateSwatchSelection(cfg.color);
    this._updatePlayerTabBadges();

    document.querySelectorAll('#rim-type-selector button[data-rim-type]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.rimType === cfg.rims);
    });
    document.querySelectorAll('#rim-finish-selector button[data-rim-finish]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.rimFinish === cfg.rimFinish);
    });
    document.querySelectorAll('#spoiler-type-selector button[data-spoiler-type]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.spoilerType === cfg.spoiler);
    });
  }

  _updateVehicleStatBars(bodyType) {
    // Liaison dynamique directe avec computeVehicleStats (js/config.js) :
    // Toute modification de VEHICLE_MODIFIERS ou de CONFIG.car se reflète 1:1 en % dans le salon.
    const disp = getVehicleDisplayStats(bodyType);

    document.getElementById('stat-bar-speed').style.width = disp.speedBarWidth;
    document.getElementById('stat-val-speed').textContent = disp.speedText;

    document.getElementById('stat-bar-accel').style.width = disp.accelBarWidth;
    document.getElementById('stat-val-accel').textContent = disp.accelText;

    document.getElementById('stat-bar-grip').style.width = disp.gripBarWidth;
    document.getElementById('stat-val-grip').textContent = disp.gripText;
  }

  _updateSwatchSelection(hex) {
    const norm = hex.toLowerCase();
    document.querySelectorAll('[data-color-preset]').forEach((swatch) => {
      swatch.classList.toggle('active', swatch.dataset.colorPreset.toLowerCase() === norm);
    });
  }

  _updatePlayerTabBadges() {
    if (this.currentGameMode === 'ONLINE') {
      const mySlot = this.network?.role === 'guest' ? (this.network.mySlotIndex || 1) : 0;
      const dot1 = document.getElementById('tab-dot-p1');
      if (dot1 && this.playerConfigs[mySlot]) {
        dot1.style.background = this.playerConfigs[mySlot].color;
      }
      return;
    }
    for (let i = 0; i < 2; i++) {
      const dot = document.getElementById(`tab-dot-p${i + 1}`);
      if (dot && this.playerConfigs[i]) dot.style.background = this.playerConfigs[i].color;
    }
  }

  // ==========================================================================
  // 4. LANCEMENT DE COURSE (SOLO, ÉCRAN SCINDÉ, SPECTATEUR, 2 À 4J EN LIGNE P2P)
  // ==========================================================================

  _onClickStartRace() {
    if (this.currentGameMode === 'ONLINE') {
      if (this.network.role === 'guest') return;
      if (!this.network.canStartOnlineRace()) return;
      this._launchOnlineRaceAsHost();
      return;
    }
    this.resetRace(true);
  }

  _onClickRestartRace() {
    if (this.raceScene.isOnline) {
      if (this.network.role === 'host') {
        this._launchOnlineRaceAsHost();
      }
      return;
    }
    this.resetRace(false);
  }

  _launchOnlineRaceAsHost() {
    this.input.clearAll();
    soundManager.ensureStarted();
    soundManager.fadeOutLobbyMusic();
    this.isPaused = false;
    this.gameState = 'RACING';
    this.garageScene.setEnabled(false);

    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    document.getElementById('garage-overlay').classList.add('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('race-overlay').classList.remove('hidden');

    // Synchronise les configurations des 4 slots depuis le gestionnaire réseau
    for (let i = 0; i < 4; i++) {
      const s = this.network.slots[i];
      const sCar = s ? (s.carConfig || s.car) : null;
      if (s && s.occupied && sCar) {
        this.playerConfigs[i] = {
          ...this.playerConfigs[i],
          ...sCar,
          name: s.name || sCar.name || `JOUEUR ${i + 1}`,
        };
      }
    }

    const humanSlots = this.network.getOccupiedSlots();

    const resolvedWeather = this.raceSettings.weather === 'random'
      ? (['sunny', 'rain', 'storm'][Math.floor(Math.random() * 3)])
      : this.raceSettings.weather;

    let resolvedCircuit = this.raceSettings.circuit;
    if (resolvedCircuit === 'random') {
      const circuits = ['flat', 'mountain', 'valley', 'lake', 'grotto'];
      resolvedCircuit = circuits[Math.floor(Math.random() * circuits.length)];
    }

    const onlineSettings = {
      ...this.raceSettings,
      circuit: resolvedCircuit,
      weather: resolvedWeather,
      playerCount: humanSlots.length,
      humanSlots,
      myOnlineSlot: 0,
      isOnline: true,
      onlineRole: 'host',
    };

    this.raceScene.startRace(this.playerConfigs, onlineSettings);

    const tokenLayout = this.raceScene.boostTokens
      ? this.raceScene.boostTokens.exportTokenLayout()
      : null;

    this.network.sendStartOnlineRace({
      playerConfigs: this.playerConfigs,
      humanSlots,
      raceSettings: {
        ...this.raceSettings,
        circuit: resolvedCircuit,
        weather: resolvedWeather,
        playerCount: humanSlots.length,
        humanSlots,
        tokenLayout,
        botAIProfiles: this.raceScene.lastRaceSettings?.botAIProfiles,
        botNames: this.raceScene.lastRaceSettings?.botNames,
      },
    });
  }

  _onNetStartOnlineRace(payload) {
    if (!payload) return;
    this.input.clearAll();
    this.currentGameMode = 'ONLINE';
    this._refreshGameModeUI();

    if (Array.isArray(payload.playerConfigs)) {
      for (let i = 0; i < Math.min(4, payload.playerConfigs.length); i++) {
        if (payload.playerConfigs[i]) {
          this.garageScene.updateCarConfig(i, payload.playerConfigs[i]);
        }
      }
    }
    if (payload.raceSettings) {
      this._applySyncedRaceSettings(payload.raceSettings);
    }

    soundManager.ensureStarted();
    soundManager.fadeOutLobbyMusic();
    this.isPaused = false;
    this.gameState = 'RACING';
    this.garageScene.setEnabled(false);

    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    document.getElementById('garage-overlay').classList.add('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('race-overlay').classList.remove('hidden');

    const humanSlots = Array.isArray(payload.humanSlots)
      ? payload.humanSlots
      : (Array.isArray(payload.raceSettings?.humanSlots) ? payload.raceSettings.humanSlots : [0, 1]);

    const guestOnlineSettings = {
      ...this.raceSettings,
      ...(payload.raceSettings || {}),
      playerCount: humanSlots.length,
      humanSlots,
      myOnlineSlot: this.network.mySlotIndex || 1,
      isOnline: true,
      onlineRole: 'guest',
    };

    this.raceScene.startRace(this.playerConfigs, guestOnlineSettings);
  }

  resetRace(rebuildFromLobby = true) {
    this.input.clearAll();
    soundManager.ensureStarted();
    soundManager.fadeOutLobbyMusic();
    this.isPaused = false;
    this.gameState = 'RACING';
    this.garageScene.setEnabled(false);

    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    document.getElementById('garage-overlay').classList.add('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('race-overlay').classList.remove('hidden');

    if (rebuildFromLobby || this.raceScene.vehicles.length === 0) {
      let actualCircuit = this.raceSettings.circuit;
      if (actualCircuit === 'random') {
        const circuits = ['flat', 'mountain', 'valley', 'lake', 'grotto'];
        actualCircuit = circuits[Math.floor(Math.random() * circuits.length)];
      }

      this.raceScene.startRace(this.playerConfigs, {
        ...this.raceSettings,
        circuit: actualCircuit,
        isOnline: false,
      });
    } else {
      this.raceScene.resetRace();
    }
  }

  launchRace() {
    this._onClickStartRace();
  }

  returnToGarage() {
    this.input.clearAll();
    this.isPaused = false;
    this.gameState = 'LOBBY';
    soundManager.silenceRaceAudio();
    soundManager.fadeInLobbyMusic();
    this.garageScene.setEnabled(true);

    this._syncGarageCarsAndCamera();
    this._updateBotSelectorOptions();

    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    document.getElementById('race-overlay').classList.add('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('garage-overlay').classList.remove('hidden');
    this._update3DPodiumBadges();
    this._updateWaitingRoomSlotsUI();
    this._refreshGameModeUI();
    this._refreshWeatherUI();
    this._syncCustomizerUI();
    this._refreshOnlineStatusUI();
  }

  _onRaceFinished(standings) {
    this.isPaused = false;
    this.gameState = 'RESULTS';
    this._resultsRefreshTimer = 0;
    soundManager.silenceRaceAudio();
    this.hud.renderFinalResults(standings);
    document.getElementById('results-overlay').classList.remove('hidden');
  }

  enterSpectatorFromResults() {
    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.add('hidden');
      pauseOverlay.style.display = 'none';
    }
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('race-overlay').classList.remove('hidden');
    this.isPaused = false;
    this.gameState = 'RACING';
    this.raceScene.enterSpectatorMode();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.garageScene.onResize(w, h);
    this.raceScene.onResize(w, h);
  }

  /**
   * Boucle principale `requestAnimationFrame` unique (un seul `render()` par frame en plein écran).
   */
  _loop(now) {
    requestAnimationFrame((t) => this._loop(t));
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) * 0.001));
    this.lastTime = now;

    if (this.gameState === 'LOBBY') {
      this.garageScene.render(dt);
    } else if (this.gameState === 'RACING' && !this.isPaused) {
      this.raceScene.update(dt);
      this.raceScene.render();
    } else if (this.gameState === 'RESULTS') {
      this.raceScene.update(dt);
      this.raceScene.render();
      this._resultsRefreshTimer = (this._resultsRefreshTimer || 0) + dt;
      if (this._resultsRefreshTimer >= 0.35) {
        this._resultsRefreshTimer = 0;
        this.hud.renderFinalResults(this.raceScene.standings);
      }
    } else if (this.isPaused || this.gameState === 'PAUSED') {
      if (this.raceScene.isOnline) {
        this.raceScene.update(dt);
      }
      this.raceScene.render();
    }

    this.input.endFrame();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new RacingApp();
  window.racingApp = app;
  window.resetRace = () => app.resetRace(true);

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  if (params.get('body')) {
    app.garageScene.updateCarConfig(0, { bodyType: params.get('body') });
  }
  if (params.get('players')) {
    const raw = Number(params.get('players'));
    const modeKey = raw === 0 ? 'SPECTATOR' : raw === 1 ? 'SOLO' : 'SPLIT';
    app.setGameMode(modeKey);
  }
  if (params.get('circuit')) {
    app.setCircuitMode(params.get('circuit'));
  }
  if (params.get('weather')) {
    app.setWeatherMode(params.get('weather'));
  }
  app._syncCustomizerUI();

  // Détection automatique : si l'URL contient ?room=CODE, pré-remplit le code et tente la connexion immédiatement
  if (roomParam) {
    const cleanCode = NetworkManager.normalizeRoomCode(roomParam);
    app._pendingRoomId = cleanCode;

    // Nettoie l'URL immédiatement pour éviter qu'un rechargement ultérieur ne bloque en mode Invité
    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (_) {}

    const joinCodeInput = document.getElementById('online-join-code-input');
    if (joinCodeInput) {
      joinCodeInput.value = cleanCode;
    }

    const defaultPseudo = params.get('name')
      ? params.get('name').trim().slice(0, 18)
      : `PILOTE-${Math.floor(10 + Math.random() * 89)}`;

    app._joinOnlineRoomAsGuest(cleanCode, defaultPseudo);
    return;
  }

  if (params.get('mode') === 'race') {
    app.resetRace(true);
    if (params.get('skipCountdown') === '1') {
      app.raceScene.countdownTimer = 0.02;
      app.input.codes.add('KeyW');
      app.input.codes.add('KeyO');
      const steps = Number(params.get('steps') || 110);
      for (let i = 0; i < steps; i++) {
        app.raceScene.update(1 / 60);
      }
      app.input.codes.clear();
      app.raceScene.render();
    }
  }
});
