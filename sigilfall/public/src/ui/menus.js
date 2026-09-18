/* =============================================================================
   the menus: roster, match setup, how to play and the end screen.  they only
   read and write the app config; starting a match is the app's job.
   ========================================================================== */
import { $, el, Screens } from './screens.js';
import { CHARACTERS, CHARACTER_LIST, abilityOf, CHARMS, CHARM_LIST, getCharm } from '../characters/roster.js';
import { MAPS, MAP_LIST } from '../world/mapData.js';
import { MODES, MODE_LIST } from '../game/rules.js';
import { settings } from '../core/settings.js';
import { escapeHtml } from './hud.js';

const SLOT_KEYS = [['lmb', '좌클릭 / 공격'], ['rmb', '우클릭 / 보조'], ['q', 'Q'], ['a1', '1'], ['a2', '2'], ['ult', 'E · 영역']];

export class Menus {
  constructor(app) {
    this.app = app;
    this.previewChar = app.cfg.character;
    this.bind();
  }

  bind() {
    const app = this.app;
    $('btnPlay').onclick = () => { this.renderSetup(); Screens.show('screenPlay'); };
    $('btnChars').onclick = () => { this.openChars(); };
    $('btnSettings').onclick = () => { app.openSettings(); };
    $('btnHow').onclick = () => { this.renderHow(); Screens.show('screenHow'); };
    $('btnLoadout').onclick = () => this.openLoadout();
    $('btnLoadoutBack').onclick = () => { app.applyLoadout(); Screens.back(); };
    $('btnOnline').onclick = () => app.openOnline();

    $('btnPlayBack').onclick = () => Screens.back();
    $('btnHowBack').onclick = () => Screens.back();
    $('btnCharsBack').onclick = () => Screens.back();
    $('btnStartMatch').onclick = () => app.startMatch();

    $('btnPickChar').onclick = () => {
      app.cfg.character = this.previewChar;
      settings.set('lastCharacter', this.previewChar);
      $('menuCharName').textContent = CHARACTERS[this.previewChar].latin;
      app.onCharacterChosen?.(this.previewChar);
      Screens.back();
    };

    $('btnResume').onclick = () => app.resume();
    $('btnPauseSettings').onclick = () => app.openSettings();
    $('btnPauseChar').onclick = () => this.openChars();
    $('btnQuit').onclick = () => app.quitMatch();
    $('btnAgain').onclick = () => app.playAgain();
    $('btnEndMenu').onclick = () => app.toMenu();
  }

  /* ------------------------------------------------------------- roster */
  openChars() {
    this.previewChar = this.app.cfg.character;
    this.renderRoster();
    Screens.show('screenChars');
  }

  renderRoster() {
    const wrap = $('roster');
    wrap.innerHTML = '';
    for (const id of CHARACTER_LIST) {
      const c = CHARACTERS[id];
      const card = el('button', 'card' + (id === this.previewChar ? ' on' : ''));
      card.appendChild(el('div', 'glyph', c.latin[0]));
      card.appendChild(el('div', 'ltn', c.latin));
      card.appendChild(el('div', 'nm', c.name));
      card.appendChild(el('div', 'role', c.role));
      card.appendChild(el('div', 'bl', c.blurb));
      const bar = el('div', 'bar');
      for (let i = 0; i < 3; i++) bar.appendChild(el('i', i < c.difficulty ? 'on' : ''));
      card.appendChild(bar);
      card.onclick = () => { this.previewChar = id; this.renderRoster(); };
      wrap.appendChild(card);
    }
    this.renderKit(this.previewChar);
    $('pickName').textContent = CHARACTERS[this.previewChar].name;
  }

  renderKit(id) {
    const wrap = $('kit');
    wrap.innerHTML = '';
    for (const [slot, keyLabel] of SLOT_KEYS) {
      const spec = abilityOf(id, slot);
      if (!spec) continue;
      const row = el('div', 'k');
      row.appendChild(el('div', 'key', keyLabel.split(' ')[0]));
      const body = el('div');
      body.appendChild(el('div', 'kn', spec.name + '  ' + spec.latin));
      body.appendChild(el('div', 'kd', spec.desc || ''));
      row.appendChild(body);
      const meta = [];
      if (spec.cd) meta.push('쿨 ' + spec.cd + '초');
      if (spec.cost) meta.push('주력 ' + spec.cost);
      if (spec.hpCost) meta.push('체력 ' + spec.hpCost);
      if (spec.dmg) meta.push('피해 ' + spec.dmg + (spec.dmgMax ? '~' + spec.dmgMax : ''));
      if (spec.dur && spec.kind === 'domain') meta.push(spec.dur + '초');
      row.appendChild(el('div', 'meta', meta.join('\n')));
      wrap.appendChild(row);
    }
  }

  /* ------------------------------------------------------------ loadout */
  openLoadout() {
    this.loadoutChar = this.app.cfg.character;
    this.renderLoadout();
    Screens.show('screenLoadout');
  }

  renderLoadout() {
    const charms = settings.get('charms') || {};
    const picker = $('loadoutChars');
    picker.innerHTML = '';
    for (const id of CHARACTER_LIST) {
      const b = el('button', 'btn' + (id === this.loadoutChar ? ' primary' : ' ghost'));
      b.style.flex = '1 1 120px';
      b.appendChild(el('span', 't', CHARACTERS[id].latin));
      b.appendChild(el('span', 'd', getCharm(charms[id]).name));
      b.onclick = () => { this.loadoutChar = id; this.renderLoadout(); };
      picker.appendChild(b);
    }

    const wrap = $('charms');
    wrap.innerHTML = '';
    const current = charms[this.loadoutChar] || 'none';
    for (const id of CHARM_LIST) {
      const c = CHARMS[id];
      const card = el('button', 'card' + (id === current ? ' on' : ''));
      card.appendChild(el('div', 'glyph', c.icon));
      card.appendChild(el('div', 'ltn', c.latin));
      card.appendChild(el('div', 'nm', c.name));
      card.appendChild(el('div', 'bl', c.desc));
      card.onclick = () => {
        const next = Object.assign({}, settings.get('charms') || {});
        next[this.loadoutChar] = id;
        settings.set('charms', next);
        this.renderLoadout();
        this.app.applyLoadout();
      };
      wrap.appendChild(card);
    }

    const sum = $('loadoutSummary');
    sum.innerHTML = '';
    const ch = CHARACTERS[this.loadoutChar];
    const mods = getCharm(current).mods;
    const rows = [
      ['체력', Math.round(ch.hp * (mods.hp || 1)) + (mods.hp ? ' (+' + Math.round((mods.hp - 1) * 100) + '%)' : '')],
      ['이동 속도', (ch.speed * (mods.speed || 1)).toFixed(2) + ' m/s' + (mods.speed ? ' (+' + Math.round((mods.speed - 1) * 100) + '%)' : '')],
      ['주력 회복', Math.round(ch.energy.regen * (mods.regen || 1)) + '/초' + (mods.regen ? ' (+' + Math.round((mods.regen - 1) * 100) + '%)' : '')],
      ['이동기 쿨다운', Math.max(0.5, ch.q.cd * (mods.cdMul || 1) + (mods.cdQ || 0)).toFixed(1) + '초'],
      ['영역 지속', (ch.ult.dur + (mods.domainDur || 0)).toFixed(1) + '초']
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'opt');
      r.appendChild(el('span', 'lbl', k));
      r.appendChild(el('span', 'val', v));
      sum.appendChild(r);
    }
  }

  /* -------------------------------------------------------------- setup */
  renderSetup() {
    const cfg = this.app.cfg;
    const list = $('setupList');
    list.innerHTML = '';

    list.appendChild(this.segRow('모드', MODES[cfg.mode].desc,
      MODE_LIST.map((m) => [m, MODES[m].name]), cfg.mode, (v) => {
        cfg.mode = v;
        if (v === 'duel') cfg.botCount = 1;
        this.renderSetup();
      }));

    list.appendChild(this.segRow('맵', MAPS[cfg.map] ? MAPS[cfg.map].desc : '무작위',
      MAP_LIST.map((m) => [m, MAPS[m].name]).concat([['random', '무작위']]), cfg.map, (v) => {
        cfg.map = v;
        this.renderSetup();
      }));

    const maxBots = MODES[cfg.mode].maxPlayers - 1;
    list.appendChild(this.segRow('봇 수', '함께 싸울 인원',
      Array.from({ length: maxBots + 1 }, (_, i) => [i, String(i)]), Math.min(cfg.botCount, maxBots), (v) => {
        cfg.botCount = Number(v);
        this.renderSetup();
      }));

    list.appendChild(this.segRow('봇 난이도', '조준 정확도, 반응 속도, 술식 사용 빈도가 달라집니다',
      [['easy', '쉬움'], ['normal', '보통'], ['hard', '어려움']], cfg.botLevel, (v) => {
        cfg.botLevel = v;
        this.renderSetup();
      }));

    list.appendChild(this.segRow('술사', CHARACTERS[cfg.character].blurb,
      CHARACTER_LIST.map((c) => [c, CHARACTERS[c].latin]), cfg.character, (v) => {
        cfg.character = v;
        settings.set('lastCharacter', v);
        $('menuCharName').textContent = CHARACTERS[v].latin;
        this.renderSetup();
      }));
  }

  segRow(label, sub, options, current, onPick) {
    const r = el('div', 'opt');
    const l = el('span', 'lbl');
    l.appendChild(document.createTextNode(label));
    if (sub) l.appendChild(el('small', '', sub));
    r.appendChild(l);
    const seg = el('div', 'seg');
    for (const [val, text] of options) {
      const b = el('button', String(val) === String(current) ? 'on' : '', text);
      b.onclick = () => onPick(val);
      seg.appendChild(b);
    }
    r.appendChild(seg);
    return r;
  }

  /* ------------------------------------------------------------- how to */
  renderHow() {
    const list = $('howList');
    const mobile = settings.device.isMobile;
    list.innerHTML = '';
    const rows = mobile ? [
      ['왼쪽 화면', '가상 스틱으로 이동. 끝까지 밀면 달리기'],
      ['오른쪽 화면', '드래그로 시점 회전, 짧게 탭하면 사격'],
      ['공격 / 보조', '오른쪽 큰 버튼과 그 위 버튼'],
      ['Q · 1 · 2', '이동기와 술식. 쿨다운이 버튼에 표시됩니다'],
      ['E', '궁극기. 게이지가 차면 테두리가 빛납니다'],
      ['조준 보정', '설정 → 조준에서 강도와 범위를 바꿀 수 있습니다']
    ] : [
      ['WASD', '이동 · Shift 달리기 · Space 점프 · Ctrl/C 앉기'],
      ['마우스', '시점 · 좌클릭 기본 공격 · 우클릭 보조 공격'],
      ['Q', '이동기 / 회피'],
      ['1 · 2', '술식'],
      ['E', '궁극기 — 영역 전개'],
      ['R', '재집중 (주력 회복)'],
      ['Tab', '점수판 · Esc 메뉴']
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'opt');
      const key = el('div', 'key');
      key.style.cssText = 'flex:0 0 92px;padding:6px 8px;background:#0e1319;border:1px solid var(--line2);border-radius:2px;font-size:12px;text-align:center;color:var(--ember2)';
      key.textContent = k;
      r.appendChild(key);
      r.appendChild(el('span', 'lbl', v));
      list.appendChild(r);
    }
    const tip = el('div', 'hint',
      '기본 공격으로 압박하고, 술식으로 각도를 만들고, 궁극기로 영역을 열어 마무리하세요. ' +
      '강한 술식일수록 선딜과 쿨다운이 깁니다.');
    list.appendChild(tip);
  }

  /* ---------------------------------------------------------------- end */
  renderEnd(result) {
    const app = this.app;
    const me = result.me;
    const title = $('endTitle');
    let outcome = 'draw', text = '무승부';
    if (result.winTeam && me) {
      if (result.winTeam === me.team) { outcome = 'win'; text = '승리'; }
      else { outcome = 'lose'; text = '패배'; }
    }
    title.className = outcome;
    title.textContent = text;
    $('endSub').textContent = result.why === 'forfeit' ? '상대가 나갔습니다'
      : `${MODES[app.cfg.mode].name} · ${result.scoreText || ''}`;

    const rows = result.fighters.slice().sort((a, b) => b.stats.kills - a.stats.kills || b.stats.damage - a.stats.damage);
    const html = ['<table style="width:100%;border-collapse:collapse" class="mono">',
      '<thead><tr><th style="text-align:left">이름</th><th>술사</th><th>K</th><th>D</th><th>피해</th><th>명중</th></tr></thead><tbody>'];
    for (const f of rows) {
      const acc = f.stats.shots ? Math.round((f.stats.hits / f.stats.shots) * 100) : 0;
      html.push(`<tr class="${me && f.team === me.team ? 'a' : 'b'}${f === me ? ' me' : ''}">` +
        `<td style="text-align:left">${escapeHtml(f.name)}</td><td>${f.char.latin}</td>` +
        `<td>${f.stats.kills}</td><td>${f.stats.deaths}</td><td>${Math.round(f.stats.damage)}</td><td>${acc}%</td></tr>`);
    }
    html.push('</tbody></table>');
    const board = $('endBoard');
    board.innerHTML = html.join('');
    board.querySelectorAll('th,td').forEach((c) => {
      c.style.padding = '7px 9px';
      c.style.borderBottom = '1px solid var(--line)';
      c.style.fontSize = '13px';
      if (!c.style.textAlign) c.style.textAlign = 'right';
    });
    Screens.show('screenEnd');
  }
}
