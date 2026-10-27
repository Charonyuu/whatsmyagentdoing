'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// These are session storage roots, not artifact directories for individual chats.
function ompDirs(override, env = process.env, home = os.homedir(), platform = process.platform) {
  const active = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const named = value => value && value !== 'default' && /^[\w][\w.-]*$/.test(value) ? value : null;
  if (override || env.WMAD_OMP_SESSIONS_DIR) {
    return [{ dir: path.resolve(override || env.WMAD_OMP_SESSIONS_DIR), profile: named(active) }];
  }
  const base = path.join(home, '.omp');
  const profiles = new Set();
  try {
    for (const e of fs.readdirSync(path.join(base, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) profiles.add(e.name);
    }
  } catch {}
  if (named(active)) profiles.add(active);
  const sessionDir = (profile) => {
    const root = profile ? path.join(base, 'profiles', profile) : base;
    const inheritedProfile = named(active) || named(env.PI_PROFILE);
    const derivedAgent = inheritedProfile && path.join(base, 'profiles', inheritedProfile, 'agent');
    const agent = !profile && env.PI_CODING_AGENT_DIR && path.resolve(env.PI_CODING_AGENT_DIR) !== derivedAgent && env.PI_CODING_AGENT_DIR;
    if (!agent && ['linux', 'darwin'].includes(platform) && env.XDG_DATA_HOME) {
      const xdg = path.join(env.XDG_DATA_HOME, 'omp', ...(profile ? ['profiles', profile] : []));
      if (fs.existsSync(xdg)) return path.join(xdg, 'sessions');
    }
    return path.join(agent ? path.resolve(agent) : path.join(root, 'agent'), 'sessions');
  };
  return [{ dir: sessionDir(null), profile: null }, ...Array.from(profiles, profile => ({ dir: sessionDir(profile), profile }))];
}

function ompResumeCommand(s, platform = process.platform) {
  // Windows commands target PowerShell 5.1 and PowerShell 7.
  // A separate --cwd avoids &&, which is unsupported by PowerShell 5.1.
  const quote = platform === 'win32'
    ? v => "'" + String(v).replace(/'/g, "''") + "'"
    : v => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const args = ['omp'];
  args.push('--profile', quote(s.ompProfile || 'default'));
  if (s.cwd) args.push('--cwd', quote(s.cwd));
  args.push('--session-dir', quote(path.dirname(s.file)), '--resume', quote(s.sessionId || s.id));
  return args.join(' ');
}

module.exports = { ompDirs, ompResumeCommand };
