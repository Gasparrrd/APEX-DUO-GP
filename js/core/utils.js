/**
 * utils.js — Fonctions utilitaires partagées (maths, formatage, libération mémoire).
 */

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Lissage exponentiel indépendant du framerate. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const dampFactor = (lambda, dt) => 1 - Math.exp(-lambda * dt);

/** Rapproche `current` de `target` d'au plus `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

/** Ramène x dans [0, m). */
export const wrap = (x, m) => ((x % m) + m) % m;

/** Différence signée la plus courte sur un anneau de longueur m (résultat dans [-m/2, m/2)). */
export function wrapDelta(a, b, m) {
  let d = wrap(a - b, m);
  if (d >= m / 2) d -= m;
  return d;
}

/** Formate un temps en secondes -> "m:ss.mmm". */
export function formatTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Ordinal français : 1er, 2e, 3e... */
export const ordinalFr = (n) => (n === 1 ? '1er' : `${n}e`);

/** Générateur pseudo-aléatoire déterministe (mulberry32) pour un décor reproductible. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Libère géométries et matériaux d'une hiérarchie Three.js. */
export function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry && !obj.geometry.userData.shared) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      if (!m.userData.shared) m.dispose();
    }
  });
}
