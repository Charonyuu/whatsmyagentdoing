// Fake loopback API and synthetic logs only; no real credentials or sessions.
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Magpie } = require('../src/magpie');
const { Watcher } = require('../src/watcher');
const { newSession } = require('../src/parsers');
const { snapshot, createServer } = require('../src/server');

const KEY = 'test-only-magpie-web-key';
const NOW = Date.now();
const iso = (ms = NOW) => new Date(ms).toISOString();
const session = (id, agent = 'codex', extra = {}) => ({
  agent, id, name: agent, start: iso(NOW - 3600000), last: iso(),
  title: 'Example task', cwd: '/example', models: [{ model: 'example-model' }], ...extra,
});
const route = (id, extra = {}) => ({ agent: 'codex', session: id, time: iso(), done: false, model: 'current-model', ...extra });

async function fixture(t, key = KEY) {
  const state = { sessions: [], routes: [], mine: true, status: 200, malformed: false, calls: [], cookies: [],
    key, cookieName: 'magpie_web_3430' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.calls.push(url.pathname);
    if (url.pathname === '/') {
      if (url.searchParams.get('k') !== state.key) { res.writeHead(401).end(); return; }
      res.writeHead(303, { 'set-cookie': `${state.cookieName}=${state.key}; Path=/; HttpOnly`,
        location: state.loginRedirect || '/' }).end();
      return;
    }
    state.cookies.push(req.headers.cookie);
    if (req.headers.cookie !== `${state.cookieName}=${state.key}`) { res.writeHead(401).end(); return; }
    res.writeHead(state.status, { 'content-type': 'application/json', ...(state.redirect ? { location: '/unexpected' } : {}) });
    const value = req.url === '/api/sessions' ? { sessions: state.sessions } : { routes: state.routes, mine: state.mine };
    res.end(state.malformed ? '{"secret":"' + KEY : state.huge ? JSON.stringify({ ...value, pad: 'x'.repeat(9 * 1024 * 1024) }) : JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const magpie = new Magpie({ url: `http://127.0.0.1:${server.address().port}`, key });
  t.after(async () => {
    magpie.stop();
    await magpie.pending;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { state, magpie, port: server.address().port };
}

test('request completion never means turn completion; parallel calls share one person', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [session('one'), session('two'), session('one', 'opencode')];
  state.routes = [route('one'), route('one', { done: true }), route('two', { done: true })];
  await magpie.poll();
  assert.equal(magpie.sessions().length, 3);
  assert.equal(magpie.sessions()[0].status, 'thinking');
  assert.equal(magpie.sessions()[1].status, 'idle');
  assert.equal(magpie.sessions()[0].turnStartedAt, null, 'a request timestamp is not a turn start');
  assert.ok(state.cookies.every(cookie => cookie === `magpie_web_3430=${KEY}`),
    'the cookie uses the internal port, not the published port');
  assert.deepEqual(state.calls.sort(), ['/', '/api/gateway/trace', '/api/sessions']);
  state.routes.forEach(r => { r.done = true; });
  await magpie.poll();
  assert.ok(magpie.sessions().every(s => s.status === 'idle'));
  state.routes[0].done = false;
  await magpie.poll();
  assert.equal(magpie.sessions()[0].status, 'thinking');
});

test('helpers, missing IDs and invalid rows do not create active people', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [null, {}, session('old', 'codex', { last: iso(NOW - 48 * 3600000) }),
    session('bad', 'constructor'), session('bad', 'bad"><img'), session('missing-time', 'codex', { last: 'invalid' })];
  state.routes = [route('title', { kind: 'title' }), route('guardian', { kind: 'guardian' }),
    route('compact', { kind: 'compact' }), route(''), null, route('child', { kind: 'collab_spawn' }),
    route('new-before-listing', { time: iso(NOW - 20 * 60000) })];
  await magpie.poll();
  assert.deepEqual(magpie.sessions().map(s => s.id), ['new-before-listing', 'child']);
  assert.ok(snapshot(magpie, {}).sessions.every(s => s.status === 'thinking'),
    'a still-running request is not timed out just because it started 20 minutes ago');
  state.mine = false;
  await magpie.poll();
  assert.ok(magpie.sessions().every(s => s.status === 'idle'));
});

test('native logs win, including approvals, completion, subagents and Gemini session aliases', async t => {
  const { state, magpie } = await fixture(t);
  const watcher = new Watcher({ magpieSources: [] });
  watcher.magpies = [magpie];
  state.sessions = [session('same'), session('other'), session('real-id', 'gemini')];
  state.routes = [route('same'), route('other')];
  await magpie.poll();
  const native = { ...newSession('codex', 'same', '/fake'), status: 'waiting', activity: 'Approval',
    lastEventAt: NOW, subagent: true, parentId: 'parent', prompt: 'private prompt', reply: 'private reply' };
  watcher.trackers.set('/fake', { session: native });
  watcher.trackers.set('/gemini', { session: { ...newSession('gemini', 'filename', '/gemini'),
    sessionId: 'real-id', status: 'done', lastEventAt: NOW } });
  const rows = watcher.sessions();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'waiting');
  assert.equal(rows[0].activity, 'Approval');
  assert.equal(rows[0].subagent, true);
  assert.equal(rows[0].parentId, 'parent');
  assert.equal(rows[0].source, undefined);
  assert.equal(rows[0].title, 'Example task');
  assert.equal(native.title, null, 'gateway metadata must not stick in the native tracker');
  native.status = 'done';
  assert.equal(watcher.sessions()[0].status, 'done', 'gateway requests cannot overwrite a native completion');
  const safe = snapshot(watcher, { privacy: true });
  assert.ok(safe.sessions.every(s => s.title === null && s.prompt === null && s.reply === null));
  assert.equal(JSON.stringify(safe).includes(KEY), false);
});

test('OMP gateway snapshots omit Resume while matching local logs retain it', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [session('local', 'omp'), session('remote', 'omp')];
  state.routes = [route('local', { agent: 'omp' }), route('remote', { agent: 'omp' })];
  await magpie.poll();
  assert.ok(snapshot(magpie, {}).sessions.every(s => s.resumeCommand === undefined));
  const watcher = new Watcher({ magpieSources: [] });
  watcher.magpies = [magpie];
  watcher.trackers.set('/fake/local.jsonl', { session: {
    ...newSession('omp', 'local', '/fake/local.jsonl'), sessionId: 'local',
    cwd: '/fixture', status: 'waiting', lastEventAt: NOW, ompProfile: 'work',
  } });
  const rows = snapshot(watcher, {}).sessions;
  assert.equal(rows.length, 2);
  const local = rows.find(s => s.id === 'local');
  assert.equal(local.status, 'waiting');
  assert.equal(local.source, undefined);
  assert.match(local.resumeCommand, /--profile 'work'.*--resume 'local'/);
  const remote = rows.find(s => s.id === 'remote');
  assert.equal(remote.status, 'thinking');
  assert.equal(remote.resumeCommand, undefined);
});

test('failed polls become idle, warn once, expire and recover without leaking responses', async t => {
  const { state, magpie } = await fixture(t);
  const warnings = [];
  magpie.on('warning', msg => warnings.push(msg));
  state.sessions = [session('one')]; state.routes = [route('one')];
  await magpie.poll();
  state.status = 401;
  await magpie.poll(); await magpie.poll();
  assert.equal(magpie.sessions()[0].status, 'idle');
  assert.deepEqual(warnings, ['HTTP 401']);
  state.status = 200; state.malformed = true;
  await magpie.poll();
  assert.equal(warnings.length, 2);
  assert.equal(warnings.join().includes(KEY), false);
  state.malformed = false;
  state.sessions = null;
  await magpie.poll();
  assert.equal(magpie.sessions()[0].status, 'idle');
  state.sessions = [session('one')];
  await magpie.poll();
  assert.equal(magpie.error, null);
  assert.equal(magpie.sessions()[0].status, 'thinking');
  magpie.windowMs = -1;
  assert.equal(magpie.sessions().length, 0);
});

test('polls do not overlap and stopped adapters publish no late results', async t => {
  const { magpie } = await fixture(t);
  let release;
  let calls = 0;
  // Both reads share a controlled promise so cancellation can be tested without a timer.
  const response = new Promise(resolve => { release = resolve; });
  magpie.cookie = `magpie_web_3430=${KEY}`;
  magpie.read = () => { calls++; return response; };
  const first = magpie.poll();
  assert.equal(magpie.poll(), first);
  assert.equal(calls, 2);
  let changes = 0;
  magpie.on('change', () => changes++);
  magpie.stop();
  release({ sessions: [session('one')], routes: [route('one')], mine: true });
  await first;
  assert.equal(changes, 0);
  assert.equal(magpie.sessions().length, 0);
});

test('configuration rejects remote origins and embedded credentials without echoing secrets', () => {
  for (const url of ['https://example.com', `http://127.0.0.1:3430/?k=${KEY}`,
    `http://user:${KEY}@localhost:3430`, 'file:///tmp/magpie', 'http://localhost:3430/other']) {
    assert.throws(() => new Magpie({ url, key: KEY }), err => !err.message.includes(KEY));
  }
  assert.throws(() => new Magpie({ url: 'http://localhost:3430', key: 'bad\r\nCookie: value' }), /WMAD_MAGPIE_KEY/);
});

test('redirects cannot forward the web key to another endpoint', async t => {
  const { state, magpie } = await fixture(t);
  state.status = 302; state.redirect = true;
  await magpie.poll();
  assert.ok(magpie.error);
  assert.ok(state.calls.length > 0);
  assert.ok(state.calls.every(url => ['/', '/api/sessions', '/api/gateway/trace'].includes(url)));
});

test('dashboard JSON and SSE contain only session fields, with private titles redacted', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [session('one', 'opencode', { name: 'OpenCode', providerKey: KEY }),
    session('remote', 'omp')];
  state.routes = [route('one', { agent: 'opencode', order: [{ credential: KEY }] })];
  await magpie.poll();
  const server = createServer(magpie, { privacy: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = await (await fetch(base + '/api/sessions')).json();
  assert.equal(json.sessions[0].title, null);
  assert.equal(json.sessions[0].agentName, 'OpenCode');
  assert.equal(json.sessions[0].source, 'magpie');
  assert.equal(json.sessions.find(s => s.agent === 'omp').resumeCommand, undefined);
  const res = await fetch(base + '/events');
  const reader = res.body.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal(event.includes(KEY), false);
  assert.match(event, /"status":"thinking"/);
  assert.match(event, /"title":null/);
  assert.match(event, /"agent":"omp"/);
});

test('--json waits for Magpie, isolates native homes, applies privacy and reports authentication failure', async t => {
  const { state, port } = await fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-magpie-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  state.sessions = [session('cli')]; state.routes = [route('cli')];
  // Poison inherited overrides with synthetic sessions so a missing isolation is observable.
  const inheritedHomes = {};
  for (const [name, rel, records] of [
    ['KIMI_CODE_HOME', 'sessions/project/kimi/agents/main/wire.jsonl',
      [{ type: 'turn.prompt', time: NOW, input: 'Synthetic native task' }]],
    ['DSH_HOME', 'sessions/project/dsh/session.v4.jsonl',
      [{ type: 'session', id: 'dsh', createdAt: NOW }, { type: 'turn/start', time: NOW, data: {} }]],
    ['GROK_HOME', 'sessions/project/grok/updates.jsonl',
      [{ timestamp: NOW / 1000, params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Synthetic native task' } } } }]],
    ['WMAD_OMP_SESSIONS_DIR', 'project/native.jsonl',
      [{ type: 'session', id: 'native-omp', cwd: '/fixture', timestamp: iso() },
        { type: 'message', timestamp: iso(), message: { role: 'user', content: 'Synthetic native task' } }]],
  ]) {
    inheritedHomes[name] = path.join(root, name);
    const file = path.join(inheritedHomes[name], rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const env = { ...process.env, ...inheritedHomes, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root, GEMINI_CLI_HOME: root, WMAD_NO_UPDATE_CHECK: '1',
    KIMI_CODE_HOME: root, DSH_HOME: root, GROK_HOME: root,
    WMAD_OMP_SESSIONS_DIR: root,
    WMAD_MAGPIE_SOURCES: JSON.stringify([{ url: `http://127.0.0.1:${port}`, key: KEY }]) };
  const run = () => promisify(execFile)(process.execPath, [path.join(__dirname, '../bin/cli.js'), '--json', '--private'], { env });
  const result = await run();
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'thinking');
  assert.equal(rows[0].title, null);
  assert.equal((result.stdout + result.stderr).includes(KEY), false);
  state.status = 401;
  await assert.rejects(run(), err => err.code === 1 && /HTTP 401/.test(err.stderr)
    && !err.stderr.includes(KEY) && err.stdout === '');
});

test('two instances merge native metadata and gateway activity without duplicating sessions', async t => {
  const a = await fixture(t);
  const b = await fixture(t, 'second-instance-web-key');
  b.state.cookieName = 'magpie_web_3431';
  a.state.sessions = [session('same', 'codex', { title: 'Native title', last: iso(NOW - 1000) }),
    session('native-only')];
  b.state.sessions = [session('same', 'codex', { gateway: true, title: 'Gateway title' }),
    session('gateway-only', 'opencode', { gateway: true, role: 'subagent', parent_session: 'parent' })];
  b.state.routes = [route('same')];
  const watcher = new Watcher({ magpieSources: JSON.stringify([
    { url: b.magpie.url.origin, key: b.state.key },
    { url: a.magpie.url.origin, key: a.state.key },
  ]) });
  t.after(() => watcher.stop());
  await Promise.all(watcher.magpies.map(m => m.poll()));
  let rows = watcher.sessions();
  assert.equal(rows.length, 3);
  assert.equal(rows.find(s => s.id === 'same').title, 'Native title', 'native metadata wins regardless of source order');
  assert.equal(rows.find(s => s.id === 'same').status, 'thinking');
  assert.equal(rows.find(s => s.id === 'gateway-only').subagent, true);
  assert.equal(rows.find(s => s.id === 'gateway-only').parentId, 'parent');
  assert.ok(a.state.cookies.every(c => c === 'magpie_web_3430=' + a.state.key));
  assert.ok(b.state.cookies.every(c => c === 'magpie_web_3431=' + b.state.key));
  a.state.routes = [route('same')];
  b.state.status = 503;
  await Promise.all(watcher.magpies.map(m => m.poll()));
  assert.equal(watcher.sessions().find(s => s.id === 'same').status, 'thinking', 'one failure cannot erase healthy activity');
  assert.equal(watcher.sessions().length, 3);
  a.state.routes = [];
  await watcher.magpies[1].poll();
  assert.equal(watcher.sessions().find(s => s.id === 'same').status, 'idle');
  b.state.status = 200;
  await watcher.magpies[0].poll();
  assert.equal(watcher.sessions().find(s => s.id === 'same').status, 'thinking');
  const local = { ...newSession('codex', 'same', '/fake'), status: 'waiting', parentId: 'native-parent', subagent: true };
  watcher.trackers.set('/fake', { session: local });
  rows = watcher.sessions();
  assert.equal(rows.length, 3);
  assert.equal(rows.find(s => s.id === 'same').status, 'waiting');
  assert.equal(rows.find(s => s.id === 'same').parentId, 'native-parent');
});

test('--json awaits both sources and fails without emitting a partial snapshot', async t => {
  const a = await fixture(t);
  const b = await fixture(t, 'second-cli-test-key');
  b.state.cookieName = 'magpie_web_3431';
  a.state.sessions = [session('first')];
  a.state.routes = [route('first', { done: true })];
  b.state.sessions = [session('second')];
  b.state.routes = [route('second')];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-magpie-multi-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root, GEMINI_CLI_HOME: root, KIMI_CODE_HOME: root, DSH_HOME: root, GROK_HOME: root,
    WMAD_OMP_SESSIONS_DIR: root,
    WMAD_NO_UPDATE_CHECK: '1', WMAD_MAGPIE_SOURCES: JSON.stringify([
      { url: a.magpie.url.origin, key: a.state.key },
      { url: b.magpie.url.origin, key: b.state.key },
    ]) };
  const run = () => promisify(execFile)(process.execPath,
    [path.join(__dirname, '../bin/cli.js'), '--json', '--private'], { env });
  const result = await run();
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows.map(s => [s.id, s.status]).sort(), [['first', 'idle'], ['second', 'thinking']]);
  assert.ok(rows.every(s => s.title === null && s.prompt === null && s.reply === null));
  assert.ok(a.state.cookies.every(c => c === `magpie_web_3430=${a.state.key}`));
  assert.ok(b.state.cookies.every(c => c === `magpie_web_3431=${b.state.key}`));
  for (const key of [a.state.key, b.state.key]) assert.ok(!(result.stdout + result.stderr).includes(key));
  b.state.status = 503;
  await assert.rejects(run(), err => err.code === 1 && err.stdout === ''
    && /Magpie source 2: HTTP 503/.test(err.stderr)
    && !err.stderr.includes(a.state.key) && !err.stderr.includes(b.state.key));
});

test('sign-in uses the returned cookie, caches it and never follows its redirect', async t => {
  const { state, magpie } = await fixture(t);
  state.loginRedirect = 'http://example.invalid/should-not-be-visited';
  state.sessions = [session('one')];
  await magpie.poll(); await magpie.poll();
  assert.equal(magpie.error, null);
  assert.equal(state.calls.filter(p => p === '/').length, 1);
  state.status = 401;
  await magpie.poll();
  assert.equal(magpie.cookie, null);
  state.status = 200;
  await magpie.poll();
  assert.equal(magpie.error, null);
  assert.equal(state.calls.filter(p => p === '/').length, 2);
});

test('local interface addresses are accepted without allowing arbitrary network hosts', () => {
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({ local: [{ address: '100.64.0.8' }] });
  try {
    assert.doesNotThrow(() => new Magpie({ url: 'http://100.64.0.8:3431', key: KEY }));
    assert.throws(() => new Magpie({ url: 'http://100.64.0.9:3431', key: KEY }), /local HTTP/);
  } finally { os.networkInterfaces = original; }
});

test('source configuration errors do not echo keys, and the single-source form still works', () => {
  for (const config of [`[{"key":"${KEY}"`, JSON.stringify({ key: KEY }), '[null]']) {
    assert.throws(() => new Watcher({ magpieSources: config }), e => !e.message.includes(KEY));
  }
  const w = new Watcher({ magpieSources: null, magpieUrl: 'http://127.0.0.1:3430', magpieKey: KEY });
  assert.equal(w.magpies.length, 1);
  w.stop();
});

test('Kimi children do not consume their parent Magpie record through the resume ID', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [session('parent', 'kimi', { models: [{ model: 'parent-model' }] })];
  await magpie.poll();
  const watcher = new Watcher({ magpieSources: [] });
  watcher.magpies = [magpie];
  watcher.trackers.set('/child', { session: { ...newSession('kimi', 'parent/agent-0', '/child'),
    sessionId: 'parent', parentId: 'parent', subagent: true } });
  watcher.trackers.set('/parent', { session: newSession('kimi', 'parent', '/parent') });
  const rows = watcher.sessions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, null);
  assert.equal(rows[1].model, 'parent-model');
});

test('oversized responses and fields are refused or bounded before reaching the dashboard', async t => {
  const { state, magpie } = await fixture(t);
  state.sessions = [session('long', 'codex', { title: 'T'.repeat(5000), name: 'N'.repeat(100), cwd: '/' + 'c'.repeat(5000) })];
  await magpie.poll();
  const s = magpie.sessions()[0];
  assert.equal(s.title, null, 'a title over the field limit is dropped');
  assert.equal(s.agentName, null);
  assert.equal(s.cwd, null);
  state.sessions = [session('long', 'codex', { title: 'T'.repeat(1000) })];
  await magpie.poll();
  assert.ok(magpie.sessions()[0].title.length <= 220, 'titles are shortened like native previews');
  state.huge = true;
  await magpie.poll();
  assert.equal(magpie.error, 'API unavailable or invalid response');
  assert.ok(magpie.sessions().every(row => row.status === 'idle'));
});
