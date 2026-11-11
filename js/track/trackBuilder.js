/**
 * trackBuilder.js — Construction 3D et physique des circuits (Circuit 1 Plat & Circuit 2 Col de Montagne) :
 *  - Sol herbeux / vallée + ruban d'asphalte texturé 3D (avec dénivelés physiques)
 *  - Colliders physiques 3D inclinés selon la pente pour les montées/descentes du Circuit 2
 *  - Bordures de falaises rocheuses, talus 3D et sommets montagneux (Circuit 2)
 *  - Instanciation (THREE.InstancedMesh à 60 FPS) de rochers, pins, chênes, poteaux et spectateurs
 *  - Vibreurs bicolores (curbs), glissières métalliques 3D, feux de départ et signalisation
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js?v=40';
import { seededRandom, wrap } from '../core/utils.js?v=40';
import {
  asphaltTexture, grassTexture, curbTexture, checkerTexture,
  blobShadowTexture, billboardTexture, chevronTexture,
  distanceBoardTexture, gantryTexture,
} from '../gfx/textures.js?v=40';

export class TrackBuilder {
  /**
   * @param {import('./trackLayout.js').TrackLayout} layout
   * @param {THREE.Scene} scene
   * @param {CANNON.World} world
   * @param {object} materials { groundMat, barrierMat }
   */
  constructor(layout, scene, world, materials) {
    this.layout = layout;
    this.scene = scene;
    this.world = world;
    this.materials = materials;

    this.root = new THREE.Group();
    this.root.name = 'track';
    this.scene.add(this.root);

    this.physicsBodies = [];
    this.roadMaterials = [];
    this.startLightMeshes = [];
    this.spectatorUniforms = { uTime: { value: 0 } };

    this._buildGround();
    this._buildAsphalt();
    if (this.layout.hasRelief) {
      this._buildContinuousRoadTrimesh();
      this._buildMountainReliefAndRocks();
    }
    if (this.layout.circuitId === 'valley') {
      this._buildValleyScenery();
    }
    if (this.layout.circuitId === 'lake') {
      this._buildLakeAndVegetationScenery();
    }
    if (this.layout.circuitId === 'grotto') {
      this._buildGrottoScenery();
    }
    this._buildCircuitFlags();
    this._buildCurbs();
    this._buildBarriers();
    this._buildStartFinish();
    this._buildSignsAndBillboards();
    this._buildGrandstandsAndCornerCrowds();
    this._buildTrees();
    this._finalizeStaticSceneryOptimization();
  }

  /**
   * Optimisation GPU & CPU (60 FPS constants) :
   *  - Désactive les ombres dynamiques portées/reçues sur tous les décors secondaires
   *    (arbres, buissons, rochers, spectateurs, drapeaux, panneaux, falaises).
   *  - Conserve `receiveShadow = true` uniquement sur le ruban d'asphalte direct (`this.roadMesh`).
   *  - Figer les matrices (`matrixAutoUpdate = false`) de tous les objets statiques du circuit.
   */
  _finalizeStaticSceneryOptimization() {
    this.root.traverse((obj) => {
      if (obj === this.root) return;
      if (obj.isMesh || obj.isInstancedMesh) {
        obj.castShadow = false;
        obj.receiveShadow = (obj === this.roadMesh);
      }
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Sol et route 3D                                                    */
  /* ------------------------------------------------------------------ */

  _buildGround() {
    const tex = grassTexture();
    tex.repeat.set(200, 200);
    // Maillage de sol ultra-léger (1x1 segment = 2 triangles) avec matrixAutoUpdate désactivé
    const geo = new THREE.PlaneGeometry(4500, 4500, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      color: this.layout.hasRelief ? 0x8ea885 : 0xffffff,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.15;
    this.root.add(mesh);
    this.groundMesh = mesh;

    const groundBody = new CANNON.Body({
      mass: 0,
      material: this.materials.groundMat,
      collisionFilterGroup: 4,
      collisionFilterMask: -1,
    });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(groundBody);
    this.physicsBodies.push(groundBody);
  }

  _buildAsphalt() {
    const L = this.layout;
    const n = L.count;
    const hw = L.halfWidth;
    const bd = L.barrierDistance;

    // Calcul de la largeur d'accotement plat (6 à 10 m de large dans les points bas / creux) :
    // Dans les sections basses (p.y <= 16 m : vallées, abords du lac, virages en cuvette),
    // le terrain épouse exactement la même hauteur Y que la bordure de piste sur 6.5 à 10 m de large,
    // éliminant tout fossé ou cassure brusque entre le vibreur et l'herbe.
    this.shoulderOutDistLeft = new Float32Array(n);
    this.shoulderOutDistRight = new Float32Array(n);

    const shPos = new Float32Array((n + 1) * 4 * 3);
    const shNorm = new Float32Array((n + 1) * 4 * 3);
    const shIdx = [];

    const positions = new Float32Array((n + 1) * 2 * 3);
    const normals = new Float32Array((n + 1) * 2 * 3);
    const uvs = new Float32Array((n + 1) * 2 * 2);
    const indices = [];

    const innerSh = hw - 0.25;

    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const p = L.points[idx];
      const r = L.rights[idx];
      const v = (i * L.ds) / 14;

      // Facteur de point bas (1.0 dans les creux <= 5m, transition douce jusqu'à 16m)
      const lowFactor = L.hasRelief ? THREE.MathUtils.clamp((16.0 - p.y) / 11.0, 0, 1) : 1.0;
      const desiredFlatDist = hw + 2.2 + lowFactor * 7.8; // jusqu'à hw + 10.0 m dans les creux !

      const kCurv = L.curvature[idx];
      const maxLeft = (-kCurv > 0.002) ? Math.max(bd + 1.2, 0.64 / (-kCurv)) : desiredFlatDist;
      const maxRight = (kCurv > 0.002) ? Math.max(bd + 1.2, 0.64 / kCurv) : desiredFlatDist;

      let shLeft = Math.min(desiredFlatDist, maxLeft);
      let shRight = Math.min(desiredFlatDist, maxRight);

      // Sécurité anti-chevauchement avec un autre tronçon de piste ou pont/tunnel
      const isGrottoBridgeOrTunnel = L.circuitId === 'grotto' && (
        (Math.abs(p.x) < 16 && p.z >= -156 && p.z <= 36 && p.y < 16) ||
        (Math.abs(p.x) < 16 && p.z >= 70 && p.z <= 192)
      );
      const isGrottoRidge = L.circuitId === 'grotto' && Math.abs(p.x) < 78 && p.z > -98 && p.z < -8 && p.y > 46;
      if (isGrottoBridgeOrTunnel) {
        shLeft = hw + 1.1;
        shRight = hw + 1.1;
      } else if (isGrottoRidge) {
        shLeft = bd + 0.4;
        shRight = bd + 0.4;
      } else {
        const xL = p.x - r.x * shLeft, zL = p.z - r.z * shLeft;
        if (L.distanceToCenterline(xL, zL) < bd + 0.8) shLeft = bd + 0.8;
        const xR = p.x + r.x * shRight, zR = p.z + r.z * shRight;
        if (L.distanceToCenterline(xR, zR) < bd + 0.8) shRight = bd + 0.8;
      }

      this.shoulderOutDistLeft[idx] = shLeft;
      this.shoulderOutDistRight[idx] = shRight;

      // 4 sommets d'accotement plat par section : 0 = -shLeft, 1 = -innerSh, 2 = +innerSh, 3 = +shRight
      // Alignés au niveau de la piste (p.y - 0.03 à p.y - 0.05) sans fossé
      const sk = i * 4;
      const yShIn = p.y - 0.03;
      const yShOut = p.y - 0.05;

      shPos[sk * 3] = p.x - r.x * shLeft;
      shPos[sk * 3 + 1] = yShOut;
      shPos[sk * 3 + 2] = p.z - r.z * shLeft;

      shPos[(sk + 1) * 3] = p.x - r.x * innerSh;
      shPos[(sk + 1) * 3 + 1] = yShIn;
      shPos[(sk + 1) * 3 + 2] = p.z - r.z * innerSh;

      shPos[(sk + 2) * 3] = p.x + r.x * innerSh;
      shPos[(sk + 2) * 3 + 1] = yShIn;
      shPos[(sk + 2) * 3 + 2] = p.z + r.z * innerSh;

      shPos[(sk + 3) * 3] = p.x + r.x * shRight;
      shPos[(sk + 3) * 3 + 1] = yShOut;
      shPos[(sk + 3) * 3 + 2] = p.z + r.z * shRight;

      for (let j = 0; j < 4; j++) shNorm[(sk + j) * 3 + 1] = 1;

      if (i < n) {
        const l0 = sk, l1 = sk + 1, l2 = sk + 4, l3 = sk + 5;
        shIdx.push(l0, l1, l2, l1, l3, l2);
        const r0 = sk + 2, r1 = sk + 3, r2 = sk + 6, r3 = sk + 7;
        shIdx.push(r0, r1, r2, r1, r3, r2);
      }

      // Ruban d'asphalte principal à p.y + 0.02m
      const k = i * 2;
      const yRoad = p.y + 0.02;
      positions[k * 3] = p.x - r.x * hw;
      positions[k * 3 + 1] = yRoad;
      positions[k * 3 + 2] = p.z - r.z * hw;
      positions[(k + 1) * 3] = p.x + r.x * hw;
      positions[(k + 1) * 3 + 1] = yRoad;
      positions[(k + 1) * 3 + 2] = p.z + r.z * hw;

      normals[k * 3 + 1] = 1;
      normals[(k + 1) * 3 + 1] = 1;

      uvs[k * 2] = 0; uvs[k * 2 + 1] = v;
      uvs[(k + 1) * 2] = 1; uvs[(k + 1) * 2 + 1] = v;

      if (i < n) {
        const a = k, b = k + 1, c = k + 2, d = k + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    const shGeo = new THREE.BufferGeometry();
    shGeo.setAttribute('position', new THREE.BufferAttribute(shPos, 3));
    shGeo.setAttribute('normal', new THREE.BufferAttribute(shNorm, 3));
    shGeo.setIndex(shIdx);
    const shMat = new THREE.MeshLambertMaterial({
      color: L.hasRelief ? 0x526946 : 0x497330,
      side: THREE.DoubleSide,
    });
    this.shoulderMesh = new THREE.Mesh(shGeo, shMat);
    this.root.add(this.shoulderMesh);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const trackMaterial = new THREE.MeshStandardMaterial({
      map: asphaltTexture(),
      roughness: 0.84,
      metalness: 0.06,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -4.0,
    });
    this.roadMaterials.push(trackMaterial);
    this.roadMesh = new THREE.Mesh(geo, trackMaterial);
    this.roadMesh.receiveShadow = true;
    this.root.add(this.roadMesh);
  }

  /**
   * Construit le maillage physique de la route découpé en tronçons spatiaux (`CANNON.Body` par bloc de 32 segments)
   * avec sous-échantillonnage (`step = 2`) et 2 triangles par quad afin que `SAPBroadphase` élague 97% des triangles
   * hors de portée des véhicules (60 FPS constants).
   */
  _buildContinuousRoadTrimesh() {
    const L = this.layout;
    const n = L.count;
    const halfWidth = L.barrierDistance + 3.0;
    const step = 1;
    const chunkSegs = 32;

    for (let start = 0; start < n; start += step * chunkSegs) {
      const end = Math.min(n, start + step * chunkSegs);
      const segCount = Math.ceil((end - start) / step);
      if (segCount <= 0) continue;

      const vertices = new Float32Array((segCount + 1) * 2 * 3);
      const indices = new Int32Array(segCount * 2 * 3);

      const midIdx = (start + Math.floor(segCount * 0.5) * step) % n;
      const pMid = L.points[midIdx];
      const ox = pMid.x, oy = pMid.y, oz = pMid.z;

      for (let s = 0; s <= segCount; s++) {
        const idx = (start + s * step) % n;
        const p = L.points[idx];
        const r = L.rights[idx];
        const baseV = s * 6;

        vertices[baseV] = (p.x - r.x * halfWidth) - ox;
        vertices[baseV + 1] = p.y - oy;
        vertices[baseV + 2] = (p.z - r.z * halfWidth) - oz;

        vertices[baseV + 3] = (p.x + r.x * halfWidth) - ox;
        vertices[baseV + 4] = p.y - oy;
        vertices[baseV + 5] = (p.z + r.z * halfWidth) - oz;

        if (s < segCount) {
          const l0 = s * 2, r0 = s * 2 + 1;
          const l1 = (s + 1) * 2, r1 = (s + 1) * 2 + 1;
          const baseI = s * 6;
          indices[baseI] = l0;     indices[baseI + 1] = r0;     indices[baseI + 2] = l1;
          indices[baseI + 3] = r0; indices[baseI + 4] = r1;     indices[baseI + 5] = l1;
        }
      }

      const trimeshShape = new CANNON.Trimesh(Array.from(vertices), Array.from(indices));
      const roadBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(ox, oy, oz),
        material: this.materials.groundMat,
        collisionFilterGroup: 4,
        collisionFilterMask: -1,
      });
      roadBody.addShape(trimeshShape);
      roadBody.updateBoundingRadius();
      this.world.addBody(roadBody);
      this.physicsBodies.push(roadBody);
    }
  }

  /**
   * Calcule l'altitude exacte `y = getTerrainHeight(x, z)` du maillage de terrain (accotement plat, talus ou plaine)
   * afin d'ancrer parfaitement au sol tous les arbres, buissons, rochers, tribunes et spectateurs.
   */
  getTerrainHeight(x, z) {
    const L = this.layout;
    if (!L.hasRelief) return -0.15;

    // Si dans l'emprise du lac Nord du Circuit 4 (échelle recalibrée -30% : centre 71, -365), retourne le niveau de la berge
    if (L.circuitId === 'lake') {
      const dxL = (x - 71) / 150;
      const dzL = (z + 365) / 86;
      if (dxL * dxL + dzL * dzL <= 1.0) {
        return 2.05;
      }
    }

    const proj = L.project(x, z);
    const idx = proj.index;
    const py = proj.y;
    const lat = proj.lateral;
    const dist = Math.abs(lat);

    const shArr = lat >= 0 ? this.shoulderOutDistRight : this.shoulderOutDistLeft;
    const shDist = (shArr && shArr[idx]) ? shArr[idx] : (L.barrierDistance + 0.8);

    // Sur toute la bande d'accotement plat (jusqu'à 10 m de large dans les creux), même hauteur Y que la bordure de piste !
    if (dist <= shDist) {
      return Math.max(-0.15, py - 0.04);
    }

    const outDistArr = lat >= 0 ? this.cliffOutDistRight : this.cliffOutDistLeft;
    const outDist = (outDistArr && outDistArr[idx]) ? outDistArr[idx] : (shDist + 18);

    if (dist >= outDist) {
      return -0.15;
    }

    const yIn = py - 0.05;
    const yOut = -0.15;
    const t = (dist - shDist) / Math.max(0.5, outDist - shDist);
    return Math.max(-0.15, yIn + (yOut - yIn) * t);
  }

  /**
   * Génère le relief 3D (Col de Montagne, Vallée & Lac) :
   *  - Bordures de falaises rocheuses et talus prenant naissance au bord extérieur de l'accotement plat (`shDist`)
   *  - Sommets montagneux autour de la vallée
   *  - Rochers low-poly instanciés (`THREE.InstancedMesh`) ancrés sur le terrain via `getTerrainHeight(x, z)`
   */
  _buildMountainReliefAndRocks() {
    const L = this.layout;
    const n = L.count;
    const bd = L.barrierDistance + 0.5;
    const isLake = L.circuitId === 'lake';
    const skirtOuter = isLake ? (bd + 22.0) : (bd + 24.0);

    this.cliffOutDistLeft = new Float32Array(n);
    this.cliffOutDistRight = new Float32Array(n);

    const verts = [];
    const indices = [];
    let vCount = 0;

    for (const side of [-1, 1]) {
      const shArr = side > 0 ? this.shoulderOutDistRight : this.shoulderOutDistLeft;
      const outArr = side > 0 ? this.cliffOutDistRight : this.cliffOutDistLeft;
      for (let i = 0; i <= n; i++) {
        const idx = i % n;
        const p = L.points[idx], r = L.rights[idx];
        const inDist = (shArr && shArr[idx]) ? shArr[idx] : bd;
        const xIn = p.x + r.x * side * inDist;
        const zIn = p.z + r.z * side * inDist;
        const yIn = p.y - 0.05;

        const isOnBridgeSpan = (L.circuitId === 'valley' && Math.abs(p.x) < 35 && Math.abs(p.z) < 84 && p.y > 9.0)
          || (L.circuitId === 'grotto' && (
            (Math.abs(p.x) < 78 && p.z > -102 && p.z < -4 && p.y > 42.0) ||
            (Math.abs(p.x) < 20 && p.z >= -160 && p.z <= 38 && p.y < 18.0) ||
            (Math.abs(p.x) < 20 && p.z >= 66 && p.z <= 198)
          ));

        const kSigned = side * L.curvature[idx];
        const maxCurveDist = kSigned > 0.002 ? Math.max(inDist + 1.2, 0.66 / kSigned) : Math.max(skirtOuter, inDist + 10.0);
        let outDist = isOnBridgeSpan ? (inDist + 0.4) : Math.min(Math.max(skirtOuter, inDist + 10.0), maxCurveDist);

        let xOut = p.x + r.x * side * outDist;
        let zOut = p.z + r.z * side * outDist;
        if (!isOnBridgeSpan && L.distanceToCenterline(xOut, zOut) < bd + 1.0) {
          outDist = inDist + 0.8;
          xOut = p.x + r.x * side * outDist;
          zOut = p.z + r.z * side * outDist;
        }
        outArr[idx] = outDist;

        const yOut = isOnBridgeSpan ? p.y - 1.15 : -0.15;

        verts.push(xIn, yIn, zIn, xOut, yOut, zOut);
        if (i < n && !isOnBridgeSpan) {
          const a = vCount, b = vCount + 1, c = vCount + 2, d = vCount + 3;
          if (side > 0) indices.push(a, b, c, b, d, c);
          else indices.push(a, c, b, b, c, d);
        }
        vCount += 2;
      }
    }

    const cliffGeo = new THREE.BufferGeometry();
    cliffGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    cliffGeo.setIndex(indices);
    cliffGeo.computeVertexNormals();
    const cliffMat = new THREE.MeshLambertMaterial({
      color: L.circuitId === 'lake' ? 0x4b5d44 : (L.circuitId === 'valley' ? 0x666c73 : 0x5c6168),
      flatShading: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.0,
      polygonOffsetUnits: 2.0,
    });
    this.cliffMesh = new THREE.Mesh(cliffGeo, cliffMat);
    this.root.add(this.cliffMesh);

    // 2) Massifs montagneux low-poly en arrière-plan (5 faces pour réduire le nombre de polygones)
    const rnd = seededRandom(77);
    const peakGeo = new THREE.ConeGeometry(1, 1, 5);
    peakGeo.translate(0, 0.5, 0);
    const peakMat = new THREE.MeshLambertMaterial({ color: 0x4f565e, flatShading: true });
    const snowGeo = new THREE.ConeGeometry(0.42, 0.42, 5);
    snowGeo.translate(0, 0.80, 0);
    const snowMat = new THREE.MeshLambertMaterial({ color: 0xeef3f8, flatShading: true });

    const isGrotto = L.circuitId === 'grotto';
    const peaks = isLake
      ? [
          [550, 180, 110, 135], [530, -240, 105, 125], [-550, -85, 115, 145],
          [-525, 295, 105, 130], [125, -715, 125, 150], [265, 730, 115, 140],
          [-335, 715, 110, 132], [-475, -545, 115, 138],
        ]
      : isGrotto
        ? [
            [860, 240, 135, 165], [840, -340, 130, 155], [-860, -140, 140, 175],
            [-820, 420, 125, 150], [180, -760, 145, 180], [-480, -720, 135, 162],
            [520, 720, 128, 152], [-440, 730, 122, 148], [210, 260, 95, 118],
            [-230, -240, 100, 128],
          ]
        : [
            [110, 45, 55, 68], [-90, -40, 62, 75], [340, 90, 75, 95],
            [335, -80, 70, 88], [-345, -20, 80, 96], [-330, 140, 68, 82],
            [60, -320, 78, 92], [120, 310, 72, 85], [-160, 310, 66, 78],
          ];
    for (const [px, pz, rad, h] of peaks) {
      if (L.distanceToCenterline(px, pz) < rad + L.barrierDistance + 14) continue;
      if (isLake && (((px - 71) * (px - 71)) / (170 * 170) + ((pz + 365) * (pz + 365)) / (105 * 105) < 1.0)) continue;
      const m = new THREE.Mesh(peakGeo, peakMat);
      m.position.set(px, -1.2, pz);
      m.scale.set(rad, h, rad);
      m.rotation.y = rnd() * Math.PI * 2;
      this.root.add(m);

      if (h > 72) {
        const s = new THREE.Mesh(snowGeo, snowMat);
        s.position.set(px, -1.2, pz);
        s.scale.set(rad, h, rad);
        s.rotation.y = m.rotation.y;
        this.root.add(s);
      }
    }

    // 3) Rochers low-poly instanciés (réduits de 40% et regroupés près des bordures de piste)
    const rockCount = isLake ? 190 : 140;
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let placedRocks = 0;

    for (let k = 0; k < rockCount; k++) {
      const idx = Math.floor(rnd() * n);
      const side = rnd() > 0.5 ? 1 : -1;
      const offset = bd + 2.0 + rnd() * 7.5;
      const p = L.points[idx], r = L.rights[idx];
      const rx = p.x + r.x * side * offset;
      const rz = p.z + r.z * side * offset;
      if (L.distanceToCenterline(rx, rz) < bd + 1.8) continue;
      if (this._isGrottoExcludedZone(rx, rz)) continue;
      if (isLake && (((rx - 71) * (rx - 71)) / (152 * 152) + ((rz + 365) * (rz + 365)) / (88 * 88) < 1.0)) continue;

      const baseScale = 0.8 + rnd() * 1.7;
      const ry = this.getTerrainHeight(rx, rz) - 0.15 + baseScale * 0.26;

      pos.set(rx, ry, rz);
      quat.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      scl.set(baseScale * (0.8 + rnd() * 0.5), baseScale * (0.6 + rnd() * 0.65), baseScale);
      m4.compose(pos, quat, scl);
      rocks.setMatrixAt(placedRocks, m4);

      const shade = 0.38 + rnd() * 0.22;
      col.setRGB(shade, shade * 1.02, shade * 1.05);
      rocks.setColorAt(placedRocks, col);
      placedRocks++;
    }
    rocks.count = placedRocks;
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    this.root.add(rocks);
  }

  /* ------------------------------------------------------------------ */
  /*  Circuit 3 : Environnement « Vallée & Pont » Ultra Détaillé         */
  /* ------------------------------------------------------------------ */

  _buildValleyScenery() {
    this._buildValleyRiver();
    this._buildValleyBridge();
    this._buildValleyBuildings();
  }

  /**
   * Rivière bleu transparent avec reflet spéculaire et onde animée par shader GPU.
   * Longe la portion basse de la vallée et passe sous l'arche Nord du grand viaduc.
   */
  _buildValleyRiver() {
    const riverPoints = [
      new THREE.Vector3(380, 0.14, 150),
      new THREE.Vector3(295, 0.14, 72),
      new THREE.Vector3(230, 0.14, -22),
      new THREE.Vector3(150, 0.14, -36),
      new THREE.Vector3(70, 0.14, -30),
      new THREE.Vector3(0, 0.14, -30),
      new THREE.Vector3(-85, 0.14, -36),
      new THREE.Vector3(-155, 0.14, -75),
      new THREE.Vector3(-240, 0.14, -140),
      new THREE.Vector3(-360, 0.14, -220),
    ];
    const curve = new THREE.CatmullRomCurve3(riverPoints, false, 'centripetal');
    const segs = 120;
    const pts = curve.getSpacedPoints(segs);
    const halfW = 14.0;
    const bankW = 18.5;

    const wVerts = [];
    const wNorms = [];
    const wUvs = [];
    const wIdx = [];

    const bVerts = [];
    const bNorms = [];
    const bIdx = [];

    for (let i = 0; i <= segs; i++) {
      const p = pts[i];
      const pPrev = pts[Math.max(0, i - 1)];
      const pNext = pts[Math.min(segs, i + 1)];
      const tx = pNext.x - pPrev.x;
      const tz = pNext.z - pPrev.z;
      const len = Math.hypot(tx, tz) || 1;
      const rx = -tz / len;
      const rz = tx / len;

      // Lit/berges sablonneuses
      bVerts.push(
        p.x - rx * bankW, -0.01, p.z - rz * bankW,
        p.x + rx * bankW, -0.01, p.z + rz * bankW
      );
      bNorms.push(0, 1, 0, 0, 1, 0);

      // Ruban d'eau subdivisé transversalement (3 sommets) pour l'ondulation shader
      const vCoord = i * 0.28;
      wVerts.push(
        p.x - rx * halfW, p.y, p.z - rz * halfW,
        p.x,              p.y, p.z,
        p.x + rx * halfW, p.y, p.z + rz * halfW
      );
      wNorms.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      wUvs.push(0, vCoord, 0.5, vCoord, 1, vCoord);

      if (i < segs) {
        const kb = i * 2;
        bIdx.push(kb, kb + 1, kb + 2, kb + 1, kb + 3, kb + 2);

        const kw = i * 3;
        wIdx.push(
          kw, kw + 1, kw + 3, kw + 1, kw + 4, kw + 3,
          kw + 1, kw + 2, kw + 4, kw + 2, kw + 5, kw + 4
        );
      }
    }

    const bankGeo = new THREE.BufferGeometry();
    bankGeo.setAttribute('position', new THREE.Float32BufferAttribute(bVerts, 3));
    bankGeo.setAttribute('normal', new THREE.Float32BufferAttribute(bNorms, 3));
    bankGeo.setIndex(bIdx);
    const bankMat = new THREE.MeshLambertMaterial({ color: 0x6f6756, side: THREE.DoubleSide });
    this.root.add(new THREE.Mesh(bankGeo, bankMat));

    const waterGeo = new THREE.BufferGeometry();
    waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wVerts, 3));
    waterGeo.setAttribute('normal', new THREE.Float32BufferAttribute(wNorms, 3));
    waterGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUvs, 2));
    waterGeo.setIndex(wIdx);

    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x1688c2,
      roughness: 0.14,
      metalness: 0.35,
      transparent: true,
      opacity: 0.84,
      side: THREE.DoubleSide,
    });
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.spectatorUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float wave = sin(position.x * 0.18 + uTime * 2.4) * 0.08 + cos(position.z * 0.22 + uTime * 1.9) * 0.07;
         transformed.y += wave;`
      );
    };
    this.root.add(new THREE.Mesh(waterGeo, waterMat));
  }

  /**
   * Grand Pont / Viaduc monumental à arches en pierre et superstructure métallique en treillis.
   * La piste passe SOUS l'arche centrale (z = 0, y = 0.5 m) puis SUR le tablier (x = 0, y = 14.0 m).
   */
  _buildValleyBridge() {
    const group = new THREE.Group();
    group.name = 'valleyBridge';
    this.root.add(group);

    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x7e848c, flatShading: true });
    const darkStoneMat = new THREE.MeshLambertMaterial({ color: 0x585e66, flatShading: true });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x37474f, metalness: 0.78, roughness: 0.34 });
    const accentSteelMat = new THREE.MeshStandardMaterial({ color: 0xc62828, metalness: 0.65, roughness: 0.38 });

    const bridgeW = (this.layout.barrierDistance + 1.1) * 2;
    const bridgeLen = 166;
    const deckY = 14.0;

    // 1) Tablier massif en pierre/béton sous la chaussée du pont
    const deckGeo = new THREE.BoxGeometry(bridgeW + 1.6, 1.35, bridgeLen);
    const deckMesh = new THREE.Mesh(deckGeo, stoneMat);
    deckMesh.position.set(0, deckY - 0.72, 0);
    group.add(deckMesh);

    // Corniches latérales en pierre
    for (const side of [-1, 1]) {
      const ledgeGeo = new THREE.BoxGeometry(1.1, 1.6, bridgeLen + 2);
      const ledge = new THREE.Mesh(ledgeGeo, darkStoneMat);
      ledge.position.set(side * (bridgeW * 0.5 + 0.55), deckY - 0.3, 0);
      group.add(ledge);
    }

    // 2) Piliers monumentaux en pierre (espacés pour laisser z ∈ [-17, +17] libre pour la route et z ∈ [-43, -17] pour la rivière)
    const pierZList = [-72, -45, -17.5, 17.5, 45, 72];
    const pierGeo = new THREE.BoxGeometry(bridgeW + 2.4, deckY - 0.5, 4.2);
    const baseGeo = new THREE.BoxGeometry(bridgeW + 4.0, 2.2, 5.8);

    for (const pz of pierZList) {
      const pier = new THREE.Mesh(pierGeo, stoneMat);
      pier.position.set(0, (deckY - 0.5) * 0.5, pz);
      group.add(pier);

      const base = new THREE.Mesh(baseGeo, darkStoneMat);
      base.position.set(0, 1.0, pz);
      group.add(base);
    }

    // 3) Voussoirs d'arches en pierre entre chaque paire de piliers
    for (let k = 0; k < pierZList.length - 1; k++) {
      const z0 = pierZList[k];
      const z1 = pierZList[k + 1];
      const span = z1 - z0 - 3.6;
      const midZ = (z0 + z1) * 0.5;
      const archSegs = 9;
      for (let s = 0; s < archSegs; s++) {
        const a0 = (s / archSegs) * Math.PI;
        const a1 = ((s + 1) / archSegs) * Math.PI;
        const am = (a0 + a1) * 0.5;
        const segZ = midZ - Math.cos(am) * (span * 0.5);
        const segY = 5.5 + Math.sin(am) * 7.2;
        const chord = (span * 0.5) * (Math.PI / archSegs) * 1.12;

        const voussoirGeo = new THREE.BoxGeometry(bridgeW + 1.8, 1.25, chord);
        const voussoir = new THREE.Mesh(voussoirGeo, darkStoneMat);
        voussoir.position.set(0, segY, segZ);
        voussoir.rotation.x = am - Math.PI * 0.5;
        group.add(voussoir);
      }
    }

    // 4) Superstructure en treillis métallique (Truss Bridge) au-dessus du tablier (y = 14.0 -> 20.4 m)
    const trussH = 6.4;
    const trussX = this.layout.barrierDistance + 0.65;
    const bayStep = 14;
    const colGeo = new THREE.BoxGeometry(0.48, trussH, 0.48);
    const diagLen = Math.hypot(bayStep, trussH);
    const diagGeo = new THREE.BoxGeometry(0.28, diagLen, 0.28);
    const topBeamGeo = new THREE.BoxGeometry(0.55, 0.55, bridgeLen - 12);
    const crossBeamGeo = new THREE.BoxGeometry(trussX * 2 + 0.6, 0.48, 0.48);

    for (const side of [-1, 1]) {
      const topBeam = new THREE.Mesh(topBeamGeo, accentSteelMat);
      topBeam.position.set(side * trussX, deckY + trussH, 0);
      group.add(topBeam);
    }

    for (let z = -70; z <= 70; z += bayStep) {
      for (const side of [-1, 1]) {
        const col = new THREE.Mesh(colGeo, steelMat);
        col.position.set(side * trussX, deckY + trussH * 0.5, z);
        group.add(col);

        if (z < 70) {
          const diag = new THREE.Mesh(diagGeo, accentSteelMat);
          diag.position.set(side * trussX, deckY + trussH * 0.5, z + bayStep * 0.5);
          diag.rotation.x = Math.atan2(bayStep, trussH) * (z % (bayStep * 2) === 0 ? 1 : -1);
          group.add(diag);
        }
      }

      // Portique transversal supérieur
      const cross = new THREE.Mesh(crossBeamGeo, steelMat);
      cross.position.set(0, deckY + trussH, z);
      group.add(cross);
    }
  }

  /**
   * Bâtiments du Circuit 3 :
   *  - Paddock de course & bâtiment des stands (Pit Building) à toiture plate le long de la ligne de départ
   *  - Hangars industriels près de la zone technique
   *  - Maisons/chalets de bord de route sur le coteau Ouest
   */
  _buildValleyBuildings() {
    const group = new THREE.Group();
    group.name = 'valleyBuildings';
    this.root.add(group);

    const concreteMat = new THREE.MeshLambertMaterial({ color: 0xd7dce2 });
    const darkRoofMat = new THREE.MeshLambertMaterial({ color: 0x262c34 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x152536, metalness: 0.85, roughness: 0.15 });
    const redAccentMat = new THREE.MeshLambertMaterial({ color: 0xd32f2f });
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0x607d8b, metalness: 0.45, roughness: 0.55 });
    const houseWallMat = new THREE.MeshLambertMaterial({ color: 0xf2eadc });
    const houseRoofMat = new THREE.MeshLambertMaterial({ color: 0x8d3b28, flatShading: true });

    // 1) Grand bâtiment des Stands / Paddock (le long de la ligne droite de départ, z = 224, y = 3.5 m)
    const pitBaseY = 3.5;
    const pitZ = 224.5;
    const pitBody = new THREE.Mesh(new THREE.BoxGeometry(118, 5.2, 13), concreteMat);
    pitBody.position.set(16, pitBaseY + 2.6, pitZ);
    group.add(pitBody);

    // Loges vitrées VIP à l'étage
    const vipGlass = new THREE.Mesh(new THREE.BoxGeometry(114, 3.0, 10.5), glassMat);
    vipGlass.position.set(16, pitBaseY + 6.7, pitZ - 0.5);
    group.add(vipGlass);

    // Toiture plate en porte-à-faux au-dessus de la voie des stands
    const pitRoof = new THREE.Mesh(new THREE.BoxGeometry(124, 0.75, 17.5), darkRoofMat);
    pitRoof.position.set(16, pitBaseY + 8.5, pitZ - 2.2);
    group.add(pitRoof);

    const pitFascia = new THREE.Mesh(new THREE.BoxGeometry(124.2, 0.45, 0.4), redAccentMat);
    pitFascia.position.set(16, pitBaseY + 8.55, pitZ - 10.9);
    group.add(pitFascia);

    // Portes de boxes des écuries (10 garages)
    const bayGeo = new THREE.BoxGeometry(7.8, 3.6, 0.35);
    const bayMat = new THREE.MeshLambertMaterial({ color: 0x1c2128 });
    for (let k = 0; k < 10; k++) {
      const bx = -36 + k * 11.5;
      const bay = new THREE.Mesh(bayGeo, bayMat);
      bay.position.set(bx, pitBaseY + 1.8, pitZ - 6.4);
      group.add(bay);
    }

    // 2) Hangars industriels (zone technique Est)
    const hangars = [
      { x: 135, y: 3.5, z: 226, w: 28, h: 7.5, d: 16, rot: -0.05 },
      { x: 172, y: 3.4, z: 224, w: 26, h: 7.5, d: 15, rot: -0.08 },
      { x: -115, y: 3.5, z: 226, w: 30, h: 7.2, d: 16, rot: 0.02 },
    ];
    for (const h of hangars) {
      const hGroup = new THREE.Group();
      hGroup.position.set(h.x, h.y, h.z);
      hGroup.rotation.y = h.rot;
      const body = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), hangarMat);
      body.position.y = h.h * 0.5;
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(h.d * 0.52, h.d * 0.52, h.w, 10, 1, false, 0, Math.PI), darkRoofMat);
      roof.rotation.z = Math.PI * 0.5;
      roof.scale.set(0.38, 1, 1);
      roof.position.y = h.h;
      hGroup.add(body, roof);
      group.add(hGroup);
    }

    // 3) Petites maisons / chalets de bord de route sur les coteaux
    const houses = [
      { x: -86, z: 170, rot: 0.25, s: 1.0 },
      { x: -112, z: 164, rot: -0.15, s: 1.1 },
      { x: -138, z: 162, rot: 0.10, s: 0.95 },
      { x: -164, z: 168, rot: 0.40, s: 1.05 },
      { x: 196, z: 62, rot: -1.1, s: 1.0 },
      { x: 182, z: 46, rot: -0.8, s: 0.92 },
    ];
    const hBodyGeo = new THREE.BoxGeometry(7.2, 4.6, 6.2);
    hBodyGeo.translate(0, 2.3, 0);
    const hRoofGeo = new THREE.ConeGeometry(5.8, 2.8, 4);
    hRoofGeo.rotateY(Math.PI * 0.25);
    hRoofGeo.translate(0, 6.0, 0);

    for (const hs of houses) {
      const proj = this.layout.project(hs.x, hs.z);
      if (proj.dist < this.layout.barrierDistance + 5.5) continue;
      const hg = new THREE.Group();
      hg.position.set(hs.x, Math.max(0, proj.y - 0.3), hs.z);
      hg.rotation.y = hs.rot;
      hg.scale.setScalar(hs.s);
      hg.add(new THREE.Mesh(hBodyGeo, houseWallMat));
      hg.add(new THREE.Mesh(hRoofGeo, houseRoofMat));
      group.add(hg);
    }
  }

  /**
   * Drapeaux animés aux couleurs du circuit disposés le long du paddock, du pont et des virages.
   */
  _buildCircuitFlags() {
    const L = this.layout;
    const n = L.count;
    const bd = L.barrierDistance + 1.4;
    const step = 10;

    const poleGeo = new THREE.CylinderGeometry(0.05, 0.07, 4.6, 5);
    poleGeo.translate(0, 2.3, 0);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xd0d6de });

    const flagGeo = new THREE.PlaneGeometry(1.75, 0.95, 4, 1);
    flagGeo.translate(0.88, 4.05, 0);
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.spectatorUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float flutter = sin(uTime * 7.5 + position.x * 3.8 + float(gl_InstanceID) * 1.3) * (position.x * 0.14);
         transformed.z += flutter;`
      );
    };

    const maxFlags = Math.ceil(n / step) * 2;
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, maxFlags);
    const flags = new THREE.InstancedMesh(flagGeo, flagMat, maxFlags);
    const palette = [0x00e5ff, 0xff3d00, 0xffd600, 0x1e88e5, 0x00e676];
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let count = 0;

    for (let i = 0; i < n; i += step) {
      const p = L.points[i], r = L.rights[i];
      if (L.isInTunnel && L.isInTunnel(p.x, p.y, p.z)) continue;
      // Dans les points bas (p.y <= 15m), on place des drapeaux tous les 10 pas directement sur l'accotement plat ;
      // en hauteur, un drapeau tous les 20 pas.
      if (p.y > 15.0 && (i % 20 !== 0)) continue;
      for (const side of [-1, 1]) {
        const fx = p.x + r.x * side * bd;
        const fz = p.z + r.z * side * bd;
        if (this._isGrottoExcludedZone(fx, fz)) continue;
        const fy = this.getTerrainHeight(fx, fz);
        m4.makeTranslation(fx, fy, fz);
        poles.setMatrixAt(count, m4);
        flags.setMatrixAt(count, m4);
        col.setHex(palette[count % palette.length]);
        flags.setColorAt(count, col);
        count++;
      }
    }

    poles.count = count;
    flags.count = count;
    poles.instanceMatrix.needsUpdate = true;
    flags.instanceMatrix.needsUpdate = true;
    if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
    this.root.add(poles, flags);
  }

  /* ------------------------------------------------------------------ */
  /*  Circuit 4 : Décors Spécifiques « Lac & Végétation » (-30% scale)  */
  /* ------------------------------------------------------------------ */

  _buildLakeAndVegetationScenery() {
    this._buildInnerNorthLake();
    this._buildDenseVegetationForest();
    this._buildLakeSidePitPavilions();
  }

  _buildInnerNorthLake() {
    const lakeGroup = new THREE.Group();
    lakeGroup.name = 'innerNorthLake';
    this.root.add(lakeGroup);

    // Coordonnées recalibrées (-30%) au coeur du lobe Nord, au niveau de la rive basse (y = 2.15m)
    const lakeX = 71;
    const lakeZ = -365;
    const lakeY = 2.15;
    const rx = 136;
    const rz = 76;

    // 1) Bordure sablonneuse et rocheuse claire autour du pourtour du plan d'eau
    const outerSandGeo = new THREE.CircleGeometry(1, 48);
    outerSandGeo.rotateX(-Math.PI / 2);
    const outerSandMat = new THREE.MeshLambertMaterial({
      color: 0xe6d6b8,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -1.0,
    });
    const outerSandMesh = new THREE.Mesh(outerSandGeo, outerSandMat);
    outerSandMesh.position.set(lakeX, lakeY - 0.14, lakeZ);
    outerSandMesh.scale.set(rx + 14, 1, rz + 12);
    lakeGroup.add(outerSandMesh);

    // Jupe de berge périphérique raccordant le bord sablonneux au sol de la vallée
    const skirtGeo = new THREE.CylinderGeometry(1, 1.08, 2.3, 48, 1, true);
    const skirtMesh = new THREE.Mesh(skirtGeo, outerSandMat);
    skirtMesh.position.set(lakeX, lakeY - 1.25, lakeZ);
    skirtMesh.scale.set(rx + 14, 1, rz + 12);
    lakeGroup.add(skirtMesh);

    const innerPebbleGeo = new THREE.CircleGeometry(1, 48);
    innerPebbleGeo.rotateX(-Math.PI / 2);
    const innerPebbleMat = new THREE.MeshLambertMaterial({
      color: 0xcfc4b0,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -2.0,
    });
    const innerPebbleMesh = new THREE.Mesh(innerPebbleGeo, innerPebbleMat);
    innerPebbleMesh.position.set(lakeX, lakeY - 0.08, lakeZ);
    innerPebbleMesh.scale.set(rx + 5, 1, rz + 4.5);
    lakeGroup.add(innerPebbleMesh);

    // Fond aquatique bleu azur sous la surface semi-transparente
    const bedGeo = new THREE.CircleGeometry(1, 48);
    bedGeo.rotateX(-Math.PI / 2);
    const bedMat = new THREE.MeshBasicMaterial({
      color: 0x005b96,
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -3.0,
    });
    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.position.set(lakeX, lakeY - 0.04, lakeZ);
    bedMesh.scale.set(rx, 1, rz);
    lakeGroup.add(bedMesh);

    // 2) Surface d'eau bleu azur / cyan profonde et lumineuse (color: 0x0077be, roughness: 0.1, metalness: 0.15, opacity: 0.85)
    const waterGeo = new THREE.CircleGeometry(1, 48);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0077be,
      emissive: 0x004b80,
      emissiveIntensity: 0.26,
      roughness: 0.1,
      metalness: 0.15,
      transparent: true,
      opacity: 0.85,
      envMap: this.scene.environment || null,
      envMapIntensity: 1.35,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -4.0,
    });
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.spectatorUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ripple = sin(position.x * 24.0 + uTime * 2.2) * 0.05 + cos(position.z * 18.0 + uTime * 1.7) * 0.04;
         transformed.y += ripple;`
      );
    };
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.set(lakeX, lakeY, lakeZ);
    waterMesh.scale.set(rx, 1, rz);
    lakeGroup.add(waterMesh);

    // 3) Rochers clairs instanciés disposés sur la berge sablonneuse + îlots rocheux
    const L = this.layout;
    const bd = L.barrierDistance;
    const rnd = seededRandom(404);
    const shoreRockCount = 95;
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const shoreRocks = new THREE.InstancedMesh(rockGeo, rockMat, shoreRockCount);

    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let placed = 0;

    for (let i = 0; i < shoreRockCount - 8; i++) {
      const ang = (i / (shoreRockCount - 8)) * Math.PI * 2 + (rnd() - 0.5) * 0.06;
      const radialJit = 0.97 + rnd() * 0.09;
      const x = lakeX + Math.cos(ang) * rx * radialJit;
      const z = lakeZ + Math.sin(ang) * rz * radialJit;
      if (L.distanceToCenterline(x, z) < bd + 2.5) continue;

      const s = 0.9 + rnd() * 2.1;
      pos.set(x, lakeY - 0.22 + s * 0.30, z);
      quat.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      scl.set(s * (0.9 + rnd() * 0.45), s * (0.52 + rnd() * 0.42), s * (0.85 + rnd() * 0.4));
      m4.compose(pos, quat, scl);
      shoreRocks.setMatrixAt(placed, m4);

      const shade = 0.58 + rnd() * 0.24;
      col.setRGB(shade * 1.04, shade * 1.0, shade * 0.92);
      shoreRocks.setColorAt(placed, col);
      placed++;
    }

    const islets = [
      [lakeX - 38, lakeZ + 8, 4.2],
      [lakeX - 29, lakeZ + 13, 2.9],
      [lakeX + 45, lakeZ - 10, 3.8],
      [lakeX + 52, lakeZ - 6, 2.6],
    ];
    for (const [ix, iz, iscale] of islets) {
      if (placed >= shoreRockCount) break;
      pos.set(ix, lakeY + 0.28, iz);
      quat.setFromEuler(new THREE.Euler(rnd() * 2, rnd() * 3, rnd() * 2));
      scl.set(iscale * 1.35, iscale * 0.72, iscale * 1.15);
      m4.compose(pos, quat, scl);
      shoreRocks.setMatrixAt(placed, m4);
      col.setRGB(0.55, 0.58, 0.60);
      shoreRocks.setColorAt(placed, col);
      placed++;
    }

    shoreRocks.count = placed;
    shoreRocks.instanceMatrix.needsUpdate = true;
    if (shoreRocks.instanceColor) shoreRocks.instanceColor.needsUpdate = true;
    lakeGroup.add(shoreRocks);

    // 4) Ponton en bois sur la rive Sud du lac (au ras de l'accotement plat de la rive Sud)
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x6d4c41 });
    const dockDeck = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.28, 14.0), woodMat);
    dockDeck.position.set(lakeX + 14, lakeY + 0.35, lakeZ + rz - 3.0);
    lakeGroup.add(dockDeck);
  }

  /**
   * Génère la forêt dense (« végétation ») recalibrée (-30% échelle, -40% instances, géométries low-poly)
   * et resserrée tout contre les glissières dans les sections basses (effet couloir de vitesse immersif).
   */
  _buildDenseVegetationForest() {
    const L = this.layout;
    const bd = L.barrierDistance;
    const rnd = seededRandom(808);

    // Coordonnées recalibrées (-30%) de la zone « végétation » du schéma manuscrit
    const vegetationSpine = [
      // Bande principale Ouest
      [-403, -231, 56], [-412, -136, 60], [-410, -42, 64], [-399, 52, 64],
      [-378, 143, 60], [-328, 214, 52], [-269, 256, 48],
      // Bras d'infiltration Central-Sud
      [-202, 269, 42], [-134, 286, 38], [-67, 319, 34], [-8, 365, 31], [21, 403, 26],
      // Bras Sud-Ouest
      [-277, 319, 42], [-281, 395, 46], [-269, 470, 46], [-231, 533, 42],
      // Bosquets Nord-Est et Sud-Est
      [395, -304, 46], [382, -410, 46], [319, 388, 46], [307, 262, 42],
    ];

    const forestTrees = [];
    const bushList = [];
    const mossRockList = [];

    // 1) Couloir forestier oppressant dans les points bas (arbres et buissons juste derrière les glissières sur l'accotement plat)
    for (let i = 0; i < L.count; i += 3) {
      const p = L.points[i], r = L.rights[i];
      if (p.y > 16.5) continue;
      for (const side of [-1, 1]) {
        if (rnd() < 0.35) continue;
        const dist = bd + 2.2 + rnd() * 6.8;
        const x = p.x + r.x * side * dist;
        const z = p.z + r.z * side * dist;
        if (L.distanceToCenterline(x, z) < bd + 2.0) continue;
        if (((x - 71) * (x - 71)) / (152 * 152) + ((z + 365) * (z + 365)) / (88 * 88) < 1.0) continue;

        const yBase = this.getTerrainHeight(x, z) - 0.18;
        forestTrees.push({
          x,
          y: yBase,
          z,
          scale: 0.95 + rnd() * 0.85,
          rot: rnd() * Math.PI * 2,
          kind: rnd() < 0.50 ? 'pine' : (rnd() < 0.80 ? 'oak' : 'birch'),
        });

        if (rnd() < 0.65) {
          const bDist = bd + 1.6 + rnd() * 4.5;
          const bx = p.x + r.x * side * bDist;
          const bz = p.z + r.z * side * bDist;
          if (L.distanceToCenterline(bx, bz) >= bd + 1.5) {
            bushList.push({
              x: bx,
              y: this.getTerrainHeight(bx, bz) - 0.15,
              z: bz,
              scale: 0.85 + rnd() * 1.0,
              rot: rnd() * Math.PI * 2,
            });
          }
        }
      }
    }

    // 2) Massifs de la zone « végétation » (densité réduite de 40% pour 60 FPS constants)
    for (const [cx, cz, radius] of vegetationSpine) {
      const treeDensity = Math.round(radius * 0.32);
      for (let k = 0; k < treeDensity; k++) {
        const ang = rnd() * Math.PI * 2;
        const rDist = Math.sqrt(rnd()) * radius;
        const x = cx + Math.cos(ang) * rDist;
        const z = cz + Math.sin(ang) * rDist;

        const dTrack = L.distanceToCenterline(x, z);
        if (dTrack < bd + 2.4) continue;
        if (((x - 71) * (x - 71)) / (152 * 152) + ((z + 365) * (z + 365)) / (88 * 88) < 1.0) continue;

        const yBase = this.getTerrainHeight(x, z) - 0.20;
        forestTrees.push({
          x,
          y: yBase,
          z,
          scale: 0.95 + rnd() * 0.95,
          rot: rnd() * Math.PI * 2,
          kind: rnd() < 0.48 ? 'pine' : (rnd() < 0.78 ? 'oak' : 'birch'),
        });
      }

      const bushDensity = Math.round(radius * 0.34);
      for (let k = 0; k < bushDensity; k++) {
        const ang = rnd() * Math.PI * 2;
        const rDist = Math.sqrt(rnd()) * (radius + 6);
        const x = cx + Math.cos(ang) * rDist;
        const z = cz + Math.sin(ang) * rDist;

        const dTrack = L.distanceToCenterline(x, z);
        if (dTrack < bd + 1.8) continue;
        if (((x - 71) * (x - 71)) / (150 * 150) + ((z + 365) * (z + 365)) / (86 * 86) < 1.0) continue;

        const yBase = this.getTerrainHeight(x, z) - 0.18;
        bushList.push({
          x,
          y: yBase,
          z,
          scale: 0.85 + rnd() * 1.1,
          rot: rnd() * Math.PI * 2,
        });
      }

      const rockDensity = Math.round(radius * 0.11);
      for (let k = 0; k < rockDensity; k++) {
        const ang = rnd() * Math.PI * 2;
        const rDist = Math.sqrt(rnd()) * radius;
        const x = cx + Math.cos(ang) * rDist;
        const z = cz + Math.sin(ang) * rDist;
        const dTrack = L.distanceToCenterline(x, z);
        if (dTrack < bd + 2.4) continue;
        if (((x - 71) * (x - 71)) / (150 * 150) + ((z + 365) * (z + 365)) / (86 * 86) < 1.0) continue;

        const s = 0.9 + rnd() * 1.6;
        const yBase = this.getTerrainHeight(x, z) - 0.18 + s * 0.25;
        mossRockList.push({
          x,
          y: yBase,
          z,
          scale: s,
          rot: rnd() * Math.PI * 2,
        });
      }
    }

    const pines = forestTrees.filter((t) => t.kind === 'pine');
    const oaks = forestTrees.filter((t) => t.kind === 'oak');
    const birches = forestTrees.filter((t) => t.kind === 'birch');

    // Géométries ultra low-poly (troncs à 5 faces, cônes à 5 faces, dodécaèdres détail 0)
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 2.8, 5);
    trunkGeo.translate(0, 1.0, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4e342e });

    const p1 = new THREE.ConeGeometry(1.8, 3.0, 5); p1.translate(0, 3.2, 0);
    const p2 = new THREE.ConeGeometry(1.35, 2.6, 5); p2.translate(0, 4.8, 0);
    const pineGeo = mergeGeometries([p1, p2]);

    const o1 = new THREE.DodecahedronGeometry(1.9, 0); o1.translate(0, 3.7, 0);
    const o2 = new THREE.DodecahedronGeometry(1.4, 0); o2.translate(0.6, 4.2, 0.3);
    const oakGeo = mergeGeometries([o1, o2]);

    const birchGeo = new THREE.ConeGeometry(1.15, 4.8, 5);
    birchGeo.translate(0, 4.2, 0);

    const foliageMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });

    const totalTrunks = forestTrees.length;
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, totalTrunks));
    const pineMesh = new THREE.InstancedMesh(pineGeo, foliageMat, Math.max(1, pines.length));
    const oakMesh = new THREE.InstancedMesh(oakGeo, foliageMat, Math.max(1, oaks.length));
    const birchMesh = new THREE.InstancedMesh(birchGeo, foliageMat, Math.max(1, birches.length));

    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();

    let tIdx = 0;
    pines.forEach((t, i) => {
      pos.set(t.x, t.y, t.z);
      quat.setFromEuler(new THREE.Euler(0, t.rot, 0));
      scl.setScalar(t.scale);
      m4.compose(pos, quat, scl);
      trunkMesh.setMatrixAt(tIdx++, m4);
      pineMesh.setMatrixAt(i, m4);
      col.setHSL(0.31 + (rnd() - 0.5) * 0.04, 0.58, 0.18 + rnd() * 0.10);
      pineMesh.setColorAt(i, col);
    });

    oaks.forEach((t, i) => {
      pos.set(t.x, t.y, t.z);
      quat.setFromEuler(new THREE.Euler(0, t.rot, 0));
      scl.setScalar(t.scale);
      m4.compose(pos, quat, scl);
      trunkMesh.setMatrixAt(tIdx++, m4);
      oakMesh.setMatrixAt(i, m4);
      col.setHSL(0.26 + (rnd() - 0.5) * 0.06, 0.62, 0.24 + rnd() * 0.12);
      oakMesh.setColorAt(i, col);
    });

    birches.forEach((t, i) => {
      pos.set(t.x, t.y, t.z);
      quat.setFromEuler(new THREE.Euler(0, t.rot, 0));
      scl.setScalar(t.scale);
      m4.compose(pos, quat, scl);
      trunkMesh.setMatrixAt(tIdx++, m4);
      birchMesh.setMatrixAt(i, m4);
      col.setHSL(0.22 + (rnd() - 0.5) * 0.05, 0.65, 0.28 + rnd() * 0.12);
      birchMesh.setColorAt(i, col);
    });

    trunkMesh.instanceMatrix.needsUpdate = true;
    pineMesh.instanceMatrix.needsUpdate = true;
    oakMesh.instanceMatrix.needsUpdate = true;
    birchMesh.instanceMatrix.needsUpdate = true;
    if (pineMesh.instanceColor) pineMesh.instanceColor.needsUpdate = true;
    if (oakMesh.instanceColor) oakMesh.instanceColor.needsUpdate = true;
    if (birchMesh.instanceColor) birchMesh.instanceColor.needsUpdate = true;
    this.root.add(trunkMesh, pineMesh, oakMesh, birchMesh);

    const bu1 = new THREE.DodecahedronGeometry(0.95, 0); bu1.translate(0, 0.52, 0);
    const bu2 = new THREE.DodecahedronGeometry(0.70, 0); bu2.translate(0.50, 0.40, 0.22);
    const bushGeo = mergeGeometries([bu1, bu2]);
    const bushMesh = new THREE.InstancedMesh(bushGeo, foliageMat, Math.max(1, bushList.length));

    bushList.forEach((b, i) => {
      pos.set(b.x, b.y, b.z);
      quat.setFromEuler(new THREE.Euler(0, b.rot, 0));
      scl.set(b.scale, b.scale * 0.85, b.scale);
      m4.compose(pos, quat, scl);
      bushMesh.setMatrixAt(i, m4);
      col.setHSL(0.28 + (rnd() - 0.5) * 0.07, 0.64, 0.22 + rnd() * 0.14);
      bushMesh.setColorAt(i, col);
    });
    bushMesh.instanceMatrix.needsUpdate = true;
    if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
    this.root.add(bushMesh);

    const mRockGeo = new THREE.DodecahedronGeometry(0.95, 0);
    const mRockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const mRockMesh = new THREE.InstancedMesh(mRockGeo, mRockMat, Math.max(1, mossRockList.length));

    mossRockList.forEach((mr, i) => {
      pos.set(mr.x, mr.y, mr.z);
      quat.setFromEuler(new THREE.Euler(rnd() * 2, mr.rot, rnd() * 2));
      scl.set(mr.scale * 1.15, mr.scale * 0.72, mr.scale);
      m4.compose(pos, quat, scl);
      mRockMesh.setMatrixAt(i, m4);
      col.setRGB(0.34 + rnd() * 0.12, 0.42 + rnd() * 0.14, 0.33 + rnd() * 0.10);
      mRockMesh.setColorAt(i, col);
    });
    mRockMesh.instanceMatrix.needsUpdate = true;
    if (mRockMesh.instanceColor) mRockMesh.instanceColor.needsUpdate = true;
    this.root.add(mRockMesh);
  }

  _buildLakeSidePitPavilions() {
    const L = this.layout;
    const bd = L.barrierDistance;
    const group = new THREE.Group();
    group.name = 'lakePitPavilions';
    this.root.add(group);

    const foundationMat = new THREE.MeshLambertMaterial({ color: 0x4a5246 });
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe6e1d6 });
    const timberMat = new THREE.MeshLambertMaterial({ color: 0x4e342e });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x2e4c38, flatShading: true });

    const pavGeoFoundation = new THREE.BoxGeometry(15.0, 12.0, 7.5);
    pavGeoFoundation.translate(0, -6.0, 0);
    const pavGeoBody = new THREE.BoxGeometry(14, 3.8, 6.5);
    pavGeoBody.translate(0, 1.9, 0);
    const pavGeoRoof = new THREE.BoxGeometry(15.4, 0.55, 8.2);
    pavGeoRoof.translate(0, 4.05, 0);

    const sampleRatios = [0.02, 0.06, 0.84];
    for (const ratio of sampleRatios) {
      const idx = Math.floor(L.count * ratio) % L.count;
      const p = L.points[idx], r = L.rights[idx], t = L.tangents[idx];
      const side = 1;
      const dist = bd + 7.2;
      const px = p.x + r.x * side * dist;
      const pz = p.z + r.z * side * dist;
      if (L.distanceToCenterline(px, pz) < bd + 5.8) continue;

      const py = this.getTerrainHeight(px, pz);
      const pav = new THREE.Group();
      pav.position.set(px, py, pz);
      pav.rotation.y = Math.atan2(t.x, t.z);
      pav.add(new THREE.Mesh(pavGeoFoundation, foundationMat));
      pav.add(new THREE.Mesh(pavGeoBody, wallMat));
      pav.add(new THREE.Mesh(pavGeoRoof, roofMat));

      const beam = new THREE.Mesh(new THREE.BoxGeometry(14.4, 0.35, 0.35), timberMat);
      beam.position.set(0, 3.6, -3.25 * side);
      pav.add(beam);
      group.add(pav);
    }
  }

  /**
   * Indique si une coordonnée `(x, z)` se trouve dans l'emprise centrale du Circuit 5 (`grotto`)
   * (tunnel rocheux, massif central, viaduc ou rivière du canyon) pour éviter tout conflit de placement générique.
   */
  _isGrottoExcludedZone(x, z) {
    if (this.layout.circuitId !== 'grotto') return false;
    // Couloir du tunnel rocheux + massif central + viaduc (échelle 1.5x : x de -78 à +78, z de -170 à +205)
    if (Math.abs(x) < 78 && z >= -170 && z <= 205) return true;
    // Lit de la rivière animée dans le canyon (autour de z = 132, x de -365 à +435)
    if (z >= 94 && z <= 174 && x >= -365 && x <= 435) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Circuit 5 : « Le Col de la Grotte » (Mountain Pass & Under-tunnel) */
  /* ------------------------------------------------------------------ */

  _buildGrottoScenery() {
    this._buildGrottoTunnelAndMountain();
    this._buildGrottoViaductAndRiver();
    this._buildGrottoSafetyBarriers();
    this._buildGrottoLifeAndBuildings();
    this._buildGrottoAlpineVegetation();
  }

  /**
   * 1. La Grande Montagne Centrale & Le Long Tunnel Rocheux (x = 0, z de -100 à +26, Y = 0.5m) :
   *  - Portails Nord (z = -100) et Sud (z = +26) avec arches en pierre/béton naturel
   *  - Voûte intérieure sombre en roche taillée (totalement dégagée sur 126 m)
   *  - Éclairage intérieur artificiel : guirlandes LED orange/jaunes émettrices et spots lumineux
   *  - Effet visuel de brume lumineuse à l'intérieur du tunnel
   *  - Massif rocheux central multi-échelles surplombant le tunnel et portant la Piste Supérieure (Y = 35.5m)
   *    avec roche grise, mousse alpine et sommets enneigés.
   */
  _buildGrottoTunnelAndMountain() {
    const group = new THREE.Group();
    group.name = 'grottoTunnelAndMountain';
    this.root.add(group);

    const zStart = -152;
    const zEnd = 33;
    const tunnelLen = zEnd - zStart; // 185 m
    const zMid = (zStart + zEnd) * 0.5; // -59.5 m
    const tunnelFloorY = 0.5;
    const tunnelRadius = 12.8;

    const darkRockMat = new THREE.MeshLambertMaterial({
      color: 0x22272e,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const stonePortalMat = new THREE.MeshLambertMaterial({ color: 0x6c737d, flatShading: true });
    const concreteMat = new THREE.MeshLambertMaterial({ color: 0x8b929a });
    const ledOrangeMat = new THREE.MeshBasicMaterial({ color: 0xff9800 });
    const ledYellowMat = new THREE.MeshBasicMaterial({ color: 0xffea00 });

    // a) Voûte intérieure du tunnel (demi-cylindre supérieur au-dessus de Y = 0.5m, rayon 12.8m)
    const vaultGeo = new THREE.CylinderGeometry(
      tunnelRadius,
      tunnelRadius,
      tunnelLen,
      16,
      8,
      true,
      -Math.PI * 0.5,
      Math.PI
    );
    vaultGeo.rotateX(Math.PI * 0.5);
    // Déformation légère des sommets de la voûte (> 4m de haut) pour un aspect rocheux taillé
    const vPosAttr = vaultGeo.attributes.position;
    const rndVault = seededRandom(505);
    for (let i = 0; i < vPosAttr.count; i++) {
      const vx = vPosAttr.getX(i);
      const vy = vPosAttr.getY(i);
      const vz = vPosAttr.getZ(i);
      if (vy > 2.5 && Math.abs(vz) < tunnelLen * 0.46) {
        const jitter = (rndVault() - 0.5) * 0.65;
        vPosAttr.setX(i, vx + jitter);
        vPosAttr.setY(i, vy + jitter * 0.5);
      }
    }
    vaultGeo.computeVertexNormals();
    const vaultMesh = new THREE.Mesh(vaultGeo, darkRockMat);
    vaultMesh.position.set(0, tunnelFloorY + 0.2, zMid);
    group.add(vaultMesh);

    // Trottoirs / banquettes de sécurité en béton le long des parois intérieures du tunnel
    const curbWallGeo = new THREE.BoxGeometry(1.4, 1.35, tunnelLen);
    for (const side of [-1, 1]) {
      const curbWall = new THREE.Mesh(curbWallGeo, concreteMat);
      curbWall.position.set(side * (this.layout.barrierDistance + 0.55), tunnelFloorY + 0.65, zMid);
      group.add(curbWall);

      // Bande LED continue orange/ambre à mi-hauteur sur chaque paroi
      const stripGeo = new THREE.BoxGeometry(0.14, 0.16, tunnelLen - 2);
      const strip = new THREE.Mesh(stripGeo, ledOrangeMat);
      strip.position.set(side * (this.layout.barrierDistance - 0.12), tunnelFloorY + 2.4, zMid);
      group.add(strip);
    }

    // b) Arches et spots lumineux intérieurs (tous les 9 mètres le long du tunnel)
    const archRibGeo = new THREE.TorusGeometry(tunnelRadius - 0.25, 0.38, 6, 16, Math.PI);
    const spotHousingGeo = new THREE.BoxGeometry(1.6, 0.24, 0.65);
    const spotLensGeo = new THREE.PlaneGeometry(1.4, 0.45);
    spotLensGeo.rotateX(Math.PI * 0.5);
    const hazePlaneGeo = new THREE.PlaneGeometry(18.0, 7.5);
    const hazeMat = new THREE.MeshBasicMaterial({
      color: 0xffb74d,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (let z = zStart + 8; z <= zEnd - 8; z += 11) {
      const rib = new THREE.Mesh(archRibGeo, stonePortalMat);
      rib.position.set(0, tunnelFloorY + 0.2, z);
      group.add(rib);

      // Double rampe de spots LED jaune/orange au plafond de la voûte
      for (const sx of [-3.6, 3.6]) {
        const housing = new THREE.Mesh(spotHousingGeo, stonePortalMat);
        housing.position.set(sx, tunnelFloorY + 11.4, z);
        const lens = new THREE.Mesh(spotLensGeo, ledYellowMat);
        lens.position.set(sx, tunnelFloorY + 11.25, z);
        group.add(housing, lens);
      }

      // Légère brume lumineuse intérieure (halo de résonance sous la roche)
      if (Math.abs(z - zMid) < 72 && ((Math.round(z - zStart) % 22) === 8)) {
        const haze = new THREE.Mesh(hazePlaneGeo, hazeMat);
        haze.position.set(0, tunnelFloorY + 4.2, z);
        group.add(haze);
      }
    }

    // Deux sources lumineuses ponctuelles ambrées à l'intérieur du tunnel
    for (const lz of [zStart + 54, zEnd - 54]) {
      const ptLight = new THREE.PointLight(0xffa726, 2.4, 95, 1.4);
      ptLight.position.set(0, tunnelFloorY + 9.5, lz);
      group.add(ptLight);
    }

    // c) Portails monumentaux d'entrée (Nord z = -100) et de sortie (Sud z = +26) en pierre & béton
    const portalPillarGeo = new THREE.BoxGeometry(5.5, 15.5, 4.5);
    const portalHeaderGeo = new THREE.BoxGeometry(34.0, 5.2, 4.8);
    const portalArchRingGeo = new THREE.TorusGeometry(tunnelRadius + 0.1, 1.15, 7, 18, Math.PI);

    for (const [pz, isEntry] of [[zStart, true], [zEnd, false]]) {
      const portalGrp = new THREE.Group();
      portalGrp.position.set(0, tunnelFloorY, pz);
      group.add(portalGrp);

      const leftPil = new THREE.Mesh(portalPillarGeo, stonePortalMat);
      leftPil.position.set(-(tunnelRadius + 2.2), 7.5, 0);
      const rightPil = new THREE.Mesh(portalPillarGeo, stonePortalMat);
      rightPil.position.set(tunnelRadius + 2.2, 7.5, 0);
      const header = new THREE.Mesh(portalHeaderGeo, concreteMat);
      header.position.set(0, 14.2, 0);
      const archRing = new THREE.Mesh(portalArchRingGeo, concreteMat);
      archRing.position.set(0, 0.2, isEntry ? -1.4 : 1.4);
      portalGrp.add(leftPil, rightPil, header, archRing);

      // Panneau lumineux "TUNNEL DU COL — 185M" au fronton du portail
      const signTex = billboardTexture(
        isEntry ? 'TUNNEL DU COL · 185M' : 'SORTIE TUNNEL · VIADUC',
        '#1b222c',
        '#ffffff',
        '#ff9800'
      );
      const signMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(14.5, 2.2),
        new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide })
      );
      signMesh.position.set(0, 14.2, isEntry ? -2.55 : 2.55);
      if (isEntry) signMesh.rotation.y = Math.PI;
      portalGrp.add(signMesh);
    }

    // d) Grande Structure Rocheuse Centrale (La Montagne sculptée en versants rocheux naturels autour du tunnel)
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x555d66, flatShading: true });
    const darkSlopeMat = new THREE.MeshLambertMaterial({ color: 0x454c54, flatShading: true });
    const mossMat = new THREE.MeshLambertMaterial({ color: 0x41563c, flatShading: true });
    const snowMat = new THREE.MeshLambertMaterial({ color: 0xf0f5fa, flatShading: true });

    // Cœur rocheux trapézoïdal (enveloppant la voûte du tunnel sans l'obstruer, soutenant la crête à Y = 71m)
    const ridgeCoreGeo = new THREE.CylinderGeometry(22, 38, 53.0, 6);
    ridgeCoreGeo.scale(2.5, 1.0, 2.4);
    const ridgeCore = new THREE.Mesh(ridgeCoreGeo, rockMat);
    ridgeCore.position.set(0, 41.0, zMid);
    group.add(ridgeCore);

    // Massifs rocheux latéraux en pente douce de part et d'autre du tunnel (totalement hors de la voûte)
    const sideSlopeGeo = new THREE.CylinderGeometry(14, 24, 31.0, 7);
    sideSlopeGeo.scale(1.05, 1.0, 3.0);
    for (const side of [-1, 1]) {
      const sideCliff = new THREE.Mesh(sideSlopeGeo, darkSlopeMat);
      sideCliff.position.set(side * (tunnelRadius + 27.5), 15.0, zMid);
      group.add(sideCliff);
    }

    // Flancs rocheux Est et Ouest bien ancrés dans la montagne (hauteur x2 : aucun rocher flottant !)
    const flankGeo = new THREE.ConeGeometry(1, 1, 7);
    flankGeo.translate(0, 0.5, 0);
    const flankDefs = [
      [-60, -0.5, -108, 36, 66.5, rockMat],
      [60, -0.5, -108, 36, 66.5, rockMat],
      [-66, -0.5, -57, 39, 67.2, mossMat],
      [66, -0.5, -57, 39, 67.2, mossMat],
      [-60, -0.5, -6, 36, 65.5, rockMat],
      [60, -0.5, -6, 36, 65.5, rockMat],
      [-36, -0.5, -93, 25, 66.0, mossMat],
      [36, -0.5, -93, 25, 66.0, mossMat],
      [-36, -0.5, -21, 25, 65.5, rockMat],
      [36, -0.5, -21, 25, 65.5, rockMat],
      // Grands pics alpins enneigés dans les 4 quadrants hors de la piste supérieure (z = -52.5) et du tunnel (|x| <= 20)
      [-57, 0.0, -114, 33, 108, rockMat],
      [57, 0.0, -114, 33, 112, rockMat],
      [-57, 0.0, 3, 31, 100, rockMat],
      [57, 0.0, 3, 31, 104, rockMat],
    ];
    for (const [fx, fy, fz, rad, h, mat] of flankDefs) {
      const m = new THREE.Mesh(flankGeo, mat);
      m.position.set(fx, fy, fz);
      m.scale.set(rad, h, rad);
      m.rotation.y = (fx + fz) * 0.1;
      group.add(m);

      if (fy + h > 90) {
        const cap = new THREE.Mesh(flankGeo, snowMat);
        cap.position.set(fx, fy + h * 0.62, fz);
        cap.scale.set(rad * 0.42, h * 0.40, rad * 0.42);
        cap.rotation.y = m.rotation.y;
        group.add(cap);
      }
    }

    // Couronne de rochers facettés ancrés dans le socle rocheux (z de -124 à +9, jamais au-dessus des portails)
    const boulderGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rndMtn = seededRandom(808);
    for (let k = 0; k < 42; k++) {
      const bx = (rndMtn() - 0.5) * 134;
      const bz = -118 + rndMtn() * 124;
      if (Math.abs(bx) < 28 && (bz < -110 || bz > -4)) continue;
      const sx = 6.5 + rndMtn() * 8.5;
      const sy = 5.5 + rndMtn() * 7.0;
      const sz = 6.5 + rndMtn() * 8.5;
      const distToUpperRoadZ = Math.abs(bz - (-52.5));
      const maxTopY = distToUpperRoadZ < (this.layout.barrierDistance + sz + 11.0) ? 66.0 : 74.0;
      const by = Math.min(maxTopY - sy, 31.0 + rndMtn() * 28.0);
      const mat = by + sy > 67.6 ? snowMat : (rndMtn() > 0.45 ? rockMat : mossMat);
      const rock = new THREE.Mesh(boulderGeo, mat);
      rock.position.set(bx, by, bz);
      rock.scale.set(sx, sy, sz);
      rock.rotation.set(rndMtn() * 2, rndMtn() * 3, rndMtn() * 2);
      group.add(rock);
    }
  }

  /**
   * 2. Le Pont / Viaduc à Arches (x = 0, z de +48 à +128, culminant à Y = 6.8m)
   *    & La Rivière Animée visible au niveau du canyon (Y = +0.16m) :
   *  - Rivière bleue animée (avec shader GPU de vagues) coulant entre x = -145 et +195, sous le pont à z = 88.
   *  - Tablier et rambardes du Viaduc épousant parfaitement l'arc altimétrique de la piste sans aucune cassure.
   */
  _buildGrottoViaductAndRiver() {
    const group = new THREE.Group();
    group.name = 'grottoViaductAndRiver';
    this.root.add(group);

    const riverCenterZ = 132;

    // a) Lit sablonneux courbe + Rivière bleue animée effilée aux extrémités (échelle 1.5x)
    const makeRiverRibbon = (width, segsX, segsZ) => {
      const geo = new THREE.PlaneGeometry(780, width, segsX, segsZ);
      geo.rotateX(-Math.PI * 0.5);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const rx = pos.getX(i);
        const rz = pos.getZ(i);
        const u = Math.abs(rx) / 390; // 0 au centre -> 1 aux extrémités
        const taper = Math.max(0.06, Math.sqrt(Math.max(0, 1 - u * u * 0.92)));
        pos.setZ(i, rz * taper + Math.sin(rx * 0.012) * 15.0);
      }
      geo.computeVertexNormals();
      return geo;
    };

    const bankBedGeo = makeRiverRibbon(56, 56, 4);
    const bankBedMat = new THREE.MeshLambertMaterial({ color: 0xc2b280 });
    const bankBedMesh = new THREE.Mesh(bankBedGeo, bankBedMat);
    bankBedMesh.position.set(33, 0.01, riverCenterZ);
    group.add(bankBedMesh);

    const waterGeo = makeRiverRibbon(42, 72, 10);
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x0e87d4,
      emissive: 0x053a60,
      emissiveIntensity: 0.22,
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: 0.90,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -4.0,
    });
    riverMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.spectatorUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float wave = sin(transformed.x * 0.11 + uTime * 2.8) * 0.08
                    + cos(transformed.z * 0.20 - uTime * 2.1) * 0.06;
         transformed.y += wave;`
      );
    };
    const riverMesh = new THREE.Mesh(waterGeo, riverMat);
    riverMesh.position.set(33, 0.14, riverCenterZ);
    group.add(riverMesh);

    // b) Le Grand Pont / Viaduc suivant exactement le profil altimétrique de la piste (x = 0, z de +70 à +192)
    const L = this.layout;
    const bridgeDeckWidth = (L.barrierDistance + 1.2) * 2;
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x737a84, flatShading: true });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x2f3742, metalness: 0.68, roughness: 0.36 });

    // Collecte des points de la piste situés sur l'emprise du viaduc (|x| < 10, z entre 70 et 192)
    const bridgeIndices = [];
    for (let i = 0; i < L.count; i++) {
      const p = L.points[i];
      if (Math.abs(p.x) < 10 && p.z >= 70 && p.z <= 192) {
        bridgeIndices.push(i);
      }
    }

    if (bridgeIndices.length >= 2) {
      // Tablier continu sous la chaussée épousant l'arc du pont (p.y - 0.55)
      const deckVerts = [];
      const deckIdx = [];
      const hwDeck = bridgeDeckWidth * 0.5;
      for (let k = 0; k < bridgeIndices.length; k++) {
        const p = L.points[bridgeIndices[k]];
        const r = L.rights[bridgeIndices[k]];
        const yTop = p.y - 0.08;
        const yBot = p.y - 1.25;
        deckVerts.push(
          p.x - r.x * hwDeck, yTop, p.z - r.z * hwDeck,
          p.x + r.x * hwDeck, yTop, p.z + r.z * hwDeck,
          p.x - r.x * hwDeck, yBot, p.z - r.z * hwDeck,
          p.x + r.x * hwDeck, yBot, p.z + r.z * hwDeck
        );
        if (k < bridgeIndices.length - 1) {
          const b = k * 4;
          const n = (k + 1) * 4;
          // Dessous & côtés gauche/droit du tablier
          deckIdx.push(b + 2, b + 3, n + 2, b + 3, n + 3, n + 2);
          deckIdx.push(b, b + 2, n, b + 2, n + 2, n);
          deckIdx.push(b + 1, n + 1, b + 3, b + 3, n + 1, n + 3);
        }
      }
      const deckGeo = new THREE.BufferGeometry();
      deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckVerts, 3));
      deckGeo.setIndex(deckIdx);
      deckGeo.computeVertexNormals();
      group.add(new THREE.Mesh(deckGeo, steelMat));

      // Fermes métalliques supérieures suivant la hauteur du tablier
      const postGeo = new THREE.BoxGeometry(0.42, 4.2, 0.42);
      const xTruss = L.barrierDistance + 0.85;
      const railVerts = [];
      const railIdx = [];
      let rv = 0;
      for (const side of [-1, 1]) {
        for (let k = 0; k < bridgeIndices.length; k++) {
          const idx = bridgeIndices[k];
          const p = L.points[idx];
          const r = L.rights[idx];
          const px = p.x + r.x * side * xTruss;
          const pz = p.z + r.z * side * xTruss;
          const py = p.y + 3.8;
          railVerts.push(px, py - 0.22, pz, px, py + 0.22, pz);
          if (k < bridgeIndices.length - 1) {
            railIdx.push(rv, rv + 1, rv + 2, rv + 1, rv + 3, rv + 2);
          }
          rv += 2;
          if (k % 5 === 0) {
            const post = new THREE.Mesh(postGeo, steelMat);
            post.position.set(px, p.y + 1.9, pz);
            group.add(post);
          }
        }
      }
      const trussBeamGeo = new THREE.BufferGeometry();
      trussBeamGeo.setAttribute('position', new THREE.Float32BufferAttribute(railVerts, 3));
      trussBeamGeo.setIndex(railIdx);
      trussBeamGeo.computeVertexNormals();
      group.add(new THREE.Mesh(trussBeamGeo, new THREE.MeshStandardMaterial({ color: 0x263238, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide })));

      // Piles en pierre encadrant la rivière (aux points z proches de 84, 108, 156, 180)
      for (const targetZ of [84, 108, 156, 180]) {
        let bestP = null;
        let bestDz = 999;
        for (const idx of bridgeIndices) {
          const p = L.points[idx];
          const dz = Math.abs(p.z - targetZ);
          if (dz < bestDz) {
            bestDz = dz;
            bestP = p;
          }
        }
        if (bestP && bestP.y > 1.2) {
          const pierH = bestP.y - 0.3;
          const pier = new THREE.Mesh(new THREE.BoxGeometry(bridgeDeckWidth + 1.6, pierH, 4.8), stoneMat);
          pier.position.set(bestP.x, pierH * 0.5 - 0.2, bestP.z);
          group.add(pier);
        }
      }
    }
  }

  /**
   * 3. Sécurité Renforcée :
   *  - Glissières métalliques doublées sur toute la Piste Supérieure et la crête (Y > 20m)
   *  - Barrières de béton (type Jersey bicolores rouge/blanc et gris) dans les lacets et aux abords du tunnel/pont
   *  - Balises réfléchissantes lumineuses le long du tracé
   */
  _buildGrottoSafetyBarriers() {
    const L = this.layout;
    const n = L.count;
    const bd = L.barrierDistance;
    const group = new THREE.Group();
    group.name = 'grottoSafetyBarriers';
    this.root.add(group);

    // a) Glissières métalliques doublées en haute montagne (Y > 18m : ascension haute + crête sommitale + début descente)
    const upperRailVerts = [];
    const upperRailNorms = [];
    const upperRailIdx = [];
    let vCount = 0;

    for (const side of [-1, 1]) {
      for (const [y0, y1] of [[0.92, 1.22], [1.32, 1.58]]) {
        for (let i = 0; i < n; i++) {
          const iNext = (i + 1) % n;
          const p0 = L.points[i], p1 = L.points[iNext];
          if (p0.y < 36.0 && p1.y < 36.0) continue;

          const r0 = L.rights[i], r1 = L.rights[iNext];
          const x0 = p0.x + r0.x * side * bd, z0 = p0.z + r0.z * side * bd;
          const x1 = p1.x + r1.x * side * bd, z1 = p1.z + r1.z * side * bd;
          const nx = -r0.x * side, nz = -r0.z * side;

          upperRailVerts.push(
            x0, p0.y + y0, z0,
            x0, p0.y + y1, z0,
            x1, p1.y + y0, z1,
            x1, p1.y + y1, z1
          );
          upperRailNorms.push(nx, 0.15, nz, nx, 0.15, nz, nx, 0.15, nz, nx, 0.15, nz);

          const a = vCount, b = vCount + 1, c = vCount + 2, d = vCount + 3;
          if (side > 0) upperRailIdx.push(a, b, c, b, d, c);
          else upperRailIdx.push(a, c, b, b, c, d);
          vCount += 4;
        }
      }
    }

    if (upperRailIdx.length > 0) {
      const upperGeo = new THREE.BufferGeometry();
      upperGeo.setAttribute('position', new THREE.Float32BufferAttribute(upperRailVerts, 3));
      upperGeo.setAttribute('normal', new THREE.Float32BufferAttribute(upperRailNorms, 3));
      upperGeo.setIndex(upperRailIdx);
      const upperMat = new THREE.MeshStandardMaterial({
        color: 0xd0d7e0,
        metalness: 0.80,
        roughness: 0.28,
        side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(upperGeo, upperMat));
    }

    // b) Barrières de béton (Jersey) et balises réfléchissantes (InstancedMesh)
    const jerseyGeo = new THREE.BoxGeometry(0.65, 0.95, 3.2);
    jerseyGeo.translate(0, 0.475, 0);
    const jerseyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

    const bollardGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.15, 6);
    bollardGeo.translate(0, 0.575, 0);
    const bollardMat = new THREE.MeshBasicMaterial({ color: 0xff5722 });

    const jerseyTransforms = [];
    const jerseyColors = [];
    const bollardTransforms = [];
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < n; i += 3) {
      const p = L.points[i], r = L.rights[i], t = L.tangents[i];
      const yaw = Math.atan2(t.x, t.z);
      quat.setFromEuler(new THREE.Euler(0, yaw, 0));

      const isSharpTurn = Math.abs(L.curvature[i]) > 0.006;
      const isBridgeOrTunnelApproach = Math.abs(p.x) < 18 && p.z > -202 && p.z < 218;

      if (isSharpTurn || isBridgeOrTunnelApproach) {
        for (const side of [-1, 1]) {
          pos.set(p.x + r.x * side * (bd - 0.32), p.y, p.z + r.z * side * (bd - 0.32));
          m4.compose(pos, quat, scl);
          jerseyTransforms.push(m4.clone());
          jerseyColors.push(((i / 3) % 2 === 0) ? 0xdde2e8 : (isSharpTurn ? 0xe53935 : 0x9aa2ac));
        }
      }

      if (i % 6 === 0) {
        for (const side of [-1, 1]) {
          pos.set(p.x + r.x * side * (bd - 0.05), p.y + 0.55, p.z + r.z * side * (bd - 0.05));
          m4.compose(pos, quat, scl);
          bollardTransforms.push(m4.clone());
        }
      }
    }

    if (jerseyTransforms.length > 0) {
      const jMesh = new THREE.InstancedMesh(jerseyGeo, jerseyMat, jerseyTransforms.length);
      const col = new THREE.Color();
      for (let i = 0; i < jerseyTransforms.length; i++) {
        jMesh.setMatrixAt(i, jerseyTransforms[i]);
        col.setHex(jerseyColors[i]);
        jMesh.setColorAt(i, col);
      }
      jMesh.instanceMatrix.needsUpdate = true;
      if (jMesh.instanceColor) jMesh.instanceColor.needsUpdate = true;
      group.add(jMesh);
    }

    if (bollardTransforms.length > 0) {
      const bMesh = new THREE.InstancedMesh(bollardGeo, bollardMat, bollardTransforms.length);
      for (let i = 0; i < bollardTransforms.length; i++) {
        bMesh.setMatrixAt(i, bollardTransforms[i]);
      }
      bMesh.instanceMatrix.needsUpdate = true;
      group.add(bMesh);
    }
  }

  /**
   * 4. La Vie, les Bâtiments, Belvédères, Camping-Cars, Tentes, Panneaux & Lampadaires :
   *  - Paddock et Stands de course le long de la Grande Ligne Droite (z = 220, Y = 0)
   *  - Lampadaires lumineux le long de la Grande Ligne Droite
   *  - Petites plates-formes de spectateurs sécurisées (Belvédères) à flanc de montagne
   *  - Cabanes de commissaires de course, tentes et camping-cars de spectateurs
   *  - Panneaux de signalisation ("VIRAGE DANGEREUX", "TUNNEL 126M", flèches réfléchissantes)
   */
  _buildGrottoLifeAndBuildings() {
    const L = this.layout;
    const bd = L.barrierDistance;
    const group = new THREE.Group();
    group.name = 'grottoLifeAndBuildings';
    this.root.add(group);

    // a) Grand complexe Paddock & Stands de course le long de la Grande Ligne Droite (z = 540, côté Sud)
    const pitWallMat = new THREE.MeshLambertMaterial({ color: 0xe8edf2 });
    const pitDarkMat = new THREE.MeshLambertMaterial({ color: 0x26303c });
    const pitGlassMat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.15, metalness: 0.75 });
    const pitAccentMat = new THREE.MeshBasicMaterial({ color: 0xff6d00 });

    const paddockGrp = new THREE.Group();
    paddockGrp.position.set(68, 0, 540 + bd + 9.5);
    group.add(paddockGrp);

    const mainPitBox = new THREE.Mesh(new THREE.BoxGeometry(116, 5.2, 11.0), pitWallMat);
    mainPitBox.position.y = 2.6;
    const upperLounges = new THREE.Mesh(new THREE.BoxGeometry(110, 3.6, 9.2), pitDarkMat);
    upperLounges.position.set(0, 7.0, 0.4);
    const glassStrip = new THREE.Mesh(new THREE.BoxGeometry(108, 2.2, 0.3), pitGlassMat);
    glassStrip.position.set(0, 7.0, -4.1);
    const roofOverhang = new THREE.Mesh(new THREE.BoxGeometry(120, 0.55, 13.5), pitDarkMat);
    roofOverhang.position.set(0, 9.0, -0.5);
    const accentStripe = new THREE.Mesh(new THREE.BoxGeometry(120.2, 0.32, 13.6), pitAccentMat);
    accentStripe.position.set(0, 9.15, -0.5);
    paddockGrp.add(mainPitBox, upperLounges, glassStrip, roofOverhang, accentStripe);

    // Portes de garages des stands (10 boxes) + Tour de contrôle
    const bayDoorGeo = new THREE.BoxGeometry(7.2, 3.6, 0.25);
    for (let b = -4.5; b <= 4.5; b += 1.0) {
      const door = new THREE.Mesh(bayDoorGeo, pitDarkMat);
      door.position.set(b * 10.5, 1.8, -5.45);
      paddockGrp.add(door);
    }
    const towerShaft = new THREE.Mesh(new THREE.BoxGeometry(7.5, 18.0, 7.5), pitDarkMat);
    towerShaft.position.set(-66, 9.0, 0);
    const towerCab = new THREE.Mesh(new THREE.BoxGeometry(10.5, 4.2, 10.5), pitGlassMat);
    towerCab.position.set(-66, 19.5, 0);
    const towerRoof = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.8, 11.8), pitWallMat);
    towerRoof.position.set(-66, 21.8, 0);
    paddockGrp.add(towerShaft, towerCab, towerRoof);

    // b) Poteaux lumineux (lampadaires) le long de la Grande Ligne Droite (x de -315 à +390, z = 540)
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x454d57 });
    const lampBulbMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
    const poleShaftGeo = new THREE.CylinderGeometry(0.14, 0.20, 9.5, 6);
    poleShaftGeo.translate(0, 4.75, 0);
    const poleArmGeo = new THREE.BoxGeometry(0.22, 0.22, 2.8);
    const lampHeadGeo = new THREE.BoxGeometry(0.95, 0.22, 0.55);

    for (let lx = -315; lx <= 390; lx += 36) {
      for (const side of [-1, 1]) {
        const lampGrp = new THREE.Group();
        lampGrp.position.set(lx, 0, 540 + side * (bd + 1.2));
        const shaft = new THREE.Mesh(poleShaftGeo, poleMat);
        const arm = new THREE.Mesh(poleArmGeo, poleMat);
        arm.position.set(0, 9.3, -side * 1.2);
        const bulb = new THREE.Mesh(lampHeadGeo, lampBulbMat);
        bulb.position.set(0, 9.15, -side * 2.3);
        lampGrp.add(shaft, arm, bulb);
        group.add(lampGrp);
      }
    }

    // c) Belvédères sécurisés à flanc de montagne (plates-formes de spectateurs avec vue plongeante)
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x6d4c41 });
    const railMat = new THREE.MeshLambertMaterial({ color: 0xb0bec5 });
    const belvedereRatios = [
      [0.21, 1],  // Épingle 1 en montée
      [0.31, -1], // Épingle 2 panoramique
      [0.44, 1],  // Sommet de la crête rocheuse (Y = 35.5m)
      [0.58, -1], // Grande descente Nord-Ouest
    ];
    const specGeo = mergeGeometries([
      new THREE.BoxGeometry(0.42, 0.58, 0.26).translate(0, 0.29, 0),
      new THREE.BoxGeometry(0.26, 0.26, 0.26).translate(0, 0.74, 0),
    ]);
    const palette = [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0xfb8c00, 0x00acc1];

    for (const [ratio, side] of belvedereRatios) {
      const idx = Math.floor(L.count * ratio) % L.count;
      const p = L.points[idx], r = L.rights[idx];
      const bx = p.x + r.x * side * (bd + 5.2);
      const bz = p.z + r.z * side * (bd + 5.2);
      const by = p.y + 0.35;
      const yaw = Math.atan2(-r.x * side, -r.z * side);

      const belv = new THREE.Group();
      belv.position.set(bx, by, bz);
      belv.rotation.y = yaw;
      group.add(belv);

      // Plate-forme bois + piliers d'ancrage dans la falaise + garde-corps métalliques sécurisés
      const deck = new THREE.Mesh(new THREE.BoxGeometry(11.0, 0.45, 5.2), woodMat);
      const stilts = new THREE.Mesh(new THREE.BoxGeometry(10.2, 12.0, 4.4), new THREE.MeshLambertMaterial({ color: 0x4a5058 }));
      stilts.position.y = -6.2;
      const frontRail = new THREE.Mesh(new THREE.BoxGeometry(11.0, 1.1, 0.14), railMat);
      frontRail.position.set(0, 0.75, 2.5);
      const backRail = new THREE.Mesh(new THREE.BoxGeometry(11.0, 1.1, 0.14), railMat);
      backRail.position.set(0, 0.75, -2.5);
      belv.add(deck, stilts, frontRail, backRail);

      // Spectateurs sur le belvédère encourageant les pilotes
      for (let s = -4.2; s <= 4.2; s += 1.2) {
        const sp = new THREE.Mesh(specGeo, new THREE.MeshLambertMaterial({ color: palette[Math.abs(Math.round(s * 3)) % palette.length] }));
        sp.position.set(s, 0.25, 1.4);
        belv.add(sp);
      }
    }

    // d) Cabanes de commissaires de course, Tentes & Camping-Cars dans les zones herbeuses
    const camperBodyMat = new THREE.MeshLambertMaterial({ color: 0xf5f7fa });
    const camperStripeMat = new THREE.MeshLambertMaterial({ color: 0x1e88e5 });
    const tentColors = [0xff7043, 0x26a69a, 0xffca28, 0x5c6bc0];
    const campSpots = [
      [-352, 0.0, 398, 0.4],
      [-412, 0.0, 428, 0.9],
      [412, 0.0, 465, -0.6],
      [-278, 0.5, -465, 1.2],
      [465, 24.0, 218, -0.4],
    ];

    for (let c = 0; c < campSpots.length; c++) {
      const [cx, , cz, rotY] = campSpots[c];
      if (L.distanceToCenterline(cx, cz) < bd + 6.5) continue;
      const cy = this.getTerrainHeight(cx, cz);

      // Camping-Car (Camper Van 3D)
      const camper = new THREE.Group();
      camper.position.set(cx, cy, cz);
      camper.rotation.y = rotY;
      const vanBox = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 6.4), camperBodyMat);
      vanBox.position.y = 1.5;
      const vanAlcove = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 2.2), camperBodyMat);
      vanAlcove.position.set(0, 2.75, 2.2);
      const vanStripe = new THREE.Mesh(new THREE.BoxGeometry(2.54, 0.35, 6.42), camperStripeMat);
      vanStripe.position.y = 1.4;
      const vanWindshield = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.85, 0.2), pitGlassMat);
      vanWindshield.position.set(0, 1.85, 3.15);
      const awning = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.10, 4.4), new THREE.MeshLambertMaterial({ color: tentColors[c % tentColors.length] }));
      awning.position.set(2.1, 2.55, -0.2);
      camper.add(vanBox, vanAlcove, vanStripe, vanWindshield, awning);
      group.add(camper);

      // Tente dôme à proximité du camping-car
      const tentGeo = new THREE.ConeGeometry(2.2, 1.9, 5);
      tentGeo.translate(0, 0.95, 0);
      const tent = new THREE.Mesh(tentGeo, new THREE.MeshLambertMaterial({ color: tentColors[(c + 1) % tentColors.length], flatShading: true }));
      tent.position.set(cx + 5.5, cy, cz + 2.5);
      group.add(tent);
    }

    // Cabanes de commissaires de course (Marshal Huts) aux points stratégiques
    for (const mRatio of [0.12, 0.38, 0.68, 0.88]) {
      const idx = Math.floor(L.count * mRatio) % L.count;
      const p = L.points[idx], r = L.rights[idx], t = L.tangents[idx];
      const mx = p.x - r.x * (bd + 2.8);
      const mz = p.z - r.z * (bd + 2.8);
      if (this._isGrottoExcludedZone(mx, mz)) continue;
      const hut = new THREE.Group();
      hut.position.set(mx, p.y, mz);
      hut.rotation.y = Math.atan2(t.x, t.z);
      const hutBody = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.5, 2.4), pitWallMat);
      hutBody.position.y = 1.25;
      const hutRoof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.30, 2.8), pitAccentMat);
      hutRoof.position.y = 2.65;
      hut.add(hutBody, hutRoof);
      group.add(hut);
    }

    // e) Panneaux de signalisation "VIRAGE DANGEREUX" et "TUNNEL"
    const warnSigns = [
      [0.14, 1, 'VIRAGE DANGEREUX', '#b71c1c', '#ffffff', '#ffeb3b'],
      [0.24, -1, 'LACETS SERRÉS', '#e65100', '#ffffff', '#ffeb3b'],
      [0.40, 1, 'CRÊTE · +71M', '#0d47a1', '#ffffff', '#00e5ff'],
      [0.69, 1, 'ATTENTION TUNNEL', '#1b222c', '#ffca28', '#ff6d00'],
      [0.83, -1, 'VIADUC DU CANYON', '#1b5e20', '#ffffff', '#ffca28'],
    ];
    const signBoardGeo = new THREE.BoxGeometry(4.6, 1.45, 0.16);
    const signLegGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.4, 5);
    signLegGeo.translate(0, 1.2, 0);

    for (const [ratio, side, label, bg, fg, acc] of warnSigns) {
      const idx = Math.floor(L.count * ratio) % L.count;
      const p = L.points[idx], r = L.rights[idx], t = L.tangents[idx];
      const sx = p.x + r.x * side * (bd + 2.1);
      const sz = p.z + r.z * side * (bd + 2.1);
      const sGrp = new THREE.Group();
      sGrp.position.set(sx, p.y, sz);
      sGrp.rotation.y = Math.atan2(-t.x, -t.z);
      const board = new THREE.Mesh(
        signBoardGeo,
        new THREE.MeshBasicMaterial({ map: billboardTexture(label, bg, fg, acc) })
      );
      board.position.y = 2.2;
      const l1 = new THREE.Mesh(signLegGeo, poleMat); l1.position.x = -1.6;
      const l2 = new THREE.Mesh(signLegGeo, poleMat); l2.position.x = 1.6;
      sGrp.add(board, l1, l2);
      group.add(sGrp);
    }
  }

  /**
   * 5. Forêt Alpine Dense, Touffes d'Herbe & Buissons (Optimisés via THREE.InstancedMesh) :
   *  - Des centaines de sapins alpins et pins répartis sur les flancs de montagne et au bord du tracé
   *  - Touffes d'herbe et buissons éparpillés le long de la piste
   */
  _buildGrottoAlpineVegetation() {
    const L = this.layout;
    const bd = L.barrierDistance;
    const rnd = seededRandom(909);

    const firTransforms = [];
    const firColors = [];
    const grassBushTransforms = [];
    const grassBushColors = [];

    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();

    // Bosquets alpins denses sur les reliefs Est, Ouest et Nord + bordures de piste (échelle 1.5x)
    const alpineZones = [
      [360, 315, 132, 85],
      [570, -68, 138, 90],
      [-420, -345, 142, 95],
      [-352, 202, 126, 80],
      [322, -278, 118, 75],
      [-502, 442, 115, 70],
    ];

    for (const [cx, cz, rad, count] of alpineZones) {
      for (let k = 0; k < count; k++) {
        const ang = rnd() * Math.PI * 2;
        const dist = Math.sqrt(rnd()) * rad;
        const x = cx + Math.cos(ang) * dist;
        const z = cz + Math.sin(ang) * dist;
        if (L.distanceToCenterline(x, z) < bd + 3.2) continue;
        if (this._isGrottoExcludedZone(x, z)) continue;

        const y = this.getTerrainHeight(x, z) - 0.15;
        const s = 0.90 + rnd() * 0.85;
        pos.set(x, y, z);
        quat.setFromEuler(new THREE.Euler(0, rnd() * Math.PI * 2, 0));
        scl.setScalar(s);
        m4.compose(pos, quat, scl);
        firTransforms.push(m4.clone());
        // Sapins plus clairs/enneigés en haute altitude (y > 48m)
        firColors.push(y > 48 ? 0x607d6b : (rnd() > 0.5 ? 0x1e4628 : 0x275432));
      }
    }

    // Touffes d'herbe et buissons alpins tout le long des accotements (hors tunnel et pont)
    for (let i = 0; i < L.count; i += 2) {
      const p = L.points[i], r = L.rights[i];
      for (const side of [-1, 1]) {
        if (rnd() < 0.35) continue;
        const offset = bd + 1.2 + rnd() * 5.5;
        const bx = p.x + r.x * side * offset;
        const bz = p.z + r.z * side * offset;
        if (this._isGrottoExcludedZone(bx, bz)) continue;
        if (L.distanceToCenterline(bx, bz) < bd + 1.0) continue;

        const by = p.y - 0.08;
        const bs = 0.65 + rnd() * 0.90;
        pos.set(bx, by, bz);
        quat.setFromEuler(new THREE.Euler(0, rnd() * Math.PI * 2, 0));
        scl.set(bs * 1.1, bs * 0.75, bs * 1.1);
        m4.compose(pos, quat, scl);
        grassBushTransforms.push(m4.clone());
        grassBushColors.push(rnd() > 0.4 ? 0x3b6e38 : 0x4e7d3e);
      }
    }

    // InstancedMesh des sapins alpins à 3 étages coniques
    if (firTransforms.length > 0) {
      const fTrunk = new THREE.CylinderGeometry(0.20, 0.34, 2.4, 5).translate(0, 1.2, 0);
      const fCone1 = new THREE.ConeGeometry(1.9, 2.8, 5).translate(0, 3.0, 0);
      const fCone2 = new THREE.ConeGeometry(1.45, 2.5, 5).translate(0, 4.5, 0);
      const fCone3 = new THREE.ConeGeometry(0.95, 2.1, 5).translate(0, 5.8, 0);
      const firCrownGeo = mergeGeometries([fCone1, fCone2, fCone3]);

      const trunkMesh = new THREE.InstancedMesh(fTrunk, new THREE.MeshLambertMaterial({ color: 0x4e342e }), firTransforms.length);
      const crownMesh = new THREE.InstancedMesh(firCrownGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), firTransforms.length);
      const col = new THREE.Color();

      for (let i = 0; i < firTransforms.length; i++) {
        trunkMesh.setMatrixAt(i, firTransforms[i]);
        crownMesh.setMatrixAt(i, firTransforms[i]);
        col.setHex(firColors[i]);
        crownMesh.setColorAt(i, col);
      }
      trunkMesh.instanceMatrix.needsUpdate = true;
      crownMesh.instanceMatrix.needsUpdate = true;
      if (crownMesh.instanceColor) crownMesh.instanceColor.needsUpdate = true;
      this.root.add(trunkMesh, crownMesh);
    }

    // InstancedMesh des buissons et touffes d'herbe
    if (grassBushTransforms.length > 0) {
      const gb1 = new THREE.DodecahedronGeometry(0.82, 0).translate(0, 0.42, 0);
      const gb2 = new THREE.DodecahedronGeometry(0.58, 0).translate(0.45, 0.32, 0.20);
      const gbGeo = mergeGeometries([gb1, gb2]);
      const gbMesh = new THREE.InstancedMesh(gbGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), grassBushTransforms.length);
      const col = new THREE.Color();

      for (let i = 0; i < grassBushTransforms.length; i++) {
        gbMesh.setMatrixAt(i, grassBushTransforms[i]);
        col.setHex(grassBushColors[i]);
        gbMesh.setColorAt(i, col);
      }
      gbMesh.instanceMatrix.needsUpdate = true;
      if (gbMesh.instanceColor) gbMesh.instanceColor.needsUpdate = true;
      this.root.add(gbMesh);
    }
  }

  _buildCurbs() {
    const L = this.layout;
    const n = L.count;
    const hw = L.halfWidth;
    const cw = CONFIG.track.curbWidth;
    const threshold = 0.0042;

    const verts = [];
    const norms = [];
    const uvs = [];
    const indices = [];
    let vCount = 0;

    const addSegment = (i0, i1, side) => {
      const innerOff = side * (hw - 0.25);
      const outerOff = side * (hw + cw);
      const hIn = 0.025, hOut = 0.08;
      for (let s = i0; s <= i1; s++) {
        const idx = (s + n) % n;
        const p = L.points[idx], r = L.rights[idx];
        const v = (s * L.ds) / 2.4;

        const ax = p.x + r.x * innerOff, az = p.z + r.z * innerOff;
        const bx = p.x + r.x * outerOff, bz = p.z + r.z * outerOff;

        verts.push(ax, p.y + hIn, az, bx, p.y + hOut, bz);
        norms.push(0, 1, 0, 0, 1, 0);
        uvs.push(0, v, 1, v);

        if (s < i1) {
          const a = vCount, b = vCount + 1, c = vCount + 2, d = vCount + 3;
          if (side > 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
        vCount += 2;
      }
    };

    for (const side of [-1, 1]) {
      let inRun = false, start = 0;
      for (let i = 0; i < n; i++) {
        const k = L.curvature[i];
        const active = (side * k > threshold) || (side * k < -threshold * 1.9);
        if (active && !inRun) { inRun = true; start = i; }
        else if (!active && inRun) {
          if (i - start >= 3) addSegment(start - 1, i, side);
          inRun = false;
        }
      }
      if (inRun && n - start >= 3) addSegment(start - 1, n - 1, side);
    }

    if (indices.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const mat = new THREE.MeshStandardMaterial({
      map: curbTexture(),
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -8.0,
    });
    this.root.add(new THREE.Mesh(geo, mat));
  }

  /* ------------------------------------------------------------------ */
  /*  Glissières de sécurité 3D (visuel + physique spatialement découpée)*/
  /* ------------------------------------------------------------------ */

  _buildBarriers() {
    const L = this.layout;
    const n = L.count;
    const bd = L.barrierDistance;
    const railStep = 2;
    const steps = Math.ceil(n / railStep);
    const railVerts = [];
    const railNorms = [];
    const railIndices = [];
    let vCount = 0;

    for (const side of [-1, 1]) {
      for (const [y0, y1] of [[0.52, 0.82], [0.18, 0.42]]) {
        for (let s = 0; s <= steps; s++) {
          const idx = (s < steps) ? ((s * railStep) % n) : 0;
          const p = L.points[idx], r = L.rights[idx];
          const x = p.x + r.x * side * bd;
          const z = p.z + r.z * side * bd;
          const nx = -r.x * side, nz = -r.z * side;

          railVerts.push(x, p.y + y0, z, x, p.y + y1, z);
          railNorms.push(nx, 0.15, nz, nx, 0.15, nz);

          if (s < steps) {
            const a = vCount, b = vCount + 1, c = vCount + 2, d = vCount + 3;
            if (side > 0) railIndices.push(a, b, c, b, d, c);
            else railIndices.push(a, c, b, b, c, d);
          }
          vCount += 2;
        }
      }
    }

    const railGeo = new THREE.BufferGeometry();
    railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railVerts, 3));
    railGeo.setAttribute('normal', new THREE.Float32BufferAttribute(railNorms, 3));
    railGeo.setIndex(railIndices);

    const railMat = new THREE.MeshStandardMaterial({
      color: 0xc8cfd8,
      metalness: 0.78,
      roughness: 0.32,
      side: THREE.DoubleSide,
    });
    this.root.add(new THREE.Mesh(railGeo, railMat));

    const postStep = 3;
    const postCount = Math.ceil(n / postStep) * 2;
    const postGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12);
    postGeo.translate(0, 0.45, 0);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x6b727c });
    const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
    const m4 = new THREE.Matrix4();
    let pIdx = 0;

    for (let i = 0; i < n; i += postStep) {
      const p0 = L.points[i], r0 = L.rights[i];
      for (const side of [-1, 1]) {
        const px = p0.x + r0.x * side * (bd + 0.08);
        const pz = p0.z + r0.z * side * (bd + 0.08);
        m4.makeTranslation(px, p0.y, pz);
        posts.setMatrixAt(pIdx++, m4);
      }
    }
    posts.count = pIdx;
    posts.instanceMatrix.needsUpdate = true;
    this.root.add(posts);

    // Colliders physiques découpés en chunks spatiaux de 8 segments (physStep = 4)
    // pour que SAPBroadphase élague 98% des boîtes de barrières à chaque sous-pas physique et raycast IA !
    const physStep = 2;
    const chunkSteps = 16;
    const halfThick = CONFIG.track.barrierThickness * 0.5;
    const halfHeight = CONFIG.track.barrierHeight * 0.5;
    const q = new CANNON.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const threeQuat = new THREE.Quaternion();

    for (let chunkStart = 0; chunkStart < n; chunkStart += physStep * chunkSteps) {
      const chunkEnd = Math.min(n, chunkStart + physStep * chunkSteps);
      const midIdx = Math.min(n - 1, chunkStart + Math.floor((chunkEnd - chunkStart) * 0.5));
      const pMid = L.points[midIdx];
      const ox = pMid.x, oy = pMid.y, oz = pMid.z;

      const chunkBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(ox, oy, oz),
        material: this.materials.barrierMat,
        collisionFilterGroup: 2,
        collisionFilterMask: 1,
      });

      for (let i = chunkStart; i < chunkEnd; i += physStep) {
        const iNext = (i + physStep) % n;
        const p0 = L.points[i], p1 = L.points[iNext];
        const r0 = L.rights[i], r1 = L.rights[iNext];

        for (const side of [-1, 1]) {
          const off = side * (bd + halfThick + 0.04);
          const ax = p0.x + r0.x * off, az = p0.z + r0.z * off;
          const bx = p1.x + r1.x * off, bz = p1.z + r1.z * off;
          const cx = (ax + bx) * 0.5 - ox;
          const cy = (p0.y + p1.y) * 0.5 + halfHeight - oy;
          const cz = (az + bz) * 0.5 - oz;
          const horizLen = Math.hypot(bx - ax, bz - az) || 1;
          const dy = p1.y - p0.y;
          const segLen = Math.hypot(horizLen, dy) * 0.56;
          const yaw = Math.atan2(bx - ax, bz - az);
          const pitch = -Math.atan2(dy, horizLen);

          euler.set(pitch, yaw, 0, 'YXZ');
          threeQuat.setFromEuler(euler);
          q.set(threeQuat.x, threeQuat.y, threeQuat.z, threeQuat.w);

          const boxShape = new CANNON.Box(new CANNON.Vec3(halfThick + 0.12, halfHeight + 1.4, segLen));
          chunkBody.addShape(boxShape, new CANNON.Vec3(cx, cy - 0.35, cz), q);
        }
      }

      chunkBody.updateBoundingRadius();
      this.world.addBody(chunkBody);
      this.physicsBodies.push(chunkBody);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Ligne de départ / arrivée, grille et portique à feux               */
  /* ------------------------------------------------------------------ */

  _buildStartFinish() {
    const L = this.layout;
    const p0 = L.points[0], t0 = L.tangents[0];
    const yaw = Math.atan2(t0.x, t0.z);
    const hw = L.halfWidth;

    const group = new THREE.Group();
    group.position.set(p0.x, p0.y, p0.z);
    group.rotation.y = yaw;
    this.root.add(group);

    const lineGeo = new THREE.PlaneGeometry(hw * 2 - 0.4, 2.2);
    lineGeo.rotateX(-Math.PI / 2);
    const lineMat = new THREE.MeshBasicMaterial({ map: checkerTexture(), polygonOffset: true, polygonOffsetFactor: -2.0, polygonOffsetUnits: -8.0 });
    const lineMesh = new THREE.Mesh(lineGeo, lineMat);
    lineMesh.position.y = 0.03;
    group.add(lineMesh);

    const slotMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee, polygonOffset: true, polygonOffsetFactor: -2.0, polygonOffsetUnits: -8.0 });
    const slotGeo = new THREE.PlaneGeometry(2.2, 0.35);
    slotGeo.rotateX(-Math.PI / 2);
    for (let k = 0; k < 15; k++) {
      const pos = this.getStartTransform(k);
      const marker = new THREE.Mesh(slotGeo, slotMat);
      marker.position.set(pos.position.x, pos.position.y - 0.52, pos.position.z);
      marker.rotation.y = Math.atan2(pos.forward.x, pos.forward.z);
      marker.position.addScaledVector(pos.forward, 1.9);
      this.root.add(marker);
    }

    const span = hw * 2 + 3.2;
    const pillarGeo = new THREE.BoxGeometry(0.55, 6.8, 0.55);
    pillarGeo.translate(0, 3.4, 0);
    const beamGeo = new THREE.BoxGeometry(span + 0.6, 0.6, 0.7);
    beamGeo.translate(0, 6.5, 0);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x22262c, metalness: 0.7, roughness: 0.35 });

    const leftPillar = new THREE.Mesh(pillarGeo, frameMat);
    leftPillar.position.x = -span * 0.5;
    const rightPillar = new THREE.Mesh(pillarGeo, frameMat);
    rightPillar.position.x = span * 0.5;
    const beam = new THREE.Mesh(beamGeo, frameMat);
    group.add(leftPillar, rightPillar, beam);

    const bannerGeo = new THREE.PlaneGeometry(span - 0.8, 1.25);
    const bannerMat = new THREE.MeshBasicMaterial({ map: gantryTexture() });
    const bannerFront = new THREE.Mesh(bannerGeo, bannerMat);
    bannerFront.position.set(0, 5.75, -0.38);
    bannerFront.rotation.y = Math.PI;
    const bannerBack = new THREE.Mesh(bannerGeo, bannerMat);
    bannerBack.position.set(0, 5.75, 0.38);
    group.add(bannerFront, bannerBack);

    const podGeo = new THREE.BoxGeometry(0.55, 0.95, 0.3);
    const lensGeo = new THREE.CircleGeometry(0.18, 12);
    this.startLightMeshes = [];
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 0.85;
      const pod = new THREE.Mesh(podGeo, frameMat);
      pod.position.set(x, 4.65, -0.35);
      group.add(pod);

      const mat = new THREE.MeshBasicMaterial({ color: 0x220808 });
      const lens1 = new THREE.Mesh(lensGeo, mat);
      lens1.position.set(x, 4.84, -0.52);
      lens1.rotation.y = Math.PI;
      const lens2 = new THREE.Mesh(lensGeo, mat);
      lens2.position.set(x, 4.46, -0.52);
      lens2.rotation.y = Math.PI;
      group.add(lens1, lens2);
      this.startLightMeshes.push(mat);
    }
  }

  setStartLights(state) {
    for (let i = 0; i < this.startLightMeshes.length; i++) {
      const m = this.startLightMeshes[i];
      if (state === 'go') m.color.setHex(0x00ff55);
      else if (typeof state === 'number' && i < state) m.color.setHex(0xff1e1e);
      else m.color.setHex(0x240808);
    }
  }

  getStartTransform(slotIndex) {
    const L = this.layout;
    const side = slotIndex % 2 === 0 ? -1 : 1;
    const s = wrap(-8.5 - slotIndex * 5.2, L.length);
    const lateral = side * 2.85;
    const sample = L.sample(s, lateral);
    return {
      position: new THREE.Vector3(sample.position.x, sample.position.y + 0.55, sample.position.z),
      forward: sample.tangent.clone(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Panneaux de signalisation et panneaux publicitaires                */
  /* ------------------------------------------------------------------ */

  _buildSignsAndBillboards() {
    const L = this.layout;
    const n = L.count;
    const bd = L.barrierDistance;
    const postMat = new THREE.MeshLambertMaterial({ color: 0x555b64 });

    const chevronGeo = new THREE.PlaneGeometry(2.6, 1.3);
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5);
    postGeo.translate(0, 1.1, 0);
    const matLeft = new THREE.MeshBasicMaterial({ map: chevronTexture(-1), side: THREE.DoubleSide });
    const matRight = new THREE.MeshBasicMaterial({ map: chevronTexture(1), side: THREE.DoubleSide });

    let lastChevron = -20;
    for (let i = 10; i < n - 10; i += 8) {
      const k = L.curvature[i];
      if (Math.abs(k) < 0.013 || i - lastChevron < 14) continue;
      lastChevron = i;
      const outSide = k > 0 ? -1 : 1;
      const p = L.points[i], r = L.rights[i], t = L.tangents[i];
      const x = p.x + r.x * outSide * (bd + 1.2);
      const z = p.z + r.z * outSide * (bd + 1.2);

      const sign = new THREE.Mesh(chevronGeo, k > 0 ? matRight : matLeft);
      sign.position.set(x, p.y + 1.85, z);
      sign.rotation.y = Math.atan2(-t.x, -t.z) + outSide * 0.25;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, p.y, z);
      this.root.add(sign, post);
    }

    const distGeo = new THREE.PlaneGeometry(1.1, 1.1);
    const brakingZones = [115, 255, 515];
    for (const cornerIdx of brakingZones) {
      const cIdx = cornerIdx % n;
      const kSign = L.curvature[cIdx] >= 0 ? -1 : 1;
      for (const distMeters of [150, 100, 50]) {
        const idx = (cIdx - Math.round(distMeters / L.ds) + n) % n;
        const p = L.points[idx], r = L.rights[idx], t = L.tangents[idx];
        const x = p.x + r.x * kSign * (bd + 1.0);
        const z = p.z + r.z * kSign * (bd + 1.0);
        const board = new THREE.Mesh(
          distGeo,
          new THREE.MeshBasicMaterial({ map: distanceBoardTexture(distMeters), side: THREE.DoubleSide })
        );
        board.position.set(x, p.y + 1.6, z);
        board.rotation.y = Math.atan2(-t.x, -t.z);
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(x, p.y, z);
        this.root.add(board, post);
      }
    }

    const sponsors = [
      ['APEX GT', '#0d47a1', '#ffffff', '#ffca28'],
      ['NITRO X', '#b71c1c', '#ffffff', '#ffd54f'],
      ['ALPINE V8', '#1b5e20', '#ffffff', '#a5d6a7'],
      ['CHRONO PRO', '#212121', '#ffca28', '#e53935'],
      ['AERO FORCE', '#4a148c', '#ffffff', '#00e5ff'],
    ];
    const bbGeo = new THREE.BoxGeometry(9.0, 2.3, 0.25);
    const legGeo = new THREE.CylinderGeometry(0.14, 0.14, 3.6, 6);
    legGeo.translate(0, 1.8, 0);

    const bbIndices = [70, 210, 390, 580, 740, 900];
    bbIndices.forEach((idx, k) => {
      const i = idx % n;
      const side = k % 2 === 0 ? 1 : -1;
      const p = L.points[i], r = L.rights[i], t = L.tangents[i];
      let sideNow = side;
      let x = p.x + r.x * sideNow * (bd + 5.5);
      let z = p.z + r.z * sideNow * (bd + 5.5);
      if (L.distanceToCenterline(x, z) < bd + 3.8) {
        sideNow = -sideNow;
        x = p.x + r.x * sideNow * (bd + 5.5);
        z = p.z + r.z * sideNow * (bd + 5.5);
        if (L.distanceToCenterline(x, z) < bd + 3.8) return;
      }
      if (this._isGrottoExcludedZone(x, z)) return;
      const [text, bg, fg, acc] = sponsors[k % sponsors.length];

      const group = new THREE.Group();
      group.position.set(x, this.getTerrainHeight(x, z), z);
      group.rotation.y = Math.atan2(-t.x, -t.z) - side * 0.35;

      const board = new THREE.Mesh(bbGeo, new THREE.MeshBasicMaterial({ map: billboardTexture(text, bg, fg, acc) }));
      board.position.y = 3.2;
      const l1 = new THREE.Mesh(legGeo, postMat); l1.position.x = -3.2;
      const l2 = new THREE.Mesh(legGeo, postMat); l2.position.x = 3.2;
      group.add(board, l1, l2);
      this.root.add(group);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Tribunes et groupes de spectateurs au bord de l'accotement plat    */
  /* ------------------------------------------------------------------ */

  _buildGrandstandsAndCornerCrowds() {
    const L = this.layout;
    const bd = L.barrierDistance;
    const rnd = seededRandom(42);

    const placements = L.circuitId === 'lake'
      ? [
          [Math.floor(L.count * 0.95), -1, 2],
          [Math.floor(L.count * 0.89), 1, 1],
          [Math.floor(L.count * 0.16), 1, 1],
        ]
      : L.circuitId === 'grotto'
        ? [
            [15, -1, 2],
            [55, -1, 1],
            [Math.floor(L.count * 0.65), -1, 1],
          ]
        : [
            [18, -1, 2],
            [Math.floor(L.count * 0.96), 1, 2],
            [Math.floor(L.count * 0.14), -1, 1],
            [Math.floor(L.count * 0.49), -1, 1],
          ];

    this.grandstandBoxes = [];
    const spectatorTransforms = [];
    const tiers = 5;
    const blockLen = 28;

    const stepParts = [];
    for (let s = 0; s < tiers; s++) {
      const g = new THREE.BoxGeometry(blockLen, 0.9, 1.5);
      g.translate(0, 0.45 + s * 0.85, s * 1.45);
      stepParts.push(g);
    }
    const plinth = new THREE.BoxGeometry(blockLen + 0.6, 14.0, tiers * 1.5 + 2.0);
    plinth.translate(0, -7.0, (tiers * 1.45) * 0.45);
    const backWall = new THREE.BoxGeometry(blockLen, tiers * 0.85 + 2.8, 0.4);
    backWall.translate(0, (tiers * 0.85 + 2.8) * 0.5, tiers * 1.45 + 0.5);
    const roof = new THREE.BoxGeometry(blockLen + 1, 0.35, tiers * 1.5 + 2.2);
    roof.rotateX(0.12);
    roof.translate(0, tiers * 0.85 + 2.9, (tiers * 1.45) * 0.45);
    stepParts.push(plinth, backWall, roof);
    const standGeo = mergeGeometries(stepParts);
    const standMat = new THREE.MeshLambertMaterial({ color: 0x383f49 });

    const m4 = new THREE.Matrix4();
    const qRot = new THREE.Quaternion();
    const vPos = new THREE.Vector3();
    const vScale = new THREE.Vector3(1, 1, 1);

    for (const [idx, side, blocks] of placements) {
      for (let b = 0; b < blocks; b++) {
        const i = (idx + b * 16) % L.count;
        const p = L.points[i], r = L.rights[i];
        const dist = bd + 8.0;
        const gx = p.x + r.x * side * dist;
        const gz = p.z + r.z * side * dist;
        if (L.distanceToCenterline(gx, gz) < bd + 6.0) continue;
        if (this._isGrottoExcludedZone(gx, gz)) continue;
        if (L.circuitId === 'lake' && (((gx - 71) * (gx - 71)) / (155 * 155) + ((gz + 365) * (gz + 365)) / (90 * 90) < 1.0)) continue;
        const gy = this.getTerrainHeight(gx, gz);
        const lookDirX = -r.x * side, lookDirZ = -r.z * side;
        const yaw = Math.atan2(-lookDirX, -lookDirZ);

        const stand = new THREE.Mesh(standGeo, standMat);
        stand.position.set(gx, gy, gz);
        stand.rotation.y = yaw;
        this.root.add(stand);

        this.grandstandBoxes.push({ x: gx, z: gz, radius: blockLen * 0.65 });

        qRot.setFromEuler(new THREE.Euler(0, yaw + Math.PI, 0));
        for (let s = 0; s < tiers; s++) {
          for (let col = -blockLen * 0.44; col <= blockLen * 0.44; col += 1.35) {
            if (rnd() < 0.22) continue;
            const localX = col + (rnd() - 0.5) * 0.25;
            const localY = 0.9 + s * 0.85;
            const localZ = s * 1.45 - 0.15;

            vPos.set(localX, localY, localZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            vPos.x += gx; vPos.y += gy; vPos.z += gz;
            m4.compose(vPos, qRot, vScale);
            spectatorTransforms.push(m4.clone());
          }
        }
      }
    }

    // Groupes de spectateurs placés au plus près de la piste sur l'accotement plat (particulièrement dans les points bas / creux)
    const cornerZones = [0.06, 0.12, 0.22, 0.34, 0.48, 0.62, 0.72, 0.78, 0.88, 0.93];
    for (const ratio of cornerZones) {
      const i = Math.floor(L.count * ratio) % L.count;
      const p = L.points[i], r = L.rights[i];
      const isLowHollow = p.y <= 15.0;
      const sides = isLowHollow ? [-1, 1] : [L.curvature[i] >= 0 ? -1 : 1];

      for (const side of sides) {
        const cx = p.x + r.x * side * (bd + 2.4);
        const cz = p.z + r.z * side * (bd + 2.4);
        if (this._isGrottoExcludedZone(cx, cz)) continue;
        if (L.circuitId === 'lake' && (((cx - 71) * (cx - 71)) / (152 * 152) + ((cz + 365) * (cz + 365)) / (88 * 88) < 1.0)) continue;
        const yaw = Math.atan2(r.x * side, r.z * side);
        qRot.setFromEuler(new THREE.Euler(0, yaw + Math.PI, 0));

        const groupSize = isLowHollow ? 18 : 14;
        for (let k = 0; k < groupSize; k++) {
          const along = (k - groupSize * 0.5) * 0.9;
          const depth = (k % 3) * 0.8;
          vPos.set(along, 0, depth).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          vPos.x += cx; vPos.z += cz;
          if (L.distanceToCenterline(vPos.x, vPos.z) < bd + 1.6) continue;
          vPos.y = this.getTerrainHeight(vPos.x, vPos.z);
          m4.compose(vPos, qRot, vScale);
          spectatorTransforms.push(m4.clone());
        }
      }
    }

    const torso = new THREE.BoxGeometry(0.42, 0.58, 0.26);
    torso.translate(0, 0.29, 0);
    const head = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    head.translate(0, 0.74, 0);
    const specGeo = mergeGeometries([torso, head]);

    const specMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    specMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.spectatorUniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float phase = float(gl_InstanceID) * 1.93;
         float jump = max(0.0, sin(uTime * 5.2 + phase));
         transformed.y += jump * 0.22;
         transformed.x += sin(uTime * 3.1 + phase) * 0.06;`
      );
    };

    const count = spectatorTransforms.length;
    const specMesh = new THREE.InstancedMesh(specGeo, specMat, count);
    const palette = [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0xfb8c00, 0x8e24aa, 0x00acc1, 0xf5f5f5];
    const col = new THREE.Color();

    for (let i = 0; i < count; i++) {
      specMesh.setMatrixAt(i, spectatorTransforms[i]);
      col.setHex(palette[Math.floor(rnd() * palette.length)]);
      specMesh.setColorAt(i, col);
    }
    specMesh.instanceMatrix.needsUpdate = true;
    specMesh.instanceColor.needsUpdate = true;
    this.root.add(specMesh);
    this.spectatorMesh = specMesh;
  }

  /* ------------------------------------------------------------------ */
  /*  Arbres 3D instanciés Low-Poly (-40% instances, regroupés bordure)  */
  /* ------------------------------------------------------------------ */

  _buildTrees() {
    const L = this.layout;
    const b = L.bounds;
    const rnd = seededRandom(101);
    const bd = L.barrierDistance;
    const minTrackDist = bd + 2.6;

    const pineList = [];
    const oakList = [];

    // 1) Rangées d'arbres resserrées le long des bordures de piste (effet couloir de vitesse dans les creux)
    const step = L.circuitId === 'lake' ? 7 : 6;
    for (let i = 0; i < L.count; i += step) {
      const p = L.points[i], r = L.rights[i];
      const isLow = p.y <= 15.0;
      for (const side of [-1, 1]) {
        if (rnd() < (isLow ? 0.25 : 0.42)) continue;
        const dist = isLow ? (bd + 2.8 + rnd() * 6.5) : (bd + 4.5 + rnd() * 10.5);
        const x = p.x + r.x * side * dist;
        const z = p.z + r.z * side * dist;
        if (L.distanceToCenterline(x, z) < minTrackDist) continue;
        if (this._isGrottoExcludedZone(x, z)) continue;
        if (L.circuitId === 'lake' && (((x - 71) * (x - 71)) / (152 * 152) + ((z + 365) * (z + 365)) / (88 * 88) < 1.0)) continue;
        let inStand = false;
        for (const g of this.grandstandBoxes) {
          if (Math.hypot(x - g.x, z - g.z) < g.radius + 5) { inStand = true; break; }
        }
        if (inStand) continue;

        const y = this.getTerrainHeight(x, z) - 0.20;
        const item = { x, y, z, scale: 0.85 + rnd() * 0.65, rot: rnd() * Math.PI * 2 };
        if (rnd() < 0.62) pineList.push(item);
        else oakList.push(item);
      }
    }

    // 2) Nombre total d'arbres réduit de 40% (max 210 au lieu de 380) et sans dispersion lointaine inutile
    const targetMax = L.circuitId === 'lake' ? 180 : 220;
    let attempts = 0;
    while (pineList.length + oakList.length < targetMax && attempts < 1500) {
      attempts++;
      const x = (b.min.x - 45) + rnd() * (b.max.x - b.min.x + 90);
      const z = (b.min.z - 45) + rnd() * (b.max.z - b.min.z + 90);
      const dCenter = L.distanceToCenterline(x, z);
      if (dCenter < minTrackDist + 6 || dCenter > 65) continue;
      if (this._isGrottoExcludedZone(x, z)) continue;
      if (L.circuitId === 'lake' && (((x - 71) * (x - 71)) / (155 * 155) + ((z + 365) * (z + 365)) / (90 * 90) < 1.0)) continue;
      let inStand = false;
      for (const g of this.grandstandBoxes) {
        if (Math.hypot(x - g.x, z - g.z) < g.radius + 6) { inStand = true; break; }
      }
      if (inStand) continue;
      const item = { x, y: this.getTerrainHeight(x, z) - 0.20, z, scale: 0.85 + rnd() * 0.75, rot: rnd() * Math.PI * 2 };
      if (rnd() < 0.58) pineList.push(item);
      else oakList.push(item);
    }

    const totalTrees = Math.max(1, pineList.length + oakList.length);
    // Modèles ultra low-poly : troncs à 5 faces, cônes à 5 faces, dodécaèdres détail 0
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.2, 5);
    trunkGeo.translate(0, 1.1, 0);

    const c1 = new THREE.ConeGeometry(1.75, 2.8, 5); c1.translate(0, 3.1, 0);
    const c2 = new THREE.ConeGeometry(1.35, 2.4, 5); c2.translate(0, 4.5, 0);
    const pineCrownGeo = mergeGeometries([c1, c2]);

    const o1 = new THREE.DodecahedronGeometry(1.85, 0); o1.translate(0, 3.6, 0);
    const o2 = new THREE.DodecahedronGeometry(1.35, 0); o2.translate(0.7, 4.2, 0.4);
    const oakCrownGeo = mergeGeometries([o1, o2]);

    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });
    const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, totalTrees);
    const pineCrowns = new THREE.InstancedMesh(pineCrownGeo, crownMat, Math.max(1, pineList.length));
    const oakCrowns = new THREE.InstancedMesh(oakCrownGeo, crownMat, Math.max(1, oakList.length));

    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();

    let tIdx = 0;
    pineList.forEach((t, i) => {
      pos.set(t.x, t.y, t.z);
      quat.setFromEuler(new THREE.Euler(0, t.rot, 0));
      scl.setScalar(t.scale);
      m4.compose(pos, quat, scl);
      trunks.setMatrixAt(tIdx, m4);
      pineCrowns.setMatrixAt(i, m4);

      col.setHSL(0.29 + (rnd() - 0.5) * 0.04, 0.50, 0.22 + rnd() * 0.10);
      pineCrowns.setColorAt(i, col);
      tIdx++;
    });

    oakList.forEach((t, i) => {
      pos.set(t.x, t.y, t.z);
      quat.setFromEuler(new THREE.Euler(0, t.rot, 0));
      scl.setScalar(t.scale);
      m4.compose(pos, quat, scl);
      trunks.setMatrixAt(tIdx, m4);
      oakCrowns.setMatrixAt(i, m4);

      col.setHSL(0.24 + (rnd() - 0.5) * 0.06, 0.56, 0.28 + rnd() * 0.12);
      oakCrowns.setColorAt(i, col);
      tIdx++;
    });

    trunks.instanceMatrix.needsUpdate = true;
    pineCrowns.instanceMatrix.needsUpdate = true;
    if (pineCrowns.instanceColor) pineCrowns.instanceColor.needsUpdate = true;
    oakCrowns.instanceMatrix.needsUpdate = true;
    if (oakCrowns.instanceColor) oakCrowns.instanceColor.needsUpdate = true;
    this.root.add(trunks, pineCrowns, oakCrowns);
  }

  update(time) {
    this.spectatorUniforms.uTime.value = time;
  }

  dispose() {
    for (const b of this.physicsBodies) this.world.removeBody(b);
    this.physicsBodies.length = 0;
    this.root.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) if (!m.userData.shared) m.dispose();
    });
    this.root.removeFromParent();
  }
}
