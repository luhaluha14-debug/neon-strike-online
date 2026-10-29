// Runs every tests/*.test.mjs one file at a time (each file loads maps in a
// browser; running them in parallel only slows everything down).
// Explicit file list: works on every Node version the project supports.
//   npm test                      all files
//   npm test -- ui body           only files whose name contains "ui" or "body"

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const dir = fileURLToPath(new URL('.', import.meta.url));
const filters = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs') && (filters.length === 0 || filters.some((s) => f.includes(s))))
  .sort()
  .map((f) => dir + f);

if (files.length === 0) {
  console.error('no test files match', filters);
  process.exit(1);
}

let failed = false;
const stream = run({ files, concurrency: 1 });
stream.on('test:fail', (e) => {
  // Count only real failures (a file-level failure is reported once too).
  if (e.details?.error?.failureType !== 'subtestsFailed') failed = true;
});
stream.compose(spec).pipe(process.stdout);
stream.on('close', () => {
  process.exitCode = failed ? 1 : 0;
});
