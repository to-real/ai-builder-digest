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
  assert.match(index, /newer post body/);
  assert.doesNotMatch(index, /older post body/);
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
