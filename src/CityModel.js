import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// three-mesh-bvh による高速レイキャストを有効化
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * 街の3Dモデル（または BIM）の読み込み・正規化・衝突判定情報の構築を担う。
 *
 * - glTF / GLB / PLY / FBX / OBJ のインポートに対応
 * - 読み込んだモデルを適切なスケール・接地に正規化
 * - 衝突メッシュ（建物など）を抽出して BVH を構築
 * - 地面高さの取得、歩行可能領域・目的地(POI)の算出
 */
export class CityModel {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'city';
    scene.add(this.root);

    this.collisionMeshes = [];      // 衝突判定対象（建物など）
    this.collisionHelper = null;    // 衝突メッシュの可視化
    this.bounds = new THREE.Box3(); // モデル全体のAABB
    this.groundY = 0;               // 地面のおおよその高さ
    this.size = 100;                // 街のおおよその一辺
    this.center = new THREE.Vector3();
    this.destinations = [];         // 目的地(POI)候補
    this.lampBulbs = [];            // 街灯の発光マテリアル（点灯/消灯制御用）
    this.lampLights = [];           // 街灯の点光源
    this.lampGroup = null;
    this.addedGround = false;       // 地面が無いモデルに自動追加したか
    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = true;
  }

  clear() {
    for (const m of [...this.root.children]) {
      this.root.remove(m);
      m.traverse?.((o) => {
        if (o.geometry) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); }
      });
    }
    this.collisionMeshes = [];
    if (this.collisionHelper) {
      this.scene.remove(this.collisionHelper);
      this.collisionHelper.children[0]?.material?.dispose(); // 共有マテリアルのみ破棄（geometryは元メッシュと共有）
      this.collisionHelper = null;
    }
    this.destinations = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.lampGroup = null;
    this.addedGround = false;
  }

  /** ファイル(File)からモデルを読み込む */
  async loadFromFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(file);
    try {
      let object;
      if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        object = gltf.scene;
      } else if (ext === 'fbx') {
        object = await new FBXLoader().loadAsync(url);
      } else if (ext === 'ply') {
        const geo = await new PLYLoader().loadAsync(url);
        geo.computeVertexNormals();
        const material = geo.hasAttribute('color')
          ? new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true })
          : new THREE.MeshStandardMaterial({ color: 0xb9c2cc, flatShading: true });
        object = new THREE.Mesh(geo, material);
      } else if (ext === 'obj') {
        object = await new OBJLoader().loadAsync(url);
      } else {
        throw new Error(`未対応の形式です: .${ext}`);
      }
      // FBXは慣習的にcm単位のことが多いためメートルへ換算
      this.setModel(object, file.name, { unitScale: ext === 'fbx' ? 0.01 : 1 });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * 読み込んだ object を街として設定（接地・衝突情報構築）。
   *
   * 人と建物の縮尺を一致させるため、モデルは原則「実寸（メートル）」のまま扱う。
   * （以前は一律160mに正規化していたため人物との縮尺が崩れていた）
   * 単位が極端なモデルのみ、見やすい範囲へ穏やかに補正する。
   */
  setModel(object, name = 'model', opts = {}) {
    this.clear();

    // 単位換算（FBXのcm→m等）
    const unit = opts.unitScale || 1;
    if (unit !== 1) object.scale.multiplyScalar(unit);
    object.updateMatrixWorld(true);

    // 実寸を計測。極端な場合のみ補正（人スケール1.7mを保つため通常は等倍）。
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    let scale = 1;
    if (maxDim > 4000) scale = 2000 / maxDim;       // 巨大すぎ→約2km上限に
    else if (maxDim < 8) scale = 30 / maxDim;        // 小さすぎ→約30mに拡大
    if (scale !== 1) object.scale.multiplyScalar(scale);
    object.updateMatrixWorld(true);

    // 再計測して中心を原点、最下部を y=0 に接地
    const box2 = new THREE.Box3().setFromObject(object);
    const center = box2.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.z -= center.z;
    object.position.y -= box2.min.y;
    object.updateMatrixWorld(true);

    object.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.geometry && !o.geometry.boundsTree) {
          o.geometry.computeBoundsTree();
        }
      }
    });

    this.root.add(object);

    // 地面（床）を持たないモデルなら自動で地面を追加（歩行可能面を保証）
    const tmpBox = new THREE.Box3().setFromObject(this.root);
    const tmpSize = tmpBox.getSize(new THREE.Vector3());
    const sizeGuess = Math.max(tmpSize.x, tmpSize.z) || 1;
    this.addedGround = false;
    if (!this._hasGroundLikeMesh(sizeGuess)) {
      this._addGroundPlane(tmpBox, sizeGuess);
      this.addedGround = true;
    }

    this._finalizeBounds(name);
  }

  /** 広く平らな（地面とみなせる）メッシュが存在するか */
  _hasGroundLikeMesh(size) {
    let found = false;
    this.root.traverse((o) => {
      if (!o.isMesh || found) return;
      const bb = new THREE.Box3().setFromObject(o);
      const s = bb.getSize(new THREE.Vector3());
      if (s.y < size * 0.04 && (s.x > size * 0.3 || s.z > size * 0.3)) found = true;
    });
    return found;
  }

  /** 地面が無いモデル用に床面を追加 */
  _addGroundPlane(box, size) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 1.2, size * 1.2),
      new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 1 })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    plane.receiveShadow = true;
    plane.userData.isAddedGround = true;
    plane.geometry.computeBoundsTree();
    this.root.add(plane);
  }

  /** 街灯を配置（グリッド状。建物内は避ける） */
  _buildStreetLights() {
    this.lampBulbs = [];
    this.lampLights = [];
    const grp = new THREE.Group();
    grp.name = 'streetlights';
    const size = this.size;
    const spacing = clamp(size / 7, 14, 45);
    const half = size * 0.46;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.7, metalness: 0.4 });

    const candidates = [];
    for (let x = -half; x <= half; x += spacing)
      for (let z = -half; z <= half; z += spacing)
        candidates.push([this.center.x + x, this.center.z + z]);

    const maxPosts = 80;
    const lightEvery = Math.max(1, Math.ceil(candidates.length / 22)); // 点光源は最大~22個
    let placed = 0, idx = 0;
    for (const [cx, cz] of candidates) {
      if (placed >= maxPosts) break;
      const p = { x: cx, z: cz };
      if (!this.inBounds(p) || this.isInsideBuilding(new THREE.Vector3(cx, 0, cz))) { idx++; continue; }
      const gy = this.groundHeightAt(cx, cz);
      const lamp = this._makeLampPost(postMat);
      lamp.position.set(cx, gy, cz);
      grp.add(lamp);
      placed++;
      if (idx % lightEvery === 0 && this.lampLights.length < 22) {
        const light = new THREE.PointLight(0xffd28a, 0, spacing * 2.4, 2);
        light.position.set(cx, gy + 3.7, cz);
        grp.add(light);
        this.lampLights.push(light);
      }
      idx++;
    }
    this.lampGroup = grp;
    this.root.add(grp);
  }

  _makeLampPost(postMat) {
    const g = new THREE.Group();
    const h = 4.2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, h, 8), postMat);
    post.position.y = h / 2;
    post.castShadow = true;
    g.add(post);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 8), postMat);
    shade.position.y = h + 0.06;
    g.add(shade);
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0x5e5b4c, emissive: 0xffd98a, emissiveIntensity: 0 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), bulbMat);
    bulb.position.y = h - 0.12;
    g.add(bulb);
    this.lampBulbs.push(bulbMat);
    return g;
  }

  /** 街灯の点灯度合いを更新（night: 0=昼/消灯, 1=夜/全点灯） */
  updateLamps(night) {
    const n = clamp(night, 0, 1);
    for (const m of this.lampBulbs) m.emissiveIntensity = n * 2.4;
    for (const l of this.lampLights) l.intensity = n * 1.8;
  }

  /** サンプルの街（グリッド状の市街地）を生成 */
  generateSampleCity() {
    this.clear();
    const grp = new THREE.Group();

    const blockSize = 18;     // 街区サイズ
    const road = 8;           // 道路幅
    const grid = 5;           // 5x5 街区
    const cell = blockSize + road;
    const extent = grid * cell;
    const half = extent / 2;

    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(extent + 40, extent + 40),
      new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    grp.add(ground);

    // 道路（明るいライン）
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x586072 });
    for (let i = 0; i <= grid; i++) {
      const pos = -half + i * cell - road;
      const hRoad = new THREE.Mesh(new THREE.PlaneGeometry(extent + 40, road), roadMat);
      hRoad.rotation.x = -Math.PI / 2;
      hRoad.position.set(0, 0.02, pos + road / 2);
      grp.add(hRoad);
      const vRoad = new THREE.Mesh(new THREE.PlaneGeometry(road, extent + 40), roadMat);
      vRoad.rotation.x = -Math.PI / 2;
      vRoad.position.set(pos + road / 2, 0.02, 0);
      grp.add(vRoad);
    }

    // 建物
    const palette = [0x8d99ae, 0x9aa7b8, 0xb0bac7, 0x7f8ca0, 0xa7b0bd, 0xc2b8a8];
    const dests = [];
    let rng = mulberry32(20240619);
    for (let gx = 0; gx < grid; gx++) {
      for (let gz = 0; gz < grid; gz++) {
        const cx = -half + gx * cell + blockSize / 2;
        const cz = -half + gz * cell + blockSize / 2;
        // 1街区に1〜4棟
        const n = 1 + Math.floor(rng() * 3);
        for (let b = 0; b < n; b++) {
          const bw = 4 + rng() * (blockSize / 2 - 2);
          const bd = 4 + rng() * (blockSize / 2 - 2);
          const bh = 6 + rng() * 34;
          const ox = (rng() - 0.5) * (blockSize - bw - 1);
          const oz = (rng() - 0.5) * (blockSize - bd - 1);
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(bw, bh, bd),
            new THREE.MeshStandardMaterial({ color: palette[Math.floor(rng() * palette.length)], roughness: 0.85 })
          );
          mesh.position.set(cx + ox, bh / 2, cz + oz);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.geometry.computeBoundsTree();
          grp.add(mesh);
          // 建物の出入口付近を目的地候補に
          dests.push(new THREE.Vector3(
            cx + ox + (rng() - 0.5) * bw,
            0,
            cz + oz + bd / 2 + 1.5
          ));
        }
        // 広場・公園的な目的地も
        if (rng() > 0.6) dests.push(new THREE.Vector3(cx, 0, cz));
      }
    }

    this.root.add(grp);
    this._presetDestinations = dests;
    this._finalizeBounds('サンプルの街（自動生成）');
  }

  /** 衝突メッシュ抽出・境界算出・目的地生成の最終処理 */
  _finalizeBounds(name) {
    this.root.updateMatrixWorld(true);
    this.bounds.setFromObject(this.root);
    this.bounds.getCenter(this.center);
    const size = this.bounds.getSize(new THREE.Vector3());
    this.size = Math.max(size.x, size.z);
    this.groundY = this.bounds.min.y;

    // 衝突メッシュ＝面積の大きい/縦に伸びたメッシュ（=建物・構造物）を採用。
    // ほぼ平らで広いメッシュ（地面）は歩行可能面として扱い、衝突からは除外。
    this.collisionMeshes = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const bb = new THREE.Box3().setFromObject(o);
      const s = bb.getSize(new THREE.Vector3());
      const isGroundLike = s.y < this.size * 0.02 && (s.x > this.size * 0.4 || s.z > this.size * 0.4);
      if (!isGroundLike) this.collisionMeshes.push(o);
    });
    // 万一すべて地面判定になった場合は全メッシュを対象に
    if (this.collisionMeshes.length === 0) {
      this.root.traverse((o) => { if (o.isMesh) this.collisionMeshes.push(o); });
    }

    this._buildDestinations();
    this._buildStreetLights();
    this.modelName = name;
    this.modelStats = {
      meshes: this.collisionMeshes.length,
      size: Math.round(this.size)
    };
  }

  /** 目的地(POI)候補を構築。プリセットがあれば優先、無ければ建物周辺をサンプリング */
  _buildDestinations() {
    this.destinations = [];
    if (this._presetDestinations && this._presetDestinations.length) {
      this.destinations = this._presetDestinations.filter((p) => this.inBounds(p));
      this._presetDestinations = null;
    }
    // 不足分は衝突メッシュ（建物）の周囲をサンプリングして補う
    const need = 40;
    if (this.destinations.length < need && this.collisionMeshes.length) {
      for (let i = 0; this.destinations.length < need && i < 400; i++) {
        const mesh = this.collisionMeshes[i % this.collisionMeshes.length];
        const bb = new THREE.Box3().setFromObject(mesh);
        const c = bb.getCenter(new THREE.Vector3());
        const s = bb.getSize(new THREE.Vector3());
        const ang = Math.random() * Math.PI * 2;
        const r = Math.max(s.x, s.z) * 0.5 + 2 + Math.random() * 3;
        const p = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
        if (this.inBounds(p) && !this.isInsideBuilding(p)) this.destinations.push(p);
      }
    }
    // それでも不足ならグリッド状に配置
    if (this.destinations.length < 8) {
      const r = this.size * 0.4;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        this.destinations.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
    }
  }

  inBounds(p) {
    const m = this.size * 0.5 * 0.98;
    return Math.abs(p.x - this.center.x) < m && Math.abs(p.z - this.center.z) < m;
  }

  /** 指定XZ位置が建物内部か（上方からのレイで建物に当たるか）を判定 */
  isInsideBuilding(p) {
    this._raycaster.set(
      new THREE.Vector3(p.x, this.groundY + 0.4, p.z),
      new THREE.Vector3(0, 1, 0)
    );
    this._raycaster.far = 200;
    const hits = this._raycaster.intersectObjects(this.collisionMeshes, true);
    // 真上に建物の天井がある＝建物内部
    return hits.length > 0 && hits[0].distance < 100;
  }

  /** 指定XZの地面高さを取得（無ければ groundY） */
  groundHeightAt(x, z) {
    this._raycaster.set(new THREE.Vector3(x, this.groundY + 500, z), new THREE.Vector3(0, -1, 0));
    this._raycaster.far = 1000;
    const hits = this._raycaster.intersectObjects(this.root.children, true);
    for (const h of hits) {
      // 建物の屋根ではなく地面を拾いたいので、低い方の交点を採用
      if (h.point.y <= this.groundY + this.size * 0.02 + 0.5) return h.point.y;
    }
    return this.groundY;
  }

  /** ランダムな歩行可能スポーン地点 */
  randomWalkablePoint() {
    const m = this.size * 0.45;
    for (let i = 0; i < 30; i++) {
      const p = new THREE.Vector3(
        this.center.x + (Math.random() - 0.5) * 2 * m,
        0,
        this.center.z + (Math.random() - 0.5) * 2 * m
      );
      if (!this.isInsideBuilding(p)) { p.y = this.groundY; return p; }
    }
    return new THREE.Vector3(this.center.x, this.groundY, this.center.z);
  }

  randomDestination() {
    if (!this.destinations.length) return this.randomWalkablePoint();
    return this.destinations[Math.floor(Math.random() * this.destinations.length)].clone();
  }

  /**
   * 衝突メッシュの可視化トグル。
   * 単純な直方体(AABB)ではなく、実際に衝突判定へ使用しているメッシュ形状そのものを
   * ワイヤフレームで重ねて表示する（=メッシュに忠実）。
   */
  showCollision(show) {
    if (show && !this.collisionHelper) {
      this.collisionHelper = new THREE.Group();
      this.collisionHelper.name = 'collisionHelper';
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff5a5a, wireframe: true, transparent: true, opacity: 0.45
      });
      for (const m of this.collisionMeshes) {
        m.updateWorldMatrix(true, false);
        const wf = new THREE.Mesh(m.geometry, mat); // ジオメトリを共有（破棄しない）
        wf.matrixAutoUpdate = false;
        wf.matrix.copy(m.matrixWorld);              // 元メッシュのワールド変換に一致
        this.collisionHelper.add(wf);
      }
      this.scene.add(this.collisionHelper);
    }
    if (this.collisionHelper) this.collisionHelper.visible = show;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 決定的な擬似乱数（サンプル街の再現性確保）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
