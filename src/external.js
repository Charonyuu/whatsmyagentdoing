'use strict';

// opencode and hermes keep every session in one SQLite database instead of a
// log file per session, so the incremental file readers in watcher.js cannot
// see them. Read them here through Node's built-in SQLite module: no
// dependency to install, and a Node too old to have it simply skips both.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { newSession, clean } = require('./parsers');

// First existing path wins, so the environment override stays explicit. Home
// and env come from the caller, which is how tests keep their fixtures out of
// the developer's real databases.
function candidates(home, env) {
  return {
    opencode: [
      env.OPENCODE_DB,
      path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'opencode.db'),
    ].filter(Boolean),
    hermes: [
      env.HERMES_HOME && path.join(env.HERMES_HOME, 'state.db'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'hermes', 'state.db'),
      path.join(home, '.hermes', 'state.db'),
    ].filter(Boolean),
  };
}

// Loaded on first use: a machine without either agent never touches it, and
// older Node builds only lose these two agents.
let sqlite;
function sqliteModule() {
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
  }
  return sqlite;
}

function database(candidates) {
  const mod = sqliteModule();
  if (!mod) return null;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const db = new mod.DatabaseSync(file, { readOnly: true });
      // The agent app is writing this database; wait rather than fail.
      db.exec('PRAGMA busy_timeout = 2000');
      return db;
    } catch {}
  }
  return null;
}

function session(agent, id, fields) {
  const s = newSession(agent, id, null);
  // Both clients record a turn's start and end, so silence never has to be
  // interpreted: keep the status the last message gives.
  s.explicitLifecycle = true;
  s.parentId = fields.parentId || null;
  s.subagent = !!fields.parentId;
  s.cwd = fields.cwd || null;
  s.title = fields.title || null;
  s.model = fields.model || null;
  s.status = fields.status || 'idle';
  s.activity = fields.activity || null;
  s.prompt = fields.prompt || null;
  s.reply = fields.reply || null;
  s.error = fields.error || null;
  s.turnStartedAt = fields.turnStartedAt || null;
  s.lastEventAt = fields.lastEventAt || null;
  s.startedAt = fields.startedAt || null;
  return s;
}

// --- opencode -------------------------------------------------------------

function opencodeModel(value) {
  if (!value) return null;
  try { return JSON.parse(value).id || null; } catch { return String(value); }
}

// The newest part of the last message says what the agent is doing right now;
// parts arrive newest first.
function opencodeState(message, parts) {
  if (!message) return { status: 'idle' };
  if (message.role === 'user') return { status: 'thinking' };
  if (message.error) return { status: 'error', error: clean(message.error.name || message.error.message) || 'Error' };
  const running = parts.find((p) => p.type === 'tool' && p.state &&
    (p.state.status === 'running' || p.state.status === 'pending'));
  if (message.finish === 'tool-calls') {
    return running ? { status: 'tool', activity: running.tool || 'Tool' } : { status: 'tool' };
  }
  if (message.finish === 'stop') return { status: 'done' };
  if (message.finish === 'error') return { status: 'error', error: 'Turn failed' };
  // A turn cancelled before its last message lands keeps no finish reason, but
  // it does record a completion time.
  if (message.time && message.time.completed) return { status: 'done' };
  const latest = parts[0];
  if (latest && latest.type === 'tool') return { status: 'tool', activity: latest.tool || 'Tool' };
  if (latest && latest.type === 'text') return { status: 'typing' };
  return { status: 'thinking' };
}

function opencodeV1(db, since) {
  const rows = db.prepare(`select id, parent_id, title, directory, model, time_created, time_updated
    from session where time_updated >= ? order by time_updated desc`).all(since);
  const recent = db.prepare('select id, data from message where session_id = ? order by time_created desc limit 8');
  const partsOf = db.prepare('select data from part where message_id = ? order by time_created desc limit 40');
  // The message row's own id keys its parts; the JSON body does not carry one.
  const parse = (rows) => rows.map((r) => {
    try { return { ...JSON.parse(r.data), id: r.id }; } catch { return null; }
  }).filter(Boolean);

  const out = [];
  for (const row of rows) {
    const messages = parse(recent.all(row.id));
    const last = messages[0] || null;
    const parts = last ? parse(partsOf.all(last.id)) : [];
    const state = opencodeState(last, parts);
    const userMessage = messages.find((m) => m.role === 'user');
    const userParts = userMessage ? parse(partsOf.all(userMessage.id)).reverse() : [];
    const replyParts = last && last.role === 'assistant' ? parts.slice().reverse() : [];
    out.push(session('opencode', row.id, {
      parentId: row.parent_id,
      cwd: row.directory,
      title: row.title,
      model: opencodeModel(row.model),
      prompt: clean(userParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')),
      reply: clean(replyParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')),
      status: state.status,
      activity: state.activity,
      error: state.error,
      turnStartedAt: userMessage && userMessage.time ? userMessage.time.created : null,
      lastEventAt: row.time_updated,
      startedAt: row.time_created,
    }));
  }
  return out;
}

// OpenCode 2.x keeps its sessions in session_v2 / session_message and no longer
// writes the session / message / part tables above. Each session_message row is
// typed: `user`, `assistant` (content blocks: reasoning, text, tool), `idle` (a
// turn ended, with an outcome of succeeded or failed), plus `model-switched`
// and `system`, which say nothing about what the agent is doing.
const OPENCODE_V2_ASKS = new Set(['question']);
const OPENCODE_V2_OPEN = new Set(['running', 'pending']);

function opencodeV2State(message) {
  if (!message) return { status: 'idle' };
  const body = message.body;
  if (message.type === 'idle') {
    if (body.outcome === 'failed') {
      return { status: 'error', error: clean(body.error && (body.error.message || body.error.type)) || 'Turn failed' };
    }
    return { status: body.outcome === 'succeeded' ? 'done' : 'idle' };
  }
  if (message.type === 'user') return { status: 'thinking' };

  const blocks = Array.isArray(body.content) ? body.content.filter(Boolean) : [];
  const open = blocks.filter((b) => b.type === 'tool' && b.state && OPENCODE_V2_OPEN.has(b.state.status));
  if (open.length) {
    // A tool that asks the user something stays "running" until they answer.
    const ask = open.find((b) => OPENCODE_V2_ASKS.has(b.name));
    if (ask) return { status: 'waiting', activity: ask.name };
    return { status: 'tool', activity: open[open.length - 1].name || 'Tool' };
  }
  if (body.finish === 'error') {
    return { status: 'error', error: clean(body.error && (body.error.message || body.error.type)) || 'Turn failed' };
  }
  if (body.finish === 'stop' || body.finish === 'length') return { status: 'done' };
  // Not finished yet: the newest block says what is being produced. After a
  // step that ended in tool calls (all finished) the model is reading the results.
  if (!(body.time && body.time.completed)) {
    const latest = blocks[blocks.length - 1];
    if (latest && latest.type === 'text') return { status: 'typing' };
  }
  return { status: 'thinking' };
}

function opencodeV2(db, since) {
  const rows = db.prepare(`select id, parent_id, title, directory, model, time_created, time_updated
    from session_v2 where time_updated >= ? order by time_updated desc`).all(since);
  const recent = db.prepare(`select type, data from session_message
    where session_id = ? and type in ('user', 'assistant', 'idle')
    order by time_created desc, seq desc limit 6`);
  const lastUser = db.prepare(`select type, data from session_message
    where session_id = ? and type = 'user' order by time_created desc, seq desc limit 1`);
  const parse = (r) => {
    try { return { type: r.type, body: JSON.parse(r.data) || {} }; } catch { return null; }
  };
  const text = (m) => (Array.isArray(m.body.content) ? m.body.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');

  const out = [];
  for (const row of rows) {
    const messages = recent.all(row.id).map(parse).filter(Boolean);
    const user = parse(lastUser.get(row.id) || {}) || null;
    const state = opencodeV2State(messages[0]);
    // The reply is the newest assistant text of the current turn; a turn that has
    // just started (the newest message is the prompt) has no reply yet.
    const turn = messages.findIndex((m) => m.type === 'user');
    const reply = messages.slice(0, turn < 0 ? messages.length : turn)
      .find((m) => m.type === 'assistant' && text(m));
    out.push(session('opencode', row.id, {
      parentId: row.parent_id,
      cwd: row.directory,
      title: row.title,
      model: opencodeModel(row.model),
      prompt: user ? clean(typeof user.body.text === 'string' ? user.body.text : '') : null,
      reply: reply ? clean(text(reply)) : null,
      status: state.status,
      activity: state.activity,
      error: state.error,
      turnStartedAt: user && user.body.time ? user.body.time.created : null,
      lastEventAt: row.time_updated,
      startedAt: row.time_created,
    }));
  }
  return out;
}

// A database can hold both generations: OpenCode 2 copies the sessions of an
// older install into session_v2 (with their messages) and then only writes
// there. A session found in both is therefore read from session_v2.
function opencode(db, since) {
  const has = (name) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
  const byId = new Map();
  if (has('session')) {
    try { for (const s of opencodeV1(db, since)) byId.set(s.id, s); } catch { /* try the other layout */ }
  }
  if (has('session_v2') && has('session_message')) {
    try { for (const s of opencodeV2(db, since)) byId.set(s.id, s); } catch { /* keep what v1 gave */ }
  }
  return [...byId.values()];
}

// --- hermes ---------------------------------------------------------------

// Hermes writes one row per message; the newest row's role and finish reason
// are the same signal a streaming log would give.
function hermesState(message, ended) {
  if (!message) return { status: ended ? 'idle' : 'thinking' };
  if (message.role === 'user' || message.role === 'tool') return { status: 'thinking' };
  if (message.role === 'assistant') {
    if (message.finish_reason === 'tool_calls') return { status: 'tool', activity: message.tool_name || 'Tool' };
    if (message.finish_reason === 'stop' || message.finish_reason === 'length') return { status: 'done' };
    if (!message.finish_reason) return { status: 'typing' };
  }
  return { status: ended ? 'done' : 'idle' };
}

function hermes(db, since) {
  // Unlike opencode, hermes keeps no "last updated" column, so a long chat that
  // is still in use would drop out if only the start time were compared.
  const rows = db.prepare(`select s.id, s.model, s.parent_session_id, s.started_at, s.ended_at
    from sessions s
    where s.started_at >= ?
       or (select max(timestamp) from messages m where m.session_id = s.id) >= ?
    order by s.started_at desc`).all(since / 1000, since / 1000);
  const lastMessage = db.prepare(`select role, tool_name, content, timestamp, finish_reason
    from messages where session_id = ? order by timestamp desc limit 1`);
  const lastOfRole = db.prepare(`select content, timestamp from messages
    where session_id = ? and role = ? order by timestamp desc limit 1`);

  const out = [];
  for (const row of rows) {
    const last = lastMessage.get(row.id) || null;
    const prompt = lastOfRole.get(row.id, 'user');
    const reply = lastOfRole.get(row.id, 'assistant');
    const state = hermesState(last, !!row.ended_at);
    const startedAt = row.started_at * 1000;
    out.push(session('hermes', row.id, {
      parentId: row.parent_session_id,
      model: row.model,
      prompt: prompt ? clean(prompt.content) : null,
      reply: reply ? clean(reply.content) : null,
      status: state.status,
      activity: state.activity,
      error: last && last.finish_reason === 'error' ? 'Turn failed' : null,
      turnStartedAt: prompt ? prompt.timestamp * 1000 : null,
      lastEventAt: Math.max(last ? last.timestamp * 1000 : 0, startedAt),
      startedAt,
    }));
  }
  return out;
}

// --- watcher hook ---------------------------------------------------------

// Returns every opencode and hermes session inside the window. A database that
// cannot be read is skipped and its sessions simply stay out of the office;
// the file-based readers are untouched by any failure here.
function poll(since, { home = os.homedir(), env = process.env } = {}) {
  const out = [];
  if (!sqliteModule()) return out;
  const paths = candidates(home, env);
  for (const [read, list] of [[opencode, paths.opencode], [hermes, paths.hermes]]) {
    const db = database(list);
    if (!db) continue;
    try { out.push(...read(db, since)); } catch { /* keep the other agent's rows */ } finally { db.close(); }
  }
  return out;
}

// The paths this process would read, for the CLI's "Reads (never writes)" list.
function location() {
  const paths = candidates(os.homedir(), process.env);
  return { opencode: paths.opencode[0], hermes: paths.hermes[0] };
}

// A Node without node:sqlite silently loses both agents, so say it once at
// startup instead of leaving the user wondering where their sessions went.
function notice({ home = os.homedir(), env = process.env, sqlite: available = sqliteModule() } = {}) {
  if (available) return null;
  const paths = candidates(home, env);
  const found = [...paths.opencode, ...paths.hermes].filter((file) => fs.existsSync(file));
  if (!found.length) return null;
  return `opencode and hermes sessions need Node.js 22.13 or newer (this is ${process.version}); `
    + 'their databases are being skipped, other agents are unaffected.';
}

module.exports = { poll, location, notice, opencodeState, opencodeV2State, hermesState };
