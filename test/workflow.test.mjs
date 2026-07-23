import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/daily.yml', import.meta.url);

test('Daily Digest runs maintained actions and project code on Node 24', async () => {
  const workflow = await readFile(workflowUrl, 'utf-8');

  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*['"]24['"]/);
  assert.doesNotMatch(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/);
});
