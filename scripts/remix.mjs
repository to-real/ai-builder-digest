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
    'HARD RULES: Use ONLY content present in the user-message JSON. Never fabricate. Every tweet, podcast, and blog item MUST include its original url. Use the bio field for builder roles; never guess titles.',
    '',
    'STRUCTURE — output EXACTLY this markdown (it drives the web layout):',
    '# AI Builders Digest — <Month Day, Year>',
    '### X / TWITTER',
    '## <Builder full name>',
    '*<role / company, from bio>*',
    '<English summary paragraph>',
    '<Chinese translation paragraph>',
    '→ [原文](<tweet url>)',
    '## <Next builder>',
    '... (more builders) ...',
    '### PODCASTS',
    '## <Podcast name — episode title>',
    '*<show name>*',
    '<English summary>',
    '<Chinese translation>',
    '→ [原文](<video url>)',
    '',
    'LAYOUT RULES:',
    '- Line 1: "# AI Builders Digest — <date>" as a level-1 heading.',
    '- Sections ### X / TWITTER and ### PODCASTS are level-3 headings; omit a section with no content.',
    '- Each builder/item = level-2 heading (## ), full name + role, no @ handles.',
    '- Role/company as an italic line (*...*) directly under each ## .',
    '- English paragraph then Chinese translation paragraph, interleaved per item (NOT all-English-then-all-Chinese).',
    '- Source link on its own line as: → [原文](url). Multiple URLs = multiple such lines.',
    '- One blank line between items. NO "---" horizontal rules.',
    '- Final line: Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders'
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
