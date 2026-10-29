// Synthetic logs only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { transcript } = require('../src/transcript');
const { newSession, applyCopilot } = require('../src/parsers');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-tr-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const write = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const at = (s) => new Date(Date.UTC(2026, 9, 29, 10, 0, s)).toISOString();

test('Claude transcript keeps full text, tool calls, and skips tool results and notifications', (t) => {
  const f = path.join(tmp(t), 'a.jsonl');
  const long = 'x'.repeat(900);
  write(f, [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', content: [{ type: 'text', text: long }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', timestamp: at(3), message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', timestamp: at(4), message: { id: 'm2', content: [{ type: 'text', text: 'Fixed it.' }] } },
  ]);
  const m = transcript({ agent: 'claude', id: 'a', file: f });
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(m[1].text.length, 900, 'replies are not cut to the card preview length');
  assert.equal(m[2].text, 'Bash: npm test');
});

test('Codex transcript drops the duplicate item copy of a message', (t) => {
  const f = path.join(tmp(t), 'b.jsonl');
  write(f, [
    { type: 'event_msg', timestamp: at(0), payload: { type: 'user_message', message: 'Add tests' } },
    { type: 'event_msg', timestamp: at(0), payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'Add tests' }] } } },
    { type: 'event_msg', timestamp: at(1), payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', 'pnpm test'] } } },
    { type: 'event_msg', timestamp: at(2), payload: { type: 'agent_message', message: 'Tests added.' } },
  ]);
  const m = transcript({ agent: 'codex', id: 'b', file: f });
  assert.deepEqual(m.map((x) => [x.role, x.text]), [['user', 'Add tests'], ['tool', 'Shell: pnpm test'], ['assistant', 'Tests added.']]);
});

test('other clients are replayed through their own parser', (t) => {
  const f = path.join(tmp(t), 'events.jsonl');
  write(f, [
    { type: 'user.message', timestamp: at(0), data: { content: 'Rename the flag' } },
    { type: 'tool.execution_start', timestamp: at(1), data: { toolName: 'bash', arguments: { command: 'rg flag' } } },
    { type: 'assistant.message', timestamp: at(2), data: { content: 'Renamed.' } },
  ]);
  const m = transcript({ ...newSession('copilot', 'c', f) }, applyCopilot);
  assert.deepEqual(m.map((x) => [x.role, x.text]), [['user', 'Rename the flag'], ['tool', 'Shell: rg flag'], ['assistant', 'Renamed.']]);
});

test('a session without a readable log falls back to its last prompt and reply', () => {
  const m = transcript({ agent: 'gemini', id: 'g', file: '/nope/missing.jsonl', prompt: 'Hi', reply: 'Hello' });
  assert.deepEqual(m.map((x) => x.text), ['Hi', 'Hello']);
});

test('the HTTP endpoint looks sessions up by key and hides everything with --private', () => {
  const r = spawnSync(process.execPath, ['-e', `
    const http = require('http');
    const { createServer } = require('./src/server');
    const w = { sessions: () => [], transcript: (k) => (k === 'claude:a' ? [{ role: 'user', text: 'hi', at: 1 }] : null), on() {}, start() {} };
    const get = (port, q) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path: '/api/transcript?key=' + encodeURIComponent(q), headers: { host: 'localhost' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok([res.statusCode, JSON.parse(b)])); }));
    (async () => {
      for (const privacy of [false, true]) {
        const s = createServer(w, { privacy });
        await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
        const port = s.address().port;
        console.log(JSON.stringify([privacy, await get(port, 'claude:a'), await get(port, '../../etc/passwd')]));
        s.close();
      }
      process.exit(0);
    })();`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  const [open, priv] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(open[1], [200, { messages: [{ role: 'user', text: 'hi', at: 1 }] }]);
  assert.equal(open[2][0], 404, 'unknown keys find nothing; no path is ever opened from the request');
  assert.deepEqual(priv[1], [403, { messages: [], private: true }]);
}, { skip: false });
