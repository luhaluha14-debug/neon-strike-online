import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

// Static files of the built game (dist/) for the Node servers (account
// server, multiplayer relay): no path escapes the folder, client-side routes
// fall back to index.html, hashed bundles are cached for good.

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;

/** Serves files under `dir` (null = nothing). Resolves true when it answered the request. */
export function createStaticHandler(dir: string | null): StaticHandler {
  if (!dir) return async () => false;
  const staticRoot = resolve(dir);
  return async (req, res, path) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    } catch {
      return false;
    }
    let file = join(staticRoot, rel);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return false;
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      // Client-side routes fall back to the game page; missing assets stay 404.
      if (rel.startsWith('assets') || extname(rel)) return false;
      file = join(staticRoot, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return false;
    }
    const top = rel.split(/[/\\]/)[0];
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // Same caching as the static site (render.yaml): hashed bundles forever, map files a day.
      'cache-control': top === 'assets' ? 'public, max-age=31536000, immutable' : top === 'maps' ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
