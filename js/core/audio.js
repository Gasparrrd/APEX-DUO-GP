/**
 * audio.js — Système Audio Complet avec Sélecteur « Moteur Électrique | Moteur Thermique » :
 *  1. Musique d'accueil du Salon (`LOBBY_MUSIC_URL = "./salon.mp3"`) :
 *     - Balise `<audio id="lobby-music" loop>` avec fondu sortant au départ et fondu entrant au retour
 *  2. Sélecteur de profil sonore moteur (`engineSoundMode = 'thermal' | 'electric'`) :
 *     - Profil Électrique (`'electric'`) :
 *         * Oscillateur harmonique montant linéairement en fréquence avec la vitesse
 *         * Sifflement technologique fluide (onduleur / turbine haute fréquence)
 *     - Profil Thermique (`'thermal'`) :
 *         * Deux oscillateurs `sawtooth` légèrement désaccordés (`+3 Hz` et `-3 Hz`) reproduisant
 *           le battement mécanique brut et le grondement sourd des cylindres
 *         * Saturation harmonique via un `WaveShaperNode` pour le timbre métallique d'un échappement libre
 *         * Simulation d'une boîte 5 rapports (montée en régime puis chute brève de pitch au passage)
 *         * Micro-pops étouffés (bruit blanc explosif très court filtré) lors des décélérations brutales
 *         * Au ralenti (véhicule à l'arrêt), maintien d'un « rumble » grave et stable à basse fréquence (~40–50 Hz)
 *  3. Effets sonores de course : ramassage des jetons de boost (normal +25% / rare +40%), boost, dérapage, collisions.
 */
import { clamp } from './utils.js?v=40';

export const LOBBY_MUSIC_URL = './salon.mp3';

/** Seuils des 5 rapports de boîte virtuels (km/h) pour le profil Thermique. */
const GEAR_THRESHOLDS_KMH = [0, 44, 86, 132, 182, 255];

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.thermalDistortionCurve = null;
    this.channels = []; // Un canal par joueur humain (0 = J1, 1 = J2)
    this.muted = false;
    this.active = false;

    // Mode sonore moteur sélectionné au menu ('thermal' | 'electric')
    this.engineSoundMode = 'thermal';

    // Gestion des volumes sonores (Salon & Moteur/Bruitages)
    this.lobbyMusicVolume = 0.70;
    this.engineVolume = 0.80;
    this.lobbyAudio = null;
    this.lobbyTargetVolume = 0.70 * 0.55;
    this.inLobby = true;
    this._fadeRafId = null;

    this._initLobbyMusicElement();

    const unlock = () => {
      this.ensureStarted();
      if (this.inLobby && !this._isRaceActive()) {
        this.playLobbyMusic();
      } else if (this._isRaceActive()) {
        this.stopLobbyMusicImmediately();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  /** Vérifie si une course est actuellement active (interdit strictement la musique du salon). */
  _isRaceActive() {
    if (!this.inLobby) return true;
    if (typeof window !== 'undefined' && window.racingApp && window.racingApp.gameState && window.racingApp.gameState !== 'LOBBY') {
      return true;
    }
    const raceOverlay = typeof document !== 'undefined' ? document.getElementById('race-overlay') : null;
    if (raceOverlay && !raceOverlay.classList.contains('hidden')) {
      return true;
    }
    return false;
  }

  /** Coupe immédiatement la musique du salon et annule tout fondu en cours. */
  stopLobbyMusicImmediately() {
    this.inLobby = false;
    if (this._fadeRafId) {
      cancelAnimationFrame(this._fadeRafId);
      this._fadeRafId = null;
    }
    if (this.lobbyAudio) {
      this.lobbyAudio.volume = 0;
      if (!this.lobbyAudio.paused) {
        try { this.lobbyAudio.pause(); } catch (_) {}
      }
    }
  }

  /**
   * Définit le profil sonore du moteur choisi dans le menu ('electric' | 'thermal').
   */
  setEngineSoundMode(mode = 'thermal') {
    this.engineSoundMode = mode === 'electric' ? 'electric' : 'thermal';
  }

  /** Règle le volume de la musique du salon (0.0 à 1.0). */
  setLobbyMusicVolume(vol = 0.70) {
    this.lobbyMusicVolume = clamp(Number(vol) || 0, 0, 1);
    this.lobbyTargetVolume = this.lobbyMusicVolume * 0.55;
    if (this.lobbyAudio && this.inLobby && !this._isRaceActive() && !this.muted) {
      this.lobbyAudio.volume = this.lobbyTargetVolume;
    }
  }

  /** Règle le volume général des moteurs et bruitages (0.0 à 1.0). */
  setEngineVolume(vol = 0.80) {
    this.engineVolume = clamp(Number(vol) || 0, 0, 1);
    if (this.masterGain && this.ctx) {
      const targetGain = this.muted ? 0 : this.engineVolume * 0.55;
      this.masterGain.gain.setValueAtTime(targetGain, this.ctx.currentTime);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Musique d'ambiance du Salon (MP3 externe avec fade-in / fade-out)     */
  /* ---------------------------------------------------------------------- */

  _initLobbyMusicElement() {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('lobby-music');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'lobby-music';
      el.loop = true;
      el.preload = 'auto';
      document.body?.appendChild(el);
    }
    if (!el.getAttribute('src')) {
      el.src = LOBBY_MUSIC_URL;
    }
    el.loop = true;
    el.volume = this.lobbyTargetVolume;
    this.lobbyAudio = el;
  }

  playLobbyMusic() {
    if (this._isRaceActive()) {
      this.stopLobbyMusicImmediately();
      return;
    }
    if (!this.lobbyAudio) this._initLobbyMusicElement();
    if (!this.lobbyAudio || this.muted) return;
    this.inLobby = true;
    if (this.lobbyAudio.paused) {
      this.lobbyAudio.volume = Math.max(0.05, this.lobbyAudio.volume || this.lobbyTargetVolume);
      const p = this.lobbyAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (!this.inLobby || this._isRaceActive()) {
            this.stopLobbyMusicImmediately();
          }
        }).catch(() => {});
      }
    }
  }

  fadeOutLobbyMusic(durationMs = 450) {
    this.inLobby = false;
    if (!this.lobbyAudio) return;
    if (this._fadeRafId) {
      cancelAnimationFrame(this._fadeRafId);
      this._fadeRafId = null;
    }
    if (durationMs <= 0) {
      this.stopLobbyMusicImmediately();
      return;
    }

    const audio = this.lobbyAudio;
    const startVol = audio.volume;
    const startTime = performance.now();

    const step = (now) => {
      if (this.inLobby) return;
      const t = clamp((now - startTime) / Math.max(1, durationMs), 0, 1);
      audio.volume = Math.max(0, startVol * (1 - t));
      if (t < 1 && !this.inLobby) {
        this._fadeRafId = requestAnimationFrame(step);
      } else if (!this.inLobby) {
        this._fadeRafId = null;
        audio.volume = 0;
        try { audio.pause(); } catch (_) {}
      }
    };
    this._fadeRafId = requestAnimationFrame(step);
  }

  fadeInLobbyMusic(durationMs = 950) {
    this.inLobby = true;
    if (this._isRaceActive()) {
      this.stopLobbyMusicImmediately();
      return;
    }
    if (!this.lobbyAudio) this._initLobbyMusicElement();
    if (!this.lobbyAudio || this.muted) return;
    if (this._fadeRafId) {
      cancelAnimationFrame(this._fadeRafId);
      this._fadeRafId = null;
    }

    const audio = this.lobbyAudio;
    const startVol = audio.paused ? 0.02 : audio.volume;
    audio.volume = startVol;
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (!this.inLobby || this._isRaceActive()) {
          this.stopLobbyMusicImmediately();
        }
      }).catch(() => {});
    }

    const targetVol = this.lobbyTargetVolume;
    const startTime = performance.now();

    const step = (now) => {
      if (!this.inLobby || this._isRaceActive()) {
        this.stopLobbyMusicImmediately();
        return;
      }
      const t = clamp((now - startTime) / Math.max(1, durationMs), 0, 1);
      audio.volume = clamp(startVol + (targetVol - startVol) * t, 0, 1);
      if (t < 1 && this.inLobby) {
        this._fadeRafId = requestAnimationFrame(step);
      } else {
        this._fadeRafId = null;
      }
    };
    this._fadeRafId = requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------------------- */
  /*  Initialisation Web Audio API & Courbe de Saturation (`WaveShaperNode`)*/
  /* ---------------------------------------------------------------------- */

  ensureStarted() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : (this.engineVolume ?? 0.8) * 0.55;
      this.masterGain.connect(this.ctx.destination);

      this.noiseBuffer = this._createWhiteNoiseBuffer(2.0);
      this.thermalDistortionCurve = this._createThermalExhaustCurve(3.1);
      this.channels = [
        this._createPlayerChannel(-0.55),
        this._createPlayerChannel(0.55),
      ];
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.active = true;
    return true;
  }

  /**
   * Courbe de saturation harmonique (`WaveShaperNode`) donnant le timbre métallique
   * et nerveux d'un échappement libre pour le moteur Thermique.
   */
  _createThermalExhaustCurve(drive = 3.1) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const norm = Math.tanh(drive);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.tanh((x + 0.14 * x * x) * drive) / norm;
    }
    return curve;
  }

  _createWhiteNoiseBuffer(durationSec = 2.0) {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Crée un canal joueur comportant les deux moteurs synthétiques :
   *  - Branche A : Profil Thermique (2 oscillateurs `sawtooth` désaccordés de +/- 3 Hz + `WaveShaperNode`)
   *  - Branche B : Profil Électrique (oscillateur harmonique linéaire + sifflement technologique fluide)
   */
  _createPlayerChannel(defaultPan = 0) {
    const ctx = this.ctx;

    const panner = ctx.createStereoPanner
      ? ctx.createStereoPanner()
      : ctx.createGain();
    if (panner.pan) panner.pan.value = defaultPan;
    panner.connect(this.masterGain);

    /* --- 1. Branche Moteur THERMIQUE (2x sawtooth +/- 3 Hz + WaveShaper) --- */
    const sawA = ctx.createOscillator();
    sawA.type = 'sawtooth';
    sawA.frequency.value = 42; // Base ~45 Hz - 3 Hz

    const sawB = ctx.createOscillator();
    sawB.type = 'sawtooth';
    sawB.frequency.value = 48; // Base ~45 Hz + 3 Hz

    // Sous-harmonique grave renforçant le rumble à 40–50 Hz au ralenti
    const subRumble = ctx.createOscillator();
    subRumble.type = 'triangle';
    subRumble.frequency.value = 45;

    const sawMix = ctx.createGain();
    sawMix.gain.value = 0.48;

    const subRumbleGain = ctx.createGain();
    subRumbleGain.gain.value = 0.55;

    sawA.connect(sawMix);
    sawB.connect(sawMix);
    subRumble.connect(subRumbleGain);

    // Filtre dynamique avant saturation
    const thermalFilter = ctx.createBiquadFilter();
    thermalFilter.type = 'lowpass';
    thermalFilter.frequency.value = 280;
    thermalFilter.Q.value = 2.6;

    sawMix.connect(thermalFilter);
    subRumbleGain.connect(thermalFilter);

    // Saturation harmonique WaveShaperNode (timbre métallique d'échappement libre)
    const thermalShaper = ctx.createWaveShaper();
    thermalShaper.curve = this.thermalDistortionCurve;
    thermalShaper.oversample = '2x';

    // Filtre post-saturation d'échappement
    const thermalCabinet = ctx.createBiquadFilter();
    thermalCabinet.type = 'lowpass';
    thermalCabinet.frequency.value = 2200;
    thermalCabinet.Q.value = 0.8;

    const thermalGain = ctx.createGain();
    thermalGain.gain.value = 0;

    thermalFilter.connect(thermalShaper);
    thermalShaper.connect(thermalCabinet);
    thermalCabinet.connect(thermalGain);
    thermalGain.connect(panner);

    sawA.start();
    sawB.start();
    subRumble.start();

    /* --- 2. Branche Moteur ÉLECTRIQUE (montée linéaire + sifflement fluide) --- */
    const elecBaseOsc = ctx.createOscillator();
    elecBaseOsc.type = 'triangle';
    elecBaseOsc.frequency.value = 75;

    const elecHarmOsc = ctx.createOscillator();
    elecHarmOsc.type = 'sine';
    elecHarmOsc.frequency.value = 225; // Harmonique technologique 3x

    const elecWhineOsc = ctx.createOscillator();
    elecWhineOsc.type = 'sine';
    elecWhineOsc.frequency.value = 600; // Sifflement fluide d'onduleur

    const elecBaseGain = ctx.createGain();
    elecBaseGain.gain.value = 0.55;

    const elecHarmGain = ctx.createGain();
    elecHarmGain.gain.value = 0.28;

    const elecWhineGain = ctx.createGain();
    elecWhineGain.gain.value = 0.14;

    const elecFilter = ctx.createBiquadFilter();
    elecFilter.type = 'bandpass';
    elecFilter.frequency.value = 420;
    elecFilter.Q.value = 0.9;

    const elecGain = ctx.createGain();
    elecGain.gain.value = 0;

    elecBaseOsc.connect(elecBaseGain);
    elecHarmOsc.connect(elecHarmGain);
    elecWhineOsc.connect(elecWhineGain);

    elecBaseGain.connect(elecFilter);
    elecHarmGain.connect(elecFilter);
    elecFilter.connect(elecGain);
    elecWhineGain.connect(elecGain);
    elecGain.connect(panner);

    elecBaseOsc.start();
    elecHarmOsc.start();
    elecWhineOsc.start();

    /* --- 3. Effet de Boost (Nitro) --- */
    const boostOsc = ctx.createOscillator();
    boostOsc.type = 'triangle';
    boostOsc.frequency.value = 210;

    const boostOscGain = ctx.createGain();
    boostOscGain.gain.value = 0;
    boostOsc.connect(boostOscGain);
    boostOscGain.connect(panner);
    boostOsc.start();

    const boostNoise = ctx.createBufferSource();
    boostNoise.buffer = this.noiseBuffer;
    boostNoise.loop = true;

    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'bandpass';
    boostFilter.frequency.value = 1100;
    boostFilter.Q.value = 1.4;

    const boostNoiseGain = ctx.createGain();
    boostNoiseGain.gain.value = 0;

    boostNoise.connect(boostFilter);
    boostFilter.connect(boostNoiseGain);
    boostNoiseGain.connect(panner);
    boostNoise.start();

    /* --- 4. Dérapage / Crépitement des pneus --- */
    const skidNoise = ctx.createBufferSource();
    skidNoise.buffer = this.noiseBuffer;
    skidNoise.loop = true;

    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1050;
    skidFilter.Q.value = 4.2;

    const skidGain = ctx.createGain();
    skidGain.gain.value = 0;

    skidNoise.connect(skidFilter);
    skidFilter.connect(skidGain);
    skidGain.connect(panner);
    skidNoise.start();

    /* --- 5. Effet d'Écho / Réverbération dans le Tunnel (Web Audio API Delay + Filtre de résonance rocheuse) --- */
    const tunnelDelay = ctx.createDelay(0.5);
    tunnelDelay.delayTime.value = 0.085; // 85 ms de réflexion acoustique sur les parois rocheuses
    const tunnelFilter = ctx.createBiquadFilter();
    tunnelFilter.type = 'bandpass';
    tunnelFilter.frequency.value = 540;
    tunnelFilter.Q.value = 0.85;
    const tunnelFeedback = ctx.createGain();
    tunnelFeedback.gain.value = 0.44;
    const tunnelWetGain = ctx.createGain();
    tunnelWetGain.gain.value = 0; // Désactivé hors du tunnel, activé progressivement sous la roche

    panner.connect(tunnelDelay);
    tunnelDelay.connect(tunnelFilter);
    tunnelFilter.connect(tunnelFeedback);
    tunnelFeedback.connect(tunnelDelay);
    tunnelFilter.connect(tunnelWetGain);
    tunnelWetGain.connect(this.masterGain);

    return {
      panner,
      tunnelWetGain,
      inTunnel: false,
      // Thermique
      sawA,
      sawB,
      subRumble,
      subRumbleGain,
      thermalFilter,
      thermalGain,
      // Électrique
      elecBaseOsc,
      elecHarmOsc,
      elecWhineOsc,
      elecWhineGain,
      elecFilter,
      elecGain,
      // Boost & Pneus
      boostOsc,
      boostOscGain,
      boostFilter,
      boostNoiseGain,
      skidFilter,
      skidGain,
      boostPitch: 210,
      // État boîte 5 rapports & détection de décélération brutale
      currentGear: 1,
      shiftTimer: 0,
      smoothRpm: 0.16,
      prevThrottle: 0,
      prevSpeedKmh: 0,
      lastPopTime: 0,
      lastUpdateTime: 0,
    };
  }

  /**
   * Déclenche 1 à 3 micro-pops étouffés (bruit blanc explosif très court filtré)
   * lors des décélérations brutales en mode Thermique.
   */
  _triggerThermalExhaustPops(ch, popCount = 2) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.noiseBuffer) return;

    const ctx = this.ctx;
    const baseNow = ctx.currentTime;

    for (let p = 0; p < popCount; p++) {
      const t0 = baseNow + 0.025 + p * (0.055 + Math.random() * 0.055);
      const dur = 0.032 + Math.random() * 0.020; // Bruit blanc explosif très court
      const amp = (0.16 + Math.random() * 0.07) * (1 - p * 0.18);

      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const offset = Math.random() * Math.max(0.1, this.noiseBuffer.duration - 0.15);

      // Filtre passe-bas / passe-bande étouffé d'échappement
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(180 + Math.random() * 110, t0);
      filter.Q.setValueAtTime(1.6, t0);

      const shaper = ctx.createWaveShaper();
      shaper.curve = this.thermalDistortionCurve;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.linearRampToValueAtTime(amp, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

      noise.connect(filter);
      filter.connect(shaper);
      shaper.connect(gain);
      gain.connect(ch.panner);

      noise.start(t0, offset, dur + 0.01);
      noise.stop(t0 + dur + 0.01);
    }
  }

  /**
   * Simule le passage de 5 rapports de boîte (montée en régime puis chute brève de pitch).
   */
  _updateThermalGearbox(ch, speedKmh, throttle, now) {
    const dt = ch.lastUpdateTime > 0 ? clamp(now - ch.lastUpdateTime, 0.001, 0.1) : 1 / 60;
    ch.lastUpdateTime = now;

    const s = Math.max(0, speedKmh);
    let targetGear = 1;
    for (let g = 1; g < GEAR_THRESHOLDS_KMH.length; g++) {
      if (s >= GEAR_THRESHOLDS_KMH[g]) targetGear = g + 1;
    }
    targetGear = clamp(targetGear, 1, GEAR_THRESHOLDS_KMH.length - 1);

    if (targetGear > ch.currentGear && s > 18) {
      ch.shiftTimer = 0.14; // Chute brève de pitch au passage de rapport
      ch.currentGear = targetGear;
    } else if (targetGear < ch.currentGear) {
      ch.currentGear = targetGear;
    }

    if (ch.shiftTimer > 0) {
      ch.shiftTimer = Math.max(0, ch.shiftTimer - dt);
    }

    const low = GEAR_THRESHOLDS_KMH[ch.currentGear - 1];
    const high = GEAR_THRESHOLDS_KMH[ch.currentGear];
    const inGearRatio = clamp((s - low) / Math.max(1, high - low), 0, 1);

    const gearMinRpm = ch.currentGear === 1 ? 0.0 : 0.34;
    const gearSpan = ch.currentGear === 1 ? 0.92 : 0.62;
    let targetRpm = gearMinRpm + Math.pow(inGearRatio, 0.92) * gearSpan + throttle * 0.08;

    if (ch.shiftTimer > 0) {
      targetRpm *= 0.70;
    }

    const rpmRate = targetRpm > ch.smoothRpm ? 12.0 : 9.0;
    ch.smoothRpm += (targetRpm - ch.smoothRpm) * (1 - Math.exp(-rpmRate * dt));
    return clamp(ch.smoothRpm, 0.0, 1.05);
  }

  /**
   * Met à jour l'audio en course selon le profil sélectionné (« Électrique » ou « Thermique »).
   */
  updateRaceAudio(players, playerCount = 1, isPaused = false) {
    // Sécurité absolue : coupe immédiatement la musique du salon dès que l'audio de course tourne
    if (this.inLobby || (this.lobbyAudio && !this.lobbyAudio.paused && !this._fadeRafId)) {
      this.stopLobbyMusicImmediately();
    }
    if (!this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const tau = 0.032;
    const isElectric = this.engineSoundMode === 'electric';

    for (let i = 0; i < 2; i++) {
      const ch = this.channels[i];
      if (!ch) continue;

      const activePlayer = !isPaused && i < playerCount ? players[i] : null;
      if (!activePlayer || activePlayer.parkingLocked) {
        ch.thermalGain.gain.setTargetAtTime(0, now, 0.05);
        ch.elecGain.gain.setTargetAtTime(0, now, 0.05);
        ch.boostOscGain.gain.setTargetAtTime(0, now, 0.05);
        ch.boostNoiseGain.gain.setTargetAtTime(0, now, 0.05);
        ch.skidGain.gain.setTargetAtTime(0, now, 0.05);
        if (ch.tunnelWetGain) ch.tunnelWetGain.gain.setTargetAtTime(0, now, 0.05);
        ch.inTunnel = false;
        continue;
      }

      // Résonance et écho sous le tunnel rocheux (activé uniquement dans les coordonnées du tunnel)
      const inTunnelNow = Boolean(activePlayer.inTunnel);
      ch.inTunnel = inTunnelNow;
      if (ch.tunnelWetGain) {
        ch.tunnelWetGain.gain.setTargetAtTime(inTunnelNow ? 0.58 : 0.0, now, 0.075);
      }

      if (ch.panner.pan) {
        const targetPan = playerCount === 1 ? 0 : (i === 0 ? -0.55 : 0.55);
        ch.panner.pan.setTargetAtTime(targetPan, now, tau);
      }

      const speedKmh = activePlayer.speedKmh || 0;
      const throttle = activePlayer.finished
        ? 0
        : Math.max(activePlayer.controls?.throttle || 0, activePlayer.isBoosting ? 1 : 0);
      const brake = activePlayer.controls?.brake || 0;

      const pitchMult = activePlayer.bodyType === 'formula'
        ? 1.18
        : activePlayer.bodyType === 'muscle'
          ? 0.84
          : 1.0;

      if (isElectric) {
        /* --- Mode Moteur ÉLECTRIQUE : montée linéaire en fréquence + sifflement fluide --- */
        ch.thermalGain.gain.setTargetAtTime(0, now, 0.04);

        const speedRatio = clamp(speedKmh / 240, 0, 1.2);
        const elecFreq = (68 + speedRatio * 340) * pitchMult;
        const whineFreq = (420 + speedRatio * 1850) * pitchMult;

        ch.elecBaseOsc.frequency.setTargetAtTime(elecFreq, now, tau);
        ch.elecHarmOsc.frequency.setTargetAtTime(elecFreq * 3.0, now, tau);
        ch.elecWhineOsc.frequency.setTargetAtTime(whineFreq, now, tau);
        ch.elecWhineGain.gain.setTargetAtTime(0.06 + speedRatio * 0.14 + throttle * 0.06, now, tau);
        ch.elecFilter.frequency.setTargetAtTime(260 + speedRatio * 1400 + throttle * 420, now, tau);

        const elecVol = 0.045 + speedRatio * 0.065 + throttle * 0.055;
        ch.elecGain.gain.setTargetAtTime(elecVol, now, tau);
      } else {
        /* --- Mode Moteur THERMIQUE : 2x sawtooth (+/- 3 Hz) + WaveShaper + 5 rapports + rumble 45 Hz --- */
        ch.elecGain.gain.setTargetAtTime(0, now, 0.04);

        const rpm = this._updateThermalGearbox(ch, speedKmh, throttle, now);

        // Détection de décélération brutale (lâcher de gaz à haut régime ou freinage fort) -> micro-pops étouffés
        const suddenLift = ch.prevThrottle > 0.55 && throttle < 0.15 && rpm > 0.45 && speedKmh > 50;
        const hardBraking = brake > 0.5 && (ch.prevSpeedKmh - speedKmh) > 1.8 && speedKmh > 60;
        if ((suddenLift || hardBraking) && now - ch.lastPopTime > 0.42) {
          ch.lastPopTime = now;
          const pops = 1 + Math.floor(Math.random() * 3); // 1 à 3 micro-pops étouffés
          this._triggerThermalExhaustPops(ch, pops);
        }
        ch.prevThrottle = throttle;
        ch.prevSpeedKmh = speedKmh;

        // Au ralenti (véhicule à l'arrêt), maintient un « rumble » grave et stable à basse fréquence (~45 Hz)
        // En roulage, monte en régime sur chacun des 5 rapports avec chute brève au passage de vitesse
        const idleRumbleHz = 45 * pitchMult;
        const thermalFreq = idleRumbleHz + rpm * 125 * pitchMult;

        // Deux oscillateurs sawtooth légèrement désaccordés (+3 Hz et -3 Hz)
        ch.sawA.frequency.setTargetAtTime(Math.max(30, thermalFreq - 3.0), now, tau);
        ch.sawB.frequency.setTargetAtTime(Math.max(36, thermalFreq + 3.0), now, tau);
        ch.subRumble.frequency.setTargetAtTime(Math.max(38, thermalFreq * 0.5 + 22), now, tau);

        // Renforce le rumble grave au ralenti (~40-50 Hz)
        const idleWeight = clamp(1 - speedKmh / 25, 0.25, 1.0);
        ch.subRumbleGain.gain.setTargetAtTime(0.45 + idleWeight * 0.30, now, tau);

        const shiftMute = ch.shiftTimer > 0 ? 0.58 : 1.0;
        const filterCutoff = (185 + rpm * 820 + Math.pow(throttle, 0.85) * 1150) * shiftMute;
        ch.thermalFilter.frequency.setTargetAtTime(filterCutoff, now, tau);
        ch.thermalFilter.Q.setTargetAtTime(2.2 + throttle * 1.6, now, tau);

        const thermalVol = (0.068 + throttle * 0.065 + rpm * 0.042) * shiftMute;
        ch.thermalGain.gain.setTargetAtTime(thermalVol, now, 0.025);
      }

      // Effet de Boost (Nitro)
      if (activePlayer.isBoosting) {
        ch.boostPitch = Math.min(560, ch.boostPitch + 14);
        ch.boostOsc.frequency.setTargetAtTime(ch.boostPitch, now, 0.03);
        ch.boostFilter.frequency.setTargetAtTime(880 + ch.boostPitch * 1.5, now, 0.03);
        ch.boostOscGain.gain.setTargetAtTime(0.055, now, 0.03);
        ch.boostNoiseGain.gain.setTargetAtTime(0.10, now, 0.03);
      } else {
        ch.boostPitch = Math.max(210, ch.boostPitch - 22);
        ch.boostOscGain.gain.setTargetAtTime(0, now, 0.05);
        ch.boostNoiseGain.gain.setTargetAtTime(0, now, 0.05);
      }

      // Dérapage / Crépitement des pneus
      const slip = activePlayer.slipAngle || 0;
      if (activePlayer.isDrifting && speedKmh > 22) {
        const skidIntensity = clamp((slip - 0.15) * 2.2, 0.05, 0.22);
        const skidFreq = 920 + clamp(speedKmh * 2.2, 0, 480);
        ch.skidFilter.frequency.setTargetAtTime(skidFreq, now, 0.03);
        ch.skidGain.gain.setTargetAtTime(skidIntensity, now, 0.03);
      } else {
        ch.skidGain.gain.setTargetAtTime(0, now, 0.05);
      }
    }
  }

  /** Coupe les sons de course (ex. retour au garage ou pause). */
  silenceRaceAudio() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const ch of this.channels) {
      if (!ch) continue;
      ch.thermalGain.gain.setTargetAtTime(0, now, 0.04);
      ch.elecGain.gain.setTargetAtTime(0, now, 0.04);
      ch.boostOscGain.gain.setTargetAtTime(0, now, 0.04);
      ch.boostNoiseGain.gain.setTargetAtTime(0, now, 0.04);
      ch.skidGain.gain.setTargetAtTime(0, now, 0.04);
      if (ch.tunnelWetGain) ch.tunnelWetGain.gain.setTargetAtTime(0, now, 0.04);
      ch.inTunnel = false;
    }
  }

  /**
   * Joue un son énergétique lors du ramassage d'un jeton de boost (+25% normal ou +40% rare).
   */
  playBoostPickup(isRare = false, pan = 0) {
    if (!this.ensureStarted() || !this.ctx || this.ctx.state !== 'running') return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (out.pan) out.pan.value = clamp(pan, -0.8, 0.8);
    out.connect(this.masterGain);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = isRare ? 587.33 : 440;
    const f1 = isRare ? 1174.66 : 880;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + (isRare ? 0.22 : 0.15));

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(isRare ? 0.22 : 0.16, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isRare ? 0.26 : 0.18));

    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + (isRare ? 0.28 : 0.20));
  }

  /**
   * Joue un signal sonore descendant d'alerte lors du contact avec un jeton ralentisseur rouge (-25%).
   */
  playSlowdownPickup(pan = 0) {
    if (!this.ensureStarted() || !this.ctx || this.ctx.state !== 'running') return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (out.pan) out.pan.value = clamp(pan, -0.8, 0.8);
    out.connect(this.masterGain);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(360, now);
    osc.frequency.exponentialRampToValueAtTime(115, now + 0.28);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(920, now);
    filter.frequency.exponentialRampToValueAtTime(240, now + 0.28);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.30);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  /**
   * Joue un impact sonore sourd lors d'une collision contre une barrière ou un autre véhicule.
   */
  playCollision(intensity = 0.5, pan = 0) {
    if (!this.ensureStarted() || !this.ctx || this.ctx.state !== 'running') return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const power = clamp(intensity, 0.12, 1.0);

    const out = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (out.pan) out.pan.value = clamp(pan, -0.8, 0.8);
    out.connect(this.masterGain);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(105 + power * 45, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.16);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.28 * power, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(oscGain);
    oscGain.connect(out);
    osc.start(now);
    osc.stop(now + 0.19);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(340 + power * 420, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.24 * power, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(now);
    noise.stop(now + 0.14);
  }

  playCountdownBeep(isGo = false) {
    if (!this.ensureStarted() || !this.ctx || this.ctx.state !== 'running') return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = isGo ? 0.46 : 0.15;
    const freq = isGo ? 880 : 440;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(isGo ? 0.22 : 0.16, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    const harmGain = ctx.createGain();
    harmGain.gain.value = 0.25;

    osc.connect(gain);
    osc2.connect(harmGain);
    harmGain.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc2.start(now);
    osc.stop(now + duration + 0.02);
    osc2.stop(now + duration + 0.02);
  }
}

export const soundManager = (typeof globalThis !== 'undefined' && globalThis.__apexSoundManager)
  ? globalThis.__apexSoundManager
  : (typeof globalThis !== 'undefined' ? (globalThis.__apexSoundManager = new SoundManager()) : new SoundManager());
