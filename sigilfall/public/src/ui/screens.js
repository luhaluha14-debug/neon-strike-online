/* =============================================================================
   screen stack and toasts.  every full page panel lives in index.html; this
   just decides which one is visible and remembers where "back" goes.
   ========================================================================== */
const ids = ['screenBoot', 'screenMenu', 'screenPlay', 'screenChars', 'screenSettings',
  'screenHow', 'screenLobby', 'screenRoom', 'screenPause', 'screenEnd'];

export const $ = (id) => document.getElementById(id);

export const Screens = {
  current: 'screenBoot',
  history: [],
  onChange: null,

  show(id, remember = true) {
    if (remember && this.current && this.current !== id) this.history.push(this.current);
    for (const s of ids) {
      const el = $(s);
      if (el) el.classList.toggle('hide', s !== id);
    }
    this.current = id;
    document.body.classList.toggle('ingame', id === 'none');
    this.onChange?.(id);
  },

  /* hides every screen: used while a match is running */
  hideAll() {
    for (const s of ids) $(s)?.classList.add('hide');
    this.current = 'none';
    document.body.classList.add('ingame');
    this.onChange?.('none');
  },

  back(fallback = 'screenMenu') {
    const prev = this.history.pop();
    this.show(prev || fallback, false);
  },

  reset(id = 'screenMenu') {
    this.history.length = 0;
    this.show(id, false);
  },

  get isMenu() { return this.current !== 'none'; }
};

let toastTimer = null;
export function toast(msg, kind = '', ms = 2200) {
  const wrap = $('toast');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { while (wrap.children.length > 3) wrap.firstChild.remove(); }, 100);
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
