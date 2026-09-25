/* =========================================================================
   DROPZONE client entry.
   App   : renderer, menus, settings, input, audio (lives for the page)
   Match : one offline match vs bots (fixed 60 Hz simulation + interpolated
           rendering).  Online play will swap the local Match for a network
           proxy that feeds the same render/HUD code.
   ========================================================================= */
import * as THREE from 'three';
import { BUILD } from '../build-config.js';
import { buildMap } from '../shared/mapgen.js';
import { NavGrid } from '../shared/nav.js';
import { Match, TICK, rayHitPlayer, emptyCommand } from '../shared/game.js';
import { WEAPONS } from '../shared/weapons.js';
import { ITEMS, invCount } from '../shared/items.js';
import { eyeHeight } from '../shared/movement.js';
import { anglesFromDir, lerp, wrapAngle } from '../shared/util.js';
import { loadSettings, saveSettings, defaults, gfx, ACTIONS, DEFAULT_KEYS, keyLabel } from './settings.js';
import { Input } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Audio } from './audio.js';
import { WorldView } from './render/world-view.js';
import { FX } from './render/fx.js';
import { Soldier, itemGeometry, MUZZLE } from './render/models.js';
import { ViewModel } from './render/viewmodel.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { DevTools } from './debug.js';

const $ = (id) => document.getElementById(id);
const MODEL = { kestrel: 'rifle', wasp: 'smg', breaker: 'shotgun', hornet: 'pistol', fists: 'none' };
const LOCAL_ID = 1;

/* ======================================================================= */
class App {
  constructor() {
    this.touch = isTouchDevice();
    document.body.classList.toggle('touch', this.touch);
    this.settings = loadSettings(this.touch);
    this.canvas = $('game');
    this.input = new Input(this.settings, this.canvas);
    this.input.touchMode = this.touch;
    this.audio = new Audio();
    this.audio.setVolume(this.settings.volume);
    this.hud = new HUD();
    this.session = null;
    this.world = buildMap();
    this.nav = new NavGrid(this.world);
    this.mapImage = makeMapImage(this.world);
    this.touchUI = new TouchControls($('touch'), this.input, this.settings, () => saveSettings(this.settings));
    this.dev = BUILD.dev ? new DevTools(this) : null;
    this.applyUIScale();
    this.initRenderer();
    this.bindMenus();
    this.input.onLockChange = (locked) => {
      // losing the mouse mid-fight pauses the offline match — but not when the
      // result screen / spectating released it on purpose
      const s = this.session;
      if (!locked && s && s.canPause && !this.touch && !s.uiOpen) this.pause(true);
    };
    addEventListener('resize', () => this.resize());
    this.resize();
    this.last = performance.now();
    this.lastRender = 0;
    requestAnimationFrame((t) => this.loop(t));
    $('ver').textContent = `v${BUILD.version}${BUILD.dev ? ' · DEV BUILD (F3 디버그)' : ''}`;
    $('loading').classList.add('hide');
  }

  initRenderer() {
    const q = this.q = gfx(this.settings);
    if (this.renderer) {
      this.renderer.dispose();
      // antialias can only be chosen at context creation -> swap the canvas
      const c = this.canvas.cloneNode();
      this.canvas.replaceWith(c);
      this.canvas = c;
      this.input.canvas = c;
      c.addEventListener('mousedown', (e) => this.input.onMouse(e, true));
      c.addEventListener('click', () => this.onCanvasClick());
    } else this.canvas.addEventListener('click', () => this.onCanvasClick());
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: q.antialias, powerPreference: 'high-performance', stencil: false });
    r.setPixelRatio(Math.min(2, (window.devicePixelRatio || 1) * q.pixelRatio));
    r.shadowMap.enabled = q.shadows > 0;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = q.material === 'standard' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    r.toneMappingExposure = 1.05;
    r.autoClear = false;
    r.info.autoReset = false;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.08, q.viewDist + 300);
    this.worldView = new WorldView(this.scene, this.world, q);
    this.fx = new FX(this.scene, q);
    this.vm = new ViewModel(innerWidth / innerHeight);
    this.gfxKey = JSON.stringify(q);
    this.resize();
  }

  applyUIScale() { document.documentElement.style.setProperty('--ui', this.settings.uiScale); }

  resize() {
    if (!this.renderer) return;
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  onCanvasClick() {
    this.audio.init();
    if (this.session && this.session.state === 'playing' && !this.touch && !this.session.uiOpen) this.input.requestLock();
    if (this.session && this.session.spectating) this.session.nextSpectate();
  }

  /* ---------------- menus ---------------- */
  screen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hide', s.id !== id);
    this.curScreen = id;
  }

  bindMenus() {
    const S = this.settings;
    $('pName').value = S.name;
    $('pBots').value = S.bots; $('pBotsV').textContent = S.bots;
    $('pBots').oninput = () => { S.bots = +$('pBots').value; $('pBotsV').textContent = S.bots; saveSettings(S); };
    $('pName').onchange = () => { S.name = $('pName').value.trim().slice(0, 12) || 'PLAYER'; saveSettings(S); };
    segment($('pDiff'), () => S.difficulty, (v) => { S.difficulty = v; saveSettings(S); });
    segment($('pView'), () => S.view, (v) => { S.view = v; saveSettings(S); });
    $('bPlay').onclick = () => { this.audio.init(); this.startMatch(); };
    $('bSettings').onclick = () => { this.settingsBack = 'menu'; this.openSettings(); };
    $('bHelp').onclick = () => { this.buildHelp(); this.screen('help'); };
    for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => this.back();
    $('bResume').onclick = () => this.pause(false);
    $('bPSettings').onclick = () => { this.settingsBack = 'pause'; this.openSettings(); };
    $('bQuit').onclick = () => this.endSession();
    $('bAgain').onclick = () => { this.endSession(); this.startMatch(); };
    $('bLobby').onclick = () => this.endSession();
    $('bSpectate').onclick = () => { $('result').classList.add('hide'); if (this.session) this.session.startSpectate(); };
    $('invClose').onclick = () => this.session && this.session.toggleInventory(false);
    $('mapClose').onclick = () => this.session && this.session.toggleMap(false);
    $('bLayout').onclick = () => this.editLayout(true);
    $('bLayoutDone').onclick = () => this.editLayout(false);
    $('bLayoutReset').onclick = () => this.touchUI.resetLayout();
    $('bResetSet').onclick = () => {
      const keepLayout = S.layout;
      const name = S.name;
      Object.assign(S, defaults(this.touch));
      S.layout = keepLayout; S.name = name;
      saveSettings(S); this.input.buildMap(); this.openSettings(this.setTab);
    };
    // inventory clicks (delegated)
    const inv = $('inv');
    inv.addEventListener('click', (e) => this.session && this.session.invClick(e, false));
    inv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.session) this.session.invClick(e, true); });
    let pressT = null;
    inv.addEventListener('touchstart', (e) => { pressT = setTimeout(() => { pressT = 'long'; if (this.session) this.session.invClick(e, true); }, 550); }, { passive: true });
    inv.addEventListener('touchend', (e) => { if (pressT === 'long') e.preventDefault(); else clearTimeout(pressT); pressT = null; });
    $('prompt').addEventListener('pointerdown', () => this.input.tap('interact'));
    this.screen('menu');
  }

  back() {
    if (this.curScreen === 'settings') {
      saveSettings(this.settings);
      this.input.buildMap();
      this.applyUIScale();
      this.touchUI.layout();
      this.audio.setVolume(this.settings.volume);
      if (JSON.stringify(gfx(this.settings)) !== this.gfxKey && !this.session) this.initRenderer();
      if (this.session) this.session.applySettings();
      this.screen(this.settingsBack === 'pause' ? 'pause' : 'menu');
      if (this.settingsBack === 'pause') $('pause').classList.remove('hide');
      return;
    }
    this.screen('menu');
  }

  buildHelp() {
    const k = this.settings.keys;
    const rows = ACTIONS.map(([a, label]) => `<div><span>${label}</span><b>${(k[a] || []).map(keyLabel).join(' / ')}</b></div>`);
    rows.push('<div><span>무기 교체</span><b>마우스 휠</b></div>', '<div><span>일시정지</span><b>ESC</b></div>');
    $('helpKeys').innerHTML = rows.join('');
  }

  openSettings(tab) {
    const S = this.settings;
    const tabs = [['controls', '조작'], ['graphics', '그래픽'], ['audio', '사운드'], ['mobile', '모바일'], ['keys', '키 설정']];
    this.setTab = tab || this.setTab || (this.touch ? 'mobile' : 'controls');
    $('setTabs').innerHTML = tabs.map(([id, n]) => `<button data-t="${id}" class="${id === this.setTab ? 'on' : ''}">${n}</button>`).join('');
    for (const b of $('setTabs').children) b.onclick = () => this.openSettings(b.dataset.t);
    const body = $('setBody');
    body.innerHTML = '';
    const row = (label, ctl, val, note) => {
      const d = document.createElement('div'); d.className = 'srow';
      d.innerHTML = `<span>${label}</span><div></div><span class="val"></span>`;
      d.children[1].appendChild(ctl);
      if (val) d.children[2].textContent = val;
      if (note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = note; d.appendChild(n); }
      body.appendChild(d);
      return d;
    };
    const slider = (label, key, min, max, step, fmt = (v) => v, note) => {
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = S[key];
      const d = row(label, inp, fmt(S[key]), note);
      inp.oninput = () => { S[key] = +inp.value; d.children[2].textContent = fmt(S[key]); if (key === 'volume') this.audio.setVolume(S.volume); };
    };
    const seg = (label, key, opts, note) => {
      const div = document.createElement('div'); div.className = 'seg';
      for (const [v, n] of opts) { const b = document.createElement('button'); b.dataset.v = JSON.stringify(v); b.textContent = n; div.appendChild(b); }
      const paint = () => { for (const b of div.children) b.classList.toggle('on', b.dataset.v === JSON.stringify(S[key])); };
      for (const b of div.children) b.onclick = () => { S[key] = JSON.parse(b.dataset.v); paint(); if (key === 'quality') { S.shadows = S.antialias = S.effects = S.viewDist = S.renderScale = null; this.openSettings('graphics'); } };
      paint();
      row(label, div, '', note);
    };
    const onoff = [[true, '켜기'], [false, '끄기']];
    if (this.setTab === 'controls') {
      slider('마우스 감도', 'sens', 0.1, 3, 0.05, (v) => v.toFixed(2));
      slider('조준 감도', 'adsSens', 0.1, 2, 0.05, (v) => v.toFixed(2));
      slider('시야각 (FOV)', 'fov', 60, 105, 1, (v) => v + '°');
      seg('Y축 반전', 'invertY', onoff);
      seg('조준 방식', 'adsHold', [[true, '누르고 있기'], [false, '토글']]);
      seg('앉기 방식', 'crouchHold', [[false, '토글'], [true, '누르고 있기']]);
      seg('기본 시점', 'view', [['tps', '3인칭'], ['fps', '1인칭']]);
      seg('자동 줍기', 'autoPickup', onoff, '탄약과 회복 아이템을 지나가면 자동으로 줍습니다');
    } else if (this.setTab === 'graphics') {
      seg('그래픽 품질', 'quality', [['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH'], ['ultra', 'ULTRA']], '아래 개별 옵션은 품질 프리셋을 덮어씁니다');
      const q = gfx(S);
      seg('그림자', 'shadows', [[null, `자동(${['끔', '낮음', '중간', '높음'][q.shadows]})`], [0, '끔'], [1, '낮음'], [2, '중간'], [3, '높음']]);
      seg('안티앨리어싱', 'antialias', [[null, `자동(${q.antialias ? '켬' : '끔'})`], [true, '켜기'], [false, '끄기']], '변경 시 다음 경기부터 적용');
      seg('효과 품질', 'effects', [[null, '자동'], [0, '낮음'], [1, '중간'], [2, '높음']]);
      seg('렌더 거리', 'viewDist', [[null, `자동(${q.viewDist}m)`], [150, '150m'], [250, '250m'], [350, '350m'], [450, '450m']]);
      seg('렌더 해상도', 'renderScale', [[null, '자동'], [0.5, '50%'], [0.75, '75%'], [1, '100%'], [1.5, '150%']]);
      seg('FPS 제한', 'fpsCap', [[30, '30'], [60, '60'], [90, '90'], [120, '120'], [0, '무제한']]);
      const n = document.createElement('p'); n.className = 'sub'; n.textContent = '그래픽 변경은 로비에서 즉시, 경기 중에는 다음 경기부터 적용됩니다.'; body.appendChild(n);
    } else if (this.setTab === 'audio') {
      slider('전체 음량', 'volume', 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
    } else if (this.setTab === 'mobile') {
      slider('터치 감도', 'touchSens', 0.2, 3, 0.05, (v) => v.toFixed(2));
      slider('UI 크기', 'uiScale', 0.7, 1.4, 0.05, (v) => Math.round(v * 100) + '%');
      slider('버튼 크기', 'btnScale', 0.6, 1.6, 0.05, (v) => Math.round(v * 100) + '%');
      slider('버튼 투명도', 'btnOpacity', 0.2, 1, 0.05, (v) => Math.round(v * 100) + '%');
      seg('자동 사격', 'autoFire', onoff, '조준선이 적 위에 있으면 자동으로 발사합니다');
      seg('조준 보조', 'aimAssist', onoff, '적 근처에서 조준 속도가 느려지고 살짝 따라갑니다 (터치 전용)');
      seg('자이로 조작', 'gyro', onoff, '기기를 기울여 조준을 미세 조정합니다 (지원 기기)');
      slider('자이로 감도', 'gyroSens', 0.2, 3, 0.1, (v) => v.toFixed(1));
      seg('진동', 'vibrate', onoff);
      seg('자동 줍기', 'autoPickup', onoff);
    } else if (this.setTab === 'keys') {
      for (const [a, label] of ACTIONS) {
        const b = document.createElement('button'); b.className = 'kb';
        b.textContent = (S.keys[a] || []).map(keyLabel).join(' / ') || '—';
        b.onclick = () => {
          b.classList.add('wait'); b.textContent = '키를 누르세요… (ESC 취소)';
          this.input.onRebind = (code) => {
            if (code) {
              // steal the key from other actions so one key never does two things
              for (const k in S.keys) S.keys[k] = S.keys[k].filter((c) => c !== code);
              S.keys[a] = [code];
            }
            this.input.buildMap(); saveSettings(S); this.openSettings('keys');
          };
        };
        row(label, b, '');
      }
      const rb = document.createElement('button'); rb.className = 'btn sm'; rb.textContent = '키 설정 초기화';
      rb.onclick = () => { S.keys = JSON.parse(JSON.stringify(DEFAULT_KEYS)); this.input.buildMap(); saveSettings(S); this.openSettings('keys'); };
      body.appendChild(rb);
    }
    this.screen('settings');
  }

  editLayout(on) {
    $('layoutBar').classList.toggle('hide', !on);
    if (on) {
      if (!$('bSzUp')) {
        const bar = $('layoutBar');
        const up = document.createElement('button'); up.className = 'btn sm'; up.id = 'bSzUp'; up.textContent = '선택 버튼 크게'; up.onclick = () => this.touchUI.resizeSel(1.1);
        const dn = document.createElement('button'); dn.className = 'btn sm'; dn.id = 'bSzDn'; dn.textContent = '작게'; dn.onclick = () => this.touchUI.resizeSel(1 / 1.1);
        bar.insertBefore(dn, bar.children[1]); bar.insertBefore(up, dn);
      }
      $('settings').classList.add('hide');
      $('touch').classList.remove('hide');
      this.touchUI.setEdit(true);
    } else {
      this.touchUI.setEdit(false);
      saveSettings(this.settings);
      $('touch').classList.toggle('hide', !(this.session && this.touch && this.session.state === 'playing'));
      this.screen('settings');
    }
  }

  /* ---------------- match lifecycle ---------------- */
  startMatch() {
    if (JSON.stringify(gfx(this.settings)) !== this.gfxKey) this.initRenderer();
    this.screen(null);
    $('result').classList.add('hide');
    this.session = new Session(this);
    this.hud.show(true);
    this.touchUI.setVisible(this.touch);
    this.touchUI.visible = this.touch;
    this.input.enabled = true;
    this.input.clearEdges();
    if (!this.touch) this.input.requestLock();
    if (this.touch) tryFullscreen();
  }

  endSession() {
    if (this.session) this.session.dispose();
    this.session = null;
    this.hud.show(false);
    this.touchUI.setVisible(false);
    this.touchUI.visible = false;
    this.input.enabled = false;
    this.input.exitLock();
    $('inv').classList.add('hide'); $('bigmap').classList.add('hide'); $('result').classList.add('hide'); $('pause').classList.add('hide');
    this.screen('menu');
  }

  pause(on) {
    if (!this.session) return;
    this.session.paused = on;
    $('pause').classList.toggle('hide', !on);
    if (on) { this.curScreen = 'pause'; this.pausedAt = performance.now(); this.input.releaseAll(); this.input.exitLock(); }
    else { this.curScreen = null; this.input.clearEdges(); if (!this.touch) this.input.requestLock(); }
    this.input.enabled = !on;
  }

  /* ---------------- main loop ---------------- */
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const cap = this.settings.fpsCap;
    if (cap > 0 && t - this.lastRender < 1000 / cap - 1.5) return;
    this.lastRender = t;
    let dt = (t - this.last) / 1000;
    this.last = t;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    try {
      if (this.dev) this.dev.handleKeys(this.input);
      if (this.input.consume('escape')) this.onEscape();
      this.renderer.info.reset();
      this.renderer.clear();
      if (this.session) this.session.frame(dt);
      else this.menuFrame(dt);
      if (this.dev) this.dev.frame(dt);
    } catch (err) {
      showFatal(err);
      throw err;
    }
  }

  onEscape() {
    const s = this.session;
    if (!s) { if (this.curScreen === 'settings' || this.curScreen === 'help') this.back(); return; }
    if (s.invOpen) { s.toggleInventory(false); return; }
    if (s.mapOpen) { s.toggleMap(false); return; }
    if (this.curScreen === 'settings') { this.back(); return; }
    // the browser also exits pointer lock on ESC (which already paused us)
    if (s.paused && performance.now() - (this.pausedAt || 0) < 400) return;
    if (s.paused || s.canPause) this.pause(!s.paused);
  }

  menuFrame(dt) {
    // slow fly-over of the island behind the menu
    this.menuT = (this.menuT || 0) + dt * 0.04;
    const c = this.camera;
    c.position.set(Math.cos(this.menuT) * 150, 70, Math.sin(this.menuT) * 150);
    c.lookAt(0, 5, 0);
    c.fov = 60; c.updateProjectionMatrix();
    this.worldView.update(dt, c.position, null);
    this.worldView.zoneWall.visible = false;
    this.renderer.render(this.scene, c);
  }
}

function segment(root, get, set) {
  const paint = () => { for (const b of root.children) b.classList.toggle('on', b.dataset.v === get()); };
  for (const b of root.children) b.onclick = () => { set(b.dataset.v); paint(); };
  paint();
}

function tryFullscreen() {
  const el = document.documentElement;
  try { if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch { /* ignore */ }
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch { /* ignore */ }
}

function showFatal(err) {
  const f = $('fatal');
  f.classList.remove('hide');
  f.textContent = '오류: ' + (err && err.stack ? err.stack : String(err));
}

/* ======================================================================= */
class Session {
  constructor(app) {
    this.app = app;
    const S = app.settings;
    this.world = app.world;
    this.seed = (Math.random() * 1e9) >>> 0;
    this.match = new Match({ world: app.world, nav: app.nav, seed: this.seed, bots: S.bots, difficulty: S.difficulty, humans: [{ id: LOCAL_ID, name: S.name }] });
    this.me = this.match.byId.get(LOCAL_ID);
    this.me.autoPickup = S.autoPickup;
    this.state = 'playing';
    this.paused = false;
    this.acc = 0;
    this.time = 0;
    this.simMs = 0;
    this.view = S.view;
    this.camera = app.camera;
    this.rig = new CameraRig(app.camera, app.world);
    this.rig.mode = this.view;
    this.rig.yaw = this.me.yaw;
    this.hud = app.hud;
    this.fx = app.fx;
    this.vm = app.vm;
    this.mapImage = app.mapImage;
    this.recentShots = [];
    this.soldiers = new Map();
    this.prev = new Map();
    this.itemMeshes = new Map();
    this.itemMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a2418 });
    this.itemGroup = new THREE.Group();
    app.scene.add(this.itemGroup);
    this.adsBlend = 0;
    this.invOpen = false; this.mapOpen = false;
    this.spectating = false; this.specId = null;
    this.muzzleV = new THREE.Vector3();
    this.steps = new Map();
    this.gyro = { on: false, lastA: null, lastB: null };
    for (const p of this.match.players) {
      const s = new Soldier(p.skin, app.q.shadows > 1);
      app.scene.add(s.root);
      this.soldiers.set(p.id, s);
      this.prev.set(p.id, { x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z, yaw: p.yaw });
    }
    this.syncItems();
    this.hud.banner('자기장이 곧 줄어듭니다 · 무기를 찾으세요', 'zone', 4);
    this.applySettings();
  }

  applySettings() {
    const S = this.app.settings;
    this.me.autoPickup = S.autoPickup;
    if (S.gyro && !this.gyroHandler) {
      this.gyroHandler = (e) => this.onGyro(e);
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) DeviceOrientationEvent.requestPermission().catch(() => {});
      } catch { /* ignore */ }
      addEventListener('deviceorientation', this.gyroHandler);
    } else if (!S.gyro && this.gyroHandler) { removeEventListener('deviceorientation', this.gyroHandler); this.gyroHandler = null; }
  }
  onGyro(e) {
    if (e.beta === null || e.gamma === null) return;
    const landscape = (screen.orientation ? screen.orientation.angle : window.orientation || 0) % 180 !== 0;
    const a = landscape ? e.beta : e.gamma, b = landscape ? e.gamma : e.beta;
    if (this.gyro.lastA !== null && this.app.input.enabled) {
      let da = a - this.gyro.lastA, db = b - this.gyro.lastB;
      if (Math.abs(da) > 20) da = 0; if (Math.abs(db) > 20) db = 0;
      const k = this.app.settings.gyroSens * 0.017;
      this.rig.look(-da * k * (landscape ? -1 : 1), -db * k);
    }
    this.gyro.lastA = a; this.gyro.lastB = b;
  }

  dispose() {
    const sc = this.app.scene;
    for (const s of this.soldiers.values()) sc.remove(s.root);
    sc.remove(this.itemGroup);
    this.fx.reset();
    if (this.gyroHandler) removeEventListener('deviceorientation', this.gyroHandler);
  }

  get uiOpen() { return this.invOpen || this.mapOpen; }
  get canPause() { return this.state === 'playing' && this.me.alive && !this.spectating && this.app.curScreen !== 'result'; }

  /* ---------------- per frame ---------------- */
  frame(dt) {
    const app = this.app, input = app.input, S = app.settings;
    this.time += dt;
    // ---- UI toggles ----
    if (input.consume('inventory')) this.toggleInventory(!this.invOpen);
    if (input.consume('map')) this.toggleMap(!this.mapOpen);
    if (input.consume('view')) { this.view = this.view === 'tps' ? 'fps' : 'tps'; this.rig.mode = this.view; }
    // ---- look ----
    const lk = input.takeLook();
    const me = this.me;
    const w = this.match.weaponOf(me);
    const zoom = 1 + (w.zoom - 1) * this.adsBlend;
    let sens = 0.0022 * S.sens * (this.adsBlend > 0.5 ? S.adsSens / zoom : 1);
    if (input.lastDevice === 'touch') sens = 0.0022 * (this.adsBlend > 0.5 ? S.adsSens / zoom : 1) * this.aimAssistMul();
    const invert = S.invertY ? -1 : 1;
    this.rig.freeLook = input.held('freelook') && this.view === 'tps';
    if (!this.spectating) {
      this.rig.look(lk.x * sens, lk.y * sens * invert);
      this.vm.sway(lk.x, lk.y);
    }
    if (input.lastDevice === 'touch' && S.aimAssist && me.alive) this.aimAssistPull(dt);

    // ---- simulation ----
    if (!this.paused) {
      this.acc = Math.min(this.acc + dt, 0.25);
      while (this.acc >= TICK) {
        this.acc -= TICK;
        this.tick();
      }
    }
    const alpha = this.acc / TICK;
    this.render(dt, alpha);
  }

  aimAssistMul() {
    // slow down the look speed when the crosshair is over / near an enemy
    return this.nearTarget ? 0.55 : 1;
  }
  aimAssistPull(dt) {
    const t = this.nearTarget;
    if (!t || !this.app.input.held('fire') && this.adsBlend < 0.5) return;
    const e = this.match.eye(this.me);
    const a = anglesFromDir(t.x - e.x, t.y - e.y, t.z - e.z);
    const dy = wrapAngle(a.yaw - this.rig.yaw), dp = a.pitch - this.rig.pitch;
    const k = Math.min(1, dt * 2.2);
    this.rig.yaw += dy * k * 0.35; this.rig.pitch += dp * k * 0.25;
  }

  tick() {
    const m = this.match, me = this.me;
    for (const p of m.players) {
      const pr = this.prev.get(p.id);
      pr.x = p.body.pos.x; pr.y = p.body.pos.y; pr.z = p.body.pos.z; pr.yaw = p.yaw;
    }
    if (me.alive && this.state === 'playing') m.setCommand(me.id, this.buildCommand());
    else m.setCommand(me.id, emptyCommand());
    const t0 = performance.now();
    m.step(TICK);
    this.simMs = this.simMs * 0.95 + (performance.now() - t0) * 0.05;
    for (const e of m.drainEvents()) this.onEvent(e);
  }

  buildCommand() {
    const input = this.app.input, S = this.app.settings, me = this.me;
    const mv = input.move;
    const uiBlock = this.uiOpen;
    const aim = this.computeAim();
    const c = emptyCommand();
    c.fwd = uiBlock ? 0 : mv.y; c.right = uiBlock ? 0 : mv.x;
    c.yaw = this.rig.yaw; c.pitch = this.rig.pitch;
    c.aimYaw = aim.yaw; c.aimPitch = aim.pitch;
    c.fire = !uiBlock && (input.held('fire') || (S.autoFire && this.app.touch && this.crossOnEnemy));
    c.ads = !uiBlock && input.ads;
    c.sprint = input.held('sprint');
    c.walk = input.held('walk');
    c.jump = input.consume('jump');
    c.crouch = input.consume('crouch');
    if (S.crouchHold && input.consume('crouchRelease') && me.body.stance === 'crouch') c.crouch = true;
    c.prone = input.consume('prone');
    c.reload = input.consume('reload');
    c.interact = input.consume('interact');
    for (let i = 0; i < 4; i++) if (input.consume('slot' + (i + 1))) c.slot = i;
    input.consume('slot5');
    if (input.consume('nextWeapon')) c.cycle = 1;
    if (input.consume('prevWeapon')) c.cycle = -1;
    if (input.consume('heal')) {
      const key = me.hp < 75 && invCount(me.inv, 'bandage') > 0 && (me.hp >= 40 || invCount(me.inv, 'medkit') === 0) ? 'bandage' : invCount(me.inv, 'medkit') > 0 ? 'medkit' : invCount(me.inv, 'bandage') > 0 ? 'bandage' : null;
      if (key) c.use = key; else { this.hud.banner('회복 아이템이 없습니다', '', 1.4); this.app.audio.ui('deny'); }
    }
    return c;
  }

  /** where the crosshair points in the world -> angles from the eye */
  computeAim() {
    const me = this.me, m = this.match;
    const e = m.eye(me);
    if (this.view === 'fps' || this.rig.freeLook) {
      if (this.rig.freeLook && this.lastAim) return this.lastAim;
      this.crossOnEnemy = false;
      const d = this.rig.fwd;
      this.lastAimPoint = this.aimHitPoint(e, { x: -Math.sin(this.rig.yaw) * Math.cos(this.rig.pitch), y: Math.sin(this.rig.pitch), z: -Math.cos(this.rig.yaw) * Math.cos(this.rig.pitch) }, 0);
      this.lastAim = { yaw: this.rig.yaw, pitch: this.rig.pitch };
      return this.lastAim;
    }
    const cp = this.camera.position;
    const d = { x: -Math.sin(this.rig.yaw) * Math.cos(this.rig.pitch), y: Math.sin(this.rig.pitch), z: -Math.cos(this.rig.yaw) * Math.cos(this.rig.pitch) };
    // start the ray at the player's depth so walls between camera and player are ignored
    const skip = Math.max(0, (e.x - cp.x) * d.x + (e.y - cp.y) * d.y + (e.z - cp.z) * d.z) + 0.3;
    const hitPt = this.aimHitPoint(cp, d, skip);
    this.lastAimPoint = hitPt;
    let dx = hitPt.x - e.x, dy = hitPt.y - e.y, dz = hitPt.z - e.z;
    // point blank / behind the eye: fall back to the camera direction
    if (dx * d.x + dy * d.y + dz * d.z < 1.2) { dx = d.x; dy = d.y; dz = d.z; }
    this.lastAim = anglesFromDir(dx, dy, dz);
    return this.lastAim;
  }

  aimHitPoint(o, d, skip) {
    const m = this.match, maxT = 900;
    const sx = o.x + d.x * skip, sy = o.y + d.y * skip, sz = o.z + d.z * skip;
    const wh = this.world.raycast(sx, sy, sz, d.x, d.y, d.z, maxT, { bullets: true });
    let t = wh ? wh.t : maxT;
    this.crossOnEnemy = false; this.nearTarget = null;
    let bestAng = 0.09;
    for (const p of m.players) {
      if (p === this.me || !p.alive) continue;
      const h = rayHitPlayer(p, sx, sy, sz, d.x, d.y, d.z, t);
      if (h) { t = h.t; this.crossOnEnemy = true; }
      // aim assist candidate: nearest angular distance to the enemy's chest
      if (this.app.settings.aimAssist && this.app.touch) {
        const cx = p.body.pos.x - sx, cy = p.body.pos.y + 1.1 - sy, cz = p.body.pos.z - sz;
        const L = Math.hypot(cx, cy, cz);
        if (L < 120 && L > 1) {
          const ang = Math.acos(Math.min(1, (cx * d.x + cy * d.y + cz * d.z) / L));
          if (ang < bestAng && this.world.lineClear(sx, sy, sz, p.body.pos.x, p.body.pos.y + 1.1, p.body.pos.z)) { bestAng = ang; this.nearTarget = { x: p.body.pos.x, y: p.body.pos.y + (p.body.stance === 'prone' ? 0.25 : 1.1), z: p.body.pos.z }; }
        }
      }
    }
    return { x: sx + d.x * t, y: sy + d.y * t, z: sz + d.z * t };
  }

  /* ---------------- events -> fx / audio / hud ---------------- */
  onEvent(e) {
    const m = this.match, me = this.me, A = this.app.audio, hud = this.hud;
    const isMe = e.id === me.id;
    switch (e.t) {
      case 'shot': {
        const p = m.byId.get(e.id); if (!p) break;
        const w = WEAPONS[e.w];
        if (isMe) {
          this.rig.kick(w, p.body.stance, p.adsT);
          this.vm.shot(w);
          if (this.app.settings.vibrate && this.app.touch && navigator.vibrate) try { navigator.vibrate(w.cat === 'shotgun' ? 25 : 8); } catch { /* ignore */ }
        } else {
          this.recentShots.push({ x: e.x, z: e.z, t: this.time });
          if (this.recentShots.length > 20) this.recentShots.shift();
          this.whizCheck(e);
        }
        A.gunshot(w.sound, { x: e.x, y: e.y, z: e.z }, isMe);
        if (w.cat !== 'melee') {
          const mz = this.muzzleOf(p);
          this.fx.muzzle(mz.x, mz.y, mz.z, w.cat === 'shotgun', isMe);
          // tag the bullets just spawned so tracers leave from the muzzle
          const n = e.dirs.length;
          for (let i = m.bullets.length - 1, k = 0; i >= 0 && k < n; i--) if (m.bullets[i].owner === p.id) { this.fx.tagBullet(m.bullets[i], mz.x, mz.y, mz.z); k++; }
          if (w.cat !== 'shotgun') A.shell({ x: e.x, y: e.y - 1, z: e.z }, isMe);
        }
        const s = this.soldiers.get(e.id); if (s) s.kickT = 1;
        break;
      }
      case 'hit': {
        this.fx.blood(e.x, e.y, e.z, e.dx, e.dz, e.part === 'head');
        if (e.by === me.id) { hud.hit(e.part === 'head', e.kill); A.hitmark(e.part === 'head', e.kill); }
        if (isMe) {
          const att = e.by !== null ? m.byId.get(e.by) : null;
          hud.hurt(e.dmg, att ? att.body.pos : null);
          A.hurt();
          this.rig.addShake(Math.min(0.6, e.dmg / 50));
          if (this.app.settings.vibrate && this.app.touch && navigator.vibrate) try { navigator.vibrate(40); } catch { /* ignore */ }
        }
        break;
      }
      case 'impact': this.fx.impact(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.mat); A.impact(e, e.mat); break;
      case 'kill': {
        const v = m.byId.get(e.id), k = e.by !== null ? m.byId.get(e.by) : null;
        const nm = (p) => `<b class="${p === me ? 'me' : ''}">${escapeHtml(p.name)}</b>`;
        const how = e.cause === 'zone' ? '자기장' : e.cause === 'fall' ? '낙하' : (WEAPONS[e.cause] ? WEAPONS[e.cause].name : e.cause);
        hud.feed(k && k !== v ? `${nm(k)}<span class="w">${how}${e.head ? ' ✦' : ''}</span>${nm(v)}` : `${nm(v)}<span class="w">${how}</span>`);
        if (k === me && v !== me) hud.banner(`${v.name} 처치${e.head ? ' · 헤드샷' : ''}`, '', 1.8);
        if (isMe) this.onDeath(k);
        break;
      }
      case 'reload': if (isMe || this.near(e.id, 25)) A.reload(this.posOf(e.id), isMe, 0); break;
      case 'reloadDone': if (isMe || this.near(e.id, 25)) A.reload(this.posOf(e.id), isMe, 1); break;
      case 'shellIn': if (isMe || this.near(e.id, 25)) A.reload(this.posOf(e.id), isMe, 2); break;
      case 'dry': if (isMe) A.dry(); break;
      case 'noAmmo': if (isMe) { hud.banner('탄약이 없습니다', '', 1.4); A.ui('deny'); } break;
      case 'pickup': if (isMe) { A.pickup(); const it = ITEMS[e.key]; hud.prompt(null); if (it) this.toast(`${it.name}${e.n > 1 ? ' ×' + e.n : ''} 획득`); } this.itemsDirty = true; break;
      case 'deny': if (isMe) { A.ui('deny'); hud.banner(e.why === 'full' ? '가방이 가득 찼습니다' : e.why === 'hpfull' ? '더 회복할 수 없습니다' : '사용할 수 없습니다', '', 1.4); } break;
      case 'healed': if (isMe) A.heal(); break;
      case 'land': {
        const p = m.byId.get(e.id);
        if (p && (isMe || this.near(e.id, 30))) { A.land(p.body.pos, isMe, e.v); if (e.v > 7) this.fx.dust(p.body.pos.x, p.body.pos.y, p.body.pos.z, Math.min(2, e.v / 8)); }
        if (isMe) this.rig.land(e.v);
        break;
      }
      case 'zone':
        if (e.ev === 'shrink') { hud.banner('자기장이 줄어들기 시작합니다!', 'zone', 3); A.ui('zone'); }
        else if (e.ev === 'wait') hud.banner('새 안전구역이 표시되었습니다', 'zone', 3);
        else if (e.ev === 'final') hud.banner('최종 구역', 'zone', 3);
        break;
      case 'itemAdd': case 'itemRemove': case 'itemUpdate': this.itemsDirty = true; break;
      case 'end': this.onEnd(e.winner); break;
    }
  }

  toast(txt) { this.hud.prompt(`<span>${escapeHtml(txt)}</span>`); this.toastT = 1.2; }

  near(id, d) { const p = this.match.byId.get(id); return p && Math.hypot(p.body.pos.x - this.me.body.pos.x, p.body.pos.z - this.me.body.pos.z) < d; }
  posOf(id) { const p = this.match.byId.get(id); return p ? { x: p.body.pos.x, y: p.body.pos.y + 1, z: p.body.pos.z } : null; }

  whizCheck(e) {
    const me = this.me;
    if (!me.alive) return;
    const h = this.match.eye(me);
    for (const d of e.dirs) {
      const vx = h.x - e.x, vy = h.y - e.y, vz = h.z - e.z;
      const along = vx * d[0] + vy * d[1] + vz * d[2];
      if (along < 4) continue;
      const px = vx - d[0] * along, py = vy - d[1] * along, pz = vz - d[2] * along;
      const miss = Math.hypot(px, py, pz);
      if (miss < 2.5) { this.app.audio.whiz({ x: h.x - px, y: h.y - py, z: h.z - pz }); this.rig.addShake(0.08); return; }
    }
  }

  muzzleOf(p) {
    if (p === this.me && this.view === 'fps' && !this.spectating) return this.vm.muzzleWorld(this.camera, this.muzzleV);
    const s = this.soldiers.get(p.id);
    if (s && s.gun) {
      s.root.updateMatrixWorld(true);
      const mz = MUZZLE[s.gunModel] || MUZZLE.none;
      return this.muzzleV.set(mz[0], mz[1], mz[2]).applyMatrix4(s.gun.matrixWorld);
    }
    const e = this.match.eye(p);
    return this.muzzleV.set(e.x, e.y, e.z);
  }

  onDeath(killer) {
    this.app.audio.lose();
    this.deathT = this.time;
    this.specId = killer && killer.alive ? killer.id : null;
    this.hud.banner(killer ? `${killer.name}에게 처치당했습니다` : '사망했습니다', '', 3);
    setTimeout(() => { if (this.app.session === this && this.state === 'playing') this.showResult(false); }, 2200);
  }

  onEnd(winnerId) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    const won = winnerId === this.me.id;
    if (won) { this.app.audio.win(); this.hud.banner('최후의 생존자!', '', 5); }
    setTimeout(() => { if (this.app.session === this) this.showResult(won); }, won ? 2500 : 300);
  }

  showResult(won) {
    const me = this.me, m = this.match;
    const place = won ? 1 : (me.place || m.aliveCount() + 1);
    $('resTitle').textContent = won ? '최후의 생존자' : place <= 5 ? '아깝습니다!' : '다음엔 더 잘할 수 있어요';
    $('resPlace').innerHTML = `#${place} <span>/ ${m.players.length}</span>`;
    const alive = me.alive ? m.time : me.deathT;
    $('resStats').innerHTML = [
      [me.kills, '처치'], [Math.round(me.dmgDealt), '피해량'], [`${Math.floor(alive / 60)}:${String(Math.floor(alive % 60)).padStart(2, '0')}`, '생존 시간']
    ].map(([v, l]) => `<div><b>${v}</b><i>${l}</i></div>`).join('');
    $('bSpectate').classList.toggle('hide', this.state === 'ended' || m.aliveCount() === 0);
    $('result').classList.remove('hide');
    this.app.curScreen = 'result';
    this.app.input.exitLock();
    this.app.input.enabled = false;
    this.app.touchUI.setVisible(false);
    this.toggleInventory(false); this.toggleMap(false);
  }

  startSpectate() {
    this.spectating = true;
    this.paused = false;
    this.app.curScreen = null;
    this.app.input.enabled = true;
    if (!this.app.touch) this.app.input.requestLock();
    if (!this.specId || !this.match.byId.get(this.specId).alive) this.nextSpectate();
    this.hud.banner('관전 중 · 클릭(터치)으로 다음 플레이어', '', 3);
  }
  nextSpectate() {
    const alive = this.match.players.filter((p) => p.alive && p !== this.me);
    if (!alive.length) return;
    const i = alive.findIndex((p) => p.id === this.specId);
    this.specId = alive[(i + 1) % alive.length].id;
  }

  /* ---------------- UI panels ---------------- */
  toggleInventory(on) {
    if (on && (!this.me.alive || this.state !== 'playing')) return;
    this.invOpen = on;
    $('inv').classList.toggle('hide', !on);
    if (on) { this.toggleMap(false); this.hud.renderInventory(this); this.app.input.exitLock(); this.app.input.releaseAll(); }
    else if (!this.app.touch && this.state === 'playing' && !this.paused) this.app.input.requestLock();
  }
  toggleMap(on) {
    this.mapOpen = on;
    $('bigmap').classList.toggle('hide', !on);
    if (on) { this.invOpen = false; $('inv').classList.add('hide'); }
  }
  invClick(e, alt) {
    const el = e.target.closest ? e.target.closest('.it') : null;
    if (!el) return;
    const m = this.match, me = this.me;
    if (el.dataset.g) {
      const it = m.itemById.get(+el.dataset.g);
      if (it) m.pickup(me, it);
    } else if (el.dataset.b) {
      const key = el.dataset.b;
      if (alt || ITEMS[key].kind !== 'heal') m.requestDrop(me.id, key, alt ? me.inv.items[key] : Math.min(me.inv.items[key], ITEMS[key].stack || 1));
      else { m.setCommand(me.id, Object.assign(emptyCommand(), { use: key, yaw: this.rig.yaw, pitch: this.rig.pitch })); this.toggleInventory(false); }
    } else if (el.dataset.s !== undefined) {
      if (alt) m.requestDrop(me.id, 'slot' + el.dataset.s, 1);
      else m.setCommand(me.id, Object.assign(emptyCommand(), { slot: +el.dataset.s, yaw: this.rig.yaw, pitch: this.rig.pitch }));
    }
    for (const ev of m.drainEvents()) this.onEvent(ev);
    this.syncItems();
    this.hud.renderInventory(this);
  }

  syncItems() {
    const seen = new Set();
    for (const it of this.match.items) {
      seen.add(it.id);
      let mesh = this.itemMeshes.get(it.id);
      if (!mesh) {
        mesh = new THREE.Mesh(itemGeometry(it.key), this.itemMat);
        mesh.position.set(it.x, it.y + 0.02, it.z);
        mesh.rotation.y = (it.id * 2.399) % 6.28;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.itemGroup.add(mesh);
        this.itemMeshes.set(it.id, mesh);
      }
    }
    for (const [id, mesh] of this.itemMeshes) if (!seen.has(id)) { this.itemGroup.remove(mesh); this.itemMeshes.delete(id); }
    this.itemsDirty = false;
  }

  /* ---------------- rendering ---------------- */
  render(dt, alpha) {
    const app = this.app, m = this.match, me = this.me, q = app.q;
    if (this.itemsDirty) this.syncItems();
    if (this.invOpen && ((this.invT = (this.invT || 0) + dt) > 0.3)) { this.invT = 0; this.hud.renderInventory(this); }
    // who is the camera following?
    let focus = me;
    if (!me.alive && this.spectating) { const s = m.byId.get(this.specId); if (s && s.alive) focus = s; else this.nextSpectate(); }
    const w = m.weaponOf(focus);
    this.adsBlend += ((focus.ads ? 1 : 0) - this.adsBlend) * Math.min(1, dt / Math.max(0.05, w.adsTime * 0.6));
    const pr = this.prev.get(focus.id);
    const pos = { x: lerp(pr.x, focus.body.pos.x, alpha), y: lerp(pr.y, focus.body.pos.y, alpha), z: lerp(pr.z, focus.body.pos.z, alpha) };
    if (focus !== me) {
      this.rig.yaw = focus.yaw; this.rig.pitch = focus.pitch * 0.5;
      this.rig.mode = 'tps';
    } else this.rig.mode = this.view;
    if (!me.alive && !this.spectating) {
      // death cam: slowly orbit the body
      this.rig.yaw += dt * 0.25;
      this.rig.pitch = lerp(this.rig.pitch, -0.35, dt * 2);
      this.rig.mode = 'tps';
    }
    this.rig.update(dt, pos, me.alive || focus !== me ? eyeHeight(focus.body) : 0.6, this.adsBlend, w, app.settings.fov);
    const cp = this.camera.position;
    app.audio.setListener(cp.x, cp.y, cp.z, this.rig.yaw + this.rig.freeYaw);
    app.audio.tickAmbience(dt, this.time - (this.lastFightT || 0) > 10);
    app.worldView.update(dt, cp, m.zone);

    // ---- soldiers ----
    const vd2 = (q.viewDist * 0.9) ** 2, lod2 = (40 * q.lodScale) ** 2;
    for (const p of m.players) {
      const s = this.soldiers.get(p.id);
      const pp = this.prev.get(p.id);
      const x = lerp(pp.x, p.body.pos.x, alpha), y = lerp(pp.y, p.body.pos.y, alpha), z = lerp(pp.z, p.body.pos.z, alpha);
      const dx = x - cp.x, dz = z - cp.z;
      const far = dx * dx + dz * dz > vd2;
      const hideSelf = p === focus && this.rig.mode === 'fps';
      const hideDead = !p.alive && m.time - p.deathT > 40;
      s.root.visible = !far && !hideSelf && !hideDead;
      if (!s.root.visible) continue;
      s.setLod(dx * dx + dz * dz > lod2 && p !== focus);
      s.root.position.set(x, y, z);
      s.root.rotation.y = p === me && me.alive ? this.rig.yaw : pp.yaw + wrapAngle(p.yaw - pp.yaw) * alpha;
      const sl = p.alive ? m.slotOf(p) : null;
      s.setWeapon(sl ? MODEL[sl.id] : null);
      const vx = p.body.vel.x, vz = p.body.vel.z;
      s.kickT = Math.max(0, (s.kickT || 0) - dt * 12);
      s.animate({
        dt, speed: Math.hypot(vx, vz), stance: p.body.stance, pitch: p === me ? this.rig.pitch : p.pitch, onGround: p.body.onGround,
        alive: p.alive, sprint: p.body.sprinting, reloading: p.reloading, kick: s.kickT
      });
      // footsteps
      if (p.alive && p.body.onGround) this.footstep(p, dt);
    }
    // ---- ground items: only near ones are drawn; highlight pickup target ----
    const target = me.alive && this.state === 'playing' ? m.findPickup(me) : null;
    for (const it of m.items) {
      const mesh = this.itemMeshes.get(it.id);
      if (!mesh) continue;
      const d2 = (it.x - cp.x) ** 2 + (it.z - cp.z) ** 2;
      mesh.visible = d2 < 3600;
      const sc = it === target ? 1.25 + Math.sin(this.time * 8) * 0.08 : 1;
      if (mesh.scale.x !== sc) { mesh.scale.setScalar(sc); mesh.updateMatrix(); }
    }
    if (this.toastT > 0) this.toastT -= dt;
    else if (target && !this.uiOpen) {
      const def = ITEMS[target.key];
      const key = app.touch ? '줍기' : keyLabel(app.settings.keys.interact[0]);
      const extra = def.kind === 'weapon' ? ` <span style="color:#9fb0c2">${WEAPONS[target.key].catName}</span>` : target.count > 1 ? ` ×${target.count}` : '';
      this.hud.prompt(`<kbd>${key}</kbd>${escapeHtml(def.name)}${extra}`);
    } else this.hud.prompt(null);
    if (app.touch) { app.touchUI.setEnabled('interact', !!target); app.touchUI.setState('ads', app.input.adsToggled); }

    // ---- effects ----
    this.fx.renderBullets(m.bullets, alpha, TICK, cp);
    this.fx.update(dt);
    if (m.time - me.lastHitT < 1 || m.time - me.lastShotT < 1) this.lastFightT = this.time;

    // ---- draw ----
    this.camera.far = q.viewDist + 300;
    app.renderer.render(app.scene, this.camera);
    if (this.rig.mode === 'fps' && focus === me && me.alive) {
      const sl = m.slotOf(me);
      this.vm.setWeapon(MODEL[sl.id]);
      this.vm.update(dt, { ads: this.adsBlend, speed: me.body.moveSpeed, onGround: me.body.onGround, reloading: me.reloading, sprint: me.body.sprinting, aspect: this.camera.aspect });
      this.vm.cam.fov = 62 / (1 + (w.zoom - 1) * this.adsBlend * 0.5);
      app.renderer.clearDepth();
      app.renderer.render(this.vm.scene, this.vm.cam);
    }
    // ---- HUD ----
    this.hud.update(dt, this);
    if (this.mapOpen) { this.showAllOnMap = app.dev && app.dev.flags.map; this.hud.drawBigMap(this); }
  }

  footstep(p, dt) {
    if (p.body.moveSpeed < 1.2) return;
    const cp = this.camera.position;
    const d = Math.hypot(p.body.pos.x - cp.x, p.body.pos.z - cp.z);
    if (d > 40 && p !== this.me) return;
    let st = this.steps.get(p.id) || 0;
    st += p.body.moveSpeed * dt;
    const stride = p.body.stance === 'prone' ? 1.4 : p.body.sprinting ? 1.9 : 1.55;
    if (st > stride) {
      st = 0;
      const quiet = p.body.stance !== 'stand' || p.cmd.walk;
      const g = this.world.groundAt(p.body.pos.x, p.body.pos.z);
      if (!quiet || d < 8) this.app.audio.footstep(p.body.pos, p === this.me, p.body.moveSpeed * (quiet ? 0.4 : 1), p.body.pos.y - g > 0.08 ? 'hard' : 'soft');
    }
    this.steps.set(p.id, st);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- top-down map picture (minimap + full map) ---------------- */
function makeMapImage(world) {
  const S = 640, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const T = world.terrain, half = world.half, k = S / (half * 2);
  const img = g.createImageData(S, S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = i / k - half, z = j / k - half;
      const h = T.heightAt(x, z);
      const shade = (T.heightAt(x - 1, z - 1) - T.heightAt(x + 1, z + 1)) * 12;
      const base = h > 18 ? [120, 124, 110] : [86, 112, 62];
      const o = (j * S + i) * 4;
      img.data[o] = Math.max(0, Math.min(255, base[0] + shade + h));
      img.data[o + 1] = Math.max(0, Math.min(255, base[1] + shade + h * 0.8));
      img.data[o + 2] = Math.max(0, Math.min(255, base[2] + shade));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.lineCap = 'round';
  for (const r of world.roads) {
    g.strokeStyle = '#8b8373'; g.lineWidth = r.w * k;
    g.beginPath(); g.moveTo((r.ax + half) * k, (r.az + half) * k); g.lineTo((r.bx + half) * k, (r.bz + half) * k); g.stroke();
  }
  g.fillStyle = 'rgba(40,60,30,.55)';
  for (const p of world.props) if (p.type === 'tree') { g.beginPath(); g.arc((p.x + half) * k, (p.z + half) * k, 2.2 * k, 0, 6.28); g.fill(); }
  const sorted = world.boxes.filter((b) => !b.hidden && b.maxY - b.minY > 0.5).sort((a, b) => a.maxY - b.maxY);
  for (const b of sorted) {
    const col = new THREE.Color(b.color).multiplyScalar(0.85);
    g.fillStyle = '#' + col.getHexString();
    g.fillRect((b.minX + half) * k, (b.minZ + half) * k, Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
  }
  return c;
}

/* ---------------- boot ---------------- */
try {
  window.__app = new App();
} catch (err) {
  showFatal(err);
  $('loading').textContent = 'ERROR';
  throw err;
}
