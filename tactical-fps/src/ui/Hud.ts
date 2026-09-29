import { PLAYER_CONFIG } from '../config';
import './hud.css';

/**
 * Minimal DOM HUD. Values are only written to the DOM when they change so the
 * HUD costs nothing per frame.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly healthValue: HTMLSpanElement;
  private readonly healthBar: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayStatus: HTMLParagraphElement;
  private readonly overlayButton: HTMLButtonElement;
  private lastHealth = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="crosshair" aria-hidden="true">
        <span class="ch-line ch-top"></span><span class="ch-line ch-bottom"></span>
        <span class="ch-line ch-left"></span><span class="ch-line ch-right"></span>
      </div>
      <div class="vitals">
        <div class="vitals-label">HP</div>
        <div class="vitals-main">
          <span class="health-value">100</span>
          <div class="health-track"><div class="health-bar"></div></div>
        </div>
      </div>
      <div class="stats"></div>
      <div class="overlay">
        <div class="panel">
          <h1>TACTICAL FPS <span>PROTOTYPE</span></h1>
          <p class="status">맵 불러오는 중…</p>
          <button type="button" disabled>클릭하여 시작</button>
          <dl class="controls">
            <dt>W A S D</dt><dd>이동</dd>
            <dt>마우스</dt><dd>시점</dd>
            <dt>Space</dt><dd>점프</dd>
            <dt>Shift</dt><dd>걷기 (조용히)</dd>
            <dt>C / Ctrl</dt><dd>앉기</dd>
            <dt>R</dt><dd>스폰으로 복귀</dd>
            <dt>F3</dt><dd>성능 정보</dd>
            <dt>Esc</dt><dd>일시정지</dd>
          </dl>
        </div>
      </div>`;
    parent.appendChild(this.root);

    this.healthValue = this.root.querySelector('.health-value')!;
    this.healthBar = this.root.querySelector('.health-bar')!;
    this.stats = this.root.querySelector('.stats')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.overlayStatus = this.root.querySelector('.status')!;
    this.overlayButton = this.root.querySelector('button')!;
  }

  onStart(handler: () => void): void {
    this.overlayButton.addEventListener('click', handler);
  }

  setLoading(text: string): void {
    this.overlayStatus.textContent = text;
    this.overlayButton.disabled = true;
  }

  setReady(text = '준비 완료'): void {
    this.overlayStatus.textContent = text;
    this.overlayButton.disabled = false;
  }

  setError(text: string): void {
    this.overlayStatus.textContent = text;
    this.overlayStatus.classList.add('error');
    this.overlayButton.disabled = true;
  }

  setPaused(paused: boolean): void {
    this.overlay.classList.toggle('hidden', !paused);
    this.root.classList.toggle('playing', !paused);
  }

  setHealth(value: number): void {
    const hp = Math.max(0, Math.round(value));
    if (hp === this.lastHealth) return;
    this.lastHealth = hp;
    this.healthValue.textContent = String(hp);
    this.healthBar.style.transform = `scaleX(${hp / PLAYER_CONFIG.maxHealth})`;
    this.root.classList.toggle('low-health', hp <= 25);
  }

  setStatsVisible(visible: boolean): void {
    this.stats.classList.toggle('visible', visible);
  }

  get statsVisible(): boolean {
    return this.stats.classList.contains('visible');
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
