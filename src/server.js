'use strict';

const fs = require('fs');
const http = require('http');
const { guessFromPrompts } = require('./lang');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/office3d.js': ['office3d.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/popout.js': ['popout.js', 'text/javascript; charset=utf-8'],
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
// 3D models, served as-is (3D view only).
const MOUNTS = { '/assets/': path.join(__dirname, '..', 'assets') };
const scenes = require('./scenes');
const updater = require('./update');
const { ompResumeCommand } = require('./omp');
const { dayKey } = require('./parsers');

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  // no-cache: a reinstalled scene pack or an updated clone must show up on reload
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const ACTIVE = new Set(['thinking', 'tool', 'typing']);

// Logs only record finished blocks, so a few states need a clock to resolve:
// a reply with no follow-up is a finished turn, and an "active" session that
// has gone silent for a long time was most likely closed mid-turn.
function view(s, now, { privacy }) {
  const quiet = now - (s.lastEventAt || s.mtime || now);
  let status = s.status;
  if (status === 'typing' && !s.explicitLifecycle && quiet > 45_000) status = 'done';
  if (status === 'typing' && s.explicitLifecycle && quiet > 15 * 60_000) status = 'idle';
  if (status === 'thinking' && s.source !== 'magpie' && quiet > 15 * 60_000) status = 'idle';
  if (status === 'tool' && quiet > 45 * 60_000) status = 'idle';
  if ((status === 'waiting' || status === 'error') && quiet > 2 * 3600_000) status = 'idle';
  // Still "active" but silent for a while: likely stuck (a hung tool, a lost prompt).
  const stuckAfter = status === 'tool' ? 10 * 60_000 : status === 'thinking' ? 8 * 60_000 : Infinity;
  const stuck = quiet > stuckAfter ? Math.floor(quiet / 60_000) : 0;

  const out = {
    key: `${s.agent}:${s.id}`,
    agent: s.agent,
    ...(s.source === 'magpie' ? { source: s.source, agentName: s.agentName } : {}),
    id: s.id,
    sessionId: s.sessionId || null,
    parentId: s.parentId,
    subagent: s.subagent,
    cwd: s.cwd,
    project: s.cwd ? `${s.agent === 'copilot' ? 'workspace-' : ''}${path.basename(s.cwd)}` : null,
    title: s.title,
    model: s.model,
    status,
    stuck,
    context: s.context ? { used: s.context, window: s.contextWindow || null } : null,
    today: s.daily && s.daily.day === dayKey(now) ? { turns: s.daily.turns, tokens: s.daily.tokens } : null,
    activity: status === 'tool' || status === 'waiting' ? s.activity : null,
    prompt: s.prompt,
    reply: s.reply,
    error: s.error,
    turnStartedAt: s.turnStartedAt,
    lastEventAt: s.lastEventAt || s.mtime,
    startedAt: s.startedAt,
  };
  if (s.agent === 'omp' && s.source !== 'magpie') {
    out.ompProfile = s.ompProfile || null;
    // OMP subagents can't be resumed on their own.
    out.resumeCommand = s.subagent || !s.file ? null : ompResumeCommand(s);
  }
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

// Today's totals across every session seen today, main sessions and subagents alike.
function summary(sessions, now) {
  // Folder names are keys here, so no prototype: a project called __proto__ stays a project.
  const out = { day: dayKey(now), turns: 0, tokens: 0, agents: 0, byAgent: Object.create(null), projects: Object.create(null) };
  for (const s of sessions) {
    if (!s.today) continue;
    out.agents += 1;
    out.turns += s.today.turns;
    out.tokens += s.today.tokens;
    const a = (out.byAgent[s.agent] ||= { sessions: 0, turns: 0, tokens: 0 });
    a.sessions += 1; a.turns += s.today.turns; a.tokens += s.today.tokens;
    if (s.project) out.projects[s.project] = (out.projects[s.project] || 0) + s.today.turns;
  }
  return out;
}

function snapshot(watcher, opts) {
  const now = Date.now();
  const raw = watcher.sessions();
  const sessions = raw.map((s) => view(s, now, opts));
  sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  return { now, lang: opts.demo ? null : promptLanguage(raw), sessions, summary: summary(sessions, now) };
}

function createServer(watcher, opts, { onShutdown, onRestart } = {}) {
  const clients = new Set();
  let last = '';

  const push = (force) => {
    let body;
    try { body = JSON.stringify(snapshot(watcher, opts)); } catch (e) { console.error('snapshot failed:', e.message); return; }
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
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice(m.length)); }
      catch { res.writeHead(400).end(); return; }
      serveFile(res, MOUNTS[m], rel);
    } else if (url.pathname.startsWith('/scenes/')) {
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice('/scenes/'.length)); }
      catch { res.writeHead(400).end(); return; }
      const [id, ...rest] = rel.split('/');
      const dir = scenes.sceneDir(id);
      if (!dir) res.writeHead(404).end();
      else serveFile(res, dir, rest.join('/'));
    } else if (url.pathname === '/api/scenes') {
      const cat = scenes.catalog();
      const icon = (x) => x.icon || (cat.find((c) => c.id === x.id) || {}).icon || '🗺️';
      const have = scenes.installed().map((x) => ({ ...x, icon: icon(x) }));
      const ids = new Set(have.map((x) => x.id));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        installed: have.map(({ id, name, version, credits, icon }) => ({ id, name, version, credits, icon })),
        available: cat.filter((x) => !ids.has(x.id)).map(({ id, name, version, size, credits, icon }) => ({ id, name, version, size, credits, icon: icon || '🗺️' })),
      }));
    } else if (url.pathname === '/api/scenes/install' && req.method === 'POST') {
      // Same guard as shutdown: a custom header web pages can't send cross-site.
      if (req.headers['x-whatsmyagentdoing'] !== 'install') { res.writeHead(403).end(); return; }
      const id = url.searchParams.get('id') || '';
      scenes.install(id).then(
        (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: x.id })); },
        (e) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); },
      );
    } else if (url.pathname === '/api/transcript') {
      // --private hides prompts and replies everywhere, so it hides the conversation too.
      const key = url.searchParams.get('key') || '';
      const messages = opts.privacy || key.length > 600 ? null : watcher.transcript?.(key);
      res.writeHead(messages ? 200 : opts.privacy ? 403 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(messages ? { messages } : { messages: [], private: !!opts.privacy }));
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
    } else if (url.pathname === '/api/version') {
      updater.checkLatest().finally(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(updater.info()));
      });
    } else if (url.pathname === '/api/update' && req.method === 'POST') {
      // Same guard as shutdown: web pages can't send this header cross-site.
      if (req.headers['x-whatsmyagentdoing'] !== 'update') { res.writeHead(403).end(); return; }
      updater.update().then(
        (version) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version }));
          for (const c of clients) c.end();
          if (onRestart) setTimeout(onRestart, 100);
        },
        (e) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); },
      );
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
