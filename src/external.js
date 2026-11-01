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

function opencode(db, since) {
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
  const rows = db.prepare(`select id, model, parent_session_id, started_at, ended_at
    from sessions where started_at >= ? order by started_at desc`).all(since / 1000);
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

module.exports = { poll, location, opencodeState, hermesState };
