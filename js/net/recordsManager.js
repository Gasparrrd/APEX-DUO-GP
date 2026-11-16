/**
 * recordsManager.js — Gestionnaire des Records Mondiaux en ligne (Top 3 par circuit et durée)
 * et des Voitures Fantômes (#1).
 *
 * Fonctionnement :
 *  - Mode Connecté (serveur `server.py` en local, LAN ou tunnel public) :
 *    Synchronisation directe avec `/api/records` et `/api/ghost` stockés côté serveur.
 *  - Mode Statique / Hors-serveur (ex: GitHub Pages sans backend Python) :
 *    Repli transparent sur `localStorage` + synchronisation P2P WebRTC entre joueurs connectés.
 */

export const CIRCUIT_META = {
  flat:     { id: 'flat',     number: 1, name: 'Plaine',             label: '1 · Plaine' },
  mountain: { id: 'mountain', number: 2, name: 'Montagne',           label: '2 · Montagne' },
  valley:   { id: 'valley',   number: 3, name: 'Vallée & Pont',      label: '3 · Vallée & Pont' },
  lake:     { id: 'lake',     number: 4, name: 'Lac & Végétation',   label: '4 · Lac & Végétation' },
  grotto:   { id: 'grotto',   number: 5, name: 'Le Col de la Grotte', label: '5 · Le Col de la Grotte' },
};

export const CIRCUIT_ORDER = ['flat', 'mountain', 'valley', 'lake', 'grotto'];
export const LAP_MODES = [2, 3, 5];

const STORAGE_RECORDS_KEY        = 'apex_duo_world_records_v1';
const STORAGE_GHOSTS_KEY         = 'apex_duo_world_ghosts_v1';
const STORAGE_DEVICE_ID_KEY      = 'apex_duo_device_id';
const STORAGE_DEVICE_PSEUDOS_KEY = 'apex_duo_device_pseudos_v1';

function sanitizeDeviceId(raw) {
  return String(raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function createEmptyStore() {
  const leaderboards = {};
  for (const cid of CIRCUIT_ORDER) {
    leaderboards[cid] = {
      bestLap: [],
      race: { '2': [], '3': [], '5': [] },
    };
  }
  return { leaderboards, ghosts: {} };
}

function dedupAndSortTop3(entries, devicePseudos = {}) {
  if (!Array.isArray(entries)) return [];
  const valid = entries
    .filter((e) => e && typeof e.time === 'number' && Number.isFinite(e.time))
    .map((e) => ({ ...e }))
    .sort((a, b) => a.time - b.time);

  const seenDevices = new Set();
  const out = [];
  for (const e of valid) {
    const did = sanitizeDeviceId(e.deviceId);
    if (did) {
      e.deviceId = did;
      if (devicePseudos && devicePseudos[did]) {
        e.pseudo = devicePseudos[did];
      }
      if (seenDevices.has(did)) continue;
      seenDevices.add(did);
    }
    out.push(e);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeLeaderboards(rawLb, devicePseudos = {}) {
  const out = createEmptyStore().leaderboards;
  if (!rawLb || typeof rawLb !== 'object') return out;

  for (const cid of CIRCUIT_ORDER) {
    const cRaw = rawLb[cid];
    if (!cRaw || typeof cRaw !== 'object') continue;
    if (Array.isArray(cRaw.bestLap)) {
      out[cid].bestLap = dedupAndSortTop3(cRaw.bestLap, devicePseudos);
    }
    if (cRaw.race && typeof cRaw.race === 'object') {
      for (const laps of LAP_MODES) {
        const key = String(laps);
        const list = cRaw.race[key];
        if (Array.isArray(list)) {
          out[cid].race[key] = dedupAndSortTop3(list, devicePseudos);
        }
      }
    }
  }
  return out;
}

function insertIntoTop3(boardList, newEntry) {
  const did = sanitizeDeviceId(newEntry.deviceId);
  let filtered = (boardList || []).filter((e) => e && e.entryId !== newEntry.entryId);

  if (did) {
    const existing = filtered.find((e) => e.deviceId === did);
    if (existing) {
      existing.pseudo = newEntry.pseudo;
      if (typeof existing.time === 'number' && existing.time <= newEntry.time) {
        const kept = filtered.slice().sort((a, b) => a.time - b.time).slice(0, 3);
        return { top3: kept, rank: null };
      }
    }
    filtered = filtered.filter((e) => e.deviceId !== did);
  }

  filtered.push(newEntry);
  filtered.sort((a, b) => a.time - b.time);
  const top3 = filtered.slice(0, 3);
  const idx = top3.findIndex((e) => e.entryId === newEntry.entryId);
  return { top3, rank: idx >= 0 ? idx + 1 : null };
}

function mergeBoardLists(listA, listB, devicePseudos = {}) {
  const map = new Map();
  for (const item of [...(listA || []), ...(listB || [])]) {
    if (!item || typeof item.time !== 'number' || !Number.isFinite(item.time)) continue;
    const copy = { ...item };
    const did = sanitizeDeviceId(copy.deviceId);
    if (did) {
      copy.deviceId = did;
      if (devicePseudos && devicePseudos[did]) {
        copy.pseudo = devicePseudos[did];
      }
    }
    const key = did ? `dev_${did}` : (copy.entryId || `${copy.pseudo}_${Math.round(copy.time * 1000)}`);
    const prev = map.get(key);
    if (!prev || copy.time < prev.time) {
      map.set(key, copy);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.time - b.time)
    .slice(0, 3);
}

export class RecordsManager {
  constructor() {
    this.leaderboards = createEmptyStore().leaderboards;
    this.ghostCache = new Map(); // clé `${circuit}_${laps}` -> ghost object | null
    this.devicePseudos = {};     // deviceId -> dernier pseudo utilisé
    this.deviceId = this._initDeviceId();
    this.onlineAvailable = false;
    this.lastSyncAt = 0;
    this._loadLocalFallback();
  }

  _initDeviceId() {
    try {
      const existing = sanitizeDeviceId(localStorage.getItem(STORAGE_DEVICE_ID_KEY));
      if (existing && existing.length >= 8) {
        return existing;
      }
    } catch (_) {}

    let generated = '';
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        generated = crypto.randomUUID();
      }
    } catch (_) {}
    if (!generated) {
      generated = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
    const clean = sanitizeDeviceId(generated);
    try {
      localStorage.setItem(STORAGE_DEVICE_ID_KEY, clean);
    } catch (_) {}
    return clean;
  }

  getDeviceId() {
    return this.deviceId;
  }

  _applyDevicePseudoLocally(deviceId, pseudo) {
    const did = sanitizeDeviceId(deviceId);
    if (!did || !pseudo || pseudo.length < 2) return;
    this.devicePseudos[did] = pseudo;

    for (const cid of CIRCUIT_ORDER) {
      const cBoard = this.getCircuitRecords(cid);
      for (const e of cBoard.bestLap || []) {
        if (e && e.deviceId === did) e.pseudo = pseudo;
      }
      for (const laps of LAP_MODES) {
        for (const e of (cBoard.race && cBoard.race[String(laps)]) || []) {
          if (e && e.deviceId === did) e.pseudo = pseudo;
        }
      }
    }
    for (const g of this.ghostCache.values()) {
      if (g && g.deviceId === did) g.pseudo = pseudo;
    }
  }

  _getApiBaseUrl() {
    if (typeof window !== 'undefined' && typeof window.APEX_RECORDS_API_URL === 'string' && window.APEX_RECORDS_API_URL) {
      return window.APEX_RECORDS_API_URL.replace(/\/+$/, '');
    }
    return '';
  }

  _loadLocalFallback() {
    try {
      const rawDp = localStorage.getItem(STORAGE_DEVICE_PSEUDOS_KEY);
      if (rawDp) {
        const parsedDp = JSON.parse(rawDp);
        if (parsedDp && typeof parsedDp === 'object') {
          this.devicePseudos = { ...parsedDp };
        }
      }
    } catch (_) {}

    try {
      const raw = localStorage.getItem(STORAGE_RECORDS_KEY);
      if (raw) {
        this.leaderboards = normalizeLeaderboards(JSON.parse(raw), this.devicePseudos);
      }
    } catch (_) {}

    try {
      const rawGhosts = localStorage.getItem(STORAGE_GHOSTS_KEY);
      if (rawGhosts) {
        const parsed = JSON.parse(rawGhosts);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (v && Array.isArray(v.samples)) {
              const did = sanitizeDeviceId(v.deviceId);
              if (did && this.devicePseudos[did]) {
                v.pseudo = this.devicePseudos[did];
              }
              this.ghostCache.set(k, v);
            }
          }
        }
      }
    } catch (_) {}
  }

  _saveLocalFallback() {
    try {
      localStorage.setItem(STORAGE_DEVICE_PSEUDOS_KEY, JSON.stringify(this.devicePseudos));
    } catch (_) {}

    try {
      localStorage.setItem(STORAGE_RECORDS_KEY, JSON.stringify(this.leaderboards));
    } catch (_) {}

    try {
      const ghostObj = {};
      for (const [k, v] of this.ghostCache.entries()) {
        if (v && Array.isArray(v.samples)) {
          ghostObj[k] = v;
        }
      }
      localStorage.setItem(STORAGE_GHOSTS_KEY, JSON.stringify(ghostObj));
    } catch (_) {}
  }

  _sanitizePseudo(raw) {
    return String(raw || 'Pilote').trim().replace(/\s+/g, ' ').slice(0, 16) || 'Pilote';
  }

  _sanitizeCarConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return {};
    return {
      bodyType: cfg.bodyType || 'supercar',
      color: cfg.color || '#e53935',
      rims: cfg.rims || 'sport',
      rimFinish: cfg.rimFinish || 'silver',
      spoiler: cfg.spoiler || 'gt',
      neonColor: cfg.neonColor || '#00e5ff',
    };
  }

  /** Formate un temps en secondes au format `m:ss.xxx` (ou `--:--.---` si invalide). */
  static formatTime(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0 || sec >= 99999) {
      return '--:--.---';
    }
    const totalMs = Math.round(sec * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  getCircuitRecords(circuitId) {
    const cid = CIRCUIT_META[circuitId] ? circuitId : 'flat';
    if (!this.leaderboards[cid]) {
      this.leaderboards[cid] = { bestLap: [], race: { '2': [], '3': [], '5': [] } };
    }
    return this.leaderboards[cid];
  }

  /**
   * Récupère tous les Top 3 mondiaux depuis le serveur HTTP.
   * En cas d'échec réseau (mode statique pur), conserve le cache local/P2P.
   */
  async fetchAllRecords() {
    const base = this._getApiBaseUrl();
    try {
      const res = await fetch(`${base}/api/records?_t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.leaderboards) {
          if (data.devicePseudos && typeof data.devicePseudos === 'object') {
            this.devicePseudos = { ...this.devicePseudos, ...data.devicePseudos };
          }
          this.leaderboards = normalizeLeaderboards(data.leaderboards, this.devicePseudos);
          for (const g of this.ghostCache.values()) {
            const did = sanitizeDeviceId(g?.deviceId);
            if (did && this.devicePseudos[did]) {
              g.pseudo = this.devicePseudos[did];
            }
          }
          this.onlineAvailable = true;
          this.lastSyncAt = Date.now();
          this._saveLocalFallback();
          return { ok: true, online: true, leaderboards: this.leaderboards };
        }
      }
    } catch (_) {
      // Fallback hors-serveur ci-dessous
    }

    this.onlineAvailable = false;
    return { ok: true, online: false, leaderboards: this.leaderboards };
  }

  /**
   * Récupère la voiture fantôme (#1) pour une combinaison (circuit, laps).
   */
  async fetchGhost(circuitId, laps) {
    const cid = CIRCUIT_META[circuitId] ? circuitId : 'flat';
    const lapKey = String(laps);
    const key = `${cid}_${lapKey}`;
    const base = this._getApiBaseUrl();

    try {
      const res = await fetch(`${base}/api/ghost?circuit=${encodeURIComponent(cid)}&laps=${encodeURIComponent(lapKey)}&_t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          this.onlineAvailable = true;
          if (data.ghost && Array.isArray(data.ghost.samples) && data.ghost.samples.length >= 9) {
            const did = sanitizeDeviceId(data.ghost.deviceId);
            if (did && this.devicePseudos[did]) {
              data.ghost.pseudo = this.devicePseudos[did];
            }
            this.ghostCache.set(key, data.ghost);
            this._saveLocalFallback();
            return data.ghost;
          }
          // Le serveur répond explicitement qu'il n'y a pas de fantôme pour ce mode
          this.ghostCache.delete(key);
          this._saveLocalFallback();
          return null;
        }
      }
    } catch (_) {
      // Fallback sur le cache local/P2P
    }

    return this.ghostCache.get(key) || null;
  }

  getCachedGhost(circuitId, laps) {
    return this.ghostCache.get(`${circuitId}_${laps}`) || null;
  }

  /**
   * Synchronise en ligne le dernier pseudo utilisé par cette machine (`deviceId`).
   * Met à jour automatiquement le pseudo sur tous ses records et fantômes existants.
   */
  async syncDevicePseudo(rawPseudo) {
    const cleanPseudo = this._sanitizePseudo(rawPseudo);
    if (!cleanPseudo || cleanPseudo.length < 2) {
      return { ok: false, online: this.onlineAvailable };
    }

    this._applyDevicePseudoLocally(this.deviceId, cleanPseudo);
    this._saveLocalFallback();

    const base = this._getApiBaseUrl();
    try {
      const res = await fetch(`${base}/api/records/pseudo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.deviceId,
          pseudo: cleanPseudo,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          this.onlineAvailable = true;
          this.lastSyncAt = Date.now();
          if (data.devicePseudos && typeof data.devicePseudos === 'object') {
            this.devicePseudos = { ...this.devicePseudos, ...data.devicePseudos };
          }
          if (data.leaderboards) {
            this.leaderboards = normalizeLeaderboards(data.leaderboards, this.devicePseudos);
          }
          for (const g of this.ghostCache.values()) {
            const did = sanitizeDeviceId(g?.deviceId);
            if (did && this.devicePseudos[did]) {
              g.pseudo = this.devicePseudos[did];
            }
          }
          this._saveLocalFallback();
          return { ok: true, online: true, leaderboards: this.leaderboards };
        }
      }
    } catch (_) {
      // Fallback hors-serveur conservé
    }

    return { ok: true, online: false, leaderboards: this.leaderboards };
  }

  /**
   * Soumet le résultat d'un joueur à la fin d'une course (meilleur tour + temps total + fantôme si fini).
   */
  async submitRaceResult({ circuit, laps, pseudo, carConfig, bestLapTime, totalRaceTime, ghost }) {
    const cid = CIRCUIT_META[circuit] ? circuit : 'flat';
    const lapKey = String(laps);
    if (!['2', '3', '5'].includes(lapKey)) {
      return {
        ok: false,
        bestLapRank: null,
        raceRank: null,
        isNewBestLapWR: false,
        isNewRaceWR: false,
        circuitRecords: this.getCircuitRecords(cid),
      };
    }

    const cleanPseudo = this._sanitizePseudo(pseudo);
    const cleanCar = this._sanitizeCarConfig(carConfig);
    const entryId = `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const validBestLap = (typeof bestLapTime === 'number' && Number.isFinite(bestLapTime) && bestLapTime > 2.0 && bestLapTime < 3600)
      ? Math.round(bestLapTime * 10000) / 10000
      : null;

    const validTotalRace = (typeof totalRaceTime === 'number' && Number.isFinite(totalRaceTime) && totalRaceTime > 4.0 && totalRaceTime < 7200)
      ? Math.round(totalRaceTime * 10000) / 10000
      : null;

    this._applyDevicePseudoLocally(this.deviceId, cleanPseudo);

    // Pré-mise à jour optimiste en mémoire pour affichage immédiat
    const cBoard = this.getCircuitRecords(cid);
    let localBestLapRank = null;
    let localRaceRank = null;
    const nowIso = new Date().toISOString();

    if (validBestLap !== null) {
      const resBl = insertIntoTop3(cBoard.bestLap, {
        entryId,
        deviceId: this.deviceId,
        pseudo: cleanPseudo,
        time: validBestLap,
        carConfig: cleanCar,
        date: nowIso,
      });
      cBoard.bestLap = resBl.top3;
      localBestLapRank = resBl.rank;
    }

    if (validTotalRace !== null) {
      const resRace = insertIntoTop3(cBoard.race[lapKey], {
        entryId,
        deviceId: this.deviceId,
        pseudo: cleanPseudo,
        time: validTotalRace,
        carConfig: cleanCar,
        date: nowIso,
        hasGhost: false,
      });
      cBoard.race[lapKey] = resRace.top3;
      localRaceRank = resRace.rank;

      if (localRaceRank === 1 && ghost && Array.isArray(ghost.samples) && ghost.samples.length >= 9) {
        const ghostEntry = {
          entryId,
          deviceId: this.deviceId,
          pseudo: cleanPseudo,
          time: validTotalRace,
          carConfig: cleanCar,
          sampleInterval: ghost.sampleInterval || (1 / 15),
          samples: ghost.samples,
          date: nowIso,
        };
        this.ghostCache.set(`${cid}_${lapKey}`, ghostEntry);
        if (cBoard.race[lapKey][0]) {
          cBoard.race[lapKey][0].hasGhost = true;
        }
      }
    }

    this._saveLocalFallback();

    // Envoi au serveur en ligne `/api/records`
    // On n'envoie le fantôme que si le joueur a une chance d'être #1 (ou si pas encore de #1 connu)
    const shouldSendGhost = Boolean(
      validTotalRace !== null
      && ghost
      && Array.isArray(ghost.samples)
      && ghost.samples.length >= 9
      && (localRaceRank === 1 || !this.onlineAvailable)
    );

    const payload = {
      entryId,
      deviceId: this.deviceId,
      circuit: cid,
      laps: Number(lapKey),
      pseudo: cleanPseudo,
      carConfig: cleanCar,
      bestLapTime: validBestLap,
      totalRaceTime: validTotalRace,
      ghost: shouldSendGhost ? ghost : null,
    };

    const base = this._getApiBaseUrl();
    try {
      const res = await fetch(`${base}/api/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          this.onlineAvailable = true;
          this.lastSyncAt = Date.now();
          if (data.devicePseudos && typeof data.devicePseudos === 'object') {
            this.devicePseudos = { ...this.devicePseudos, ...data.devicePseudos };
          }
          if (data.leaderboards) {
            this.leaderboards = normalizeLeaderboards(data.leaderboards, this.devicePseudos);
          } else if (data.circuitRecords) {
            this.leaderboards[cid] = normalizeLeaderboards({ [cid]: data.circuitRecords }, this.devicePseudos)[cid];
          }
          if (data.isNewRaceWR && ghost && Array.isArray(ghost.samples) && ghost.samples.length >= 9) {
            this.ghostCache.set(`${cid}_${lapKey}`, {
              entryId: data.entryId || entryId,
              deviceId: this.deviceId,
              pseudo: cleanPseudo,
              time: validTotalRace,
              carConfig: cleanCar,
              sampleInterval: ghost.sampleInterval || (1 / 15),
              samples: ghost.samples,
              date: nowIso,
            });
          }
          this._saveLocalFallback();
          return {
            ok: true,
            online: true,
            entryId: data.entryId || entryId,
            bestLapRank: data.bestLapRank ?? localBestLapRank,
            raceRank: data.raceRank ?? localRaceRank,
            isNewBestLapWR: Boolean(data.isNewBestLapWR),
            isNewRaceWR: Boolean(data.isNewRaceWR),
            circuitRecords: this.getCircuitRecords(cid),
          };
        }
      }
    } catch (_) {
      // Conservation du mode repli local/P2P
    }

    return {
      ok: true,
      online: false,
      entryId,
      bestLapRank: localBestLapRank,
      raceRank: localRaceRank,
      isNewBestLapWR: localBestLapRank === 1,
      isNewRaceWR: localRaceRank === 1,
      circuitRecords: this.getCircuitRecords(cid),
    };
  }

  /** Exporte les classements actuels pour la synchronisation P2P entre joueurs en ligne. */
  exportForPeer() {
    return {
      leaderboards: this.leaderboards,
      devicePseudos: this.devicePseudos,
    };
  }

  /** Fusionne les classements reçus d'un pair P2P (utile en hébergement statique sans serveur HTTP). */
  importFromPeer(payload) {
    if (!payload || !payload.leaderboards) return false;
    let changed = false;

    if (payload.devicePseudos && typeof payload.devicePseudos === 'object') {
      for (const [k, v] of Object.entries(payload.devicePseudos)) {
        const did = sanitizeDeviceId(k);
        const pseudo = this._sanitizePseudo(v);
        if (did && pseudo.length >= 2 && this.devicePseudos[did] !== pseudo) {
          this.devicePseudos[did] = pseudo;
          this._applyDevicePseudoLocally(did, pseudo);
          changed = true;
        }
      }
    }

    const incoming = normalizeLeaderboards(payload.leaderboards, this.devicePseudos);

    for (const cid of CIRCUIT_ORDER) {
      const cur = this.getCircuitRecords(cid);
      const inc = incoming[cid];
      if (!inc) continue;

      const mergedBl = mergeBoardLists(cur.bestLap, inc.bestLap, this.devicePseudos);
      if (JSON.stringify(mergedBl) !== JSON.stringify(cur.bestLap)) {
        cur.bestLap = mergedBl;
        changed = true;
      }
      for (const laps of LAP_MODES) {
        const key = String(laps);
        const mergedRace = mergeBoardLists(cur.race[key], inc.race[key], this.devicePseudos);
        if (JSON.stringify(mergedRace) !== JSON.stringify(cur.race[key])) {
          cur.race[key] = mergedRace;
          changed = true;
        }
      }
    }

    if (changed) {
      this._saveLocalFallback();
    }
    return changed;
  }
}

export const recordsManager = new RecordsManager();
