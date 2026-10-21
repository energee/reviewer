import { review } from '../dist/reviewer.js';
import assert from 'node:assert/strict';
import { fixture } from '../test/fixture.js';

const app = await fixture();
try {
  const first = await app.execute();
  assert.equal(first.status, 'reviewed');
  console.log(`Review: ${first.findings[0].title}`);
  console.log(`Inline finding: ${app.state.reviews[0].comments[0].path}:${app.state.reviews[0].comments[0].line}`);
  console.log(`Draft fix: ${first.fixUrl} -> ${app.state.companion.base.ref}`);
  console.log(`Patched code: ${app.state.trees[0].tree[0].content.trim()}`);
  await app.execute();
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.comments.length, 1);
  console.log('Follow-up: existing summary and fix PR updated; no duplicate inline finding.');
  app.options.noFindings = true;
  await app.execute();
  assert.equal(app.state.companion.state, 'closed');
  console.log('Addressed finding: companion PR closed and current summary cleared.');
  console.log('PASS: actual action orchestration and model tool loop exercised with offline API fixtures.');
} finally {
  await app.cleanup();
}

let modelTurn = 0;
const boundedReview = await review({
  apiKey: 'fixture-key', model: 'fixture-model', maxInputBytes: 64 * 1024,
  diff: '"'.repeat(52 * 1024), instructions: '"'.repeat(16 * 1024),
  files: [{ path: 'context.js', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
  readFile: async () => 'needle\n'.repeat(100), listFiles: async () => ['context.js'],
  fetchImpl: async () => {
    modelTurn++;
    const call = modelTurn === 1
      ? { id: 'search', name: 'search', input: { query: 'needle' } }
      : { id: 'finish', name: 'submit_review', input: { summary: 'No supported defect.', findings: [], limitations: [] } };
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', ...call }] }));
  },
});
console.log('Budget/search limitations observed:', boundedReview.limitations);
