import * as THREE from 'three';

/**
 * ストリートファニチャー（ベンチ・テーブル・パラソル）の生成と配置管理。
 *
 * - 各ファニチャーは「座席スロット(seat)」を持ち、歩行者が座れる
 * - 地面クリックで配置、右クリックで撤去
 * - 配置時にワールド座標の座席位置・向きを算出して群衆側へ提供する
 */

const WOOD = 0x9c6b3f;
const WOOD_DARK = 0x6e4a2b;
const METAL = 0x8a929c;
const FABRIC = 0xd9534f;
const FABRIC2 = 0xe8b04b;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts });
}
function box(w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function cyl(rt, rb, h, m, x = 0, y = 0, z = 0, seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export const FURNITURE_TYPES = {
  bench: 'ベンチ',
  table: 'テーブル',
  parasol: 'パラソル'
};

// --- 各ファニチャーのジオメトリと座席（ローカル座標）を生成 -----------------
function buildBench() {
  const g = new THREE.Group();
  const w = mat(WOOD), wd = mat(WOOD_DARK);
  g.add(box(1.8, 0.07, 0.46, w, 0, 0.45, 0));        // 座面
  g.add(box(1.8, 0.4, 0.06, w, 0, 0.7, -0.2));        // 背もたれ
  for (const sx of [-0.8, 0.8]) for (const sz of [-0.18, 0.18]) {
    g.add(box(0.07, 0.45, 0.07, wd, sx, 0.225, sz));  // 脚
  }
  // 座席3つ（正面 +z を向く）
  const seats = [-0.55, 0, 0.55].map((lx) => ({ lx, lz: 0.02, lf: 0, h: 0.45 }));
  return { group: g, seats };
}

function buildTable() {
  const g = new THREE.Group();
  const m = mat(METAL, { metalness: 0.3 });
  g.add(cyl(0.5, 0.5, 0.05, m, 0, 0.72, 0, 16));      // 天板
  g.add(cyl(0.04, 0.04, 0.72, m, 0, 0.36, 0));        // 支柱
  g.add(cyl(0.28, 0.28, 0.03, m, 0, 0.02, 0, 16));    // 台座
  const seats = [];
  const stoolM = mat(0x556070);
  for (const [lx, lz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
    g.add(cyl(0.22, 0.22, 0.05, stoolM, lx, 0.45, lz, 12)); // スツール座面
    g.add(cyl(0.03, 0.03, 0.45, stoolM, lx, 0.225, lz));    // スツール脚
    seats.push({ lx, lz, lf: Math.atan2(-lx, -lz), h: 0.45 }); // テーブル中心を向く
  }
  return { group: g, seats };
}

function buildParasol() {
  const g = new THREE.Group();
  const pole = mat(METAL, { metalness: 0.4 });
  g.add(cyl(0.05, 0.06, 2.4, pole, 0, 1.2, 0));        // ポール
  g.add(cyl(0.3, 0.3, 0.06, pole, 0, 0.03, 0, 16));    // 重し台座
  // 傘（8角錐）
  const canopyGeo = new THREE.ConeGeometry(1.7, 0.6, 8);
  const canopy = new THREE.Mesh(canopyGeo, mat(FABRIC, { side: THREE.DoubleSide }));
  canopy.position.y = 2.5;
  canopy.castShadow = true;
  g.add(canopy);
  // 中央の小テーブル
  g.add(cyl(0.4, 0.4, 0.05, mat(METAL), 0, 0.72, 0, 16));
  // 椅子2脚（外向き）
  const seats = [];
  const chairM = mat(FABRIC2);
  for (const lz of [0.7, -0.7]) {
    g.add(cyl(0.22, 0.22, 0.05, chairM, 0, 0.45, lz, 12));
    g.add(cyl(0.03, 0.03, 0.45, chairM, 0, 0.225, lz));
    seats.push({ lx: 0, lz, lf: Math.atan2(0, lz > 0 ? 1 : -1), h: 0.45 });
  }
  return { group: g, seats };
}

const BUILDERS = { bench: buildBench, table: buildTable, parasol: buildParasol };

export class FurnitureManager {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    scene.add(this.group);
    this.items = [];          // 配置済みファニチャー
    this._ray = new THREE.Raycaster();
  }

  /** 地面上の point にファニチャーを配置 */
  place(type, point) {
    const builder = BUILDERS[type];
    if (!builder) return null;
    const { group, seats } = builder();
    const groundY = this.city.groundHeightAt(point.x, point.z);
    const rotY = Math.random() * Math.PI * 2;
    group.position.set(point.x, groundY, point.z);
    group.rotation.y = rotY;

    // 座席のワールド座標・向きを算出
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const worldSeats = seats.map((s) => ({
      x: point.x + (s.lx * cos + s.lz * sin),
      z: point.z + (-s.lx * sin + s.lz * cos),
      groundY,
      facing: s.lf + rotY,
      sitHeight: s.h,
      occupiedBy: null
    }));

    const item = { type, object: group, seats: worldSeats };
    group.userData.furnitureItem = item;
    group.traverse((o) => { o.userData.furnitureItem = item; });
    this.group.add(group);
    this.items.push(item);
    return item;
  }

  /** スクリーン座標下のファニチャーを返す（撤去用） */
  pickAt(clientX, clientY, camera) {
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    this._ray.setFromCamera(ndc, camera);
    const hits = this._ray.intersectObject(this.group, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData.furnitureItem) o = o.parent;
    return o ? o.userData.furnitureItem : null;
  }

  /** ファニチャーを撤去（着席中/向かい中の歩行者は解放） */
  remove(item, crowd) {
    if (!item) return;
    if (crowd) crowd.evictFromSeats(item.seats);
    this.group.remove(item.object);
    item.object.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose?.();
    });
    this.items = this.items.filter((it) => it !== item);
  }

  /** pos の近くにある空席のうち最も近いものを返す */
  getFreeSeatNear(pos, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    for (const item of this.items) {
      for (const seat of item.seats) {
        if (seat.occupiedBy !== null) continue;
        const dx = seat.x - pos.x, dz = seat.z - pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = seat; }
      }
    }
    return best;
  }

  releaseAllSeats() {
    for (const item of this.items) for (const s of item.seats) s.occupiedBy = null;
  }

  /** すべてのファニチャーを撤去（街モデル切り替え時など） */
  clearAll(crowd) {
    for (const item of [...this.items]) this.remove(item, crowd);
  }

  hasSeats() {
    return this.items.some((it) => it.seats.length > 0);
  }
}
