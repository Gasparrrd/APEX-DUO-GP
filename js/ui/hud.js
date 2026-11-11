/**
 * hud.js — Contrôleur du HUD (tête haute) pour :
 *  - Mode Solo (100% plein écran)
 *  - Mode 2 Joueurs (Écran Scindé 50%/50%)
 *  - Mode Spectateur (Plein écran 100%, masquage des compteurs joueurs, bandeau large en bas d'écran)
 *  - Mini-carte temps réel (jusqu'à 7 véhicules) et Écran de Classement Final avec accès Spectateur.
 */
import { CONFIG } from '../config.js?v=39';
import { clamp, formatTime, ordinalFr } from '../core/utils.js?v=39';
import * as THREE from 'three';

const _hudFwd = new THREE.Vector3();
const _hudRight = new THREE.Vector3();

export class HUDController {
  constructor() {
    this.raceOverlay = document.getElementById('race-overlay');
    this.splitDivider = document.getElementById('split-divider');
    this.hudLeft = document.querySelector('.hud-left');
    this.hudRight = document.querySelector('.hud-right');

    // Éléments HUD Mode Spectateur & Télémétrie dynamique
    this.spectatorHud = document.getElementById('spectator-hud');
    this.spectatorTelemetry = document.getElementById('spectator-telemetry-cluster');
    this.spectatorDriverName = document.getElementById('spectator-driver-name');
    this.spectatorDriverLap = document.getElementById('spectator-driver-lap');
    this.btnSpecResults = document.getElementById('btn-spec-results');
    this.specSpeedValue = document.getElementById('spec-speed');
    this.specSpeedArc = document.getElementById('spec-speed-arc');
    this.specBoostBar = document.getElementById('spec-boost-bar');
    this.specBoostPct = document.getElementById('spec-boost-pct');
    this.specBoostWrap = document.getElementById('spec-boost-wrap');
    this.specWindBox = document.getElementById('spec-wind-box');
    this.specWindArrow = document.getElementById('spec-wind-arrow');
    this.specWindStatus = document.getElementById('spec-wind-status');

    this.panels = [0, 1].map((idx) => {
      const p = idx + 1;
      return {
        hudPanel: idx === 0 ? this.hudLeft : this.hudRight,
        driverTag: document.querySelector(`.p${p}-tag`),
        speedValue: document.getElementById(`p${p}-speed`),
        speedArc: document.getElementById(`p${p}-speed-arc`),
        boostBar: document.getElementById(`p${p}-boost-bar`),
        boostPct: document.getElementById(`p${p}-boost-pct`),
        boostWrap: document.getElementById(`p${p}-boost-wrap`),
        cpBonus: document.getElementById(`p${p}-cp-bonus`),
        lapText: document.getElementById(`p${p}-lap`),
        lapTime: document.getElementById(`p${p}-lap-time`),
        rankNum: document.getElementById(`p${p}-rank`),
        rankTotal: document.getElementById(`p${p}-rank-total`),
        wrongWay: document.getElementById(`p${p}-wrong-way`),
        finishedBanner: document.getElementById(`p${p}-finished`),
        windBox: document.getElementById(`p${p}-wind-box`),
        windArrow: document.getElementById(`p${p}-wind-arrow`),
        windStatus: document.getElementById(`p${p}-wind-status`),
      };
    });

    this.playerCount = 2;
    this.isSpectator = false;
    this.countdownEl = document.getElementById('race-countdown');
    this.envBadgeEl = document.getElementById('hud-env-badge');
    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this.layout = null;
    this.trackPath2D = null;
  }

  /** Affiche la météo active et le niveau d'adhérence générale sur le HUD. */
  setEnvironmentBadge(weatherLabel) {
    if (this.envBadgeEl) {
      this.envBadgeEl.textContent = weatherLabel;
    }
  }

  /**
   * Bascule l'affichage du HUD entre :
   *  - Mode Spectateur (`isSpectator = true` ou `count === 0`) : plein écran, masque les compteurs joueurs
   *  - Mode Solo (`count === 1`) : plein écran J1
   *  - Mode 2 Joueurs (`count === 2`) : écran scindé 50% / 50%
   */
  setPlayerCount(count, isSpectator = false) {
    this.playerCount = Number(count);
    this.isSpectator = Boolean(isSpectator || this.playerCount === 0);

    if (this.isSpectator) {
      if (this.raceOverlay) this.raceOverlay.classList.add('solo-mode');
      if (this.splitDivider) this.splitDivider.classList.add('hidden');
      if (this.hudLeft) this.hudLeft.classList.add('hidden');
      if (this.hudRight) this.hudRight.classList.add('hidden');
      if (this.spectatorHud) this.spectatorHud.classList.remove('hidden');
      if (this.spectatorTelemetry) this.spectatorTelemetry.classList.remove('hidden');
      return;
    }

    const isSolo = this.playerCount === 1;
    if (this.raceOverlay) this.raceOverlay.classList.toggle('solo-mode', isSolo);
    if (this.splitDivider) this.splitDivider.classList.toggle('hidden', isSolo);
    if (this.hudLeft) this.hudLeft.classList.remove('hidden');
    if (this.hudRight) this.hudRight.classList.toggle('hidden', isSolo);
    if (this.spectatorHud) this.spectatorHud.classList.add('hidden');
    if (this.spectatorTelemetry) this.spectatorTelemetry.classList.add('hidden');
  }

  /** Précalcule le tracé sur la mini-carte. */
  initMinimap(layout) {
    this.layout = layout;
    if (!this.minimapCanvas) return;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const b = layout.bounds;
    const pad = 16;
    const scale = Math.min(
      (w - 2 * pad) / (b.max.x - b.min.x),
      (h - 2 * pad) / (b.max.z - b.min.z)
    );
    const ox = (w - (b.max.x - b.min.x) * scale) * 0.5 - b.min.x * scale;
    const oz = (h - (b.max.z - b.min.z) * scale) * 0.5 - b.min.z * scale;
    this.mapTransform = { scale, ox, oz };

    const path = new Path2D();
    for (let i = 0; i <= layout.count; i++) {
      const p = layout.points[i % layout.count];
      const x = p.x * scale + ox;
      const y = p.z * scale + oz;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    this.trackPath2D = path;
  }

  /** Réinitialise tous les indicateurs du HUD pour un nouveau départ propre. */
  resetForNewRace(totalLaps) {
    for (const ui of this.panels) {
      ui.speedValue.textContent = '0';
      if (ui.speedArc) ui.speedArc.style.strokeDashoffset = '220';
      ui.boostBar.style.width = `${CONFIG.boost.startEnergy}%`;
      ui.boostPct.textContent = `${CONFIG.boost.startEnergy}%`;
      ui.boostWrap.classList.remove('boosting', 'slowed');
      if (ui.hudPanel) ui.hudPanel.classList.remove('slowdown-flash');
      ui.lapText.textContent = `1 / ${totalLaps}`;
      ui.lapTime.textContent = '0:00.000';
      ui.wrongWay.classList.add('hidden');
      ui.finishedBanner.classList.add('hidden');
      ui.cpBonus.classList.remove('visible', 'type-boost', 'type-super', 'type-slowdown');
    }
    const tbody = document.getElementById('results-tbody');
    if (tbody) tbody.innerHTML = '';
  }

  setCountdown(text, isGo = false) {
    if (!this.countdownEl) return;
    this.countdownEl.textContent = text;
    this.countdownEl.classList.remove('hidden');
    this.countdownEl.classList.toggle('go', isGo);
  }

  hideCountdown() {
    if (this.countdownEl) this.countdownEl.classList.add('hidden');
  }

  /**
   * Met à jour les compteurs des joueurs, le bandeau Spectateur et la mini-carte.
   * En mode « 2J en Ligne », `localPlayerOverride` permet d'afficher en plein écran
   * les compteurs du joueur local (Hôte ou Invité).
   */
  _updateWindIndicator(boxEl, arrowEl, statusEl, vehicle, windVec) {
    if (!boxEl || !arrowEl) return;
    if (!vehicle || vehicle.finished || !windVec) {
      boxEl.classList.add('hidden');
      return;
    }
    boxEl.classList.remove('hidden');

    vehicle.getForwardVector(_hudFwd);
    vehicle.getRightVector(_hudRight);

    const wx = windVec[0] || 0;
    const wz = windVec[2] || 0;

    const wFwd = wx * _hudFwd.x + wz * _hudFwd.z;
    const wRight = wx * _hudRight.x + wz * _hudRight.z;

    const angleDeg = Math.atan2(wRight, wFwd) * (180 / Math.PI);
    arrowEl.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`;

    if (statusEl) {
      const absA = Math.abs(angleDeg);
      if (absA <= 42) {
        statusEl.textContent = 'DOS (+)';
        statusEl.className = 'wind-status wind-tail';
      } else if (absA >= 138) {
        statusEl.textContent = 'FACE (-)';
        statusEl.className = 'wind-status wind-head';
      } else if (angleDeg > 0) {
        statusEl.textContent = 'DROITE';
        statusEl.className = 'wind-status wind-cross';
      } else {
        statusEl.textContent = 'GAUCHE';
        statusEl.className = 'wind-status wind-cross';
      }
    }
  }

  update(players, allVehicles, raceTime, spectatorInfo = null, localPlayerOverride = null, activeWeather = 'sunny', windVec = null) {
    const totalCars = allVehicles.length;
    const arcCircumference = 220;

    if (this.isSpectator && spectatorInfo && spectatorInfo.target) {
      const target = spectatorInfo.target;
      const tag = (target.displayTag || target.name || 'PILOTE').toUpperCase();
      const posLabel = `P${target.rank || 1}`;
      const lapNow = Math.min(target.lap || 1, target.totalLaps || CONFIG.race.laps);
      const lapTotal = target.totalLaps || CONFIG.race.laps;

      if (this.spectatorDriverName) {
        this.spectatorDriverName.textContent = `${tag} (${posLabel})`;
      }
      if (this.spectatorDriverLap) {
        this.spectatorDriverLap.textContent = target.finished
          ? `TERMINÉ — CHRONO ${formatTime(target.finishTime)}`
          : `TOUR ${lapNow} / ${lapTotal}`;
      }
      if (this.btnSpecResults) {
        this.btnSpecResults.classList.toggle('hidden', !spectatorInfo.canShowResults);
      }

      // Télémétrie dynamique en direct du véhicule suivi (synchronisation instantanée lors des changements de cible)
      const kmh = Math.round(target.speedKmh || Math.abs(target.forwardSpeed || 0) * 3.6);
      if (this.specSpeedValue) {
        this.specSpeedValue.textContent = String(kmh);
      }
      if (this.specSpeedArc) {
        const speedRatio = clamp(kmh / 360, 0, 1);
        this.specSpeedArc.style.strokeDashoffset = String(arcCircumference * (1 - speedRatio));
      }

      const boostPct = Math.round(clamp(target.boostEnergy ?? 100, 0, 100));
      if (this.specBoostBar) {
        this.specBoostBar.style.width = `${boostPct}%`;
      }
      if (this.specBoostPct) {
        this.specBoostPct.textContent = `${boostPct}%`;
      }
      if (this.specBoostWrap) {
        this.specBoostWrap.classList.toggle('boosting', Boolean(target.isBoosting));
        this.specBoostWrap.classList.toggle('slowed', (target.slowdownTimer || 0) > 0);
      }

      const isStormSpec = (activeWeather === 'storm') && Boolean(windVec);
      if (isStormSpec) {
        this._updateWindIndicator(this.specWindBox, this.specWindArrow, this.specWindStatus, target, windVec);
      } else if (this.specWindBox) {
        this.specWindBox.classList.add('hidden');
      }
      this._drawMinimap(allVehicles, target);
      return;
    }

    const activePlayers = localPlayerOverride
      ? 1
      : (this.playerCount === 1 ? 1 : (this.playerCount === 2 ? 2 : 0));

    for (let i = 0; i < activePlayers; i++) {
      const v = (i === 0 && localPlayerOverride) ? localPlayerOverride : players[i];
      const ui = this.panels[i];
      if (!v || !ui) continue;

      if (ui.driverTag) {
        ui.driverTag.textContent = (v.displayTag || v.name || `JOUEUR ${i + 1}`).toUpperCase();
      }

      const kmh = Math.round(v.speedKmh);
      ui.speedValue.textContent = String(kmh);

      const speedRatio = clamp(kmh / 360, 0, 1);
      if (ui.speedArc) {
        ui.speedArc.style.strokeDashoffset = String(arcCircumference * (1 - speedRatio));
      }

      const boostPct = Math.round(clamp(v.boostEnergy, 0, 100));
      ui.boostBar.style.width = `${boostPct}%`;
      ui.boostPct.textContent = `${boostPct}%`;
      ui.boostWrap.classList.toggle('boosting', v.isBoosting);
      ui.boostWrap.classList.toggle('slowed', v.slowdownTimer > 0);
      if (ui.hudPanel) {
        ui.hudPanel.classList.toggle('slowdown-flash', v.slowdownTimer > 0);
      }

      // Affichage exclusif lors du contact physique avec un jeton de boost ou ralentisseur
      const hasNotif = v.hudNotificationTimer > 0;
      if (hasNotif && v.hudNotificationText) {
        ui.cpBonus.textContent = v.hudNotificationText;
      }
      ui.cpBonus.classList.toggle('visible', hasNotif);
      ui.cpBonus.classList.toggle('type-boost', hasNotif && v.hudNotificationType === 'boost');
      ui.cpBonus.classList.toggle('type-super', hasNotif && v.hudNotificationType === 'super');
      ui.cpBonus.classList.toggle('type-slowdown', hasNotif && v.hudNotificationType === 'slowdown');

      ui.lapText.textContent = `${Math.min(v.lap, v.totalLaps)} / ${v.totalLaps}`;
      ui.lapTime.textContent = formatTime(v.finished ? v.finishTime : v.currentLapTime);

      ui.rankNum.textContent = ordinalFr(v.rank);
      ui.rankTotal.textContent = `/ ${totalCars}`;

      ui.wrongWay.classList.toggle('hidden', !v.isWrongWay || v.finished);

      if (v.finished) {
        ui.finishedBanner.textContent = `ARRIVÉ — ${ordinalFr(v.rank)} (${formatTime(v.finishTime)})`;
        ui.finishedBanner.classList.remove('hidden');
      } else {
        ui.finishedBanner.classList.add('hidden');
      }
    }

    const isStorm = (activeWeather === 'storm') && Boolean(windVec);
    for (let i = 0; i < 2; i++) {
      const ui = this.panels[i];
      if (!ui || !ui.windBox) continue;
      if (!isStorm || i >= activePlayers) {
        ui.windBox.classList.add('hidden');
      } else {
        const v = (i === 0 && localPlayerOverride) ? localPlayerOverride : players[i];
        this._updateWindIndicator(ui.windBox, ui.windArrow, ui.windStatus, v, windVec);
      }
    }
    if (this.specWindBox) {
      this.specWindBox.classList.add('hidden');
    }

    this._drawMinimap(allVehicles, null);
  }

  _drawMinimap(allVehicles, spectatorTarget = null) {
    const ctx = this.minimapCtx;
    if (!ctx || !this.trackPath2D || !this.layout) return;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const { scale, ox, oz } = this.mapTransform;

    ctx.clearRect(0, 0, w, h);

    if (this.layout.circuitId === 'lake') {
      // Affichage du Lac (« LAKE ») et de la zone « Végétation » sur la mini-carte
      ctx.save();
      ctx.fillStyle = 'rgba(0, 184, 212, 0.32)';
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(71 * scale + ox, -365 * scale + oz, Math.max(4, 136 * scale), Math.max(3, 76 * scale), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(46, 125, 50, 0.28)';
      ctx.beginPath();
      ctx.ellipse(-388 * scale + ox, 21 * scale + oz, Math.max(4, 72 * scale), Math.max(8, 230 * scale), -0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.lineWidth = 9;
    ctx.stroke(this.trackPath2D);

    ctx.strokeStyle = 'rgba(220, 230, 242, 0.85)';
    ctx.lineWidth = 5;
    ctx.stroke(this.trackPath2D);

    const p0 = this.layout.points[0];
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(p0.x * scale + ox - 3, p0.z * scale + oz - 3, 6, 6);

    for (const v of allVehicles) {
      if (!v.isAI) continue;
      const isWatched = spectatorTarget === v;
      const posX = v.chassisBody ? v.chassisBody.position.x : v.root.position.x;
      const posZ = v.chassisBody ? v.chassisBody.position.z : v.root.position.z;
      const x = posX * scale + ox;
      const y = posZ * scale + oz;
      ctx.beginPath();
      ctx.arc(x, y, isWatched ? 6.5 : 4.8, 0, Math.PI * 2);
      ctx.fillStyle = v.model?.cfg?.color || '#ff1744';
      ctx.fill();
      ctx.strokeStyle = isWatched ? '#ffffff' : '#000000';
      ctx.lineWidth = isWatched ? 2.2 : 1.5;
      ctx.stroke();
    }

    for (const v of allVehicles) {
      if (v.isAI) continue;
      const isWatched = spectatorTarget === v;
      const posX = v.chassisBody ? v.chassisBody.position.x : v.root.position.x;
      const posZ = v.chassisBody ? v.chassisBody.position.z : v.root.position.z;
      const x = posX * scale + ox;
      const y = posZ * scale + oz;
      ctx.beginPath();
      ctx.arc(x, y, isWatched ? 7.2 : 6.4, 0, Math.PI * 2);
      ctx.fillStyle = v.model?.cfg?.color || '#00e5ff';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
  }

  /**
   * Remplit le tableau de classement final sur l'écran de fin de course,
   * affiche le score et le chrono du ou des joueurs en haut de la carte,
   * juste au-dessus du bouton « Mode Spectateur ».
   */
  renderFinalResults(standings) {
    const tbody = document.getElementById('results-tbody');
    const subtitle = document.getElementById('results-winner-subtitle');
    const playerSummary = document.getElementById('results-player-summary');
    if (!tbody) return;
    tbody.innerHTML = '';

    const winner = standings[0];
    if (subtitle && winner) {
      subtitle.textContent = winner.finished
        ? `Leader : ${winner.name} en ${formatTime(winner.finishTime)}`
        : `En tête de la course : ${winner.name}`;
    }

    // Score et chrono du ou des joueurs humains (affiché juste au-dessus du bouton « Mode Spectateur »)
    if (playerSummary) {
      const humanPlayers = standings.filter((v) => !v.isAI);
      if (humanPlayers.length > 0) {
        playerSummary.innerHTML = humanPlayers.map((p) => `
          <div class="player-score-card">
            <span class="color-dot" style="background:${p.model.cfg.color}"></span>
            <strong>${p.displayTag || p.name}</strong>
            <span class="score-rank">${ordinalFr(p.rank)} / ${standings.length}</span>
            <span class="score-time">Chrono : ${p.finished ? formatTime(p.finishTime) : formatTime(p.currentLapTime)}</span>
          </div>
        `).join('');
        playerSummary.classList.remove('hidden');
      } else {
        playerSummary.innerHTML = '';
        playerSummary.classList.add('hidden');
      }
    }

    standings.forEach((v, idx) => {
      const tr = document.createElement('tr');
      if (!v.isAI) tr.classList.add('player-row');
      const totalTimeText = v.finished
        ? formatTime(v.finishTime)
        : `En course (Tour ${Math.min(v.lap, v.totalLaps)}/${v.totalLaps})`;
      tr.innerHTML = `
        <td class="col-rank"><span class="rank-pill rank-${idx + 1}">${ordinalFr(idx + 1)}</span></td>
        <td class="col-driver">
          <span class="color-dot" style="background:${v.model.cfg.color}"></span>
          <span>${v.name}</span>
          ${!v.isAI ? `<span class="tag-human">${v.id.toUpperCase()}</span>` : ''}
        </td>
        <td class="col-time">${totalTimeText}</td>
        <td class="col-best">${isFinite(v.bestLapTime) ? formatTime(v.bestLapTime) : '--:--.---'}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}
