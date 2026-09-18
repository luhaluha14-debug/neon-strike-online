/* tiny test harness: no dependencies, readable output, non-zero exit on failure */
export const state = { pass: 0, fail: 0, failures: [] };

export function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async tests are not supported');
    state.pass++;
    process.stdout.write('  ok   ' + name + '\n');
  } catch (e) {
    state.fail++;
    state.failures.push([name, e]);
    process.stdout.write('  FAIL ' + name + '\n       ' + (e && e.message) + '\n');
  }
}
export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
export function equal(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': ' + a + ' !== ' + b); }
export function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error((msg || 'not near') + ': ' + a + ' vs ' + b);
}
