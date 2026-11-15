// Tiny static server for ./dist used by the end-to-end test.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function serve(root = 'dist', port = 0) {
  const base = resolve(root);
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (p.endsWith('/')) p = join(p, 'index.html');
      const file = join(base, p);
      if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    }).listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}
