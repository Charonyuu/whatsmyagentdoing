// Fixture databases only: never read the developer's actual agent history.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}

const { poll, notice, opencodeV2State } = require('../src/external');

const HOUR = 3600000;
const NOW = Date.parse('2026-11-01T12:00:00Z');

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-external-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opencodeDb(dir) {
  const file = path.join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table session (id text, parent_id text, title text, directory text, model text,
    time_created integer, time_updated integer);
    create table message (id text, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text, message_id text, session_id text, time_created integer, data text);`);
  const add = (id, role, at, data, parts = []) => {
    db.prepare('insert into message values (?, ?, ?, ?, ?)').run(`msg_${id}`, 'ses_1', at, at, JSON.stringify({ role, ...data }));
    parts.forEach((p, i) => db.prepare('insert into part values (?, ?, ?, ?, ?)')
      .run(`prt_${id}_${i}`, `msg_${id}`, 'ses_1', at + i, JSON.stringify(p)));
  };
  db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)')
    .run('ses_1', null, 'Fix the parser', 'C:/work/app', JSON.stringify({ id: 'muse-spark-1.3' }), NOW - HOUR, NOW - 1000);
  add('u', 'user', NOW - 2000, {}, [{ type: 'text', text: 'fix the parser' }]);
  add('a', 'assistant', NOW - 1500, { finish: 'stop' }, [{ type: 'text', text: 'done, patched it' }]);
  db.close();
  return file;
}

function hermesDb(dir) {
  const file = path.join(dir, 'state.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table sessions (id text, model text, parent_session_id text, started_at real, ended_at real);
    create table messages (session_id text, role text, content text, timestamp real, finish_reason text, tool_name text);`);
  db.prepare('insert into sessions values (?, ?, ?, ?, ?)').run('20261101_120000_abc', 'swift-1.5', null, (NOW - HOUR) / 1000, null);
  const msg = db.prepare('insert into messages values (?, ?, ?, ?, ?, ?)');
  msg.run('20261101_120000_abc', 'user', 'run the tests', (NOW - 2000) / 1000, null, null);
  msg.run('20261101_120000_abc', 'assistant', '', (NOW - 1500) / 1000, 'tool_calls', 'bash');
  msg.run('20261101_120000_abc', 'tool', 'all green', (NOW - 1200) / 1000, null, null);
  db.close();
  return file;
}

test('opencode and hermes sessions are read from their databases', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  const since = NOW - 24 * HOUR;
  const rows = poll(since, {
    home: dir,
    env: { OPENCODE_DB: opencodeDb(dir), HERMES_HOME: path.join(dir, 'hermes') },
  });

  const open = rows.find((s) => s.agent === 'opencode');
  assert.equal(open.id, 'ses_1');
  assert.equal(open.status, 'done');
  assert.equal(open.prompt, 'fix the parser');
  assert.equal(open.reply, 'done, patched it');
  assert.equal(open.model, 'muse-spark-1.3');
  assert.equal(open.cwd, 'C:/work/app');
  assert.equal(open.lastEventAt, NOW - 1000);

  assert.equal(rows.filter((s) => s.agent === 'hermes').length, 0, 'no hermes database means no hermes rows');
});

test('hermes tool calls show as a running tool', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  hermesDb(dir);
  const rows = poll(NOW - 24 * HOUR, {
    home: dir,
    env: { HERMES_HOME: dir, OPENCODE_DB: path.join(dir, 'missing.db') },
  }).filter((s) => s.agent === 'hermes');

  // The newest row is the tool result, so the turn is still running.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'thinking');
  assert.equal(rows[0].model, 'swift-1.5');
  assert.equal(rows[0].prompt, 'run the tests');
  assert.equal(rows[0].reply, null);
});

test('an unfinished assistant message is still typing', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  const file = path.join(dir, 'state.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table sessions (id text, model text, parent_session_id text, started_at real, ended_at real);
    create table messages (session_id text, role text, content text, timestamp real, finish_reason text, tool_name text);`);
  db.prepare('insert into sessions values (?, ?, ?, ?, ?)').run('s1', 'm', null, (NOW - 60) / 1000, null);
  db.prepare('insert into messages values (?, ?, ?, ?, ?, ?)').run('s1', 'assistant', 'partial', (NOW - 10) / 1000, null, null);
  db.close();

  const rows = poll(NOW - HOUR, { home: dir, env: { HERMES_HOME: dir } });
  assert.equal(rows[0].status, 'typing');
});

test('a hermes chat that started before the window but is still in use is kept', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  const db = new sqlite.DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`create table sessions (id text, model text, parent_session_id text, started_at real, ended_at real);
    create table messages (session_id text, role text, content text, timestamp real, finish_reason text, tool_name text);`);
  // Started 30 hours ago, but the last message is an hour old: still in the 24h window.
  db.prepare('insert into sessions values (?, ?, ?, ?, ?)').run('s1', 'm', null, (NOW - 30 * HOUR) / 1000, null);
  db.prepare('insert into messages values (?, ?, ?, ?, ?, ?)').run('s1', 'user', 'still here', (NOW - HOUR) / 1000, null, null);
  db.prepare('insert into messages values (?, ?, ?, ?, ?, ?)').run('s1', 'assistant', 'yes', (NOW - HOUR + 1000) / 1000, 'stop', null);
  db.close();

  const rows = poll(NOW - 24 * HOUR, { home: dir, env: { HERMES_HOME: dir } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastEventAt, NOW - HOUR + 1000);
});

test('missing databases yield no rows and do not throw', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  assert.deepEqual(poll(NOW - HOUR, { home: dir, env: {} }), []);
});

test('a Node without node:sqlite is told why the two agents are missing', (t) => {
  const dir = root(t);
  const file = path.join(dir, 'opencode.db');
  fs.writeFileSync(file, '');

  assert.match(notice({ home: dir, env: { OPENCODE_DB: file }, sqlite: null }), /22\.13/);
  assert.equal(notice({ home: dir, env: {}, sqlite: null }), null, 'nothing to warn about without a database');
  assert.equal(notice({ home: dir, env: { OPENCODE_DB: file }, sqlite: {} }), null, 'no warning when the module is there');
});

// --- OpenCode 2.x (session_v2 / session_message) --------------------------

function opencodeV2Db(dir, build) {
  const file = path.join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table session_v2 (id text, parent_id text, title text, directory text, model text,
    time_created integer, time_updated integer);
    create table session_message (id text, session_id text, type text, seq integer, time_created integer,
    time_updated integer, data text);`);
  let seq = 0;
  const session = (id, fields = {}) => db.prepare('insert into session_v2 values (?, ?, ?, ?, ?, ?, ?)')
    .run(id, fields.parent || null, fields.title || null, 'C:/work/app',
      JSON.stringify({ id: 'xing-4', providerID: 'openrouter' }), NOW - HOUR, fields.updated || NOW - 1000);
  const message = (sid, type, at, data) => db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_${++seq}`, sid, type, seq, at, at, JSON.stringify({ time: { created: at }, ...data }));
  build({ session, message });
  db.close();
  return file;
}

const tool = (name, status, input = {}) => ({ type: 'tool', id: `call_${name}`, name, executed: false, state: { status, input } });
const read = (file) => poll(NOW - 24 * HOUR, { home: path.dirname(file), env: { OPENCODE_DB: file, HERMES_HOME: path.dirname(file) } })
  .filter((s) => s.agent === 'opencode');

test('opencode 2.x sessions are read from session_v2 and session_message', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const file = opencodeV2Db(root(t), ({ session, message }) => {
    session('ses_a', { title: 'Greeting' });
    message('ses_a', 'user', NOW - 5000, { text: 'list the files' });
    message('ses_a', 'assistant', NOW - 4000, { finish: 'tool-calls', time: { created: NOW - 4000, completed: NOW - 3900 },
      content: [{ type: 'reasoning', text: 'read it' }, tool('read', 'completed', { path: 'D:/code' })] });
    message('ses_a', 'assistant', NOW - 3000, { finish: 'stop', time: { created: NOW - 3000, completed: NOW - 2900 },
      content: [{ type: 'text', text: 'There are 3 folders.' }] });
    message('ses_a', 'idle', NOW - 2800, { outcome: 'succeeded' });
  });
  const [open] = read(file);
  assert.equal(open.id, 'ses_a');
  assert.equal(open.status, 'done');
  assert.equal(open.prompt, 'list the files');
  assert.equal(open.reply, 'There are 3 folders.');
  assert.equal(open.model, 'xing-4');
  assert.equal(open.cwd, 'C:/work/app');
  assert.equal(open.title, 'Greeting');
  assert.equal(open.turnStartedAt, NOW - 5000);
});

test('an opencode 2.x tool that asks a question shows as waiting for the user', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const file = opencodeV2Db(root(t), ({ session, message }) => {
    session('ses_q');
    message('ses_q', 'user', NOW - 3000, { text: 'ask me A or B' });
    // The assistant message has no completion time until the question is answered.
    message('ses_q', 'assistant', NOW - 2000, { content: [{ type: 'reasoning', text: 'ask' }, tool('question', 'running')] });
  });
  const [open] = read(file);
  assert.equal(open.status, 'waiting');
  assert.equal(open.activity, 'question');
});

test('opencode 2.x states follow the newest message', () => {
  const state = (type, body) => opencodeV2State({ type, body });
  assert.equal(opencodeV2State(null).status, 'idle');
  assert.equal(state('user', { text: 'hi' }).status, 'thinking');
  assert.deepEqual(state('assistant', { content: [tool('bash', 'running')] }), { status: 'tool', activity: 'bash' });
  assert.equal(state('assistant', { content: [tool('bash', 'pending')] }).status, 'tool');
  assert.equal(state('assistant', { content: [{ type: 'text', text: 'wri' }] }).status, 'typing');
  assert.equal(state('assistant', { content: [{ type: 'reasoning', text: 'hm' }] }).status, 'thinking');
  assert.equal(state('assistant', { content: [] }).status, 'thinking');
  // A step that ended in tool calls whose tools are all finished: reading the results.
  assert.equal(state('assistant', { finish: 'tool-calls', time: { completed: 1 }, content: [tool('read', 'completed')] }).status, 'thinking');
  assert.equal(state('assistant', { finish: 'stop', content: [] }).status, 'done');
  assert.equal(state('assistant', { finish: 'error', error: { type: 'provider.rate-limit', message: 'Provider returned error' } }).error, 'Provider returned error');
  assert.equal(state('idle', { outcome: 'succeeded' }).status, 'done');
  assert.deepEqual(state('idle', { outcome: 'failed', error: { type: 'provider.quota', message: 'Free usage limit reached' } }),
    { status: 'error', error: 'Free usage limit reached' });
  assert.equal(state('idle', { outcome: 'failed' }).error, 'Turn failed');
  assert.equal(state('idle', { outcome: 'something-new' }).status, 'idle');
});

test('a new opencode 2.x prompt after a finished turn is thinking, with no stale reply', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const file = opencodeV2Db(root(t), ({ session, message }) => {
    session('ses_n');
    message('ses_n', 'user', NOW - 9000, { text: 'first' });
    message('ses_n', 'assistant', NOW - 8000, { finish: 'stop', content: [{ type: 'text', text: 'old answer' }] });
    message('ses_n', 'idle', NOW - 7000, { outcome: 'succeeded' });
    message('ses_n', 'model-switched', NOW - 2000, { model: { id: 'other' } });
    message('ses_n', 'user', NOW - 1500, { text: 'second' });
  });
  const [open] = read(file);
  assert.equal(open.status, 'thinking');
  assert.equal(open.prompt, 'second');
  assert.equal(open.reply, null);
});

test('a session in both opencode layouts is read from session_v2, and v1-only sessions stay', { skip: !sqlite && 'node:sqlite is unavailable' }, (t) => {
  const dir = root(t);
  const file = opencodeV2Db(dir, ({ session, message }) => {
    session('ses_1', { title: 'migrated' });
    message('ses_1', 'user', NOW - 2000, { text: 'from v2' });
    message('ses_1', 'assistant', NOW - 1500, { finish: 'stop', content: [{ type: 'text', text: 'v2 answer' }] });
  });
  // Add the legacy tables to the same file, as an upgraded install has them.
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table session (id text, parent_id text, title text, directory text, model text,
    time_created integer, time_updated integer);
    create table message (id text, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text, message_id text, session_id text, time_created integer, data text);`);
  const old = db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)');
  old.run('ses_1', null, 'migrated', 'C:/work/app', JSON.stringify({ id: 'old' }), NOW - HOUR, NOW - 1000);
  old.run('ses_legacy', null, 'legacy only', 'C:/work/old', JSON.stringify({ id: 'old' }), NOW - HOUR, NOW - 3000);
  db.close();

  const rows = read(file);
  assert.deepEqual(rows.map((s) => s.id).sort(), ['ses_1', 'ses_legacy']);
  assert.equal(rows.find((s) => s.id === 'ses_1').prompt, 'from v2');
  assert.equal(rows.find((s) => s.id === 'ses_legacy').title, 'legacy only');
});
