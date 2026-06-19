import * as THREE from 'three';

/**
 * 属性に応じた10種類のローポリ・アバターを生成する。
 *
 * 各タイプは「性別・年代・障害の有無」などの組み合わせを表現し、
 * 体格・色・付属物（杖・白杖・車椅子・ベビーカー・リュック）で描き分ける。
 */

// --- 10種類のアバター定義 -------------------------------------------------
export const AVATAR_TYPES = [
  { id: 0, label: '成人男性',        gender: '男性', age: '成人',  disability: 'なし',         color: 0x4a76c9, skin: 0xf0c8a0, scale: 1.0 },
  { id: 1, label: '成人女性',        gender: '女性', age: '成人',  disability: 'なし',         color: 0xc95a8e, skin: 0xf3d0b0, scale: 0.94 },
  { id: 2, label: '高齢男性',        gender: '男性', age: '高齢者', disability: 'なし',         color: 0x6b7280, skin: 0xe8c0a0, scale: 0.92, cane: true },
  { id: 3, label: '高齢女性',        gender: '女性', age: '高齢者', disability: 'なし',         color: 0x9a7aa0, skin: 0xecc8aa, scale: 0.88, cane: true },
  { id: 4, label: '男児',            gender: '男性', age: '子ども', disability: 'なし',         color: 0x35b07b, skin: 0xf0c8a0, scale: 0.62 },
  { id: 5, label: '女児',            gender: '女性', age: '子ども', disability: 'なし',         color: 0xe8a13c, skin: 0xf3d0b0, scale: 0.6 },
  { id: 6, label: '車椅子利用者',    gender: '男性', age: '成人',  disability: '車椅子',       color: 0x2bb6c4, skin: 0xf0c8a0, scale: 0.92, wheelchair: true },
  { id: 7, label: '視覚障害者(白杖)', gender: '女性', age: '成人',  disability: '視覚障害',     color: 0xd4b13a, skin: 0xf3d0b0, scale: 0.95, whiteCane: true },
  { id: 8, label: 'ベビーカー利用',  gender: '女性', age: '成人',  disability: 'なし(乳幼児連れ)', color: 0xe0707a, skin: 0xf3d0b0, scale: 0.95, stroller: true },
  { id: 9, label: '来街者(観光)',    gender: '男性', age: '成人',  disability: 'なし',         color: 0x7c5cff, skin: 0xf0c8a0, scale: 1.0, backpack: true }
];

// 共有マテリアルのキャッシュ（タイプごとに使い回してドローコールを抑える）
const matCache = new Map();
function mat(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  }
  return matCache.get(color);
}

const DARK = 0x2a2f3a;
const METAL = 0x9aa3ad;

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/**
 * 1体のアバター（THREE.Group）を生成する。
 * 戻り値の userData に walk animation 用の四肢ピボットと頭の高さを格納する。
 */
export function createAvatar(typeIndex) {
  const t = AVATAR_TYPES[typeIndex % AVATAR_TYPES.length];
  const g = new THREE.Group();
  g.name = `avatar_${t.label}`;

  const bodyColor = t.color;
  const skin = t.skin;

  // しゃがんだ高さ（子どもは低い）。各パーツの基準。
  const legH = 0.42;
  const torsoH = 0.5;
  const headR = 0.16;

  // --- 脚（歩行アニメ用にピボットを持たせる） ---
  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.09, legH, 0);
  leftLeg.add(box(0.14, legH, 0.16, DARK, 0, -legH / 2, 0));
  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.09, legH, 0);
  rightLeg.add(box(0.14, legH, 0.16, DARK, 0, -legH / 2, 0));

  // --- 胴体 ---
  const torso = box(0.34, torsoH, 0.2, bodyColor, 0, legH + torsoH / 2, 0);

  // --- 腕 ---
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.21, legH + torsoH - 0.04, 0);
  leftArm.add(box(0.08, 0.42, 0.1, bodyColor, 0, -0.2, 0));
  const rightArm = new THREE.Group();
  rightArm.position.set(0.21, legH + torsoH - 0.04, 0);
  rightArm.add(box(0.08, 0.42, 0.1, bodyColor, 0, -0.2, 0));

  // --- 首・頭 ---
  const neckY = legH + torsoH;
  const head = new THREE.Mesh(new THREE.BoxGeometry(headR * 1.7, headR * 1.9, headR * 1.7), mat(skin));
  head.position.set(0, neckY + headR, 0);
  head.castShadow = true;

  // 髪・帽子で性別/年代を少し描き分け
  const hairColor = t.age === '高齢者' ? 0xdddddd : (t.gender === '女性' ? 0x4a3327 : 0x2b2118);
  const hair = box(headR * 1.85, headR * 0.7, headR * 1.85, hairColor, 0, neckY + headR * 1.7, 0);
  if (t.gender === '女性' && t.age !== '高齢者') {
    // 後ろ髪
    hair.add(box(headR * 1.5, headR * 1.3, headR * 0.5, hairColor, 0, -headR * 0.9, -headR * 0.8));
  }

  g.add(leftLeg, rightLeg, torso, leftArm, rightArm, head, hair);

  // --- 付属物（属性表現） ---
  if (t.backpack) {
    g.add(box(0.26, 0.34, 0.14, 0x394150, 0, legH + torsoH / 2 + 0.02, -0.16));
  }
  if (t.cane) {
    const cane = box(0.03, 0.62, 0.03, 0x6b4f2a, 0.27, 0.31, 0.12);
    g.add(cane);
  }
  if (t.whiteCane) {
    const wc = new THREE.Group();
    wc.position.set(0.24, legH + 0.1, 0.18);
    wc.rotation.z = 0.5;
    wc.add(box(0.025, 0.9, 0.025, 0xf5f5f5, 0, 0, 0));
    wc.add(box(0.03, 0.06, 0.03, 0xd03030, 0, -0.43, 0)); // 赤い先端
    g.add(wc);
  }
  if (t.wheelchair) {
    // 座位姿勢に調整
    g.position.y = -0.0;
    torso.position.y = legH * 0.55 + torsoH / 2;
    head.position.y = legH * 0.55 + torsoH + headR;
    hair.position.y = legH * 0.55 + torsoH + headR * 1.7;
    leftArm.position.y = rightArm.position.y = legH * 0.55 + torsoH - 0.04;
    // 脚を前に折りたたむ
    leftLeg.position.set(-0.09, legH * 0.55, 0.12);
    rightLeg.position.set(0.09, legH * 0.55, 0.12);
    leftLeg.rotation.x = rightLeg.rotation.x = -Math.PI / 2.1;

    const chair = new THREE.Group();
    // 車輪
    const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.05, 16);
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, mat(DARK));
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 0.27, 0.28, -0.02);
      w.castShadow = true;
      chair.add(w);
      const wf = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 12), mat(METAL));
      wf.rotation.z = Math.PI / 2;
      wf.position.set(sx * 0.27, 0.1, 0.26);
      chair.add(wf);
    }
    chair.add(box(0.5, 0.05, 0.4, METAL, 0, 0.5, 0.02)); // 座面
    chair.add(box(0.5, 0.45, 0.05, METAL, 0, 0.72, -0.18)); // 背もたれ
    g.add(chair);
  }
  if (t.stroller) {
    const s = new THREE.Group();
    s.position.set(0, 0, 0.45);
    s.add(box(0.4, 0.28, 0.5, 0xdedede, 0, 0.62, 0)); // 幌
    s.add(box(0.4, 0.04, 0.5, 0x556, 0, 0.46, 0));   // 座席底
    const wg = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(wg, mat(DARK));
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 0.18, 0.1, sz * 0.2);
      s.add(w);
    }
    // ハンドル
    s.add(box(0.04, 0.5, 0.04, METAL, -0.18, 0.5, -0.22));
    s.add(box(0.04, 0.5, 0.04, METAL, 0.18, 0.5, -0.22));
    g.add(s);
    // 押している姿勢：腕を前に
    leftArm.rotation.x = rightArm.rotation.x = -1.0;
  }

  // スケール（体格）
  g.scale.setScalar(t.scale);

  // walk animation 用の参照
  g.userData = {
    type: t,
    typeIndex,
    limbs: { leftLeg, rightLeg, leftArm: t.stroller ? null : leftArm, rightArm: t.stroller ? null : rightArm },
    headHeight: (neckY + headR) * t.scale,   // 一人称カメラの目線高さ
    walkPhase: Math.random() * Math.PI * 2,
    animatable: !t.wheelchair                  // 車椅子は脚を振らない
  };

  return g;
}

/**
 * 歩行アニメーション（脚・腕の振り）。speed=移動速度, dt=経過秒。
 */
export function animateAvatar(avatar, speed, dt) {
  const u = avatar.userData;
  if (!u.animatable) return;
  if (speed < 0.05) {
    // 立ち止まり：徐々に直立へ
    for (const k of ['leftLeg', 'rightLeg', 'leftArm', 'rightArm']) {
      const limb = u.limbs[k];
      if (limb) limb.rotation.x *= 0.85;
    }
    return;
  }
  u.walkPhase += dt * (4 + speed * 2.2);
  const swing = Math.sin(u.walkPhase) * Math.min(0.6, 0.25 + speed * 0.25);
  if (u.limbs.leftLeg) u.limbs.leftLeg.rotation.x = swing;
  if (u.limbs.rightLeg) u.limbs.rightLeg.rotation.x = -swing;
  if (u.limbs.leftArm) u.limbs.leftArm.rotation.x = -swing * 0.8;
  if (u.limbs.rightArm) u.limbs.rightArm.rotation.x = swing * 0.8;
}
