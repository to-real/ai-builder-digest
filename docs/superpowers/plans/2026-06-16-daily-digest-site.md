# AI Builders 每日日报网页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个公开的 AI Builder 日报静态网站，每天由 GitHub Actions 自动抓取 feed、用智谱 GLM remix 成双语 digest、生成静态页、部署到 GitHub Pages，并保留历史归档。

**Architecture:** GitHub Actions 定时 workflow（北京时间 08:00）跑三个脚本——`prepare-digest.js`（复用 follow-builders，抓 feed 出 JSON）→ `remix.mjs`（调智谱 GLM，出双语 markdown）→ `build-site.mjs`（markdown 转 kami 风格静态站）。生成的 `digests/YYYY-MM-DD.md` commit 回仓库作归档，`site/` 作为 artifact 部署到 Pages。本地邮件推送（已配的 follow-builders）保持不动。

**Tech Stack:** Node.js 20 (ESM)、`marked`（md→html）、`dotenv` + `proper-lockfile`（prepare-digest 依赖）、`node:test`（内置测试）、智谱 GLM-4.6 API（OpenAI 兼容）、GitHub Actions + Pages。

**Repo 根目录：** `E:\ai-builder-digest\`（已含 `docs/`，spec 与本计划都在里面）。

**前置确认（开始前必须有）：**
- 智谱 BigModel API key（`ZHIPU_API_KEY`，用户已有）
- GitHub 账号、`gh` CLI 已登录（`gh auth status` 能通过；否则手动建 repo/secret）
- 本机已装 Node 20+、git

---

## File Structure

```
ai-builder-digest/
├─ .github/workflows/daily.yml      # Task 7：定时 workflow
├─ scripts/
│  ├─ prepare-digest.js             # Task 2：从 follow-builders 拷贝，不改
│  ├─ remix.mjs                     # Task 3：调 GLM remix（含可测 export）
│  └─ build-site.mjs                # Task 5：markdown → 静态站（含可测 export）
├─ prompts/                         # Task 2：从 follow-builders 拷贝
│  ├─ digest-intro.md
│  ├─ summarize-podcast.md
│  ├─ summarize-tweets.md
│  └─ translate.md
├─ templates/
│  ├─ layout.html                   # Task 4：页面骨架（公共）
│  └─ style.css                     # Task 4：kami 设计 token
├─ digests/                         # 运行时生成，会 commit（归档）
├─ site/                            # 构建产物，gitignore，Actions 上传 artifact
├─ test/
│  ├─ remix.test.mjs                # Task 3
│  └─ build-site.test.mjs           # Task 5
├─ .gitignore                       # Task 1
├─ package.json                     # Task 1
└─ README.md                        # Task 9
```

文件职责边界：
- `remix.mjs` 只管「feed JSON + prompts → GLM → markdown」，export `remix(feedStr, apiKey, prompts)` 供测试，`main()` 处理 CLI。
- `build-site.mjs` 只管「digests/*.md → site/*.html」，export `buildSite({digestsDir, outDir})` 供测试，模板与 CSS 全在 `templates/`。
- `templates/` 是纯静态资源，build-site 读取并内联到生成的 HTML。

---

## Task 1: Repo 初始化与项目骨架

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "ai-builder-digest",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "AI Builders daily digest static site — auto-generated, deployed to GitHub Pages.",
  "scripts": {
    "prepare": "node scripts/prepare-digest.js",
    "remix": "node scripts/remix.mjs",
    "build": "node scripts/build-site.mjs",
    "test": "node --test"
  },
  "dependencies": {
    "dotenv": "^16.4.0",
    "marked": "^12.0.0",
    "proper-lockfile": "^4.1.0"
  }
}
```

- [ ] **Step 2: 写 `.gitignore`**

```
node_modules/
.env
feed.json
site/
*.log
.DS_Store
```

说明：`digests/` **不**忽略（要作为内容归档提交）；`site/` 忽略（构建产物，由 Actions 上传 artifact 部署）。

- [ ] **Step 3: 初始化 git 并首次提交**

Run:
```bash
cd /e/ai-builder-digest
git init -b main
git add package.json .gitignore docs/
git commit -m "chore: init repo with spec and plan"
```
Expected: 首个 commit 生成。

- [ ] **Step 4: 安装依赖**

Run: `npm install`
Expected: `node_modules/` 生成，`dotenv`、`marked`、`proper-lockfile` 就位。

---

## Task 2: 拷贝 prepare-digest.js 与 prompts

**Files:**
- Create: `scripts/prepare-digest.js`（从 follow-builders 拷贝）
- Create: `prompts/digest-intro.md`、`prompts/summarize-podcast.md`、`prompts/summarize-tweets.md`、`prompts/translate.md`

- [ ] **Step 1: 拷贝 prepare-digest.js**

Run:
```bash
cp ~/.claude/skills/follow-builders/scripts/prepare-digest.js /e/ai-builder-digest/scripts/prepare-digest.js
```

- [ ] **Step 2: 拷贝 prompts**

Run:
```bash
mkdir -p /e/ai-builder-digest/prompts
cp ~/.claude/skills/follow-builders/prompts/{digest-intro,summarize-podcast,summarize-tweets,summarize-blogs,translate}.md /e/ai-builder-digest/prompts/
```
（`summarize-blogs.md` 一并拷来，当前 blogs 为空但保留以备扩展。）

- [ ] **Step 3: 通读 prepare-digest.js，确认 state 依赖**

Read `scripts/prepare-digest.js` 全文。确认两点：
1. 它的输出是否写到 stdout（我们要 `> feed.json`）。若它直接写文件而非 stdout，记下输出路径，Task 7 workflow 里改为读该路径。
2. 它是否依赖 `~/.follow-builders/state-feed.json` 做去重。若是，记下该文件名——Task 7 的 workflow 需要把这个 state 文件也 commit 回仓库，使其跨 run 持久（否则每次 Actions 全新 checkout，可能输出重复内容）。

把结论写进一行注释追加到 `scripts/prepare-digest.js` 顶部（不改逻辑），例如：
```js
// NOTE: outputs JSON to stdout; reads state from ~/.follow-builders/state-feed.json (commit this in CI for cross-run dedup)
```

- [ ] **Step 4: 本地冒烟测试 prepare-digest 能跑**

Run:
```bash
cd /e/ai-builder-digest
mkdir -p ~/.follow-builders
echo '{"language":"bilingual","delivery":{"method":"stdout"}}' > ~/.follow-builders/config.json
node scripts/prepare-digest.js > feed.json 2>/dev/null
head -c 300 feed.json
```
Expected: `feed.json` 生成，开头是合法 JSON（含 `status`/`podcasts`/`x`/`prompts`/`stats` 等字段）。若报错，按 Step 3 记下的依赖排查。

- [ ] **Step 5: 提交**

```bash
git add scripts/prepare-digest.js prompts/
git commit -m "feat: vendor prepare-digest.js and prompts from follow-builders"
```

---

## Task 3: remix.mjs —— GLM remix 脚本（TDD）

**Files:**
- Create: `scripts/remix.mjs`
- Test: `test/remix.test.mjs`

- [ ] **Step 1: 写失败测试 `test/remix.test.mjs`**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，提示找不到 `remix` / `buildSystemPrompt` 导出。

- [ ] **Step 3: 写 `scripts/remix.mjs`**

```js
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'glm-4.6';

const PROMPT_FILES = ['digest-intro', 'summarize-podcast', 'summarize-tweets', 'summarize-blogs', 'translate'];

export async function loadPrompts(dir = join(ROOT, 'prompts')) {
  const out = {};
  for (const n of PROMPT_FILES) {
    out[n] = await readFile(join(dir, `${n}.md`), 'utf-8');
  }
  return out;
}

export function buildSystemPrompt(prompts) {
  return [
    'You remix AI builder content (podcasts + X/Twitter posts + blog posts) into a bilingual digest.',
    '',
    '=== OVERALL FRAMING ===', prompts['digest-intro'],
    '', '=== HOW TO SUMMARIZE PODCASTS ===', prompts['summarize-podcast'],
    '', '=== HOW TO SUMMARIZE TWEETS ===', prompts['summarize-tweets'],
    '', '=== HOW TO SUMMARIZE BLOGS ===', prompts['summarize-blogs'],
    '', '=== HOW TO TRANSLATE EN->ZH ===', prompts['translate'],
    '',
    'OUTPUT FORMAT: bilingual. For each item output the English summary paragraph, then IMMEDIATELY the Chinese translation paragraph right below it, then move to the next item. Interleave per item — do NOT output all English then all Chinese.',
    'OUTPUT: pure markdown only. No preamble, no code fences wrapping the whole output.',
    'HARD RULES: Use ONLY content present in the user-message JSON. Never fabricate. Every tweet, podcast, and blog item MUST include its original url. Use the bio field for builder roles; never guess titles. Today\'s date is in the JSON.'
  ].join('\n');
}

export async function remix(feedJsonStr, apiKey, prompts) {
  const system = buildSystemPrompt(prompts);
  const res = await fetch(GLM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [ { role: 'system', content: system }, { role: 'user', content: feedJsonStr } ],
      temperature: 0.5,
      stream: false
    })
  });
  if (!res.ok) throw new Error(`GLM API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function main() {
  loadEnv({ path: join(ROOT, '.env') });
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error('ZHIPU_API_KEY not set (put it in .env or env)');
  const feedPath = process.argv[2] || join(ROOT, 'feed.json');
  const feed = await readFile(feedPath, 'utf-8');
  const prompts = await loadPrompts();
  const markdown = await remix(feed, apiKey, prompts);
  const date = new Date().toISOString().slice(0, 10);
  await mkdir(join(ROOT, 'digests'), { recursive: true });
  await writeFile(join(ROOT, 'digests', `${date}.md`), markdown, 'utf-8');
  console.log(`wrote digests/${date}.md (${markdown.length} chars)`);
}

const invokedDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirect) main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（3 个测试全过）。

- [ ] **Step 5: 本地真实跑一次（消耗少量 GLM token）**

Run:
```bash
cd /e/ai-builder-digest
echo "ZHIPU_API_KEY=<粘贴用户的智谱key>" > .env
node scripts/remix.mjs feed.json
head -c 400 digests/$(date +%F).md
```
Expected: `digests/YYYY-MM-DD.md` 生成，内容是双语 markdown（英文段 + 紧跟中文段）。确认每条带 URL、无编造。删掉 `.env`（不入库）。

- [ ] **Step 6: 提交**

```bash
git add scripts/remix.mjs test/remix.test.mjs
git commit -m "feat: add remix.mjs — GLM-powered bilingual digest"
```

---

## Task 4: kami 风格模板与 CSS

**Files:**
- Create: `templates/style.css`
- Create: `templates/layout.html`

- [ ] **Step 1: 写 `templates/style.css`（kami 设计 token，屏幕版）**

```css
:root {
  --parchment: #f5f4ed;
  --ivory: #faf9f5;
  --near-black: #141413;
  --dark-warm: #3d3d3a;
  --olive: #504e49;
  --stone: #6b6a64;
  --brand: #1B365D;
  --border: #e8e6dc;
  --border-soft: #e5e3d8;
  --tag-bg: #E4ECF5;
  --serif: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", Georgia, serif;
  --sans: var(--serif);
}

@media (prefers-color-scheme: dark) {
  :root {
    --parchment: #1a1a18;
    --ivory: #222220;
    --near-black: #ece6d8;
    --dark-warm: #cfcabd;
    --olive: #b3b0a4;
    --stone: #9a988e;
    --brand: #8fb3d8;
    --border: #33312b;
    --border-soft: #2c2a25;
    --tag-bg: #1f2d3d;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--parchment); }
body {
  color: var(--near-black);
  background: var(--parchment);
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.75;
  letter-spacing: 0.2px;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 720px; margin: 0 auto; padding: 0 20px; }

.site-head {
  border-bottom: 1px solid var(--border);
  padding: 20px 0;
  margin-bottom: 36px;
}
.site-head .wrap { display: flex; justify-content: space-between; align-items: baseline; }
.brand {
  font-size: 20px; font-weight: 500;
  color: var(--near-black); text-decoration: none;
  letter-spacing: 0.3px;
}
.brand .brand-mark { color: var(--brand); }
.site-head nav a {
  color: var(--brand); text-decoration: none;
  font-size: 14px; letter-spacing: 0.5px;
}
.site-head nav a:hover { text-decoration: underline; }

.site-foot {
  border-top: 1px solid var(--border);
  padding: 28px 0 40px;
  margin-top: 56px;
  color: var(--stone);
  font-size: 13px;
}
.site-foot a { color: var(--brand); }

h1, h2, h3, h4 { font-weight: 500; line-height: 1.3; color: var(--near-black); }
h1 {
  font-size: 28px; margin: 0 0 6px;
  padding-left: 13px; border-left: 3px solid var(--brand);
}
h2 {
  font-size: 22px; margin: 34px 0 12px;
  padding-left: 13px; border-left: 3px solid var(--brand);
}
h3 { font-size: 18px; margin: 24px 0 8px; color: var(--dark-warm); }
h4 { font-size: 16px; margin: 18px 0 6px; color: var(--dark-warm); }

p { margin: 0 0 14px; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 500; color: var(--dark-warm); }
em { color: var(--olive); }
hr { border: none; border-top: 1px solid var(--border); margin: 30px 0; }
ul, ol { margin: 0 0 14px; padding-left: 22px; }
li { margin-bottom: 4px; }
code {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.88em; background: var(--ivory);
  padding: 1px 5px; border-radius: 3px;
}
blockquote {
  border-left: 3px solid var(--border);
  padding-left: 14px; color: var(--stone);
  margin: 0 0 14px;
}

.eyebrow {
  color: var(--brand); font-size: 12px;
  letter-spacing: 1.6px; text-transform: uppercase;
  font-weight: 500; margin-bottom: 4px;
}
.post-meta { color: var(--stone); font-size: 14px; margin-bottom: 28px; }

.archive-list { list-style: none; padding: 0; }
.archive-list li { padding: 11px 0; border-bottom: 1px dotted var(--border); }
.archive-list a { display: flex; justify-content: space-between; align-items: baseline; color: var(--near-black); }
.archive-list a:hover { text-decoration: none; }
.archive-list .date { color: var(--brand); font-weight: 500; font-variant-numeric: tabular-nums; }
.archive-list .label { color: var(--stone); font-size: 13px; }

.intro-note {
  background: var(--ivory); border: 1px solid var(--border-soft);
  border-radius: 4px; padding: 14px 18px; margin-bottom: 28px;
  color: var(--olive); font-size: 15px;
}
```

- [ ] **Step 2: 写 `templates/layout.html`（公共骨架，占位符 `{{...}}`）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<meta name="description" content="{{description}}">
<style>
{{style}}
</style>
</head>
<body>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="index.html"><span class="brand-mark">·</span> AI Builders Daily</a>
    <nav><a href="archive.html">归档</a></nav>
  </div>
</header>
<main class="wrap">
{{main}}
</main>
<footer class="site-foot">
  <div class="wrap">
    每日自动生成 · 数据来自 <a href="https://github.com/zarazhangrui/follow-builders">follow-builders</a> · 双语对照
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 3: 提交**

```bash
git add templates/
git commit -m "feat: add kami-style layout and stylesheet"
```

---

## Task 5: build-site.mjs —— 静态站生成（TDD）

**Files:**
- Create: `scripts/build-site.mjs`
- Test: `test/build-site.test.mjs`

- [ ] **Step 1: 写失败测试 `test/build-site.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { rm, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { buildSite, slugDate } from '../scripts/build-site.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIGESTS = join(here, 'tmp-digests');
const OUT = join(here, 'tmp-site');

async function fresh() {
  await rm(DIGESTS, { recursive: true, force: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(DIGESTS, { recursive: true });
}

test('slugDate validates YYYY-MM-DD', () => {
  assert.equal(slugDate('2026-06-16.md'), '2026-06-16');
  assert.equal(slugDate('not-a-date.md'), null);
});

test('buildSite writes index/archive/per-post, latest on index', async () => {
  await fresh();
  await writeFile(join(DIGESTS, '2026-06-15.md'), '# 2026-06-15\n\nolder post body');
  await writeFile(join(DIGESTS, '2026-06-16.md'), '# 2026-06-16\n\nnewer post body');
  const res = await buildSite({ digestsDir: DIGESTS, outDir: OUT });
  assert.equal(res.posts, 2);

  const files = await readdir(OUT);
  for (const f of ['index.html', 'archive.html', '2026-06-15.html', '2026-06-16.html']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  const index = await readFile(join(OUT, 'index.html'), 'utf-8');
  assert.match(index, /newer post body/);          // latest first
  assert.doesNotMatch(index, /older post body/);   // only latest on index
  const archive = await readFile(join(OUT, 'archive.html'), 'utf-8');
  assert.match(archive, /2026-06-15/);
  assert.match(archive, /2026-06-16/);
  await rm(DIGESTS, { recursive: true, force: true });
  await rm(OUT, { recursive: true, force: true });
});

test('buildSite with empty digests still writes index + archive', async () => {
  await fresh();
  const res = await buildSite({ digestsDir: DIGESTS, outDir: OUT });
  assert.equal(res.posts, 0);
  const index = await readFile(join(OUT, 'index.html'), 'utf-8');
  assert.match(index, /暂无/i);
  await rm(DIGESTS, { recursive: true, force: true });
  await rm(OUT, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `buildSite` / `slugDate`。

- [ ] **Step 3: 写 `scripts/build-site.mjs`**

```js
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function slugDate(filename) {
  const stem = basename(filename).replace(/\.md$/i, '');
  return DATE_RE.test(stem) ? stem : null;
}

async function loadPosts(digestsDir) {
  if (!existsSync(digestsDir)) return [];
  const files = await readdir(digestsDir);
  const posts = [];
  for (const f of files) {
    const date = slugDate(f);
    if (!date) continue;
    const md = await readFile(join(digestsDir, f), 'utf-8');
    const html = await marked.parse(md);
    const firstH1 = md.match(/^#\s+(.+)$/m);
    posts.push({ date, md, html, title: firstH1 ? firstH1[1].trim() : `AI Builders Digest — ${date}` });
  }
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

function render(tpl, vars) {
  return tpl.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (vars[k] ?? ''));
}

function archiveItemsHtml(posts) {
  return posts.map(p =>
    `<li><a href="${p.date}.html"><span class="date">${p.date}</span><span class="label">${escapeHtml(p.title)}</span></a></li>`
  ).join('\n');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function buildSite(opts = {}) {
  const digestsDir = opts.digestsDir ?? join(ROOT, 'digests');
  const outDir = opts.outDir ?? join(ROOT, 'site');
  const templatesDir = join(ROOT, 'templates');

  const [style, layout] = await Promise.all([
    readFile(join(templatesDir, 'style.css'), 'utf-8'),
    readFile(join(templatesDir, 'layout.html'), 'utf-8')
  ]);
  const posts = await loadPosts(digestsDir);
  await mkdir(outDir, { recursive: true });

  const latest = posts[0];

  // index.html — latest full digest
  const indexMain = latest
    ? `<p class="eyebrow">最新一期</p><h1>${escapeHtml(latest.title)}</h1><p class="post-meta">${latest.date} · 双语对照</p><div class="digest-body">${latest.html}</div>`
    : `<h1>暂无日报</h1><p class="post-meta">第一期将在下次自动生成时发布。</p>`;
  await writeFile(join(outDir, 'index.html'),
    render(layout, { style, title: latest ? latest.title : 'AI Builders Daily', description: '每日 AI 建造者动态，双语对照', main: indexMain }));

  // archive.html
  const archiveMain = posts.length
    ? `<p class="eyebrow">归档</p><h1>历史日报</h1><ul class="archive-list">${archiveItemsHtml(posts)}</ul>`
    : `<h1>暂无历史</h1>`;
  await writeFile(join(outDir, 'archive.html'),
    render(layout, { style, title: '归档 · AI Builders Daily', description: '历史日报归档', main: archiveMain }));

  // per-post pages
  for (const p of posts) {
    const main = `<p class="eyebrow">日报</p><h1>${escapeHtml(p.title)}</h1><p class="post-meta">${p.date} · <a href="index.html">回最新</a> · <a href="archive.html">查归档</a></p><div class="digest-body">${p.html}</div>`;
    await writeFile(join(outDir, `${p.date}.html`),
      render(layout, { style, title: `${p.title} · AI Builders Daily`, description: p.title, main }));
  }

  return { posts: posts.length };
}

const invokedDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirect) {
  buildSite().then(r => console.log(`built ${r.posts} posts into site/`)).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（remix 3 个 + build-site 3 个，全过）。

- [ ] **Step 5: 本地真实构建**

Run:
```bash
cd /e/ai-builder-digest
node scripts/build-site.mjs
ls site/
```
Expected: `site/index.html`、`site/archive.html`、`site/YYYY-MM-DD.html` 生成（前提是 Task 3 Step 5 已产出 digests/）。

- [ ] **Step 6: 提交**

```bash
git add scripts/build-site.mjs test/build-site.test.mjs
git commit -m "feat: add build-site.mjs — markdown to kami-style static site"
```

---

## Task 6: 本地端到端验证

**Files:** 无新增（验证现有链路）

- [ ] **Step 1: 全链路本地跑一遍**

Run:
```bash
cd /e/ai-builder-digest
node scripts/prepare-digest.js > feed.json 2>/dev/null
echo "ZHIPU_API_KEY=<key>" > .env
node scripts/remix.mjs feed.json
node scripts/build-site.mjs
rm .env
```
Expected: `digests/YYYY-MM-DD.md` 更新，`site/` 重新生成。

- [ ] **Step 2: 本地起静态服务器预览**

Run:
```bash
cd /e/ai-builder-digest/site && python -m http.server 8000
```
浏览器打开 `http://localhost:8000`。检查：
- 暖羊皮纸底、墨蓝竖条标题（kami 风格到位）
- 双语逐段对照、每条带原文链接
- 点「归档」能进列表、点列表项能进单期
- 深色模式下不刺眼（系统切深色）

若有渲染问题，回 Task 4/5 修模板或 CSS，重跑 build。Ctrl-C 停服务器。

- [ ] **Step 3: 跑全量测试确认绿**

Run: `cd /e/ai-builder-digest && npm test`
Expected: 全部 PASS。

- [ ] **Step 4: 提交（若期间改了模板/脚本）**

```bash
git add -A
git status   # 确认没有 .env / feed.json / site/ 被加进来
git commit -m "chore: local e2e verified" || echo "nothing to commit"
```

---

## Task 7: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/daily.yml`

- [ ] **Step 1: 写 `.github/workflows/daily.yml`**

```yaml
name: Daily Digest

on:
  schedule:
    - cron: "0 0 * * *"   # UTC 00:00 = Beijing 08:00
  workflow_dispatch:       # 允许手动触发

permissions:
  contents: write     # commit digests back
  pages: write
  id-token: write     # deploy-pages

concurrency:
  group: daily-digest
  cancel-in-progress: false

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Prepare feed
        run: |
          mkdir -p "$HOME/.follow-builders"
          printf '{"language":"bilingual","delivery":{"method":"stdout"}}' > "$HOME/.follow-builders/config.json"
          node scripts/prepare-digest.js > feed.json

      - name: Remix with GLM
        env:
          ZHIPU_API_KEY: ${{ secrets.ZHIPU_API_KEY }}
        run: node scripts/remix.mjs feed.json

      - name: Build site
        run: node scripts/build-site.mjs

      - name: Commit new digest
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add digests/
          git commit -m "digest: $(date -u +%F)" || echo "no new digest to commit"
          git push

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload site artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: site

      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
```

> **关于 state 持久化**：若 Task 2 Step 3 发现 `prepare-digest.js` 依赖 `~/.follow-builders/state-feed.json` 做去重，把该文件纳入仓库管理（`git add` 一个仓库内的 state 副本），并在 workflow 里 Prepare feed 前后做 `cp repo-state.json ~/.follow-builders/state-feed.json` 与回写+commit。MVP 若无此依赖则跳过。

- [ ] **Step 2: 提交**

```bash
cd /e/ai-builder-digest
git add .github/workflows/daily.yml
git commit -m "ci: add daily digest workflow (prepare → remix → build → deploy)"
```

---

## Task 8: 创建 GitHub repo、配置 Secret、首次部署

**Files:** 无（外部操作）

- [ ] **Step 1: 创建 GitHub repo 并推送**

Run（需 `gh` 已登录）:
```bash
cd /e/ai-builder-digest
gh repo create ai-builder-digest --public --source=. --remote=origin --push
```
备选（无 gh）：在 github.com 新建 public repo `ai-builder-digest`，然后：
```bash
git remote add origin git@github.com:<你的用户名>/ai-builder-digest.git
git push -u origin main
```

- [ ] **Step 2: 写入 ZHIPU_API_KEY Secret**

Run:
```bash
gh secret set ZHIPU_API_KEY --body="<粘贴用户的智谱key>"
```
备选：repo Settings → Secrets and variables → Actions → New repository secret，Name=`ZHIPU_API_KEY`，Value=key。

- [ ] **Step 3: 开启 GitHub Pages（Source = GitHub Actions）**

Run（gh）:
```bash
gh api -X PUT repos/<你的用户名>/ai-builder-digest/pages \
  -f "build_type=workflow" 2>/dev/null || echo "若失败，去 repo Settings → Pages → Source 选 'GitHub Actions'"
```
备选：repo Settings → Pages → Source 下拉选 **GitHub Actions**。

- [ ] **Step 4: 手动触发一次 workflow 验证**

Run:
```bash
gh workflow run daily.yml
sleep 5
gh run watch
```
Expected: run 变绿（all steps pass）。若有红，`gh run view --log-failed` 排查（常见：ZHIPU_API_KEY 没生效、prepare-digest 在 CI 报错、GLM 返回非 200）。

- [ ] **Step 5: 确认 Pages 上线**

Run:
```bash
gh api repos/<你的用户名>/ai-builder-digest/pages --jq '.html_url'
```
Expected: 返回 `https://<用户名>.github.io/ai-builder-digest/`。浏览器打开，看到最新一期双语日报、kami 风格、归档可点。确认 `digests/` 也被 commit（`git pull` 能看到当天 md）。

- [ ] **Step 6: 提交（若 repo 配置产生了本地变更，一般无）**

```bash
git status || true
```

---

## Task 9: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 `README.md`**

```markdown
# AI Builders Daily

每日 AI 建造者动态，双语对照。数据来自 [follow-builders](https://github.com/zarazhangrui/follow-builders)，前端采用 [kami](https://github.com/tw93/Kami) 设计语言。

## 工作方式

GitHub Actions 每天 08:00（北京时间）自动：

1. `prepare-digest.js` 抓取中心化 feed
2. `remix.mjs` 调智谱 GLM，把内容 remix 成双语 digest
3. `build-site.mjs` 生成 kami 风格静态站
4. `digests/` commit 回仓库（归档），`site/` 部署到 GitHub Pages

## 本地开发

```bash
npm install
node scripts/prepare-digest.js > feed.json
echo "ZHIPU_API_KEY=你的key" > .env
node scripts/remix.mjs feed.json
node scripts/build-site.mjs
cd site && python -m http.server 8000   # 预览
```

## 测试

```bash
npm test
```

## 配置

- `ZHIPU_API_KEY`：仓库 Secret，智谱 BigModel API key
- `digests/YYYY-MM-DD.md`：每期日报源文件（入库归档）
- `templates/`：kami 风格 layout 与 CSS
```

- [ ] **Step 2: 提交并推送**

```bash
cd /e/ai-builder-digest
git add README.md
git commit -m "docs: add README"
git push
```

---

## Self-Review 笔记（写完计划后自查）

- **Spec 覆盖**：架构/三脚本/数据流/workflow/部署/Secret/成本/邮件保留/kami 样式 → 均有对应 Task。字体授权取舍（Noto Serif SC 替代商业楷体）在 Task 4 CSS 体现。
- **类型一致**：`remix(feedJsonStr, apiKey, prompts)`、`buildSite({digestsDir, outDir})`、`slugDate(filename)` 在测试与实现中签名一致。
- **已知简化**：prepare-digest 的 state 持久化按 Task 2 Step 3 结论决定是否纳入 CI（已在 Task 7 注明分支）。
- **风险**：GLM 输出质量需 Task 3 Step 5 人工确认；双语 prompt 在 GLM 上可能需微调 repo 内 prompts 副本（不动原 skill）。
