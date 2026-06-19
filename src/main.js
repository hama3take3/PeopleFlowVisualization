import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CityModel } from './CityModel.js';
import { Crowd } from './Crowd.js';
import { AVATAR_TYPES } from './AvatarFactory.js';
import { FurnitureManager } from './Furniture.js';

// =====================================================================
//  シーン基盤
// =====================================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d141f);
scene.fog = new THREE.Fog(0x0d141f, 300, 800);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(120, 110, 150);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // 地面より下に潜らない
controls.minDistance = 5;
controls.maxDistance = 1200;

// --- ライト ---
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x39414f, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
sun.position.set(120, 200, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);
scene.add(sun.target);

// =====================================================================
//  街と人流
// =====================================================================
const city = new CityModel(scene);
const crowd = new Crowd(scene, city);
const furniture = new FurnitureManager(scene, city);
crowd.furniture = furniture;

// シミュレーション状態
const sim = {
  clock: 480,        // 分（0-1440）
  speed: 60,         // sim分 / 実秒
  playing: true,
  scrubbing: false
};

function configureForCity() {
  // ライト・カメラを街のサイズに合わせる
  const s = city.size;
  sun.position.set(city.center.x + s * 0.4, s * 1.2, city.center.z + s * 0.3);
  sun.target.position.copy(city.center);
  const cam = sun.shadow.camera;
  cam.left = -s * 0.7; cam.right = s * 0.7;
  cam.top = s * 0.7; cam.bottom = -s * 0.7;
  cam.near = 1; cam.far = s * 3;
  cam.updateProjectionMatrix();
  scene.fog.near = s * 1.5;
  scene.fog.far = s * 4;

  controls.target.copy(city.center);
  camera.position.set(city.center.x + s * 0.6, s * 0.7, city.center.z + s * 0.8);
  controls.maxDistance = s * 3;
  controls.update();

  document.getElementById('model-info').textContent =
    `${city.modelName}｜衝突メッシュ ${city.modelStats.meshes}・約${city.modelStats.size}m`
    + (city.addedGround ? '・地面を自動追加' : '');
}

// =====================================================================
//  初期化（サンプルの街 + 人流）
// =====================================================================
function init() {
  showLoading('サンプルの街を生成中...');
  setTimeout(() => {
    city.generateSampleCity();
    configureForCity();
    crowd.generate(getPopCount(), sim.clock);
    hideLoading();
  }, 30);
}

// =====================================================================
//  一人称視点モード
// =====================================================================
const fpv = {
  active: false,
  agent: null,
  yaw: 0,
  pitch: 0,
  manualLook: false,
  keys: { w: false, a: false, s: false, d: false }
};
let savedCam = null;

function enterFPV(agent) {
  if (fpv.active) exitFPV(false);
  crowd.standAgent(agent);   // 着席中なら起立させてから操作開始
  fpv.active = true;
  fpv.agent = agent;
  fpv.yaw = agent.heading;
  fpv.pitch = -0.05;
  fpv.manualLook = false;
  savedCam = { pos: camera.position.clone(), target: controls.target.clone() };
  controls.enabled = false;
  camera.near = 0.1;
  camera.fov = 70;
  camera.updateProjectionMatrix();
  document.getElementById('fpv-banner').classList.remove('hidden');
  document.getElementById('fpv-name').textContent =
    `一人称：${agent.info.typeLabel}（${agent.info.gender}・${agent.info.ageNum}歳）`;
  hideTooltip();
}

function exitFPV(restore = true) {
  if (!fpv.active) return;
  if (fpv.agent) fpv.agent.manual = null;
  fpv.active = false;
  fpv.agent = null;
  controls.enabled = true;
  camera.fov = 55;
  camera.updateProjectionMatrix();
  if (restore && savedCam) {
    camera.position.copy(savedCam.pos);
    controls.target.copy(savedCam.target);
    controls.update();
  }
  document.getElementById('fpv-banner').classList.add('hidden');
}

function updateFPVCamera(dt) {
  const a = fpv.agent;
  if (!a) return;

  // WASD で本人を操作（建物との衝突判定はCrowd側で適用）
  const k = fpv.keys;
  const forward = (k.w ? 1 : 0) - (k.s ? 1 : 0);
  const strafe = (k.d ? 1 : 0) - (k.a ? 1 : 0);
  if (forward !== 0 || strafe !== 0) {
    a.manual = { forward, strafe, heading: fpv.yaw };
  } else if (a.manual) {
    a.manual = { forward: 0, strafe: 0, heading: fpv.yaw };
  }

  // 操作していない時は進行方向へ自然に視線を合わせる
  if (!fpv.manualLook && !(forward || strafe)) {
    fpv.yaw = lerpAngle(fpv.yaw, a.heading, Math.min(1, dt * 2.5));
  }

  const head = crowd.getHeadPosition(a);
  camera.position.copy(head);
  const dir = new THREE.Vector3(
    Math.sin(fpv.yaw) * Math.cos(fpv.pitch),
    Math.sin(fpv.pitch),
    Math.cos(fpv.yaw) * Math.cos(fpv.pitch)
  );
  camera.lookAt(head.x + dir.x, head.y + dir.y, head.z + dir.z);
}

// =====================================================================
//  ピッキング（ホバーで属性表示 / クリックで一人称）
// =====================================================================
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2();
let hoverAgent = null;
let lastPickTime = 0;

function pickAgent(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const pickables = crowd.proxies.filter((p) => p.userData.pickable !== false);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits.length ? hits[0].object.userData.agent : null;
}

function onPointerMove(e) {
  if (fpv.active) {
    if (fpv.manualLook) {
      fpv.yaw -= e.movementX * 0.0025;
      fpv.pitch = clamp(fpv.pitch - e.movementY * 0.0025, -1.2, 1.2);
    }
    return;
  }
  // ホバー判定は負荷軽減のため間引く
  const now = performance.now();
  if (now - lastPickTime < 40) return;
  lastPickTime = now;

  const agent = pickAgent(e.clientX, e.clientY);
  hoverAgent = agent;
  if (agent) showTooltip(agent, e.clientX, e.clientY);
  else hideTooltip();
}

canvas.addEventListener('pointermove', onPointerMove);

// ファニチャー配置モード
const placement = { type: null };
function setPlacement(type) {
  placement.type = (placement.type === type) ? null : type;
  document.querySelectorAll('.furn-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.furn === placement.type));
  const banner = $('place-banner');
  if (placement.type) {
    $('place-name').textContent =
      `配置モード：${({ bench: 'ベンチ', table: 'テーブル', parasol: 'パラソル' })[placement.type]}`;
    banner.classList.remove('hidden');
    canvas.style.cursor = 'copy';
  } else {
    banner.classList.add('hidden');
    canvas.style.cursor = '';
  }
}

// 地面（街メッシュ）との交点を求める
function groundPointAt(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(city.root.children, true);
  return hits.length ? hits[0].point : null;
}

// 左クリック：配置モードなら設置 / アバター選択で一人称へ / FPV中はマウスルック
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) {
    if (fpv.active) { fpv.manualLook = true; return; }
    if (placement.type) {
      const p = groundPointAt(e.clientX, e.clientY);
      if (p) furniture.place(placement.type, p);
      return;
    }
    const agent = pickAgent(e.clientX, e.clientY);
    if (agent) enterFPV(agent);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button === 0 && fpv.active) fpv.manualLook = false;
});

// 右クリック：FPV中は俯瞰へ戻る / それ以外はカーソル下のファニチャーを撤去
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (fpv.active) { exitFPV(true); return; }
  const item = furniture.pickAt(e.clientX, e.clientY, camera);
  if (item) furniture.remove(item, crowd);
});

// ファニチャーボタン
document.querySelectorAll('.furn-btn').forEach((b) =>
  b.addEventListener('click', () => setPlacement(b.dataset.furn)));
// Escで配置モード解除
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && placement.type) setPlacement(null);
});

// FPV用キーボード
window.addEventListener('keydown', (e) => {
  if (!fpv.active) return;
  const m = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd' }[e.code];
  if (m) { fpv.keys[m] = true; e.preventDefault(); }
  if (e.code === 'Escape') exitFPV(true);
});
window.addEventListener('keyup', (e) => {
  const m = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd' }[e.code];
  if (m) fpv.keys[m] = false;
});

// =====================================================================
//  ツールチップ（属性表示）
// =====================================================================
const tooltipEl = document.getElementById('tooltip');
function showTooltip(agent, x, y) {
  const i = agent.info;
  const status = agent.sitState === 'sitting' ? '着席・休憩中'
    : agent.sitState === 'going' ? '着席へ移動中'
    : agent.dwelling ? '滞在中' : '移動中';
  tooltipEl.innerHTML = `
    <div class="tt-title">${i.typeLabel}</div>
    <div class="tt-row"><span>性別</span><span>${i.gender}</span></div>
    <div class="tt-row"><span>年代</span><span>${i.age}（${i.ageNum}歳）</span></div>
    <div class="tt-row"><span>障害の有無</span><span>${i.disability}</span></div>
    <div class="tt-row"><span>状態</span><span>${status}</span></div>
    <div class="tt-row" style="margin-top:4px;color:#ffd166">クリックで一人称体験</div>`;
  tooltipEl.classList.remove('hidden');
  const ox = x + 16, oy = y + 16;
  tooltipEl.style.left = Math.min(ox, window.innerWidth - 230) + 'px';
  tooltipEl.style.top = Math.min(oy, window.innerHeight - 140) + 'px';
}
function hideTooltip() { tooltipEl.classList.add('hidden'); }

// =====================================================================
//  UI 配線
// =====================================================================
const $ = (id) => document.getElementById(id);
function getPopCount() { return clamp(parseInt($('pop-count').value) || 500, 50, 2000); }

// モデル読み込み
$('model-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showLoading(`${file.name} を読み込み中...`);
  try {
    exitFPV(false);
    furniture.clearAll(crowd);
    await city.loadFromFile(file);
    configureForCity();
    crowd.generate(getPopCount(), sim.clock);
    syncDisplayCheckboxes();
  } catch (err) {
    alert('読み込みに失敗しました：' + err.message);
    console.error(err);
  } finally {
    hideLoading();
    e.target.value = '';
  }
});

$('load-sample').addEventListener('click', () => {
  showLoading('サンプルの街を生成中...');
  setTimeout(() => {
    exitFPV(false);
    furniture.clearAll(crowd);
    city.generateSampleCity();
    configureForCity();
    crowd.generate(getPopCount(), sim.clock);
    syncDisplayCheckboxes();
    hideLoading();
  }, 30);
});

$('regen-crowd').addEventListener('click', () => {
  showLoading('人流データを生成中...');
  setTimeout(() => {
    exitFPV(false);
    crowd.generate(getPopCount(), sim.clock);
    syncDisplayCheckboxes();
    hideLoading();
  }, 30);
});

// 時刻スライダー
const timeSlider = $('time-slider');
timeSlider.addEventListener('input', () => {
  sim.clock = parseInt(timeSlider.value);
  crowd.reseed(sim.clock);
  updateClockLabels();
});
timeSlider.addEventListener('pointerdown', () => { sim.scrubbing = true; });
window.addEventListener('pointerup', () => { sim.scrubbing = false; });

// 速度スライダー
const speedSlider = $('speed-slider');
speedSlider.addEventListener('input', () => {
  sim.speed = parseInt(speedSlider.value);
  $('speed-label').textContent = '×' + sim.speed;
});

// 再生 / 一時停止
$('play-toggle').addEventListener('click', () => {
  sim.playing = !sim.playing;
  $('play-toggle').textContent = sim.playing ? '⏸' : '▶';
});

// 表示トグル
$('toggle-paths').addEventListener('change', (e) => crowd.setPathsVisible(e.target.checked));
$('toggle-dest').addEventListener('change', (e) => crowd.setDestVisible(e.target.checked));
$('toggle-collision').addEventListener('change', (e) => city.showCollision(e.target.checked));
function syncDisplayCheckboxes() {
  crowd.setPathsVisible($('toggle-paths').checked);
  crowd.setDestVisible($('toggle-dest').checked);
  city.showCollision($('toggle-collision').checked);
}

// ヘルプ
$('help-toggle').addEventListener('click', () => $('help-panel').classList.toggle('hidden'));

// 凡例（属性フィルタ）
function buildLegend() {
  const el = $('legend');
  el.innerHTML = '';
  AVATAR_TYPES.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:#${t.color.toString(16).padStart(6, '0')}"></span>${t.label}`;
    item.addEventListener('click', () => {
      const on = item.classList.toggle('off');
      crowd.setTypeVisible(t.id, !on);
    });
    el.appendChild(item);
  });
}
buildLegend();

// =====================================================================
//  時計表示
// =====================================================================
function fmtTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function updateClockLabels() {
  const t = fmtTime(sim.clock);
  $('clock').textContent = t;
  $('time-label').textContent = t;
  if (!sim.scrubbing) timeSlider.value = Math.floor(sim.clock);
}

// =====================================================================
//  太陽（光源）の時刻連動
// =====================================================================
const _dayCol = new THREE.Color(0x0d141f);
const _nightCol = new THREE.Color(0x0c1422);
const _tmpCol = new THREE.Color();
const _sunDir = new THREE.Vector3();
function updateSun(min) {
  // 6:00で東の地平線、12:00で天頂、18:00で西の地平線
  const a = (min - 360) / 720 * Math.PI;      // 0=6:00, π=18:00
  const elev = Math.sin(a);                    // >0 で昼
  const day = clamp(elev, 0, 1);
  const r = (city.size || 150) * 1.4;
  _sunDir.set(Math.cos(a), Math.max(0.06, elev), 0.33).normalize();
  sun.position.set(
    city.center.x + _sunDir.x * r,
    city.groundY + _sunDir.y * r,
    city.center.z + _sunDir.z * r
  );
  sun.target.position.copy(city.center);

  // 強度（夜は太陽光ほぼ無し。街灯と環境光で見える程度の明るさを確保）
  sun.intensity = 0.05 + day * 1.5;
  hemi.intensity = 0.34 + day * 0.62;

  // 地平線近くは暖色（朝焼け・夕焼け）
  const warm = 1 - clamp(elev / 0.45, 0, 1);
  _tmpCol.setRGB(1, 0.95 - warm * 0.32, 0.85 - warm * 0.5);
  sun.color.copy(_tmpCol);

  // 背景・フォグを昼夜で補間
  _tmpCol.copy(_nightCol).lerp(_dayCol, day);
  scene.background.copy(_tmpCol);
  scene.fog.color.copy(_tmpCol);

  // 暗さに応じて街灯を自動点灯/消灯（夕方〜明け方）。
  // elev≈0.2(≒17時/7時)で点き始め、日没後に全点灯。
  const night = clamp((0.2 - elev) / 0.28, 0, 1);
  city.updateLamps(night);
}

// =====================================================================
//  メインループ
// =====================================================================
const timer = new THREE.Timer();
function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);

  // シミュレーション時刻を進める
  const effScale = (sim.playing && !sim.scrubbing) ? sim.speed : 0;
  if (effScale > 0) {
    sim.clock = (sim.clock + dt * effScale) % 1440;
  }
  updateClockLabels();
  updateSun(sim.clock);

  crowd.update(dt, sim.clock, effScale);

  if (fpv.active) updateFPVCamera(dt);
  else controls.update();

  renderer.render(scene, camera);
}

// =====================================================================
//  リサイズ・ユーティリティ
// =====================================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function showLoading(text) {
  $('loading-text').textContent = text || '読み込み中...';
  $('loading').classList.remove('hidden');
}
function hideLoading() { $('loading').classList.add('hidden'); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// デバッグ/外部連携用フック
window.__viz = { THREE, camera, controls, city, crowd, furniture, sim, enterFPV, exitFPV, setPlacement, updateSun };

// 起動
$('speed-label').textContent = '×' + sim.speed;
updateClockLabels();
init();
animate();
