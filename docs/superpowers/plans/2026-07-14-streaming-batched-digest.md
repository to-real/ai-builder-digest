# Streaming Batched Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single long GLM request with resumable, size-bounded streaming summarization followed by one global editing pass and a deterministic publication fallback.

**Architecture:** Normalize all feed sources into one item contract, group homogeneous items into batches of at most 20,000 serialized characters, and stream each batch into validated summary JSON with a concurrency limit of two. Cache successful item summaries, then stream a global editing pass over the compressed summaries; if editing or validation still fails, render valid summaries locally into publishable Markdown.

**Tech Stack:** Node.js 24 ESM, built-in `fetch`/WHATWG streams, `node:test`, SHA-256 from `node:crypto`, GitHub Actions cache v6, GitHub upload-artifact v7.

## Global Constraints

- Use Node.js 24 in GitHub Actions and verification commands.
- Add no runtime dependency for SSE parsing, batching, validation, caching, or fallback rendering.
- Repository `prompts/*.md` files are the only production prompt source; `feed.json` must not contain prompts.
- Default batch limit is exactly 20,000 serialized characters and default GLM concurrency is exactly 2.
- Streaming timeouts are: 120 seconds to first data, 60 seconds idle, 5 minutes absolute for summary batches, and 8 minutes absolute for final composition.
- Retry a failed summary batch once, then split it by serialized size; skip a single item only after it also fails twice.
- A skipped item must be visible in the run report but must not fail or appear in the public digest.
- The final output must preserve bilingual item content, source-link allowlisting, existing heading structure, and the Follow Builders footer.
- Keep the legacy one-request implementation selectable with `DIGEST_PIPELINE=legacy` until the streaming pipeline succeeds in three consecutive real runs.
- Every behavior change follows red-green-refactor TDD and each task ends in a focused commit.

## File Map

- `scripts/prepare-digest.js`: fetch feed data and build prompt-free `feed.json`.
- `scripts/normalize-feed.mjs`: convert X builders, blog posts, and podcast episodes to standard items.
- `scripts/batch-items.mjs`: pack and split homogeneous item batches by serialized size.
- `scripts/glm-stream.mjs`: call GLM with SSE parsing, timeout classification, and timing metrics.
- `scripts/summary-record.mjs`: validate summary records and persist content-addressed cache entries.
- `scripts/summarize-items.mjs`: coordinate cache lookup, concurrency, retry, split, and single-item skip.
- `scripts/compose-digest.mjs`: globally edit summaries and validate generated Markdown.
- `scripts/render-fallback.mjs`: render valid summary records without an LLM.
- `scripts/digest-pipeline.mjs`: orchestrate the streaming pipeline and write the machine-readable run report.
- `scripts/remix-legacy.mjs`: preserve the current one-request implementation as a rollback path.
- `scripts/remix.mjs`: CLI dispatcher and final digest writer.
- `test/fixtures/feed.json`: stable multi-source feed for integration tests.
- `test/*.test.mjs`: one focused test file per module plus workflow and pipeline tests.
- `.github/workflows/daily.yml`: restore/save cache, upload reports, and select the streaming pipeline.

---

### Task 1: Remove duplicate prompts and normalize feed items

**Files:**
- Modify: `scripts/prepare-digest.js`
- Create: `scripts/normalize-feed.mjs`
- Create: `test/normalize-feed.test.mjs`

**Interfaces:**
- Produces: `buildFeedOutput({ config, feedX, feedBlogs, feedPodcasts, errors }) -> Feed`
- Produces: `normalizeFeed(feed) -> { items: DigestItem[], stats: object }`
- `DigestItem`: `{ id, type, author, bio, title, content, url, publishedAt }`

- [ ] **Step 1: Write the failing feed-contract tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedOutput } from '../scripts/prepare-digest.js';
import { normalizeFeed } from '../scripts/normalize-feed.mjs';

test('feed output excludes prompts', () => {
  const feed = buildFeedOutput({
    config: { language: 'bilingual' },
    feedX: { x: [] }, feedBlogs: { blogs: [] }, feedPodcasts: { podcasts: [] }, errors: []
  });
  assert.equal('prompts' in feed, false);
});

test('normalizeFeed emits one stable item per tweet, blog, and podcast', () => {
  const feed = {
    x: [{ name: 'Swyx', bio: 'AI Engineer', tweets: [{ id: 't1', text: 'Build smaller.', url: 'https://x.test/t1', createdAt: '2026-07-14' }] }],
    blogs: [{ name: 'Claude Blog', title: 'Typed models', content: 'Body', url: 'https://blog.test/1', publishedAt: '2026-07-14' }],
    podcasts: [{ name: 'MAD', title: 'Open models', transcript: 'Transcript', url: 'https://video.test/1', publishedAt: '2026-07-14' }],
    stats: {}
  };
  const { items } = normalizeFeed(feed);
  assert.deepEqual(items.map(item => item.type), ['x', 'blog', 'podcast']);
  assert.deepEqual(items.map(item => item.url), ['https://x.test/t1', 'https://blog.test/1', 'https://video.test/1']);
  assert.equal(new Set(items.map(item => item.id)).size, 3);
});
```

- [ ] **Step 2: Run the tests and verify the missing exports fail**

Run: `npx --yes node@24 --test test/normalize-feed.test.mjs`

Expected: FAIL because `buildFeedOutput` and `normalize-feed.mjs` do not exist.

- [ ] **Step 3: Extract prompt-free feed construction**

Remove `PROMPTS_BASE`, `PROMPT_FILES`, `fetchText`, remote prompt loading, and the `prompts` property from `prepare-digest.js`. Export and call this function from `main()`:

```js
export function buildFeedOutput({ config, feedX, feedBlogs, feedPodcasts, errors = [] }) {
  const x = feedX?.x || [];
  const blogs = feedBlogs?.blogs || [];
  const podcasts = feedPodcasts?.podcasts || [];
  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },
    podcasts,
    x,
    blogs,
    stats: {
      podcastEpisodes: podcasts.length,
      xBuilders: x.length,
      totalTweets: x.reduce((sum, author) => sum + author.tweets.length, 0),
      blogPosts: blogs.length,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },
    errors: errors.length ? errors : undefined
  };
}
```

Guard CLI execution so importing the module does not fetch the network:

```js
import { fileURLToPath } from 'node:url';

function handleFatalError(error) {
  console.error(JSON.stringify({ status: 'error', message: error.message }));
  process.exitCode = 1;
}

const invokedDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirect) main().catch(handleFatalError);
```

- [ ] **Step 4: Implement item normalization**

```js
import { createHash } from 'node:crypto';

function stableId(type, url) {
  return createHash('sha256').update(`${type}\0${url}`).digest('hex').slice(0, 20);
}

export function normalizeFeed(feed) {
  const items = [];
  for (const author of feed.x || []) {
    for (const tweet of author.tweets || []) {
      items.push({ id: stableId('x', tweet.url), type: 'x', author: author.name || '', bio: author.bio || '', title: '', content: tweet.text || '', url: tweet.url, publishedAt: tweet.createdAt || '' });
    }
  }
  for (const post of feed.blogs || []) {
    items.push({ id: stableId('blog', post.url), type: 'blog', author: post.author || post.name || '', bio: post.name || '', title: post.title || '', content: post.content || post.description || '', url: post.url, publishedAt: post.publishedAt || '' });
  }
  for (const episode of feed.podcasts || []) {
    items.push({ id: stableId('podcast', episode.url), type: 'podcast', author: episode.name || '', bio: episode.name || '', title: episode.title || '', content: episode.transcript || '', url: episode.url, publishedAt: episode.publishedAt || '' });
  }
  return { items, stats: { ...(feed.stats || {}), normalizedItems: items.length } };
}
```

- [ ] **Step 5: Verify and commit**

Run: `npx --yes node@24 --test test/normalize-feed.test.mjs`

Expected: 2 tests pass.

```bash
git add scripts/prepare-digest.js scripts/normalize-feed.mjs test/normalize-feed.test.mjs
git commit -m "refactor: normalize prompt-free digest feed"
```

### Task 2: Pack and split batches by serialized size

**Files:**
- Create: `scripts/batch-items.mjs`
- Create: `test/batch-items.test.mjs`

**Interfaces:**
- Produces: `serializedChars(items) -> number`
- Produces: `batchItems(items, maxChars = 20_000) -> DigestItem[][]`
- Produces: `splitBatch(items) -> [DigestItem[], DigestItem[]]`

- [ ] **Step 1: Write boundary tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchItems, serializedChars, splitBatch } from '../scripts/batch-items.mjs';

const item = (id, content) => ({ id, type: 'x', content, url: `https://x.test/${id}` });

test('batchItems preserves order and stays under the limit', () => {
  const batches = batchItems([item('a', 'x'.repeat(60)), item('b', 'y'.repeat(60)), item('c', 'z'.repeat(60))], 180);
  assert.deepEqual(batches.flat().map(value => value.id), ['a', 'b', 'c']);
  assert.ok(batches.every(batch => batch.length === 1 || serializedChars(batch) <= 180));
});

test('an oversized single item remains intact', () => {
  const batches = batchItems([item('large', 'x'.repeat(500))], 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].content.length, 500);
});

test('splitBatch balances serialized size without reordering', () => {
  const [left, right] = splitBatch([item('a', 'x'.repeat(10)), item('b', 'x'.repeat(300)), item('c', 'x'.repeat(10))]);
  assert.deepEqual([...left, ...right].map(value => value.id), ['a', 'b', 'c']);
  assert.ok(left.length > 0 && right.length > 0);
});
```

- [ ] **Step 2: Verify the module-missing failure**

Run: `npx --yes node@24 --test test/batch-items.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement packing and balanced splitting**

```js
export const serializedChars = items => JSON.stringify(items).length;

export function batchItems(items, maxChars = 20_000) {
  const batches = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (current.length && serializedChars(candidate) > maxChars) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export function splitBatch(items) {
  if (items.length < 2) throw new Error('cannot split a single-item batch');
  const total = serializedChars(items);
  let bestIndex = 1;
  let bestDistance = Infinity;
  for (let index = 1; index < items.length; index++) {
    const distance = Math.abs(serializedChars(items.slice(0, index)) - total / 2);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  }
  return [items.slice(0, bestIndex), items.slice(bestIndex)];
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx --yes node@24 --test test/batch-items.test.mjs`

Expected: 3 tests pass.

```bash
git add scripts/batch-items.mjs test/batch-items.test.mjs
git commit -m "feat: batch digest items by input size"
```

### Task 3: Add the streaming GLM client

**Files:**
- Create: `scripts/glm-stream.mjs`
- Create: `test/glm-stream.test.mjs`

**Interfaces:**
- Produces: `parseSseEvent(data) -> string | null`
- Produces: `streamChat({ messages, apiKey, model, endpoint, fetchImpl, timeouts }) -> { content, metrics }`
- Timeout error names: `FirstByteTimeout`, `IdleTimeout`, `AbsoluteTimeout`

- [ ] **Step 1: Write SSE and timeout tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseEvent, streamChat } from '../scripts/glm-stream.mjs';

function responseFrom(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  }), { status: 200 });
}

test('parseSseEvent extracts GLM delta content', () => {
  assert.equal(parseSseEvent('{"choices":[{"delta":{"content":"hello"}}]}'), 'hello');
  assert.equal(parseSseEvent('[DONE]'), null);
});

test('streamChat joins fragmented SSE chunks and records metrics', async () => {
  const fetchImpl = async () => responseFrom([
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'
  ]);
  const result = await streamChat({ messages: [], apiKey: 'k', fetchImpl, timeouts: { firstByteMs: 100, idleMs: 100, absoluteMs: 500 } });
  assert.equal(result.content, 'hello world');
  assert.equal(result.metrics.chunks, 2);
  assert.ok(result.metrics.firstByteMs >= 0);
});

test('streamChat aborts when the first data chunk never arrives', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  await assert.rejects(
    () => streamChat({ messages: [], apiKey: 'k', fetchImpl, timeouts: { firstByteMs: 10, idleMs: 10, absoluteMs: 100 } }),
    { name: 'FirstByteTimeout' }
  );
});
```

- [ ] **Step 2: Verify the tests fail because the client is absent**

Run: `npx --yes node@24 --test test/glm-stream.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement SSE parsing and three timeout clocks**

Implement `streamChat` with `AbortController`, a first-data timer cleared by the first body chunk, an idle timer reset on every chunk, and an absolute timer that is never reset. Use these exact defaults:

```js
const DEFAULT_TIMEOUTS = { firstByteMs: 120_000, idleMs: 60_000, absoluteMs: 300_000 };

export function parseSseEvent(data) {
  if (!data || data === '[DONE]') return null;
  const parsed = JSON.parse(data);
  return parsed.choices?.[0]?.delta?.content ?? '';
}

function timeoutError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}
```

The read loop must retain incomplete text between chunks, split events on `\n\n`, accept CRLF, and call `reader.cancel()` in `finally`. POST this body:

```js
JSON.stringify({ model, messages, temperature: 0.5, stream: true })
```

Return metrics with `{ firstByteMs, totalMs, chunks, finishReason }`. Throw `GLM API error <status>: <body>` for non-2xx responses. Timer callbacks must call `controller.abort(timeoutError(...))`; the catch block must rethrow `controller.signal.reason` when the signal is aborted.

Use this control flow for the complete body read:

```js
export async function streamChat({ messages, apiKey, model = 'glm-4.6', endpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions', fetchImpl = fetch, timeouts = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const controller = new AbortController();
  const startedAt = Date.now();
  let firstByteAt = null;
  let chunks = 0;
  let idleTimer;
  const abort = (name, message) => { if (!controller.signal.aborted) controller.abort(timeoutError(name, message)); };
  const abortPromise = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  const firstTimer = setTimeout(() => abort('FirstByteTimeout', 'GLM sent no data before the first-byte deadline'), limits.firstByteMs);
  const absoluteTimer = setTimeout(() => abort('AbsoluteTimeout', 'GLM exceeded the absolute deadline'), limits.absoluteMs);
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort('IdleTimeout', 'GLM stream became idle'), limits.idleMs); };
  let reader;
  try {
    const response = await Promise.race([fetchImpl(endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.5, stream: true })
    }), abortPromise]);
    if (!response.ok) throw new Error(`GLM API error ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('GLM response body is missing');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = 'eof';
    read: while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      if (firstByteAt === null) { firstByteAt = Date.now(); clearTimeout(firstTimer); }
      resetIdle();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') { finishReason = 'done'; break read; }
        const delta = parseSseEvent(data);
        if (delta) { content += delta; chunks += 1; }
      }
    }
    if (!content) throw new Error('GLM stream returned no content');
    return { content, metrics: { firstByteMs: firstByteAt - startedAt, totalMs: Date.now() - startedAt, chunks, finishReason } };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(firstTimer); clearTimeout(idleTimer); clearTimeout(absoluteTimer);
    if (reader) await reader.cancel().catch(() => {});
  }
}
```

- [ ] **Step 4: Add idle and absolute timeout tests**

Use a `ReadableStream` that emits one valid SSE chunk and then remains open to assert `IdleTimeout`. Use a stream that emits chunks more frequently than `idleMs` while running beyond `absoluteMs` to assert `AbsoluteTimeout`. Set test timeouts to 10–40 ms so the suite does not wait real minutes.

```js
test('streamChat distinguishes idle and absolute timeouts', async () => {
  const idleFetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); } }), { status: 200 });
  await assert.rejects(() => streamChat({ messages: [], apiKey: 'k', fetchImpl: idleFetch, timeouts: { firstByteMs: 20, idleMs: 10, absoluteMs: 100 } }), { name: 'IdleTimeout' });

  let interval;
  const activeFetch = async () => new Response(new ReadableStream({
    start(controller) { interval = setInterval(() => controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')), 5); },
    cancel() { clearInterval(interval); }
  }), { status: 200 });
  await assert.rejects(() => streamChat({ messages: [], apiKey: 'k', fetchImpl: activeFetch, timeouts: { firstByteMs: 20, idleMs: 20, absoluteMs: 35 } }), { name: 'AbsoluteTimeout' });
});
```

- [ ] **Step 5: Verify and commit**

Run: `npx --yes node@24 --test test/glm-stream.test.mjs`

Expected: all SSE and timeout tests pass in under one second.

```bash
git add scripts/glm-stream.mjs test/glm-stream.test.mjs
git commit -m "feat: stream GLM responses with liveness timeouts"
```

### Task 4: Define validated summary records and content-addressed cache

**Files:**
- Create: `scripts/summary-record.mjs`
- Create: `test/summary-record.test.mjs`

**Interfaces:**
- Produces: `validateSummary(value, expectedItem) -> string[]`
- Produces: `summaryCacheKey(item, { model, prompt }) -> string`
- Produces: `readSummaryCache(cacheDir, key) -> SummaryRecord | null`
- Produces: `writeSummaryCache(cacheDir, key, summary) -> Promise<void>`

- [ ] **Step 1: Write contract and cache tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSummary, summaryCacheKey, readSummaryCache, writeSummaryCache } from '../scripts/summary-record.mjs';

const item = { id: 'a', type: 'x', content: 'body', url: 'https://x.test/a' };
const summary = { id: 'a', type: 'x', author: 'Builder A', title: '', include: true, role: 'CEO', judgment: 'A judgment', facts: ['One fact'], english: 'English detail.', chinese: '中文细节。', themes: ['agents'], url: item.url };

test('summary requires matching id/url and bilingual content', () => {
  assert.deepEqual(validateSummary(summary, item), []);
  assert.match(validateSummary({ ...summary, url: 'https://wrong.test' }, item).join(' '), /url/);
  assert.match(validateSummary({ ...summary, chinese: '' }, item).join(' '), /chinese/);
});

test('cache key changes with content, model, or prompt', () => {
  const base = summaryCacheKey(item, { model: 'glm-4.6', prompt: 'v1' });
  assert.notEqual(base, summaryCacheKey({ ...item, content: 'changed' }, { model: 'glm-4.6', prompt: 'v1' }));
  assert.notEqual(base, summaryCacheKey(item, { model: 'glm-other', prompt: 'v1' }));
  assert.notEqual(base, summaryCacheKey(item, { model: 'glm-4.6', prompt: 'v2' }));
});

test('cache round-trips valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digest-cache-'));
  await writeSummaryCache(dir, 'key', summary);
  assert.deepEqual(await readSummaryCache(dir, 'key'), summary);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Verify the missing module failure**

Run: `npx --yes node@24 --test test/summary-record.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement validation and atomic cache writes**

Use SHA-256 over `JSON.stringify({ item, model, prompt })`. Store cache files as `<cacheDir>/items/<key>.json`. Write to `<key>.tmp-<pid>` and rename to the final path so interrupted writes cannot create valid-looking partial JSON. `readSummaryCache` must return `null` on `ENOENT` or invalid JSON and rethrow other filesystem errors.

```js
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateSummary(value, expected) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['summary must be an object'];
  if (value.id !== expected.id) issues.push('id does not match input item');
  if (value.type !== expected.type) issues.push('type does not match input item');
  if (value.url !== expected.url) issues.push('url does not match input item');
  if (typeof value.author !== 'string' || !value.author.trim()) issues.push('author is required');
  if (['blog', 'podcast'].includes(value.type) && (typeof value.title !== 'string' || !value.title.trim())) issues.push('title is required');
  if (typeof value.role !== 'string' || !value.role.trim()) issues.push('role is required');
  if (typeof value.include !== 'boolean') issues.push('include must be boolean');
  for (const field of ['judgment', 'english', 'chinese']) if (typeof value[field] !== 'string' || !value[field].trim()) issues.push(`${field} is required`);
  if (!Array.isArray(value.facts)) issues.push('facts must be an array');
  if (!Array.isArray(value.themes)) issues.push('themes must be an array');
  return issues;
}

export function summaryCacheKey(item, { model, prompt }) {
  return createHash('sha256').update(JSON.stringify({ item, model, prompt })).digest('hex');
}

export async function readSummaryCache(cacheDir, key) {
  try { return JSON.parse(await readFile(join(cacheDir, 'items', `${key}.json`), 'utf-8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

export async function writeSummaryCache(cacheDir, key, summary) {
  const dir = join(cacheDir, 'items');
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `${key}.json`);
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(summary)}\n`, 'utf-8');
  await rename(tempPath, finalPath);
}
```

Validation must report all of these failures in one array: non-object record, mismatched `id`, mismatched `type`, mismatched `url`, empty `author`, empty `role`, non-boolean `include`, empty `judgment`, empty `english`, empty `chinese`, non-array `facts`, and non-array `themes`. Blog and podcast records must also have a non-empty `title`.

- [ ] **Step 4: Verify and commit**

Run: `npx --yes node@24 --test test/summary-record.test.mjs`

Expected: 3 tests pass.

```bash
git add scripts/summary-record.mjs test/summary-record.test.mjs
git commit -m "feat: validate and cache digest summaries"
```

### Task 5: Build resilient concurrent batch summarization

**Files:**
- Create: `scripts/summarize-items.mjs`
- Create: `test/summarize-items.test.mjs`

**Interfaces:**
- Consumes: `batchItems`, `splitBatch`, summary cache functions, and injected `chat({ messages, timeouts })`
- Produces: `summarizeItems({ items, prompts, chat, cacheDir, model, maxChars, concurrency }) -> { summaries, skipped, metrics }`

- [ ] **Step 1: Write retry, split, skip, cache, and concurrency tests**

Create tests with an injected `chat` function that parses the JSON user message and returns valid summary JSON. Cover these exact cases:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeItems } from '../scripts/summarize-items.mjs';
import { summaryCacheKey, writeSummaryCache } from '../scripts/summary-record.mjs';

const prompts = { 'summarize-tweets': 'Summarize X as JSON.', 'summarize-blogs': 'Summarize blogs as JSON.', 'summarize-podcast': 'Summarize podcasts as JSON.' };
const item = id => ({ id, type: 'x', author: id, bio: 'Builder', title: '', content: `content-${id}`, url: `https://source.test/${id}`, publishedAt: '2026-07-14' });
const validSummary = value => ({ id: value.id, type: value.type, author: value.author, title: value.title || '', include: true, role: 'Builder', judgment: `Judgment ${value.id}`, facts: ['fact'], english: 'English detail.', chinese: '中文细节。', themes: ['agents'], url: value.url });

test('retries once, splits a repeatedly failing batch, and keeps successful items', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'summaries-'));
  const calls = new Map();
  const chat = async ({ messages }) => {
    const items = JSON.parse(messages.at(-1).content);
    const key = items.map(item => item.id).join(',');
    calls.set(key, (calls.get(key) || 0) + 1);
    if (items.length > 1) throw new Error('batch stalled');
    if (items[0].id === 'bad') throw new Error('item stalled');
    return { content: JSON.stringify([validSummary(items[0])]), metrics: { totalMs: 1 } };
  };
  const result = await summarizeItems({ items: [item('good'), item('bad')], prompts, chat, cacheDir, model: 'glm-4.6', maxChars: 20_000, concurrency: 2, sleep: async () => {} });
  assert.deepEqual(result.summaries.map(value => value.id), ['good']);
  assert.deepEqual(result.skipped.map(value => value.id), ['bad']);
  assert.equal(calls.get('good,bad'), 2);
  assert.equal(calls.get('bad'), 2);
  await rm(cacheDir, { recursive: true, force: true });
});
```

Add a cache-hit test asserting `chat` is not called for a valid cached record. Add a concurrency test that increments an `active` counter inside `chat`, waits on controlled promises, and asserts the maximum observed value is exactly 2.

Use this concrete concurrency assertion after creating a fresh temporary cache directory:

```js
let active = 0;
let maxActive = 0;
const chat = async ({ messages }) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 10));
  active -= 1;
  const values = JSON.parse(messages.at(-1).content);
  return { content: JSON.stringify(values.map(validSummary)), metrics: { totalMs: 10 } };
};
await summarizeItems({ items: ['a', 'b', 'c', 'd'].map(item), prompts, chat, cacheDir, model: 'glm-4.6', maxChars: 1, concurrency: 2, sleep: async () => {} });
assert.equal(maxActive, 2);
```

For the cache-hit assertion, use the exact prompt selected for the X item when computing the key:

```js
const cachedItem = item('cached');
const cachedSummary = validSummary(cachedItem);
const key = summaryCacheKey(cachedItem, { model: 'glm-4.6', prompt: prompts['summarize-tweets'] });
await writeSummaryCache(cacheDir, key, cachedSummary);
const result = await summarizeItems({ items: [cachedItem], prompts, cacheDir, model: 'glm-4.6', chat: async () => { throw new Error('cache miss'); } });
assert.deepEqual(result.summaries, [cachedSummary]);
assert.equal(result.metrics.cacheHits, 1);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx --yes node@24 --test test/summarize-items.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement homogeneous queues and recovery**

Group uncached items by `type`, call `batchItems` for each group, and enqueue `{ type, items }`. Use two worker loops by default:

```js
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    await processBatch(batch);
  }
});
await Promise.all(workers);
```

`processBatch` calls the injected chat twice at most, with a 5-second delay between attempts in production and an injected `sleep` in tests. It parses a JSON array, matches records to input items by `id`, validates each record, and caches valid records immediately. After two failures, enqueue `splitBatch(batch.items)` when the batch has multiple items; otherwise append `{ id, url, reason }` to `skipped`.

Use the prompt mapping:

```js
const promptKey = { x: 'summarize-tweets', blog: 'summarize-blogs', podcast: 'summarize-podcast' };
```

The summary request system message must require JSON only and repeat the summary-record fields. Pass `timeouts: { firstByteMs: 120_000, idleMs: 60_000, absoluteMs: 300_000 }` to the streaming client. Preserve original item order by sorting final summaries against an `id -> index` map before returning.

Implement the coordinator with this queue shape and error boundary:

```js
import { batchItems, splitBatch } from './batch-items.mjs';
import { readSummaryCache, summaryCacheKey, validateSummary, writeSummaryCache } from './summary-record.mjs';

const PROMPT_KEYS = { x: 'summarize-tweets', blog: 'summarize-blogs', podcast: 'summarize-podcast' };
const SUMMARY_TIMEOUTS = { firstByteMs: 120_000, idleMs: 60_000, absoluteMs: 300_000 };

export async function summarizeItems({ items, prompts, chat, cacheDir, model = 'glm-4.6', maxChars = 20_000, concurrency = 2, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const order = new Map(items.map((value, index) => [value.id, index]));
  const summaries = [];
  const skipped = [];
  const metrics = { cacheHits: 0, requests: 0, batches: 0, splits: 0, totalGlmMs: 0 };
  const uncached = [];
  for (const value of items) {
    const prompt = prompts[PROMPT_KEYS[value.type]];
    const key = summaryCacheKey(value, { model, prompt });
    const cached = await readSummaryCache(cacheDir, key);
    if (cached && validateSummary(cached, value).length === 0) { summaries.push(cached); metrics.cacheHits += 1; }
    else uncached.push(value);
  }
  const queue = Object.keys(PROMPT_KEYS).flatMap(type => batchItems(uncached.filter(value => value.type === type), maxChars).map(values => ({ type, items: values })));
  const processBatch = async batch => {
    metrics.batches += 1;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const requestStartedAt = Date.now();
      try {
        metrics.requests += 1;
        const prompt = prompts[PROMPT_KEYS[batch.type]];
        const messages = [{ role: 'system', content: `${prompt}\nReturn only a JSON array with id,type,author,title,include,role,judgment,facts,english,chinese,themes,url.` }, { role: 'user', content: JSON.stringify(batch.items) }];
        const result = await chat({ messages, timeouts: SUMMARY_TIMEOUTS });
        const records = JSON.parse(result.content);
        if (!Array.isArray(records)) throw new Error('summary response must be a JSON array');
        const matched = batch.items.map(value => ({ value, record: records.find(candidate => candidate.id === value.id) }));
        for (const { value, record } of matched) {
          const issues = validateSummary(record, value);
          if (issues.length) throw new Error(`${value.id}: ${issues.join('; ')}`);
        }
        for (const { value, record } of matched) {
          const key = summaryCacheKey(value, { model, prompt });
          await writeSummaryCache(cacheDir, key, record);
          summaries.push(record);
        }
        return;
      } catch (error) {
        lastError = error;
      } finally {
        metrics.totalGlmMs += Date.now() - requestStartedAt;
      }
      if (attempt === 1) await sleep(5_000);
    }
    if (batch.items.length > 1) {
      metrics.splits += 1;
      const [left, right] = splitBatch(batch.items);
      queue.push({ type: batch.type, items: left }, { type: batch.type, items: right });
    } else {
      const value = batch.items[0];
      skipped.push({ id: value.id, url: value.url, reason: `${lastError.name}: ${lastError.message}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) await processBatch(queue.shift()); }));
  summaries.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { summaries, skipped, metrics };
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx --yes node@24 --test test/summarize-items.test.mjs`

Expected: retry/split/skip, cache-hit, and concurrency tests pass.

```bash
git add scripts/summarize-items.mjs test/summarize-items.test.mjs
git commit -m "feat: summarize digest batches with recovery"
```

### Task 6: Add global composition and Markdown validation

**Files:**
- Create: `scripts/compose-digest.mjs`
- Create: `test/compose-digest.test.mjs`

**Interfaces:**
- Produces: `validateDigest(markdown, summaries) -> string[]`
- Produces: `composeDigest({ summaries, prompts, chat, date }) -> { markdown, metrics, repaired }`
- Throws: `DigestCompositionError` with `.issues` and `.lastMarkdown` after failed repair

- [ ] **Step 1: Write validation and repair tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDigest, composeDigest, DigestCompositionError } from '../scripts/compose-digest.mjs';

const summaries = [{ id: 'a', type: 'x', author: 'Builder A', title: '', include: true, role: 'CEO', judgment: 'Ship smaller.', english: 'English details.', chinese: '中文细节。', facts: ['fact'], themes: ['agents'], url: 'https://x.test/a' }];
const valid = '# AI Builders Digest — July 14, 2026\n\n### X / TWITTER\n\n## Builder\n\n*CEO*\n\n**Ship smaller.**\n\nEnglish details.\n\n中文细节。\n\n→ [原文](https://x.test/a)\n\nGenerated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders';

test('validateDigest accepts bilingual allowlisted Markdown', () => {
  assert.deepEqual(validateDigest(valid, summaries), []);
  assert.match(validateDigest(valid.replace('https://x.test/a', 'https://invented.test'), summaries).join(' '), /not present/);
  assert.match(validateDigest(valid.replace('中文细节。', ''), summaries).join(' '), /Chinese/);
});

test('composeDigest repairs one invalid draft', async () => {
  const outputs = ['# broken', valid];
  const result = await composeDigest({ summaries, prompts: {}, date: '2026-07-14', chat: async () => ({ content: outputs.shift(), metrics: {} }) });
  assert.equal(result.markdown, valid);
  assert.equal(result.repaired, true);
});

test('composeDigest exposes the final invalid draft after repair fails', async () => {
  await assert.rejects(() => composeDigest({ summaries, prompts: {}, date: '2026-07-14', chat: async () => ({ content: '# broken', metrics: {} }) }), DigestCompositionError);
});

test('composeDigest converts a streaming failure into a fallback-safe error', async () => {
  const timeout = new Error('stream idle');
  timeout.name = 'IdleTimeout';
  await assert.rejects(() => composeDigest({ summaries, prompts: {}, date: '2026-07-14', chat: async () => { throw timeout; } }), error => error instanceof DigestCompositionError && /IdleTimeout/.test(error.issues.join(' ')));
});
```

- [ ] **Step 2: Verify the module-missing failure**

Run: `npx --yes node@24 --test test/compose-digest.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement local Markdown validation**

Split item blocks on lines beginning with `## ` but not `### `. For every block, require an ASCII letter, a CJK character (`/[\u3400-\u9fff]/`), and at least one Markdown URL. Extract every `http` URL from the document and reject any URL that is neither in the summary URL set nor the exact Follow Builders footer URL. Also require the level-one title and footer.

```js
const FOOTER_URL = 'https://github.com/zarazhangrui/follow-builders';

export function validateDigest(markdown, summaries) {
  const issues = [];
  if (!/^# AI Builders Digest\b/m.test(markdown)) issues.push('missing level-one digest title');
  if (!markdown.trimEnd().endsWith(`Generated through the Follow Builders skill: ${FOOTER_URL}`)) issues.push('missing Follow Builders footer');
  const allowed = new Set([FOOTER_URL, ...summaries.map(value => value.url)]);
  for (const url of markdown.match(/https?:\/\/[^\s)]+/g) || []) if (!allowed.has(url)) issues.push(`URL not present in summaries: ${url}`);
  const blocks = markdown.split(/(?=^## (?!#))/m).slice(1);
  for (const [index, block] of blocks.entries()) {
    if (!/[A-Za-z]/.test(block)) issues.push(`item ${index + 1} missing English`);
    if (!/[\u3400-\u9fff]/.test(block)) issues.push(`item ${index + 1} missing Chinese`);
    if (!/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(block)) issues.push(`item ${index + 1} missing source link`);
  }
  if (!blocks.length) issues.push('digest contains no item blocks');
  return issues;
}
```

- [ ] **Step 4: Implement composition and one repair call**

The first call receives all `include: true` summaries plus the versioned intro/translation/layout prompts and uses `timeouts: { firstByteMs: 120_000, idleMs: 60_000, absoluteMs: 480_000 }`. If validation fails, make exactly one second call containing the invalid Markdown and the exact issue array. Validate again; if issues remain, throw:

```js
export class DigestCompositionError extends Error {
  constructor(issues, lastMarkdown) {
    super(`digest validation failed: ${issues.join('; ')}`);
    this.name = 'DigestCompositionError';
    this.issues = issues;
    this.lastMarkdown = lastMarkdown;
  }
}
```

Use the same call shape for draft and repair:

```js
const COMPOSE_TIMEOUTS = { firstByteMs: 120_000, idleMs: 60_000, absoluteMs: 480_000 };

export async function composeDigest({ summaries, prompts, chat, date }) {
  const selected = summaries.filter(value => value.include);
  const system = [prompts['digest-intro'], prompts.translate, 'Create one coherent bilingual digest. Use only the supplied JSON and URLs. Return Markdown only.'].filter(Boolean).join('\n\n');
  let draftResult;
  try { draftResult = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ date, summaries: selected }) }], timeouts: COMPOSE_TIMEOUTS }); }
  catch (error) { throw new DigestCompositionError([`${error.name}: ${error.message}`], ''); }
  let issues = validateDigest(draftResult.content, selected);
  if (!issues.length) return { markdown: draftResult.content, metrics: { draft: draftResult.metrics }, repaired: false };
  let repairResult;
  try {
    repairResult = await chat({
      messages: [
        { role: 'system', content: `${system}\n\nRepair every listed validation error. Do not add new facts or URLs.` },
        { role: 'user', content: JSON.stringify({ issues, markdown: draftResult.content }) }
      ],
      timeouts: COMPOSE_TIMEOUTS
    });
  } catch (error) { throw new DigestCompositionError([`${error.name}: ${error.message}`], draftResult.content); }
  issues = validateDigest(repairResult.content, selected);
  if (issues.length) throw new DigestCompositionError(issues, repairResult.content);
  return { markdown: repairResult.content, metrics: { draft: draftResult.metrics, repair: repairResult.metrics }, repaired: true };
}
```

- [ ] **Step 5: Verify and commit**

Run: `npx --yes node@24 --test test/compose-digest.test.mjs`

Expected: 4 tests pass.

```bash
git add scripts/compose-digest.mjs test/compose-digest.test.mjs
git commit -m "feat: compose and validate global digest"
```

### Task 7: Add deterministic fallback rendering

**Files:**
- Create: `scripts/render-fallback.mjs`
- Create: `test/render-fallback.test.mjs`

**Interfaces:**
- Produces: `renderFallback({ summaries, date }) -> string`

- [ ] **Step 1: Write the fallback test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFallback } from '../scripts/render-fallback.mjs';
import { validateDigest } from '../scripts/compose-digest.mjs';

const includedSummary = (id, type) => ({ id, type, author: `Author ${id}`, title: type === 'x' ? '' : `Title ${id}`, include: true, role: 'Builder', judgment: `Judgment ${id}`, facts: ['fact'], english: 'English detail.', chinese: '中文细节。', themes: ['agents'], url: `https://source.test/${id}` });

test('fallback renders valid bilingual Markdown and omits excluded records', () => {
  const summaries = [includedSummary('a', 'x'), { ...includedSummary('b', 'blog'), include: false }];
  const markdown = renderFallback({ summaries, date: '2026-07-14' });
  assert.deepEqual(validateDigest(markdown, summaries), []);
  assert.match(markdown, /https:\/\/source.test\/a/);
  assert.doesNotMatch(markdown, /https:\/\/source.test\/b/);
});
```

- [ ] **Step 2: Verify failure**

Run: `npx --yes node@24 --test test/render-fallback.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement a type-grouped renderer**

Render the exact level-one title, group included summaries into X / TWITTER, OFFICIAL BLOGS, and PODCASTS sections, and render for each record: a level-two title, italic role, bold judgment, English paragraph, Chinese paragraph, and source link. Escape heading newlines, omit empty sections, and append the exact Follow Builders footer.

```js
const LABELS = { x: 'X / TWITTER', blog: 'OFFICIAL BLOGS', podcast: 'PODCASTS' };
const cleanHeading = value => String(value || '').replace(/[\r\n]+/g, ' ').trim();

export function renderFallback({ summaries, date }) {
  const displayDate = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const lines = [`# AI Builders Digest — ${displayDate}`, ''];
  for (const type of ['x', 'blog', 'podcast']) {
    const records = summaries.filter(value => value.include && value.type === type);
    if (!records.length) continue;
    lines.push(`### ${LABELS[type]}`, '');
    for (const record of records) {
      const heading = type === 'x' ? record.author : `${record.author} — ${record.title}`;
      lines.push(`## ${cleanHeading(heading)}`, '', `*${cleanHeading(record.role)}*`, '', `**${record.judgment.trim()}**`, '', record.english.trim(), '', record.chinese.trim(), '', `→ [原文](${record.url})`, '');
    }
  }
  lines.push('Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders');
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx --yes node@24 --test test/render-fallback.test.mjs`

Expected: the fallback test passes through the same validator used by global composition.

```bash
git add scripts/render-fallback.mjs test/render-fallback.test.mjs
git commit -m "feat: render digest without model fallback"
```

### Task 8: Orchestrate the pipeline, report metrics, and retain legacy rollback

**Files:**
- Create: `scripts/digest-pipeline.mjs`
- Create: `scripts/remix-legacy.mjs`
- Modify: `scripts/remix.mjs`
- Modify: `test/remix.test.mjs`
- Create: `test/digest-pipeline.test.mjs`
- Create: `test/fixtures/feed.json`

**Interfaces:**
- Produces: `runDigestPipeline({ feed, prompts, chat, cacheDir, date, reportPath, summarize, compose, fallback }) -> { markdown, report }`; the final three arguments default to production functions and are injectable in integration tests
- Produces: `runLegacy({ feedJson, apiKey, prompts }) -> string`
- CLI selector: `DIGEST_PIPELINE=streaming|legacy`, default `streaming`

- [ ] **Step 1: Add the integration fixture and failing pipeline tests**

The fixture must contain two tweet items, one blog item, and one podcast item with short deterministic text and unique URLs. Use production normalization with injected stage functions:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runDigestPipeline } from '../scripts/digest-pipeline.mjs';
import { DigestCompositionError } from '../scripts/compose-digest.mjs';
import { renderFallback } from '../scripts/render-fallback.mjs';

const feed = JSON.parse(await readFile(new URL('./fixtures/feed.json', import.meta.url), 'utf-8'));
const summary = (id, type, url) => ({ id, type, author: `Author ${id}`, title: type === 'x' ? '' : `Title ${id}`, include: true, role: 'Builder', judgment: `Judgment ${id}`, facts: ['fact'], english: 'English detail.', chinese: '中文细节。', themes: ['agents'], url });

test('pipeline records composed mode and skipped items', async () => {
  const summaries = [summary('tweet-1', 'x', 'https://source.test/tweet-1'), summary('blog-1', 'blog', 'https://source.test/blog-1')];
  const skipped = [{ id: 'podcast-1', url: 'https://source.test/podcast-1', reason: 'IdleTimeout' }];
  const expected = renderFallback({ summaries, date: '2026-07-14' });
  const result = await runDigestPipeline({
    feed, prompts: {}, chat: async () => { throw new Error('chat must be handled by injected stages'); }, cacheDir: '.unused', date: '2026-07-14', reportPath: null,
    summarize: async () => ({ summaries, skipped, metrics: { cacheHits: 0, batches: 1 } }),
    compose: async () => ({ markdown: expected, metrics: { totalMs: 1 }, repaired: false }),
    fallback: renderFallback
  });
  assert.equal(result.report.mode, 'composed');
  assert.deepEqual(result.report.summaries.skipped, skipped);
  assert.match(result.markdown, /tweet-1/);
  assert.doesNotMatch(result.markdown, /podcast-1/);
});

test('pipeline composes all normalized fixture items', async () => {
  const summarize = async ({ items }) => ({
    summaries: items.map(value => summary(value.id, value.type, value.url)),
    skipped: [],
    metrics: { cacheHits: 0, batches: 3 }
  });
  const compose = async ({ summaries }) => ({ markdown: renderFallback({ summaries, date: '2026-07-14' }), metrics: { totalMs: 1 }, repaired: false });
  const result = await runDigestPipeline({ feed, prompts: {}, chat: async () => {}, cacheDir: '.unused', date: '2026-07-14', reportPath: null, summarize, compose, fallback: renderFallback });
  assert.equal(result.report.summaries.valid, 4);
  assert.equal(result.report.mode, 'composed');
});

test('pipeline falls back only for DigestCompositionError', async () => {
  const summaries = [summary('tweet-1', 'x', 'https://source.test/tweet-1')];
  const result = await runDigestPipeline({
    feed, prompts: {}, chat: async () => {}, cacheDir: '.unused', date: '2026-07-14', reportPath: null,
    summarize: async () => ({ summaries, skipped: [], metrics: {} }),
    compose: async () => { throw new DigestCompositionError(['bad heading'], '# bad'); },
    fallback: renderFallback
  });
  assert.equal(result.report.mode, 'fallback');
  assert.match(result.markdown, /https:\/\/source.test\/tweet-1/);
});

test('pipeline rejects an empty valid-summary set', async () => {
  await assert.rejects(() => runDigestPipeline({
    feed, prompts: {}, chat: async () => {}, cacheDir: '.unused', date: '2026-07-14', reportPath: null,
    summarize: async () => ({ summaries: [], skipped: [], metrics: {} }),
    compose: async () => { throw new Error('must not compose'); }, fallback: renderFallback
  }), /no valid summaries/);
});
```

These tests cover normal composition, a permanently skipped item, deterministic fallback, and rejection of an empty valid-summary set.

- [ ] **Step 2: Run and verify failure**

Run: `npx --yes node@24 --test test/digest-pipeline.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Preserve the current implementation as legacy**

Move the current request construction, 300-second timeout, two-attempt retry, and `buildSystemPrompt` into `remix-legacy.mjs`. Export `runLegacy` and update the existing unit tests to import legacy behavior from that file. Do not change legacy behavior during this task.

- [ ] **Step 4: Implement pipeline orchestration and report writing**

`runDigestPipeline` must:

1. Call `normalizeFeed`.
2. Call `summarizeItems` with repository prompts and the cache directory.
3. Throw when no valid summaries remain.
4. Call `composeDigest`; catch only `DigestCompositionError` and use `renderFallback`.
5. Assemble a report containing feed sizes, normalized count, cache hits, batch metrics, skipped records, composition metrics, final mode, and final validation issues.
6. Write the report atomically in a `finally` block so a failing run still leaves diagnostics.

Use this result shape:

```js
return {
  markdown,
  report: {
    startedAt, finishedAt: new Date().toISOString(), mode,
    input: { totalChars: JSON.stringify(feed).length, normalizedItems: items.length },
    summaries: { valid: summaries.length, skipped, ...metrics },
    composition: compositionMetrics
  }
};
```

- [ ] **Step 5: Replace `remix.mjs` with the CLI dispatcher**

Load `.env`, the feed file, and local prompts. When `DIGEST_PIPELINE === 'legacy'`, call `runLegacy`; otherwise construct `streamChat` with the GLM endpoint/model/API key and call `runDigestPipeline`. Write `digests/<date>.md` only after the selected path returns a non-empty string. Default cache and report paths are `.digest-cache` and `artifacts/remix-report.json`.

- [ ] **Step 6: Verify and commit**

Run: `npx --yes node@24 --test test/remix.test.mjs test/digest-pipeline.test.mjs`

Expected: legacy regression tests and all four pipeline integration cases pass.

```bash
git add scripts/digest-pipeline.mjs scripts/remix-legacy.mjs scripts/remix.mjs test/remix.test.mjs test/digest-pipeline.test.mjs test/fixtures/feed.json
git commit -m "feat: orchestrate streaming digest pipeline"
```

### Task 9: Persist cache and diagnostics in GitHub Actions

**Files:**
- Modify: `.github/workflows/daily.yml`
- Modify: `.gitignore`
- Modify: `test/workflow.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Cache directory: `.digest-cache/`
- Diagnostic artifact: `artifacts/remix-report.json`
- Workflow selector: `DIGEST_PIPELINE: streaming`

- [ ] **Step 1: Extend the workflow test before editing YAML**

Add assertions for all of these maintained action majors and paths:

```js
assert.match(workflow, /actions\/cache\/restore@v6/);
assert.match(workflow, /actions\/cache\/save@v6/);
assert.match(workflow, /actions\/upload-artifact@v7/);
assert.match(workflow, /DIGEST_PIPELINE:\s*streaming/);
assert.match(workflow, /\.digest-cache/);
assert.match(workflow, /artifacts\/remix-report\.json/);
assert.match(workflow, /if:\s*always\(\)/);
```

- [ ] **Step 2: Run the workflow test and verify it fails**

Run: `npx --yes node@24 --test test/workflow.test.mjs`

Expected: FAIL because cache, artifact, and selector steps are absent.

- [ ] **Step 3: Update ignores and workflow**

Add `.digest-cache/` and `artifacts/` to `.gitignore`. In `daily.yml`, restore the cache after `npm ci`:

```yaml
      - name: Restore digest cache
        uses: actions/cache/restore@v6
        with:
          path: .digest-cache
          key: digest-v1-${{ runner.os }}-${{ hashFiles('prompts/*.md') }}-${{ github.run_id }}
          restore-keys: |
            digest-v1-${{ runner.os }}-${{ hashFiles('prompts/*.md') }}-
```

Set `DIGEST_PIPELINE: streaming` on the Remix step. Immediately after it, add these steps so they execute even if later work fails:

```yaml
      - name: Save digest cache
        if: always()
        uses: actions/cache/save@v6
        with:
          path: .digest-cache
          key: digest-v1-${{ runner.os }}-${{ hashFiles('prompts/*.md') }}-${{ github.run_id }}

      - name: Upload remix report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: remix-report-${{ github.run_id }}
          path: artifacts/remix-report.json
          if-no-files-found: warn
```

- [ ] **Step 4: Document operation and rollback**

In `README.md`, document the streaming/batched stages, cache directory, artifact report, skipped-item policy, and the exact rollback action: set `DIGEST_PIPELINE: legacy` in `daily.yml` and rerun `workflow_dispatch`.

- [ ] **Step 5: Verify and commit**

Run: `npx --yes node@24 --test test/workflow.test.mjs`

Expected: workflow assertions pass.

```bash
git add .github/workflows/daily.yml .gitignore test/workflow.test.mjs README.md
git commit -m "ci: persist digest cache and reports"
```

### Task 10: Run complete verification and real rollout

**Files:**
- Verify all modified files
- Update: PR description/comment with evidence only; no additional source file is required

**Interfaces:**
- Real acceptance run: `workflow_dispatch` on the implementation branch
- Success evidence: completed digest, site build, Pages deploy, report artifact, no Node 20 warning

- [ ] **Step 1: Run the complete Node 24 test suite**

Run: `npx --yes node@24 --test`

Expected: all unit and integration tests pass with zero failures.

- [ ] **Step 2: Run deterministic feed fixture and site build**

Run the deterministic pipeline integration test, then build the site:

```bash
npx --yes node@24 --test test/digest-pipeline.test.mjs
npx --yes node@24 scripts/build-site.mjs
```

Expected: the pipeline fixture produces valid Markdown and the site build exits 0.

- [ ] **Step 3: Check repository hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation files are modified before the final commit/push.

- [ ] **Step 4: Push and trigger one real branch run**

```powershell
git push
gh workflow run daily.yml --ref agent/harden-daily-digest
Start-Sleep -Seconds 3
$runId = (gh run list --workflow daily.yml --branch agent/harden-daily-digest --event workflow_dispatch --limit 1 --json databaseId | ConvertFrom-Json)[0].databaseId
gh run watch $runId --exit-status
```

- [ ] **Step 5: Inspect the completed run and artifact**

Run:

```powershell
gh run view $runId --json status,conclusion,url,jobs
gh run view $runId --log
$artifactDir = Join-Path $env:TEMP "remix-report-$runId"
gh run download $runId --name "remix-report-$runId" --dir $artifactDir
Get-Content -Raw (Join-Path $artifactDir 'remix-report.json')
```

Expected: `conclusion: success`; checkout/setup-node, feed preparation, streaming summarization, cache save, site build, and Pages deploy succeed. The log shows Node 24 and contains no Node 20 deprecation annotation. The downloaded report records batch sizes, cache hits, timings, skipped items, and `mode`.

- [ ] **Step 6: Record rollout evidence and retain the rollback flag**

Add a PR comment containing the run URL, report mode, batch count, cache hits, skipped count, and total GLM time. Do not remove `DIGEST_PIPELINE=legacy` until two additional scheduled or manual real runs also succeed.

```powershell
$report = Get-Content -Raw (Join-Path $artifactDir 'remix-report.json') | ConvertFrom-Json
$runUrl = (gh run view $runId --json url | ConvertFrom-Json).url
$comment = "Validation run: $runUrl`n`nMode: $($report.mode)`nBatches: $($report.summaries.batches)`nCache hits: $($report.summaries.cacheHits)`nSkipped: $($report.summaries.skipped.Count)`nTotal GLM ms: $($report.summaries.totalGlmMs)"
gh pr comment 1 --repo to-real/ai-builder-digest --body $comment
```
