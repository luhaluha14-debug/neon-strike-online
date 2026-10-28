/* =============================================================================
   finding a browser to test in.  playwright normally resolves its own, but a
   container may place it anywhere, so this looks in the usual spots and only
   overrides when it actually finds one.  set CHROMIUM_PATH to force it.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const LAUNCH_ARGS = [
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--disable-dev-shm-usage'
];

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    for (const dir of entries.filter((d) => d.startsWith('chromium')).sort().reverse()) {
      for (const sub of ['chrome-linux64', 'chrome-linux', 'chrome-mac', 'chrome-win']) {
        for (const bin of ['chrome', 'headless_shell', 'chrome.exe']) {
          const p = path.join(root, dir, sub, bin);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return null;                 // let playwright resolve it itself
}

/* launches with the test flags; extra options are merged in */
async function launchChromium(chromium, options = {}) {
  const exe = findChromium();
  return chromium.launch(Object.assign(
    { args: LAUNCH_ARGS },
    exe ? { executablePath: exe } : {},
    options
  ));
}

module.exports = { findChromium, launchChromium, LAUNCH_ARGS };
