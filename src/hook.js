'use strict';

// Optional Claude Code hook: Claude Code doesn't log permission prompts, so a
// tool waiting on approval looks like it's still running. With the hook
// installed, Claude Code runs `cli.js --hook` on each Notification; for
// permission and question prompts it writes a small marker file that the
// watcher shows as "Waiting for you" until the session logs anything newer.
// The marker holds the session ID, a time and Claude Code's own short message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const WAIT_DIR = () => path.join(os.homedir(), '.whatsmyagentdoing', 'waiting');
const SETTINGS = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
// Our entry, wherever the skill is installed: `<node> "<…>/bin/cli.js" --hook`.
const OURS = /[\\/]bin[\\/]cli\.js"? --hook$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NEEDS_YOU = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

// Claude Code runs a hook command through sh (or Git Bash / PowerShell on
// Windows). PowerShell can't run a quoted path as a command, so Windows uses
// the exec form, which starts node.exe directly without a shell.
function entry(platform = process.platform) {
  if (platform === 'win32') return { type: 'command', command: process.execPath, args: [CLI, '--hook'] };
  return { type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} --hook` };
}

// Reads one Notification payload. Returns true when a marker was written.
function record(input, now = Date.now()) {
  let d;
  try { d = JSON.parse(input); } catch { return false; }
  if (!d || typeof d.session_id !== 'string' || !SESSION_ID.test(d.session_id)) return false;
  const type = typeof d.notification_type === 'string' ? d.notification_type : '';
  const message = typeof d.message === 'string' ? d.message.slice(0, 160) : '';
  // Older Claude Code versions send no type; their permission message says so.
  if (!(NEEDS_YOU.has(type) || (!type && /permission/i.test(message)))) return false;
  fs.mkdirSync(WAIT_DIR(), { recursive: true });
  const file = path.join(WAIT_DIR(), `${d.session_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: now, message }));
  fs.renameSync(tmp, file);
  return true;
}

// session ID -> { at, message } for markers newer than sinceMs; older ones are removed.
function markers(sinceMs) {
  const out = new Map();
  let entries;
  try { entries = fs.readdirSync(WAIT_DIR(), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -5), file = path.join(WAIT_DIR(), e.name);
    if (!SESSION_ID.test(id)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isFinite(m.at) || m.at < sinceMs) { fs.unlinkSync(file); continue; }
      out.set(id, { at: m.at, message: typeof m.message === 'string' ? m.message.slice(0, 160) : '' });
    } catch {}
  }
  return out;
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const d = JSON.parse(text);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${file} is not a JSON object`);
  return d;
}

function ours(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string'
    && (OURS.test(h.command.trim()) || (Array.isArray(h.args) && OURS.test(`${h.args.join(' ')}`))));
}

function writeSettings(file, d) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Adds (or refreshes) the hook in Claude Code's user settings, keeping every other setting and hook.
function install(file = SETTINGS(), platform = process.platform) {
  const d = readSettings(file);
  if (d.hooks !== undefined && (typeof d.hooks !== 'object' || Array.isArray(d.hooks))) throw new Error('"hooks" in settings.json is not an object');
  d.hooks = d.hooks || {};
  const list = Array.isArray(d.hooks.Notification) ? d.hooks.Notification.filter((g) => !ours(g)) : [];
  list.push({ matcher: '', hooks: [entry(platform)] });
  d.hooks.Notification = list;
  writeSettings(file, d);
  return file;
}

function uninstall(file = SETTINGS()) {
  const d = readSettings(file);
  const list = d.hooks?.Notification;
  if (!Array.isArray(list) || !list.some(ours)) return false;
  const kept = list.filter((g) => !ours(g));
  if (kept.length) d.hooks.Notification = kept;
  else delete d.hooks.Notification;
  if (!Object.keys(d.hooks).length) delete d.hooks;
  writeSettings(file, d);
  return true;
}

function installed(file = SETTINGS()) {
  try { return (readSettings(file).hooks?.Notification || []).some(ours); } catch { return false; }
}

module.exports = { record, markers, install, uninstall, installed, SETTINGS, WAIT_DIR };
