import { Game } from './core/Game';
import type { QualityLevel } from './config';

// Quality can be forced with ?quality=low|medium|high; defaults to a
// conservative guess so low-end devices start playable.
function pickQuality(): QualityLevel {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const lowEnd = (navigator.hardwareConcurrency ?? 4) <= 4 || matchMedia('(pointer: coarse)').matches;
  return lowEnd ? 'low' : 'medium';
}

const game = new Game(document.getElementById('app')!, pickQuality());
void game.start();

if (import.meta.env.DEV) {
  (window as unknown as { game: Game }).game = game;
}
