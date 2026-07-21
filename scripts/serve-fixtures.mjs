import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.m3u8', 'application/vnd.apple.mpegurl; charset=utf-8'],
  ['.ts', 'video/mp2t'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
]);

function resolveFixture(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname === '/' ? '/pages/direct.html' : decodeURIComponent(url.pathname);
  const file = resolve(root, `.${pathname}`);
  const fromRoot = relative(root, file);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || resolve(file) === resolve(root)) {
    return null;
  }
  return file;
}

export function createFixtureServer() {
  return http.createServer(async (request, response) => {
    let file;
    try {
      file = resolveFixture(request.url);
    } catch {
      response.writeHead(400).end('bad request');
      return;
    }

    if (!file) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': contentTypes.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      });
      response.end(body);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(500).end('fixture error');
    }
  });
}

export function startFixtureServer({ port = Number(process.env.FIXTURE_PORT ?? 4173) } = {}) {
  const server = createFixtureServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`Fixture server: http://127.0.0.1:${address.port}`);
  });
  return server;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) startFixtureServer();
