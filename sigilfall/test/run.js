/* =============================================================================
   test runner.  the game data, geometry and server rules are checked against
   exactly the modules the browser loads.     npm test
   ========================================================================== */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { state } from './harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['world.test.js', 'characters.test.js', 'rules.test.js', 'server.test.js'];

for (const file of SUITES) {
  process.stdout.write('\n' + file + '\n');
  await import(pathToFileURL(path.join(HERE, file)).href);
}

process.stdout.write(`\n${state.pass} passed, ${state.fail} failed\n`);
process.exit(state.fail ? 1 : 0);
