/* =========================================================================
   NEON STRIKE online — client networking, lobby and room screens.
   The server owns health, kills, score, respawns and ultimate charge.
   This client moves its own player, reports its shots, and draws everyone
   else ~110 ms in the past, interpolated between server snapshots.
   ========================================================================= */
'use strict';

function netR2(v) { return Math.round(v * 100) / 100; }
function netR3(v) { return Math.round(v * 1000) / 1000; }

Object.assign(NET, {
  active: false,        // an online match is running
  ws: null, id: 0, connected: false, retry: 0,
  room: null,           // latest room info
  wantRoom: false,      // show the room screen when the next room info arrives
  myHero: 'assault', myTeam: null, mapId: 'plaza', startMsg: null,
  byId: {},             // server id -> fighter
  offset: null,         // server clock minus local clock (ms)
  ping: 0, sendT: 0, pingT: 0, infoT: 0, ultUsedAt: 0,
  claims: [], ends: [],
  INTERP: 110
});

/* ---------------- connection ---------------- */
NET.connect = function () {
  if (NET.ws && (NET.ws.readyState === 0 || NET.ws.readyState === 1)) return;
  if (location.protocol === 'file:') {
    NET.status('온라인은 서버 주소(http://…)로 접속했을 때만 됩니다. 파일을 직접 연 상태에서는 쓸 수 없습니다.', true);
    return;
  }
  NET.status('서버에 연결 중…');
  var ws = NET.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = function () {
    NET.connected = true; NET.retry = 0;
    NET.status('연결됨 — 빠른 매칭, 방 만들기, 코드 입장 중에서 고르세요');
    NET.send({ t: 'hello', name: NET.name() });
  };
  ws.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    var h = NET.on[m.t];
    if (h) { try { h(m); } catch (x) { if (window.console) console.error('net', m.t, x); } }
  };
  ws.onclose = function () {
    var wasActive = NET.active;
    NET.connected = false; NET.ws = null; NET.room = null;
    if (wasActive) NET.abortMatch('서버와 연결이 끊어졌습니다');
    var onScreens = !$('online').classList.contains('hide') || !$('room').classList.contains('hide');
    if (onScreens || wasActive) {
      show('online');
      NET.status('연결이 끊어졌습니다. 다시 연결 중…', true);
      setTimeout(NET.connect, Math.min(8000, 1000 * ++NET.retry));
    }
  };
};

NET.send = function (o) {
  if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(o));
};

NET.name = function () {
  var v = ($('onName').value || '').trim().slice(0, 12);
  try { if (v) localStorage.setItem('neonstrike.name', v); } catch (e) {}
  return v || 'PLAYER';
};
NET.status = function (msg, bad) {
  var el = $('onStatus');
  el.textContent = msg;
  el.style.color = bad ? '#ff8a5c' : '';
};
NET.err = function (msg) {
  $('onErr').textContent = msg || '';
  $('rmErr').textContent = msg || '';
};

/* send a lobby request (quick / create / join) */
NET.go = function (msg) {
  Snd.init(); sfxUI('click');
  if (!NET.connected) { NET.err('서버에 연결되어 있지 않습니다. 잠시 후 다시 시도하세요.'); NET.connect(); return; }
  NET.err('');
  NET.send({ t: 'hello', name: NET.name() });
  msg.hero = NET.myHero;
  NET.wantRoom = true;
  NET.send(msg);
};

NET.leave = function () {
  NET.send({ t: 'leave' });
  NET.room = null;
  NET.active = false;
  NET.restoreOfflineUI();
};

/* ---------------- lobby / room UI ---------------- */
NET.paintSeg = function (host, v) {
  for (var i = 0; i < host.children.length; i++) {
    host.children[i].classList.toggle('on', host.children[i].getAttribute('data-v') === v);
  }
};

NET.initUI = function () {
  try { $('onName').value = localStorage.getItem('neonstrike.name') || ''; } catch (e) {}
  function seg(host, items, onPick) {
    host.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it[1];
      b.setAttribute('data-v', it[0]);
      b.onclick = function () { sfxUI('click'); onPick(it[0]); };
      host.appendChild(b);
    });
  }
  var heroItems = HERO_LIST.map(function (h) { return [h, HEROES[h].name]; });
  seg($('onHero'), heroItems, function (v) { NET.myHero = v; NET.paintSeg($('onHero'), v); });
  seg($('rmHero'), heroItems, function (v) { NET.myHero = v; NET.send({ t: 'hero', hero: v }); });
  seg($('rmMode'), MODE_LIST.map(function (id) { return [id, MODES[id].name]; }), function (v) { NET.send({ t: 'settings', mode: v }); });
  seg($('rmMap'), MAP_LIST.concat(['random']).map(function (id) { return [id, MAPS[id] ? MAPS[id].name : 'RANDOM']; }),
    function (v) { NET.send({ t: 'settings', map: v }); });
  NET.paintSeg($('onHero'), NET.myHero);

  $('bOnline').onclick = function () { Snd.init(); sfxUI('click'); NET.err(''); show('online'); NET.connect(); };
  $('onBack').onclick = function () { sfxUI('back'); show('menu'); };
  $('onQuick').onclick = function () { NET.go({ t: 'quick' }); };
  $('onCreate').onclick = function () { NET.go({ t: 'create', mode: 'tdm', map: 'plaza' }); };
  $('onJoin').onclick = function () {
    var c = $('onCode').value.trim().toUpperCase();
    if (c.length !== 4) { NET.err('4자리 방 코드를 입력하세요'); return; }
    NET.go({ t: 'join', code: c });
  };
  $('onCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('onJoin').click(); });
  $('rmLeave').onclick = function () { sfxUI('back'); NET.leave(); show('online'); };
  $('rmStart').onclick = function () { sfxUI('click'); NET.send({ t: 'start' }); };
};

NET.renderRoom = function () {
  var r = NET.room;
  if (!r) return;
  var M = MODES[r.mode] || MODES.tdm, host = r.host === NET.id;
  var mapName = MAPS[r.map] ? MAPS[r.map].name : 'RANDOM';
  $('rmCode').textContent = r.pub ? 'QUICK MATCH' : r.code;
  var sub = M.name + ' · ' + mapName + ' · ' + r.ps.length + '/' + (r.mode === 'duel' ? 2 : 6) + '명';
  if (r.state === 'play') sub += ' · 경기 진행 중';
  else if (r.state === 'end') sub += ' · 경기 종료, 잠시 후 대기실로 돌아갑니다';
  else if (r.cd) sub += ' · ' + r.cd + '초 후 시작';
  else if (r.pub) sub += ' · 2명이 모이면 자동으로 시작';
  else sub += host ? ' · 친구에게 방 코드를 알려주세요' : ' · 방장이 시작하기를 기다리는 중';
  $('rmSub').textContent = sub;

  var canEdit = !r.pub && host && r.state === 'lobby';
  $('rmSettings').style.display = canEdit ? '' : 'none';
  $('rmStart').style.display = canEdit ? '' : 'none';
  $('rmStart').disabled = r.ps.length < 2;
  $('rmStart').textContent = r.ps.length < 2 ? 'WAITING FOR PLAYERS' : 'START';
  NET.paintSeg($('rmMode'), r.mode);
  NET.paintSeg($('rmMap'), r.map);
  var me = r.ps.find(function (p) { return p.id === NET.id; });
  if (me) { NET.myHero = me.hero; NET.paintSeg($('rmHero'), me.hero); }

  var list = $('rmPlayers');
  list.innerHTML = '';
  var groups = M.ffa
    ? [['PLAYERS', r.ps, '#cfe0ef']]
    : [['TEAM A', r.ps.filter(function (p) { return p.team === 'a'; }), '#63b0f5'],
       ['TEAM B', r.ps.filter(function (p) { return p.team === 'b'; }), '#ff8a5c']];
  groups.forEach(function (g) {
    var col = document.createElement('div');
    col.className = 'rmteam';
    var h = document.createElement('h5');
    h.textContent = g[0] + ' (' + g[1].length + ')';
    h.style.color = g[2];
    col.appendChild(h);
    g[1].forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'rmp' + (p.id === NET.id ? ' me' : '');
      var n = document.createElement('span');
      n.textContent = p.name + (p.id === r.host && !r.pub ? ' ★' : '') + (p.id === NET.id ? ' (나)' : '');
      var hh = document.createElement('span');
      hh.className = 'hh';
      hh.textContent = HEROES[p.hero] ? HEROES[p.hero].name : p.hero;
      row.appendChild(n); row.appendChild(hh);
      col.appendChild(row);
    });
    list.appendChild(col);
  });
  list.style.gridTemplateColumns = M.ffa ? '1fr' : '';
};

NET.restoreOfflineUI = function () {
  var ph = $('pause');
  ph.querySelector('h2').textContent = 'PAUSED';
  ph.querySelector('.sub').textContent = 'Click to resume';
  $('bAgain').textContent = 'PLAY AGAIN';
  $('bModes').style.display = '';
  $('netInfo').textContent = '';
};

NET.notice = function (text) {
  var el = document.createElement('div');
  el.className = 'fe';
  el.style.borderRightColor = '#9fb3c9';
  el.textContent = text;
  $('feed').appendChild(el);
  feedItems.push({ el: el, t: t_now + 3.5 });
};

/* ---------------- match setup ---------------- */
NET.beginMatch = function (m) {
  var me = m.ps.find(function (p) { return p.id === NET.id; });
  if (!me || !NET.room) return;
  NET.startMsg = m;
  NET.mapId = m.map;
  NET.myTeam = me.team;
  NET.offset = null;
  NET.claims = []; NET.ends = [];
  NET.active = true;
  startMatch(me.hero, m.mode);          // builds the roster through NET.buildRoster / NET.placeFighters
  teamScore = Object.assign({}, m.sc);
  refreshScore();
  var ph = $('pause');
  ph.querySelector('h2').textContent = 'ONLINE';
  ph.querySelector('.sub').textContent = '클릭하면 전투에 합류합니다 · 온라인 경기는 멈추지 않습니다';
  $('bAgain').textContent = 'BACK TO ROOM';
  $('bModes').style.display = 'none';
  // pointer lock needs a click from the player, and the match started from a network message
  enterPause();
};

NET.buildRoster = function () {
  NET.byId = {};
  NET.startMsg.ps.forEach(function (p) { NET.addFighter(p); });
};

NET.addFighter = function (p) {
  var mine = p.id === NET.id;
  var f = makeFighter(fighters.length, p.hero, p.team, mine, mine ? 'YOU' : p.name, mine || p.team === NET.myTeam);
  f.netId = p.id;
  f.snaps = [];
  fighters.push(f);
  NET.byId[p.id] = f;
  if (mine) player = f;
  return f;
};

NET.placeFighters = function () {
  NET.startMsg.ps.forEach(function (p) {
    var f = NET.byId[p.id];
    if (f) NET.applySpawnState(f, p);
  });
};

NET.applySpawnState = function (f, p) {
  f.pos.set(p.p[0], p.p[1], p.p[2]);
  f.vel.set(0, 0, 0);
  f.yaw = p.yaw; f.pitch = 0;
  f.aimDir.set(-Math.sin(f.yaw), 0, -Math.cos(f.yaw));
  f.maxHp = HEROES[f.heroId].hp;
  f.hp = p.hp;
  f.netSeq = p.sq;
  f.snaps = [];
  if (!p.alive) {
    f.alive = false; f.hp = 0; f.deathT = 0;
    f.respawnAt = t_now + 1;
    f.mesh.visible = false;
  }
};

NET.rebuildRemote = function (f, hero) {
  disposeGroup(f.mesh);
  scene.remove(f.mesh);
  f.heroId = hero; f.hero = HEROES[hero]; f.maxHp = f.hero.hp;
  buildFighterMesh(f);
};

NET.removeFighter = function (f) {
  disposeGroup(f.mesh);
  scene.remove(f.mesh);
  var i = fighters.indexOf(f);
  if (i >= 0) fighters.splice(i, 1);
  delete NET.byId[f.netId];
};

NET.abortMatch = function (msg) {
  NET.active = false;
  exitPointerLock();
  gameState = 'menu';
  $('hud').classList.remove('on');
  $('pause').classList.add('hide');
  $('dead').classList.remove('on');
  NET.restoreOfflineUI();
  show('online');
  NET.err(msg);
};

/* ---------------- per frame ---------------- */
NET.update = function () {
  var now = Date.now(), p = player;
  if (now - NET.sendT >= 50 && p && p.alive) {
    NET.sendT = now;
    NET.send({
      t: 'st', sq: p.netSeq, p: [netR2(p.pos.x), netR2(p.pos.y), netR2(p.pos.z)],
      y: netR3(p.yaw), pi: netR3(p.pitch), h: netR2(p.height), f: (p.crouch ? 2 : 0) | (p.ads ? 4 : 0)
    });
  }
  if (now - NET.pingT >= 2000) { NET.pingT = now; NET.send({ t: 'ping', c: now }); }
  if (now - NET.infoT >= 500) {
    NET.infoT = now;
    $('netInfo').textContent = 'PING ' + NET.ping + 'ms';
  }
};

/* draw a remote player where it was INTERP ms ago, between the two snapshots around that time */
NET.updateRemote = function (f) {
  var S = f.snaps;
  if (!S.length || NET.offset === null) return;
  var rt = Date.now() + NET.offset - NET.INTERP;
  var a = S[0], b = null;
  for (var i = S.length - 1; i >= 0; i--) {
    if (S[i].s <= rt) { a = S[i]; b = S[i + 1] || null; break; }
  }
  var s = a;
  if (b) {
    var k = clamp((rt - a.s) / Math.max(1, b.s - a.s), 0, 1);
    s = {
      x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k),
      yaw: dampAngle(a.yaw, b.yaw, k), pitch: lerp(a.pitch, b.pitch, k), h: lerp(a.h, b.h, k), fl: b.fl
    };
  }
  f.pos.set(s.x, s.y, s.z);
  f.yaw = s.yaw; f.pitch = s.pitch; f.height = s.h;
  f.aimDir.set(-Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), -Math.cos(s.yaw) * Math.cos(s.pitch));
  f.crouch = !!(s.fl & 2);
  f.ads = !!(s.fl & 4);
  f.barrierEnd = (s.fl & 8) ? t_now + 0.15 : 0;
  f.ultActive = !!(s.fl & 16);
  f.odEnd = (s.fl & 32) ? t_now + 0.15 : 0;
  f.reconEnd = (s.fl & 64) ? t_now + 0.15 : 0;
};

/* ---------------- outgoing combat ---------------- */
NET.hitClaim = function (v, head, dist) {
  if (v.netId) NET.claims.push({ id: v.netId, hd: head ? 1 : 0, d: netR2(dist), v: v });
};
NET.shotEnd = function (x, y, z) {
  NET.ends.push([netR2(x), netR2(y), netR2(z)]);
};
NET.sendFire = function () {
  var claims = NET.claims, head = false, flashed = [];
  camForward(VF);                       // the server checks hits lie along where we were looking
  NET.send({
    t: 'fire', e: NET.ends, d: [netR3(VF.x), netR3(VF.y), netR3(VF.z)],
    h: claims.map(function (c) { return { id: c.id, hd: c.hd, d: c.d }; })
  });
  // instant hit feedback; the damage numbers follow when the server confirms
  for (var i = 0; i < claims.length; i++) {
    if (claims[i].hd) head = true;
    if (flashed.indexOf(claims[i].v) < 0) { flashed.push(claims[i].v); flashFighter(claims[i].v, claims[i].hd ? 1 : 0.62); }
  }
  if (claims.length) {
    showHitmarker(head ? 'hs' : '');
    sfxHit(head);
    if (head) sfxHeadDing();
  }
  NET.claims = []; NET.ends = [];
};
NET.abil = function (k) {
  var msg = { t: 'abil', k: k };
  if (k === 'u') {
    NET.ultUsedAt = Date.now();
    if (player.heroId === 'sniper') { camForward(VF); msg.d = [netR3(VF.x), netR3(VF.y), netR3(VF.z)]; }
  }
  NET.send(msg);
};

/* ---------------- incoming ---------------- */
NET.on = {
  welcome: function (m) { NET.id = m.id; },
  pong: function (m) { NET.ping = Math.max(0, Date.now() - m.c); },
  err: function (m) { NET.wantRoom = false; NET.err(m.m); },

  room: function (m) {
    NET.room = m;
    if (NET.wantRoom) { NET.wantRoom = false; NET.err(''); show('room'); }
    NET.renderRoom();
  },

  start: function (m) { NET.beginMatch(m); },

  joined: function (m) {
    if (!NET.active || NET.byId[m.p.id]) return;
    var f = NET.addFighter(m.p);
    spawnFighter(f, true);
    NET.applySpawnState(f, m.p);
    if (!(m.p.team in teamScore)) teamScore[m.p.team] = 0;
    refreshScore();
    NET.notice(m.p.name + ' 입장');
  },

  left: function (m) {
    var f = NET.byId[m.id];
    if (!NET.active || !f) return;
    NET.notice(f.name + ' 퇴장');
    if (MODE.ffa) delete teamScore[f.team];
    NET.removeFighter(f);
    refreshScore();
  },

  spawn: function (m) {
    var f = NET.byId[m.id];
    if (!NET.active || !f) return;
    if (f.isPlayer) {
      if (m.hero !== f.heroId) switchPlayerHero(m.hero);
      spawnFighter(f);
      NET.applySpawnState(f, m);
      $('dead').classList.remove('on');
      deadOverlay = false;
      wantFireOnce = false;
      if (vm.group) vm.group.visible = true;
    } else {
      if (m.hero !== f.heroId) NET.rebuildRemote(f, m.hero);
      spawnFighter(f);
      NET.applySpawnState(f, m);
    }
  },

  snap: function (m) {
    if (!NET.active) return;
    var sample = m.s - Date.now();
    if (NET.offset === null || sample > NET.offset) NET.offset = sample;
    else NET.offset += (sample - NET.offset) * 0.05;
    for (var i = 0; i < m.ps.length; i++) {
      var r = m.ps[i], f = NET.byId[r[0]];
      if (!f) continue;
      if (f.isPlayer) {
        if (f.alive && (r[7] & 1)) f.hp = r[8];
        if (Date.now() - NET.ultUsedAt > 600) {
          var before = f.ult;
          f.ult = m.u;
          if (f.ult >= 100 && before < 100 && f.alive) sfxUltReady();
        }
        continue;
      }
      if (f.alive && (r[7] & 1)) f.hp = r[8];
      f.snaps.push({ s: m.s, x: r[1], y: r[2], z: r[3], yaw: r[4], pitch: r[5], h: r[6], fl: r[7] });
      if (f.snaps.length > 30) f.snaps.shift();
    }
  },

  pos: function (m) {
    if (!NET.active || !player || m.sq !== player.netSeq) return;
    player.pos.set(m.p[0], m.p[1], m.p[2]);
    player.vel.set(0, 0, 0);
  },

  shot: function (m) {
    var f = NET.byId[m.id];
    if (!NET.active || !f || f.isPlayer || !f.alive) return;
    muzzleWorld(f, V2);
    var sx = V2.x, sy = V2.y, sz = V2.z;
    if (f.heroId === 'assault') sfxRifle(f.pos);
    else if (f.heroId === 'sniper') sfxSniper(f.pos);
    else sfxShotgun(f.pos);
    FX.flash(sx, sy, sz, f.heroId === 'shock' ? 0.62 : 0.46);
    FEEL.muzzle(sx, sy, sz, f.heroId === 'sniper' ? 1.5 : 1, false);
    FX.shell(sx, sy, sz, f.yaw);
    f.lastShotAt = t_now;
    var eye = fighterEye(f);
    for (var i = 0; i < m.e.length; i++) {
      var e = m.e[i];
      FX.tracer(sx, sy, sz, e[0], e[1], e[2], m.u ? 0xff9d3d : (f.ally ? 0xffe6a8 : 0xffd0a0), m.e.length > 1 ? 0.03 : 0.05);
      FX.burst(e[0], e[1], e[2], 3, 0xe8dfc9, 4, 0.06, 1, 0.3);
      if (i === 0) {
        var dx = e[0] - f.pos.x, dy = e[1] - eye, dz = e[2] - f.pos.z;
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        checkWhiz(f.pos.x, eye, f.pos.z, dx / len, dy / len, dz / len, len);
        if (m.u) explode(e[0], e[1], e[2], 2.6, 22, f, false);      // visuals only online
      }
    }
  },

  dmg: function (m) {
    var v = NET.byId[m.v], a = NET.byId[m.a];
    if (!NET.active || !v) return;
    v.hp = m.hp;
    v.lastHitAt = t_now;
    if (a) v.lastHitBy = a;
    if (a && a.isPlayer) {
      showDamage(v.pos.x, v.pos.y + v.height * 0.8, v.pos.z, m.n, !!m.hd);
      player.stats.dmg += m.n;
      if (m.hd) player.stats.hs++;
    }
    if (v.isPlayer) {
      v.flinch = t_now + 0.22;
      onPlayerHurt(m.n, a);
      if (a) FEEL.arrow(a.pos.x, a.pos.z);
    } else if (!a || !a.isPlayer) {
      flashFighter(v, m.hd ? 1 : 0.62);
    }
  },

  kill: function (m) {
    teamScore = Object.assign({}, m.sc);
    refreshScore();
    var v = NET.byId[m.v], a = NET.byId[m.a] || null;
    if (!NET.active || !v || !v.alive) return;
    if (a) { a.streak = m.st; a.streakAt = t_now; }
    if (a && a.isPlayer) player.stats.kills++;
    killFighter(v, a, !!m.hd);            // effects, kill feed and banners; score is already set
  },

  abil: function (m) {
    var f = NET.byId[m.id];
    if (!NET.active || !f || f.isPlayer) return;
    var p = f.pos, hero = f.heroId;
    if (m.k === 'q') {
      sfxAbility(hero === 'assault' ? 'dash' : (hero === 'sniper' ? 'blink' : 'charge'), p);
      FX.burst(p.x, p.y + 0.8, p.z, 10, hero === 'sniper' ? 0x7fe0d0 : (hero === 'shock' ? 0xffb066 : 0x8fd0ff), 4.5, 0.09, 0.2, 0.4);
    } else if (m.k === 's') {
      sfxAbility(hero === 'assault' ? 'buff' : (hero === 'sniper' ? 'recon' : 'shield'), p);
      FX.ring(p.x, 0.05, p.z, 0.4, hero === 'sniper' ? 11 : 3.5, hero === 'assault' ? 0xffa11f : (hero === 'sniper' ? 0x7fe0d0 : 0x69c9d8), 0.5);
    } else if (m.k === 'u') {
      sfxUlt(hero, p);
      if (hero === 'sniper' && m.o && m.d) {
        muzzleWorld(f, V2);
        FX.beam(V2.x, V2.y, V2.z, m.o[0] + m.d[0] * 140, m.o[1] + m.d[1] * 140, m.o[2] + m.d[2] * 140, 0.3, 0xfff0b0, 0.5);
        FX.flash(V2.x, V2.y, V2.z, 1.3);
        sfxRail(p);
      } else if (hero === 'shock') {
        FX.ring(p.x, 0.05, p.z, 0.6, 10, 0xff8a2b, 0.6);
        FX.ring(p.x, 0.05, p.z, 0.3, 6, 0xffd24a, 0.4);
        FX.burst(p.x, p.y + 0.7, p.z, 26, 0xffb347, 13, 0.16, 0.7, 0.6);
        sfxBoom(p, true);
      } else {
        FX.ring(p.x, 0.05, p.z, 0.5, 5, 0xff8a2b, 0.6);
      }
    }
  },

  knock: function (m) {
    if (!NET.active || !player || !player.alive) return;
    player.vel.x += m.v[0];
    player.vel.z += m.v[2];
    player.vel.y = Math.max(player.vel.y, m.v[1]);
    player.onGround = false;
  },

  end: function (m) {
    if (!NET.active) return;
    var row = (m.stats || []).find(function (r) { return r[0] === NET.id; });
    if (row) player.stats = { kills: row[1], deaths: row[2], dmg: row[3], shots: row[4], hits: row[5], hs: row[6] };
    teamScore = Object.assign({}, m.sc);
    refreshScore();
    NET.active = false;
    endMatch(m.win === player.team);
    if (m.why === 'forfeit') $('endSc').textContent = '상대가 모두 나가서 경기가 끝났습니다';
  }
};

NET.initUI();
