"""Adds the online hooks to public/index.html (run once; aborts without writing if anything does not match)."""
import sys, io, os

PATH = os.path.join(os.path.dirname(__file__), '..', 'public', 'index.html')
with io.open(PATH, 'r', encoding='utf-8', newline='') as fh:
    src = fh.read()
CRLF = '\r\n' in src
if CRLF:
    src = src.replace('\r\n', '\n')
if 'NET.buildRoster' in src:
    print('already patched'); sys.exit(0)

errors, count = [], 0

def rep(old, new, label):
    global src, count
    n = src.count(old)
    if n != 1:
        errors.append('%s: expected 1 match, found %d' % (label, n)); return
    src = src.replace(old, new); count += 1

def rep_between(start, end, new, label):
    global src, count
    if src.count(start) != 1:
        errors.append('%s: start marker found %d times' % (label, src.count(start))); return
    a = src.index(start); b = src.find(end, a)
    if b < 0:
        errors.append('%s: end marker not found' % label); return
    src = src[:a] + new + src[b:]; count += 1

# ---------------------------------------------------------------- CSS
rep("/* ---------- map select ---------- */",
r"""/* ---------- online lobby ---------- */
.onpanel{width:min(640px,92vw)}
.onrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.onrow label{width:78px;flex:0 0 auto;font-size:13px;color:#cfe0ef}
.onrow .seg{flex:1;flex-wrap:wrap}
.onrow input{flex:1;min-width:0;background:#141b23;border:1px solid #2f3d4e;border-radius:6px;color:#eef3f8;
  font:inherit;font-size:15px;padding:9px 12px;-webkit-user-select:text;user-select:text}
.onbtns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;padding:14px 0}
.onbtns .btn,.onrow .btn{margin:0}
.rmcode{color:var(--acc);letter-spacing:.3em;-webkit-user-select:text;user-select:text}
#rmPlayers{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.rmteam h5{font-size:11px;letter-spacing:.2em;margin-bottom:6px}
.rmp{display:flex;justify-content:space-between;gap:8px;background:#1b232e;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:13px}
.rmp .hh{color:#9fb3c9;font-size:11px;letter-spacing:.1em}
.rmp.me{box-shadow:inset 0 0 0 1px var(--acc)}
.btn:disabled{opacity:.5;cursor:default;transform:none}
#netInfo{position:absolute;top:6px;right:10px;font-size:11px;color:#7f93a8;font-family:monospace}
@media (max-width:560px){ #rmPlayers{grid-template-columns:1fr} }

/* ---------- map select ---------- */""",
    'css')

# ---------------------------------------------------------------- HTML
rep('    <button class="btn p" id="bPlay">PLAY</button>\n',
    '    <button class="btn p" id="bPlay">PLAY</button>\n'
    '    <button class="btn p" id="bOnline">ONLINE</button>\n',
    'menu online button')

rep('  <div id="fps"></div>\n',
    '  <div id="fps"></div>\n  <div id="netInfo"></div>\n',
    'hud net info')

rep('<!-- ============ PAUSE ============ -->',
r"""<!-- ============ ONLINE LOBBY ============ -->
<div class="screen hide" id="online">
  <div class="wrap">
    <h2 class="t">ONLINE</h2><div class="sub" id="onStatus">서버에 연결 중…</div>
    <div class="panel onpanel">
      <div class="onrow"><label>닉네임</label><input id="onName" maxlength="12" placeholder="PLAYER" autocomplete="off"></div>
      <div class="onrow"><label>영웅</label><div class="seg" id="onHero"></div></div>
      <div class="onbtns">
        <button class="btn p sm" id="onQuick">빠른 매칭</button>
        <button class="btn sm" id="onCreate">방 만들기</button>
      </div>
      <div class="onrow"><label>방 코드</label><input id="onCode" maxlength="4" placeholder="ABCD" autocomplete="off" style="text-transform:uppercase"><button class="btn sm" id="onJoin" style="min-width:110px">입장</button></div>
      <div class="note" id="onErr" style="color:#ff8a5c"></div>
    </div>
    <button class="btn sm" style="margin-top:16px" id="onBack">BACK</button>
  </div>
</div>

<!-- ============ ONLINE ROOM ============ -->
<div class="screen hide" id="room">
  <div class="wrap">
    <h2 class="t">ROOM <span class="rmcode" id="rmCode">----</span></h2>
    <div class="sub" id="rmSub"></div>
    <div class="panel onpanel">
      <div id="rmSettings">
        <div class="onrow"><label>모드</label><div class="seg" id="rmMode"></div></div>
        <div class="onrow"><label>맵</label><div class="seg" id="rmMap"></div></div>
      </div>
      <div class="onrow"><label>내 영웅</label><div class="seg" id="rmHero"></div></div>
      <div id="rmPlayers"></div>
      <div class="note" id="rmErr" style="color:#ff8a5c"></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn sm" id="rmLeave">LEAVE</button>
      <button class="btn p sm" id="rmStart">START</button>
    </div>
  </div>
</div>

<!-- ============ PAUSE ============ -->""",
    'online screens')

rep("</script>\n<script>\n(function () {\n  var srcs = [",
    "</script>\n<script src=\"net.js\"></script>\n<script>\n(function () {\n  var srcs = [",
    'net.js include')

# ---------------------------------------------------------------- globals
rep("function chance(p60, dt) { return Math.random() < 1 - Math.pow(1 - p60, dt * 60); }\n",
    "function chance(p60, dt) { return Math.random() < 1 - Math.pow(1 - p60, dt * 60); }\n"
    "function escHtml(s) {\n"
    "  return String(s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; });\n"
    "}\n"
    "/* online state; net.js fills in the rest.  NET.active is true only during an online match */\n"
    "var NET = { active: false };\n",
    'NET global')

rep("  var ids = ['menu', 'how', 'select', 'end', 'settings', 'modes'];",
    "  var ids = ['menu', 'how', 'select', 'end', 'settings', 'modes', 'online', 'room'];",
    'show ids')

# player names come from other people now
rep("'\">' + att.name + '</span>'", "'\">' + escHtml(att.name) + '</span>'", 'feed attacker name')
rep("'\">' + vic.name + '</span>'", "'\">' + escHtml(vic.name) + '</span>'", 'feed victim name')

# ---------------------------------------------------------------- combat hooks
rep("function applyDamage(v, dmg, attacker, head, hx, hy, hz, dir) {\n  if (!v.alive || gameState !== 'play') return;\n",
    "function applyDamage(v, dmg, attacker, head, hx, hy, hz, dir) {\n"
    "  if (NET.active) return;              // online, the server decides all damage\n"
    "  if (!v.alive || gameState !== 'play') return;\n",
    'applyDamage guard')

rep("function addUlt(f, amt) {\n  if (f.ultActive) return;\n",
    "function addUlt(f, amt) {\n  if (f.ultActive || NET.active) return;   // online charge comes from the server\n",
    'addUlt guard')

rep("  sfxBoom(V2.set(x, y, z), big);\n",
    "  sfxBoom(V2.set(x, y, z), big);\n  if (NET.active) return;              // splash damage is applied by the server\n",
    'explode guard')

rep("  stop: function (ms, scale) {\n",
    "  stop: function (ms, scale) {\n    if (NET.active) return;            // slowing the local clock would desync other players\n",
    'hit stop online')

rep("    applyDamage(victim, dmg, f, head, ex, ey, ez, dir);\n",
    "    applyDamage(victim, dmg, f, head, ex, ey, ez, dir);\n"
    "    if (NET.active && f.isPlayer) NET.hitClaim(victim, head, dist);\n",
    'hitscan claim')

rep("  var surfIdx = OUTN.i;\n",
    "  if (NET.active && f.isPlayer) NET.shotEnd(ex, ey, ez);\n  var surfIdx = OUTN.i;\n",
    'hitscan end point')

rep("    hitscan(f, origin, V3, w, i === 0);\n  }\n",
    "    hitscan(f, origin, V3, w, i === 0);\n  }\n  if (NET.active && f.isPlayer) NET.sendFire();\n",
    'tryFire send')

rep("  if (attacker && attacker !== v) {\n"
    "    attacker.stats.kills++;\n"
    "    addUlt(attacker, 22);\n"
    "    addTeamScore(attacker.team);\n"
    "    if (t_now - attacker.streakAt < 4.2) attacker.streak++; else attacker.streak = 1;\n"
    "    attacker.streakAt = t_now;\n",
    "  if (attacker && attacker !== v) {\n"
    "    if (!NET.active) {                  // online these come from the server\n"
    "      attacker.stats.kills++;\n"
    "      addUlt(attacker, 22);\n"
    "      addTeamScore(attacker.team);\n"
    "      if (t_now - attacker.streakAt < 4.2) attacker.streak++; else attacker.streak = 1;\n"
    "      attacker.streakAt = t_now;\n"
    "    }\n",
    'killFighter scoring')

rep("  if (v.isPlayer) onPlayerDeath(attacker);\n  checkMatchEnd();\n",
    "  if (v.isPlayer) onPlayerDeath(attacker);\n  if (!NET.active) checkMatchEnd();\n",
    'killFighter match end')

# ---------------------------------------------------------------- input
rep("  else if (k === 'KeyQ') useQ(player);\n  else if (k === 'KeyE') useUlt(player);\n  else if (k === 'KeyX') useShift(player);\n",
    "  else if (k === 'KeyQ') { if (useQ(player) && NET.active) NET.abil('q'); }\n"
    "  else if (k === 'KeyE') { if (useUlt(player) && NET.active) NET.abil('u'); }\n"
    "  else if (k === 'KeyX') { if (useShift(player) && NET.active) NET.abil('s'); }\n",
    'ability keys')

rep("  pendingHero = HERO_LIST[(i + 1) % HERO_LIST.length];\n",
    "  pendingHero = HERO_LIST[(i + 1) % HERO_LIST.length];\n  if (NET.active) NET.send({ t: 'hero', hero: pendingHero });\n",
    'hero swap online')

# ---------------------------------------------------------------- match flow
rep("  fighters.length = 0;\n  var order = HERO_LIST, oi = order.indexOf(heroId), f, h;\n",
    "  fighters.length = 0;\n  if (NET.active) { NET.buildRoster(); return; }\n  var order = HERO_LIST, oi = order.indexOf(heroId), f, h;\n",
    'buildRoster online')

rep("  loadMap(chosenMap === 'random' ? pick(MAP_LIST) : chosenMap);   // RANDOM rolls again every match\n",
    "  loadMap(NET.active ? NET.mapId : (chosenMap === 'random' ? pick(MAP_LIST) : chosenMap));   // RANDOM rolls again every match\n",
    'startMatch map')

rep("    spawnFighter(ff, true, slot);\n  }\n  player.pitch = 0;\n",
    "    spawnFighter(ff, true, slot);\n  }\n"
    "  if (NET.active) NET.placeFighters();   // the server decides who stands where, and who is still dead\n"
    "  player.pitch = 0;\n",
    'startMatch placement')

rep("    if (t_now >= f.respawnAt) {\n      if (pendingHero !== f.heroId) switchPlayerHero(pendingHero);\n",
    "    if (t_now >= f.respawnAt && !NET.active) {   // online respawns arrive from the server\n"
    "      if (pendingHero !== f.heroId) switchPlayerHero(pendingHero);\n",
    'player respawn')

rep_between("  if (gameState === 'play' || gameState === 'end') {\n    t_now += dt; t_dt = dt;\n",
            "  if (renderer && (gameState === 'play'",
r"""  // an online match never pauses: the menu overlay opens but the world keeps running
  var simOn = gameState === 'play' || (NET.active && gameState === 'pause');
  if (simOn || gameState === 'end') {
    t_now += dt; t_dt = dt;
    if (simOn) {
      updatePlayer(dt);
      if (NET.active) NET.update(dt);
      for (var i = 0; i < fighters.length; i++) {
        var f = fighters[i];
        if (!f.alive) {
          updateFighterMesh(f);
          if (t_now >= f.respawnAt && !f.isPlayer && !NET.active) spawnFighter(f);
          continue;
        }
        if (!f.isPlayer) { if (NET.active) NET.updateRemote(f, dt); else updateAI(f, dt); }
        updateFighterMesh(f);
      }
      FEEL.update(dt);
      updateHUD();
      updateEnemyBars();
      var crit = player.alive && player.hp / player.maxHp < 0.3;
      if (crit !== lowHpOn) { lowHpOn = crit; $('lowhp').classList.toggle('on', crit); }
    }
    FX.update(dt);
    if (!simOn) FEEL.update(dt);
    updateDamageNumbers(dt);
    updateHitmarker(dt);
    updateHurt(dt);
    updateFlash(dt);
    updateFeed();
  }

""",
    'frame loop')

rep("  $('bAgain').onclick = function () { sfxUI('click'); startMatch(chosenHero, chosenMode); };\n",
    "  $('bAgain').onclick = function () {\n"
    "    sfxUI('click');\n"
    "    if (NET.room) { gameState = 'menu'; $('hud').classList.remove('on'); show('room'); NET.renderRoom(); return; }\n"
    "    startMatch(chosenHero, chosenMode);\n"
    "  };\n",
    'play again')
rep("  $('bModes').onclick = function () { sfxUI('click'); gameState = 'menu'; $('hud').classList.remove('on'); buildModeCards(); show('modes'); };\n",
    "  $('bModes').onclick = function () { sfxUI('click'); if (NET.room) NET.leave(); gameState = 'menu'; $('hud').classList.remove('on'); buildModeCards(); show('modes'); };\n",
    'change mode')
rep("  $('bMenu').onclick = function () { sfxUI('back'); gameState = 'menu'; $('hud').classList.remove('on'); show('menu'); };\n",
    "  $('bMenu').onclick = function () { sfxUI('back'); if (NET.room) NET.leave(); gameState = 'menu'; $('hud').classList.remove('on'); show('menu'); };\n",
    'main menu')
rep("  $('bQuit').onclick = function () {\n    gameState = 'menu'; $('pause').classList.add('hide'); $('hud').classList.remove('on'); show('menu');\n  };\n",
    "  $('bQuit').onclick = function () {\n"
    "    var online = NET.active;\n"
    "    if (online) NET.leave();\n"
    "    gameState = 'menu'; $('pause').classList.add('hide'); $('hud').classList.remove('on');\n"
    "    show(online ? 'online' : 'menu');\n"
    "  };\n",
    'quit match')

if errors:
    print('PATCH ABORTED, file not written:')
    for e in errors: print('  -', e)
    sys.exit(1)
out = src.replace('\n', '\r\n') if CRLF else src
with io.open(PATH, 'w', encoding='utf-8', newline='') as fh:
    fh.write(out)
print('applied %d replacements' % count)
