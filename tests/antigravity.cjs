// Synthetic Antigravity CLI events and isolated directory tests.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { newSession, applyAntigravity, describeAntigravityTool } = require('../src/parsers');

const NOW = Date.now();
const ts = (offset = 0) => new Date(NOW + offset).toISOString();

test('applyAntigravity maps USER_INPUT, PLANNER_RESPONSE (thinking, tools, tokens, error, reply), and GENERIC', () => {
  const s = newSession('antigravity', 'test-sess', null);

  // 1. USER_INPUT with <USER_REQUEST> tag and Model Selection
  applyAntigravity(s, {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: ts(0),
    content: `<USER_REQUEST>\nPlease optimize our database queries.\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to Gemini 3.8 Flash (High).\n</USER_SETTINGS_CHANGE>`,
  });

  assert.equal(s.prompt, 'Please optimize our database queries.');
  assert.equal(s.reply, null);
  assert.equal(s.status, 'thinking');
  assert.equal(s.model, 'Gemini 3.8 Flash (High)');
  assert.equal(s.daily.turns, 1);

  // 2. PLANNER_RESPONSE with thinking and tokens
  applyAntigravity(s, {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: ts(1000),
    input_tokens: 15000,
    cache_read_tokens: 5000,
    output_tokens: 300,
    thinking: 'Planning steps...',
  });

  assert.equal(s.status, 'thinking');
  assert.equal(s.context, 20300);
  assert.equal(s.contextWindow, 1000000);
  assert.equal(s.daily.tokens, 15300);

  // 3. PLANNER_RESPONSE with run_command tool
  applyAntigravity(s, {
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: ts(2000),
    tool_calls: [{
      name: 'run_command',
      args: {
        CommandLine: '"npm test"',
        toolSummary: '"Unit test execution"',
      },
    }],
  });

  assert.equal(s.status, 'tool');
  assert.equal(s.activity, 'Bash: Unit test execution');

  // 4. GENERIC event (tool completed, back to thinking)
  applyAntigravity(s, {
    step_index: 3,
    source: 'MODEL',
    type: 'GENERIC',
    created_at: ts(3000),
    content: 'Command exited with code 0.',
  });

  assert.equal(s.status, 'thinking');

  // Tool output quoting a settings change must not change the model.
  applyAntigravity(s, {
    step_index: 3,
    source: 'MODEL',
    type: 'GENERIC',
    created_at: ts(3500),
    content: 'The user changed setting `Model Selection` from None to Fake Model.\n',
  });
  assert.equal(s.model, 'Gemini 3.8 Flash (High)');

  // 5. PLANNER_RESPONSE with edit_file tool
  applyAntigravity(s, {
    step_index: 4,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: ts(4000),
    tool_calls: [{
      name: 'edit_file',
      args: {
        Path: '"/Users/developer/project/src/db.js"',
      },
    }],
  });

  assert.equal(s.status, 'tool');
  assert.equal(s.activity, 'edit_file db.js');

  // 6. Test various describeAntigravityTool branches
  assert.equal(describeAntigravityTool({ name: 'read_file', args: { Path: '"/app/index.js"' } }), 'read_file index.js');
  assert.equal(describeAntigravityTool({ name: 'view_file', args: { AbsolutePath: '"/app/view.html"' } }), 'view_file view.html');
  assert.equal(describeAntigravityTool({ name: 'write_file', args: { Path: '"/app/config.json"' } }), 'write_file config.json');
  assert.equal(describeAntigravityTool({ name: 'grep_search', args: { Query: '"findMe"' } }), 'grep_search findMe');
  assert.equal(describeAntigravityTool({ name: 'find_by_name', args: { Pattern: '"*.ts"' } }), 'find_by_name *.ts');
  assert.equal(describeAntigravityTool({ name: 'search_web', args: { query: '"PostgreSQL indexes"' } }), 'WebSearch “PostgreSQL indexes”');
  assert.equal(describeAntigravityTool({ name: 'invoke_subagent', args: { Role: '"Database Expert"' } }), 'Subagent: Database Expert');
  assert.equal(describeAntigravityTool({ name: 'call_mcp_tool', args: { ServerName: '"postgres"', ToolName: '"query"' } }), 'postgres · query');
  assert.equal(describeAntigravityTool({ name: 'call_mcp_tool', args: { ServerName: '"postgres"' } }), 'postgres');
  assert.equal(describeAntigravityTool({ name: 'custom_tool' }), 'custom_tool');

  // 7. PLANNER_RESPONSE with ask_question (waiting)
  applyAntigravity(s, {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: ts(5000),
    tool_calls: [{
      name: 'ask_question',
      args: {
        questions: [{ question: '"Apply migration?"' }],
      },
    }],
  });

  assert.equal(s.status, 'waiting');
  assert.equal(s.activity, 'Waiting for your answer');

  // 8. Error in PLANNER_RESPONSE
  applyAntigravity(s, {
    step_index: 6,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'ERROR',
    content: 'Quota exceeded for Gemini API',
    created_at: ts(6000),
  });

  assert.equal(s.status, 'error');
  assert.equal(s.error, 'Quota exceeded for Gemini API');

  // 9. PLANNER_RESPONSE with final text content (turn done)
  applyAntigravity(s, {
    step_index: 7,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Database queries have been fully indexed and optimized.',
    created_at: ts(7000),
  });

  assert.equal(s.status, 'done');
  assert.equal(s.reply, 'Database queries have been fully indexed and optimized.');
  assert.equal(s.error, null);
});

test('applyAntigravity marks subagent lineage from step 0 SYSTEM_MESSAGE with sender UUID', () => {
  const s = newSession('antigravity', 'sub-agent-session-id', null);
  assert.equal(s.subagent, false);
  assert.equal(s.parentId, null);

  const parentUuid = 'c8c622b2-7934-4507-a879-9dbd9b06925b';
  applyAntigravity(s, {
    step_index: 0,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: ts(0),
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T04:16:27Z sender=${parentUuid} priority=MESSAGE_PRIORITY_HIGH content=Please implement Antigravity support in whatsmyagentdoing\n</SYSTEM_MESSAGE>`,
  });

  assert.equal(s.subagent, true);
  assert.equal(s.parentId, parentUuid);
  assert.equal(s.prompt, 'Please implement Antigravity support in whatsmyagentdoing');
  assert.equal(s.status, 'thinking');
  assert.equal(s.daily.turns, 1);
});

test('applyAntigravity keeps the turn going when a subagent reports back to its parent', () => {
  const s = newSession('antigravity', 'parent', null);
  applyAntigravity(s, { step_index: 0, type: 'USER_INPUT', created_at: ts(0), content: '<USER_REQUEST>Ship it</USER_REQUEST>' });
  applyAntigravity(s, { step_index: 1, type: 'PLANNER_RESPONSE', created_at: ts(1000), content: 'Delegating.' });
  applyAntigravity(s, {
    step_index: 2, type: 'SYSTEM_MESSAGE', created_at: ts(2000),
    content: '<SYSTEM_MESSAGE>\n[Message] sender=c8c622b2-7934-4507-a879-9dbd9b06925b content=Subagent finished\n</SYSTEM_MESSAGE>',
  });

  assert.equal(s.subagent, false);
  assert.equal(s.parentId, null);
  assert.equal(s.prompt, 'Ship it');
  assert.equal(s.reply, 'Delegating.');
  assert.equal(s.status, 'thinking');
  assert.equal(s.daily.turns, 1);
});

test('applyAntigravity sizes the context window from the selected model', () => {
  const tokens = (s) => applyAntigravity(s, { step_index: 1, type: 'PLANNER_RESPONSE', created_at: ts(1000), input_tokens: 1000, output_tokens: 10 });

  const unknown = newSession('antigravity', 'unknown', null);
  tokens(unknown);
  assert.equal(unknown.context, 1010);
  assert.equal(unknown.contextWindow, null);

  const claude = newSession('antigravity', 'claude', null);
  applyAntigravity(claude, {
    step_index: 0, type: 'USER_INPUT', created_at: ts(0),
    content: '<USER_REQUEST>Hi</USER_REQUEST>\nThe user changed setting `Model Selection` from None to Claude Opus 4.6 (Thinking). No need to comment.',
  });
  tokens(claude);
  assert.equal(claude.model, 'Claude Opus 4.6 (Thinking)');
  assert.equal(claude.contextWindow, 200000);
});

test('Watcher discovers Antigravity sessions, resolves cwd from history.jsonl, and title from annotations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-antigravity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const agyHome = path.join(root, '.gemini', 'antigravity-cli');
  const watcherFile = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };

  vm.runInNewContext(fs.readFileSync(watcherFile, 'utf8'), {
    module: mod, Buffer, Date, console, setInterval, clearInterval,
    process: { env: { ANTIGRAVITY_HOME: agyHome } },
    require: (name) => name === 'os' ? { homedir: () => root } : createRequire(watcherFile)(name),
  }, { filename: watcherFile });

  const parentId = '11111111-2222-3333-4444-555555555555';
  const childId = '66666666-7777-8888-9999-000000000000';

  // Setup parent session transcript
  const parentLogDir = path.join(agyHome, 'brain', parentId, '.system_generated', 'logs');
  fs.mkdirSync(parentLogDir, { recursive: true });
  fs.writeFileSync(path.join(parentLogDir, 'transcript.jsonl'), [
    JSON.stringify({
      step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: ts(0),
      content: '<USER_REQUEST>Build Antigravity support</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: ts(1000),
      content: 'I will help with that.',
    }),
  ].join('\n') + '\n');

  // Setup child subagent session transcript
  const childLogDir = path.join(agyHome, 'brain', childId, '.system_generated', 'logs');
  fs.mkdirSync(childLogDir, { recursive: true });
  fs.writeFileSync(path.join(childLogDir, 'transcript.jsonl'), [
    JSON.stringify({
      step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: ts(2000),
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${ts(2000)} sender=${parentId} content=Subagent task instructions\n</SYSTEM_MESSAGE>`,
    }),
    JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: ts(3000),
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo test"' } }],
    }),
  ].join('\n') + '\n');

  // Setup history.jsonl with workspace for parent
  fs.mkdirSync(agyHome, { recursive: true });
  fs.writeFileSync(path.join(agyHome, 'history.jsonl'), [
    JSON.stringify({ conversationId: parentId, workspace: '/Users/test/workspace/project' }),
  ].join('\n') + '\n');

  // Setup annotations for parent
  const annotationsDir = path.join(agyHome, 'annotations');
  fs.mkdirSync(annotationsDir, { recursive: true });
  fs.writeFileSync(path.join(annotationsDir, `${parentId}.pbtxt`), 'title: "Antigravity Integration Task"\n');

  const watcher = new mod.exports.Watcher({ hours: 24 });
  watcher.tick();
  // Force scan
  watcher.lastScan = 0;
  watcher.tick();

  const sessions = watcher.sessions();
  assert.equal(sessions.length, 2);

  const parentSession = sessions.find((s) => s.id === parentId);
  assert.ok(parentSession, 'parent session discovered');
  assert.equal(parentSession.agent, 'antigravity');
  assert.equal(parentSession.cwd, '/Users/test/workspace/project');
  assert.equal(parentSession.title, 'Antigravity Integration Task');
  assert.equal(parentSession.status, 'done');
  assert.equal(parentSession.reply, 'I will help with that.');
  assert.equal(parentSession.subagent, false);

  const childSession = sessions.find((s) => s.id === childId);
  assert.ok(childSession, 'child session discovered');
  assert.equal(childSession.agent, 'antigravity');
  // Subagent inherits parent's workspace when child has no direct entry in history.jsonl
  assert.equal(childSession.cwd, '/Users/test/workspace/project');
  assert.equal(childSession.subagent, true);
  assert.equal(childSession.parentId, parentId);
  assert.equal(childSession.status, 'tool');
  assert.equal(childSession.activity, 'Bash: echo test');

  // A rename is picked up, with octal UTF-8 escapes decoded ("修正 \"登入\"").
  const note = path.join(annotationsDir, `${parentId}.pbtxt`);
  fs.writeFileSync(note, 'title: "\\344\\277\\256\\346\\255\\243 \\"\\347\\231\\273\\345\\205\\245\\""\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(note, later, later);
  assert.equal(watcher.sessions().find((s) => s.id === parentId).title, '修正 "登入"');
});
