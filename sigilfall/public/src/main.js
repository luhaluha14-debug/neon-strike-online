/* =============================================================================
   SIGILFALL — entry point.  wires the engine, the input devices, the menus and
   a match together, and owns the transitions between them.
   ========================================================================== */
import { Engine } from './core/engine.js';
import { PerfWatch } from './core/perf.js';
import { settings } from './core/settings.js';
import { InputManager } from './input/inputManager.js';
import { KeyboardMouse } from './input/keyboardMouse.js';
import { TouchControls } from './mobile/touchControls.js';
import { Game } from './game/game.js';
import { Menus } from './ui/menus.js';
import { SettingsUI } from './ui/settingsUI.js';
import { OnlineUI } from './net/onlineUI.js';
import { $, el, Screens, toast } from './ui/screens.js';
import { CHARACTERS, getCharm } from './characters/roster.js';
import { MODES } from './game/rules.js';
import { MAP_LIST } from './world/mapData.js';
import { audio } from './audio/audio.js';

class App {
  constructor() {
    this.canvas = $('view');
    this.engine = new Engine(this.canvas);
    this.input = new InputManager();
    this.kbm = new KeyboardMouse(this.input, this.canvas);
    this.touch = new TouchControls(this.input, this.canvas);
    this.game = new Game(this.engine, this.input);

    this.cfg = {
      mode: 'tdm',
      map: 'shrine',
      character: settings.get('lastCharacter') || 'rift',
      botCount: 5,
      botLevel: 'normal',
      playerName: settings.get('name') || '나',
      charm: (settings.get('charms') || {})[settings.get('lastCharacter') || 'rift'] || 'none'
    };
    if (!CHARACTERS[this.cfg.character]) this.cfg.character = 'rift';

    this.menus = new Menus(this);
    this.settingsUI = new SettingsUI(() => this.onSettingsChanged());
    this.settingsUI.onCapture = (fn) => { this.kbm.rebindCapture = fn; };
    this.online = new OnlineUI(this);

    this.paused = false;
    this.inMatch = false;

    this.game.on('end', (r) => this.onMatchEnd(r));
    this.kbm.onLockChange = (locked) => {
      // losing the lock mid-fight means the player alt-tabbed or hit escape
      if (!locked && this.inMatch && !this.paused && !this.kbm.dragLook && settings.device.fine) this.pause();
    };
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      if (this.kbm.rebindCapture) return;
      if (this.inMatch) { this.paused ? this.resume() : this.pause(); }
    });
    this.buildHudButtons();
    this.perf = new PerfWatch(this.engine);
    this.engine.start();
    this.engine.add((dt) => {
      this.touch.update();
      if (this.inMatch && !this.paused) this.perf.update(dt);
    });
  }

  /* a pause tap for touch devices, since there is no Esc key */
  buildHudButtons() {
    const b = el('button', '', '⏸');
    b.style.cssText = 'position:absolute;right:14px;top:14px;width:40px;height:40px;' +
      'background:rgba(14,19,25,.7);border:1px solid var(--line2);border-radius:3px;' +
      'pointer-events:auto;font-size:15px;z-index:26';
    b.onclick = () => (this.paused ? this.resume() : this.pause());
    this.pauseBtn = b;
    $('hud').appendChild(b);
    this.syncPauseButton();
  }
  syncPauseButton() {
    const mobile = settings.device.isMobile || settings.device.touch;
    this.pauseBtn.style.display = mobile && this.inMatch ? 'block' : 'none';
  }

  /* ------------------------------------------------------------- flow */
  /* the charm follows whichever character is selected */
  applyLoadout() {
    const charms = settings.get('charms') || {};
    this.cfg.charm = charms[this.cfg.character] || 'none';
    $('menuCharmName').textContent = getCharm(this.cfg.charm).name;
    if (this.net?.connected) this.net.sendCharacter(this.cfg.character, this.cfg.charm);
    if (this.game.active && this.game.player) this.game.player.pendingCharm = this.cfg.charm;
  }

  boot() {
    const d = settings.device;
    const kind = d.isPhone ? '모바일' : d.isTablet ? '태블릿' : 'PC';
    const how = d.touch
      ? (d.fine ? '터치 + 마우스/키보드' : '터치 조작 + 조준 보정')
      : '마우스 + 키보드';
    $('deviceHint').textContent = `${kind} 감지 · 그래픽 ${settings.preset.name} · ${how}`;
    $('menuCharName').textContent = CHARACTERS[this.cfg.character].latin;
    this.applyLoadout();
    Screens.reset('screenMenu');
    // the first tap or click is what lets the audio engine start
    const unlock = () => { audio.init(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);
  }

  startMatch(extra = {}) {
    audio.init();
    const cfg = Object.assign({}, this.cfg, extra);
    if (cfg.map === 'random') cfg.map = MAP_LIST[(Math.random() * MAP_LIST.length) | 0];
    if (cfg.mode === 'duel') cfg.botCount = Math.min(cfg.botCount, 1);
    cfg.botCount = Math.min(cfg.botCount, MODES[cfg.mode].maxPlayers - 1);

    Screens.hideAll();
    this.inMatch = true;
    this.paused = false;
    this.perf.reset();
    this.game.start(cfg);
    this.enterInput();
    this.syncPauseButton();
  }

  enterInput() {
    if (settings.device.touch) this.touch.setEnabled(true, this.game);
    // only a device with a real pointer gets asked for pointer lock
    if (settings.device.fine) this.kbm.requestLock();
    this.input.enabled = true;
  }
  exitInput() {
    this.touch.setEnabled(false);
    this.kbm.exitLock();
    this.input.clear();
  }

  pause() {
    if (!this.inMatch || this.paused) return;
    this.paused = true;
    this.game.paused = !this.game.net;         // online matches keep running
    this.exitInput();
    Screens.show('screenPause', false);
  }

  resume() {
    if (!this.inMatch) return;
    this.paused = false;
    this.game.paused = false;
    Screens.hideAll();
    this.enterInput();
  }

  quitMatch() {
    this.game.net?.leave();
    this.game.stop();
    this.inMatch = false;
    this.paused = false;
    this.exitInput();
    this.syncPauseButton();
    Screens.reset('screenMenu');
  }

  playAgain() {
    if (this.game.net) { this.online.backToRoom(); return; }
    this.game.stop();
    this.startMatch();
  }

  toMenu() {
    this.quitMatch();
  }

  onMatchEnd(result) {
    this.exitInput();
    const me = this.game.player;
    let scoreText = '';
    const entries = Object.entries(this.game.scores).sort((a, b) => b[1] - a[1]);
    if (entries.length) scoreText = entries.map(([, v]) => v).join(' : ');
    setTimeout(() => {
      this.menus.renderEnd({
        winTeam: result.winTeam, why: result.why, fighters: result.fighters, me, scoreText
      });
      this.paused = true;
    }, 900);
  }

  /* ----------------------------------------------------------- settings */
  openSettings() {
    this.settingsUI.open();
    Screens.show('screenSettings');
    $('btnSetBack').onclick = () => {
      this.kbm.rebindCapture = null;
      Screens.back();
    };
  }

  onSettingsChanged() {
    this.engine.onResize();
    this.touch.layout();
    if (this.game.active) {
      this.game.hud.buildCrosshair();
      $('minimap').classList.toggle('hide', !settings.get('minimap'));
      $('fps').classList.toggle('hide', !settings.get('showFps'));
    }
  }

  onCharacterChosen(id) {
    // in a room the pick is just a preference; in a match it lands on respawn
    this.applyLoadout();
    if (this.net?.connected) this.net.sendCharacter(id, this.cfg.charm);
    $('roomCharName').textContent = CHARACTERS[id].latin;
    if (!this.game.active) return;
    const p = this.game.player;
    p.pendingCharacter = id;
    if (!p.alive) toast('부활할 때 ' + CHARACTERS[id].latin + ' 로 바뀝니다', 'good');
    else toast('다음 부활부터 적용됩니다');
  }

  openOnline() { this.online.open(); }

  /* the server said go: same match code path, with the net client attached */
  startOnlineMatch(msg) {
    audio.init();
    Screens.hideAll();
    this.inMatch = true;
    this.paused = false;
    this.perf.reset();
    this.game.start({
      mode: msg.mode, map: msg.map, character: this.cfg.character,
      botCount: 0, playerName: this.cfg.playerName, online: this.net
    });
    this.net.attach(this.game, msg);
    this.enterInput();
    this.syncPauseButton();
    $('netstat').classList.remove('hide');
  }
}

const app = new App();
window.SIGILFALL = app;
app.boot();
export default app;
