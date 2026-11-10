/**
 * networkManager.js — Architecture Réseau Temps Réel 100% Statique (WebRTC / PeerJS) :
 *  - Conçu pour un hébergement 100% statique (GitHub Pages, Netlify, Vercel, etc.) sans serveur Node.js ni CLI.
 *  - Utilise le serveur de signalement public par défaut de PeerJS (`0.peerjs.com`).
 *  - Topologie en étoile Hôte / Clients (2 à 4 joueurs humains dynamiques + Bots IA) :
 *      * Slot 1 (index 0) : Hôte (serveur faisant autorité sur la météo, le circuit, les bots et le chrono).
 *      * Slots 2, 3, 4 (index 1, 2, 3) : Invités connectés en WebRTC via `DataChannel`.
 *  - Double canal WebRTC par joueur :
 *      * Canal `control` (`reliable: true`, ordonné JSON) : salle d'attente, synchronisation du compte à rebours
 *        (3, 2, 1, GO), validation des tours/checkpoints, classement final et gestion propre des déconnexions.
 *      * Canal `fast` (`reliable: false`, binaire `Float32Array` non-bloquant à 30 Hz) :
 *        positions (X, Y, Z), rotations (quaternion), vitesses, braquage et boost sans effet accordéon.
 */

const PACKET_SNAPSHOT = 101;
const PACKET_GUEST_INPUT = 102;
const PACKET_GUEST_STATE = 103;
const HEADER_FLOATS = 7;
const VEHICLE_FLOATS = 16;
const NET_TICK_RATE = 30;
const NET_TICK_INTERVAL = 1 / NET_TICK_RATE;
const MAX_ONLINE_PLAYERS = 4;

const DEFAULT_SLOT_CARS = [
  { name: 'HÔTE',     bodyType: 'supercar', color: '#1e88e5', rims: 'sport', rimFinish: 'silver', spoiler: 'gt'  },
  { name: 'PILOTE 2', bodyType: 'muscle',   color: '#fb8c00', rims: 'star',  rimFinish: 'black',  spoiler: 'lip' },
  { name: 'PILOTE 3', bodyType: 'formula',  color: '#00c853', rims: 'multi', rimFinish: 'gold',   spoiler: 'gt'  },
  { name: 'PILOTE 4', bodyType: 'supercar', color: '#8e24aa', rims: 'disc',  rimFinish: 'silver', spoiler: 'gt'  },
];

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export class NetworkManager {
  constructor(callbacks = {}) {
    this.onPeerReady = callbacks.onPeerReady || (() => {});
    this.onPeerError = callbacks.onPeerError || (() => {});
    this.onPeerConnected = callbacks.onPeerConnected || (() => {});
    this.onPeerDisconnected = callbacks.onPeerDisconnected || (() => {});
    this.onHostLeft = callbacks.onHostLeft || (() => {});
    this.onGuestLeft = callbacks.onGuestLeft || (() => {});
    this.onLobbyStateChange = callbacks.onLobbyStateChange || (() => {});
    this.onRemoteCarUpdate = callbacks.onRemoteCarUpdate || callbacks.onRemoteCarConfig || (() => {});
    this.onGuestReadyChange = callbacks.onGuestReadyChange || callbacks.onRemoteReadyChange || (() => {});
    this.onRaceSettingsUpdate = callbacks.onRaceSettingsUpdate || callbacks.onRemoteRaceSettings || (() => {});
    this.onStartOnlineRace = callbacks.onStartOnlineRace || (() => {});
    this.onResetOnlineRace = callbacks.onResetOnlineRace || (() => {});
    this.onRaceEvent = callbacks.onRaceEvent || (() => {});
    this.onPlayerMidRaceDisconnect = callbacks.onPlayerMidRaceDisconnect || (() => {});
    this.onSnapshot = callbacks.onSnapshot || callbacks.onPhysicsSnapshot || (() => {});
    this.onGuestInput = callbacks.onGuestInput || (() => {});
    this.onGuestState = callbacks.onGuestState || (() => {});
    this.onStateChange = callbacks.onStateChange || (() => {});

    this.active = false;
    this.role = 'offline'; // 'offline' | 'host' | 'guest'
    this.mySlotIndex = 0;  // 0 = Hôte, 1..3 = Invités
    this.roomId = null;
    this.inviteUrl = '';
    this.peerOpen = false;
    this.tickRate = NET_TICK_RATE;

    this.peer = null;
    // Connexions côté Invité (vers l'Hôte)
    this.reliableConn = null;
    this.fastConn = null;
    // Connexions côté Hôte (Map guestPeerId -> { peerId, slotIndex, controlConn, fastConn, lastRxSeq })
    this.guestPeers = new Map();

    this.localBroadcast = null;
    this._openFallbackTimer = null;
    this._guestConnectRetryTimer = null;
    this._httpRelayTimer = null;
    this._httpLastSeq = 0;
    this._httpFastPushTs = 0;
    this._controlSeq = 0;
    this._seenControlMsgIds = new Set();
    this._localClientId = `cli_${Math.random().toString(36).slice(2, 9)}`;

    this.connected = false;
    this.hostName = 'HÔTE';
    this.guestName = 'PILOTE 2';
    this.hostReady = true;
    this.guestReady = false;
    this._intentionalLeave = false;
    this._hostRetryCount = 0;

    // 4 Slots de joueurs humains (Slot 0 = Hôte, Slots 1..3 = Invités)
    this.slots = this._createInitialSlots();

    this._lastHostCarConfig = null;
    this._lastGuestCarConfig = null;
    this._lastRaceSettings = null;

    this._txSeq = 0;
    this._lastRxSnapshotSeq = 0;
    this._lastRxInputSeqBySlot = [0, 0, 0, 0];
    this._hostTxAccum = 0;
    this._guestTxAccum = 0;

    // Tampons binaires plats pré-alloués par nombre de véhicules (1..10) pour l'envoi à 30 Hz sans GC
    this._snapshotFloats = new Float32Array(HEADER_FLOATS + 10 * VEHICLE_FLOATS);
    this._snapshotBuffersByCount = [];
    for (let c = 0; c <= 10; c++) {
      this._snapshotBuffersByCount[c] = new Float32Array(HEADER_FLOATS + c * VEHICLE_FLOATS);
    }
    this._inputFloats = new Float32Array(8);
    this._guestStateFloats = new Float32Array(19);
    this._rxGuestInputObj = { slotIndex: 1, throttle: 0, brake: 0, steer: 0, boost: false, reset: false };
    this._rxGuestStateObj = {
      slotIndex: 1,
      px: 0, py: 0, pz: 0,
      qx: 0, qy: 0, qz: 0, qw: 1,
      forwardSpeed: 0, steerAngle: 0, boostEnergy: 100,
      flags: 0, slowdownTimer: 0, lap: 1, progOrFinish: 0,
      pickedTokenIdx: -1, lateralSpeed: 0,
    };
  }

  _createInitialSlots() {
    return [0, 1, 2, 3].map((idx) => ({
      slotIndex: idx,
      occupied: idx === 0,
      isHost: idx === 0,
      peerId: null,
      name: idx === 0 ? (this.hostName || 'HÔTE') : `Slot ${idx + 1} (Libre)`,
      ready: idx === 0,
      carConfig: { ...DEFAULT_SLOT_CARS[idx] },
    }));
  }

  /**
   * Génère un code de salon court, lisible et facile à partager (ex: `RACE-4821`).
   */
  static generateShortRoomCode() {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `RACE-${num}`;
  }

  /**
   * Normalise un code de salon ou une URL d'invitation saisie par l'utilisateur.
   * Exemples acceptés :
   *  - `https://monlien.github.io/?room=RACE-4821` -> `RACE-4821`
   *  - `race-4821` -> `RACE-4821`
   *  - `4821` -> `RACE-4821`
   */
  static normalizeRoomCode(rawInput) {
    let clean = String(rawInput || '').trim();
    if (!clean) return '';
    if (clean.includes('?room=')) {
      clean = clean.split('?room=')[1].split('&')[0].split('#')[0].trim();
    }
    try {
      clean = decodeURIComponent(clean).trim();
    } catch (_) {}

    if (/^\d{4}$/.test(clean)) {
      return `RACE-${clean}`;
    }
    if (/^race-[a-z0-9]{3,8}$/i.test(clean)) {
      return clean.toUpperCase();
    }
    if (/^[a-z0-9]{4}$/i.test(clean)) {
      return `RACE-${clean.toUpperCase()}`;
    }
    return clean;
  }

  /**
   * Retourne l'URL complète d'invitation vers le salon de l'hôte.
   */
  getInviteUrl() {
    return this.inviteUrl;
  }

  /**
   * Retourne la liste des slots occupés par des joueurs humains (1 à 4 joueurs).
   */
  getOccupiedSlots() {
    return this.slots.filter((s) => s && s.occupied);
  }

  /**
   * Retourne le nombre total de joueurs humains connectés dans le salon (1 à 4).
   */
  getConnectedPlayerCount() {
    return this.getOccupiedSlots().length;
  }

  /**
   * Vérifie si le salon peut lancer la course :
   * Autorise le lancement dès qu'au moins 1 voiture est dans le salon (1, 2, 3 ou 4)
   * ET que tous les joueurs présents dans le salon ont mis « Prêt ».
   */
  canStartOnlineRace() {
    const occupied = this.getOccupiedSlots();
    if (occupied.length < 1) return false;
    return occupied.every((s) => s.isHost || Boolean(s.ready));
  }

  _syncLegacyFlags() {
    const occupied = this.getOccupiedSlots();
    this.connected = this.role === 'guest' ? Boolean(this.connected || occupied.length >= 2) : occupied.length >= 1;
    if (this.role === 'guest') {
      const mySlot = this.slots[this.mySlotIndex];
      if (mySlot && mySlot.occupied) {
        this.guestReady = Boolean(mySlot.ready);
      }
    } else {
      this.guestReady = this.canStartOnlineRace();
    }
    const firstGuest = this.slots.find((s) => !s.isHost && s.occupied);
    if (firstGuest) {
      this.guestName = firstGuest.name || 'PILOTE 2';
    }
  }

  /**
   * Construit dynamiquement l'URL d'invitation :
   * `const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${this.roomId}`;`
   */
  _setRoomId(hostPeerId) {
    const cleanId = NetworkManager.normalizeRoomCode(hostPeerId);
    this.roomId = cleanId;
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    this.inviteUrl = `${baseUrl}?room=${encodeURIComponent(cleanId)}`;
    return this.inviteUrl;
  }

  /**
   * Initialise une session en tant qu'Hôte et génère un code court `RACE-XXXX` ainsi que le lien `?room=RACE-XXXX`.
   */
  initHost(hostName, hostCarConfig, raceSettings, forcedCode = null) {
    this._lastHostCarConfig = hostCarConfig ? { ...hostCarConfig } : { ...DEFAULT_SLOT_CARS[0] };
    this._lastRaceSettings = raceSettings ? { ...raceSettings } : null;

    if (this.active && this.role === 'host' && this.roomId && this.peerOpen && !forcedCode) {
      this.setHostName(hostName, hostCarConfig);
      this.onPeerReady(this.roomId, this.inviteUrl, 'Salon prêt');
      this._emitState();
      return this.inviteUrl;
    }

    this.disconnect();
    this._intentionalLeave = false;
    this.active = true;
    this.role = 'host';
    this.mySlotIndex = 0;
    this.peerOpen = false;
    this.hostName = (hostName || 'HÔTE').trim() || 'HÔTE';
    this.guestName = 'EN ATTENTE…';
    this.hostReady = true;
    this.guestReady = false;
    this.connected = false;
    this._hostTxAccum = 0;

    this.slots = this._createInitialSlots();
    this.slots[0] = {
      slotIndex: 0,
      occupied: true,
      isHost: true,
      peerId: 'HOST',
      name: this.hostName,
      ready: true,
      carConfig: { ...this._lastHostCarConfig, name: this.hostName },
    };

    const desiredPeerId = forcedCode || NetworkManager.generateShortRoomCode();
    const initialInviteUrl = this._setRoomId(desiredPeerId);
    this.slots[0].peerId = desiredPeerId;
    this._setupLocalBroadcast(desiredPeerId);
    this._startLocalHttpRelay(desiredPeerId);

    // Rend le code de salon et le canal local immédiatement opérationnels sans attendre le broker externe
    this.onPeerReady(desiredPeerId, initialInviteUrl, 'Salon prêt');

    const finalizeHostOpen = (resolvedId, badgeText = 'Salon prêt') => {
      if (!this.active || this.role !== 'host') return;
      if (this._openFallbackTimer) {
        clearTimeout(this._openFallbackTimer);
        this._openFallbackTimer = null;
      }
      const wasOpen = this.peerOpen;
      this.peerOpen = true;
      this.slots[0].peerId = resolvedId;
      const inviteUrl = this._setRoomId(resolvedId);
      this._setupLocalBroadcast(resolvedId);
      this._startLocalHttpRelay(resolvedId);
      if (!wasOpen || this.roomId === resolvedId) {
        console.log('[P2P Host] Salon prêt — Code:', resolvedId, '| Lien:', inviteUrl);
        this.onPeerReady(resolvedId, inviteUrl, badgeText);
      }
      this._emitState();
    };

    this._openFallbackTimer = setTimeout(() => {
      if (!this.peerOpen && this.active && this.role === 'host') {
        console.warn('[P2P Host] Délai broker PeerJS dépassé — activation du salon:', desiredPeerId);
        finalizeHostOpen(desiredPeerId, 'Salon prêt');
      }
    }, 5000);

    const PeerCtor = typeof window !== 'undefined' ? (window.Peer || window.peerjs?.Peer) : null;
    if (typeof PeerCtor === 'function') {
      try {
        this.peer = new PeerCtor(desiredPeerId, {
          debug: 1,
          config: { iceServers: ICE_SERVERS },
        });

        this.peer.on('open', (id) => {
          this._hostRetryCount = 0;
          finalizeHostOpen(id || desiredPeerId, 'Salon prêt');
        });

        this.peer.on('connection', (conn) => {
          this._bindIncomingHostConnection(conn);
        });

        this.peer.on('error', (err) => {
          const errType = err?.type || '';
          console.warn('[PeerJS Host Error]', errType || err);
          if (errType === 'unavailable-id' && this._hostRetryCount < 4) {
            this._hostRetryCount++;
            const nextCode = NetworkManager.generateShortRoomCode();
            console.log('[PeerJS Host] Code déjà utilisé, nouvel essai avec :', nextCode);
            this.initHost(this.hostName, this._lastHostCarConfig, this._lastRaceSettings, nextCode);
            return;
          }
          this.onPeerError(err);
          if (!this.peerOpen) {
            finalizeHostOpen(desiredPeerId, 'Salon prêt');
          }
          this._emitState();
        });
      } catch (err) {
        console.error('[PeerJS Host Init Exception]', err);
        this.onPeerError(err);
        finalizeHostOpen(desiredPeerId, 'Salon prêt');
      }
    } else {
      console.warn('[PeerJS] Bibliothèque PeerJS non chargée — bascule sur le canal P2P local.');
      finalizeHostOpen(desiredPeerId, 'Salon prêt');
    }

    this._emitState();
    return this.inviteUrl;
  }

  /**
   * Initialise une session en tant qu'Invité rejoignant le salon de l'Hôte (`RACE-XXXX` ou `?room=RACE-XXXX`).
   */
  initGuest(hostPeerId, guestName, guestCarConfig) {
    const cleanRoomId = NetworkManager.normalizeRoomCode(hostPeerId);
    if (!cleanRoomId) return;

    this.disconnect();
    this._intentionalLeave = false;
    this.active = true;
    this.role = 'guest';
    this.mySlotIndex = 1; // Mis à jour par HOST_WELCOME (1, 2 ou 3)
    this.peerOpen = false;
    this.guestName = (guestName || 'PILOTE 2').trim() || 'PILOTE 2';
    this.hostName = 'HÔTE';
    this.hostReady = true;
    this.guestReady = false;
    this.connected = false;
    this._guestTxAccum = 0;
    this._lastGuestCarConfig = guestCarConfig
      ? { ...guestCarConfig, name: this.guestName }
      : { ...DEFAULT_SLOT_CARS[1], name: this.guestName };

    this.slots = this._createInitialSlots();
    this.slots[1] = {
      slotIndex: 1,
      occupied: true,
      isHost: false,
      peerId: this._localClientId,
      name: this.guestName,
      ready: false,
      carConfig: { ...this._lastGuestCarConfig },
    };

    const inviteUrl = this._setRoomId(cleanRoomId);
    this._setupLocalBroadcast(cleanRoomId);
    this._startLocalHttpRelay(cleanRoomId);

    const sendHelloHandshake = () => {
      if (!this.active || this.role !== 'guest') return;
      this._sendControlMessage({
        type: 'GUEST_HELLO',
        clientId: this._localClientId,
        guestName: this.guestName,
        carConfig: this._lastGuestCarConfig,
        ready: Boolean(this.slots[this.mySlotIndex]?.ready),
      });
    };

    // Envoi immédiat sur BroadcastChannel & Relais HTTP
    sendHelloHandshake();

    const attemptPeerConnect = () => {
      if (!this.active || this.role !== 'guest' || !this.peer || !this.peerOpen) return;
      if (this.reliableConn && this.reliableConn.open) return;
      try {
        const relConn = this.peer.connect(cleanRoomId, {
          reliable: true,
          metadata: { channel: 'control', guestName: this.guestName, clientId: this._localClientId },
        });
        this._bindGuestConnectionEvents(relConn, 'control', cleanRoomId);
      } catch (err) {
        console.warn('[PeerJS Guest Connect Attempt Error]', err);
      }
    };

    // Boucle de relance automatique tant que l'invité n'a pas reçu HOST_WELCOME
    this._guestConnectRetryTimer = setInterval(() => {
      if (!this.active || this.role !== 'guest') {
        clearInterval(this._guestConnectRetryTimer);
        this._guestConnectRetryTimer = null;
        return;
      }
      if (!this.connected) {
        sendHelloHandshake();
        attemptPeerConnect();
      }
    }, 1500);

    const PeerCtor = typeof window !== 'undefined' ? (window.Peer || window.peerjs?.Peer) : null;
    if (typeof PeerCtor === 'function') {
      try {
        this.peer = new PeerCtor(undefined, {
          debug: 1,
          config: { iceServers: ICE_SERVERS },
        });

        this.peer.on('open', (myGuestPeerId) => {
          this.peerOpen = true;
          this._peerBrokerId = myGuestPeerId || null;
          console.log('[P2P Guest] Connecté au broker PeerJS:', myGuestPeerId, '-> Connexion au salon:', cleanRoomId);
          this.onPeerReady(cleanRoomId, inviteUrl, 'Connexion au salon…');
          attemptPeerConnect();
        });

        this.peer.on('error', (err) => {
          console.warn('[PeerJS Guest Error]', err?.type || err);
          this.onPeerError(err);
          this._emitState();
        });
      } catch (err) {
        console.error('[PeerJS Guest Init Exception]', err);
        this.onPeerError(err);
      }
    }

    this._emitState();
  }

  _setupLocalBroadcast(roomId) {
    if (typeof BroadcastChannel === 'undefined') return;
    if (this.localBroadcast) {
      try { this.localBroadcast.close(); } catch (_) {}
    }
    this.localBroadcast = new BroadcastChannel(`apex_duo_p2p_${roomId}`);
    this.localBroadcast.onmessage = (ev) => {
      const data = ev.data;
      if (!data) return;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this._handleBinaryPacket(data, null);
      } else if (typeof data === 'object' && data.senderClientId !== this._localClientId) {
        this._handleControlMessage(data, data.senderClientId || 'local_bc');
      }
    };
  }

  /**
   * Démarre le relais HTTP local `/api/p2p` (quand servi par `server.py`) pour garantir
   * la connexion même entre deux navigateurs différents ou derrière un pare-feu bloquant WebRTC.
   */
  _startLocalHttpRelay(roomId) {
    if (this._httpRelayTimer) {
      clearInterval(this._httpRelayTimer);
      this._httpRelayTimer = null;
    }
    this._httpLastSeq = 0;
    if (typeof fetch !== 'function' || !roomId) return;

    const pollHttp = () => {
      if (!this.active || !this.roomId) return;
      const url = `/api/p2p?room=${encodeURIComponent(this.roomId)}&clientId=${encodeURIComponent(this._localClientId)}&since=${this._httpLastSeq}`;
      fetch(url, { method: 'GET', cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data || !this.active) return;
          if (typeof data.seq === 'number' && data.seq > this._httpLastSeq) {
            this._httpLastSeq = data.seq;
          }
          if (Array.isArray(data.events)) {
            for (const ev of data.events) {
              if (ev && ev.senderClientId !== this._localClientId) {
                this._handleControlMessage(ev, ev.senderClientId || 'http_relay');
              }
            }
          }
          if (Array.isArray(data.fast)) {
            for (const arr of data.fast) {
              if (Array.isArray(arr) && arr.length >= 7) {
                this._handleBinaryPacket(new Float32Array(arr), null);
              }
            }
          }
        })
        .catch(() => {});
    };

    this._httpRelayTimer = setInterval(pollHttp, 160);
    pollHttp();
  }

  _postHttpRelay(payloadObj) {
    if (typeof fetch !== 'function' || !this.active || !this.roomId) return;
    fetch('/api/p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: this.roomId,
        clientId: this._localClientId,
        ...payloadObj,
      }),
    }).catch(() => {});
  }

  /**
   * Côté Hôte : gère l'arrivée d'une connexion WebRTC entrante d'un Invité (Slot 2, 3 ou 4).
   */
  _bindIncomingHostConnection(conn) {
    if (!conn || this.role !== 'host') return;
    const peerId = conn.metadata?.clientId || conn.peer || `guest_${Date.now()}`;
    const chType = conn.metadata?.channel || (conn.reliable === false ? 'fast' : 'control');

    let entry = this.guestPeers.get(peerId);
    if (!entry) {
      const freeSlot = this._findOrAssignSlotForPeer(peerId, conn.metadata?.guestName);
      if (freeSlot < 0) {
        conn.on('open', () => {
          try {
            conn.send({ type: 'ROOM_FULL', message: 'Ce salon est complet (4/4 joueurs maximum).' });
            setTimeout(() => { try { conn.close(); } catch (_) {} }, 250);
          } catch (_) {}
        });
        return;
      }
      entry = {
        peerId,
        slotIndex: freeSlot,
        controlConn: null,
        fastConn: null,
        lastRxSeq: 0,
      };
      this.guestPeers.set(peerId, entry);
    }

    if (chType === 'fast') {
      entry.fastConn = conn;
    } else {
      entry.controlConn = conn;
    }

    conn.on('open', () => {
      this._syncLegacyFlags();
      if (chType === 'control') {
        this._sendWelcomeToGuestPeer(entry);
        this.broadcastLobbyState();
        this.onPeerConnected(entry.slotIndex);
      }
      this._emitState();
    });

    conn.on('data', (data) => {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this._handleBinaryPacket(data, entry);
      } else if (typeof data === 'object') {
        this._handleControlMessage(data, peerId, entry);
      }
    });

    conn.on('close', () => {
      if (chType === 'control') {
        this._handleGuestPeerDisconnected(peerId);
      }
    });

    conn.on('error', (err) => {
      console.warn(`[PeerJS Host DataChannel Error (${chType}, slot=${entry.slotIndex})]`, err);
    });
  }

  _findOrAssignSlotForPeer(peerId, preferredName = '') {
    // Vérifie si ce peerId possède déjà un slot attribué
    for (let i = 1; i < MAX_ONLINE_PLAYERS; i++) {
      if (this.slots[i].occupied && this.slots[i].peerId === peerId) {
        return i;
      }
    }
    // Attribue le premier slot libre parmi 1, 2, 3
    for (let i = 1; i < MAX_ONLINE_PLAYERS; i++) {
      if (!this.slots[i].occupied) {
        const defaultCar = DEFAULT_SLOT_CARS[i] || DEFAULT_SLOT_CARS[1];
        const name = (preferredName || `PILOTE ${i + 1}`).trim().slice(0, 18);
        this.slots[i] = {
          slotIndex: i,
          occupied: true,
          isHost: false,
          peerId,
          name,
          ready: false,
          carConfig: { ...defaultCar, name },
        };
        return i;
      }
    }
    return -1;
  }

  _handleGuestPeerDisconnected(peerId) {
    if (this.role !== 'host') return;
    const entry = this.guestPeers.get(peerId);
    let slotIdx = entry ? entry.slotIndex : -1;
    if (slotIdx < 0) {
      const found = this.slots.find((s) => !s.isHost && s.occupied && s.peerId === peerId);
      if (found) slotIdx = found.slotIndex;
    }

    this.guestPeers.delete(peerId);

    if (slotIdx >= 1 && slotIdx < MAX_ONLINE_PLAYERS) {
      const leavingName = this.slots[slotIdx]?.name || `PILOTE ${slotIdx + 1}`;
      this.slots[slotIdx] = {
        slotIndex: slotIdx,
        occupied: false,
        isHost: false,
        peerId: null,
        name: `Slot ${slotIdx + 1} (Libre)`,
        ready: false,
        carConfig: { ...DEFAULT_SLOT_CARS[slotIdx] },
      };

      this._syncLegacyFlags();
      this.broadcastLobbyState();
      this._sendControlMessage({
        type: 'PLAYER_DISCONNECTED',
        slotIndex: slotIdx,
        playerName: leavingName,
      });

      this.onPlayerMidRaceDisconnect(slotIdx, leavingName);
      this.onGuestReadyChange(this.guestReady, null, leavingName, slotIdx);
      this.onGuestLeft(slotIdx, leavingName);
      this.onPeerDisconnected(slotIdx);
      this._emitState();
    }
  }

  /**
   * Côté Invité : gère les événements des canaux `control` et `fast` connectés à l'Hôte.
   */
  _bindGuestConnectionEvents(conn, chType, cleanRoomId = null) {
    if (!conn) return;
    if (chType === 'fast') {
      this.fastConn = conn;
    } else {
      this.reliableConn = conn;
    }

    conn.on('open', () => {
      this.connected = true;
      if (this.role === 'guest' && chType === 'control') {
        this._sendControlMessage({
          type: 'GUEST_HELLO',
          clientId: this._localClientId,
          guestName: this.guestName,
          carConfig: this._lastGuestCarConfig,
          ready: Boolean(this.slots[this.mySlotIndex]?.ready),
        });
        // Ouvre le canal rapide non-bloquant une fois le canal fiable établi (évite les collisions ICE/SDP)
        const targetRoom = cleanRoomId || this.roomId;
        if (targetRoom && this.peer && (!this.fastConn || !this.fastConn.open)) {
          setTimeout(() => {
            if (!this.active || this.role !== 'guest' || !this.peer) return;
            try {
              const fastConn = this.peer.connect(targetRoom, {
                reliable: false,
                serialization: 'binary',
                metadata: { channel: 'fast', clientId: this._localClientId },
              });
              this._bindGuestConnectionEvents(fastConn, 'fast', targetRoom);
            } catch (_) {}
          }, 180);
        }
      }
      this.onPeerConnected(this.mySlotIndex);
      this._emitState();
    });

    conn.on('data', (data) => {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this._handleBinaryPacket(data, null);
      } else if (typeof data === 'object') {
        this._handleControlMessage(data, conn.peer || 'host', null);
      }
    });

    conn.on('close', () => {
      if (chType === 'control') {
        const wasRole = this.role;
        const wasIntentional = this._intentionalLeave;
        this.connected = false;
        if (wasRole === 'guest' && !wasIntentional) {
          this.disconnect();
          this.onHostLeft('L\'hôte s\'est déconnecté');
        }
      }
    });

    conn.on('error', (err) => {
      console.warn(`[PeerJS Guest DataChannel Error (${chType})]`, err);
    });
  }

  _sendWelcomeToGuestPeer(entry) {
    if (!entry || !entry.controlConn || !entry.controlConn.open) return;
    const msg = {
      type: 'HOST_WELCOME',
      msgId: `${this._localClientId}_${++this._controlSeq}`,
      assignedSlot: entry.slotIndex,
      roomId: this.roomId,
      hostName: this.hostName,
      carConfig: this.slots[0].carConfig,
      slots: this.slots,
      raceSettings: this._lastRaceSettings,
      senderRole: 'host',
      senderClientId: this._localClientId,
    };
    try {
      entry.controlConn.send(msg);
    } catch (_) {}
  }

  /**
   * Côté Hôte : diffuse l'état complet des 4 slots de la salle d'attente à tous les invités.
   */
  broadcastLobbyState() {
    if (this.role !== 'host') return;
    this._syncLegacyFlags();
    this._sendControlMessage({
      type: 'LOBBY_STATE',
      hostName: this.hostName,
      slots: this.slots,
      raceSettings: this._lastRaceSettings,
    });
  }

  _sendControlMessage(payload) {
    if (!this.active) return;
    const msg = {
      ...payload,
      msgId: payload.msgId || `${this._localClientId}_${++this._controlSeq}`,
      senderRole: this.role,
      senderSlot: this.mySlotIndex,
      senderClientId: this._localClientId,
    };

    if (this.role === 'host') {
      for (const entry of this.guestPeers.values()) {
        if (entry.controlConn && entry.controlConn.open) {
          try { entry.controlConn.send(msg); } catch (_) {}
        }
      }
    } else if (this.reliableConn && this.reliableConn.open) {
      try { this.reliableConn.send(msg); } catch (_) {}
    }

    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(msg); } catch (_) {}
    }

    this._postHttpRelay({ msg });
  }

  _sendFastBinary(floatArray) {
    if (!this.active) return;
    const buffer = floatArray.buffer;

    if (this.role === 'host') {
      for (const entry of this.guestPeers.values()) {
        const fast = entry.fastConn;
        if (fast && fast.open) {
          const dc = fast.dataChannel || fast._dc;
          if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 16384) {
            continue;
          }
          try { fast.send(buffer); } catch (_) {}
          continue;
        }
        const rel = entry.controlConn;
        if (rel && rel.open) {
          const dc = rel.dataChannel || rel._dc;
          if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 20480) {
            continue;
          }
          try { rel.send(buffer); } catch (_) {}
        }
      }
    } else {
      if (this.fastConn && this.fastConn.open) {
        const dc = this.fastConn.dataChannel || this.fastConn._dc;
        if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 12288) {
          return;
        }
        try { this.fastConn.send(buffer); } catch (_) {}
      } else if (this.reliableConn && this.reliableConn.open) {
        const dc = this.reliableConn.dataChannel || this.reliableConn._dc;
        if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 16384) {
          return;
        }
        try { this.reliableConn.send(buffer); } catch (_) {}
      }
    }

    if (this.localBroadcast) {
      try { this.localBroadcast.postMessage(buffer); } catch (_) {}
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._httpFastPushTs >= 110) {
      this._httpFastPushTs = now;
      this._postHttpRelay({ fast: Array.from(floatArray) });
    }
  }

  _handleControlMessage(msg, senderPeerId = null, hostEntry = null) {
    if (!msg || !msg.type) return;
    if (msg.msgId) {
      if (this._seenControlMsgIds.has(msg.msgId)) return;
      this._seenControlMsgIds.add(msg.msgId);
      if (this._seenControlMsgIds.size > 400) {
        const firstKey = this._seenControlMsgIds.values().next().value;
        this._seenControlMsgIds.delete(firstKey);
      }
    }

    switch (msg.type) {
      case 'ROOM_FULL': {
        if (this.role !== 'guest') break;
        this._intentionalLeave = true;
        this.disconnect();
        this.onHostLeft(msg.message || 'Ce salon est complet (4/4 joueurs).');
        break;
      }

      case 'GUEST_HELLO': {
        if (this.role !== 'host') break;
        const peerKey = msg.clientId || hostEntry?.peerId || senderPeerId || 'local_guest';
        let slotIdx = hostEntry ? hostEntry.slotIndex : this._findOrAssignSlotForPeer(peerKey, msg.guestName);
        if (slotIdx < 1 || slotIdx >= MAX_ONLINE_PLAYERS) break;
        // Nettoie tout éventuel doublon résiduel du même client sur un autre slot
        for (let i = 1; i < MAX_ONLINE_PLAYERS; i++) {
          if (i !== slotIdx && this.slots[i].occupied && (this.slots[i].peerId === peerKey || (senderPeerId && this.slots[i].peerId === senderPeerId))) {
            this.slots[i] = {
              slotIndex: i,
              occupied: false,
              isHost: false,
              peerId: null,
              name: `Slot ${i + 1} (Libre)`,
              ready: false,
              carConfig: { ...(DEFAULT_SLOT_CARS[i] || DEFAULT_SLOT_CARS[1]) },
            };
          }
        }

        const gName = (msg.guestName || `PILOTE ${slotIdx + 1}`).trim().slice(0, 18);
        const defaultCar = DEFAULT_SLOT_CARS[slotIdx] || DEFAULT_SLOT_CARS[1];
        const gCar = msg.carConfig
          ? { ...defaultCar, ...msg.carConfig, name: gName }
          : { ...defaultCar, name: gName };

        this.slots[slotIdx] = {
          slotIndex: slotIdx,
          occupied: true,
          isHost: false,
          peerId: peerKey,
          name: gName,
          ready: Boolean(msg.ready),
          carConfig: gCar,
        };

        this._syncLegacyFlags();
        this.onRemoteCarUpdate(slotIdx, gCar, gName);

        if (hostEntry) {
          this._sendWelcomeToGuestPeer(hostEntry);
        } else {
          // Réponse via BroadcastChannel pour les tests multi-onglets locaux
          this._sendControlMessage({
            type: 'HOST_WELCOME',
            targetClientId: peerKey,
            assignedSlot: slotIdx,
            roomId: this.roomId,
            hostName: this.hostName,
            carConfig: this.slots[0].carConfig,
            slots: this.slots,
            raceSettings: this._lastRaceSettings,
          });
        }

        this.broadcastLobbyState();
        this.onLobbyStateChange({
          slots: this.slots,
          guestName: gName,
          guestCar: gCar,
          guestReady: this.guestReady,
        });
        this.onGuestReadyChange(this.guestReady, gCar, gName, slotIdx);
        this.onPeerConnected(slotIdx);
        this._emitState();
        break;
      }

      case 'HOST_WELCOME': {
        if (this.role !== 'guest') break;
        if (msg.targetClientId && msg.targetClientId !== this._localClientId) break;

        const wasConnected = this.connected;
        this.connected = true;
        if (typeof msg.assignedSlot === 'number' && msg.assignedSlot >= 1 && msg.assignedSlot < MAX_ONLINE_PLAYERS) {
          this.mySlotIndex = msg.assignedSlot;
        }
        this.hostName = msg.hostName || 'HÔTE';

        if (Array.isArray(msg.slots) && msg.slots.length === MAX_ONLINE_PLAYERS) {
          this.slots = msg.slots.map((s, idx) => ({
            ...s,
            slotIndex: idx,
            carConfig: { ...(DEFAULT_SLOT_CARS[idx] || DEFAULT_SLOT_CARS[0]), ...(s.carConfig || {}) },
          }));
          // S'assure que la config locale de l'invité est bien appliquée sur son slot attribué
          if (this._lastGuestCarConfig) {
            this.slots[this.mySlotIndex].carConfig = {
              ...this._lastGuestCarConfig,
              name: this.guestName,
            };
            this.slots[this.mySlotIndex].name = this.guestName;
            this.slots[this.mySlotIndex].occupied = true;
          }
          for (let i = 0; i < MAX_ONLINE_PLAYERS; i++) {
            if (this.slots[i].occupied && this.slots[i].carConfig) {
              this.onRemoteCarUpdate(i, this.slots[i].carConfig, this.slots[i].name);
            }
          }
        } else if (msg.carConfig) {
          this._lastHostCarConfig = { ...msg.carConfig, name: this.hostName };
          this.onRemoteCarUpdate(0, this._lastHostCarConfig, this.hostName);
        }

        if (msg.raceSettings) {
          this._lastRaceSettings = { ...msg.raceSettings };
          this.onRaceSettingsUpdate(this._lastRaceSettings);
        }

        this._syncLegacyFlags();
        this.onLobbyStateChange({
          slots: this.slots,
          mySlotIndex: this.mySlotIndex,
          hostName: this.hostName,
          hostCar: this.slots[0]?.carConfig,
          raceSettings: this._lastRaceSettings,
        });
        if (!wasConnected) {
          this.onPeerConnected(this.mySlotIndex);
        }
        this._emitState();
        break;
      }

      case 'LOBBY_STATE': {
        if (this.role !== 'guest') break;
        if (msg.hostName) this.hostName = msg.hostName;
        if (Array.isArray(msg.slots) && msg.slots.length === MAX_ONLINE_PLAYERS) {
          this.slots = msg.slots.map((s, idx) => ({
            ...s,
            slotIndex: idx,
            carConfig: { ...(DEFAULT_SLOT_CARS[idx] || DEFAULT_SLOT_CARS[0]), ...(s.carConfig || {}) },
          }));
          for (let i = 0; i < MAX_ONLINE_PLAYERS; i++) {
            if (this.slots[i].occupied && this.slots[i].carConfig) {
              this.onRemoteCarUpdate(i, this.slots[i].carConfig, this.slots[i].name);
            }
          }
        }
        if (msg.raceSettings) {
          this._lastRaceSettings = { ...msg.raceSettings };
          this.onRaceSettingsUpdate(this._lastRaceSettings);
        }
        this._syncLegacyFlags();
        this.onLobbyStateChange({
          slots: this.slots,
          mySlotIndex: this.mySlotIndex,
          hostName: this.hostName,
          raceSettings: this._lastRaceSettings,
        });
        this._emitState();
        break;
      }

      case 'CAR_UPDATE': {
        const targetIdx = typeof msg.playerIndex === 'number'
          ? msg.playerIndex
          : (hostEntry ? hostEntry.slotIndex : (msg.senderRole === 'host' ? 0 : 1));
        if (targetIdx < 0 || targetIdx >= MAX_ONLINE_PLAYERS) break;

        const senderName = (msg.playerName || msg.carConfig?.name || this.slots[targetIdx]?.name || `PILOTE ${targetIdx + 1}`).trim().slice(0, 18);
        if (targetIdx === 0) this.hostName = senderName;

        if (msg.carConfig) {
          const updatedCfg = { ...msg.carConfig, name: senderName };
          this.slots[targetIdx].occupied = true;
          this.slots[targetIdx].name = senderName;
          this.slots[targetIdx].carConfig = updatedCfg;
          if (targetIdx === 0) this._lastHostCarConfig = updatedCfg;
          if (targetIdx === 1) this._lastGuestCarConfig = updatedCfg;
          this.onRemoteCarUpdate(targetIdx, updatedCfg, senderName);
        }

        if (this.role === 'host') {
          this.broadcastLobbyState();
        }
        this.onLobbyStateChange({ slots: this.slots });
        this._emitState();
        break;
      }

      case 'GUEST_READY': {
        if (this.role !== 'host') break;
        const peerKey = msg.clientId || hostEntry?.peerId || senderPeerId || null;
        let slotIdx = hostEntry ? hostEntry.slotIndex : -1;
        if (slotIdx < 1 && peerKey) {
          const found = this.slots.find((s) => !s.isHost && s.occupied && s.peerId === peerKey);
          if (found) slotIdx = found.slotIndex;
        }
        if (slotIdx < 1) {
          slotIdx = (typeof msg.slotIndex === 'number' && msg.slotIndex >= 1 && msg.slotIndex < MAX_ONLINE_PLAYERS)
            ? msg.slotIndex
            : 1;
        }
        if (slotIdx < 1 || slotIdx >= MAX_ONLINE_PLAYERS) break;

        const gName = (msg.guestName || this.slots[slotIdx]?.name || `PILOTE ${slotIdx + 1}`).trim().slice(0, 18);
        this.slots[slotIdx].occupied = true;
        if (peerKey && !this.slots[slotIdx].peerId) {
          this.slots[slotIdx].peerId = peerKey;
        }
        this.slots[slotIdx].name = gName;
        this.slots[slotIdx].ready = Boolean(msg.ready);
        if (msg.carConfig) {
          this.slots[slotIdx].carConfig = { ...msg.carConfig, name: gName };
          this.onRemoteCarUpdate(slotIdx, this.slots[slotIdx].carConfig, gName);
        }

        this._syncLegacyFlags();
        this.broadcastLobbyState();
        this.onLobbyStateChange({ slots: this.slots });
        this.onGuestReadyChange(this.guestReady, this.slots[slotIdx].carConfig, gName, slotIdx);
        this._emitState();
        break;
      }

      case 'RACE_SETTINGS': {
        if (this.role !== 'guest') break;
        if (msg.raceSettings) {
          this._lastRaceSettings = { ...msg.raceSettings };
          this.onRaceSettingsUpdate(this._lastRaceSettings);
        }
        break;
      }

      case 'START_ONLINE_RACE': {
        if (this.role !== 'guest') break;
        this.onStartOnlineRace(msg.payload);
        break;
      }

      case 'RESET_ONLINE_RACE': {
        if (this.role !== 'guest') break;
        this.onResetOnlineRace(msg.payload);
        break;
      }

      case 'RACE_EVENT': {
        if (this.role === 'host') {
          // Relaye l'événement fiable à tous les autres invités
          this._sendControlMessage(msg);
        }
        this.onRaceEvent(msg);
        break;
      }

      case 'PLAYER_DISCONNECTED': {
        if (this.role !== 'guest') break;
        const sIdx = msg.slotIndex;
        if (typeof sIdx === 'number' && sIdx >= 1 && sIdx < MAX_ONLINE_PLAYERS) {
          this.slots[sIdx].occupied = false;
          this.slots[sIdx].ready = false;
          this.slots[sIdx].name = `Slot ${sIdx + 1} (Libre)`;
          this.onPlayerMidRaceDisconnect(sIdx, msg.playerName || `PILOTE ${sIdx + 1}`);
          this.onLobbyStateChange({ slots: this.slots });
          this._emitState();
        }
        break;
      }

      case 'HOST_LEFT': {
        if (this.role !== 'guest') break;
        this._intentionalLeave = true;
        this.disconnect();
        this.onHostLeft('L\'hôte s\'est déconnecté');
        break;
      }

      case 'GUEST_LEFT': {
        if (this.role !== 'host') break;
        const peerKey = hostEntry?.peerId || msg.clientId || senderPeerId;
        if (peerKey) {
          this._handleGuestPeerDisconnected(peerKey);
        }
        break;
      }

      default:
        break;
    }
  }

  _handleBinaryPacket(rawBuffer, hostEntry = null) {
    const view = rawBuffer instanceof Float32Array
      ? rawBuffer
      : rawBuffer instanceof ArrayBuffer
        ? new Float32Array(rawBuffer)
        : new Float32Array(rawBuffer.buffer, rawBuffer.byteOffset, Math.floor(rawBuffer.byteLength / 4));
    if (view.length < 7) return;

    const magic = Math.round(view[0]);
    const seq = Math.round(view[1]);

    if (magic === PACKET_SNAPSHOT && this.role === 'guest') {
      if (seq <= this._lastRxSnapshotSeq && this._lastRxSnapshotSeq - seq < 3000) return;
      this._lastRxSnapshotSeq = seq;
      this.onSnapshot(view);
    } else if (magic === PACKET_GUEST_STATE && this.role === 'host' && view.length >= 18) {
      const slotIdx = hostEntry
        ? hostEntry.slotIndex
        : (view.length >= 19 ? Math.round(view[18]) : 1);
      if (slotIdx < 1 || slotIdx >= MAX_ONLINE_PLAYERS) return;

      const lastSeq = this._lastRxInputSeqBySlot[slotIdx] || 0;
      if (seq <= lastSeq && lastSeq - seq < 3000) return;
      this._lastRxInputSeqBySlot[slotIdx] = seq;

      const st = this._rxGuestStateObj;
      st.slotIndex = slotIdx;
      st.px = view[2];
      st.py = view[3];
      st.pz = view[4];
      st.qx = view[5];
      st.qy = view[6];
      st.qz = view[7];
      st.qw = view[8];
      st.forwardSpeed = view[9];
      st.steerAngle = view[10];
      st.boostEnergy = view[11];
      st.flags = Math.round(view[12]);
      st.slowdownTimer = view[13];
      st.lap = Math.round(view[14]);
      st.progOrFinish = view[15];
      st.pickedTokenIdx = Math.round(view[16]);
      st.lateralSpeed = view[17];
      this.onGuestState(st);
    } else if (magic === PACKET_GUEST_INPUT && this.role === 'host') {
      const slotIdx = hostEntry
        ? hostEntry.slotIndex
        : (view.length >= 8 ? Math.round(view[7]) : 1);
      if (slotIdx < 1 || slotIdx >= MAX_ONLINE_PLAYERS) return;

      const lastSeq = this._lastRxInputSeqBySlot[slotIdx] || 0;
      if (seq <= lastSeq && lastSeq - seq < 3000) return;
      this._lastRxInputSeqBySlot[slotIdx] = seq;

      const inp = this._rxGuestInputObj;
      inp.slotIndex = slotIdx;
      inp.throttle = view[2];
      inp.brake = view[3];
      inp.steer = view[4];
      inp.boost = view[5] > 0.5;
      inp.reset = view[6] > 0.5;
      this.onGuestInput(inp);
    }
  }

  /** Envoie le message d'accueil et diffuse l'état du salon. */
  sendHostWelcome(hostCarConfig, raceSettings) {
    if (hostCarConfig) {
      this._lastHostCarConfig = { ...hostCarConfig, name: this.hostName };
      this.slots[0].carConfig = { ...this._lastHostCarConfig };
    }
    if (raceSettings) this._lastRaceSettings = { ...raceSettings };
    if (this.role !== 'host') return;
    this.broadcastLobbyState();
  }

  /** Met à jour le pseudonyme du joueur local (Hôte ou Invité) et le diffuse. */
  setLocalName(name, carConfig) {
    if (this.role === 'guest') {
      this.setGuestName(name, carConfig);
    } else {
      this.setHostName(name, carConfig);
    }
  }

  /** Met à jour le pseudonyme de l'Hôte et le diffuse à tous les Invités. */
  setHostName(name, hostCarConfig) {
    this.hostName = (name || 'HÔTE').trim().slice(0, 18) || 'HÔTE';
    if (hostCarConfig) {
      this._lastHostCarConfig = { ...hostCarConfig, name: this.hostName };
    }
    this.slots[0].name = this.hostName;
    if (this._lastHostCarConfig) {
      this.slots[0].carConfig = { ...this._lastHostCarConfig, name: this.hostName };
    }
    if (this.role === 'host') {
      this.broadcastLobbyState();
      this._emitState();
    }
  }

  /** Met à jour le pseudonyme de l'Invité sur son slot attribué et le diffuse à l'Hôte. */
  setGuestName(name, guestCarConfig) {
    this.guestName = (name || `PILOTE ${this.mySlotIndex + 1}`).trim().slice(0, 18) || `PILOTE ${this.mySlotIndex + 1}`;
    if (guestCarConfig) {
      this._lastGuestCarConfig = { ...guestCarConfig, name: this.guestName };
    }
    if (this.slots[this.mySlotIndex]) {
      this.slots[this.mySlotIndex].name = this.guestName;
      if (this._lastGuestCarConfig) {
        this.slots[this.mySlotIndex].carConfig = { ...this._lastGuestCarConfig };
      }
    }
    if (this.role === 'guest') {
      this._sendControlMessage({
        type: 'CAR_UPDATE',
        playerIndex: this.mySlotIndex,
        playerName: this.guestName,
        carConfig: this._lastGuestCarConfig,
      });
      this._emitState();
    }
  }

  /** Envoie instantanément toute modification de personnalisation 3D du joueur local. */
  sendCarUpdate(carConfig) {
    if (!this.active || !carConfig) return;
    const playerIndex = this.role === 'guest' ? this.mySlotIndex : 0;
    this.sendCarCustomization(playerIndex, carConfig);
  }

  /** Envoie instantanément toute modification de personnalisation 3D d'un slot aux autres joueurs. */
  sendCarCustomization(playerIndex, carConfig) {
    if (!this.active || !carConfig) return;
    const slotIdx = (typeof playerIndex === 'number' && playerIndex >= 0 && playerIndex < MAX_ONLINE_PLAYERS)
      ? playerIndex
      : this.mySlotIndex;
    const playerName = slotIdx === 0 ? this.hostName : (this.slots[slotIdx]?.name || this.guestName);
    const cfg = { ...carConfig, name: playerName };

    if (this.slots[slotIdx]) {
      this.slots[slotIdx].carConfig = cfg;
      this.slots[slotIdx].name = playerName;
    }
    if (slotIdx === 0) this._lastHostCarConfig = cfg;
    if (slotIdx === this.mySlotIndex && this.role === 'guest') this._lastGuestCarConfig = cfg;

    this._sendControlMessage({
      type: 'CAR_UPDATE',
      playerIndex: slotIdx,
      playerName,
      carConfig: cfg,
    });
  }

  /** Bascule l'état « Prêt / Pas prêt » de l'Invité sur son slot et l'envoie à l'Hôte. */
  setGuestReady(ready, guestCarConfig) {
    if (this.role !== 'guest') return;
    const isReady = Boolean(ready);
    if (guestCarConfig) {
      this._lastGuestCarConfig = { ...guestCarConfig, name: this.guestName };
    }
    if (this.slots[this.mySlotIndex]) {
      this.slots[this.mySlotIndex].ready = isReady;
      if (this._lastGuestCarConfig) {
        this.slots[this.mySlotIndex].carConfig = { ...this._lastGuestCarConfig };
      }
    }
    this.guestReady = isReady;
    this._sendControlMessage({
      type: 'GUEST_READY',
      clientId: this._localClientId,
      slotIndex: this.mySlotIndex,
      ready: isReady,
      guestName: this.guestName,
      carConfig: this._lastGuestCarConfig,
    });
    this._emitState();
  }

  /** Synchronise les paramètres de salon choisis par l'Hôte vers tous les Invités. */
  sendRaceSettings(raceSettings) {
    if (raceSettings) this._lastRaceSettings = { ...raceSettings };
    if (this.role !== 'host') return;
    this._sendControlMessage({
      type: 'RACE_SETTINGS',
      raceSettings: this._lastRaceSettings,
    });
  }

  /** L'Hôte déclenche le départ de la course en ligne pour tous les joueurs connectés. */
  sendStartOnlineRace(payload) {
    if (this.role !== 'host') return;
    this._lastRxSnapshotSeq = 0;
    this._lastRxInputSeqBySlot.fill(0);
    this._hostTxAccum = NET_TICK_INTERVAL;
    this._sendControlMessage({
      type: 'START_ONLINE_RACE',
      payload,
    });
  }

  /** L'Hôte déclenche une relance de manche (Rejouer) pour tous les joueurs. */
  sendResetOnlineRace(payload) {
    if (this.role !== 'host') return;
    this._lastRxSnapshotSeq = 0;
    this._lastRxInputSeqBySlot.fill(0);
    this._hostTxAccum = NET_TICK_INTERVAL;
    this._sendControlMessage({
      type: 'RESET_ONLINE_RACE',
      payload,
    });
  }

  /** Envoie un événement clé fiable/ordonné (ex: Top départ GO, tour franchi, arrivée). */
  sendRaceEvent(eventPayload) {
    if (!this.active || !eventPayload) return;
    this._sendControlMessage({
      type: 'RACE_EVENT',
      ...eventPayload,
    });
  }

  /**
   * Côté Hôte : encode et diffuse l'état physique de tous les véhicules et jetons à 30 Hz
   * sous forme de `Float32Array` plat (`[posX, posY, posZ, quatX, quatY, quatZ, quatW, speed, boostActive, ...]`).
   */
  broadcastHostPhysicsState(raceScene, dt = NET_TICK_INTERVAL) {
    if (!this.active || this.role !== 'host') return;

    this._hostTxAccum += dt;
    if (this._hostTxAccum + 1e-5 < NET_TICK_INTERVAL) return;
    this._hostTxAccum %= NET_TICK_INTERVAL;

    const vehicles = raceScene.vehicles;
    const count = Math.min(10, vehicles.length);
    const buf = this._snapshotBuffersByCount[count] || this._snapshotFloats;

    this._txSeq = (this._txSeq + 1) % 1000000;
    const stateCode = raceScene.state === 'countdown'
      ? 1
      : raceScene.state === 'racing'
        ? 2
        : raceScene.state === 'finished'
          ? 3
          : 0;

    let tokenMask = 0;
    const tokens = raceScene.boostTokens?.tokens;
    if (tokens) {
      for (let t = 0; t < tokens.length; t++) {
        if (tokens[t].active) tokenMask |= (1 << t);
      }
    }

    buf[0] = PACKET_SNAPSHOT;
    buf[1] = this._txSeq;
    buf[2] = stateCode;
    buf[3] = raceScene.countdownTimer || 0;
    buf[4] = raceScene.raceTime || 0;
    buf[5] = tokenMask;
    buf[6] = count;

    for (let i = 0; i < count; i++) {
      const v = vehicles[i];
      const base = HEADER_FLOATS + i * VEHICLE_FLOATS;
      const p = v.chassisBody.position;
      const q = v.chassisBody.quaternion;

      const notifCode = v.hudNotificationTimer > 0
        ? (v.hudNotificationType === 'super' ? 2 : v.hudNotificationType === 'slowdown' ? 3 : 1)
        : 0;

      const flags = (v.isBoosting ? 1 : 0)
        | (v.isDrifting ? 2 : 0)
        | (v.finished ? 4 : 0)
        | (v.isWrongWay ? 8 : 0)
        | (v.parkingLocked ? 16 : 0)
        | (notifCode << 5);

      buf[base + 0] = p.x;
      buf[base + 1] = p.y;
      buf[base + 2] = p.z;
      buf[base + 3] = q.x;
      buf[base + 4] = q.y;
      buf[base + 5] = q.z;
      buf[base + 6] = q.w;
      buf[base + 7] = v.forwardSpeed;
      buf[base + 8] = v.isBoosting ? 1 : 0;
      buf[base + 9] = v.steerAngle;
      buf[base + 10] = v.boostEnergy;
      buf[base + 11] = flags;
      buf[base + 12] = v.slowdownTimer || 0;
      buf[base + 13] = v.lap || 1;
      buf[base + 14] = v.rank || (i + 1);
      buf[base + 15] = v.finished ? (v.finishTime || 0) : (v.raceProgress || 0);
    }

    this._sendFastBinary(buf);
  }

  /**
   * Côté Invité : envoie l'état physique complet de sa voiture à 30 Hz vers l'Hôte via DataChannel non-fiable.
   */
  sendGuestState(vehicle, pickedTokenIdx = -1, dt = NET_TICK_INTERVAL) {
    if (!this.active || this.role !== 'guest' || !vehicle) return;
    this._guestTxAccum += dt;
    if (pickedTokenIdx < 0 && this._guestTxAccum + 1e-5 < NET_TICK_INTERVAL) return;
    this._guestTxAccum %= NET_TICK_INTERVAL;

    this._txSeq = (this._txSeq + 1) % 1000000;
    const buf = this._guestStateFloats;
    const p = vehicle.chassisBody.position;
    const q = vehicle.chassisBody.quaternion;

    const notifCode = vehicle.hudNotificationTimer > 0
      ? (vehicle.hudNotificationType === 'super' ? 2 : vehicle.hudNotificationType === 'slowdown' ? 3 : 1)
      : 0;

    const flags = (vehicle.isBoosting ? 1 : 0)
      | (vehicle.isDrifting ? 2 : 0)
      | (vehicle.finished ? 4 : 0)
      | (vehicle.isWrongWay ? 8 : 0)
      | (vehicle.parkingLocked ? 16 : 0)
      | (notifCode << 5);

    buf[0] = PACKET_GUEST_STATE;
    buf[1] = this._txSeq;
    buf[2] = p.x;
    buf[3] = p.y;
    buf[4] = p.z;
    buf[5] = q.x;
    buf[6] = q.y;
    buf[7] = q.z;
    buf[8] = q.w;
    buf[9] = vehicle.forwardSpeed;
    buf[10] = vehicle.steerAngle;
    buf[11] = vehicle.boostEnergy;
    buf[12] = flags;
    buf[13] = vehicle.slowdownTimer || 0;
    buf[14] = vehicle.lap || 1;
    buf[15] = vehicle.finished ? (vehicle.finishTime || 0) : (vehicle.raceProgress || 0);
    buf[16] = pickedTokenIdx;
    buf[17] = vehicle.lateralSpeed || 0;
    buf[18] = this.mySlotIndex;
    this._sendFastBinary(buf);
  }

  sendGuestControls(controls, dt = NET_TICK_INTERVAL) {
    if (!this.active || this.role !== 'guest') return;
    this._guestTxAccum += dt;
    if (!controls.reset && this._guestTxAccum + 1e-5 < NET_TICK_INTERVAL) return;
    this._guestTxAccum %= NET_TICK_INTERVAL;

    this._txSeq = (this._txSeq + 1) % 1000000;
    const buf = this._inputFloats;
    buf[0] = PACKET_GUEST_INPUT;
    buf[1] = this._txSeq;
    buf[2] = controls.throttle || 0;
    buf[3] = controls.brake || 0;
    buf[4] = controls.steer || 0;
    buf[5] = controls.boost ? 1 : 0;
    buf[6] = controls.reset ? 1 : 0;
    buf[7] = this.mySlotIndex;
    this._sendFastBinary(buf);
  }

  /**
   * Quitte proprement le groupe P2P (notifie les pairs, ferme WebRTC et détruit l'instance PeerJS).
   */
  leaveGroup() {
    this._intentionalLeave = true;
    if (this.active) {
      if (this.role === 'host') {
        this._sendControlMessage({ type: 'HOST_LEFT' });
      } else if (this.role === 'guest') {
        this._sendControlMessage({ type: 'GUEST_LEFT', clientId: this._localClientId, slotIndex: this.mySlotIndex });
      }
    }
    this.disconnect();
  }

  _emitState() {
    this._syncLegacyFlags();
    this.onStateChange({
      active: this.active,
      role: this.role,
      mySlotIndex: this.mySlotIndex,
      roomId: this.roomId,
      inviteUrl: this.inviteUrl,
      peerOpen: this.peerOpen,
      connected: this.connected,
      hostName: this.hostName,
      guestName: this.guestName,
      hostReady: this.hostReady,
      guestReady: this.guestReady,
      slots: this.slots,
      connectedCount: this.getConnectedPlayerCount(),
      canStart: this.canStartOnlineRace(),
    });
  }

  disconnect() {
    if (this._openFallbackTimer) {
      clearTimeout(this._openFallbackTimer);
      this._openFallbackTimer = null;
    }
    if (this._guestConnectRetryTimer) {
      clearInterval(this._guestConnectRetryTimer);
      this._guestConnectRetryTimer = null;
    }
    if (this._httpRelayTimer) {
      clearInterval(this._httpRelayTimer);
      this._httpRelayTimer = null;
    }
    this._seenControlMsgIds.clear();
    this.active = false;
    this.role = 'offline';
    this.mySlotIndex = 0;
    this.roomId = null;
    this.inviteUrl = '';
    this.peerOpen = false;
    this.connected = false;
    this.guestReady = false;
    this._hostTxAccum = 0;
    this._guestTxAccum = 0;

    for (const entry of this.guestPeers.values()) {
      if (entry.fastConn) {
        try { entry.fastConn.close(); } catch (_) {}
      }
      if (entry.controlConn) {
        try { entry.controlConn.close(); } catch (_) {}
      }
    }
    this.guestPeers.clear();

    if (this.fastConn) {
      try { this.fastConn.close(); } catch (_) {}
      this.fastConn = null;
    }
    if (this.reliableConn) {
      try { this.reliableConn.close(); } catch (_) {}
      this.reliableConn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }
    if (this.localBroadcast) {
      try { this.localBroadcast.close(); } catch (_) {}
      this.localBroadcast = null;
    }
    this.slots = this._createInitialSlots();
  }
}

export { HEADER_FLOATS, VEHICLE_FLOATS, NET_TICK_RATE, NET_TICK_INTERVAL, MAX_ONLINE_PLAYERS };
