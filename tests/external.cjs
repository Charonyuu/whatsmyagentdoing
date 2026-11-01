// Fixture databases only: never read the developer's actual agent history.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}

const { poll } = require('../src/external');

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
