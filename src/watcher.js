'use strict';

// Finds recent session logs on disk and keeps reading them as they grow.
// Polling (not fs.watch) because it behaves the same on macOS, Linux and
// Windows, and a 1s stat loop over a few hundred files is cheap.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const { newSession, applyClaude, applyCodex, applyGemini, applyGeminiDocument, applyCopilot, applyOMP } = require('./parsers');
const { Magpie } = require('./magpie');
const { clientFiles, metadata, applyKimi, applyDsh, applyGrok, readDsh } = require('./clients');
const { ompDirs } = require('./omp');
const hook = require('./hook');

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 768 * 1024;
// OMP, Kimi and Grok logs are replayed whole up to this size, then read head + tail like the others.
const OMP_FULL_BYTES = 32 * 1024 * 1024;
// DSH logs are decoded and replayed whole, so a busy log is re-read at most this often.
const DSH_REPLAY_MS = 5000;

const home = os.homedir();
const CLAUDE_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(home, '.codex');
const CODEX_DIR = path.join(CODEX_HOME, 'sessions');
const CODEX_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
// Gemini CLI: ~/.gemini (or $GEMINI_CLI_HOME/.gemini); sandboxed runs on
// macOS keep their state under ~/.cache/.gemini instead.
const GEMINI_HOMES = [
  path.join(process.env.GEMINI_CLI_HOME || home, '.gemini'),
  path.join(home, '.cache', '.gemini'),
];
const GEMINI_DIR = path.join(GEMINI_HOMES[0], 'tmp');
const COPILOT_DIR = path.join(home, '.copilot', 'session-state');
const CLIENT_DIRS = {
  kimi: path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions'),
  dsh: path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'sessions'),
  grok: path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions'),
};

function ls(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statSafe(f) {
  try { return fs.statSync(f); } catch { return null; }
}

function readRange(file, start, end, decoder) {
  const len = Math.max(0, end - start);
  if (!len) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return decoder ? decoder.write(buf) : buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function claudeFiles() {
  const out = [];
  for (const proj of ls(CLAUDE_DIR)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(CLAUDE_DIR, proj.name);
    for (const e of ls(pdir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ agent: 'claude', file: path.join(pdir, e.name), id: e.name.slice(0, -6) });
      } else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        for (const s of ls(sub)) {
          if (s.isFile() && s.name.endsWith('.jsonl')) {
            out.push({ agent: 'claude', file: path.join(sub, s.name), id: s.name.slice(0, -6), parentId: e.name });
          }
        }
      }
    }
  }
  return out;
}

function geminiFiles() {
  // <root>/tmp/<project>/chats/session-*.jsonl (+ legacy .json), and
  // subagents in <root>/tmp/<project>/chats/<parentSessionId>/<id>.jsonl
  const out = [];
  for (const root of GEMINI_HOMES) {
    const tmp = path.join(root, 'tmp');
    for (const proj of ls(tmp)) {
      if (!proj.isDirectory()) continue;
      const chats = path.join(tmp, proj.name, 'chats');
      for (const e of ls(chats)) {
        if (e.isFile() && /^session-.*\.jsonl?$/.test(e.name)) {
          out.push({ agent: 'gemini', file: path.join(chats, e.name), id: e.name.replace(/\.jsonl?$/, ''), project: proj.name, root });
        } else if (e.isDirectory()) {
          for (const f of ls(path.join(chats, e.name))) {
            if (f.isFile() && /\.jsonl$/.test(f.name)) {
              out.push({ agent: 'gemini', file: path.join(chats, e.name, f.name), id: f.name.slice(0, -6), project: proj.name, root, parentId: e.name });
            }
          }
        }
      }
    }
  }
  return out;
}

function codexFiles(sinceMs) {
  // Date folders record when a chat began, not when it was last used. Walk
  // every date so a months-old chat can be discovered when it resumes.
  // Check mtime here to keep inactive history out of the 1s polling list;
  // only the 5s discovery scan stats those files, without reading their logs.
  const out = [];
  for (const y of ls(CODEX_DIR)) {
    if (!y.isDirectory()) continue;
    for (const m of ls(path.join(CODEX_DIR, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of ls(path.join(CODEX_DIR, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(CODEX_DIR, y.name, m.name, d.name);
        for (const f of ls(dir)) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const file = path.join(dir, f.name);
          const st = statSafe(file);
          if (!st || st.mtimeMs < sinceMs) continue;
          const id = (f.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1] || f.name;
          out.push({ agent: 'codex', file, id });
        }
      }
    }
  }
  return out;
}

function copilotFiles() {
  const out = [];
  for (const session of ls(COPILOT_DIR)) {
    if (!session.isDirectory()) continue;
    const events = path.join(COPILOT_DIR, session.name, 'events.jsonl');
    if (statSafe(events)) out.push({ agent: 'copilot', file: events, id: session.name });
  }
  return out;
}

function ompFiles(sinceMs, roots) {
  const out = [], seen = new Set();
  const add = (dir, profile, parentFile = null, depth = 0) => {
    if (depth > 20) return;
    const entries = ls(dir);
    // OMP keeps each agent's children in a directory named after its own log.
    // Dirents don't follow symlinks, so a linked directory is never walked.
    const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.includes('.bak')) continue;
      if (!parentFile && e.name.startsWith('__advisor')) continue;
      const file = path.join(dir, e.name), st = statSafe(file);
      if (!st) continue;
      const fresh = st.mtimeMs >= sinceMs;
      if (fresh && !seen.has(file)) {
        seen.add(file);
        out.push({ agent: 'omp', file, id: null, profile, parentFile });
      }
      const stem = e.name.slice(0, -6);
      if (!dirs.has(stem)) continue;
      const children = path.join(dir, stem);
      // A quiet parent whose child directory gained no entries in the window
      // has no new children, so old history isn't walked on every scan.
      if (!fresh && (statSafe(children)?.mtimeMs || 0) < sinceMs) continue;
      add(children, profile, file, depth + 1);
    }
  };
  for (const { dir, profile } of roots) {
    add(dir, profile); // --session-dir may point straight at a log directory
    for (const e of ls(dir)) {
      // A root-level log's sibling artifact directory is not a project directory.
      if (e.isDirectory() && !statSafe(path.join(dir, e.name + '.jsonl'))) add(path.join(dir, e.name), profile);
    }
  }
  return out;
}

// OMP may record a parent through a symlink (macOS /var, a linked ~/.omp) or,
// on Windows, with different case; compare real paths. Cached per session.
function sameOMPPath(s, a, b) {
  const key = `${a}\0${b}`;
  if (s._ompPathKey === key) return s._ompPathSame;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  s._ompPathKey = key;
  s._ompPathSame = path.resolve(a) === path.resolve(b) || real(a) === real(b);
  return s._ompPathSame;
}

class Watcher extends EventEmitter {
  constructor({ hours = 24, interval = 1000, ompDir, magpieSources = process.env.WMAD_MAGPIE_SOURCES,
    magpieUrl = process.env.WMAD_MAGPIE_URL, magpieKey = process.env.WMAD_MAGPIE_KEY } = {}) {
    super();
    this.windowMs = hours * 3600 * 1000;
    this.interval = interval;
    this.trackers = new Map(); // file -> { session, offset, partial, apply }
    this.failed = new Map();   // file -> retry-after time, for logs we couldn't read
    this.dshWarned = false;
    this.codexNames = new Map();
    this.geminiProjects = new Map(); // tmp dir name -> project path
    this.geminiRegistryMtime = 0;
    this.codexIndexMtime = 0;
    this.lastScan = 0;
    this.candidates = [];
    if (typeof magpieSources === 'string') {
      try { magpieSources = JSON.parse(magpieSources); } catch { throw new Error('WMAD_MAGPIE_SOURCES must be a JSON array of {url, key} objects'); }
    }
    const sources = magpieSources ?? (magpieUrl ? [{ url: magpieUrl, key: magpieKey }] : []);
    if (!Array.isArray(sources) || sources.some((s) => !s || typeof s.url !== 'string' || typeof s.key !== 'string')) {
      throw new Error('WMAD_MAGPIE_SOURCES must be an array of {url, key} objects');
    }
    this.magpies = sources.map(({ url, key }, i) => {
      const source = new Magpie({ url, key, hours });
      source.on('change', () => this.emit('change'));
      source.on('warning', (message) => console.error(`Magpie source ${i + 1}: ${message}; its sessions are idle. Retrying.`));
      return source;
    });
    this.ompDir = ompDir;
    this.ompParentIds = new Map(); // parent log -> { mtime, size, id }
    this.waiting = new Map(); // Claude session ID -> { at, message } from the optional hook
  }

  start() {
    this.tick();
    for (const source of this.magpies) source.start();
    this.timer = setInterval(() => this.tick(), this.interval);
    return this;
  }

  stop() { clearInterval(this.timer); for (const source of this.magpies) source.stop(); }

  loadCodexIndex() {
    const st = statSafe(CODEX_INDEX);
    if (!st || st.mtimeMs === this.codexIndexMtime) return false;
    this.codexIndexMtime = st.mtimeMs;
    const start = Math.max(0, st.size - 2 * 1024 * 1024);
    for (const line of readRange(CODEX_INDEX, start, st.size).split('\n')) {
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) this.codexNames.set(d.id, d.thread_name);
      } catch {}
    }
    return true;
  }

  // ~/.gemini/projects.json maps project paths to the short slugs used as
  // tmp dir names; older versions used sha256(path) instead.
  loadGeminiProjects() {
    let mt = 0;
    const files = GEMINI_HOMES.map((r) => path.join(r, 'projects.json'));
    for (const f of files) mt += (statSafe(f) || {}).mtimeMs || 0;
    if (mt === this.geminiRegistryMtime) return false;
    this.geminiRegistryMtime = mt;
    for (const f of files) {
      try {
        const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const [dir, slug] of Object.entries(reg.projects || {})) {
          this.geminiProjects.set(slug, dir);
          this.geminiProjects.set(crypto.createHash('sha256').update(dir).digest('hex'), dir);
        }
      } catch {}
    }
    return true;
  }

  tick() {
    const now = Date.now();
    const since = now - this.windowMs;
    let changed = this.loadCodexIndex();
    if (this.loadWaiting(since)) changed = true;
    if (this.loadGeminiProjects()) changed = true;

    // Directory walk every 5s; stat known files every tick.
    if (now - this.lastScan > 5000) {
      this.lastScan = now;
      this.candidates = [...claudeFiles(), ...codexFiles(since), ...geminiFiles(), ...copilotFiles(),
        ...clientFiles(CLIENT_DIRS, since), ...ompFiles(since, ompDirs(this.ompDir, process.env, home, process.platform))];
    }

    for (const c of this.candidates) {
      // A log we can't read (permissions, deleted mid-read…) is skipped and
      // retried a minute later; it must never take the server down.
      if ((this.failed.get(c.file) || 0) > now) continue;
      try {
        if (this.track(c, since)) changed = true;
      } catch (e) {
        if (c.agent === 'dsh') {
          // A zstd frame may be half-written. Keep the last readable snapshot.
          // A log over the replay limit stays too big, so don't decode it again soon.
          this.failed.set(c.file, now + (e?.tooLarge ? 60000 : DSH_REPLAY_MS));
          if (!this.dshWarned) {
            console.error('DSH: log decoding failed; keeping the last readable state and retrying. See the zstd requirements and size limit in README.');
            this.dshWarned = true;
          }
        } else {
          this.failed.set(c.file, now + 60000);
          this.trackers.delete(c.file);
        }
      }
    }

    for (const [file, t] of this.trackers) {
      const activity = t.session.agent === 'omp' ? Math.max(t.session.lastEventAt || 0, t.session.mtime || 0) : (t.session.lastEventAt || t.session.mtime || 0);
      if (activity < since) { this.trackers.delete(file); changed = true; }
    }

    if (changed) this.emit('change');
  }

  // Returns true when this file's session changed.
  track(c, since) {
    const st = statSafe(c.file);
    const t = this.trackers.get(c.file);
    if (!st) return c.agent === 'omp' && this.trackers.delete(c.file);
    if (!t) {
      if (st.mtimeMs < since) return false;
      this.open(c, st);
      return true;
    }
    if (c.agent === 'omp') {
      // The title slot is rewritten in place, sometimes without changing the size.
      const modified = st.mtimeMs !== t.mtime || st.ctimeMs !== t.ctime || st.ino !== t.ino;
      if (st.size < t.offset || (modified && st.size === t.offset) || st.ino !== t.ino) {
        this.open(c, st);
        return true;
      }
      if (st.size > t.offset) {
        this.feedOMP(t, c.file, t.offset, st.size);
        this.ompTitle(t, c.file, st.size);
        t.offset = st.size;
        t.mtime = t.session.mtime = st.mtimeMs;
        t.ctime = st.ctimeMs;
        return true;
      }
      return false;
    }
    let changed = false;
    if (t.whole && (st.mtimeMs !== t.mtime || st.size !== t.offset)) {
      // Whole documents and compressed streams are replaced only after reading.
      if (c.agent === 'dsh' && Date.now() - t.readAt < DSH_REPLAY_MS) return false;
      this.open(c, st);
      return true;
    } else if (st.size > t.offset) {
      this.feed(t, readRange(c.file, t.offset, st.size, t.decoder), false);
      t.offset = st.size;
      changed = true;
    } else if (st.size < t.offset) {
      // File was rewritten; start over.
      this.trackers.delete(c.file);
    }
    if (c.metadata) {
      const meta = statSafe(c.metadata);
      if (meta && (meta.mtimeMs !== t.metaMtime || meta.size !== t.metaSize)) {
        metadata(t.session, c.agent, c.metadata);
        t.metaMtime = meta.mtimeMs; t.metaSize = meta.size;
        changed = true;
      }
    }
    t.session.mtime = st.mtimeMs;
    return changed;
  }

  open(c, st) {
    const session = newSession(c.agent, c.id, c.file);
    if (c.sessionId) session.sessionId = c.sessionId;
    if (c.parentId) { session.parentId = c.parentId; session.subagent = true; }
    session.mtime = st.mtimeMs;
    if (c.agent === 'gemini') session.geminiProject = c.project;
    const apply = { claude: applyClaude, codex: applyCodex, gemini: applyGemini, copilot: applyCopilot, kimi: applyKimi, dsh: applyDsh, grok: applyGrok, omp: applyOMP }[c.agent];
    const t = { session, offset: st.size, partial: '', apply, mtime: st.mtimeMs };
    if (c.agent === 'dsh') {
      t.whole = true;
      t.readAt = Date.now();
      this.feed(t, readDsh(c.file), false);
      if (!session._dshHeader) throw new Error('DSH header is not readable yet');
      for (const [file, old] of this.trackers) {
        if (old.session.agent === 'dsh' && old.session.id === session.id) this.trackers.delete(file);
      }
      this.trackers.set(c.file, t);
      return t;
    }
    if (c.agent === 'omp') {
      session.ompProfile = c.profile;
      if (c.parentFile) {
        session.subagent = true;
        session.ompParentFile = c.parentFile;
        session.ompAgentName = path.basename(c.file, '.jsonl');
      }
      t.decoder = new StringDecoder('utf8');
      t.ctime = st.ctimeMs;
      t.ino = st.ino;
      // A full chunked replay keeps metadata and every open toolCall; past
      // OMP_FULL_BYTES only calls still open in the tail are seen.
      if (st.size <= OMP_FULL_BYTES) this.feedOMP(t, c.file, 0, st.size);
      else {
        this.feed(t, readRange(c.file, 0, HEAD_BYTES), true);
        t.partial = '';
        this.feedOMP(t, c.file, st.size - TAIL_BYTES, st.size, true);
      }
      this.ompTitle(t, c.file, st.size);
      this.trackers.set(c.file, t);
      return t;
    }
    if (c.agent === 'gemini' && c.file.endsWith('.json')) {
      t.whole = true;
      try { applyGeminiDocument(session, JSON.parse(readRange(c.file, 0, st.size))); } catch {}
      this.trackers.set(c.file, t);
      return t;
    }
    // Keep a decoder for later Kimi/Grok appends that split a UTF-8 character.
    if (c.agent === 'kimi' || c.agent === 'grok') t.decoder = new StringDecoder('utf8');
    if (t.decoder && st.size <= OMP_FULL_BYTES) {
      // Pending tools and approvals need every event, including the middle.
      for (let start = 0; start < st.size; start += TAIL_BYTES) {
        this.feed(t, readRange(c.file, start, Math.min(start + TAIL_BYTES, st.size), t.decoder), false);
      }
    } else if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      this.feed(t, readRange(c.file, 0, st.size), false);
    } else {
      // Big log: head for metadata (cwd, title, model), tail for current state.
      this.feed(t, readRange(c.file, 0, HEAD_BYTES), true);
      t.partial = '';
      this.feed(t, readRange(c.file, st.size - TAIL_BYTES, st.size, t.decoder), false, true);
    }
    if (c.metadata) {
      metadata(session, c.agent, c.metadata);
      const meta = statSafe(c.metadata);
      t.metaMtime = meta?.mtimeMs; t.metaSize = meta?.size;
    }
    this.trackers.set(c.file, t);
    return t;
  }

  feedOMP(t, file, start, end, skipFirstLine = false) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(128 * 1024);
      while (start < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - start), start);
        if (!n) break;
        let text = t.decoder.write(buf.subarray(0, n));
        if (skipFirstLine) {
          // a tail read starts mid-line: drop everything up to the first newline
          const nl = text.indexOf('\n');
          text = nl < 0 ? '' : text.slice(nl + 1);
          if (nl >= 0) skipFirstLine = false;
        }
        this.feed(t, text, false);
        start += n;
      }
    } finally { fs.closeSync(fd); }
  }

  ompTitle(t, file, size) {
    const first = readRange(file, 0, Math.min(size, 4096)).split('\n')[0];
    try {
      const slot = JSON.parse(first);
      if (slot.type === 'title') applyOMP(t.session, slot);
    } catch {}
  }

  feed(t, chunk, dropLastPartial, dropFirst = false) {
    const lines = (t.partial + chunk).split('\n');
    t.partial = lines.pop();
    if (dropFirst) lines.shift();
    if (dropLastPartial) t.partial = '';
    for (const line of lines) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      try { t.apply(t.session, d); } catch {}
    }
  }

  // The parent's session ID, from its tracker or (when it is outside the
  // window) from its header, cached until the parent log changes.
  ompParentId(file) {
    const tracked = this.trackers.get(file)?.session?.sessionId;
    if (tracked) return tracked;
    const st = statSafe(file);
    if (!st) return null;
    const cached = this.ompParentIds.get(file);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.id;
    let id = null;
    try {
      for (const line of readRange(file, 0, Math.min(st.size, HEAD_BYTES)).split('\n')) {
        try { const d = JSON.parse(line); if (d.type === 'session' && typeof d.id === 'string' && d.id) { id = d.id; break; } } catch {}
      }
    } catch {}
    this.ompParentIds.set(file, { mtime: st.mtimeMs, size: st.size, id });
    return id;
  }

  // Markers written by `cli.js --hook`; returns true when they changed.
  loadWaiting(since) {
    const next = hook.markers(since);
    const key = (m) => [...m].map(([id, w]) => `${id}:${w.at}`).sort().join();
    const changed = key(next) !== key(this.waiting);
    this.waiting = next;
    return changed;
  }

  sessions() {
    const out = [];
    for (const t of this.trackers.values()) {
      const s = t.session;
      if (s.agent === 'omp') {
        // Skip stray JSONL files and logs whose header isn't written yet.
        if (!s.sessionId || !s.cwd) continue;
        if (s.subagent && s.ompParentFile) {
          // parentSession alone also describes ordinary branched conversations;
          // require the artifact directory it was found in to match its parent.
          const advisor = /^__advisor(?:[._-].*)?$/.test(s.ompAgentName);
          if (s.parentSession && !sameOMPPath(s, s.parentSession, s.ompParentFile)) continue;
          if (!s.parentSession && !advisor) continue;
          s.parentId = this.ompParentId(s.ompParentFile);
          if (!s.title) s.title = advisor ? 'Advisor' : s.ompAgentName.replace(/\./g, ' > ');
        }
        s.lastEventAt = Math.max(s.lastEventAt || 0, s.mtime || 0);
      }
      if (s.agent === 'gemini' && !s.cwd && this.geminiProjects.has(s.geminiProject)) {
        s.cwd = this.geminiProjects.get(s.geminiProject);
      }
      if (s.agent === 'gemini' && !s.cwd) s.cwd = s.geminiProject;
      // Gemini re-appends whole messages with their original timestamps, so
      // the file's own write time is the best "last activity" signal.
      if (s.agent === 'gemini') s.lastEventAt = Math.max(s.lastEventAt || 0, s.mtime || 0);
      if (s.agent === 'codex' && !s.title) {
        const name = this.codexNames.get(s.id);
        if (name) s.title = name;
      }
      // A permission prompt from the optional Claude Code hook, until the log moves on.
      const wait = s.agent === 'claude' && !s.subagent && this.waiting.get(s.id);
      if (wait && wait.at > (s.lastEventAt || 0)) {
        out.push({ ...s, status: 'waiting', activity: wait.message || null, lastEventAt: wait.at });
        continue;
      }
      out.push(s);
    }
    if (!this.magpies.length) return out;
    const remote = new Map();
    // Magpie's native records carry richer metadata than gateway projections.
    // Prefer those, then the newest record; any healthy in-flight call counts.
    const records = this.magpies.flatMap((m) => m.sessions())
      .sort((a, b) => Number(a.gateway) - Number(b.gateway) || b.lastEventAt - a.lastEventAt);
    for (const s of records) {
      const key = `${s.agent}:${s.id}`;
      const other = remote.get(key);
      if (!other) { remote.set(key, { ...s }); continue; }
      for (const field of ['title', 'cwd', 'model', 'agentName', 'parentId', 'startedAt']) {
        if (!other[field]) other[field] = s[field];
      }
      other.subagent ||= s.subagent;
      if (s.status === 'thinking') other.status = 'thinking';
      other.lastEventAt = Math.max(other.lastEventAt, s.lastEventAt);
    }
    const merged = out.map((s) => {
      // Gemini's file name can differ from its ID. Kimi children instead carry
      // the parent sessionId for resume, which must not consume the parent's row.
      const alias = s.agent === 'gemini' && s.sessionId;
      const other = remote.get(`${s.agent}:${s.id}`) || (alias && remote.get(`${s.agent}:${alias}`));
      remote.delete(`${s.agent}:${s.id}`);
      if (alias) remote.delete(`${s.agent}:${alias}`);
      // Do not write fallback metadata into the native tracker: its own title
      // may arrive later, or the gateway may disappear.
      return other ? { ...s, title: s.title || other.title, cwd: s.cwd || other.cwd, model: s.model || other.model,
        parentId: s.parentId || other.parentId, subagent: s.subagent || other.subagent } : s;
    });
    return merged.concat([...remote.values()]);
  }
}

module.exports = { Watcher, CLAUDE_DIR, CODEX_DIR, GEMINI_DIR, CLIENT_DIRS, ompDirs };
