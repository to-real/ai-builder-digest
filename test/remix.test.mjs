import { test } from 'node:test';
import assert from 'node:assert';
import { remix, buildSystemPrompt } from '../scripts/remix.mjs';

const samplePrompts = {
  'digest-intro': 'INTRO_RULES',
  'summarize-podcast': 'PODCAST_RULES',
  'summarize-tweets': 'TWEET_RULES',
  'summarize-blogs': 'BLOG_RULES',
  'translate': 'TRANSLATE_RULES'
};

test('buildSystemPrompt bundles all prompts and bilingual rules', () => {
  const sys = buildSystemPrompt(samplePrompts);
  for (const v of Object.values(samplePrompts)) assert.ok(sys.includes(v), `missing ${v}`);
  assert.match(sys, /bilingual/i);
  assert.match(sys, /url/i);
});

test('remix posts to GLM endpoint with system+user and returns content', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '# Digest\nbody' } }] }) };
  };
  const out = await remix('{"x":[],"podcasts":[]}', 'fake-key', samplePrompts);
  assert.equal(out, '# Digest\nbody');

  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer fake-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'glm-4.6');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, '{"x":[],"podcasts":[]}');
});

test('remix throws on non-ok response with status + body', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => remix('{}', 'k', samplePrompts), /401/);
});
