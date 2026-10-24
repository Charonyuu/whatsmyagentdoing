'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const { guessFromPrompts } = require('./lang');
const { newSession, applyCopilot } = require('./parsers');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/office3d.js': ['office3d.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png' };
// 3D models, served as-is (3D view only).
const MOUNTS = { '/assets/': path.join(__dirname, '..', 'assets') };

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' });
  fs.createReadStream(file).pipe(res);
}
const ACTIVE = new Set(['thinking', 'tool', 'typing']);

// Logs only record finished blocks, so a few states need a clock to resolve:
// a reply with no follow-up is a finished turn, and an "active" session that
// has gone silent for a long time was most likely closed mid-turn.
function view(s, now, { privacy }) {
  const quiet = now - (s.lastEventAt || s.mtime || now);
  let status = s.status;
  if (status === 'typing' && quiet > 45_000) status = 'done';
  if (status === 'thinking' && quiet > 15 * 60_000) status = 'idle';
  if (status === 'tool' && quiet > 45 * 60_000) status = 'idle';
  if ((status === 'waiting' || status === 'error') && quiet > 2 * 3600_000) status = 'idle';

  const out = {
    key: `${s.agent}:${s.id}`,
    agent: s.agent,
    id: s.id,
    sessionId: s.sessionId || null,
    parentId: s.parentId,
    subagent: s.subagent,
    cwd: s.cwd,
    project: s.cwd ? `${s.agent === 'copilot' ? 'workspace-' : ''}${path.basename(s.cwd)}` : null,
    title: s.title,
    model: s.model,
    status,
    activity: status === 'tool' || status === 'waiting' ? s.activity : null,
    prompt: s.prompt,
    reply: s.reply,
    error: s.error,
    turnStartedAt: s.turnStartedAt,
    lastEventAt: s.lastEventAt || s.mtime,
    startedAt: s.startedAt,
  };
  if (privacy) {
    out.prompt = out.reply = out.title = null;
    if (out.activity) out.activity = out.activity.split(/[:\s]/)[0];
  }
  return out;
}

// The language the user writes their prompts in (recent sessions first);
// the page uses it as the default UI language.
function promptLanguage(raw) {
  const recent = raw
    .filter((s) => !s.subagent && s.prompt && !s.prompt.startsWith('/'))
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))
    .slice(0, 60)
    .map((s) => s.prompt);
  return guessFromPrompts(recent);
}

function currentCopilotSession() {
  const stateDir = path.join(os.homedir(), '.copilot', 'session-state');
  if (!fs.existsSync(stateDir)) return null;
  const dirs = fs.readdirSync(stateDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      full: path.join(stateDir, d.name),
      mtime: fs.statSync(path.join(stateDir, d.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  const active = dirs[0];
  if (!active) return null;
  const eventsFile = path.join(active.full, 'events.jsonl');
  if (!fs.existsSync(eventsFile)) return null;

  const s = newSession('copilot', active.name, eventsFile);
  s.title = 'Current Copilot';
  s.model = 'mai-code-1.1-flash';
  const workspace = path.join(active.full, 'workspace.yaml');
  if (fs.existsSync(workspace)) {
    const text = fs.readFileSync(workspace, 'utf8');
    const match = text.match(/^cwd:\s*(.+)$/m);
    if (match) s.cwd = match[1].replace(/\\/g, path.sep).replace(/^c:/i, 'C:');
  }

  for (const line of fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      applyCopilot(s, JSON.parse(line));
    } catch {}
  }
  if (!s.cwd && s.agent === 'copilot') s.cwd = process.cwd();
  s.lastEventAt = s.lastEventAt || fs.statSync(eventsFile).mtimeMs;
  s.startedAt = s.startedAt || s.lastEventAt;
  return s;
}

function snapshot(watcher, opts) {
  const now = Date.now();
  const raw = [...watcher.sessions()];
  const current = currentCopilotSession();
  if (current) raw.push(current);
  const dedupe = new Map();
  for (const s of raw) dedupe.set(`${s.agent}:${s.id}`, s);
  const sessions = [...dedupe.values()].map((s) => view(s, now, opts));
  sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  return { now, lang: opts.demo ? null : promptLanguage([...dedupe.values()]), sessions };
}

function createServer(watcher, opts, { onShutdown } = {}) {
  const clients = new Set();
  let last = '';

  const push = (force) => {
    const body = JSON.stringify(snapshot(watcher, opts));
    // Compare without the timestamp so idle ticks don't spam clients.
    const sig = body.replace(/^\{"now":\d+,/, '{');
    if (!force && sig === last) return;
    last = sig;
    for (const res of clients) res.write(`data: ${body}\n\n`);
  };
  watcher.on('change', () => push(false));
  // Status can flip with no new log lines (see view()), so re-check on a clock.
  setInterval(() => push(false), 5000).unref();
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

  const server = http.createServer((req, res) => {
    // Refuse anything not addressed to loopback (blocks DNS-rebinding pages
    // from reading your prompts through this server).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    } else if (Object.keys(MOUNTS).some((m) => url.pathname.startsWith(m))) {
      const m = Object.keys(MOUNTS).find((k) => url.pathname.startsWith(k));
      serveFile(res, MOUNTS[m], decodeURIComponent(url.pathname.slice(m.length)));
    } else if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot(watcher, opts)));
    } else if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      // Only our CLI sends this header; a web page can't add a custom header
      // to a cross-site request without a CORS preflight, which we never allow.
      if (req.headers['x-whatsmyagentdoing'] !== 'stop' || !onShutdown) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      for (const c of clients) c.end();
      setTimeout(onShutdown, 50);
    } else if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'whatsmyagentdoing' }));
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(watcher, opts))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404).end();
    }
  });
  return server;
}

module.exports = { createServer, snapshot };
