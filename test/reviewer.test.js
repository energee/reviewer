import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReplacements } from '../dist/fixes.js';
import { fixture } from './fixture.js';

async function scenario(t, options) {
  const app = await fixture(options);
  t.after(app.cleanup);
  return app;
}

test('review, context investigation, fix creation and follow-up do not duplicate feedback', async t => {
  const app = await scenario(t, {});
  assert.equal((await app.execute()).status, 'reviewed');
  assert.equal(app.state.companion.base.ref, 'feature');
  assert.equal(app.state.companion.draft, true);
  assert.equal(app.state.trees[0].tree[0].content, app.source.replace('items[0].name', 'items[0]?.name'));
  await app.execute();
  assert.equal(app.state.comments.length, 1);
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.companion.number, 8);
  app.options.noFindings = true;
  await app.execute();
  assert.equal(app.state.companion.state, 'closed');
});

test('stale results cannot publish findings or fix branches after progress', async t => {
  const app = await scenario(t, { stale: true });
  assert.equal((await app.execute()).status, 'stale');
  assert.equal(app.state.reviews.length, 0);
  assert.equal(app.state.branch, null);
});

for (const option of ['fork', 'draft']) {
  test(`${option} PR never sends repository data to the model`, async t => {
    const app = await scenario(t, { [option]: true });
    assert.equal((await app.execute()).status, 'skipped');
    assert.equal(app.state.modelCalls, 0);
    assert.equal(app.state.writes, 0);
  });
}

for (const option of ['invalidLocation', 'modelError']) {
  test(`${option} fails without publishing untrusted output`, async t => {
    const app = await scenario(t, { [option]: true });
    await assert.rejects(app.execute());
    assert.equal(app.state.reviews.length, 0);
    assert.equal(app.state.branch, null);
    assert.equal((await app.outputs()).status, 'failed');
  });
}

test('permission failure is visible rather than reported as a completed review', async t => {
  const app = await scenario(t, { denied: true });
  await assert.rejects(app.execute(), /403/);
  assert.equal(app.state.companion, null);
  assert.equal(app.state.logs.some(text => text === 'status: reviewed'), false);
});

test('review-only mode does not create branches', async t => {
  const app = await scenario(t, { fixes: false });
  const result = await app.execute();
  assert.equal(result.findings[0].fix, undefined);
  assert.equal(app.state.branch, null);
  assert.equal(app.state.reviews.length, 1);
});

test('patches use original offsets and reject ambiguous or overlapping edits', () => {
  assert.equal(applyReplacements('alpha beta', [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: 'gamma' }]), 'beta gamma');
  assert.throws(() => applyReplacements('x x', [{ oldText: 'x', newText: 'y' }]), /exactly one/);
  assert.throws(() => applyReplacements('abcd', [{ oldText: 'abc', newText: 'x' }, { oldText: 'bcd', newText: 'y' }]), /overlap/);
  assert.throws(() => applyReplacements('abc', [{ oldText: 'missing', newText: 'y' }]), /exactly one/);
});

test('retry after summary publication failure does not repeat inline findings', async t => {
  const app = await scenario(t, { summaryDenied: true });
  await assert.rejects(app.execute(), /403/);
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.comments.length, 1);
  app.options.summaryDenied = false;
  await app.execute();
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.comments.length, 1);
});

test('manually edited fix branches are not overwritten', async t => {
  const app = await scenario(t, {});
  await app.execute();
  const treeCount = app.state.trees.length;
  app.state.branch = 'maintainer-commit';
  await app.execute();
  assert.equal(app.state.branch, 'maintainer-commit');
  assert.equal(app.state.trees.length, treeCount);
});

test('unrelated branch name collisions do not overwrite existing work', async t => {
  const app = await scenario(t, {});
  app.state.branch = 'unrelated-commit';
  await app.execute();
  assert.equal(app.state.branch, 'unrelated-commit');
  assert.equal(app.state.companion, null);
});

for (const option of ['retarget', 'baseAdvance']) {
  test(`${option} during review discards results`, async t => {
    const app = await scenario(t, { [option]: true });
    assert.equal((await app.execute()).status, 'stale');
    assert.equal(app.state.reviews.length, 0);
    assert.equal(app.state.branch, null);
  });
}

test('deleted lines can receive findings on the left side of the diff', async t => {
  const app = await scenario(t, { deleted: true });
  await app.execute();
  assert.equal(app.state.reviews[0].comments[0].side, 'LEFT');
  assert.equal(app.state.reviews[0].comments[0].line, 2);
  assert.equal(app.state.companion, null);
});

test('unavailable patches clear stale findings and close obsolete fix proposals', async t => {
  const app = await scenario(t, {});
  await app.execute();
  app.options.noPatch = true;
  await app.execute();
  assert.equal(app.state.companion.state, 'closed');
  assert.equal(app.state.branch, app.fixedSha);
});

test('filtered-out fixes close obsolete proposals and allow later proposals', async t => {
  const app = await scenario(t, {});
  await app.execute();
  app.options.policy = true;
  await app.push();
  await app.execute();
  assert.equal(app.state.companion.state, 'closed');
  assert.equal(app.state.branch, app.fixedSha);
  app.options.policy = false;
  await app.push();
  await app.execute();
  assert.equal(app.state.companion.state, 'open');
});

test('large Unicode limitation lists still publish a current bounded summary', async t => {
  const app = await scenario(t, { largeSummary: true });
  const result = await app.execute();
  assert.equal(result.status, 'reviewed');
  assert.ok(Buffer.byteLength(app.state.comments[0].body) < 60_000);
});

test('PAT ownership updates the same summary and companion instead of duplicating them', async t => {
  const app = await scenario(t, { pat: true });
  await app.execute();
  await app.execute();
  assert.equal(app.state.comments.length, 1);
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.companion.user.login, 'energee');
});

test('trusted PR commands dismiss and restore a finding without changing the author branch', async t => {
  const app = await scenario(t, {});
  const first = await app.execute();
  const { findingId } = await import('../dist/state.js');
  const id = findingId(first.findings[0]).slice(0, 12);
  await app.command(`/review dismiss ${id} Empty arrays are rejected by the caller`);
  const dismissed = await app.execute();
  assert.deepEqual(dismissed.findings, []);
  assert.equal(app.state.companion.state, 'closed');
  await app.command(`/review restore ${id}`);
  assert.equal((await app.execute()).findings.length, 1);
  assert.equal(app.state.companion.state, 'open');
});

test('untrusted commenters cannot invoke model calls or publish changes', async t => {
  const app = await scenario(t, {});
  await app.command('/review', 'outsider');
  assert.equal((await app.execute()).status, 'skipped');
  assert.equal(app.state.modelCalls, 0);
  assert.equal(app.state.writes, 0);
});

test('fix permission failure retains findings and authenticated checkpoint for safe retry', async t => {
  const app = await scenario(t, { proposalDenied: true });
  await assert.rejects(app.execute());
  assert.equal((await app.outputs()).status, 'incomplete');
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.branch, app.fixedSha);
  app.options.proposalDenied = false;
  await app.execute();
  assert.equal(app.state.companion.head.ref, 'agentic-review/pr-7');
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.comments.length, 1);
});

test('queued feedback can dismiss a known finding absent from the latest review', async t => {
  const app = await scenario(t, {});
  const first = await app.execute();
  const { findingId } = await import('../dist/state.js');
  const id = findingId(first.findings[0]).slice(0, 12);
  app.options.noFindings = true;
  await app.execute();
  app.options.noFindings = false;
  await app.command(`/review dismiss ${id} Caller rejects this input before this function`);
  assert.deepEqual((await app.execute()).findings, []);
  assert.equal(app.state.companion.state, 'closed');
});

test('an invalid optional patch cannot publish code or discard its valid finding', async t => {
  const app = await scenario(t, { invalidFix: true });
  const result = await app.execute();
  assert.equal(result.status, 'reviewed');
  assert.equal(result.findings[0].fix, undefined);
  assert.equal(app.state.branch, null);
  assert.equal(app.state.reviews.length, 1);
  assert.equal((await app.outputs()).status, 'reviewed');
});
