'use strict';

const { EventEmitter } = require('events');
const os = require('os');
const { newSession, clean } = require('./parsers');

// A local API response this large is not a session listing; refuse it.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function identity(agent, id) {
  return typeof agent === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(agent)
    && !Object.hasOwn(Object.prototype, agent)
    && typeof id === 'string' && id.length > 0 && id.length <= 512
    ? `${agent}:${id}` : null;
}

const text = (value, max = 512) => typeof value === 'string' && value.length <= max ? value : null;
const time = (value) => typeof value === 'string' ? Date.parse(value) || null : null;

// Magpie's web API observes requests, not agent turns. Keep that distinction
// here; native session logs remain the authority when both sources see a chat.
class Magpie extends EventEmitter {
  constructor({ url, key, hours = 24, interval = 5000 }) {
    super();
    try { this.url = new URL(url); } catch { throw new Error('Invalid WMAD_MAGPIE_URL'); }
    const local = ['localhost', '127.0.0.1', '::1',
      ...Object.values(os.networkInterfaces()).flatMap((entries) => (entries || []).map((entry) => entry.address))];
    if (!['http:', 'https:'].includes(this.url.protocol)
      || !local.includes(this.url.hostname.replace(/^\[|\]$/g, ''))
      || this.url.username || this.url.password || this.url.search || this.url.hash
      || this.url.pathname !== '/') {
      throw new Error('Magpie URL must be a local HTTP(S) origin without credentials');
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{16,}$/.test(key)) {
      throw new Error('Set WMAD_MAGPIE_KEY to the Magpie web sign-in key');
    }
    this.key = key;
    this.cookie = null;
    this.windowMs = hours * 3600000;
    this.interval = interval;
    this.rows = [];
    this.error = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.interval);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
  }

  poll() {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  async read(endpoint, signal) {
    const res = await fetch(new URL(endpoint, this.url), {
      headers: { Cookie: this.cookie }, redirect: 'error', signal,
    });
    if (!res.ok) {
      if (res.status === 401) this.cookie = null;
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
      await res.body?.cancel();
      throw new Error('Response too large');
    }
    const body = await res.text();
    if (body.length > MAX_BODY_BYTES) throw new Error('Response too large');
    return JSON.parse(body);
  }

  async signIn(signal) {
    const url = new URL('/', this.url);
    url.searchParams.set('k', this.key);
    // Magpie names its cookie after its listening port, which may differ from
    // Docker's published port. Use the sign-in response; never follow redirects.
    const res = await fetch(url, { redirect: 'manual', signal });
    await res.body?.cancel();
    if (res.status !== 303) throw new Error(`HTTP ${res.status}`);
    const cookie = (res.headers.get('set-cookie') || '').match(/(?:^|,\s*)(magpie_web_\d+)=([A-Za-z0-9._~-]+)(?:;|$)/);
    if (!cookie || cookie[2] !== this.key) throw new Error('Invalid sign-in response');
    this.cookie = `${cookie[1]}=${cookie[2]}`;
  }

  async refresh() {
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller.abort(), 10000);
    try {
      if (!this.cookie) await this.signIn(this.controller.signal);
      const [listing, trace] = await Promise.all([
        this.read('/api/sessions', this.controller.signal),
        this.read('/api/gateway/trace', this.controller.signal),
      ]);
      if (!Array.isArray(listing?.sessions) || !Array.isArray(trace?.routes)) {
        throw new Error('Unexpected API response');
      }
      const rows = new Map();
      for (const row of listing.sessions) {
        const key = identity(row?.agent, row?.id);
        if (!key) continue;
        const s = newSession(row.agent, row.id, null);
        s.source = 'magpie';
        s.gateway = row.gateway === true;
        s.agentName = text(row.name, 64);
        s.cwd = text(row.cwd, 4096);
        s.title = clean(text(row.title, 4096));
        s.startedAt = time(row.start);
        s.lastEventAt = time(row.last);
        s.parentId = identity(row.agent, row.parent_session) ? row.parent_session : null;
        s.subagent = row.role === 'subagent' || !!s.parentId;
        // A list of lifetime token totals does not identify the current model.
        if (Array.isArray(row.models) && row.models.length === 1) s.model = text(row.models[0]?.model);
        rows.set(key, s);
      }
      // The trace is a bounded snapshot (after=0), including in-flight calls.
      // Ignore title/guardian/compaction helpers that aren't the chat's work.
      const routes = trace.routes.filter((r) => identity(r?.agent, r?.session)
        && (!r.kind || r.kind === 'collab_spawn')).sort((a, b) => (time(a.time) || 0) - (time(b.time) || 0));
      for (const route of routes) {
        const key = identity(route.agent, route.session);
        let s = rows.get(key);
        if (!s) {
          s = newSession(route.agent, route.session, null);
          s.source = 'magpie';
          s.gateway = true;
          rows.set(key, s);
        }
        s.model = text(route.model) || s.model;
        s.lastEventAt = Math.max(s.lastEventAt || 0, time(route.time) || 0);
        if (trace.mine === true && route.done === false) s.status = 'thinking';
        // shortcut: gateway-only chats are idle between requests; use native
        // logs until Magpie exposes tool, approval and turn-completion events.
      }
      if (this.stopped) return;
      this.rows = [...rows.values()];
      this.error = null;
    } catch (err) {
      this.controller.abort();
      if (this.stopped) return;
      // Do not expose response bodies, URLs or headers containing credentials.
      const message = /^HTTP \d{3}$/.test(err.message) ? err.message : 'API unavailable or invalid response';
      if (message !== this.error) this.emit('warning', message);
      this.error = message;
      this.rows = this.rows.map((s) => ({ ...s, status: 'idle' }));
    } finally {
      clearTimeout(timeout);
    }
    this.emit('change');
  }

  sessions() {
    const since = Date.now() - this.windowMs;
    return this.rows.filter((s) => s.lastEventAt >= since);
  }
}

module.exports = { Magpie };
