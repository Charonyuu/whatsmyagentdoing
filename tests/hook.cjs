// Isolated homes and settings files only; never touches the real Claude Code settings.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const CLI = path.join(__dirname, '../bin/cli.js');
const tmp = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// Loads a module with os.homedir() pointing at root.
function load(file, root, extra = {}) {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, Date, process: { env: {}, pid: process.pid, platform: process.platform, execPath: process.execPath }, console, setInterval, clearInterval,
    __dirname: path.dirname(file),
    require: (name) => name === 'os' ? { homedir: () => root } : name === './hook' ? load(path.join(__dirname, '../src/hook.js'), root) : createRequire(file)(name),
    ...extra,
  }, { filename: file });
  return mod.exports;
}

test('only permission and question prompts write a marker, and session IDs cannot escape the folder', t => {
  const root = tmp(t), hook = load(path.join(__dirname, '../src/hook.js'), root);
  const dir = path.join(root, '.whatsmyagentdoing/waiting');
  assert.equal(hook.record(JSON.stringify({ session_id: 'abc', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })), false);
  assert.equal(hook.record(JSON.stringify({ session_id: '../../evil', notification_type: 'permission_prompt' })), false);
  assert.equal(hook.record(JSON.stringify({ session_id: 'a/b', notification_type: 'permission_prompt' })), false);
  assert.equal(hook.record('not json'), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(hook.record(JSON.stringify({ session_id: 'abc', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), 1000), true);
  assert.equal(hook.record(JSON.stringify({ session_id: 'old-style', message: 'Claude needs your permission to use Edit' }), 1000), true);
  assert.deepEqual([...fs.readdirSync(dir)].sort(), ['abc.json', 'old-style.json']);
  assert.deepEqual({ ...hook.markers(0).get('abc') }, { at: 1000, message: 'Claude needs your permission to use Bash' });
  assert.equal(hook.markers(2000).size, 0, 'markers older than the window are removed');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('install keeps other settings and hooks, is idempotent, and uninstall removes only ours', t => {
  const root = tmp(t), hook = load(path.join(__dirname, '../src/hook.js'), root);
  const file = path.join(root, 'settings.json');
  const before = { model: 'opus', hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  fs.writeFileSync(file, JSON.stringify(before));
  hook.install(file); hook.install(file);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.model, 'opus');
  assert.equal(d.hooks.Notification.length, 2);
  assert.match(d.hooks.Notification[1].hooks[0].command, /bin[\\/]cli\.js" --hook$/);
  assert.equal(hook.installed(file), true);
  assert.equal(hook.uninstall(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
  assert.equal(hook.uninstall(file), false);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => hook.install(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'an unreadable settings file is never overwritten');
  const fresh = path.join(root, 'new/settings.json');
  hook.install(fresh);
  hook.uninstall(fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {});
});

test('a Claude session waits for you until its log moves past the prompt', t => {
  const root = tmp(t);
  const log = path.join(root, '.claude/projects/proj/sess-1.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const now = Date.now();
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(log, line({ type: 'user', timestamp: new Date(now - 5000).toISOString(), cwd: '/work', message: { role: 'user', content: 'Run the tests' } })
    + line({ type: 'assistant', timestamp: new Date(now - 4000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }));
  const { Watcher } = load(path.join(__dirname, '../src/watcher.js'), root);
  const hook = load(path.join(__dirname, '../src/hook.js'), root);
  const w = new Watcher();
  w.tick();
  assert.equal(w.sessions()[0].status, 'tool');
  hook.record(JSON.stringify({ session_id: 'sess-1', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), now - 3000);
  w.tick();
  assert.equal(w.sessions()[0].status, 'waiting');
  assert.equal(w.sessions()[0].activity, 'Claude needs your permission to use Bash');
  fs.appendFileSync(log, line({ type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }));
  w.tick();
  assert.notEqual(w.sessions()[0].status, 'waiting', 'approving the tool clears the wait');
});

test('cli.js --hook records from stdin, prints nothing and always exits 0', t => {
  const root = tmp(t);
  const env = { ...process.env, HOME: root, USERPROFILE: root, WMAD_NO_UPDATE_CHECK: '1' };
  const run = (input) => execFileSync(process.execPath, [CLI, '--hook'], { env, input, encoding: 'utf8' });
  assert.equal(run(JSON.stringify({ session_id: 'abc', notification_type: 'permission_prompt', message: 'Claude needs your permission' })), '');
  assert.equal(run('garbage'), '');
  assert.deepEqual(fs.readdirSync(path.join(root, '.whatsmyagentdoing/waiting')), ['abc.json']);
  const settings = path.join(root, '.claude/settings.json');
  execFileSync(process.execPath, [CLI, '--install-hook'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Notification.length, 1);
  execFileSync(process.execPath, [CLI, '--uninstall-hook'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
});
