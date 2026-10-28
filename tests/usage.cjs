// Synthetic events only.
const assert = require('node:assert/strict');
const test = require('node:test');
const { newSession, applyClaude, applyCodex, dayKey } = require('../src/parsers');

const NOW = Date.now();
const at = (ms) => new Date(ms).toISOString();

test('Claude counts each API response once, tracks context fill and counts real prompts as turns', () => {
  const s = newSession('claude', 'a', null);
  applyClaude(s, { type: 'user', timestamp: at(NOW), message: { role: 'user', content: 'Fix it' } });
  applyClaude(s, { type: 'user', timestamp: at(NOW), message: { role: 'user', content: '<task-notification>x</task-notification>' } });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50_000, output_tokens: 200 };
  for (const block of [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Done' }]) {
    applyClaude(s, { type: 'assistant', timestamp: at(NOW), message: { id: 'msg_1', role: 'assistant', model: 'claude-x', usage, content: [block] } });
  }
  assert.equal(s.daily.turns, 1, 'task notifications are not turns');
  assert.equal(s.daily.tokens, 1210, 'cache reads are not counted, and a response logged twice counts once');
  assert.equal(s.context, 51_210);
  assert.equal(s.contextWindow, 200_000);
  applyClaude(s, { type: 'assistant', timestamp: at(NOW), message: { id: 'msg_2', role: 'assistant', usage: { input_tokens: 5, cache_read_input_tokens: 400_000, output_tokens: 5 }, content: [] } });
  assert.equal(s.contextWindow, 1_000_000, 'more than 200k in context means a 1M window');
});

test('Codex reads token_count events and resets at a new day', () => {
  const s = newSession('codex', 'b', null);
  const yesterday = NOW - 86_400_000;
  applyCodex(s, { type: 'event_msg', timestamp: at(yesterday), payload: { type: 'task_started' } });
  applyCodex(s, { type: 'event_msg', timestamp: at(NOW), payload: { type: 'task_started' } });
  applyCodex(s, { type: 'event_msg', timestamp: at(NOW), payload: { type: 'user_message', message: 'new' } });
  applyCodex(s, { type: 'event_msg', timestamp: at(NOW), payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 24_601, cached_input_tokens: 13_056, output_tokens: 312 }, model_context_window: 475_000 } } });
  assert.equal(s.daily.day, dayKey(NOW));
  assert.equal(s.daily.turns, 1);
  assert.equal(s.daily.tokens, 24_601 - 13_056 + 312);
  assert.equal(s.context, 24_913);
  assert.equal(s.contextWindow, 475_000);
  applyCodex(s, { type: 'event_msg', timestamp: at(yesterday), payload: { type: 'task_started' } });
  assert.equal(s.daily.turns, 1, 'an older day never rolls the counter back');
  applyCodex(s, { type: 'event_msg', timestamp: at(NOW), payload: { type: 'token_count', info: null } });
});
