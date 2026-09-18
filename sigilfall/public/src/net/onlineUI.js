/* =============================================================================
   the online screens: lobby (quick match, create, join by code, public rooms)
   and the room itself.  the NetClient does the talking; this only draws.
   ========================================================================== */
import { $, el, Screens, toast } from '../ui/screens.js';
import { NetClient } from './client.js';
import { CHARACTERS, CHARACTER_LIST } from '../characters/roster.js';
import { MAPS, MAP_LIST } from '../world/mapData.js';
import { MODES, MODE_LIST } from '../game/rules.js';
import { settings } from '../core/settings.js';
import { escapeHtml } from '../ui/hud.js';

export class OnlineUI {
  constructor(app) {
    this.app = app;
    this.net = new NetClient(app);
    app.net = this.net;
    this.bound = false;
    this.wire();
  }

  wire() {
    const net = this.net;
    net.on('room', (r) => this.renderRoom(r));
    net.on('rooms', (list) => this.renderRoomList(list));
    net.on('leftRoom', () => { if (!this.app.inMatch) Screens.show('screenLobby', false); });
    net.on('matchStart', (m) => this.app.startOnlineMatch(m));
    net.on('end', (m) => this.onEnd(m));
    net.on('close', () => {
      if (this.app.inMatch) {
        toast('서버와 연결이 끊어졌습니다', 'bad', 3200);
        this.app.quitMatch();
      } else if (Screens.current === 'screenRoom' || Screens.current === 'screenLobby') {
        Screens.reset('screenMenu');
        toast('연결이 끊어졌습니다', 'bad');
      }
    });
  }

  async open() {
    const app = this.app;
    $('inName').value = app.cfg.playerName === '나' ? (settings.get('name') || '') : app.cfg.playerName;
    if (!this.bound) this.bindButtons();
    Screens.show('screenLobby');
    $('roomList').innerHTML = '<div class="hint">서버에 연결하는 중…</div>';
    try {
      await this.net.connect();
      this.net.listRooms();
      this.refreshTimer = setInterval(() => {
        if (Screens.current === 'screenLobby' && this.net.connected) this.net.listRooms();
        else if (Screens.current !== 'screenLobby') clearInterval(this.refreshTimer);
      }, 4000);
    } catch (e) {
      $('roomList').innerHTML = '';
      toast('서버에 연결하지 못했습니다. npm start 로 서버가 켜져 있는지 확인하세요.', 'bad', 4200);
      Screens.back();
    }
  }

  bindButtons() {
    this.bound = true;
    const app = this.app, net = this.net;
    const name = () => {
      const v = ($('inName').value || '').trim().slice(0, 12) || '술사';
      app.cfg.playerName = v;
      settings.set('name', v);
      net.setName(v);
      return v;
    };
    $('inName').addEventListener('change', name);
    $('btnQuick').onclick = () => { name(); net.quick(app.cfg.character, null); };
    $('btnCreate').onclick = () => { name(); net.create(app.cfg.mode, app.cfg.map, app.cfg.character); };
    $('btnJoin').onclick = () => {
      name();
      const code = ($('inCode').value || '').trim().toUpperCase();
      if (code.length !== 4) return toast('4자리 코드를 입력하세요', 'bad');
      net.join(code, app.cfg.character);
    };
    $('inCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('btnLobbyBack').onclick = () => { net.close(); Screens.back(); };
    $('btnRoomLeave').onclick = () => { net.leave(); Screens.show('screenLobby', false); };
    $('btnRoomStart').onclick = () => net.startMatch();
    $('btnRoomChar').onclick = () => {
      this.app.menus.openChars();
    };
  }

  renderRoomList(list) {
    const wrap = $('roomList');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.appendChild(el('div', 'hint', '열려 있는 공개 방이 없습니다. 빠른 참가를 누르면 새로 만들어집니다.'));
      return;
    }
    for (const r of list) {
      const row = el('div', 'roomrow');
      row.appendChild(el('span', 'code', r.code));
      row.appendChild(el('span', '', MODES[r.mode] ? MODES[r.mode].name : r.mode));
      row.appendChild(el('span', '', r.map === 'random' ? '무작위' : (MAPS[r.map] ? MAPS[r.map].name : r.map)));
      row.appendChild(el('span', '', `${r.n}/${r.max}`));
      const go = el('button', 'go', r.state === 'play' ? '난입' : '참가');
      go.onclick = () => this.net.join(r.code, this.app.cfg.character);
      row.appendChild(go);
      wrap.appendChild(row);
    }
  }

  renderRoom(r) {
    if (this.app.inMatch) return;
    Screens.show('screenRoom', Screens.current !== 'screenRoom');
    $('roomCode').textContent = r.code;
    $('roomCharName').textContent = CHARACTERS[this.app.cfg.character].latin;

    const isHost = r.host === this.net.selfId;
    const setup = $('roomSetup');
    setup.innerHTML = '';
    const seg = (label, options, current, onPick, enabled) => {
      const row = el('div', 'opt');
      row.appendChild(el('span', 'lbl', label));
      const s = el('div', 'seg');
      for (const [val, text] of options) {
        const b = el('button', String(val) === String(current) ? 'on' : '', text);
        if (enabled) b.onclick = () => onPick(val);
        else b.style.opacity = '0.6';
        s.appendChild(b);
      }
      row.appendChild(s);
      return row;
    };
    const canEdit = isHost && !r.pub && r.state === 'lobby';
    setup.appendChild(seg('모드', MODE_LIST.map((m) => [m, MODES[m].name]), r.mode,
      (v) => this.net.setSettings({ mode: v }), canEdit));
    setup.appendChild(seg('맵', MAP_LIST.map((m) => [m, MAPS[m].name]).concat([['random', '무작위']]), r.map,
      (v) => this.net.setSettings({ map: v }), canEdit));
    setup.appendChild(seg('봇 채우기', [[true, '켬'], [false, '끔']], r.fill !== false,
      (v) => this.net.setSettings({ fill: v === true || v === 'true' }), canEdit));

    const wrap = $('roomPlayers');
    wrap.innerHTML = '';
    for (const p of r.ps) {
      const row = el('div', 'prow ' + (p.team === 'a' ? 'a' : 'b'));
      row.appendChild(el('span', '', p.name + (p.id === this.net.selfId ? ' (나)' : '')));
      row.appendChild(el('span', 'tag', CHARACTERS[p.ch] ? CHARACTERS[p.ch].latin : p.ch));
      if (p.bot) row.appendChild(el('span', 'tag', 'BOT'));
      if (p.id === r.host) row.appendChild(el('span', 'tag', '방장'));
      wrap.appendChild(row);
    }

    const start = $('btnRoomStart');
    if (r.pub) {
      $('roomHint').textContent = r.cd
        ? `${r.cd}초 뒤 자동으로 시작합니다 · 코드 ${r.code}`
        : '다른 플레이어를 기다리는 중…';
      start.style.display = 'none';
    } else {
      $('roomHint').textContent = isHost
        ? `친구에게 코드 ${r.code} 를 알려주세요. 준비되면 시작을 누르세요.`
        : `방장이 시작하기를 기다리는 중 · 코드 ${r.code}`;
      start.style.display = isHost ? '' : 'none';
    }
  }

  onEnd(m) {
    const app = this.app;
    if (!app.game.active) return;
    app.game.state = 'ended';
    app.exitInput();
    const me = app.game.player;
    // rebuild the stat table from what the server counted
    const fighters = m.stats.map((s) => ({
      name: s.name, team: s.team, char: CHARACTERS[s.ch] || CHARACTERS.rift,
      stats: { kills: s.k, deaths: s.d, damage: s.dmg, shots: s.s, hits: s.h, heads: s.hs }
    }));
    const mine = fighters.find((f) => f.name === me.name && f.team === me.team) || null;
    setTimeout(() => {
      app.menus.renderEnd({
        winTeam: m.win, why: m.why, fighters, me: mine,
        scoreText: Object.values(m.sc || {}).join(' : ')
      });
      app.paused = true;
    }, 900);
  }

  backToRoom() {
    this.app.game.stop();
    this.app.inMatch = false;
    this.app.paused = false;
    this.app.exitInput();
    this.app.syncPauseButton();
    if (this.net.connected && this.net.room) this.renderRoom(this.net.room);
    else Screens.reset('screenMenu');
  }
}

export { escapeHtml };
