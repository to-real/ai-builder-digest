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
    ? `<p class="eyebrow">最新一期</p><h1>${escapeHtml(latest.title)}</h1><p class="post-meta">${latest.date} · 双语对照</p><div class="digest-body">${latest.html}</div>`
    : `<h1>暂无日报</h1><p class="post-meta">第一期将在下次自动生成时发布。</p>`;
  await writeFile(join(outDir, 'index.html'),
    render(layout, { style, title: latest ? latest.title : 'AI Builders Daily', description: '每日 AI 建造者动态，双语对照', main: indexMain }));

  const archiveMain = posts.length
    ? `<p class="eyebrow">归档</p><h1>历史日报</h1><ul class="archive-list">${archiveItemsHtml(posts)}</ul>`
    : `<h1>暂无历史</h1>`;
  await writeFile(join(outDir, 'archive.html'),
    render(layout, { style, title: '归档 · AI Builders Daily', description: '历史日报归档', main: archiveMain }));

  for (const p of posts) {
    const main = `<p class="eyebrow">日报</p><h1>${escapeHtml(p.title)}</h1><p class="post-meta">${p.date} · <a href="index.html">回最新</a> · <a href="archive.html">查归档</a></p><div class="digest-body">${p.html}</div>`;
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
