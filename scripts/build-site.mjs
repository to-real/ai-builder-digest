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

// Post-process marked HTML: drop the duplicate digest-date <h1> (the page already
// shows the title) and tag source-link paragraphs (lines starting with →) for styling.
function enhanceHtml(html) {
  let out = html
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '')
    .replace(/<p>→\s/g, '<p class="src">→ ');
  // tag each <p> with lang (zh if it contains CJK, else en) for the EN/中文 toggle.
  // skip paragraphs that already have lang or are source-link lines.
  out = out.replace(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g, (m, attrs, inner) => {
    if (attrs && (/lang=|class="src"/.test(attrs))) return m;
    const lang = /[一-鿿]/.test(inner) ? 'zh' : 'en';
    return `<p${attrs || ''} lang="${lang}">${inner}</p>`;
  });
  // add id anchors to each <h2> (builder/theme name) for the TOC chips
  const seen = new Set();
  let n = 0;
  out = out.replace(/<h2([^>]*)>([\s\S]*?)<\/h2>/g, (m, attrs, inner) => {
    if (/\bid=/.test(attrs)) return m;
    let slug = slugify(inner);
    while (seen.has(slug)) slug = `${slugify(inner)}-${++n}`;
    seen.add(slug);
    return `<h2${attrs} id="${slug}">${inner}<button class="share" data-slug="${slug}" title="复制本条链接" aria-label="复制本条链接">🔗</button></h2>`;
  });
  // collapse the long-form PODCASTS section by default
  out = out.replace(/<h3([^>]*)>([^<]*PODCASTS[^<]*)<\/h3>([\s\S]*)$/i, (_m, h3attrs, h3text, rest) =>
    `<details class="podcast-section"><summary>🎙 ${h3text.trim()}</summary>${rest}</details>`
  );
  return out;
}

async function loadPosts(digestsDir) {
  if (!existsSync(digestsDir)) return [];
  const files = await readdir(digestsDir);
  const posts = [];
  for (const f of files) {
    const date = slugDate(f);
    if (!date) continue;
    const md = await readFile(join(digestsDir, f), 'utf-8');
    const html = enhanceHtml(await marked.parse(md));
    const firstH1 = md.match(/^#\s+(.+)$/m);
    posts.push({ date, md, html, title: firstH1 ? firstH1[1].trim() : `AI Builders Digest — ${date}` });
  }
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
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

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

function slugify(s) {
  const cleaned = s.replace(/<[^>]+>/g, '');
  return cleaned.toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SITE_URL = 'https://to-real.github.io/ai-builder-digest';

function generateRss(posts) {
  const items = posts.map(p => [
    '    <item>',
    `      <title>${escapeXml(p.title)}</title>`,
    `      <link>${SITE_URL}/${p.date}.html</link>`,
    `      <guid isPermaLink="true">${SITE_URL}/${p.date}.html</guid>`,
    `      <pubDate>${new Date(p.date + 'T00:00:00Z').toUTCString()}</pubDate>`,
    '    </item>'
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>AI Builders Digest</title>
    <link>${SITE_URL}</link>
    <description>每日双语 AI builder 日报 · by to-real</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>`;
}

function buildToc(html) {
  const matches = [...html.matchAll(/<h2[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)];
  if (matches.length < 2) return '';
  const chips = matches.map(m => `<a class="chip" href="#${m[1]}">${escapeHtml(stripTags(m[2]))}</a>`).join('');
  return `<nav class="toc"><span class="toc-label">本期阵容</span>${chips}</nav>`;
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

  const indexMain = latest
    ? `<p class="eyebrow">最新一期</p><h1>${escapeHtml(latest.title)}</h1><p class="post-meta">${latest.date} · 双语对照</p><div class="digest-body">${buildToc(latest.html)}${latest.html}</div>`
    : `<h1>暂无日报</h1><p class="post-meta">第一期将在下次自动生成时发布。</p>`;
  await writeFile(join(outDir, 'index.html'),
    render(layout, { style, title: latest ? latest.title : 'AI Builders Daily', description: '每日 AI 建造者动态，双语对照', main: indexMain }));

  const archiveMain = posts.length
    ? `<p class="eyebrow">归档</p><h1>历史日报</h1><ul class="archive-list">${archiveItemsHtml(posts)}</ul>`
    : `<h1>暂无历史</h1>`;
  await writeFile(join(outDir, 'archive.html'),
    render(layout, { style, title: '归档 · AI Builders Daily', description: '历史日报归档', main: archiveMain }));

  const aboutMain = `<p class="eyebrow">关于</p><h1>关于 AI Builders Daily</h1>
<div class="digest-body">
<p lang="zh">追踪 AI 领域真正在造东西的人——研究员、创始人、产品经理、工程师——而非只会搬运信息的网红。每天一期，双语对照。</p>
<p lang="zh"><strong>数据来源</strong>：X/Twitter 上 26 位精选 builder、6 个顶级 AI 播客（Latent Space、No Priors、Training Data 等）、Anthropic 与 Claude 官方博客。全部公开内容，由 <a href="https://github.com/zarazhangrui/follow-builders">follow-builders</a> 中心化抓取。</p>
<p lang="zh"><strong>生成方式</strong>：每天 08:00（北京时间），GitHub Actions 自动抓取 feed → 调智谱 GLM-4.6 remix 成双语摘要（判断式标题 + 主题合并）→ 生成网页 → 部署 GitHub Pages。无人为编辑干预。</p>
<p lang="zh"><strong>摘要原则</strong>：每条给判断而非描述；同主题合并提升密度；信息量不足的转赞直接跳过；中文为信息等价改写，非逐字翻译。</p>
<p lang="zh"><strong>订阅</strong>：<a href="feed.xml">RSS</a> · <a href="https://github.com/to-real/ai-builder-digest">GitHub 仓库</a></p>
</div>`;
  await writeFile(join(outDir, 'about.html'),
    render(layout, { style, title: '关于 · AI Builders Daily', description: '关于本日报', main: aboutMain }));

  for (const p of posts) {
    const main = `<p class="eyebrow">日报</p><h1>${escapeHtml(p.title)}</h1><p class="post-meta">${p.date} · <a href="index.html">回最新</a> · <a href="archive.html">查归档</a></p><div class="digest-body">${buildToc(p.html)}${p.html}</div>`;
    await writeFile(join(outDir, `${p.date}.html`),
      render(layout, { style, title: `${p.title} · AI Builders Daily`, description: p.title, main }));
  }

  await writeFile(join(outDir, 'feed.xml'), generateRss(posts), 'utf-8');

  return { posts: posts.length };
}

const invokedDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirect) {
  buildSite().then(r => console.log(`built ${r.posts} posts into site/`)).catch(e => { console.error(e); process.exit(1); });
}
