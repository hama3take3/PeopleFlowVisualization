import * as THREE from 'three';
import { createAvatar, animateAvatar, AVATAR_TYPES } from './AvatarFactory.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * 人流（歩行者群）のダミーデータ生成とリアルタイム・シミュレーション。
 *
 * - 1日のスケジュール（出勤・買い物・通学・観光など）に基づいて目的地を移動
 * - 街メッシュとの衝突判定（前方レイ + 進入チェック）で建物を貫通しない
 * - 時刻スライダー / 速度スライダーに連動（速度0で停止、scrubで再配置）
 * - 各歩行者は属性（性別・年代・障害の有無）を保持し、ホバーで表示
 */
export class Crowd {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.agents = [];
    this.proxies = [];                  // ピッキング用の軽量プロキシ
    this.group = new THREE.Group();
    this.group.name = 'crowd';
    scene.add(this.group);

    this.typeVisible = AVATAR_TYPES.map(() => true);
    this.furniture = null;   // FurnitureManager（main側で注入）

    // 経路・目的地の可視化
    this.pathLine = null;
    this.destPoints = null;

    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  dispose() {
    for (const a of this.agents) {
      this.group.remove(a.avatar);
      a.avatar.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.scene.remove(a.proxy);
      a.proxy.geometry.dispose();
    }
    this.agents = [];
    this.proxies = [];
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine = null; }
    if (this.destPoints) { this.scene.remove(this.destPoints); this.destPoints.geometry.dispose(); this.destPoints = null; }
  }

  /** 指定人数のダミー人流を生成 */
  generate(count = 500, simClock = 480) {
    this.dispose();
    this.furniture?.releaseAllSeats();
    const proxyGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.7, 6);
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });

    for (let i = 0; i < count; i++) {
      const typeIndex = pickType();
      const t = AVATAR_TYPES[typeIndex];
      const avatar = createAvatar(typeIndex);

      const baseSpeed = ({ '子ども': 1.05, '高齢者': 0.85, '成人': 1.35 })[t.age] * (t.wheelchair ? 0.85 : 1);

      const home = this.city.randomWalkablePoint();
      const schedule = this._makeSchedule(home);

      // ピッキング用プロキシ（不可視）
      const proxy = new THREE.Mesh(proxyGeo, proxyMat);
      proxy.visible = false;

      const agent = {
        id: i,
        typeIndex,
        avatar,
        proxy,
        baseSpeed,
        pos: home.clone(),
        heading: Math.random() * Math.PI * 2,
        speed: 0,
        schedule,
        target: home.clone(),
        dwelling: false,
        groundTimer: Math.random(),
        manual: null,        // 一人称操作中の手動ベロシティ
        sitState: null,      // null | 'going'（着席へ移動中） | 'sitting'（着席中）
        seat: null,          // 確保した座席
        sitMinsLeft: 0,      // 残り着席時間（sim分）
        seekTimer: 2 + Math.random() * 12,  // 次に着席を試みるまでの秒
        info: {
          typeLabel: t.label,
          gender: t.gender,
          age: t.age,
          ageNum: randomAge(t.age),
          disability: t.disability
        }
      };
      avatar.userData.agent = agent;
      proxy.userData.agent = agent;

      this.group.add(avatar);
      this.scene.add(proxy);
      this.agents.push(agent);
      this.proxies.push(proxy);
    }

    this.reseed(simClock);
    this._applyTypeVisibility();
  }

  /** 1日のスケジュール（移動先と出発時刻の列）を生成 */
  _makeSchedule(home) {
    const D = this.city.randomDestination.bind(this.city);
    const patterns = [
      // 通勤者
      [[home, 0], [D(), 8 * 60 + jit(40)], [D(), 12 * 60 + jit(20)], [D(), 13 * 60 + jit(20)], [home, 18 * 60 + jit(60)]],
      // 買い物客
      [[home, 0], [D(), 10 * 60 + jit(60)], [D(), 13 * 60 + jit(40)], [D(), 15 * 60 + jit(40)], [home, 17 * 60 + jit(60)]],
      // 通学（子ども）
      [[home, 0], [D(), 8 * 60 + jit(15)], [home, 15 * 60 + jit(20)], [D(), 16 * 60 + jit(30)], [home, 18 * 60 + jit(20)]],
      // 観光・来街者
      [[home, 0], [D(), 10 * 60 + jit(40)], [D(), 12 * 60 + jit(40)], [D(), 14 * 60 + jit(40)], [D(), 16 * 60 + jit(40)], [home, 19 * 60 + jit(40)]],
      // 高齢者（散歩・買い物）
      [[home, 0], [D(), 9 * 60 + jit(40)], [D(), 11 * 60 + jit(40)], [home, 13 * 60 + jit(60)]]
    ];
    const p = patterns[Math.floor(Math.random() * patterns.length)];
    return p.map(([pos, depart]) => ({
      pos: pos.clone ? pos.clone() : new THREE.Vector3(pos.x, 0, pos.z),
      depart: Math.max(0, Math.min(1439, depart))
    })).sort((a, b) => a.depart - b.depart);
  }

  _currentIndex(schedule, t) {
    let idx = 0;
    for (let i = 0; i < schedule.length; i++) {
      if (schedule[i].depart <= t) idx = i; else break;
    }
    return idx;
  }

  /** 時刻 t（分）に合わせて各歩行者を再配置（時刻スクラブ時に使用） */
  reseed(t) {
    this.furniture?.releaseAllSeats();
    for (const a of this.agents) {
      // 着席状態をクリア（姿勢も戻す）
      if (a.sitState) {
        const limbs = a.avatar.userData.limbs;
        if (limbs.leftLeg) limbs.leftLeg.rotation.x = 0;
        if (limbs.rightLeg) limbs.rightLeg.rotation.x = 0;
      }
      a.sitState = null;
      a.seat = null;
      a.sitMinsLeft = 0;
      const idx = this._currentIndex(a.schedule, t);
      const place = a.schedule[idx].pos;
      a.pos.copy(place);
      a.pos.x += (Math.random() - 0.5) * 4;
      a.pos.z += (Math.random() - 0.5) * 4;
      // スクラブ時に多発するため接地は概算（groundY）。毎フレーム更新側で補正される。
      a.pos.y = this.city.groundY;
      a.target.copy(place);
      a.dwelling = true;
      a.speed = 0;
      a._idx = idx;
    }
  }

  /**
   * フレーム更新。
   * @param dt 実時間の経過秒
   * @param simClock 現在のシミュレーション時刻（分, 0-1440）
   * @param timeScale 時間の速さ（sim分/実秒）。0で停止。
   */
  update(dt, simClock, timeScale) {
    // 時間の速さに応じて歩行者の見た目の速度をスケール（高速時も破綻しない範囲）
    const speedFactor = timeScale <= 0 ? 0 : clamp(timeScale / 20, 0.25, 6);

    for (const a of this.agents) {
      // 着席中：滞在時間を消費し、座り姿勢のまま固定（移動・スケジュールは凍結）
      if (a.sitState === 'sitting') {
        if (speedFactor > 0) {
          // 観察できるよう実時間ベースで消費（時間の速さで緩やかに加速）
          a.sitMinsLeft -= dt * clamp(timeScale / 60, 0.5, 4);
          if (a.sitMinsLeft <= 0) this._standUp(a, simClock);
        }
        this._sync(a);
        continue;
      }

      // スケジュールに沿って目的地を更新（着席へ向かう間は上書きしない）
      if (a.sitState === null) {
        const idx = this._currentIndex(a.schedule, simClock);
        if (idx !== a._idx) {
          a._idx = idx;
          a.target.copy(a.schedule[idx].pos);
          a.dwelling = false;
        }
        // 時々、近くの空席へ座りに行く
        if (this.furniture && !a.manual && speedFactor > 0) {
          a.seekTimer -= dt;
          if (a.seekTimer <= 0) {
            a.seekTimer = 8 + Math.random() * 18;
            if (Math.random() < 0.5 && this.furniture.hasSeats()) {
              const seat = this.furniture.getFreeSeatNear(a.pos, 28);
              if (seat) {
                seat.occupiedBy = a.id;
                a.seat = seat;
                a.sitState = 'going';
                a.target.set(seat.x, this.city.groundY, seat.z);
              }
            }
          }
        }
      }

      if (speedFactor === 0 && !a.manual) {
        // 停止中：脚を直立に戻すだけ
        animateAvatar(a.avatar, 0, dt);
        this._sync(a);
        continue;
      }

      if (a.manual) {
        this._stepManual(a, dt, speedFactor);
      } else if (a.sitState === 'going') {
        this._stepToSeat(a, dt, speedFactor, simClock);
      } else {
        this._stepAuto(a, dt, speedFactor);
      }

      // 着席を開始した場合は接地・歩行アニメをスキップ（座り姿勢を保持）
      if (a.sitState !== 'sitting') {
        // 接地（負荷分散のため間引いてサンプリング）
        a.groundTimer -= dt;
        if (a.groundTimer <= 0) {
          a.pos.y = this.city.groundHeightAt(a.pos.x, a.pos.z);
          a.groundTimer = 0.4 + Math.random() * 0.4;
        }
        animateAvatar(a.avatar, a.speed, dt);
      }
      this._sync(a);
    }

    if (this.pathLine && this.pathLine.visible) this._updatePathLine();
  }

  /** 自動移動（目的地に向かう + 衝突回避ステアリング） */
  _stepAuto(a, dt, speedFactor) {
    const toTarget = this._tmp.copy(a.target).sub(a.pos);
    toTarget.y = 0;
    const dist = toTarget.length();

    if (dist < 2.5) {
      // 到着：滞在（軽く向きをゆらす）
      a.dwelling = true;
      a.speed *= 0.8;
      a.heading += (Math.random() - 0.5) * 0.4 * dt;
      return;
    }
    a.dwelling = false;
    toTarget.normalize();

    // --- 衝突回避：前方と左右ウィスカーで建物を検出して回避方向を決める ---
    const desired = this._avoid(a, toTarget);

    // 進みたい向きへ滑らかに旋回
    const desiredHeading = Math.atan2(desired.x, desired.z);
    a.heading = lerpAngle(a.heading, desiredHeading, Math.min(1, dt * 6));

    const speed = a.baseSpeed * speedFactor;
    a.speed = speed;
    this._move(a, a.heading, speed * dt);
  }

  /** 座席へ向かう。到着したら着席を開始 */
  _stepToSeat(a, dt, speedFactor, simClock) {
    const toTarget = this._tmp.copy(a.target).sub(a.pos);
    toTarget.y = 0;
    if (toTarget.length() < 1.2) { this._startSitting(a); return; }
    toTarget.normalize();
    const desired = this._avoid(a, toTarget);
    a.heading = lerpAngle(a.heading, Math.atan2(desired.x, desired.z), Math.min(1, dt * 6));
    const speed = a.baseSpeed * speedFactor;
    a.speed = speed;
    this._move(a, a.heading, speed * dt);
  }

  /** 着席開始：座り姿勢へ。ランダムな滞在時間を設定 */
  _startSitting(a) {
    a.sitState = 'sitting';
    a.dwelling = true;
    a.speed = 0;
    a.sitMinsLeft = 8 + Math.random() * 24;  // 滞在の長さ（×60時に約8〜32秒で観察可能）
    a.pos.x = a.seat.x;
    a.pos.z = a.seat.z;
    a.pos.y = a.seat.groundY;
    a.heading = a.seat.facing;
    // 脚を前に曲げて着座姿勢に
    const limbs = a.avatar.userData.limbs;
    if (limbs.leftLeg) limbs.leftLeg.rotation.x = -1.4;
    if (limbs.rightLeg) limbs.rightLeg.rotation.x = -1.4;
  }

  /** 起立：姿勢を戻してスケジュールへ復帰 */
  _standUp(a, simClock) {
    if (a.seat) a.seat.occupiedBy = null;
    a.seat = null;
    a.sitState = null;
    a.sitMinsLeft = 0;
    a.seekTimer = 12 + Math.random() * 20;
    const limbs = a.avatar.userData.limbs;
    if (limbs.leftLeg) limbs.leftLeg.rotation.x = 0;
    if (limbs.rightLeg) limbs.rightLeg.rotation.x = 0;
    a._idx = -1;  // 次フレームでスケジュール目的地を再評価
  }

  /** 指定座席に紐づく歩行者を強制的に起立させる（ファニチャー撤去時） */
  evictFromSeats(seats) {
    const set = new Set(seats);
    for (const a of this.agents) {
      if (a.seat && set.has(a.seat)) {
        a.seat.occupiedBy = null;
        a.seat = null;
        a.sitState = null;
        a.sitMinsLeft = 0;
        a.seekTimer = 4 + Math.random() * 10;
        const limbs = a.avatar.userData.limbs;
        if (limbs.leftLeg) limbs.leftLeg.rotation.x = 0;
        if (limbs.rightLeg) limbs.rightLeg.rotation.x = 0;
        a._idx = -1;
      }
    }
  }

  /** 一人称操作中の手動移動（WASD） */
  _stepManual(a, dt, speedFactor) {
    const m = a.manual;
    const moving = m.forward !== 0 || m.strafe !== 0;
    if (!moving) { a.speed *= 0.6; return; }
    // m.heading はカメラの向き
    const dirX = Math.sin(m.heading) * m.forward + Math.cos(m.heading) * m.strafe;
    const dirZ = Math.cos(m.heading) * m.forward - Math.sin(m.heading) * m.strafe;
    const len = Math.hypot(dirX, dirZ) || 1;
    a.heading = Math.atan2(dirX / len, dirZ / len);
    const speed = a.baseSpeed * Math.max(1.2, speedFactor) * 1.4;
    a.speed = speed;
    this._move(a, a.heading, speed * dt);
  }

  /** 衝突回避ベクトルを返す（前方が塞がっていれば空いている側へ） */
  _avoid(a, dir) {
    const origin = this._tmp2.set(a.pos.x, a.pos.y + 0.9, a.pos.z);
    const lookAhead = 4;
    const meshes = this.city.collisionMeshes;
    if (!meshes.length) return dir;

    const hit = (angle) => {
      const d = new THREE.Vector3(
        Math.sin(Math.atan2(dir.x, dir.z) + angle), 0,
        Math.cos(Math.atan2(dir.x, dir.z) + angle)
      );
      this._ray.set(origin, d);
      this._ray.far = lookAhead;
      const hits = this._ray.intersectObjects(meshes, true);
      return hits.length ? hits[0].distance : Infinity;
    };

    const front = hit(0);
    if (front > lookAhead) return dir;  // 前方クリア

    // 左右を比較して空いている方へ回避
    const left = hit(-0.6);
    const right = hit(0.6);
    const turn = left > right ? -1 : 1;
    const baseAng = Math.atan2(dir.x, dir.z);
    // 近いほど大きく曲がる
    const strength = clamp(1 - front / lookAhead, 0, 1);
    const newAng = baseAng + turn * (0.6 + strength * 0.9);
    return new THREE.Vector3(Math.sin(newAng), 0, Math.cos(newAng));
  }

  /** 進入チェック付き移動：建物にめり込む場合はスライド/停止 */
  _move(a, heading, step) {
    const dx = Math.sin(heading) * step;
    const dz = Math.cos(heading) * step;
    const nx = a.pos.x + dx;
    const nz = a.pos.z + dz;

    // 前方至近に壁があれば前進を止める（最終防壁）
    const origin = this._tmp2.set(a.pos.x, a.pos.y + 0.9, a.pos.z);
    this._ray.set(origin, new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)));
    this._ray.far = step + 0.6;
    const blocked = this.city.collisionMeshes.length &&
      this._ray.intersectObjects(this.city.collisionMeshes, true).length > 0;

    if (blocked) {
      // 横ずれ（スライド）を試みる
      for (const off of [Math.PI / 2, -Math.PI / 2]) {
        const h2 = heading + off;
        this._ray.set(origin, new THREE.Vector3(Math.sin(h2), 0, Math.cos(h2)));
        this._ray.far = step + 0.6;
        if (this.city.collisionMeshes.length &&
          this._ray.intersectObjects(this.city.collisionMeshes, true).length === 0) {
          a.pos.x += Math.sin(h2) * step * 0.6;
          a.pos.z += Math.cos(h2) * step * 0.6;
          return;
        }
      }
      a.speed = 0;
      return;
    }

    // 街の範囲内に収める
    if (this.city.inBounds({ x: nx, z: nz })) {
      a.pos.x = nx;
      a.pos.z = nz;
    } else {
      a.heading += Math.PI; // 端で反転
    }
  }

  /** アバターとプロキシをエージェント状態に同期 */
  _sync(a) {
    a.avatar.position.copy(a.pos);
    a.avatar.rotation.y = a.heading;
    if (a.sitState === 'sitting' && a.seat) {
      // 座面に腰が乗るよう沈み込ませる
      const drop = Math.max(0, a.avatar.userData.hipHeight - a.seat.sitHeight);
      a.avatar.position.y = a.pos.y - drop;
    }
    a.proxy.position.set(a.pos.x, a.pos.y + 0.85, a.pos.z);
  }

  /** 着席中の歩行者を強制起立（一人称操作の開始時など） */
  standAgent(a) {
    if (a.sitState) this._standUp(a, 0);
  }

  /** 一人称カメラ用：頭部のワールド座標 */
  getHeadPosition(a, out = new THREE.Vector3()) {
    return out.set(a.pos.x, a.pos.y + a.avatar.userData.headHeight, a.pos.z);
  }

  // --- 表示系 ----------------------------------------------------------
  setTypeVisible(typeIndex, visible) {
    this.typeVisible[typeIndex] = visible;
    this._applyTypeVisibility();
  }
  _applyTypeVisibility() {
    for (const a of this.agents) {
      const v = this.typeVisible[a.typeIndex];
      a.avatar.visible = v;
      a.proxy.userData.pickable = v;
    }
  }

  setPathsVisible(show) {
    if (show && !this.pathLine) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.agents.length * 6), 3));
      this.pathLine = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.35 }));
      this.pathLine.frustumCulled = false;
      this.scene.add(this.pathLine);
    }
    if (this.pathLine) this.pathLine.visible = show;
  }
  _updatePathLine() {
    const pos = this.pathLine.geometry.attributes.position.array;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const o = i * 6;
      pos[o] = a.pos.x; pos[o + 1] = a.pos.y + 0.3; pos[o + 2] = a.pos.z;
      pos[o + 3] = a.target.x; pos[o + 4] = a.pos.y + 0.3; pos[o + 5] = a.target.z;
    }
    this.pathLine.geometry.attributes.position.needsUpdate = true;
  }

  setDestVisible(show) {
    if (show && !this.destPoints) {
      const pts = this.city.destinations;
      const geo = new THREE.BufferGeometry();
      const arr = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        arr[i * 3] = pts[i].x;
        arr[i * 3 + 1] = this.city.groundHeightAt(pts[i].x, pts[i].z) + 0.5;
        arr[i * 3 + 2] = pts[i].z;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      this.destPoints = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffd166, size: 2.5, sizeAttenuation: true }));
      this.scene.add(this.destPoints);
    }
    if (this.destPoints) this.destPoints.visible = show;
  }
}

// 属性タイプの出現比率（おおよその人口構成を模す）
const TYPE_WEIGHTS = [22, 22, 9, 9, 8, 8, 4, 3, 5, 10];
function pickType() {
  const total = TYPE_WEIGHTS.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < TYPE_WEIGHTS.length; i++) {
    r -= TYPE_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}

function randomAge(band) {
  if (band === '子ども') return 4 + Math.floor(Math.random() * 11);
  if (band === '高齢者') return 65 + Math.floor(Math.random() * 25);
  return 20 + Math.floor(Math.random() * 45);
}

const jit = (m) => Math.round((Math.random() - 0.5) * 2 * m);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
