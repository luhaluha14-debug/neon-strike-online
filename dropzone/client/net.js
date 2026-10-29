/* =========================================================================
   Online client: WebSocket connection + lobby screen (quick match, private
   rooms with a 4-letter code, team seats).  The match itself runs in the
   normal Session with an online "mirror" Match (see main.js / shared/net.js).
   ========================================================================= */
import { MODES } from '../shared/net.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class NetClient {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.ping = 0;
    this.open = false;
    this.id = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, 8000);
      ws.onopen = () => { clearTimeout(to); this.open = true; resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error('connect failed')); };
      ws.onclose = () => { this.open = false; clearInterval(this.pingT); this.emit('close', {}); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'pong') { const rtt = performance.now() - m.c; this.ping = this.ping ? this.ping * 0.7 + rtt * 0.3 : rtt; return; }
        if (m.t === 'welcome') this.id = m.id;
        this.emit(m.t, m);
      };
      this.pingT = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    });
  }
  on(t, fn) { this.handlers[t] = fn; }
  emit(t, m) { const h = this.handlers[t]; if (h) h(m); }
  send(m) { if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close() { clearInterval(this.pingT); this.handlers = {}; try { this.ws && this.ws.close(); } catch { /* ignore */ } this.open = false; }
}

/** lobby screen controller */
export class Lobby {
  constructor(app) {
    this.app = app;
    this.net = null;
    this.room = null;
    this.mode = app.settings.mode || 1;
    $('oCode').oninput = () => { $('oCode').value = $('oCode').value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); };
    for (const b of $('oMode').children) b.onclick = () => { this.mode = +b.dataset.v; this.paint(); };
    $('bQuick').onclick = () => this.act({ t: 'quick', mode: this.mode });
    $('bCreate').onclick = () => this.act({ t: 'create', mode: this.mode });
    $('bJoin').onclick = () => { const code = $('oCode').value; if (code.length === 4) this.act({ t: 'join', code }); else this.status('4글자 방 코드를 입력하세요'); };
    $('bStartRoom').onclick = () => this.net && this.net.send({ t: 'start' });
    $('bLeaveRoom').onclick = () => { if (this.net) this.net.send({ t: 'leave' }); this.room = null; this.paint(); };
    $('bOnlineBack').onclick = () => { this.close(); this.app.screen('menu'); };
    $('roomList').onclick = (e) => {
      const t = e.target.closest('[data-team]');
      if (t && this.net) this.net.send({ t: 'team', n: +t.dataset.team });
    };
  }

  get url() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`; }

  async open() {
    this.app.screen('online');
    this.paint();
    if (this.net && this.net.open) return;
    this.status('서버에 연결 중…');
    const net = this.net = new NetClient(this.url);
    try { await net.connect(); } catch { this.status('서버에 연결할 수 없습니다. 온라인은 게임 서버(npm start)로 접속했을 때만 됩니다.'); this.net = null; this.paint(); return; }
    net.send({ t: 'hello', name: this.app.settings.name, autoPickup: this.app.settings.autoPickup, autoReload: this.app.settings.autoReload });
    net.on('room', (m) => { this.room = m; this.paint(); });
    net.on('err', (m) => this.status(m.msg));
    net.on('start', (m) => { this.room = null; this.app.startOnline(net, m); });
    net.on('close', () => {
      this.room = null; this.net = null;
      if (this.app.session && this.app.session.online) this.app.session.onDisconnect();
      else { this.status('서버와 연결이 끊어졌습니다'); this.paint(); }
    });
    this.status('연결됨');
    this.paint();
  }

  act(msg) {
    if (!this.net) { this.open(); return; }
    this.app.audio.init();
    this.net.send({ t: 'hello', name: this.app.settings.name, autoPickup: this.app.settings.autoPickup, autoReload: this.app.settings.autoReload });
    this.net.send(msg);
  }

  close() { if (this.net) this.net.close(); this.net = null; this.room = null; }

  status(txt) { $('netStatus').textContent = txt; }

  paint() {
    for (const b of $('oMode').children) b.classList.toggle('on', +b.dataset.v === this.mode);
    const r = this.room;
    $('lobbyMain').classList.toggle('hide', !!r);
    $('lobbyRoom').classList.toggle('hide', !r);
    const connected = !!(this.net && this.net.open);
    for (const id of ['bQuick', 'bCreate', 'bJoin']) $(id).disabled = !connected;
    if (!r) return;
    const cd = r.state === 'countdown' ? ` · <b>${Math.ceil(r.startIn)}초 후 시작</b>` : '';
    $('roomHead').innerHTML = `${r.public ? '빠른 매칭' : `방 코드 <b class="code">${esc(r.code)}</b>`} · ${MODES[r.mode]} · ${r.players.length}명 (+봇 ${Math.max(0, r.fill - r.players.length)})${cd}`;
    const me = this.net && this.net.id;
    if (r.mode > 1) {
      const teams = new Map();
      for (const p of r.players) { if (!teams.has(p.team)) teams.set(p.team, []); teams.get(p.team).push(p); }
      const maxT = Math.max(0, ...teams.keys()) + 1;
      let h = '';
      for (let t = 1; t <= maxT; t++) {
        const list = teams.get(t) || [];
        h += `<div class="rteam" data-team="${t}"><em>팀 ${t}</em>${list.map((p) => `<span class="${p.id === me ? 'me' : ''}">${esc(p.name)}${p.id === r.host && !r.public ? ' ★' : ''}</span>`).join('')}${list.length < r.mode ? `<i>${r.public ? '빈 자리' : '여기로 이동'}</i>` : ''}</div>`;
      }
      $('roomList').innerHTML = h;
    } else {
      $('roomList').innerHTML = r.players.map((p) => `<div class="rteam"><span class="${p.id === me ? 'me' : ''}">${esc(p.name)}${p.id === r.host && !r.public ? ' ★' : ''}</span></div>`).join('');
    }
    const host = !r.public && r.host === me;
    $('bStartRoom').classList.toggle('hide', !host || r.state !== 'lobby');
    $('roomHint').textContent = r.public ? '인원이 모이면 자동으로 시작합니다. 빈 자리는 봇이 채웁니다.' : host ? '친구에게 방 코드를 알려주고, 모이면 시작을 누르세요.' : '방장이 시작하기를 기다리는 중…';
  }
}
