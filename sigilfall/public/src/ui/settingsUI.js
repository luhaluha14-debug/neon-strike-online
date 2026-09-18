/* =============================================================================
   the settings screen.  every control writes straight through to the settings
   store, which saves itself and tells the engine, HUD and touch pad to update.
   ========================================================================== */
import { $, el } from './screens.js';
import { settings, QUALITY_PRESETS, DEFAULT_BINDS } from '../core/settings.js';
import { clamp } from '../core/math.js';

const BIND_LABELS = {
  forward: '앞으로', back: '뒤로', left: '왼쪽', right: '오른쪽',
  jump: '점프', crouch: '앉기', sprint: '달리기', dash: '회피 / 이동기',
  ability1: '술식 1', ability2: '술식 2', ultimate: '궁극기 (영역)',
  refocus: '재집중', scoreboard: '점수판', menu: '메뉴'
};

const TABS = [
  ['aim', '조준'], ['move', '조작'], ['video', '화면'], ['audio', '소리'], ['touch', '모바일']
];

export class SettingsUI {
  constructor(onChanged) {
    this.tab = settings.device.isMobile ? 'aim' : 'aim';
    this.onChanged = onChanged || (() => {});
    this.capture = null;
    this.buildTabs();
    $('btnSetReset').onclick = () => {
      settings.resetBinds();
      settings.set('sensitivity', 0.0022);
      settings.set('aimAssistStrength', 0.75);
      settings.applyQuality(settings.device.tier);
      this.render();
      this.onChanged();
    };
  }

  buildTabs() {
    const wrap = $('setTabs');
    wrap.innerHTML = '';
    for (const [id, name] of TABS) {
      const b = el('button', id === this.tab ? 'on' : '', name);
      b.onclick = () => { this.tab = id; this.buildTabs(); this.render(); };
      wrap.appendChild(b);
    }
  }

  open() { this.buildTabs(); this.render(); }

  /* ---- little builders ---- */
  row(label, sub) {
    const r = el('div', 'opt');
    const l = el('span', 'lbl');
    l.appendChild(document.createTextNode(label));
    if (sub) l.appendChild(el('small', '', sub));
    r.appendChild(l);
    return r;
  }

  range(label, sub, key, min, max, step, fmt, apply) {
    const r = this.row(label, sub);
    const val = el('span', 'val');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = settings.get(key);
    const show = () => { val.textContent = fmt ? fmt(Number(input.value)) : input.value; };
    input.oninput = () => {
      const v = Number(input.value);
      settings.set(key, v);
      show();
      apply?.(v);
      this.onChanged();
    };
    show();
    r.appendChild(input);
    r.appendChild(val);
    return r;
  }

  toggle(label, sub, key, apply) {
    const r = this.row(label, sub);
    const seg = el('div', 'seg');
    const mk = (text, on) => {
      const b = el('button', settings.get(key) === on ? 'on' : '', text);
      b.onclick = () => {
        settings.set(key, on);
        apply?.(on);
        this.render();
        this.onChanged();
      };
      return b;
    };
    seg.appendChild(mk('끔', false));
    seg.appendChild(mk('켬', true));
    r.appendChild(seg);
    return r;
  }

  choice(label, sub, key, options, apply) {
    const r = this.row(label, sub);
    const seg = el('div', 'seg');
    for (const [val, text] of options) {
      const b = el('button', settings.get(key) === val ? 'on' : '', text);
      b.onclick = () => {
        settings.set(key, val);
        apply?.(val);
        this.render();
        this.onChanged();
      };
      seg.appendChild(b);
    }
    r.appendChild(seg);
    return r;
  }

  /* ---- the screens ---- */
  render() {
    const list = $('setList');
    list.innerHTML = '';
    const add = (n) => list.appendChild(n);

    if (this.tab === 'aim') {
      add(this.range('마우스 감도', 'PC 시점 회전 속도', 'sensitivity', 0.0004, 0.008, 0.0001,
        (v) => (v * 1000).toFixed(1)));
      add(this.range('조준 중 감도', '조준(우클릭) 상태의 배율', 'sensitivityAds', 0.3, 1.2, 0.01,
        (v) => v.toFixed(2)));
      add(this.range('터치 감도', '모바일 시점 회전 속도', 'touchSensitivity', 0.001, 0.012, 0.0002,
        (v) => (v * 1000).toFixed(1)));
      add(this.toggle('상하 반전', '시점 Y축을 뒤집습니다', 'invertY'));
      add(el('div', 'hint', '— 조준 보정 (모바일) —'));
      add(this.toggle('조준 보정', 'PC에서는 기본으로 꺼져 있습니다', 'aimAssist'));
      add(this.range('보정 강도', '0이면 완전 수동, 1이면 최대 보조', 'aimAssistStrength', 0, 1, 0.05,
        (v) => Math.round(v * 100) + '%'));
      add(this.range('보정 범위', '화면 중앙에서 몇 도까지 대상으로 삼을지', 'aimAssistFov', 8, 40, 1,
        (v) => v + '°'));
      add(this.toggle('대상 유지', '고른 적을 조금 더 오래 붙잡습니다', 'aimAssistSticky'));
      add(el('div', 'hint', '보정은 조준을 도와줄 뿐, 대신 쏘지 않습니다. 직접 조준하면 항상 수동이 우선합니다.'));
      return;
    }

    if (this.tab === 'move') {
      add(this.toggle('앉기 전환식', '누를 때마다 앉기/서기', 'toggleCrouch'));
      add(this.toggle('달리기 전환식', '누를 때마다 달리기 유지', 'toggleSprint'));
      add(this.toggle('자동 달리기', '모바일에서 스틱을 끝까지 밀면 달립니다', 'autoSprint'));
      add(el('div', 'hint', '— 키 설정 —'));
      for (const action of Object.keys(DEFAULT_BINDS)) {
        add(this.bindRow(action));
      }
      return;
    }

    if (this.tab === 'video') {
      add(this.choice('그래픽 품질', '기기에 맞춰 자동으로 정해집니다', 'quality',
        Object.values(QUALITY_PRESETS).map((p) => [p.id, p.name]),
        (v) => settings.applyQuality(v)));
      add(this.range('해상도 배율', '낮출수록 프레임이 올라갑니다', 'renderScale', 0.5, 1, 0.05,
        (v) => Math.round(v * 100) + '%'));
      add(this.toggle('그림자', '저사양에서는 끄는 편이 낫습니다', 'shadows'));
      add(this.range('파티클', '이펙트 양', 'particles', 0.2, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      add(this.choice('프레임 제한', '발열과 배터리에 영향을 줍니다', 'fpsCap',
        [[0, '무제한'], [60, '60'], [45, '45'], [30, '30']]));
      add(this.range('시야각 (FOV)', '넓을수록 주변이 보입니다', 'fov', 70, 110, 1, (v) => v + '°'));
      add(this.range('화면 흔들림', '', 'shake', 0, 1.6, 0.1, (v) => Math.round(v * 100) + '%'));
      add(this.toggle('자동 성능 조절', '프레임이 낮으면 그래픽을 한 단계씩 낮춥니다', 'autoQuality'));
      add(this.toggle('FPS 표시', '', 'showFps'));
      add(this.toggle('미니맵', '', 'minimap'));
      add(this.toggle('피해 숫자', '', 'damageNumbers'));
      add(this.toggle('적중 표시', '', 'hitMarkers'));
      add(this.choice('조준점', '', 'crosshairStyle',
        [['cross', '십자'], ['dot', '점'], ['both', '십자+점']]));
      add(this.range('조준점 크기', '', 'crosshairSize', 0.6, 1.8, 0.1, (v) => v.toFixed(1)));
      add(this.colorRow());
      return;
    }

    if (this.tab === 'audio') {
      add(this.range('전체 볼륨', '', 'master', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      add(this.range('효과음', '', 'sfx', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      add(this.range('환경음 / 음악', '', 'music', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      return;
    }

    if (this.tab === 'touch') {
      add(this.range('버튼 크기', '', 'touchScale', 0.7, 1.4, 0.05, (v) => Math.round(v * 100) + '%'));
      add(this.range('버튼 투명도', '전투 화면을 가리지 않게', 'touchOpacity', 0.3, 1, 0.05,
        (v) => Math.round(v * 100) + '%'));
      add(this.toggle('왼손 모드', '스틱과 버튼을 좌우로 바꿉니다', 'leftHanded'));
      add(el('div', 'hint', '버튼 배치는 화면 크기에 맞춰 자동으로 조정됩니다. 가로 화면을 권장합니다.'));
      return;
    }
  }

  bindRow(action) {
    const r = this.row(BIND_LABELS[action] || action, (settings.data.binds[action] || []).join(', '));
    const b = el('button', 'bindbtn', keyName(settings.data.binds[action]?.[0]));
    b.onclick = () => {
      b.classList.add('wait');
      b.textContent = '키 입력…';
      this.capture = (code) => {
        settings.rebind(action, code);
        this.render();
        this.onChanged();
      };
      if (this.onCapture) this.onCapture(this.capture);
    };
    r.appendChild(b);
    return r;
  }

  colorRow() {
    const r = this.row('조준점 색', '');
    const input = document.createElement('input');
    input.type = 'color';
    input.value = settings.get('crosshairColor');
    input.style.cssText = 'width:48px;height:30px;background:none;border:1px solid var(--line2)';
    input.oninput = () => { settings.set('crosshairColor', input.value); this.onChanged(); };
    r.appendChild(input);
    return r;
  }
}

function keyName(code) {
  if (!code) return '없음';
  return code
    .replace('Key', '').replace('Digit', '').replace('Arrow', '')
    .replace('ControlLeft', 'CTRL').replace('ShiftLeft', 'SHIFT')
    .replace('Space', 'SPACE').replace('Escape', 'ESC').replace('Tab', 'TAB');
}

export { clamp };
