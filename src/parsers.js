'use strict';

// Turns raw session-log lines from Claude Code and Codex into one shared
// session shape. Both tools append JSONL as they work, so the last meaningful
// line tells us what the agent is doing right now.
//
// Status values:
//   thinking  – model is reasoning / waiting on the API
//   tool      – a tool call is in flight (activity says which)
//   typing    – it has started writing its reply but the turn is not over
//   waiting   – it asked you something and is blocked on you
//   done      – the turn finished
//   interrupted, error, idle

const path = require('path');

const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function newSession(agent, id, file) {
  return {
    agent,
    id,
    file,
    cwd: null,
    title: null,
    model: null,
    subagent: false,
    parentId: null,
    status: 'idle',
    activity: null,
    prompt: null,
    reply: null,
    error: null,
    turnStartedAt: null,
    lastEventAt: null,
    startedAt: null,
  };
}

// Local calendar day, as a sortable YYYY-MM-DD key.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Today's turns and tokens, as far as the log records them. A large log read
// head + tail only counts what was read.
function today(s, ts) {
  if (!ts) return null;
  const day = dayKey(ts);
  if (!s.daily || s.daily.day < day) s.daily = { day, turns: 0, tokens: 0 };
  return s.daily.day === day ? s.daily : null;
}

function usage(s, ts, { context, window, tokens }) {
  if (Number.isFinite(context) && context > 0) {
    s.context = context;
    s.contextWindow = Number.isFinite(window) && window > 0 ? window : null;
  }
  const d = Number.isFinite(tokens) && tokens > 0 && today(s, ts);
  if (d) d.tokens += tokens;
}

function countTurn(s, ts) {
  const d = today(s, ts);
  if (d) d.turns += 1;
}

function clean(text, max = 220) {
  if (!text) return null;
  let t = String(text);
  // Codex wraps the real prompt after injected context blocks.
  const marker = t.lastIndexOf('## My request:');
  if (marker !== -1) t = t.slice(marker + 14);
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-(message|args)>[\s\S]*?<\/command-\1>/g, ' ')
    // Drop injected context blocks (<foo attr="…">…</foo>); keep short inline tags' text.
    .replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, (m) => (m.length > 300 ? ' ' : m.replace(/<[^>]+>/g, ' ')))
    // Markdown noise reads badly in a two-line preview.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`+|^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function short(s, max = 90) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stamp(s, ts) {
  const t = ts ? Date.parse(ts) : NaN;
  if (Number.isFinite(t)) {
    s.lastEventAt = Math.max(s.lastEventAt || 0, t);
    if (!s.startedAt) s.startedAt = t;
  }
  return Number.isFinite(t) ? t : null;
}

function set(s, status, activity) {
  s.status = status;
  if (activity !== undefined) s.activity = activity;
  if (status !== 'error') s.error = null;
}

// ---------------------------------------------------------------- Claude Code

function describeClaudeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `${server} · ${rest.join('__')}`;
  }
  switch (name) {
    case 'Bash':
      return `Bash: ${short(input.description || input.command)}`;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name} ${base(input.file_path || input.notebook_path)}`;
    case 'Grep':
    case 'Glob':
      return `${name} ${short(input.pattern, 60)}`;
    case 'WebFetch':
      try { return `WebFetch ${new URL(input.url).host}`; } catch { return 'WebFetch'; }
    case 'WebSearch':
      return `WebSearch “${short(input.query, 60)}”`;
    case 'Agent':
    case 'Task':
      return `Subagent: ${short(input.description || input.subagent_type, 60)}`;
    case 'Skill':
      return `Skill ${input.skill || ''}`;
    case 'TodoWrite':
      return 'Updating todo list';
    default:
      return name;
  }
}

function applyClaude(s, d) {
  const ts = stamp(s, d.timestamp);
  if (d.cwd) s.cwd = d.cwd;

  switch (d.type) {
    case 'custom-title':
      if (d.customTitle) s.title = d.customTitle;
      return;
    case 'agent-name':
      if (!s.title && d.agentName) s.title = d.agentName;
      return;
    case 'system':
      if (d.subtype === 'stop_hook_summary') set(s, 'done', null);
      else if (d.subtype === 'api_error') {
        set(s, 'error', null);
        s.error = short(d.error?.formatted || d.error?.message || 'API error', 120);
      }
      return;
    case 'user': {
      if (d.isMeta) return;
      const c = d.message?.content;
      if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
        // Tool finished (or you answered its question); model reads the result.
        set(s, 'thinking');
        return;
      }
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (!text) return;
      if (text.startsWith('[Request interrupted')) { set(s, 'interrupted', null); return; }
      if (text.includes('<local-command-stdout>') || text.includes('<local-command-caveat>')) return;
      const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
      const isNotification = text.trimStart().startsWith('<task-notification>');
      if (!isNotification) {
        s.prompt = cmd ? cmd[1].trim() : clean(text);
        if (!s.title && d.isSidechain) s.title = clean(text, 80);
        s.reply = null;
      }
      s.turnStartedAt = ts;
      if (!isNotification && !d.isSidechain) countTurn(s, ts);
      set(s, 'thinking', null);
      return;
    }
    case 'assistant': {
      const m = d.message || {};
      if (m.model && m.model !== '<synthetic>') s.model = m.model;
      // One API response is logged once per content block with the same usage.
      const u = m.usage;
      if (u && typeof u === 'object' && m.id !== s._usageId) {
        s._usageId = m.id;
        const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0);
        const prompt = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
        usage(s, ts, { context: prompt + n('output_tokens'), window: prompt + n('output_tokens') > 200_000 ? 1_000_000 : 200_000,
          tokens: n('input_tokens') + n('cache_creation_input_tokens') + n('output_tokens') });
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') set(s, 'thinking');
        else if (b.type === 'text') {
          s.reply = clean(b.text) || s.reply;
          set(s, m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' ? 'done' : 'typing', null);
        } else if (b.type === 'tool_use') {
          set(s, WAITING_TOOLS.has(b.name) ? 'waiting' : 'tool', describeClaudeTool(b.name, b.input));
        }
      }
      if (d.isApiErrorMessage) {
        set(s, 'error', null);
        s.error = s.reply;
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------- Codex

function codexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => x.text || '').join('\n');
}

function describeCodexCall(name, raw) {
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { args = raw; }
  }
  if (name === 'request_user_input' || name === 'request_user_input_async') return 'Asking you a question';
  if (typeof args === 'object' && args) {
    const cmd = args.cmd || args.command;
    if (cmd) return `Shell: ${short(Array.isArray(cmd) ? cmd[cmd.length - 1] : cmd)}`;
    if (args.query) return `${name} “${short(args.query, 60)}”`;
  }
  if (typeof args === 'string') {
    // The `exec` tool wraps other tools in a JS snippet; pull out the command.
    const m = args.match(/(?:cmd|command)\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return `Shell: ${short(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'))}`;
    const t = args.match(/tools\.([a-zA-Z_]+)\(/);
    if (t) return t[1];
  }
  return name;
}

function applyCodex(s, d) {
  const ts = stamp(s, d.timestamp);
  const p = d.payload || {};

  switch (d.type) {
    case 'session_meta':
      if (p.cwd) s.cwd = p.cwd;
      if (p.source && typeof p.source === 'object' && p.source.subagent) s.subagent = true;
      if (p.parent_thread_id) { s.parentId = p.parent_thread_id; s.subagent = true; }
      if (p.thread_source && p.thread_source !== 'user') s.subagent = true;
      return;
    case 'turn_context':
      if (p.model) s.model = p.model;
      if (p.cwd) s.cwd = p.cwd;
      return;
    case 'event_msg':
      switch (p.type) {
        case 'task_started':
          // Old and new log formats both start every turn with this event.
          countTurn(s, ts);
          s.turnStartedAt = ts;
          s.reply = null;
          set(s, 'thinking', null);
          return;
        case 'task_complete':
          if (p.last_agent_message) s.reply = clean(p.last_agent_message);
          set(s, 'done', null);
          return;
        case 'turn_aborted':
          set(s, 'interrupted', null);
          return;
        case 'error':
          set(s, 'error', null);
          s.error = short(p.message || 'Error', 120);
          return;
        case 'user_message':
          s.prompt = clean(p.message);
          set(s, 'thinking', null);
          return;
        case 'token_count': {
          const last = p.info?.last_token_usage;
          if (!last || typeof last !== 'object') return;
          const n = (k) => (Number.isFinite(last[k]) ? last[k] : 0);
          usage(s, ts, { context: n('input_tokens') + n('output_tokens'), window: p.info.model_context_window,
            tokens: n('input_tokens') - n('cached_input_tokens') + n('output_tokens') });
          return;
        }
        case 'agent_message':
          s.reply = clean(p.message) || s.reply;
          set(s, 'typing', null);
          return;
        case 'exec_approval_request':
        case 'apply_patch_approval_request':
        case 'request_user_input':
          set(s, 'waiting', 'Needs your approval');
          return;
        case 'item_started':
        case 'item_completed': {
          const it = p.item || {};
          const started = p.type === 'item_started';
          switch (it.type) {
            case 'UserMessage': {
              const text = clean(codexText(it.content));
              if (text) s.prompt = text;
              return;
            }
            case 'AgentMessage':
              s.reply = clean(codexText(it.content)) || s.reply;
              set(s, 'typing', null);
              return;
            case 'Reasoning':
              set(s, 'thinking');
              return;
            case 'CommandExecution': {
              const c = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
              set(s, started ? 'tool' : 'thinking', `Shell: ${short(c)}`);
              return;
            }
            case 'McpToolCall':
              set(s, started ? 'tool' : 'thinking', `${it.server || 'mcp'} · ${it.tool || ''}`);
              return;
            case 'FileChange':
              set(s, started ? 'tool' : 'thinking', `Editing ${Object.keys(it.changes || {}).map((f) => path.basename(f)).join(', ')}`);
              return;
            case 'Extension':
              set(s, started ? 'tool' : 'thinking', `${it.kind || 'tool'} ${short(it.query, 50)}`);
              return;
          }
          return;
        }
      }
      return;
    case 'response_item':
      switch (p.type) {
        case 'reasoning':
          set(s, 'thinking');
          return;
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call':
        case 'web_search_call': {
          const name = p.name || p.type;
          const waiting = name.startsWith('request_user_input');
          set(s, waiting ? 'waiting' : 'tool', describeCodexCall(name, p.arguments ?? p.input ?? p.action));
          return;
        }
        case 'function_call_output':
        case 'custom_tool_call_output':
          set(s, 'thinking');
          return;
        case 'message':
          if (p.role === 'assistant') {
            s.reply = clean(codexText(p.content)) || s.reply;
            set(s, 'typing', null);
          }
          return;
      }
      return;
  }
}

// --------------------------------------------------------------- Gemini CLI
//
// ~/.gemini/tmp/<project>/chats/session-*.jsonl, append-only: a metadata
// line, then message records. A message is re-appended in full whenever it
// changes (tool calls finishing etc.), so the last line for an id wins.
// Older versions wrote a single .json file instead; see applyGeminiDocument.

const GEMINI_PENDING = new Set(['validating', 'scheduled', 'executing']);

function geminiText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(geminiText).join('');
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function describeGeminiTool(tc) {
  const a = tc.args || {};
  const name = tc.name || tc.displayName || 'tool';
  const file = a.absolute_path || a.file_path || a.path;
  switch (name) {
    case 'run_shell_command':
      return `Shell: ${short(a.description || a.command)}`;
    case 'read_file':
    case 'write_file':
    case 'replace':
    case 'edit':
      return `${tc.displayName || name} ${file ? path.basename(String(file)) : ''}`.trim();
    case 'glob':
    case 'search_file_content':
    case 'grep':
      return `${tc.displayName || name} ${short(a.pattern, 60)}`;
    case 'google_web_search':
      return `WebSearch “${short(a.query, 60)}”`;
    case 'web_fetch':
      return `WebFetch ${short(a.url || a.prompt, 60)}`;
    default:
      return tc.displayName || name;
  }
}

function extractCopilotText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => extractCopilotText(v, depth + 1)).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return extractCopilotText(value.content, depth + 1);
    if (typeof value.message === 'string') return value.message;
  }
  return '';
}

function describeCopilotTool(tool, args = {}) {
  const name = tool || 'tool';
  if (args && typeof args === 'object') {
    if (args.pattern) return `Search: ${short(args.pattern, 60)}`;
    if (args.command) return `Shell: ${short(Array.isArray(args.command) ? args.command.join(' ') : String(args.command), 60)}`;
    if (args.path || args.file_path) return `${name} ${path.basename(String(args.path || args.file_path || '')) || name}`;
  }
  return name;
}

function applyCopilot(s, d) {
  if (!d || typeof d !== 'object') return;
  const data = d.data || d;
  if (d.timestamp) stamp(s, d.timestamp);
  switch (d.type) {
    case 'session.start': {
      if (data.sessionId) s.sessionId = data.sessionId;
      if (data.context?.cwd) s.cwd = data.context.cwd;
      else if (data.context?.gitRoot) s.cwd = data.context.gitRoot;
      if (data.selectedModel) s.model = data.selectedModel;
      if (data.startTime) stamp(s, data.startTime);
      return;
    }
    case 'user.message': {
      const text = clean(extractCopilotText(data.content ?? data.transformedContent ?? data.prompt));
      if (text) s.prompt = text;
      s.turnStartedAt = d.timestamp ? Date.parse(d.timestamp) : s.turnStartedAt;
      set(s, 'thinking', null);
      return;
    }
    case 'assistant.message': {
      const text = clean(extractCopilotText(data.content ?? data.message));
      if (text) s.reply = text;
      if (data.model) s.model = data.model;
      set(s, 'typing', null);
      return;
    }
    case 'tool.execution_start': {
      const name = data.toolName || data.tool_name || 'tool';
      set(s, 'tool', describeCopilotTool(name, data.arguments || data.args || {}));
      return;
    }
    case 'tool.execution_complete': {
      if (data.model) s.model = data.model;
      set(s, 'thinking', null);
      return;
    }
    case 'tool.execution_error':
      set(s, 'error', null);
      s.error = short(data.message || 'Tool error', 120);
      return;
    case 'session.end':
      set(s, 'done', null);
      return;
    default:
      return;
  }
}

function applyGemini(s, d) {
  if (!d || typeof d !== 'object') return;
  // metadata line / $set updates
  const meta = d.$set || (d.sessionId && !d.type ? d : null);
  if (meta) {
    if (meta.sessionId) s.sessionId = meta.sessionId;
    if (meta.kind === 'subagent') s.subagent = true;
    if (Array.isArray(meta.directories) && meta.directories[0] && !s.cwd) s.cwd = meta.directories[0];
    if (meta.summary) s.title = clean(meta.summary, 80);
    if (meta.startTime) stamp(s, meta.startTime);
    if (Array.isArray(meta.messages)) for (const m of meta.messages) applyGemini(s, m);
    return;
  }
  if (d.$patch || d.$rewindTo || !d.type) return;

  stamp(s, d.timestamp);
  switch (d.type) {
    case 'user': {
      const text = clean(geminiText(d.displayContent ?? d.content));
      if (!text) return;
      if (text.startsWith('/')) { s.prompt = text.split(' ')[0]; } else s.prompt = text;
      s.reply = null;
      s.turnStartedAt = d.timestamp ? Date.parse(d.timestamp) : s.turnStartedAt;
      set(s, 'thinking', null);
      return;
    }
    case 'gemini': {
      if (d.model) s.model = d.model;
      const calls = Array.isArray(d.toolCalls) ? d.toolCalls : [];
      const waiting = calls.find((c) => c.status === 'awaiting_approval');
      const pending = calls.filter((c) => GEMINI_PENDING.has(c.status));
      const text = clean(geminiText(d.content));
      if (waiting) set(s, 'waiting', describeGeminiTool(waiting));
      else if (pending.length) set(s, 'tool', describeGeminiTool(pending[pending.length - 1]));
      else if (calls.length && !text) set(s, 'thinking', null); // tools done, model continues
      else if (text) { s.reply = text; set(s, 'typing', null); }
      else set(s, 'thinking');
      return;
    }
    case 'error':
      set(s, 'error', null);
      s.error = short(geminiText(d.content) || 'Error', 120);
      return;
    case 'info':
    case 'warning': {
      const t = geminiText(d.content).toLowerCase();
      if (t.includes('cancel') || t.includes('interrupt')) set(s, 'interrupted', null);
      return;
    }
  }
}

// Legacy whole-file .json sessions.
function applyGeminiDocument(s, doc) {
  applyGemini(s, { $set: doc });
}

// ----------------------------------------------------------------------- OMP
// Pending calls live outside the session object: kept out of the JSON API, freed with the session.
const ompState = new WeakMap();
function ompPending(s) {
  let state = ompState.get(s);
  if (!state) { state = { pending: new Map() }; ompState.set(s, state); }
  return state.pending;
}

function describeOMPTool(name, args = {}) {
  if (name === 'ask') return 'Waiting for your answer';
  const file = args.path || args.file_path;
  if (name === 'bash') return `bash: ${short(args.command || args.description)}`;
  if (['read', 'edit', 'write', 'notebook'].includes(name)) return `${name} ${short(file || '')}`.trim();
  if (args.pattern || args.query) return `${name}: ${short(args.pattern || args.query, 60)}`;
  return short(name || 'tool');
}

function ompToolStatus(s) {
  const calls = Array.from(ompPending(s).values());
  const waiting = calls.find(c => c.name === 'ask');
  const current = waiting || calls[calls.length - 1];
  set(s, waiting ? 'waiting' : current ? 'tool' : 'thinking', current ? current.description : null);
}

function applyOMP(s, d) {
  if (!d || typeof d !== 'object') return;
  const pending = ompPending(s);
  if (d.type === 'title') {
    // The slot holds the current name; the watcher re-applies it after every read.
    if (typeof d.title === 'string') s.title = clean(d.title, 120);
    return;
  }
  if (d.type === 'session') {
    if (typeof d.id === 'string' && d.id) s.id = s.sessionId = d.id;
    if (typeof d.cwd === 'string') s.cwd = d.cwd;
    if (!s.title && d.title) s.title = clean(d.title, 120);
    if (d.parentSession) s.parentSession = d.parentSession; // lineage only, not a subagent
    stamp(s, d.timestamp);
    return;
  }
  if (d.type === 'title_change') {
    if (typeof d.title === 'string') s.title = clean(d.title, 120);
    return;
  }
  if (d.type === 'model_change') {
    if ((!d.role || d.role === 'default') && d.model) s.model = d.model;
    return;
  }
  if (d.type === 'custom') {
    const data = d.data || {};
    if (d.customType === 'tool_execution_start' && data.toolCallId && data.toolName) {
      stamp(s, d.timestamp || data.startedAt);
      const previous = pending.get(data.toolCallId);
      pending.set(data.toolCallId, previous || { name: data.toolName, description: describeOMPTool(data.toolName, data.args) });
      ompToolStatus(s);
    } else if (d.customType === 'session_exit') {
      stamp(s, d.timestamp || data.recordedAt);
      if (data.kind === 'fatal') {
        pending.clear(); set(s, 'error', null); s.error = short(data.reason || 'OMP exited with an error', 120);
      } else if ((data.kind && data.kind !== 'normal') || pending.size || data.pendingToolCalls?.length) {
        pending.clear(); set(s, 'interrupted', null);
      } else if (['thinking', 'typing', 'tool', 'waiting'].includes(s.status)) set(s, 'idle', null);
    }
    return;
  }
  if (d.type !== 'message' || !d.message) return;
  const m = d.message;
  if (!['user', 'assistant', 'toolResult'].includes(m.role)) return;
  const ts = stamp(s, d.timestamp || (typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : m.timestamp));
  if (m.role === 'user') {
    if (!m.steering) pending.clear();
    s.prompt = clean(codexText(m.content));
    s.reply = null;
    s.turnStartedAt = ts;
    set(s, 'thinking', null);
    return;
  }
  if (m.role === 'toolResult') {
    pending.delete(m.toolCallId);
    ompToolStatus(s);
    if (m.isError && !pending.size) {
      set(s, 'error', null); s.error = clean(codexText(m.content), 120) || 'Tool error';
    }
    return;
  }
  if (m.model) s.model = m.provider && !m.model.startsWith(m.provider + '/') ? `${m.provider}/${m.model}` : m.model;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const text = clean(codexText(m.content));
  if (text) s.reply = text;
  if (m.stopReason === 'error' || m.stopReason === 'aborted') {
    pending.clear();
    set(s, m.stopReason === 'error' ? 'error' : 'interrupted', null);
    if (m.stopReason === 'error') s.error = short(m.errorMessage || text || 'OMP error', 120);
    return;
  }
  for (const b of blocks) {
    if (b.type === 'toolCall' && b.id && b.name) pending.set(b.id, { name: b.name, description: describeOMPTool(b.name, b.arguments) });
  }
  if (pending.size) ompToolStatus(s);
  else if (m.stopReason === 'stop' || m.stopReason === 'length') set(s, 'done', null);
  else set(s, 'thinking', null);
}

module.exports = { dayKey, newSession, applyClaude, applyCodex, applyGemini, applyGeminiDocument, applyCopilot, applyOMP, clean, describeClaudeTool, describeCodexCall, codexText };
