// Synthetic Copilot CLI events only; no real sessions.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { newSession, applyCopilot } = require('../src/parsers');
const { snapshot } = require('../src/server');

const NOW = Date.now();
const ev = (type, data = {}, ms = NOW) => ({ type, timestamp: new Date(ms).toISOString(), data });

test('Copilot events map to thinking, tool, reply, error and done', () => {
  const s = newSession('copilot', 'folder', null);
  applyCopilot(s, ev('session.start', { sessionId: 'real-id', context: { cwd: '/work/app' }, selectedModel: 'model-a' }));
  assert.equal(s.sessionId, 'real-id');
  assert.equal(s.cwd, '/work/app');
  assert.equal(s.model, 'model-a');
  applyCopilot(s, ev('user.message', { content: 'Fix the build' }));
  assert.equal(s.status, 'thinking');
  assert.equal(s.prompt, 'Fix the build');
  applyCopilot(s, ev('tool.execution_start', { toolName: 'bash', arguments: { command: 'npm test' } }));
  assert.equal(s.status, 'tool');
  assert.equal(s.activity, 'Shell: npm test');
  applyCopilot(s, ev('tool.execution_error', { message: 'exit code 1' }));
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'exit code 1');
  applyCopilot(s, ev('assistant.message', { content: [{ type: 'text', text: 'Fixed it' }] }));
  assert.equal(s.status, 'typing');
  assert.equal(s.reply, 'Fixed it');
  applyCopilot(s, ev('session.end'));
  assert.equal(s.status, 'done');
});

test('Copilot replies never include tool arguments, and deep content is bounded', () => {
  const s = newSession('copilot', 'folder', null);
  applyCopilot(s, ev('assistant.message', { toolRequests: [{ arguments: { command: 'cat ~/.ssh/id_rsa' } }] }));
  assert.equal(s.reply, null);
  let deep = { text: 'too deep' };
  for (let i = 0; i < 1000; i++) deep = { content: [deep] };
  assert.doesNotThrow(() => applyCopilot(s, ev('assistant.message', { content: [deep] })));
  applyCopilot(s, null);
  applyCopilot(s, ev('unknown.event'));
});

test('Copilot sessions are discovered from session-state and labeled by workspace', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-copilot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, Buffer, Date, process: { env: {} }, console, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => root } : createRequire(file)(name),
  }, { filename: file });
  const log = path.join(root, '.copilot/session-state/abc/events.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, [ev('session.start', { sessionId: 'abc', context: { cwd: '/work/app' } }),
    ev('user.message', { content: 'Hello' })].map(x => JSON.stringify(x)).join('\n') + '\n');
  const old = path.join(root, '.copilot/session-state/old/events.jsonl');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify(ev('user.message', { content: 'Old' })) + '\n');
  fs.utimesSync(old, new Date(NOW - 30 * 3600000), new Date(NOW - 30 * 3600000));
  const w = new mod.exports.Watcher();
  w.tick();
  const rows = snapshot(w, { privacy: false }).sessions;
  assert.equal(rows.length, 1, 'sessions outside the hours window are skipped');
  assert.equal(rows[0].agent, 'copilot');
  assert.equal(rows[0].project, 'workspace-app');
  assert.equal(rows[0].status, 'thinking');
});
