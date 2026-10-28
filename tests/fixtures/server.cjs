const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
assert.ok(process.argv[3], 'Run through tests/server.cjs with an isolated home');
assert.equal(process.env.HOME, process.argv[3]);
const { createServer } = require('../../src/server');
const { USER_DIR } = require('../../src/scenes');

const scene = path.join(USER_DIR, 'fixture');
fs.mkdirSync(scene, { recursive: true });
fs.writeFileSync(path.join(scene, 'manifest.json'), '{"name":"Fixture"}');
fs.writeFileSync(path.join(scene, 'hello world.json'), '{"fixture":true}\n');
fs.writeFileSync(path.join(scene, 'literal%name.json'), '{"percent":true}\n');
fs.writeFileSync(path.join(scene, 'blocked.txt'), 'not an allowed HTTP MIME type');
fs.writeFileSync(path.join(USER_DIR, 'outside.json'), '{"outside":true}');

const watcher = new EventEmitter();
watcher.sessions = () => [];
const server = createServer(watcher, {});

function request(url, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port: server.address().port, path: url,
      headers: { host: `${host}:${server.address().port}` },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error(`Request timed out: ${url}`)));
  });
}

async function ping(host) {
  const res = await request('/api/ping', host);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { app: 'whatsmyagentdoing' });
}

async function resource(url, file, type, cache = 'no-cache') {
  const res = await request(url);
  assert.equal(res.status, 200, url);
  assert.equal(res.headers['content-type'], type);
  assert.equal(res.headers['cache-control'], cache);
  assert.deepEqual(res.body, fs.readFileSync(file), url);
}

async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const scenario = process.argv[2];
    if (scenario === 'assets' || scenario === 'scenes') {
      const prefixes = scenario === 'assets' ? ['/assets/'] : ['/scenes/', '/scenes/fixture/'];
      for (const prefix of prefixes) {
        for (const suffix of ['%', '%2', '%GG', '%E0%A4', '%FF']) {
          const url = prefix + suffix;
          assert.equal((await request(url)).status, 400, url);
          await ping();
          if (scenario === 'assets') {
            await resource('/assets/agents%2F%63laude.png', path.join(__dirname, '../../assets/agents/claude.png'), 'image/png');
          } else {
            await resource('/scenes/fixture/hello%20world.json', path.join(scene, 'hello world.json'), 'application/json');
          }
        }
      }
    } else {
      assert.equal(scenario, 'guards');
      for (const url of ['/assets/%', '/scenes/%']) {
        assert.equal((await request(url, 'untrusted.example')).status, 403, url);
      }
      for (const host of ['localhost', '127.0.0.1', '[::1]']) await ping(host);
      for (const url of [
        '/assets/%2e%2e%2fpackage.json', '/scenes/fixture/%2e%2e%2foutside.json',
        '/scenes/%2e%2e%2ffixture/manifest.json', '/assets/agents/README.md',
        '/scenes/fixture/blocked.txt', '/assets/missing.png', '/scenes/missing/manifest.json',
      ]) assert.equal((await request(url)).status, 404, url);
      await resource('/scenes/fixture/literal%25name.json', path.join(scene, 'literal%name.json'), 'application/json');
      await resource('/office.js', path.join(__dirname, '../../public/office.js'), 'text/javascript; charset=utf-8', 'no-store');
      await ping();
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
