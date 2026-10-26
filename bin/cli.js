#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { Watcher, CLAUDE_DIR, CODEX_DIR, GEMINI_DIR, ompDirs } = require('../src/watcher');
const { DemoWatcher } = require('../src/demo');
const scenes = require('../src/scenes');
const updater = require('../src/update');
const { createServer, snapshot } = require('../src/server');
const pkg = require('../package.json');

const HELP = `whatsmyagentdoing ${pkg.version}
See what every Claude Code, Codex, Gemini CLI and OMP agent on this machine is doing, live.

Usage: node bin/cli.js [options]   (or /myoffice as a skill)

Options:
  -p, --port <n>    Port to serve on (default 4545)
  --hours <n>       Show sessions active in the last n hours (default 24)
  --omp-dir <path>  OMP sessions root (or a direct --session-dir directory)
  --no-open         Don't open the browser
  --private         Hide prompts, replies and titles; show status only
  --json            Print one snapshot as JSON and exit
  --demo            Show a made-up team instead of your sessions
  --stop            Stop a running dashboard
  --update          Update to the latest version (git pull) and restart a running dashboard
  --scenes          List 3D scenes (installed and downloadable)
  --scene <id>      Download a scene if needed and open the office in it
  --remove-scene <id>  Delete a downloaded scene
  -h, --help        Show this help

Reads (never writes):
  ${CLAUDE_DIR}
  ${CODEX_DIR}
  ${GEMINI_DIR}
  ${ompDirs().map(x => x.dir).join('\n  ')}
Override with CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME /
  WMAD_OMP_SESSIONS_DIR (or --omp-dir); OMP also honors PI_CODING_AGENT_DIR.
OMP profiles under ~/.omp/profiles are discovered automatically.`;

function parseArgs(argv) {
  const o = { port: 4545, hours: 24, open: true, privacy: false, json: false, demo: false, stop: false, scenes: false, scene: null, removeScene: null, update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--hours') o.hours = Number(argv[++i]);
    else if (a.startsWith('--hours=')) o.hours = Number(a.slice(8));
    else if (a === '--omp-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error('--omp-dir requires a path'); process.exit(1); }
      o.ompDir = argv[++i];
    }
    else if (a.startsWith('--omp-dir=')) o.ompDir = a.slice(10);
    else if (a === '--no-open') o.open = false;
    else if (a === '--private') o.privacy = true;
    else if (a === '--json') o.json = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--stop') o.stop = true;
    else if (a === '--update') o.update = true;
    else if (a === '--scenes') o.scenes = true;
    else if (a === '--scene') o.scene = argv[++i];
    else if (a.startsWith('--scene=')) o.scene = a.slice(8);
    else if (a === '--remove-scene') o.removeScene = argv[++i];
    else { console.error(`Unknown option: ${a}\n\n${HELP}`); process.exit(1); }
  }
  if (!Number.isFinite(o.port) || !Number.isFinite(o.hours)) { console.error(HELP); process.exit(1); }
  return o;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

function alreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.includes('whatsmyagentdoing')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function stopAt(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 1500,
      headers: { 'x-whatsmyagentdoing': 'stop' } }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Agents read this line (see SKILL.md) and offer the update.
async function printUpdateHint() {
  await updater.checkLatest(true);
  const i = updater.info();
  if (i.updateAvailable) {
    console.log(`Update available: v${i.version} → v${i.latest}. Run with --update (or /myoffice update), or click "Update" on the page.`);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.update) {
    const before = updater.localVersion();
    try {
      const after = await updater.update();
      console.log(after === before ? `Already up to date (v${after}).` : `Updated v${before} → v${after}.`);
      // a running dashboard keeps the old code until it restarts
      for (let p = o.port; p <= o.port + 10; p++) {
        if (await alreadyRunning(p)) { await stopAt(p); console.log(`Restart it with /myoffice (it was on port ${p}).`); }
      }
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    return;
  }

  if (o.scenes) {
    const have = scenes.installed();
    const name = (x) => (x.name && (x.name.en || Object.values(x.name)[0])) || x.id;
    console.log('3D scenes (pick one with --scene <id>, or from the scene menu in High 3D):');
    console.log('  office      Office (built in)');
    for (const x of have) console.log(`  ${x.id.padEnd(11)} ${name(x)} (installed)`);
    for (const x of scenes.catalog().filter((c) => !have.some((h) => h.id === c.id))) {
      console.log(`  ${x.id.padEnd(11)} ${name(x)} (download, ${Math.max(1, Math.round(x.size / 1024))} KB)`);
    }
    return;
  }

  if (o.removeScene) {
    console.log(scenes.remove(o.removeScene) ? `Removed ${o.removeScene}.` : `${o.removeScene} isn't a downloaded scene.`);
    return;
  }

  if (o.scene && o.scene !== 'office') {
    try {
      const had = scenes.sceneDir(o.scene);
      const x = await scenes.install(o.scene);
      console.log(had ? `Scene ${x.id} is ready.` : `Downloaded scene ${x.id}.`);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
  }

  if (o.stop) {
    // It may have moved to a later port if the default was taken.
    const ports = [];
    for (let p = o.port; p <= o.port + 10; p++) if (await alreadyRunning(p)) ports.push(p);
    for (const p of ports) await stopAt(p);
    console.log(ports.length ? `Stopped ${ports.map((p) => `http://localhost:${p}`).join(', ')}` : 'Not running.');
    return;
  }

  if (o.json) {
    const w = new Watcher({ hours: o.hours, ompDir: o.ompDir });
    w.tick();
    w.lastScan = 0;
    w.tick();
    console.log(JSON.stringify(snapshot(w, o).sessions, null, 2));
    return;
  }

  const query = o.scene ? `/?view=office&quality=high&scene=${encodeURIComponent(o.scene)}` : '';
  if (await alreadyRunning(o.port)) {
    const url = `http://localhost:${o.port}${query}`;
    console.log(`Already running at ${url}`);
    await printUpdateHint();
    if (o.open) openBrowser(url);
    return;
  }

  const watcher = (o.demo ? new DemoWatcher() : new Watcher({ hours: o.hours, ompDir: o.ompDir })).start();
  const server = createServer(watcher, o, {
    onShutdown: () => { watcher.stop(); server.close(); process.exit(0); },
    // after an update from the page: start the new code on the same port
    onRestart: () => {
      watcher.stop();
      server.close(() => {
        const args = process.argv.slice(2).filter((a) => a !== '--no-open' && !a.startsWith('--scene'));
        spawn(process.execPath, [__filename, ...args, '--no-open'], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      });
      server.closeAllConnections && server.closeAllConnections();
    },
  });

  const listen = (port, tries) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
      else { console.error(err.message); process.exit(1); }
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      const n = watcher.sessions().length;
      const openUrl = url + query;
      const what = o.demo ? 'demo team' : `${n} session${n === 1 ? '' : 's'} in the last ${o.hours}h`;
      console.log(`whatsmyagentdoing v${updater.localVersion()} → ${url}  (${what}, Ctrl+C to stop)`);
      printUpdateHint();
      if (o.open) openBrowser(openUrl);
    });
  };
  listen(o.port, 10);
}

main();
