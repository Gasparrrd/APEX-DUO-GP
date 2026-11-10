/**
 * config.js — Paramètres globaux du jeu, modificateurs de statistiques des véhicules,
 * conditions météo dynamiques, profils comportementaux IA et contrôles.
 */

/** Capacité maximale totale de voitures par course (joueurs humains + bots). */
export const MAX_TOTAL_CARS = 10;

export const CONFIG = {
  physics: {
    step: 1 / 60,                    // Durée d'un pas de physique en secondes (60 Hz)
    maxSubSteps: 3,                  // Nombre max de sous-pas physiques par image
    gravity: 9.82,                   // Gravité en m/s²
    solverIterations: 10,            // Itérations du solveur physique (stabilité des contacts)
  },

  render: {
    maxPixelRatio: 2,                // Plafond du ratio de pixels de l'écran (performances)
    cameraNear: 0.1,                 // Distance d'affichage minimale de la caméra
    cameraFar: 3000,                 // Distance d'affichage maximale de la caméra
    fogNear: 380,                    // Distance où le brouillard commence
    fogFar: 2650,                    // Distance où le brouillard est total
    separatorPx: 4,                  // Épaisseur de la ligne de séparation écran scindé (px)
  },

  track: {
    halfWidth: 7,                    // Demi-largeur de la piste en mètres
    sampleSpacing: 2,                // Espacement des points de la trajectoire en mètres
    curbWidth: 1.3,                  // Largeur des vibreurs en mètres
    barrierOffset: 5.5,              // Distance bord de piste / glissières en mètres
    barrierHeight: 2.4,              // Hauteur des glissières en mètres
    barrierThickness: 1.6,           // Épaisseur des glissières en mètres
    numCheckpoints: 10,              // Nombre de checkpoints par tour
  },

  race: {
    playerCount: 2,                  // Mode par défaut (1 solo, 2 écran scindé)
    circuit: 'flat',                 // Circuit par défaut
    weather: 'sunny',                // Météo par défaut
    globalGrip: 1.0,                 // Adhérence générale (1.0 = 100%)
    engineSound: 'thermal',          // Son moteur par défaut
    laps: 3,                         // Nombre de tours
    bots: 3,                         // Nombre de bots IA
    maxTotalCars: MAX_TOTAL_CARS,    // Nombre max de voitures sur la piste
    difficulty: 'normal',            // Difficulté des bots par défaut
    finishTimeout: 45,               // Délai (s) laissé aux retardataires après le vainqueur
  },

  car: {
    mass: 1150,                      // Masse de la voiture en kg
    chassisHalfExtents: [0.9, 0.38, 2.1], // Demi-dimensions du châssis [largeur, hauteur, longueur] en m
    chassisOffsetY: 0.10,            // Rehausse de la boîte de collision en m
    wheelRadius: 0.36,               // Rayon des roues en m
    wheelWidth: 0.28,                // Largeur des roues en m
    wheelHalfTrack: 0.8,             // Demi-écartement des roues en m
    wheelFrontZ: -1.32,              // Position des roues avant (avant = -Z)
    wheelRearZ: 1.28,                // Position des roues arrière
    connectionY: 0.0,                // Hauteur d'attache des suspensions
    suspensionRestLength: 0.35,      // Longueur de repos des suspensions en m
    suspensionStiffness: 36,         // Raideur des suspensions
    dampingRelaxation: 3.8,          // Amortissement à la détente
    dampingCompression: 3.4,         // Amortissement à la compression
    maxSuspensionTravel: 0.32,       // Débattement max des suspensions en m
    maxSuspensionForce: 24000,       // Force max des suspensions en N
    rollInfluence: 0.08,             // Roulis de la carrosserie en virage
    frictionFront: 3.25,             // Adhérence des pneus avant
    frictionRear: 3.45,              // Adhérence des pneus arrière
    lateralGripDamping: 8.0,         // Résistance au glissement latéral (plus haut = moins de glisse)
    slideRate: 0.55,                 // Taux de glissade global de base (modulé en temps réel par la météo, la vitesse et le braquage)
    manualDriftIntensity: 0.22,      // Force du dérapage manuel frein + braquage (0 = aucun, plus haut = plus violent)
    manualDriftMinSpeed: 11,         // Vitesse min (m/s) pour déclencher le dérapage manuel au frein (~40 km/h)
    grassFrictionFactor: 0.65,       // Adhérence restante sur l'herbe (0.65 = 65%)
    enginePower: 250000,             // Puissance moteur en W
    maxEngineForce: 7400,            // Force motrice max à basse vitesse en N
    frontTorqueShare: 0.38,          // Part de motricité sur l'avant (0.38 = 38%)
    reverseForce: 2800,              // Force en marche arrière en N
    maxReverseSpeed: 20,             // Vitesse max en marche arrière (m/s)
    brakeImpulse: 45,                // Puissance de freinage
    engineBrake: 2.5,                // Frein moteur quand on lâche l'accélérateur
    maxSteer: 0.50,                  // Braquage max à basse vitesse (rad)
    minSteer: 0.22,                  // Braquage à très haute vitesse (rad)
    steerSpeedRef: 75,               // Vitesse (m/s) où le braquage atteint son minimum
    steerRate: 4.0,                  // Vitesse de braquage des roues
    steerReturnRate: 5.8,            // Vitesse de retour des roues au centre
    yawAssist: 0.26,                 // Aide au pivotement de la voiture en virage
    dragCoef: 0.80,                  // Résistance de l'air
    rollingResistance: 24,           // Frottement des pneus
    downforce: 3.4,                  // Appui aérodynamique (plaque la voiture au sol)
    grassDrag: 10,                  // Ralentissement supplémentaire dans l'herbe
    topSpeed: 80,                    // Vitesse max de base en m/s
    angularDamping: 0.52,            // Amortissement des rotations (anti tête-à-queue)
  },

  boost: {
    maxEnergy: 100,                  // Capacité max du boost (%)
    startEnergy: 20,                 // Boost au départ (%)
    drain: 100 / 7.5,                // Consommation du boost (%/s)
    regen: 0,                        // Recharge passive du boost (0 = aucune)
    checkpointBonus: 0,              // Boost gagné par checkpoint
    speedMultiplier: 1.75,           // Multiplicateur de vitesse max pendant le boost
    forceMultiplier: 1.4,           // Multiplicateur de force motrice pendant le boost
    force: 5700,                     // Poussée directe du boost en N
    topSpeedBonus: 12.0,             // Bonus de vitesse de pointe pendant le boost (m/s)
    tokenCount: 7,                   // Nombre de jetons de boost
    normalBonus: 25,                 // Boost donné par un jeton normal (%)
    rareBonus: 40,                   // Boost donné par un jeton rare (%)
    slowdownTokenCount: 7,           // Nombre de jetons ralentisseurs
    slowdownFactor: 0.75,            // Multiplicateur de vitesse du malus
    slowdownDuration: 3.0,           // Durée du malus (s)
    activeMinTime: 3.0,              // Durée min d'activité d'un jeton (s)
    activeMaxTime: 10.0,             // Durée max d'activité d'un jeton (s)
    cooldownMinTime: 3.0,            // Attente min avant réapparition (s)
    cooldownMaxTime: 10.0,           // Attente max avant réapparition (s)
    respawnTime: 6.5,                // Délai moyen de réapparition d'un jeton (s)
  },

  ai: {
    lateralAccel: 14.5,              // Accélération latérale max tolérée par l'IA
    brakeDecel: 10.5,                // Décélération de freinage de l'IA
    maxSpeed: 80,                    // Vitesse max de référence de l'IA
    lineMargin: 2.5,                 // Marge de l'IA par rapport aux bords de piste (m)
    unstuckTime: 5.0,                // Délai (s) avant replacement d'un bot bloqué
    relaunchSpeed: 11.0,             // Vitesse (m/s) donnée à un bot replacé
  },

  difficulty: {
    easy: {
      label: 'Facile',               // Nom affiché
      skill: 0.85,                   // Niveau de compétence global
      maxSpeedFactor: 0.75,          // Part de la vitesse max utilisée
      speedSpread: 0.040,            // Écart aléatoire de vitesse entre bots
      brakeLookaheadMult: 1.5,      // Distance d'anticipation du freinage (plus bas = freine tard)
      cornerSpeedFactor: 0.82,       // Vitesse conservée en virage
      steerGain: 1.55,               // Précision du volant
      steerRateMult: 0.68,           // Rapidité du volant
      apexCut: 0.0,                  // Tendance à couper à la corde
      boostSeekWeight: 1.75,         // Priorité donnée à la chasse aux boosts
      boostMaxLatDeviation: 3.8,     // Déviation latérale max pour un boost (m)
      boostThreshold: 10,            // Boost min avant utilisation (%)
      boostMaxCurvature: 0.0028,     // Courbure max pour booster
      corridorHalfWidth: 1.5,        // Liberté de déviation autour de la trajectoire (m)
      overtakeAggression: 1.30,      // Agressivité des dépassements
    },
    normal: {
      label: 'Moyen',                // Nom affiché
      skill: 0.95,                   // Niveau de compétence global
      maxSpeedFactor: 0.90,          // Part de la vitesse max utilisée
      speedSpread: 0.045,            // Écart aléatoire de vitesse entre bots
      brakeLookaheadMult: 1.08,      // Distance d'anticipation du freinage (plus bas = freine tard)
      cornerSpeedFactor: 0.94,       // Vitesse conservée en virage
      steerGain: 2.40,               // Précision du volant
      steerRateMult: 1.00,           // Rapidité du volant
      apexCut: 0.28,                 // Tendance à couper à la corde
      boostSeekWeight: 2.80,         // Priorité donnée à la chasse aux boosts
      boostMaxLatDeviation: 7.5,     // Déviation latérale max pour un boost (m)
      boostThreshold: 0,             // Boost min avant utilisation (%)
      boostMaxCurvature: 0.0048,     // Courbure max pour booster
      corridorHalfWidth: 3.2,        // Liberté de déviation autour de la trajectoire (m)
      overtakeAggression: 1.95,      // Agressivité des dépassements
    },
    hard: {
      label: 'Difficile',            // Nom affiché
      skill: 1.04,                   // Niveau de compétence global
      maxSpeedFactor: 1.04,          // Part de la vitesse max utilisée
      speedSpread: 0.048,            // Écart aléatoire de vitesse entre bots
      brakeLookaheadMult: 0.60,      // Distance d'anticipation du freinage (plus bas = freine tard)
      cornerSpeedFactor: 1.05,       // Vitesse conservée en virage
      steerGain: 3.15,               // Précision du volant
      steerRateMult: 1.35,           // Rapidité du volant
      apexCut: 0.88,                 // Tendance à couper à la corde
      boostSeekWeight: 3.80,         // Priorité donnée à la chasse aux boosts
      boostMaxLatDeviation: 10,     // Déviation latérale max pour un boost (m)
      boostThreshold: 0,             // Boost min avant utilisation (%)
      boostMaxCurvature: 0.0095,     // Courbure max pour booster
      corridorHalfWidth: 4.2,        // Liberté de déviation autour de la trajectoire (m)
      overtakeAggression: 2.75,      // Agressivité des dépassements
    },
  },
};

/**
 * 2. Modificateurs propres à chaque silhouette de véhicule (échelle harmonisée autour de 1.00 = 0%) :
 *  - Chaque paramètre (topSpeed, acceleration, grip, braking) utilise le même poids linéaire (1.00 = base, 1.15 = +15%, 0.85 = -15%).
 *  - Toute modification ici ou dans CONFIG.car est automatiquement répercutée dans les jauges en % du salon et dans la physique en jeu.
 */
export const VEHICLE_MODIFIERS = {
  supercar: {
    label: 'Supercar',               // Nom affiché
    topSpeed: 1.15,                  // Multiplicateur de vitesse de pointe (+15%)
    acceleration: 1.00,              // Multiplicateur d'accélération (0%)
    grip: 1.10,                      // Multiplicateur d'adhérence / tenue de route (+10%)
    braking: 1.05,                   // Multiplicateur de freinage (+5%)
    get description() {
      return formatVehicleDescription(this);
    },
  },
  muscle: {
    label: 'Muscle Car',             // Nom affiché
    topSpeed: 1.05,                  // Multiplicateur de vitesse de pointe (+5%)
    acceleration: 1.30,              // Multiplicateur d'accélération (+30%)
    grip: 0.95,                      // Multiplicateur d'adhérence / tenue de route (-5%)
    braking: 0.95,                   // Multiplicateur de freinage (-5%)
    get description() {
      return formatVehicleDescription(this);
    },
  },
  formula: {
    label: 'Monoplace',              // Nom affiché
    topSpeed: 0.85,                  // Multiplicateur de vitesse de pointe (-15%)
    acceleration: 1.10,              // Multiplicateur d'accélération (+10%)
    grip: 1.25,                      // Multiplicateur d'adhérence / tenue de route (+25%)
    braking: 1.22,                   // Multiplicateur de freinage (+22%)
    get description() {
      return formatVehicleDescription(this);
    },
  },
};

/**
 * Valeurs de référence (échelle 1.00 = 100%) de CONFIG.car permettant de refléter
 * toute modification de CONFIG.car ou de VEHICLE_MODIFIERS avec un poids équivalent.
 */
export const CAR_REFERENCE_BASELINE = {
  topSpeed: 80,
  enginePower: 250000,
  maxEngineForce: 7400,
  frictionFront: 3.25,
  frictionRear: 3.45,
  lateralGripDamping: 8.0,
  brakeImpulse: 45,
};

function formatStatPct(mult) {
  const diff = Math.round((mult - 1) * 100);
  return diff >= 0 ? `+${diff}%` : `${diff}%`;
}

function formatVehicleDescription(mod) {
  if (!mod) return '';
  return `Vitesse ${formatStatPct(mod.topSpeed)} · Accél. ${formatStatPct(mod.acceleration)} · Grip ${formatStatPct(mod.grip)}`;
}

/**
 * 3. Conditions météorologiques dynamiques (échelle harmonisée autour de 1.00) :
 *  - Ensoleillé (sunny) : Grip 1.00x, slideRate 0.55, vent nul, ciel dégagé
 *  - Pluvieux (rain)    : Grip 1.00x, slideRate 1.05, brouillard gris, pluie animée
 *  - Tempête (storm)    : Grip 0.90x, slideRate 0.80, vecteur de vent latéral/frontal fort
 */
export const WEATHER_MODIFIERS = {
  sunny: {
    label: 'Ensoleillé (Sec)',       // Nom affiché
    topSpeed: 1.00,                  // Multiplicateur de vitesse max (1.00 = 100%)
    acceleration: 1.00,              // Multiplicateur d'accélération (1.00 = 100%)
    grip: 1.00,                      // Multiplicateur d'adhérence / facilité à tourner
    slideRate: 0.55,                 // TAUX DE GLISSADE sur sol sec (glisse continue proportionnelle à la vitesse et au braquage)
    windForce: [0, 0, 0],            // Force du vent [X, Y, Z] en N
    dragMultiplier: 1.00,            // Multiplicateur de résistance de l'air
    skyColor: 0x6ea8df,              // Couleur du ciel
    fogColor: 0x8ec2ef,              // Couleur du brouillard
    fogNear: 380,                    // Distance où le brouillard commence
    fogFar: 2650,                    // Distance où le brouillard est total
    sunIntensity: 1.95,              // Intensité du soleil
    hemiIntensity: 1.05,             // Lumière d'ambiance
    roadRoughness: 0.84,             // Aspect visuel de la route (0 = brillant) — sans effet sur la physique
  },
  rain: {
    label: 'Pluvieux',               // Nom affiché
    topSpeed: 0.97,                  // Multiplicateur de vitesse max (-3%)
    acceleration: 0.95,              // Multiplicateur d'accélération (-5%)
    grip: 1.00,                      // Multiplicateur d'adhérence / facilité à tourner
    slideRate: 1.05,                 // TAUX DE GLISSADE sous la pluie (+90% de glisse par rapport au sec)
    windForce: [220, 0, -160],       // Force du vent [X, Y, Z] en N
    dragMultiplier: 1.04,            // Multiplicateur de résistance de l'air
    skyColor: 0x22262a,              // Couleur du ciel
    fogColor: 0x22262a,              // Couleur du brouillard
    fogExp2Density: 0.015,           // Densité du brouillard
    fogNear: 40,                     // Distance où le brouillard commence
    fogFar: 280,                     // Distance où le brouillard est total
    sunIntensity: 0.62,              // Intensité du soleil
    hemiIntensity: 0.68,             // Lumière d'ambiance
    roadRoughness: 0.18,             // Aspect visuel de la route (0 = brillant) — sans effet sur la physique
    roadMetalness: 0.28,             // Reflets visuels de la route — sans effet sur la physique
  },
  storm: {
    label: 'Tempête / Venteux',      // Nom affiché
    topSpeed: 0.94,                  // Multiplicateur de vitesse max (-6%)
    acceleration: 0.96,              // Multiplicateur d'accélération (-4%)
    grip: 0.90,                      // Multiplicateur d'adhérence / facilité à tourner (-10%)
    slideRate: 0.80,                 // TAUX DE GLISSADE sous tempête (+45% de glisse par rapport au sec)
    windForce: [1200, 0, -900],      // Force du vent [X, Y, Z] en N
    dragMultiplier: 1.09,            // Multiplicateur de résistance de l'air
    skyColor: 0x1c2024,              // Couleur du ciel
    fogColor: 0x22262a,              // Couleur du brouillard
    fogExp2Density: 0.0165,          // Densité du brouillard
    fogNear: 35,                     // Distance où le brouillard commence
    fogFar: 240,                     // Distance où le brouillard est total
    sunIntensity: 0.48,              // Intensité du soleil
    hemiIntensity: 0.55,             // Lumière d'ambiance
    roadRoughness: 0.22,             // Aspect visuel de la route (0 = brillant) — sans effet sur la physique
    roadMetalness: 0.25,             // Reflets visuels de la route — sans effet sur la physique
  },
};

/**
 * Formule modulaire et harmonisée de calcul des statistiques d'un véhicule en temps réel :
 *   Stat_Finale = Paramètre_Global * Modificateur_Véhicule * Modificateur_Météo (* Adhérence_Générale)
 * Tous les multiplicateurs (topSpeed, acceleration, grip, braking) agissent avec une échelle et un poids 1:1 équivalents.
 * Écrit dans `out` s'il est fourni afin d'éviter toute allocation GC dans la boucle physique 60 Hz.
 */
export function computeVehicleStats(bodyType = 'supercar', weatherKey = 'sunny', globalGrip = 1.0, out = null) {
  const base = CONFIG.car;
  const ref = CAR_REFERENCE_BASELINE;
  const vMod = VEHICLE_MODIFIERS[bodyType] || VEHICLE_MODIFIERS.supercar;
  const wMod = WEATHER_MODIFIERS[weatherKey] || WEATHER_MODIFIERS.sunny;
  const gGrip = (globalGrip !== undefined && globalGrip !== null) ? Number(globalGrip) : (CONFIG.race.globalGrip ?? 1.0);
  const target = (out && typeof out === 'object') ? out : {};

  // Échelles normalisées (poids 1:1 entre config globale, véhicule et météo)
  const baseSpeedScale = base.topSpeed / ref.topSpeed;
  const baseAccelScale = 0.5 * (base.enginePower / ref.enginePower) + 0.5 * (base.maxEngineForce / ref.maxEngineForce);
  const baseGripScale = (
    (base.frictionFront / ref.frictionFront) +
    (base.frictionRear / ref.frictionRear) +
    (base.lateralGripDamping / ref.lateralGripDamping)
  ) / 3.0;
  const baseBrakeScale = base.brakeImpulse / ref.brakeImpulse;

  const speedMultiplier = baseSpeedScale * vMod.topSpeed * wMod.topSpeed;
  const accelMultiplier = baseAccelScale * vMod.acceleration * wMod.acceleration;
  const gripMultiplier = baseGripScale * vMod.grip * wMod.grip * gGrip;
  const brakeMultiplier = baseBrakeScale * (vMod.braking ?? vMod.grip) * Math.sqrt(wMod.grip);

  target.speedMultiplier = speedMultiplier;
  target.accelMultiplier = accelMultiplier;
  target.gripMultiplier = gripMultiplier;
  target.vehicleGrip = baseGripScale * vMod.grip;

  target.topSpeed = ref.topSpeed * speedMultiplier;
  target.enginePower = ref.enginePower * accelMultiplier;
  target.maxEngineForce = ref.maxEngineForce * accelMultiplier;
  target.frictionFront = ref.frictionFront * gripMultiplier;
  target.frictionRear = ref.frictionRear * gripMultiplier;
  target.lateralGripDamping = ref.lateralGripDamping * gripMultiplier;
  target.brakeImpulse = ref.brakeImpulse * brakeMultiplier;
  target.dragCoef = base.dragCoef * wMod.dragMultiplier;
  target.windForce = wMod.windForce;
  target.slideRate = (wMod.slideRate !== undefined) ? wMod.slideRate : (base.slideRate || 0.55);
  return target;
}

/**
 * Calcule dynamiquement les statistiques affichées dans l'interface du salon (en %)
 * directement à partir de `computeVehicleStats` pour garantir une correspondance 100% exacte
 * entre `config.js`, l'interface du salon et la physique en jeu.
 */
export function getVehicleDisplayStats(bodyType = 'supercar') {
  const stats = computeVehicleStats(bodyType, 'sunny', CONFIG.race.globalGrip ?? 1.0);
  const toBarWidth = (mult) => {
    const pct = Math.round(60 + (mult - 1.0) * 120);
    return `${Math.max(8, Math.min(100, pct))}%`;
  };

  return {
    speedMult: stats.speedMultiplier,
    accelMult: stats.accelMultiplier,
    gripMult: stats.gripMultiplier,
    speedText: formatStatPct(stats.speedMultiplier),
    accelText: formatStatPct(stats.accelMultiplier),
    gripText: formatStatPct(stats.gripMultiplier),
    speedBarWidth: toBarWidth(stats.speedMultiplier),
    accelBarWidth: toBarWidth(stats.accelMultiplier),
    gripBarWidth: toBarWidth(stats.gripMultiplier),
  };
}

/**
 * 5. Profils de comportement variés pour les bots IA :
 *  - Prudent   : Vitesse max 75%, freinage très anticipé, réactivité douce, suit le centre (+/- 1m)
 *  - Équilibré : Vitesse max 90%, trajectoires propres, dépassement modéré (+/- 2.5m)
 *  - Agressif  : Vitesse max 104%, freinage très tardif, corde serrée, collecte prioritaire des boosts (+/- 4m)
 */
export const AI_BEHAVIOR_PROFILES = {
  prudent: {
    key: 'prudent',                  // Identifiant du profil
    label: 'Prudent',                // Nom affiché
    maxSpeedFactor: 0.75,            // Part de la vitesse max utilisée
    brakeLookaheadMult: 1.55,        // Distance d'anticipation du freinage (plus bas = freine tard)
    cornerSpeedFactor: 0.84,         // Vitesse conservée en virage
    apexCut: 0.15,                   // Tendance à couper à la corde
    corridorHalfWidth: 1.5,          // Liberté de déviation autour de la trajectoire (m)
    overtakeAggression: 1.35,        // Agressivité des dépassements
    boostThreshold: 20,              // Boost min avant utilisation (%)
    decisionRate: 1.1,               // Fréquence de décision de l'IA (par seconde)
  },
  balanced: {
    key: 'balanced',                 // Identifiant du profil
    label: 'Équilibré',              // Nom affiché
    maxSpeedFactor: 0.91,            // Part de la vitesse max utilisée
    brakeLookaheadMult: 1.15,        // Distance d'anticipation du freinage (plus bas = freine tard)
    cornerSpeedFactor: 0.96,         // Vitesse conservée en virage
    apexCut: 0.45,                   // Tendance à couper à la corde
    corridorHalfWidth: 2.7,          // Liberté de déviation autour de la trajectoire (m)
    overtakeAggression: 2.45,        // Agressivité des dépassements
    boostThreshold: 8,               // Boost min avant utilisation (%)
    decisionRate: 1.7,               // Fréquence de décision de l'IA (par seconde)
  },
  aggressive: {
    key: 'aggressive',               // Identifiant du profil
    label: 'Agressif',               // Nom affiché
    maxSpeedFactor: 1.05,            // Part de la vitesse max utilisée
    brakeLookaheadMult: 0.78,        // Distance d'anticipation du freinage (plus bas = freine tard)
    cornerSpeedFactor: 1.08,         // Vitesse conservée en virage
    apexCut: 0.92,                   // Tendance à couper à la corde
    corridorHalfWidth: 3.8,          // Liberté de déviation autour de la trajectoire (m)
    overtakeAggression: 3.60,        // Agressivité des dépassements
    boostThreshold: 2,               // Boost min avant utilisation (%)
    decisionRate: 2.5,               // Fréquence de décision de l'IA (par seconde)
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
