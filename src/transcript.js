'use strict';

// The recent conversation of one session, for the side panel: what you
// asked, what the agent answered and which tools it ran. Read-only, from the
// end of the session's own log. Claude Code and Codex logs keep full message
// text; for every other client the existing parser replays the tail and the
// timeline records each change of prompt, reply and tool.

const fs = require('fs');
const { newSession, describeClaudeTool, describeCodexCall, codexText } = require('./parsers');

const TAIL_BYTES = 384 * 1024;
const LIMIT = 40;
const TEXT_MAX = 1500;

function text(v) {
  if (!v) return '';
  const t = String(v).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1) + '…' : t;
}

function time(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

// The last complete lines of a log, never more than TAIL_BYTES.
function tailLines(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // the first line was cut in the middle
  return lines;
}

function* records(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

function claude(lines) {
  const out = [];
  for (const d of records(lines)) {
    const at = time(d.timestamp);
    if (d.type === 'user' && !d.isMeta) {
      const c = d.message?.content;
      if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) continue;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (!t || t.includes('<local-command-') || t.trimStart().startsWith('<task-notification>') || t.startsWith('[Request interrupted')) continue;
      const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
      out.push({ role: 'user', text: text(cmd ? cmd[1] : t), at });
    } else if (d.type === 'assistant') {
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: text(b.text), at });
        else if (b.type === 'tool_use') out.push({ role: 'tool', text: describeClaudeTool(b.name || 'tool', b.input || {}), at });
      }
    }
  }
  return out;
}

function codex(lines) {
  const out = [];
  for (const d of records(lines)) {
    const at = time(d.timestamp), p = d.payload || {};
    if (d.type === 'event_msg') {
      if (p.type === 'user_message') out.push({ role: 'user', text: text(p.message), at });
      else if (p.type === 'agent_message') out.push({ role: 'assistant', text: text(p.message), at });
      else if (p.type === 'item_completed') {
        const it = p.item || {};
        if (it.type === 'UserMessage') out.push({ role: 'user', text: text(codexText(it.content)), at });
        else if (it.type === 'AgentMessage') out.push({ role: 'assistant', text: text(codexText(it.content)), at });
        else if (it.type === 'CommandExecution') {
          const c = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
          out.push({ role: 'tool', text: `Shell: ${text(c).slice(0, 120)}`, at });
        } else if (it.type === 'McpToolCall') out.push({ role: 'tool', text: `${it.server || 'mcp'} · ${it.tool || ''}`, at });
      }
    } else if (d.type === 'response_item' && p.type === 'function_call') {
      out.push({ role: 'tool', text: describeCodexCall(p.name || 'tool', p.arguments), at });
    }
  }
  // Newer logs record a message both as an event and as an item.
  return out.filter((m, i) => !(i && m.role !== 'tool' && m.role === out[i - 1].role && m.text === out[i - 1].text));
}

// Any other client: replay the tail through its own parser and keep each change.
function replay(lines, session, apply) {
  const s = newSession(session.agent, session.id, null);
  const out = [];
  let prompt = null, reply = null, activity = null;
  for (const d of records(lines)) {
    try { apply(s, d); } catch { continue; }
    const at = s.lastEventAt;
    if (s.prompt && s.prompt !== prompt) out.push({ role: 'user', text: text(s.prompt), at });
    if (s.reply && s.reply !== reply) {
      const last = out[out.length - 1];
      // Streamed replies grow in place; keep one entry for them.
      if (last?.role === 'assistant' && reply && s.reply.startsWith(reply)) last.text = text(s.reply);
      else out.push({ role: 'assistant', text: text(s.reply), at });
    }
    if (s.status === 'tool' && s.activity && s.activity !== activity) out.push({ role: 'tool', text: text(s.activity), at });
    prompt = s.prompt; reply = s.reply; activity = s.activity;
  }
  return out;
}

const cache = new Map(); // file -> { mtime, size, messages }

function transcript(session, apply) {
  const fallback = () => [
    session.prompt && { role: 'user', text: text(session.prompt), at: session.turnStartedAt },
    session.reply && { role: 'assistant', text: text(session.reply), at: session.lastEventAt },
  ].filter(Boolean);
  const file = session.file;
  // Whole-document and compressed logs can't be tailed by lines.
  if (!file || !/\.jsonl$/.test(file)) return fallback();
  let st;
  try { st = fs.statSync(file); } catch { return fallback(); }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.messages;
  let messages;
  try {
    const lines = tailLines(file);
    messages = session.agent === 'claude' ? claude(lines)
      : session.agent === 'codex' ? codex(lines)
        : apply ? replay(lines, session, apply) : [];
  } catch { return fallback(); }
  messages = messages.filter((m) => m.text).slice(-LIMIT);
  if (!messages.length) messages = fallback();
  cache.set(file, { mtime: st.mtimeMs, size: st.size, messages });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return messages;
}

module.exports = { transcript, TAIL_BYTES, LIMIT };
