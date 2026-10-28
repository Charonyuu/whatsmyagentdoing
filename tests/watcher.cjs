// Isolated logs only: never read the developer's actual agent history.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const watcherPath = path.join(__dirname, '../src/watcher.js');
const localRequire = createRequire(watcherPath);
const source = fs.readFileSync(watcherPath, 'utf8');
const HOUR = 3600000;
const NOW = Date.parse('2026-10-26T10:00:00Z');

function fixture(t, hours = 24) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-watcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const reads = [];
  const blocked = new Set();
  const io = new Proxy(fs, {
    get(target, name) {
      if (['openSync', 'readdirSync', 'statSync'].includes(name)) return (file, ...args) => {
        if (blocked.has(String(file))) throw Object.assign(new Error('Fixture access denied'), { code: 'EACCES' });
        if (name === 'openSync') reads.push(String(file));
        return target[name](file, ...args);
      };
      return target[name];
    },
  });
  class Clock extends Date { static now() { return now; } }
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, Buffer, Date: Clock, process: { env: {} }, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => root } : name === 'fs' ? io : localRequire(name),
  }, { filename: watcherPath });
  const watcher = new mod.exports.Watcher({ hours });
  const event = (type, at, extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const write = (day, n, at) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const file = path.join(root, '.codex/sessions', day, `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { cwd: '/demo/long-chat' } }) + '\n' + event('task_started', at));
    fs.utimesSync(file, new Date(at), new Date(at));
    return { file, id };
  };
  return { root, watcher, write, reads, blocked,
    advance: ms => { now += ms; },
    append(log, type, extra) {
      fs.appendFileSync(log.file, event(type, now, extra));
      fs.utimesSync(log.file, new Date(now), new Date(now));
    },
  };
}

test('recently active Codex chats in old date folders are discovered without an index', t => {
  const f = fixture(t);
  const old = f.write('2025/01/01', 1, NOW - HOUR);
  const recent = f.write('2026/10/26', 2, NOW - HOUR);
  const inactive = f.write('2026/08/19', 3, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id).sort(), [old.id, recent.id].sort());
  assert.equal(f.reads.includes(inactive.file), false, 'inactive history is not opened');
  assert.equal(f.watcher.sessions().find(s => s.id === old.id).status, 'thinking');
});

test('an old inactive chat is discovered after resuming, then tailed without reopening', t => {
  const f = fixture(t);
  const log = f.write('2026/08/19', 1, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
  f.advance(6000);f.append(log, 'task_started');f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  const tracker = f.watcher.trackers.get(log.file);
  f.advance(1000);f.append(log, 'task_complete', { last_agent_message: 'Finished' });f.watcher.tick();
  assert.equal(f.watcher.trackers.get(log.file), tracker, 'reuse incremental tracker');
  assert.equal(f.watcher.sessions()[0].status, 'done');
  assert.equal(f.watcher.sessions()[0].reply, 'Finished');
});

test('custom hours still excludes inactive logs and expires tracked sessions', t => {
  const f = fixture(t, 2);
  const active = f.write('2024/12/31', 1, NOW - HOUR);
  const inactive = f.write('2026/10/26', 2, NOW - 3 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [active.id]);
  assert.equal(f.reads.includes(inactive.file), false);
  f.advance(3 * HOUR);f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
});

test('an inaccessible historical folder or log does not hide readable active chats', t => {
  const f = fixture(t);
  const hidden = f.write('2025/01/01', 1, NOW - HOUR);
  const blocked = f.write('2025/02/02', 2, NOW - HOUR);
  const good = f.write('2025/03/03', 3, NOW - HOUR);
  f.blocked.add(path.dirname(hidden.file));f.blocked.add(blocked.file);
  assert.doesNotThrow(() => f.watcher.tick());
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [good.id]);
});

test('historical files outside the window stay out of the one-second polling list', t => {
  const f = fixture(t);
  for (let n = 1; n <= 300; n++) f.write('2025/01/01', n, NOW - 48 * HOUR);
  const active = f.write('2025/01/01', 301, NOW - HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.candidates, c => c.file), [active.file]);
  assert.deepEqual(f.reads, [active.file]);
});

test('a large long-lived chat keeps head metadata and reads its current state from the tail', t => {
  const f = fixture(t);
  const log = f.write('2025/01/01', 1, NOW - HOUR);
  const filler = JSON.stringify({ type: 'padding', payload: { text: 'x'.repeat(4096) } }) + '\n';
  fs.appendFileSync(log.file, filler.repeat(300));
  f.append(log, 'task_complete', { last_agent_message: 'Latest reply in the tail' });
  f.watcher.tick();
  const session = f.watcher.sessions()[0];
  assert.equal(session.id, log.id);
  assert.equal(session.cwd, '/demo/long-chat');
  assert.equal(session.status, 'done');
  assert.equal(session.reply, 'Latest reply in the tail');
  assert.equal(f.reads.filter(file => file === log.file).length, 2, 'read only the head and tail');
});

test('legacy Gemini documents reload when their size changes without an mtime change', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.gemini/tmp/demo/chats/session-legacy.json');
  const stamp = new Date(NOW);
  const doc = { sessionId: 'legacy', messages: [
    { type: 'user', timestamp: stamp.toISOString(), content: 'Read the configuration' },
  ] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'thinking');
  const before = fs.statSync(file);

  doc.messages.push({ type: 'gemini', timestamp: stamp.toISOString(),
    toolCalls: [{ name: 'read_file', status: 'executing', args: { path: 'config.json' } }],
  });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(after.size > before.size);

  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'tool');
  assert.equal(f.watcher.sessions()[0].activity, 'read_file config.json');
});
