// Each case owns a child process so an uncaught request error fails the test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

for (const scenario of ['assets', 'scenes', 'guards']) {
  test(`HTTP ${scenario}: malformed paths and resource boundaries`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-server-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/server.cjs'), scenario, home], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WMAD_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}
