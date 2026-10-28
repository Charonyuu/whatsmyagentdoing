// Synthetic histories only. Real-client verification is kept outside the repo.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { newSession } = require('../src/parsers');
const { applyKimi, applyDsh, applyGrok, readDsh } = require('../src/clients');
const { snapshot } = require('../src/server');
const NOW = Date.now();
const kimi = (type, extra = {}) => ({ type, time: NOW, ...extra });
const loop = (type, extra = {}) => kimi('context.append_loop_event', { event: { type, ...extra } });
const dsh = (type, data = {}) => ({ type, time: NOW, data });
const grok = (sessionUpdate, extra = {}) => ({ timestamp: NOW / 1000, params: { update: { sessionUpdate, ...extra } } });

test('Kimi tracks parallel tools and questions, and ignores per-request completion', () => {
  const s = newSession('kimi', 'one');
  applyKimi(s, kimi('turn.prompt', { input: [{ type: 'text', text: 'Example task' }] }));
  applyKimi(s, loop('tool.call', { toolCallId: 'a', name: 'Read' }));
  applyKimi(s, loop('tool.call', { toolCallId: 'b', name: 'Bash' }));
  applyKimi(s, loop('tool.result', { toolCallId: 'a' }));
  assert.equal(s.status, 'tool'); assert.equal(s.activity, 'Bash');
  applyKimi(s, kimi('interaction.request', { id: 'q', kind: 'question' }));
  applyKimi(s, loop('tool.result', { toolCallId: 'b' }));
  assert.equal(s.status, 'waiting');
  applyKimi(s, kimi('interaction.resolved', { id: 'q' }));
  assert.equal(s.status, 'thinking');
  applyKimi(s, loop('content.part', { part: { type: 'text', text: 'Hello ' } }));
  applyKimi(s, loop('content.part', { part: { type: 'text', text: 'world' } }));
  applyKimi(s, loop('step.end', { finishReason: 'end_turn' }));
  applyKimi(s, kimi('subagent.completed'));
  applyKimi(s, kimi('usage.record'));
  assert.equal(s.status, 'typing'); assert.equal(s.reply, 'Hello world');
  applyKimi(s, kimi('turn.ended', { reason: 'completed' }));
  assert.equal(s.status, 'done');
  applyKimi(s, kimi('task.terminated'));
  assert.equal(s.status, 'done', 'a background process is not a new user turn');
  applyKimi(s, kimi('turn.prompt'));
  applyKimi(s, kimi('agent.turn.ended', { outcome: 'failed' }));
  assert.equal(s.status, 'error');
  applyKimi(s, kimi('turn.cancel'));
  assert.equal(s.status, 'interrupted');
});

test('DSH uses turn/end and approval events; step and workflow endings are not Done', () => {
  const s = newSession('dsh', 'one');
  applyDsh(s, { type: 'session', id: 'one', cwd: '/demo', createdAt: NOW, delegationDepth: 0 });
  applyDsh(s, dsh('turn/start'));
  applyDsh(s, dsh('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Example' }] }));
  applyDsh(s, dsh('tool/call', { callId: 'a', name: 'Read' }));
  applyDsh(s, dsh('tool/call', { callId: 'b', name: 'Shell' }));
  applyDsh(s, dsh('approval/asked', { id: 'approval', toolName: 'Shell' }));
  applyDsh(s, dsh('tool/result', { message: { toolCallId: 'a' } }));
  assert.equal(s.status, 'waiting');
  applyDsh(s, dsh('approval/decided', { id: 'approval' }));
  assert.equal(s.status, 'tool');
  applyDsh(s, dsh('tool/result', { message: { toolCallId: 'b' } }));
  applyDsh(s, dsh('step/end'));
  applyDsh(s, dsh('tool-workflow/run-end'));
  assert.equal(s.status, 'thinking');
  applyDsh(s, dsh('assistant/message', { message: { content: [{ type: 'text', text: 'Finished' }] } }));
  assert.equal(s.status, 'typing');
  applyDsh(s, dsh('turn/end', { reason: { kind: 'completed' } }));
  assert.equal(s.status, 'done');
  applyDsh(s, dsh('turn/start'));
  applyDsh(s, dsh('turn/end', { reason: { kind: 'cancelled' } }));
  assert.equal(s.status, 'interrupted');
  applyDsh(s, dsh('turn/end', { reason: { kind: 'max-tokens' } }));
  assert.equal(s.status, 'interrupted', 'a token limit is not successful completion');
});

test('Grok reads ACP tool status in both locations and distinguishes failures from turn endings', () => {
  const s = newSession('grok', 'one');
  applyGrok(s, grok('user_message_chunk', { content: { text: 'Hello ' } }));
  applyGrok(s, grok('user_message_chunk', { content: { text: 'world' } }));
  assert.equal(s.prompt, 'Hello world');
  assert.equal(s.turnStartedAt, NOW);
  applyGrok(s, grok('tool_call', { toolCallId: 'a', title: 'Shell' }));
  applyGrok(s, grok('tool_call', { toolCallId: 'b', title: 'Read' }));
  applyGrok(s, grok('tool_call_update', { toolCallId: 'a', status: 'failed' }));
  assert.equal(s.status, 'tool'); assert.equal(s.activity, 'Read');
  const complete = grok('tool_call_update', { toolCallId: 'b' });
  complete.params._meta = { updateParams: { status: 'Completed' } };
  applyGrok(s, complete);
  assert.equal(s.status, 'thinking', 'finishing all tools is not finishing the turn');
  applyGrok(s, grok('subagent_finished'));
  applyGrok(s, grok('agent_message_chunk', { content: { text: 'Done' } }));
  assert.equal(s.status, 'typing');
  applyGrok(s, grok('turn_completed', { stop_reason: 'end_turn' }));
  assert.equal(s.status, 'done');
  applyGrok(s, grok('task_completed', { will_wake: true }));
  assert.equal(s.status, 'done');
  applyGrok(s, grok('turn_completed', { stop_reason: 'error' }));
  assert.equal(s.status, 'error');
});

test('Grok keeps the recorded turn start when the first user chunk arrives later', () => {
  const s = newSession('grok', 'one');
  const event = grok('user_message_chunk', { content: { text: 'Hello' } });
  event.params._meta = { turnStartMs: NOW - 5000 };
  applyGrok(s, event);
  assert.equal(s.turnStartedAt, NOW - 5000);
  applyGrok(s, grok('user_message_chunk', { content: { text: ' world' } }));
  assert.equal(s.turnStartedAt, NOW - 5000);
  assert.equal(s.prompt, 'Hello world');
});

test('Grok preserves explicit failure and interruption reasons in snapshots', () => {
  for (const [reason, status, error] of [
    ['rate_limit', 'error', 'Rate limited'],
    ['max_tokens', 'interrupted', null],
    ['refusal', 'interrupted', null],
    ['cancelled', 'interrupted', null],
    ['end_turn', 'done', null],
    ['error', 'error', 'Turn failed'],
    ['unknown_reason', 'idle', null],
  ]) {
    const s = newSession('grok', 'one');
    applyGrok(s, grok('user_message_chunk', { content: { text: 'Synthetic task' } }));
    applyGrok(s, grok('tool_call', { toolCallId: 'a', title: 'Read' }));
    applyGrok(s, grok('turn_completed', { stop_reason: reason }));
    const row = snapshot({ sessions: () => [s] }, {}).sessions[0];
    assert.equal(row.status, status, reason);
    assert.equal(row.error, error, reason);
    assert.equal(s._tools.size, 0, 'a terminal event clears pending tools');
  }
});

test('Grok partial tool updates retain names without clearing parallel tools', () => {
  const s = newSession('grok', 'one');
  applyGrok(s, grok('tool_call', { toolCallId: 'a', title: 'Read configuration' }));
  applyGrok(s, grok('tool_call', { toolCallId: 'b', title: 'Shell' }));
  applyGrok(s, grok('tool_call_update', { toolCallId: 'a', status: 'in_progress' }));
  assert.equal(s.activity, 'Read configuration');
  applyGrok(s, grok('tool_call_update', { toolCallId: 'a', status: 'completed' }));
  applyGrok(s, grok('tool_call_update', { toolCallId: 'b', status: 'in_progress' }));
  assert.equal(s.status, 'tool'); assert.equal(s.activity, 'Shell');
  applyGrok(s, grok('tool_call_update', { toolCallId: 'b', title: 'Run checks' }));
  assert.equal(s.activity, 'Run checks');
  applyGrok(s, grok('tool_call_update', { toolCallId: 'b', status: 'completed' }));
  assert.equal(s.status, 'thinking', 'tool completion is not turn completion');
  applyGrok(s, grok('tool_call', { toolCallId: 'c' }));
  assert.equal(s.activity, 'Tool', 'a new unnamed tool still has a fallback');
});

test('explicit-lifecycle clients never become Done from the reply timeout', () => {
  for (const [agent, apply, event] of [
    ['kimi', applyKimi, loop('content.part', { part: { type: 'text', text: 'Working' } })],
    ['dsh', applyDsh, dsh('assistant/message', { message: { content: [{ type: 'text', text: 'Working' }] } })],
    ['grok', applyGrok, grok('agent_message_chunk', { content: { text: 'Working' } })],
  ]) {
    const s = newSession(agent, 'one');
    apply(s, event); s.lastEventAt = Date.now() - 60000;
    assert.equal(snapshot({ sessions: () => [s] }, {}).sessions[0].status, 'typing');
    s.lastEventAt = Date.now() - 16 * 60000;
    assert.equal(snapshot({ sessions: () => [s] }, {}).sessions[0].status, 'idle');
  }
});

test('fork history is not a completed new task, and DSH children keep their own identity', () => {
  const s = newSession('dsh', 'folder');
  applyDsh(s, { type: 'session', id: 'child', version: 4, isSeeded: true, delegationDepth: 1, parentSession: 'parent', createdAt: NOW });
  applyDsh(s, dsh('turn/end', { reason: { kind: 'completed' } }));
  assert.equal(s.status, 'idle');
  applyDsh(s, dsh('session/end-seed'));
  applyDsh(s, dsh('turn/start'));
  assert.equal(s.id, 'child'); assert.equal(s.parentId, 'parent'); assert.equal(s.subagent, true);
  assert.equal(s.status, 'thinking');
  const k = newSession('kimi', 'fork');
  applyKimi(k, kimi('turn.ended', { reason: 'completed' }));
  applyKimi(k, kimi('forked'));
  assert.equal(k.status, 'idle'); assert.equal(k.reply, null);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-clients-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const file = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, Buffer, Date: Clock, process: { env: {} }, console, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => root } : createRequire(file)(name),
  }, { filename: file });
  const w = new mod.exports.Watcher();
  const write = (rel, records) => {
    const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Array.isArray(records) ? records.map(x => JSON.stringify(x)).join('\n') + '\n' : JSON.stringify(records));
    fs.utimesSync(p, new Date(now), new Date(now)); return p;
  };
  return { root, w, write, advance(ms = 6000) { now += ms; }, touch(p) { fs.utimesSync(p, new Date(now), new Date(now)); } };
}

test('discovery, append, metadata refresh and per-session children use isolated client homes', t => {
  const f = fixture(t);
  const main = f.write('.kimi-code/sessions/project/session/agents/main/wire.jsonl', [kimi('turn.prompt')]);
  f.write('.kimi-code/sessions/project/session/agents/agent-1/wire.jsonl', [kimi('turn.prompt')]);
  const meta = '.kimi-code/sessions/project/session/state.json';
  f.write(meta, { cwd: '/demo', title: 'First', createdAt: NOW });
  f.write('.grok/sessions/project/grok-one/updates.jsonl', [grok('user_message_chunk', { content: { text: 'Hello' } })]);
  f.write('.grok/sessions/project/grok-one/summary.json', { info: { cwd: '/grok' }, session_kind: 'subagent-worker', parent_session_id: 'parent', current_model_id: 'model' });
  f.write('.dsh/sessions/project/dsh-one/session.v3.jsonl', [{ type: 'session', id: 'dsh-one', createdAt: NOW }, dsh('turn/start')]);
  f.w.tick();
  assert.equal(f.w.sessions().length, 4);
  assert.equal(f.w.sessions().find(s => s.id === 'session/agent-1').parentId, 'session');
  assert.equal(f.w.sessions().find(s => s.agent === 'grok').subagent, true);
  assert.equal(f.w.sessions().find(s => s.id === 'session').title, 'First');
  f.advance();
  fs.appendFileSync(main, JSON.stringify(kimi('turn.ended', { reason: 'completed', time: NOW + 6000 })) + '\n'); f.touch(main);
  f.write(meta, { title: 'Renamed', cwd: '/demo' });
  f.w.tick();
  assert.equal(f.w.sessions().find(s => s.id === 'session').status, 'done');
  assert.equal(f.w.sessions().find(s => s.id === 'session').title, 'Renamed');
  assert.equal(f.w.sessions().find(s => s.id === 'session/agent-1').status, 'thinking');
  f.advance(25 * 3600000); f.w.tick();
  assert.equal(f.w.sessions().length, 0);
});

test('DSH selects the latest format and does not duplicate a session when it upgrades', t => {
  const f = fixture(t);
  const header = { type: 'session', id: 'canonical-id', createdAt: NOW };
  f.write('.dsh/sessions/project/escaped-id/session.v3.jsonl', [header, dsh('turn/start')]);
  f.w.tick(); assert.equal(f.w.sessions().length, 1);
  f.advance();
  f.write('.dsh/sessions/project/escaped-id/session.v4.jsonl', [header, dsh('turn/end', { reason: { kind: 'completed' } })]);
  f.w.tick();
  assert.equal(f.w.sessions().length, 1);
  assert.equal(f.w.sessions()[0].id, 'canonical-id');
  assert.equal(f.w.sessions()[0].status, 'done');
  f.advance();
  f.write('.dsh/sessions/project/escaped-id/session.v5.jsonl', []);
  f.w.tick();
  assert.equal(f.w.sessions().length, 1, 'an empty replacement must not create a placeholder person');
  assert.equal(f.w.sessions()[0].id, 'canonical-id');
});

test('a busy DSH log is re-read whole at most every five seconds', t => {
  const f = fixture(t);
  const p = f.write('.dsh/sessions/project/busy/session.v3.jsonl', [{ type: 'session', id: 'busy', createdAt: NOW }, dsh('turn/start')]);
  f.w.tick(); assert.equal(f.w.sessions()[0].status, 'thinking');
  f.advance(1000);
  fs.appendFileSync(p, JSON.stringify(dsh('turn/end', { reason: { kind: 'completed' } })) + '\n'); f.touch(p);
  f.w.tick(); assert.equal(f.w.sessions()[0].status, 'thinking', 'a change within the window waits');
  f.advance(4000); f.w.tick();
  assert.equal(f.w.sessions()[0].status, 'done', 'the pending change is read once the window passes');
});

test('large Kimi logs retain pending approvals and parallel tools across partial appends', t => {
  const f = fixture(t);
  const file = f.write('.kimi-code/sessions/project/session/agents/main/wire.jsonl', [
    kimi('turn.prompt'),
    loop('tool.call', { toolCallId: 'a', name: 'Read' }),
    loop('tool.call', { toolCallId: 'b', name: 'Bash' }),
    kimi('interaction.request', { id: 'current', kind: 'question' }),
    loop('tool.result', { toolCallId: 'a', output: 'x'.repeat(1100000) }),
  ]);
  f.w.tick();
  const s = f.w.sessions()[0];
  assert.equal(s.status, 'waiting'); assert.equal(s.turnStartedAt, NOW);
  const resolved = JSON.stringify(kimi('interaction.resolved', { id: 'current' })) + '\n';
  f.advance(); fs.appendFileSync(file, resolved.slice(0, 20)); f.touch(file); f.w.tick();
  assert.equal(s.status, 'waiting', 'a half-written event does not resolve an approval');
  f.advance(); fs.appendFileSync(file, resolved.slice(20)); f.touch(file); f.w.tick();
  assert.equal(s.status, 'tool'); assert.equal(s.activity, 'Bash');
  f.advance();
  fs.appendFileSync(file, JSON.stringify(loop('tool.result', { toolCallId: 'b' })) + '\n');
  f.touch(file); f.w.tick();
  assert.equal(s.status, 'thinking', 'finishing both tools does not finish the turn');
  f.advance(); fs.appendFileSync(file, JSON.stringify(kimi('turn.ended', { reason: 'completed' })) + '\n');
  f.touch(file); f.w.tick();
  assert.equal(s.status, 'done'); assert.equal(f.w.sessions().length, 1);
});

test('large Grok logs retain an unfinished parallel tool', t => {
  const f = fixture(t);
  const file = f.write('.grok/sessions/project/session/updates.jsonl', [
    grok('user_message_chunk', { content: { text: 'Example task' } }),
    grok('tool_call', { toolCallId: 'a', title: 'Read' }),
    grok('tool_call', { toolCallId: 'b', title: 'Shell' }),
    grok('tool_call_update', { toolCallId: 'a', status: 'completed', content: [{ type: 'text', text: 'x'.repeat(1100000) }] }),
  ]);
  f.w.tick();
  const s = f.w.sessions()[0];
  assert.equal(s.status, 'tool'); assert.equal(s.activity, 'Shell');
  f.advance();
  fs.appendFileSync(file, JSON.stringify(grok('tool_call_update', { toolCallId: 'b', status: 'completed' })) + '\n');
  f.touch(file); f.w.tick();
  assert.equal(s.status, 'thinking');
  f.advance(); fs.appendFileSync(file, JSON.stringify(grok('turn_completed', { stop_reason: 'end_turn' })) + '\n');
  f.touch(file); f.w.tick(); assert.equal(s.status, 'done');
});

test('large Kimi logs replay resolved approvals and the current turn start', t => {
  const f = fixture(t);
  f.write('.kimi-code/sessions/project/session/agents/main/wire.jsonl', [
    kimi('turn.prompt', { time: NOW - 60000 }), kimi('interaction.request', { id: 'old', kind: 'question' }),
    kimi('llm.tools_snapshot', { padding: 'x'.repeat(200000) }),
    kimi('interaction.resolved', { id: 'old' }), kimi('turn.ended', { reason: 'completed' }),
    kimi('turn.prompt'),
    kimi('llm.tools_snapshot', { padding: 'x'.repeat(1100000) }),
    loop('step.begin'), loop('content.part', { part: { type: 'text', text: 'Current reply' } }),
  ]);
  f.w.tick();
  const s = f.w.sessions()[0];
  assert.equal(s.status, 'typing'); assert.equal(s.reply, 'Current reply');
  assert.equal(s.turnStartedAt, NOW);
});

test('client replay preserves UTF-8 split across read blocks and later appends', t => {
  const f = fixture(t);
  const prompt = JSON.stringify(kimi('turn.prompt', { input: '你好，继续' }));
  const padding = kimi('llm.tools_snapshot', { padding: '' });
  padding.padding = 'x'.repeat(768 * 1024 - Buffer.byteLength(JSON.stringify(padding) + '\n')
    - Buffer.byteLength(prompt.slice(0, prompt.indexOf('你好'))) - 1);
  const file = f.write('.kimi-code/sessions/project/session/agents/main/wire.jsonl', [padding, JSON.parse(prompt),
    kimi('llm.tools_snapshot', { padding: 'x'.repeat(200000) })]);
  f.w.tick();
  assert.equal(f.w.sessions()[0].prompt, '你好，继续');
  const reply = Buffer.from(JSON.stringify(loop('content.part', { part: { type: 'text', text: '正在处理' } })) + '\n');
  const split = reply.indexOf(Buffer.from('正')) + 1;
  f.advance(); fs.appendFileSync(file, reply.subarray(0, split)); f.touch(file); f.w.tick();
  assert.equal(f.w.sessions()[0].status, 'thinking');
  f.advance(); fs.appendFileSync(file, reply.subarray(split)); f.touch(file); f.w.tick();
  assert.equal(f.w.sessions()[0].reply, '正在处理');
});

function clientReader(zstd, run = execFileSync) {
  const file = path.join(__dirname, '../src/clients.js'), mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, Buffer,
    require: name => name === 'zlib' ? zstd : name === 'child_process' ? { execFileSync: run } : createRequire(file)(name),
  }, { filename: file });
  return mod.exports.readDsh;
}

test('DSH rejects a native decoder that silently reads only the first frame', t => {
  const f = fixture(t);
  const p = f.write('.dsh/sessions/project/compressed/session.v4.jsonl.zstd', []);
  let probes = 0, fallbacks = 0;
  const read = clientReader({
    zstdCompressSync: input => input,
    zstdDecompressSync: input => { probes++; return input.subarray(0, 1); },
  }, (command, args, options) => {
    fallbacks++;
    assert.equal(command, 'zstd'); assert.equal(args.at(-1), p);
    assert.equal(options.maxBuffer, 32 * 1024 * 1024);
    return 'complete transcript';
  });
  assert.equal(read(p), 'complete transcript');
  assert.equal(read(p), 'complete transcript');
  assert.equal(probes, 1, 'probe once per loaded module, not once per log');
  assert.equal(fallbacks, 2);
  const unavailable = clientReader({}, () => { throw Object.assign(new Error('zstd unavailable'), { code: 'ENOENT' }); });
  assert.throws(() => unavailable(p), { code: 'ENOENT' }, 'missing decoders must not return a truncated transcript');
});

test('DSH reads concatenated zstd frames, retains state during partial writes, then recovers', t => {
  let compress = zlib.zstdCompressSync;
  if (!compress) {
    try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); }
    catch { return t.skip('Compressed DSH needs native zstd support or the zstd executable'); }
    compress = (input) => execFileSync('zstd', ['-q', '-c'], { input });
  }
  const f = fixture(t);
  const header = JSON.stringify({ type: 'session', id: 'compressed', createdAt: NOW }) + '\n';
  const frame = compress(Buffer.from(header + JSON.stringify(dsh('turn/start')) + '\n'));
  const finish = compress(Buffer.from(JSON.stringify(dsh('turn/end', { reason: { kind: 'completed' } })) + '\n'));
  const p = f.write('.dsh/sessions/project/compressed/session.v4.jsonl.zstd', []);
  fs.writeFileSync(p, frame);
  try { readDsh(p); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip('The native decoder cannot read concatenated frames and zstd is unavailable');
    throw error;
  }
  f.touch(p); f.w.tick();
  assert.equal(f.w.sessions()[0].status, 'thinking');
  f.advance(); fs.appendFileSync(p, finish.subarray(0, 4)); f.touch(p); f.w.tick();
  assert.equal(f.w.sessions()[0].status, 'thinking');
  f.advance(); fs.appendFileSync(p, finish.subarray(4)); f.touch(p); f.w.tick();
  assert.equal(f.w.sessions()[0].status, 'done');
  assert.ok(readDsh(p).includes('turn/end'));
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); } catch { return; }
  const cliRead = clientReader({});
  assert.ok(cliRead(p).includes('turn/end'), 'older Node uses the existing zstd executable');
  fs.writeFileSync(p, Buffer.concat([frame, finish.subarray(0, 4)]));
  assert.throws(() => cliRead(p), 'the CLI must reject an unfinished frame too');
  fs.appendFileSync(p, finish.subarray(4));
  assert.ok(cliRead(p).includes('turn/end'));
});
