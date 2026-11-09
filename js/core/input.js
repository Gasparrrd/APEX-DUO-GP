/**
 * input.js — Gestionnaire d'entrées clavier (AZERTY + fallback universel).
 *
 * Combine `event.code` (emplacement physique) et `event.key` (caractère produit,
 * insensible à la casse) afin que les contrôles AZERTY (Z/Q/S/D et O/K/L/M)
 * fonctionnent quel que soit le système ou la disposition active.
 * Zéro allocation mémoire par frame (`_ctrlOut` pré-alloué).
 */
import { CONTROLS } from '../config.js?v=25';

export class InputManager {
  constructor() {
    this.codes = new Set();
    this.keys = new Set();
    this._justPressedCodes = new Set();
    this._justPressedKeys = new Set();

    // Objets de commandes pré-alloués pour éviter toute allocation GC à 60 Hz
    this._ctrlOut = {
      p1: { throttle: 0, brake: 0, steer: 0, boost: false, reset: false },
      p2: { throttle: 0, brake: 0, steer: 0, boost: false, reset: false },
    };

    this._onKeyDown = (e) => {
      // Ne bloque pas la saisie lorsque l'utilisateur édite un champ de formulaire
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const code = e.code;
      const key = (e.key || '').toLowerCase();

      if (!this.codes.has(code)) this._justPressedCodes.add(code);
      if (key && !this.keys.has(key)) this._justPressedKeys.add(key);

      this.codes.add(code);
      if (key) this.keys.add(key);

      // Empêche le défilement de la page avec Espace / Entrée / Flèches
      if (code === 'Space' || code === 'Enter' || code.startsWith('Arrow')) {
        e.preventDefault();
      }
    };

    this._onKeyUp = (e) => {
      const code = e.code;
      const key = (e.key || '').toLowerCase();
      this.codes.delete(code);
      if (key) this.keys.delete(key);
    };

    this._onBlur = () => {
      this.clearAll();
    };

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Teste si une liaison { codes, keys } est maintenue. */
  isDown(binding) {
    if (!binding) return false;
    for (const c of binding.codes) if (this.codes.has(c)) return true;
    for (const k of binding.keys) if (this.keys.has(k)) return true;
    return false;
  }

  /** Teste si une liaison vient d'être pressée durant cette frame. */
  wasPressed(binding) {
    if (!binding) return false;
    for (const c of binding.codes) if (this._justPressedCodes.has(c)) return true;
    for (const k of binding.keys) if (this._justPressedKeys.has(k)) return true;
    return false;
  }

  /** Retourne l'état des commandes pour un joueur ('p1' ou 'p2') sans allouer d'objet. */
  getPlayerControls(playerKey) {
    const map = CONTROLS[playerKey];
    const left = this.isDown(map.left) ? 1 : 0;
    const right = this.isDown(map.right) ? 1 : 0;
    const out = this._ctrlOut[playerKey] || (this._ctrlOut[playerKey] = {
      throttle: 0, brake: 0, steer: 0, boost: false, reset: false,
    });
    out.throttle = this.isDown(map.throttle) ? 1 : 0;
    out.brake = this.isDown(map.brake) ? 1 : 0;
    out.steer = left - right; // +1 = gauche, -1 = droite
    out.boost = this.isDown(map.boost);
    out.reset = this.wasPressed(map.reset);
    return out;
  }

  /** Réinitialise toutes les touches enfoncées lors des transitions Salon / Course / Pause. */
  clearAll() {
    this.codes.clear();
    this.keys.clear();
    this._justPressedCodes.clear();
    this._justPressedKeys.clear();
  }

  /** Doit être appelé en fin de frame pour réinitialiser les fronts montants. */
  endFrame() {
    this._justPressedCodes.clear();
    this._justPressedKeys.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}
