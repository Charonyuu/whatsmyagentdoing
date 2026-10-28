'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { clean } = require('./parsers');

// Some Node releases expose zstd but silently decode only the first frame.
const nativeZstd = (() => {
  if (!zlib.zstdCompressSync || !zlib.zstdDecompressSync) return false;
  try {
    const frames = ['a', 'b'].map((s) => zlib.zstdCompressSync(Buffer.from(s)));
    return zlib.zstdDecompressSync(Buffer.concat(frames)).toString('utf8') === 'ab';
  } catch { return false; }
})();

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// All three clients store sessions one directory below a project directory.
function clientFiles(roots, since) {
  const out = [];
  for (const [agent, root] of Object.entries(roots)) {
    for (const project of entries(root).filter((e) => e.isDirectory())) {
      const dir = path.join(root, project.name);
      for (const session of entries(dir).filter((e) => e.isDirectory())) {
        const base = path.join(dir, session.name);
        if (agent === 'kimi') {
          for (const child of entries(path.join(base, 'agents')).filter((e) => e.isDirectory())) {
            out.push({ agent, id: child.name === 'main' ? session.name : `${session.name}/${child.name}`,
              file: path.join(base, 'agents', child.name, 'wire.jsonl'), metadata: path.join(base, 'state.json'),
              sessionId: session.name, parentId: child.name === 'main' ? null : session.name });
          }
        } else if (agent === 'grok') {
          out.push({ agent, id: session.name, file: path.join(base, 'updates.jsonl'), metadata: path.join(base, 'summary.json') });
        } else {
          let latest;
          for (const e of entries(base)) {
            const match = e.isFile() && e.name.match(/^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/);
            if (!match) continue;
            try {
              const file = path.join(base, e.name), st = fs.statSync(file), version = Number(match[1] || 0);
              if (!latest || version > latest.version || (version === latest.version && st.mtimeMs > latest.mtime)) {
                latest = { agent, id: session.name, file, version, mtime: st.mtimeMs };
              }
            } catch {}
          }
          if (latest) out.push(latest);
        }
      }
    }
  }
  return out.filter((c) => {
    try { return fs.statSync(c.file).mtimeMs >= since; } catch { return false; }
  });
}

function at(s, value) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isFinite(t) && t > 0) {
    s.lastEventAt = Math.max(s.lastEventAt || 0, t);
    if (!s.startedAt) s.startedAt = t;
    return t;
  }
  return null;
}

function metadata(s, agent, file) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (agent === 'kimi') {
    s.cwd = d.cwd || d.workDir || s.cwd;
    s.title = clean(d.title || d.customTitle) || s.title;
    const created = typeof d.createdAt === 'number' ? d.createdAt : Date.parse(d.createdAt);
    if (Number.isFinite(created)) s.startedAt = created;
  } else if (agent === 'grok') {
    s.cwd = d.info?.cwd || s.cwd;
    s.title = clean(d.generated_title || d.session_summary) || s.title;
    s.model = d.current_model_id || s.model;
    const created = Date.parse(d.created_at);
    if (Number.isFinite(created)) s.startedAt = created;
    // A fork is a separate main session; only an explicit subagent kind is a child.
    if (typeof d.session_kind === 'string' && d.session_kind.startsWith('subagent')) {
      s.subagent = true;
      s.parentId = d.parent_session_id || s.parentId;
    }
  }
}

function text(parts) {
  if (typeof parts === 'string') return parts;
  return Array.isArray(parts) ? parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('') : '';
}

function state(s, status, activity = null) {
  s.status = status; s.activity = activity;
  if (status !== 'error') s.error = null;
}

function begin(s, ts) {
  s._tools = new Map(); s._approvals = new Map();
  s.turnStartedAt = ts; s.reply = null; s._replyText = '';
  state(s, 'thinking');
}

function activity(s, fallback = 'thinking') {
  if (s._approvals?.size) state(s, 'waiting', s._approvals.values().next().value);
  else if (s._tools?.size) state(s, 'tool', s._tools.values().next().value);
  else state(s, fallback);
}

function tool(s, id, name, finished = false) {
  s._tools ||= new Map();
  if (finished) s._tools.delete(id);
  else s._tools.set(id, clean(name, 90) || s._tools.get(id) || 'Tool');
  activity(s);
}

function approval(s, id, name, resolved = false) {
  s._approvals ||= new Map();
  if (resolved) s._approvals.delete(id);
  else s._approvals.set(id, clean(name, 90) || 'Approval');
  activity(s);
}

function end(s, reason) {
  s._tools?.clear(); s._approvals?.clear();
  if (['completed', 'done', 'end_turn'].includes(reason)) state(s, 'done');
  else if (['error', 'failed'].includes(reason)) { state(s, 'error'); s.error = 'Turn failed'; }
  else if (['cancelled', 'canceled', 'aborted', 'interrupted', 'max-tokens'].includes(reason)) state(s, 'interrupted');
  else state(s, 'idle');
}

function reply(s, value) {
  s._replyText = ((s._replyText || '') + value).slice(0, 1200);
  s.reply = clean(s._replyText);
  activity(s, 'typing');
}

function applyKimi(s, d) {
  s.explicitLifecycle = true;
  const ts = at(s, d.time);
  const e = d.event || {};
  switch (d.type) {
    case 'profile.bind':
      s.model = d.modelAlias || s.model;
      s.cwd = d.environmentDisclosure?.cwd || s.cwd;
      return;
    case 'turn.prompt':
      begin(s, ts);
      s.prompt = clean(text(d.input));
      return;
    case 'agent.turn.started': begin(s, ts); return;
    case 'llm.request':
      s.model = d.modelAlias || d.model || s.model;
      if (d.kind === 'loop') activity(s);
      return;
    case 'interaction.request': approval(s, d.id, d.kind === 'question' ? 'Question' : 'Approval'); return;
    case 'interaction.resolved': approval(s, d.id, null, true); return;
    case 'turn.cancel':
    case 'prompt.aborted': end(s, 'cancelled'); return;
    case 'agent.turn.ended': end(s, d.outcome); return;
    case 'turn.ended': end(s, d.reason); return;
    case 'forked':
      begin(s, ts); s.prompt = null; state(s, 'idle'); return;
    case 'context.append_loop_event':
      if (e.type === 'step.begin') {
        s._replyText = ''; s.reply = null; activity(s);
      } else if (e.type === 'tool.call') tool(s, e.toolCallId, e.name);
      else if (e.type === 'tool.result') tool(s, e.toolCallId, null, true);
      else if (e.type === 'content.part') {
        if (e.part?.type === 'text') reply(s, e.part.text || '');
        else if (e.part?.type === 'think') activity(s);
      }
      // step.end and usage.record end a model call, not necessarily the turn.
      return;
  }
}

function applyDsh(s, d) {
  s.explicitLifecycle = true;
  if (d.type === 'session') {
    if (typeof d.id !== 'string' || !d.id) return;
    s._dshHeader = true;
    s.id = d.id || s.id; s.cwd = d.cwd || s.cwd;
    s.startedAt = at(s, d.createdAt);
    if (d.delegationDepth > 0) { s.subagent = true; s.parentId = d.parentSession || null; }
    s._seed = d.isSeeded ? (d.version >= 2 ? Infinity : Number(d.seedLength || 0)) : 0;
    return;
  }
  if (d.type === 'session/end-seed') { s._seed = 0; return; }
  if (s._seed > 0) { s._seed--; return; }
  const ts = at(s, d.time), e = d.data || {};
  switch (d.type) {
    case 'turn/start': begin(s, ts); return;
    case 'user/message':
      if (e.source?.kind === 'user') s.prompt = clean(text(e.content));
      return;
    case 'session/title': s.title = clean(e.title); return;
    case 'request/header': s.model = e.header?.config?.model || s.model; return;
    case 'model/selection': s.model = e.model || s.model; return;
    case 'step/start': s._replyText = ''; s.reply = null; activity(s); return;
    case 'assistant/message':
      s.model = e.message?.source?.model || s.model;
      s._replyText = '';
      if (text(e.message?.content)) reply(s, text(e.message.content));
      return;
    case 'tool/call': tool(s, e.callId, e.name); return;
    case 'tool/result': tool(s, e.message?.toolCallId || e.message?.source?.callId, null, true); return;
    case 'approval/asked': approval(s, e.id, e.toolName); return;
    case 'approval/decided': approval(s, e.id, null, true); return;
    case 'turn/end': end(s, e.reason?.kind); return;
  }
}

function applyGrok(s, d) {
  s.explicitLifecycle = true;
  const ts = at(s, typeof d.timestamp === 'number' ? d.timestamp * 1000 : d.timestamp);
  const p = d.params || {}, e = p.update || {}, type = e.sessionUpdate;
  if (Number.isFinite(p._meta?.turnStartMs)) s.turnStartedAt = p._meta.turnStartMs;
  const previous = s._chunkType;
  if (type) s._chunkType = type;
  switch (type) {
    case 'user_message_chunk':
      if (previous !== type) {
        begin(s, Number.isFinite(p._meta?.turnStartMs) ? p._meta.turnStartMs : ts);
        s._promptText = '';
      }
      s._promptText = ((s._promptText || '') + (e.content?.text || '')).slice(0, 1200);
      s.prompt = clean(s._promptText);
      s.model = e._meta?.modelId || s.model;
      return;
    case 'agent_thought_chunk': activity(s); return;
    case 'agent_message_chunk':
      if (p._meta?.streamStartMs != null) {
        if (s._replyStream !== p._meta.streamStartMs) s._replyText = '';
        s._replyStream = p._meta.streamStartMs;
      } else if (previous !== type) s._replyText = '';
      reply(s, e.content?.text || ''); return;
    case 'tool_call':
    case 'tool_call_update': {
      const status = String(e.status || p._meta?.updateParams?.status || '').toLowerCase();
      tool(s, e.toolCallId, e.title || e._meta?.['x.ai/tool']?.name,
        ['completed', 'complete', 'failed'].includes(status));
      return;
    }
    case 'turn_completed':
      end(s, e.stop_reason === 'rate_limit' ? 'error'
        : ['max_tokens', 'refusal'].includes(e.stop_reason) ? 'interrupted' : e.stop_reason);
      if (e.stop_reason === 'rate_limit') s.error = 'Rate limited';
      return;
    case 'retry_state': activity(s); return;
  }
}

function tooLarge() {
  return Object.assign(new Error('DSH log exceeds replay limit'), { tooLarge: true });
}

function readDsh(file) {
  // shortcut: whole-file replay is bounded to 32 MB; use a streaming decoder
  // if individual DSH logs grow beyond this or replay becomes expensive.
  const limit = 32 * 1024 * 1024;
  if (fs.statSync(file).size > limit) throw tooLarge();
  if (!file.endsWith('.zstd')) return fs.readFileSync(file, 'utf8');
  try {
    if (nativeZstd) return zlib.zstdDecompressSync(fs.readFileSync(file), { maxOutputLength: limit }).toString('utf8');
    return execFileSync('zstd', ['-dc', '--', file], { encoding: 'utf8', maxBuffer: limit, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOBUFS' || e.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
    throw e;
  }
}

module.exports = { clientFiles, metadata, applyKimi, applyDsh, applyGrok, readDsh };
