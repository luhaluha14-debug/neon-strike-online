import { Game } from './core/Game';
import type { QualityLevel } from './config';
import { initialQuality, loadAutoState, readDevice, type AutoState } from './core/AutoQuality';
import { loadSettings, parseQuality, saveSettings } from './core/Settings';

// Quality: ?quality=low|medium|high, else the level chosen in the settings,
// else automatic: from what the device can do (or what was measured here
// before), then measured while playing (core/AutoQuality.ts).
function pickQuality(saved: QualityLevel | null): { quality: QualityLevel; auto: AutoState | null } {
  const q = parseQuality(new URLSearchParams(location.search).get('quality'));
  if (q) return { quality: q, auto: null };
  if (saved) return { quality: saved, auto: null };
  const auto = loadAutoState();
  return { quality: initialQuality(readDevice(), auto), auto };
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

const picked = pickQuality(settings.quality);
const game = new Game(document.getElementById('app')!, picked.quality, settings, picked.auto);
void game.start();

if (import.meta.env.DEV) {
  const w = window as unknown as { game: Game; vmCheck?: () => unknown };
  w.game = game;
  // Dev-only first-person model checks (glove clipping, near-plane); not in production builds.
  void import('./debug/viewModelChecks').then((m) => {
    w.vmCheck = () => m.checkViewModel(game.viewModel);
  });
}
