import test from 'node:test';
import assert from 'node:assert/strict';
import { FIX_MARKER, proposeFixes } from '../dist/fixes.js';

const branch = 'agentic-review/pr-7';
const pull = {
  number: 7,
  head: { sha: 'a'.repeat(40), ref: 'feature' },
  base: { repo: { owner: { login: 'team' } }, ref: 'feature' },
};
const findings = [{ path: 'src/file.js', fix: { oldText: 'before', newText: 'after' } }];

function companion({ state = 'open', login = 'github-actions[bot]', type = 'Bot', tip = 'existing' } = {}) {
  return {
    number: 8,
    state,
    body: `${FIX_MARKER}\n<!-- fix-tip:${tip} -->`,
    html_url: 'https://github.com/team/repo/pull/8',
    user: { login, type },
    head: { ref: branch },
    base: { ref: 'feature' },
  };
}

function github({ pullRequests = [], ref = 'existing' } = {}) {
  const calls = [];
  return {
    calls,
    listPulls: async () => pullRequests,
    getRef: async () => ref ? { object: { sha: ref } } : null,
    getCommit: async () => ({ tree: { sha: 'tree' } }),
    getTree: async () => ({ truncated: false, tree: [{ path: 'src/file.js', mode: '100644' }] }),
    readFile: async () => 'before',
    createTree: async () => ({ sha: 'new-tree' }),
    createCommit: async () => ({ sha: 'new-commit' }),
    updateRef: async (...args) => { calls.push(['updateRef', ...args]); },
    createRef: async (...args) => { calls.push(['createRef', ...args]); },
    updatePull: async (...args) => { calls.push(['updatePull', ...args]); return { html_url: 'https://github.com/team/repo/pull/8' }; },
    createPull: async (...args) => { calls.push(['createPull', ...args]); return { html_url: 'https://github.com/team/repo/pull/9' }; },
  };
}

test('reuses a companion owned by the configured PAT actor', async () => {
  const api = github({ pullRequests: [companion({ login: 'reviewer-pat', type: 'User' })] });

  const result = await proposeFixes({ github: api, pull, findings, actorLogin: 'reviewer-pat', assertCurrent: async () => {} });

  assert.equal(result.url, 'https://github.com/team/repo/pull/8');
  assert.deepEqual(api.calls.map(([method]) => method), ['updateRef', 'updatePull']);
});

test('does not take over a branch whose marked PR belongs to a different actor', async () => {
  const api = github({ pullRequests: [companion({ login: 'other-pat', type: 'User' })] });

  const result = await proposeFixes({ github: api, pull, findings, actorLogin: 'reviewer-pat', assertCurrent: async () => {} });

  assert.equal(result.url, null);
  assert.match(result.notes[0], /without an actor-owned open companion PR/);
  assert.deepEqual(api.calls, []);
});

test('leaves a manually closed companion and its branch untouched', async () => {
  const api = github({ pullRequests: [companion({ state: 'closed' })] });

  const result = await proposeFixes({ github: api, pull, findings, assertCurrent: async () => {} });

  assert.equal(result.url, null);
  assert.match(result.notes[0], /closed manually or merged/);
  assert.deepEqual(api.calls, []);
});

test('reuses only an action-obsoleted companion branch in a new proposal', async () => {
  const closed = companion({ state: 'closed' });
  closed.body += '\n<!-- fix-closed:obsolete -->';
  const api = github({ pullRequests: [closed] });

  const result = await proposeFixes({ github: api, pull, findings, assertCurrent: async () => {} });

  assert.equal(result.url, 'https://github.com/team/repo/pull/9');
  assert.deepEqual(api.calls.map(([method]) => method), ['updateRef', 'createPull']);
});

test('a checkpoint failure after preparation prevents branch mutation', async () => {
  const api = github({ ref: null });

  await assert.rejects(
    proposeFixes({ github: api, pull, findings, assertCurrent: async () => {}, onPrepared: async () => { throw new Error('checkpoint failed'); } }),
    /checkpoint failed/,
  );

  assert.deepEqual(api.calls, []);
});

test('checkpoints the generated commit before mutating the fix ref', async () => {
  const api = github({ ref: null });

  await proposeFixes({
    github: api,
    pull,
    findings,
    assertCurrent: async () => {},
    onPrepared: async sha => { api.calls.push(['onPrepared', sha]); },
  });

  assert.deepEqual(api.calls.map(([method]) => method), ['onPrepared', 'createRef', 'createPull']);
  assert.equal(api.calls[0][1], 'new-commit');
});

test('an authenticated matching checkpoint regenerates an orphan without a forced ref write', async () => {
  const api = github({ ref: 'orphan-commit' });

  const result = await proposeFixes({
    github: api,
    pull,
    findings,
    assertCurrent: async () => {},
    pendingFixSha: 'orphan-commit',
  });

  assert.equal(result.url, 'https://github.com/team/repo/pull/9');
  assert.deepEqual(api.calls.map(([method]) => method), ['updateRef', 'createPull']);
  assert.deepEqual(api.calls[0], ['updateRef', branch, 'new-commit']);
});

test('an unproven orphan branch remains untouched', async () => {
  const api = github({ ref: 'orphan-commit' });

  const result = await proposeFixes({
    github: api,
    pull,
    findings,
    assertCurrent: async () => {},
    pendingFixSha: 'different-commit',
  });

  assert.equal(result.url, null);
  assert.match(result.notes[0], /without an actor-owned open companion PR/);
  assert.deepEqual(api.calls, []);
});
