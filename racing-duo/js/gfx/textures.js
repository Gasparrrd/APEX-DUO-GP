/**
 * textures.js — Textures procédurales générées sur <canvas> (aucun asset externe).
 * Chaque texture est mise en cache : elle n'est générée qu'une seule fois.
 */
import * as THREE from 'three';
import { seededRandom } from '../core/utils.js?v=25';

const cache = new Map();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(canvas, { repeat = true, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.userData.shared = true;
  return t;
}

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

/** Asphalte : grain + taches + lignes de bord blanches (u = travers, v = long). */
export function asphaltTexture() {
  return cached('asphalt', () => {
    const [c, g] = makeCanvas(512, 512);
    const rnd = seededRandom(7);
    g.fillStyle = '#3b3c40'; g.fillRect(0, 0, 512, 512);
    // Grain fin
    const img = g.getImageData(0, 0, 512, 512), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 34;
      d[i] += n; d[i + 1] += n; d[i + 2] += n + 1;
    }
    g.putImageData(img, 0, 0);
    // Réparations / taches plus sombres
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(20,20,22,${0.08 + rnd() * 0.12})`;
      g.beginPath();
      g.ellipse(rnd() * 512, rnd() * 512, 10 + rnd() * 40, 6 + rnd() * 30, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // Trajectoire gommée (bande plus sombre au centre)
    const grd = g.createLinearGradient(0, 0, 512, 0);
    grd.addColorStop(0.25, 'rgba(0,0,0,0)');
    grd.addColorStop(0.5, 'rgba(10,10,12,0.18)');
    grd.addColorStop(0.75, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    // Lignes de bord blanches
    g.fillStyle = '#e8e8e8';
    g.fillRect(8, 0, 9, 512);
    g.fillRect(512 - 17, 0, 9, 512);
    return toTexture(c);
  });
}

/** Herbe tondue avec bandes alternées. */
export function grassTexture() {
  return cached('grass', () => {
    const [c, g] = makeCanvas(256, 256);
    const rnd = seededRandom(3);
    g.fillStyle = '#4f7d33'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.045)'; g.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 4000; i++) {
      const v = rnd();
      g.fillStyle = v > 0.5 ? `rgba(110,160,60,${rnd() * 0.5})` : `rgba(40,70,25,${rnd() * 0.5})`;
      g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 2 + rnd() * 3);
    }
    return toTexture(c);
  });
}

/** Vibreur rouge / blanc (deux blocs sur la hauteur, répété le long de la piste). */
export function curbTexture() {
  return cached('curb', () => {
    const [c, g] = makeCanvas(64, 128);
    g.fillStyle = '#d32f2f'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#f5f5f5'; g.fillRect(0, 64, 64, 64);
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, 0, 6, 128); g.fillRect(58, 0, 6, 128);
    return toTexture(c);
  });
}

/** Damier de la ligne de départ. */
export function checkerTexture() {
  return cached('checker', () => {
    const [c, g] = makeCanvas(256, 32);
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f2f2f2';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
    const t = toTexture(c, { repeat: false });
    t.magFilter = THREE.NearestFilter;
    return t;
  });
}

/** Ombre portée floue (blob) utilisée sous les voitures et les arbres. */
export function blobShadowTexture() {
  return cached('blob', () => {
    const [c, g] = makeCanvas(128, 128);
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

/** Panneau publicitaire / sponsor. */
export function billboardTexture(text, bg = '#0d47a1', fg = '#ffffff', accent = '#ffca28') {
  return cached(`bb_${text}_${bg}`, () => {
    const [c, g] = makeCanvas(512, 128);
    g.fillStyle = bg; g.fillRect(0, 0, 512, 128);
    g.fillStyle = accent; g.fillRect(0, 108, 512, 20);
    g.font = 'italic 900 78px Arial Black, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillText(text, 260, 58);
    g.fillStyle = fg; g.fillText(text, 256, 54);
    return toTexture(c, { repeat: false });
  });
}

/** Panneau de virage à chevrons (jaune / noir). dir = 1 droite, -1 gauche. */
export function chevronTexture(dir = 1) {
  return cached(`chev_${dir}`, () => {
    const [c, g] = makeCanvas(256, 128);
    g.fillStyle = '#ffd600'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#111';
    for (let i = 0; i < 3; i++) {
      const x = 40 + i * 70;
      g.beginPath();
      if (dir > 0) { g.moveTo(x, 14); g.lineTo(x + 40, 64); g.lineTo(x, 114); g.lineTo(x + 22, 114); g.lineTo(x + 62, 64); g.lineTo(x + 22, 14); }
      else { g.moveTo(x + 62, 14); g.lineTo(x + 22, 64); g.lineTo(x + 62, 114); g.lineTo(x + 40, 114); g.lineTo(x, 64); g.lineTo(x + 40, 14); }
      g.closePath(); g.fill();
    }
    g.strokeStyle = '#111'; g.lineWidth = 8; g.strokeRect(4, 4, 248, 120);
    return toTexture(c, { repeat: false });
  });
}

/** Panneau de distance de freinage (150 / 100 / 50). */
export function distanceBoardTexture(n) {
  return cached(`dist_${n}`, () => {
    const [c, g] = makeCanvas(128, 128);
    g.fillStyle = '#fafafa'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#c62828'; g.lineWidth = 10; g.strokeRect(5, 5, 118, 118);
    g.fillStyle = '#111'; g.font = 'bold 54px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), 64, 68);
    return toTexture(c, { repeat: false });
  });
}

/** Bandeau "START / FINISH" du portique. */
export function gantryTexture() {
  return cached('gantry', () => {
    const [c, g] = makeCanvas(1024, 128);
    g.fillStyle = '#101418'; g.fillRect(0, 0, 1024, 128);
    for (let x = 0; x < 1024; x += 32) {
      g.fillStyle = (x / 32) % 2 ? '#fff' : '#111';
      g.fillRect(x, 0, 32, 14);
      g.fillStyle = (x / 32) % 2 ? '#111' : '#fff';
      g.fillRect(x, 114, 32, 14);
    }
    g.font = 'italic 900 72px Arial Black, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.fillText('START  ·  FINISH', 512, 66);
    return toTexture(c, { repeat: false });
  });
}

/** Sol du garage : carrelage sombre avec liseré. */
export function garageFloorTexture() {
  return cached('garageFloor', () => {
    const [c, g] = makeCanvas(256, 256);
    g.fillStyle = '#1b1e24'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#2a2f38'; g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = '#23272f'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
    return toTexture(c);
  });
}
