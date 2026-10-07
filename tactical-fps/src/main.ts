import { Game } from './core/Game';
import type { QualityLevel } from './config';
import { loadSettings, parseQuality, saveSettings } from './core/Settings';

// Quality: ?quality=low|medium|high, else the start-screen choice, else a
// conservative guess so low-end devices start playable.
function pickQuality(saved: QualityLevel | null): QualityLevel {
  const q = parseQuality(new URLSearchParams(location.search).get('quality'));
  if (q) return q;
  if (saved) return saved;
  const lowEnd = (navigator.hardwareConcurrency ?? 4) <= 4 || matchMedia('(pointer: coarse)').matches;
  return lowEnd ? 'low' : 'medium';
}

// One link for every map: the chosen map is remembered locally. An old
// `?map=` link still works once and is then removed from the address bar.
const settings = loadSettings();
const params = new URLSearchParams(location.search);
const mapParam = params.get('map');
if (mapParam) {
  settings.mapId = mapParam;
  saveSettings(settings);
  params.delete('map');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}

const game = new Game(document.getElementById('app')!, pickQuality(settings.quality), settings);
void game.start();

if (import.meta.env.DEV) {
  (window as unknown as { game: Game }).game = game;
}
