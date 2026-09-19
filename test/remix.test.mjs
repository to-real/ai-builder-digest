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

test('remix posts to GLM endpoint with system+user and returns content', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
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

test('remix throws on non-ok response with status + body', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => remix('{}', 'k', samplePrompts), /401/);
});

test('remix allows each GLM request up to 300 seconds', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });

  let timeoutMs;
  AbortSignal.timeout = (ms) => {
    timeoutMs = ms;
    return new AbortController().signal;
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '# Digest' } }] })
  });

  await remix('{}', 'k', samplePrompts);
  assert.equal(timeoutMs, 300_000);
});

test('remix retries transient failures at most twice and logs timing', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalLog = console.log;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    console.log = originalLog;
    console.warn = originalWarn;
  });

  let attempts = 0;
  const logs = [];
  globalThis.fetch = async () => {
    attempts += 1;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));

  await assert.rejects(() => remix('{}', 'k', samplePrompts), { name: 'TimeoutError' });
  assert.equal(attempts, 2);
  assert.ok(logs.some(line => /attempt 1\/2 started.*300000ms/i.test(line)));
  assert.ok(logs.some(line => /attempt 1\/2 failed after \d+ms/i.test(line)));
  assert.ok(logs.some(line => /retrying in 5000ms/i.test(line)));
});
