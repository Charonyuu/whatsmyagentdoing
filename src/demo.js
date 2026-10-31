'use strict';

// `--demo`: a made-up team cycling through work, for screenshots and for
// trying the UI on a machine with no sessions. Same interface as Watcher.

const { EventEmitter } = require('events');
const { dayKey } = require('./parsers');

const TEAM = [
  ['claude', 'api-server', 'Add rate limiting to /v1/orders'],
  ['codex', 'landing-page', 'Make the hero section responsive'],
  ['copilot', 'cli-tools', 'Add a --verbose flag'],
  ['claude', 'mobile-app', 'Fix the crash on the settings screen'],
  ['gemini', 'data-pipeline', 'Backfill last week of events'],
  ['omp', 'search-index', 'Speed up the search index'],
  ['kimi', 'docs-site', 'Write the getting-started guide'],
  ['codex', 'billing', 'Handle failed card retries'],
  ['dsh', 'ml-eval', 'Rerun the eval suite on the new model'],
  ['gemini', 'infra', 'Bump the Postgres instance size'],
  ['grok', 'cost-report', 'Find idle cloud spend'],
  ['antigravity', 'design-system', 'Tidy up the button tokens'],
];

const TOOLS = {
  claude: ['Bash: npm test', 'Edit routes.ts', 'Read schema.prisma', 'Grep "retry"', 'Bash: git diff', 'Write README.md', 'WebSearch “Postgres upgrade”', 'github · create_pull_request'],
  gemini: ['Shell: npm run lint', 'ReadFile schema.sql', 'WebSearch “pg_upgrade”', 'Edit pipeline.py'],
  codex: ['Shell: pnpm test', 'Shell: rg TODO src', 'Editing app.tsx', 'Shell: npx tsc --noEmit', 'Shell: git status'],
  copilot: ['grep AGENT|agent', 'edit dashboard.js', 'read README.md', 'search codebase', 'run tests'],
  omp: ['bash: cargo test', 'read src/index.rs', 'edit src/query.rs', 'bash: cargo bench'],
  kimi: ['Shell: npm run build', 'ReadFile guide.md', 'Edit getting-started.md', 'Shell: npm run lint'],
  dsh: ['Shell: python eval.py', 'Read metrics.json', 'Edit config.yaml', 'Shell: pytest -q'],
  grok: ['Read billing.csv', 'Shell: aws ce get-cost-and-usage', 'Edit report.md', 'Search “idle instances”'],
  antigravity: ['Bash: npm run lint', 'read_file tokens.css', 'edit_file button.tsx', 'grep_search --color'],
};

const REPLIES = [
  'Done — tests pass and the PR is up.',
  'Fixed. The crash came from a null user on first launch.',
  'Added it behind a feature flag; ready for review.',
  'Updated the docs and the example config.',
];

// One work cycle, in seconds per step.
const SCRIPT = [
  ['thinking', 3], ['tool', 4], ['thinking', 2], ['tool', 3], ['typing', 3], ['done', 16],
];

class DemoWatcher extends EventEmitter {
  constructor() {
    super();
    const now = Date.now();
    this.list = TEAM.map(([agent, project, prompt], i) => ({
      agent,
      id: `demo-${i}`,
      file: null,
      cwd: `/home/dev/${project}`,
      title: prompt,
      model: { claude: 'claude-opus-5-5', codex: 'gpt-5-codex', gemini: 'gemini-3-pro', copilot: 'mai-code-1.1-flash',
        omp: 'claude-sonnet-5-5', kimi: 'kimi-k2', dsh: 'deepseek-v4', grok: 'grok-4', antigravity: 'Gemini 3.1 Pro (High)' }[agent],
      subagent: false,
      parentId: null,
      status: 'idle',
      activity: null,
      prompt,
      reply: null,
      error: null,
      turnStartedAt: null,
      lastEventAt: now,
      startedAt: now - (i + 1) * 600_000,
      // Stagger the team so some work while others take a break.
      offset: (i * 7.3) % 37,
      // A couple of them sometimes stop to ask you something.
      asks: i === 2 || i === 6,
      history: [
        { role: 'user', text: prompt, at: now - 900_000 },
        { role: 'tool', text: TOOLS[agent][0], at: now - 860_000 },
        { role: 'tool', text: TOOLS[agent][1], at: now - 820_000 },
        { role: 'assistant', text: REPLIES[i % REPLIES.length], at: now - 780_000 },
      ],
      // Made-up usage for the Today panel and context bars.
      daily: { day: dayKey(now), turns: 3 + ((i * 5) % 11), tokens: 40_000 + ((i * 73_919) % 410_000) },
      context: 30_000 + ((i * 41_017) % 165_000),
      contextWindow: agent === 'codex' ? 400_000 : 200_000,
    }));
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
    return this;
  }

  stop() { clearInterval(this.timer); }

  tick() {
    const t = Date.now() / 1000;
    const total = SCRIPT.reduce((a, [, d]) => a + d, 0);
    let changed = false;
    for (const s of this.list) {
      const cycle = Math.floor((t + s.offset) / total);
      let k = (t + s.offset) % total;
      let step = 0;
      while (k >= SCRIPT[step][1]) { k -= SCRIPT[step][1]; step++; }
      let [status] = SCRIPT[step];
      if (s.asks && cycle % 2 === 1 && status === 'typing') status = 'waiting';
      const key = `${cycle}:${step}:${status}`;
      if (key === s.key) continue;
      s.key = key;
      changed = true;
      const now = Date.now();
      if (step === 0) { s.turnStartedAt = now - k * 1000; s.reply = null; }
      s.status = status;
      s.lastEventAt = now;
      const tools = TOOLS[s.agent];
      s.activity = status === 'tool' ? tools[(cycle * 3 + step + s.offset | 0) % tools.length]
        : status === 'waiting' ? 'AskUserQuestion' : null;
      if (status === 'done') s.reply = REPLIES[(cycle + (s.offset | 0)) % REPLIES.length];
      // A made-up conversation for the side panel.
      const say = (role, text) => { s.history.push({ role, text, at: now }); if (s.history.length > 30) s.history.shift(); };
      if (step === 0) say('user', s.prompt);
      if (status === 'tool') say('tool', s.activity);
      if (status === 'done') say('assistant', s.reply);
    }
    if (changed) this.emit('change');
  }

  sessions() { return this.list; }

  transcript(key) {
    const s = this.list.find((x) => `${x.agent}:${x.id}` === key);
    return s ? s.history.slice() : null;
  }
}

module.exports = { DemoWatcher };
