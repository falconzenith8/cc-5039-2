// Zero-dependency shard server: serves the generated program, fMP4/WAV shards
// and the kernel. Implements HTTP Range so byte-range shard fetch works, and
// exposes /api/health for smoke checks.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.wav': 'audio/wav',
  '.mpd': 'application/dash+xml',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = normalize(join(PUBLIC_DIR, decoded));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'multilingual-stage-kernel' }));
    return;
  }
  const path = safePath(req.url === '/' ? '/index.html' : req.url);
  if (!path) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = MIME[extname(path)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const size = info.size;
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : size - 1;
      if (Number.isNaN(start) || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      const data = await readFile(path, null);
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': info.size });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`shard server listening on http://localhost:${PORT}`);
});
