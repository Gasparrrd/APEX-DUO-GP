/**
 * config.js — Paramètres globaux du jeu, modificateurs de statistiques des véhicules,
 * conditions météo dynamiques, profils comportementaux IA et contrôles.
 */

export const CONFIG = {
  physics: {
    step: 1 / 60,          // pas fixe de la simulation (s)
    maxSubSteps: 3,        // world.step(1/60, deltaTime, 3) anti-saccades
    gravity: 9.82,
    solverIterations: 10,
  },

  render: {
    maxPixelRatio: 2,      // Math.min(window.devicePixelRatio, 2)
    cameraNear: 0.1,       // Plan proche stabilisé pour éviter tout conflit de z-buffer
    cameraFar: 3000,       // Plan lointain optimisé (ratio far/near propre sans logarithmicDepthBuffer)
    fogNear: 380,
    fogFar: 2650,
    separatorPx: 4,
  },

  track: {
    halfWidth: 7,          // demi-largeur de la piste (m)
    sampleSpacing: 2,      // échantillonnage de la ligne centrale (m)
    curbWidth: 1.3,
    barrierOffset: 5.5,    // distance bord de piste -> glissière (m)
    barrierHeight: 2.4,
    barrierThickness: 1.6,
    numCheckpoints: 10,
  },

  race: {
    playerCount: 2,        // 1 = Mode Solo (plein écran), 2 = Écran Scindé
    circuit: 'flat',       // 'flat' (Circuit 1 Plat) | 'mountain' (Circuit 2 Col de Montagne) | 'valley' (Circuit 3)
    weather: 'sunny',      // 'sunny' | 'rain' | 'storm' | 'random'
    globalGrip: 1.0,       // Curseur Adhérence Générale : 0.50 (50%) à 1.50 (150%), défaut 1.00 (100%)
    engineSound: 'thermal',// 'electric' (Électrique) | 'thermal' (Thermique)
    laps: 3,
    bots: 3,
    difficulty: 'normal',  // 'easy' (Facile) | 'normal' (Moyen) | 'hard' (Difficile)
    finishTimeout: 45,
  },

  car: {
    mass: 1150,
    chassisHalfExtents: [0.9, 0.38, 2.1],
    chassisOffsetY: 0.05,
    wheelRadius: 0.36,
    wheelWidth: 0.28,
    wheelHalfTrack: 0.8,
    wheelFrontZ: -1.32,    // l'avant de la voiture est vers -Z
    wheelRearZ: 1.28,
    connectionY: 0.0,
    suspensionRestLength: 0.32,
    suspensionStiffness: 34,
    dampingRelaxation: 3.2,
    dampingCompression: 4.8,
    maxSuspensionTravel: 0.28,
    maxSuspensionForce: 1e6,
    rollInfluence: 0.11,
    frictionFront: 2.35,
    frictionRear: 2.10,
    lateralGripDamping: 4.2,
    grassFrictionFactor: 0.62,
    enginePower: 250000,
    maxEngineForce: 7400,
    frontTorqueShare: 0.25,
    reverseForce: 2800,
    maxReverseSpeed: 10,
    brakeImpulse: 45,
    engineBrake: 2.5,
    maxSteer: 0.54,
    minSteer: 0.24,
    steerSpeedRef: 68,
    steerRate: 4.2,
    steerReturnRate: 5.5,
    yawAssist: 0.45,
    dragCoef: 0.80,
    rollingResistance: 24,
    downforce: 3.1,
    grassDrag: 3.2,
    topSpeed: 64,          // m/s (~230 km/h de base)
    angularDamping: 0.38,
  },

  boost: {
    maxEnergy: 100,
    startEnergy: 15,       // Tous les joueurs et bots démarrent avec 15% de boost
    drain: 100 / 7.5,      // ~13,33% par seconde : une jauge pleine à 100% s'épuise en 7,5s continues (-25% durée)
    regen: 0,              // Aucune régénération passive automatique
    checkpointBonus: 0,    // Recharge uniquement par ramassage des jetons sur la piste
    speedMultiplier: 1.15, // +15% sur la vitesse instantanée maximale et la force motrice
    forceMultiplier: 1.15, // +15% sur la force motrice
    force: 3800,           // Poussée locale directe vers l'avant (-Z)
    topSpeedBonus: 9.6,    // +15% de 64 m/s
    tokenCount: 7,         // 6 jetons de boost sur le circuit (5 standards +25% + 1 rare +40%)
    normalBonus: 25,       // +25% de boost (6 jetons standards cyan/bleu translucide)
    rareBonus: 40,         // +40% de boost (1 jeton rare unique doré/orange translucide)
    slowdownTokenCount: 6, // 5 jetons ralentisseurs (malus rouge) répartis sur le circuit
    slowdownFactor: 0.75,  // -25% sur la vitesse actuelle et la puissance moteur
    slowdownDuration: 3.0, // Durée du malus de ralentissement : 2,5 secondes
    activeMinTime: 3.0,    // Durée minimale de la phase ACTIVE (3s)
    activeMaxTime: 10.0,   // Durée maximale de la phase ACTIVE (10s)
    cooldownMinTime: 3.0,  // Durée minimale de la phase COOLDOWN (3s)
    cooldownMaxTime: 10.0, // Durée maximale de la phase COOLDOWN (10s)
    respawnTime: 6.5,      // Moyenne de référence
  },

  ai: {
    lateralAccel: 13.0,
    brakeDecel: 9.2,
    maxSpeed: 63,
    lineMargin: 1.7,
    unstuckTime: 8.5,
    relaunchSpeed: 11.0,
  },

  difficulty: {
    easy: {
      label: 'Facile',
      skill: 0.75,
      maxSpeedFactor: 0.75,       // Vitesse de pointe plafonnée à 75%
      speedSpread: 0.040,         // Écart autour de la moyenne (±4% à somme nulle entre les bots)
      brakeLookaheadMult: 1.75,   // Freinage très anticipé avant les courbes
      cornerSpeedFactor: 0.82,
      steerGain: 1.55,            // Réactivité de braquage ralentie
      steerRateMult: 0.68,
      apexCut: 0.0,
      boostSeekWeight: 0.0,       // Aucune déviation agressive pour chercher les boosts excentrés
      boostMaxLatDeviation: 0.7,
      boostThreshold: 24,
      boostMaxCurvature: 0.0025,
    },
    normal: {
      label: 'Moyen',
      skill: 0.90,
      maxSpeedFactor: 0.90,       // Vitesse moyenne abaissée légèrement (90%)
      speedSpread: 0.045,         // Écart autour de la moyenne (±4,5% à somme nulle entre les bots)
      brakeLookaheadMult: 1.08,
      cornerSpeedFactor: 0.94,
      steerGain: 2.40,
      steerRateMult: 1.00,
      apexCut: 0.22,
      boostSeekWeight: 1.0,
      boostMaxLatDeviation: 3.2,
      boostThreshold: 10,
      boostMaxCurvature: 0.0038,
    },
    hard: {
      label: 'Difficile',
      skill: 1.04,
      maxSpeedFactor: 1.04,       // Vitesse moyenne abaissée légèrement (104%)
      speedSpread: 0.048,         // Écart autour de la moyenne (±4,8% à somme nulle entre les bots)
      brakeLookaheadMult: 0.60,   // Freinage tardif en entrée de courbe
      cornerSpeedFactor: 1.05,
      steerGain: 3.15,            // Braquage incisif et maintien serré à la corde
      steerRateMult: 1.35,
      apexCut: 0.85,              // Trajectoire très serrée à la corde
      boostSeekWeight: 1.95,      // Détection prioritaire des jetons de boost sans hésiter
      boostMaxLatDeviation: 5.6,
      boostThreshold: 2,          // Exploite le boost immédiatement en sortie de virage ou ligne droite
      boostMaxCurvature: 0.0080,
    },
  },
};

/**
 * 2. Modificateurs propres à chaque silhouette de véhicule :
 *  - Supercar  : Vitesse +15%, Accélération 1.0x, Grip +10%
 *  - Muscle GT : Vitesse 1.0x, Accélération +20%, Grip -10% (guidage amélioré en virage)
 *  - Monoplace : Vitesse -10%, Accélération +10%, Grip +25% (freinage tardif, rail)
 */
export const VEHICLE_MODIFIERS = {
  supercar: {
    label: 'Supercar',
    topSpeed: 1.15,
    acceleration: 1.00,
    grip: 1.10,
    braking: 1.05,
    description: 'Vitesse +15% · Accél. Neutre · Grip +10%',
  },
  muscle: {
    label: 'Muscle Car',
    topSpeed: 1.00,
    acceleration: 1.20,
    grip: 0.90,
    braking: 0.95,
    description: 'Vitesse Neutre · Couple +20% · Grip -10%',
  },
  formula: {
    label: 'Monoplace',
    topSpeed: 0.90,
    acceleration: 1.10,
    grip: 1.25,
    braking: 1.22,
    description: 'Vitesse -10% · Accél. +10% · Grip +25% (Appui max)',
  },
};

/**
 * 3. Conditions météorologiques dynamiques :
 *  - Ensoleillé (sunny) : Grip 1.0x, vent nul, ciel dégagé
 *  - Pluvieux (rain)    : Grip 0.75x, brouillard gris, pluie animée
 *  - Tempête (storm)    : Grip 0.85x, vecteur de vent latéral/frontal fort, vitesse réduite face au vent
 */
export const WEATHER_MODIFIERS = {
  sunny: {
    label: 'Ensoleillé (Sec)',
    topSpeed: 1.00,
    acceleration: 1.00,
    grip: 1.10, // Adhérence améliorée par temps sec (+10%)
    windForce: [0, 0, 0],
    dragMultiplier: 1.00,
    skyColor: 0x6ea8df,
    fogColor: 0x8ec2ef,
    fogNear: 380,
    fogFar: 2650,
    sunIntensity: 1.95,
    hemiIntensity: 1.05,
    roadRoughness: 0.84,
  },
  rain: {
    label: 'Pluvieux',
    topSpeed: 0.97,
    acceleration: 0.95,
    grip: 0.68, // Adhérence réduite par temps de pluie
    windForce: [220, 0, -160],
    dragMultiplier: 1.04,
    skyColor: 0x22262a,
    fogColor: 0x22262a,
    fogExp2Density: 0.015,
    fogNear: 40,
    fogFar: 280,
    sunIntensity: 0.62,
    hemiIntensity: 0.68,
    roadRoughness: 0.18,
    roadMetalness: 0.28,
  },
  storm: {
    label: 'Tempête / Venteux',
    topSpeed: 0.94,
    acceleration: 0.96,
    grip: 0.74, // Adhérence réduite par temps de tempête
    windForce: [1200, 0, -900], // Vecteur de vent constant et puissant (~1500 N homogène)
    dragMultiplier: 1.09,
    skyColor: 0x1c2024,
    fogColor: 0x22262a,
    fogExp2Density: 0.0165,
    fogNear: 35,
    fogFar: 240,
    sunIntensity: 0.48,
    hemiIntensity: 0.55,
    roadRoughness: 0.22,
    roadMetalness: 0.25,
  },
};

/**
 * Formule modulaire de calcul des statistiques d'un véhicule en temps réel :
 *   Stat_Finale = Paramètre_Global * Modificateur_Véhicule * Modificateur_Météo (* Adhérence_Générale)
 * Écrit dans `out` s'il est fourni afin d'éviter toute allocation GC dans la boucle physique 60 Hz.
 */
export function computeVehicleStats(bodyType = 'supercar', weatherKey = 'sunny', _unusedGrip = 1.0, out = null) {
  const base = CONFIG.car;
  const vMod = VEHICLE_MODIFIERS[bodyType] || VEHICLE_MODIFIERS.supercar;
  const wMod = WEATHER_MODIFIERS[weatherKey] || WEATHER_MODIFIERS.sunny;
  const target = (out && typeof out === 'object') ? out : {};

  target.topSpeed = base.topSpeed * vMod.topSpeed * wMod.topSpeed;
  target.enginePower = base.enginePower * vMod.acceleration * wMod.acceleration;
  target.maxEngineForce = base.maxEngineForce * vMod.acceleration * wMod.acceleration;
  target.frictionFront = base.frictionFront * vMod.grip * wMod.grip;
  target.frictionRear = base.frictionRear * vMod.grip * wMod.grip;
  target.lateralGripDamping = base.lateralGripDamping * vMod.grip * wMod.grip;
  target.brakeImpulse = base.brakeImpulse * vMod.braking * Math.sqrt(wMod.grip);
  target.dragCoef = base.dragCoef * wMod.dragMultiplier;
  target.windForce = wMod.windForce;
  return target;
}

/**
 * 5. Profils de comportement variés pour les bots IA :
 *  - Prudent   : Vitesse max 75%, freinage très anticipé, réactivité douce, suit le centre (+/- 1m)
 *  - Équilibré : Vitesse max 90%, trajectoires propres, dépassement modéré (+/- 2.5m)
 *  - Agressif  : Vitesse max 104%, freinage très tardif, corde serrée, collecte prioritaire des boosts (+/- 4m)
 */
export const AI_BEHAVIOR_PROFILES = {
  prudent: {
    key: 'prudent',
    label: 'Prudent',
    maxSpeedFactor: 0.75,
    brakeLookaheadMult: 1.55,
    cornerSpeedFactor: 0.84,
    apexCut: 0.15,
    corridorHalfWidth: 0.7, // Trajectoire tendue et stable
    overtakeAggression: 0.75,
    boostThreshold: 20,
    decisionRate: 1.0,
  },
  balanced: {
    key: 'balanced',
    label: 'Équilibré',
    maxSpeedFactor: 0.91,
    brakeLookaheadMult: 1.15,
    cornerSpeedFactor: 0.96,
    apexCut: 0.45,
    corridorHalfWidth: 1.6, // Variations fluides sans zigzag
    overtakeAggression: 1.40,
    boostThreshold: 8,
    decisionRate: 1.6,
  },
  aggressive: {
    key: 'aggressive',
    label: 'Agressif',
    maxSpeedFactor: 1.05,
    brakeLookaheadMult: 0.78,
    cornerSpeedFactor: 1.08,
    apexCut: 0.92,
    corridorHalfWidth: 2.8, // Exploitation maximale des cordes et dégagements
    overtakeAggression: 2.20,
    boostThreshold: 2,
    decisionRate: 2.4,
  },
};

export const CONTROLS = {
  p1: {
    throttle: { codes: ['KeyW'], keys: ['z'] },
    brake:    { codes: ['KeyS'], keys: ['s'] },
    left:     { codes: ['KeyA'], keys: ['q'] },
    right:    { codes: ['KeyD'], keys: ['d'] },
    boost:    { codes: ['ShiftLeft', 'Space'], keys: [] },
    reset:    { codes: ['KeyR'], keys: ['r'] },
  },
  p2: {
    throttle: { codes: ['KeyO'], keys: ['o'] },
    brake:    { codes: ['KeyL'], keys: ['l'] },
    left:     { codes: ['KeyK'], keys: ['k'] },
    right:    { codes: ['Semicolon', 'KeyM'], keys: ['m'] },
    boost:    { codes: ['KeyN', 'Enter', 'NumpadEnter'], keys: ['n', 'enter'] },
    reset:    { codes: ['KeyP'], keys: ['p'] },
  },
  spectator: {
    prev:     { codes: ['KeyA', 'KeyQ', 'KeyK'], keys: ['q', 'k'] },
    next:     { codes: ['KeyD', 'Semicolon', 'KeyM'], keys: ['d', 'm'] },
  },
  global: {
    pause:    { codes: ['Escape'], keys: ['escape'] },
  },
};

export const AI_BOT_NAMES = [
  'Vortex', 'Falcon', 'Apex', 'Phantom', 'Spectre',
  'Titan', 'Pulse', 'Blaze', 'Nova', 'Shadow',
  'Zenith', 'Hydra', 'Tempest', 'Eclipse', 'Raptor',
];

export const BOT_PROFILES = [
  { name: 'Vortex',  bodyType: 'formula',  color: '#e53935', rims: 'multi', rimFinish: 'black',  spoiler: 'gt'  },
  { name: 'Falcon',  bodyType: 'muscle',   color: '#43a047', rims: 'star',  rimFinish: 'silver', spoiler: 'lip' },
  { name: 'Apex',    bodyType: 'supercar', color: '#1e88e5', rims: 'sport', rimFinish: 'silver', spoiler: 'gt'  },
  { name: 'Phantom', bodyType: 'supercar', color: '#263238', rims: 'disc',  rimFinish: 'black',  spoiler: 'gt'  },
  { name: 'Spectre', bodyType: 'formula',  color: '#8e24aa', rims: 'star',  rimFinish: 'gold',   spoiler: 'gt'  },
  { name: 'Titan',   bodyType: 'muscle',   color: '#f57c00', rims: 'sport', rimFinish: 'silver', spoiler: 'lip' },
  { name: 'Pulse',   bodyType: 'supercar', color: '#00e5ff', rims: 'multi', rimFinish: 'black',  spoiler: 'gt'  },
  { name: 'Blaze',   bodyType: 'supercar', color: '#fdd835', rims: 'sport', rimFinish: 'black',  spoiler: 'gt'  },
  { name: 'Nova',    bodyType: 'formula',  color: '#d500f9', rims: 'disc',  rimFinish: 'gold',   spoiler: 'gt'  },
  { name: 'Tempest', bodyType: 'muscle',   color: '#37474f', rims: 'multi', rimFinish: 'silver', spoiler: 'gt'  },
];

export const DEFAULT_PLAYER_CARS = [
  { name: 'Joueur 1', bodyType: 'supercar', color: '#1e88e5', rims: 'sport', rimFinish: 'silver', spoiler: 'gt'  },
  { name: 'Joueur 2', bodyType: 'muscle',   color: '#fb8c00', rims: 'star',  rimFinish: 'black',  spoiler: 'lip' },
  { name: 'Joueur 3', bodyType: 'formula',  color: '#00c853', rims: 'multi', rimFinish: 'gold',   spoiler: 'gt'  },
  { name: 'Joueur 4', bodyType: 'supercar', color: '#8e24aa', rims: 'disc',  rimFinish: 'silver', spoiler: 'gt'  },
];
