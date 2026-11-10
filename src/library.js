'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');

const CATEGORY_ORDER = ['development', 'design', 'media', 'writing', 'research', 'productivity', 'games', 'other'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache']);
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_DIRECTORIES = 30000;

function readResidentSkill(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > MAX_SKILL_BYTES) return null;
  // Reading a macOS File Provider placeholder can block the entire HTTP server.
  if (process.platform === 'darwin' && stat.blocks === 0) {
    const flags = Number(execFileSync('/usr/bin/stat', ['-L', '-f', '%f', file], {
      encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (flags & 0x40000000) return null;
  }
  return fs.readFileSync(file);
}

function slug(value) {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  return out || 'skill';
}

function scalar(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text.replace(/\s+#.*$/, '').trim();
}

function parseSkill(text) {
  const source = text.replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = 1;
  while (end < lines.length && lines[end].trim() !== '---') end += 1;
  if (end >= lines.length) return null;

  let name = '';
  let description = '';
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) name = scalar(nameMatch[1]);
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      let value = scalar(descMatch[1]);
      if (['>', '|', '>-', '|-', '>+', '|+'].includes(value)) {
        const parts = [];
        let j = i + 1;
        for (; j < end && (/^\s+/.test(lines[j]) || !lines[j].trim()); j += 1) {
          if (lines[j].trim()) parts.push(lines[j].trim());
        }
        value = parts.join(' ');
      }
      description = value;
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(name) || !description.trim()) return null;
  const bodyLines = lines.slice(end + 1);
  if (bodyLines[0] === '') bodyLines.shift();
  const body = bodyLines.join('\n');
  return { name, description: description.slice(0, 600), body };
}

function categoryFor(name, description) {
  const title = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = new Set(title.split(/\s+/));
  const mentions = (list) => list.some((word) => words.has(word));
  const text = `${title} ${String(description || '').toLowerCase()}`;

  // Strong signals in the skill name win. Description matches use narrow phrases
  // so generic terms such as "create", "guide", and "workflow" do not dominate.
  if (/^(gsap|impeccable|unslop|x impeccable|x unslop|uv workflow|handpainted isometric|design taste|figma|adobe design)/.test(title)) return 'design';
  if (/^(nurture|ue mcp|unreal export|unity cozy farm|asset optimization|collision proxy|lod pipeline|environment artist|prop artist|texture workflow|scene assembly|export pipeline)/.test(title) || mentions(['game', 'games', 'gamedev', 'unity', 'unreal', 'collision', 'lod', 'teardown', 'kiln'])) return 'games';
  if (/^(data visualization|visualize|vectorbt|stock evaluator|fundamentals|backtest|optimize|analyze|research|prior art)/.test(title) || mentions(['research', 'search', 'investigation', 'backtest', 'analysis', 'analyze', 'vectorbt', 'fundamentals', 'trend', 'statistics', 'visualization'])) return 'research';
  if (/^(gsap|impeccable|unslop|uv workflow|handpainted isometric|design taste|figma|adobe design)/.test(title) || mentions(['design', 'figma', 'frontend', 'ui', 'ux', 'visual', 'illustrator', 'photoshop', 'blender', 'lookdev', 'lighting', 'material', 'sprite', 'map'])) return 'design';
  if (/^(rednote|marketing|ai launch copywriter|ai copy qa|ai copy|copywriter|caveman|baoyu translate|baoyu format markdown|baoyu url to markdown|baoyu wechat summary|baoyu post)/.test(title) || mentions(['writing', 'writer', 'copywriter', 'translate', 'translation', 'article', 'markdown', 'humanize', 'humanizer', 'document', 'blog'])) return 'writing';
  if (/^(pdf|excel|spreadsheet|google sheets|skill installer|skill creator|plugin management|codex skill curator|myoffice|recover vm applications|resume browser authentication)/.test(title) || mentions(['calendar', 'email', 'drive', 'sheets', 'spreadsheet', 'office', 'schedule', 'productivity', 'pets', 'browser'])) return 'productivity';
  if (/^(baoyu diagram|baoyu infographic)/.test(title) || mentions(['design', 'figma', 'frontend', 'ui', 'ux', 'visual', 'illustrator', 'photoshop', 'blender', 'lookdev', 'lighting', 'material', 'sprite', 'map'])) return 'design';
  if (/^(adobe edit|adobe create social|adobe batch|adobe retouch|baoyu article illustrator|baoyu comic|baoyu compress|baoyu cover|baoyu image|baoyu slide|baoyu xhs|heygen|narrator|captions|cozy asmr|export animated)/.test(title) || mentions(['video', 'audio', 'image', 'photo', 'animation', 'motion', 'caption', 'avatar', 'heygen', 'infographic', 'comic', 'diagram', 'presentation', 'slides'])) return 'media';
  if (/^(macos|github|codebase|code review|tdd|diagnos|debug|qa review|architect|domain model|api gateway|building components|compare sqlite|prototype|restore local web previews|verify offline vsix|wizard)/.test(title) || mentions(['code', 'coding', 'development', 'developer', 'debug', 'test', 'testing', 'api', 'cli', 'git', 'software', 'programming', 'architect', 'engineering', 'build', 'component', 'database'])) return 'development';

  if (/\b(game development|game engine|gameplay|unity|unreal engine|collision proxy|level of detail|3d asset optimization)\b/.test(text)) return 'games';
  if (/\b(research|investigate|search the web|market research|stock analysis|analyze a question|data visualization|statistical analysis|trend analysis|fundamental analysis)\b/.test(text)) return 'research';
  if (/\b(user interface|user experience|visual design|design system|figma|graphic design|3d asset|environment art|look development|gsap animation)\b/.test(text)) return 'design';
  if (/\b(rednote|copywriting|marketing voice|write|writing|translate|translation|articles|markdown|documents|editing|rewrite)\b/.test(text)) return 'writing';
  if (/\b(pdf|excel|calendar|email|spreadsheets|google drive|skill management|scheduling|office workflow|personal assistant)\b/.test(text)) return 'productivity';
  if (/\b(video|audio|image generation|image editing|photo|animation|motion graphics|illustration|infographic|slide deck)\b/.test(text)) return 'media';
  if (/\b(code|coding|software|debug|test|api|command line|developer|programming|engineering|github|macos diagnostics)\b/.test(text)) return 'development';
  return 'other';
}

function parseCodexPlugins(codexHome) {
  const file = path.join(codexHome, 'config.toml');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
  const enabled = new Set();
  const marketplaces = new Map();
  let pluginSection = '';
  let marketplaceSection = '';
  for (const line of lines) {
    const header = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/);
    if (header) { pluginSection = header[1]; marketplaceSection = ''; continue; }
    const marketplace = line.match(/^\s*\[(?:plugin_)?marketplaces\."?([^"\]]+)"?\]\s*$/);
    if (marketplace) { marketplaceSection = marketplace[1]; pluginSection = ''; continue; }
    if (/^\s*\[/.test(line)) { pluginSection = ''; marketplaceSection = ''; continue; }
    if (pluginSection) {
      if (/^\s*enabled\s*=\s*true\s*(?:#.*)?$/.test(line)) enabled.add(pluginSection);
      else if (/^\s*enabled\s*=\s*false\b/.test(line)) enabled.delete(pluginSection);
    }
    if (marketplaceSection) {
      const source = line.match(/^\s*source\s*=\s*"([^"]+)"/);
      if (source && path.isAbsolute(source[1])) marketplaces.set(marketplaceSection, source[1]);
    }
  }

  const roots = [];
  for (const entry of [...enabled].sort()) {
    const at = entry.lastIndexOf('@');
    if (at < 1) continue;
    const plugin = entry.slice(0, at), marketplace = entry.slice(at + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(plugin) || !/^[A-Za-z0-9._-]+$/.test(marketplace)) continue;
    const label = `Codex plugin: ${plugin}`;
    const cached = path.join(codexHome, 'plugins', 'cache', marketplace, plugin);
    const before = roots.length;
    addVersionSkillRoot(roots, cached, label);
    const source = marketplaces.get(marketplace);
    if (source && roots.length === before) {
      roots.push({ path: path.join(source, 'plugins', plugin, 'skills'), label });
      roots.push({ path: path.join(source, plugin, 'skills'), label });
    }
  }
  return dedupeRoots(roots);
}

function addVersionSkillRoot(roots, pluginDir, label) {
  let entries;
  try { entries = fs.readdirSync(pluginDir, { withFileTypes: true }); } catch { return; }
  const versions = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const dir = path.join(pluginDir, entry.name);
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && fs.existsSync(path.join(dir, 'skills'))) versions.push({ dir, version: entry.name, mtime: stat.mtimeMs });
    } catch { /* stale plugin version */ }
  }
  versions.sort((a, b) => compareVersions(b.version, a.version) || b.mtime - a.mtime || a.version.localeCompare(b.version));
  if (versions[0]) roots.push({ path: path.join(versions[0].dir, 'skills'), label });
}

function compareVersions(a, b) {
  const av = String(a).match(/^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/);
  const bv = String(b).match(/^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/);
  if (!av || !bv) return 0;
  const left = av[1].split('.').map(Number), right = bv[1].split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

function parseClaudePlugins(claudeHome) {
  const file = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  let registry;
  try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return [];
  const roots = [];
  for (const [pluginName, records] of Object.entries(registry.plugins || {})) {
    const installs = Array.isArray(records) ? records : [records];
    for (const install of installs) {
      if (!install || typeof install.installPath !== 'string' || !path.isAbsolute(install.installPath)) continue;
      roots.push({ path: path.join(install.installPath, 'skills'), label: `Claude plugin: ${pluginName}` });
    }
  }
  return roots;
}

function dedupeRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    const key = `${path.resolve(root.path)}\0${root.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

function discoverRoots(home = os.homedir(), env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return dedupeRoots([
    { path: path.join(codexHome, 'skills'), label: 'Codex' },
    { path: path.join(home, '.agents', 'skills'), label: 'Agent skills' },
    { path: path.join(claudeHome, 'skills'), label: 'Claude Code' },
    ...parseCodexPlugins(codexHome),
    ...parseClaudePlugins(claudeHome),
  ]);
}

function sourceLabel(root, rootPath, file) {
  const relative = path.relative(rootPath, path.dirname(file)).split(path.sep).filter(Boolean).join('/');
  return relative ? `${root.label} / ${relative}` : root.label;
}

function scanRoots(roots) {
  const byContent = new Map();
  let visitedDirectories = 0;

  function walk(root, rootPath, dir, ancestry, depth) {
    if (depth > 16 || visitedDirectories >= MAX_DIRECTORIES) return;
    let real;
    let entries;
    try {
      real = fs.realpathSync(dir);
      if (ancestry.has(real)) return;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    visitedDirectories += 1;
    const nextAncestry = new Set(ancestry); nextAncestry.add(real);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const hasSkillDocument = entries.some((entry) => entry.name === 'SKILL.md');
    for (const entry of entries) {
      if (entry.name === 'SKILL.md') {
        const file = path.join(dir, entry.name);
        try {
          const raw = readResidentSkill(file);
          if (!raw) continue;
          const parsed = parseSkill(raw.toString('utf8'), path.basename(dir));
          if (!parsed) continue;
          const hash = crypto.createHash('sha256').update(raw).digest('hex');
          const existing = byContent.get(hash);
          const source = sourceLabel(root, rootPath, file);
          if (existing) {
            if (!existing.sources.includes(source)) existing.sources.push(source);
          } else {
            byContent.set(hash, {
              id: `${slug(parsed.name)}-${hash.slice(0, 16)}`,
              name: parsed.name,
              description: parsed.description,
              category: categoryFor(parsed.name, parsed.description),
              sources: [source],
              files: [],
              _hash: hash,
            });
          }
          const record = byContent.get(hash);
          const realFile = fs.realpathSync(file);
          if (!record.files.some((candidate) => candidate.realFile === realFile && candidate.file === file)) record.files.push({ file, realFile });
        } catch { /* unreadable or changing local document */ }
        continue;
      }
      if (hasSkillDocument) continue;
      if (entry.name.startsWith('.') && entry.name !== '.system') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      walk(root, rootPath, path.join(dir, entry.name), nextAncestry, depth + 1);
    }
  }

  for (const root of roots) {
    let rootPath;
    try { if (!fs.statSync(root.path).isDirectory()) continue; rootPath = path.resolve(root.path); } catch { continue; }
    walk(root, rootPath, rootPath, new Set(), 0);
  }

  const skills = [...byContent.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const categories = CATEGORY_ORDER.map((id) => ({ id, skills: skills.filter((skill) => skill.category === id).map(({ id: skillId, name, description, sources }) => ({ id: skillId, name, description, sources })) }));
  const index = new Map(skills.map((skill) => [skill.id, {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sources: [...skill.sources].sort(),
    hash: skill._hash,
    files: skill.files,
  }]));
  return { categories, index };
}

function createLibrary({ home, roots } = {}) {
  const currentRoots = () => roots || discoverRoots(home);
  let snapshot = null;
  const refresh = () => { snapshot = scanRoots(currentRoots()); return snapshot; };
  return {
    catalog() { return refresh().categories; },
    getSkill(id) {
      if (typeof id !== 'string' || id.length > 160 || !/^[a-z0-9._-]+-[a-f0-9]{16}$/.test(id)) return null;
      const cached = (snapshot || refresh()).index.get(id);
      if (!cached) return null;
      for (const candidate of cached.files) {
        try {
          if (fs.realpathSync(candidate.file) !== candidate.realFile) continue;
          const raw = readResidentSkill(candidate.file);
          if (!raw) continue;
          if (crypto.createHash('sha256').update(raw).digest('hex') !== cached.hash) continue;
          const parsed = parseSkill(raw.toString('utf8'));
          if (!parsed) continue;
          return { id: cached.id, name: cached.name, description: cached.description, sources: cached.sources, body: parsed.body };
        } catch { /* removed or unreadable since catalog scan */ }
      }
      return null;
    },
  };
}

module.exports = { CATEGORY_ORDER, categoryFor, createLibrary, discoverRoots, parseSkill, scanRoots };
