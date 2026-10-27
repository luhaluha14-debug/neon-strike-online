// Real PostgreSQL for the account-server tests.
//
// GRID_TEST_DATABASE_URL set: each test file gets a fresh database created on
// that server (the URL's user needs CREATEDB). Otherwise a throwaway cluster
// is started from the local PostgreSQL binaries (initdb / pg_ctl) in a temp
// directory on a random port and removed afterwards. Neither available:
// `startPostgres()` returns null and the tests are skipped (reported as
// skipped, never as passed).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';

function pgBinDir() {
  if (process.env.GRID_PG_BIN) return process.env.GRID_PG_BIN;
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return null;
  const versions = readdirSync(root).filter((v) => existsSync(join(root, v, 'bin', 'initdb'))).sort((a, b) => Number(b) - Number(a));
  return versions.length ? join(root, versions[0], 'bin') : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Runs a PostgreSQL tool as the `postgres` OS user when we are root (initdb refuses root). */
function asPg(bin, args) {
  const isRoot = process.getuid?.() === 0;
  const cmd = isRoot ? 'runuser' : bin;
  const full = isRoot ? ['-u', 'postgres', '--', bin, ...args] : args;
  const r = spawnSync(cmd, full, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args[0] ?? ''} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

let cluster = null;

async function startCluster() {
  const bin = pgBinDir();
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), 'grid-pg-'));
  chmodSync(dir, 0o777);
  const data = join(dir, 'data');
  const port = await freePort();
  try {
    if (process.getuid?.() === 0) execFileSync('chown', ['postgres', dir]);
    asPg(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions', '-E', 'UTF8', '--locale=C']);
    asPg(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'log'), '-w', '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    console.warn('[pg] could not start a test cluster:', err.message);
    return null;
  }
  return {
    bin,
    dir,
    data,
    adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        asPg(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * A fresh, empty database for one test file: `{ url, bin, drop() }`, or
 * null when no PostgreSQL is available.
 */
export async function startPostgres() {
  let adminUrl = process.env.GRID_TEST_DATABASE_URL;
  let own = null;
  if (!adminUrl) {
    own = cluster ??= await startCluster();
    if (!own) return null;
    adminUrl = own.adminUrl;
  }
  const name = `grid_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  return {
    url: url.toString(),
    bin: own?.bin ?? pgBinDir(),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
      if (own && cluster === own) {
        cluster = null;
        own.stop();
      }
    },
    /** A second empty database on the same server (restore target). */
    async createSibling(suffix) {
      const sib = `${name}_${suffix}`;
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`CREATE DATABASE ${sib}`);
      await c.end();
      const u = new URL(adminUrl);
      u.pathname = '/' + sib;
      return u.toString();
    },
  };
}
