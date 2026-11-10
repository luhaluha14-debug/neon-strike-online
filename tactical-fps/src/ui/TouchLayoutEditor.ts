import type { TouchInput } from '../input/TouchInput';
import { emptyLayout, LAYOUT_IDS, LAYOUT_LABELS, overlaps, PLACEMENT_LIMITS, relativeOf, safeInsets, type LayoutId, type Placement, type TouchLayout } from '../input/TouchLayout';
import './touchLayout.css';

// 버튼 배치 편집: the touch controls shown as they are in play (the HUD behind them), each with a
// handle to drag; a selected control gets size and opacity sliders. Overlapping controls are marked,
// nothing leaves the safe area (TouchLayout keeps every control inside it), and nothing typed here
// reaches the game: the touch controls take no input while the editor is open, and only one finger
// drags at a time (a second finger is ignored until the first lifts). 저장 keeps the layout, 취소
// puts back what was there, 기본 배치 returns every control to the built-in arrangement.

export interface LayoutEditorHandlers {
  onSave(layout: TouchLayout | null): void;
  onClose(): void;
}

export class TouchLayoutEditor {
  readonly root: HTMLDivElement;
  private touch: TouchInput | null = null;
  private original: TouchLayout | null = null;
  private draft: TouchLayout = emptyLayout();
  private defaultOpacity = 0.7;
  private selected: LayoutId | null = null;
  private drag: { pointer: number; id: LayoutId; dx: number; dy: number } | null = null;
  private readonly handles = new Map<LayoutId, HTMLDivElement>();
  private readonly nameEl: HTMLElement;
  private readonly sizeIn: HTMLInputElement;
  private readonly opacityIn: HTMLInputElement;
  private readonly sizeOut: HTMLOutputElement;
  private readonly opacityOut: HTMLOutputElement;
  private readonly warnEl: HTMLElement;
  private handlers: LayoutEditorHandlers | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tl-editor';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', '버튼 배치 편집');
    this.root.innerHTML = `
      <div class="tl-handles"></div>
      <div class="tl-panel">
        <div class="tl-head">
          <span class="tl-title">버튼 배치 편집</span>
          <span class="tl-name">버튼을 끌어 옮기세요</span>
        </div>
        <div class="tl-sliders">
          <label class="tl-field"><span>크기</span><input type="range" class="tl-size" min="${PLACEMENT_LIMITS.size[0]}" max="${PLACEMENT_LIMITS.size[1]}" step="0.05" disabled /><output class="tl-size-out">—</output></label>
          <label class="tl-field"><span>투명도</span><input type="range" class="tl-opacity" min="${PLACEMENT_LIMITS.opacity[0]}" max="${PLACEMENT_LIMITS.opacity[1]}" step="0.05" disabled /><output class="tl-opacity-out">—</output></label>
        </div>
        <p class="tl-warn" role="status" aria-live="polite"></p>
        <div class="tl-actions">
          <button type="button" class="btn tl-reset">기본 배치</button>
          <button type="button" class="btn tl-cancel">취소</button>
          <button type="button" class="btn btn-primary tl-save">저장</button>
        </div>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends Element>(s: string) => this.root.querySelector<T>(s)!;
    this.nameEl = q('.tl-name');
    this.sizeIn = q('.tl-size');
    this.opacityIn = q('.tl-opacity');
    this.sizeOut = q('.tl-size-out');
    this.opacityOut = q('.tl-opacity-out');
    this.warnEl = q('.tl-warn');
    const handles = q<HTMLDivElement>('.tl-handles');
    for (const id of LAYOUT_IDS) {
      const h = document.createElement('div');
      h.className = 'tl-handle';
      h.dataset.id = id;
      h.innerHTML = `<span>${LAYOUT_LABELS[id]}</span>`;
      handles.appendChild(h);
      this.handles.set(id, h);
    }
    handles.addEventListener('pointerdown', this.onDown);
    handles.addEventListener('pointermove', this.onMove);
    handles.addEventListener('pointerup', this.onUp);
    handles.addEventListener('pointercancel', this.onUp);
    handles.addEventListener('lostpointercapture', this.onUp);
    // No browser gestures (scroll, zoom, long press) while editing.
    this.root.addEventListener('touchstart', (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement || e.preventDefault(), { passive: false });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.sizeIn.addEventListener('input', () => this.setSelected('size', Number(this.sizeIn.value)));
    this.opacityIn.addEventListener('input', () => this.setSelected('opacity', Number(this.opacityIn.value)));
    q('.tl-reset').addEventListener('click', () => this.reset());
    q('.tl-cancel').addEventListener('click', () => this.close(false));
    q('.tl-save').addEventListener('click', () => this.close(true));
    window.addEventListener('resize', () => this.root.hidden || this.refresh());
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** The layout being edited (tests). */
  get current(): TouchLayout {
    return this.draft;
  }

  /** Opens over the touch controls (already shown in their preview state by the caller). */
  show(touch: TouchInput, layout: TouchLayout | null, defaultOpacity: number, handlers: LayoutEditorHandlers): void {
    this.touch = touch;
    this.original = layout;
    this.draft = layout ? structuredClone(layout) : emptyLayout();
    this.defaultOpacity = defaultOpacity;
    this.handlers = handlers;
    this.selected = null;
    this.drag = null;
    this.root.hidden = false;
    touch.applyLayout(this.draft);
    this.select(null);
    this.refresh();
  }

  /** 기본 배치: every control back to the built-in arrangement (saved only on 저장). */
  reset(): void {
    this.draft = emptyLayout();
    this.touch?.applyLayout(this.draft);
    this.select(null);
    this.refresh();
  }

  close(save: boolean): void {
    if (!this.open) return;
    const t = this.touch;
    if (save) this.handlers?.onSave(Object.keys(this.draft.controls).length ? structuredClone(this.draft) : null);
    else t?.applyLayout(this.original);
    this.drag = null;
    this.root.hidden = true;
    this.handlers?.onClose();
    this.touch = null;
  }

  /** Handles over the controls where they are now; overlapping ones marked and named. */
  private refresh(): void {
    const t = this.touch;
    if (!t) return;
    const rects: DOMRect[] = [];
    const ids: LayoutId[] = [];
    for (const id of LAYOUT_IDS) {
      const r = t.layoutElement(id).getBoundingClientRect();
      const h = this.handles.get(id)!;
      h.hidden = r.width === 0;
      if (h.hidden) continue;
      h.style.left = `${r.left}px`;
      h.style.top = `${r.top}px`;
      h.style.width = `${r.width}px`;
      h.style.height = `${r.height}px`;
      h.classList.remove('warn');
      rects.push(r);
      ids.push(id);
    }
    const hit = overlaps(rects);
    const names = new Set<LayoutId>();
    for (const [a, b] of hit) {
      names.add(ids[a]);
      names.add(ids[b]);
    }
    for (const id of names) this.handles.get(id)!.classList.add('warn');
    this.warnEl.textContent = names.size ? `겹치는 버튼: ${[...names].map((id) => LAYOUT_LABELS[id]).join(' · ')}` : '';
    this.root.classList.toggle('has-warn', names.size > 0);
  }

  private select(id: LayoutId | null): void {
    this.selected = id;
    for (const [k, h] of this.handles) h.classList.toggle('selected', k === id);
    const p = id ? this.placementOf(id) : null;
    this.nameEl.textContent = id ? LAYOUT_LABELS[id] : '버튼을 끌어 옮기세요';
    this.sizeIn.disabled = this.opacityIn.disabled = !p;
    if (p) {
      this.sizeIn.value = String(p.size);
      this.opacityIn.value = String(p.opacity);
    }
    this.sizeOut.textContent = p ? `${Math.round(p.size * 100)}%` : '—';
    this.opacityOut.textContent = p ? `${Math.round(p.opacity * 100)}%` : '—';
  }

  /** The control's placement in the draft, or where the default arrangement shows it now. */
  private placementOf(id: LayoutId): Placement {
    const p = this.draft.controls[id];
    if (p) return p;
    const r = this.touch!.layoutElement(id).getBoundingClientRect();
    const rel = relativeOf(r.left + r.width / 2, r.top + r.height / 2, safeInsets());
    return { x: rel.x, y: rel.y, size: 1, opacity: this.defaultOpacity };
  }

  private setSelected(k: 'size' | 'opacity', v: number): void {
    const id = this.selected;
    if (!id) return;
    const p = { ...this.placementOf(id), [k]: Math.min(PLACEMENT_LIMITS[k][1], Math.max(PLACEMENT_LIMITS[k][0], v)) };
    this.draft.controls[id] = p;
    this.touch?.applyLayout(this.draft);
    this.select(id);
    this.refresh();
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    // One control at a time: a second finger does nothing until the first lifts.
    if (this.drag) return;
    const h = (e.target as HTMLElement).closest<HTMLElement>('.tl-handle');
    if (!h) return;
    const id = h.dataset.id as LayoutId;
    const r = h.getBoundingClientRect();
    this.drag = { pointer: e.pointerId, id, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
    this.draft.controls[id] = this.placementOf(id);
    this.select(id);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer
    }
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    e.preventDefault();
    const rel = relativeOf(e.clientX - d.dx, e.clientY - d.dy, safeInsets());
    this.draft.controls[d.id] = { ...this.placementOf(d.id), x: rel.x, y: rel.y };
    this.touch?.applyLayout(this.draft);
    this.refresh();
  };

  private onUp = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointer) this.drag = null;
  };
}
