import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../dist/main.js';

export async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-'));
  const source = 'export function first(items) {\n  return items[0].name;\n}\n';
  const pull = { number: 7, state: 'open', draft: false, title: 'Add first item helper', body: '',
    html_url: 'https://github.com/team/repo/pull/7',
    user: { login: 'author', type: 'User' },
    head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'team/repo', owner: { login: 'team' } } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'team/repo', owner: { login: 'team' } } } };
  if (options.fork) pull.head.repo.full_name = 'outsider/repo';
  if (options.draft) pull.draft = true;
  const state = { comments: [], reviews: [], companion: null, branch: null, trees: [], modelCalls: 0, writes: 0, pullReads: 0, logs: [] };
  state.actor = options.pat ? { type: 'User', login: 'energee' } : { type: 'Bot', login: 'github-actions[bot]' };
  const fixedSha = 'f'.repeat(40);
  const finding = { path: 'src/first.js', line: 2, severity: 'medium', category: 'bug',
    title: 'Handle an empty items array', body: 'When items is empty, items[0] is undefined and accessing name throws. Return undefined for an empty list.',
    fix: { oldText: 'return items[0].name;', newText: 'return items[0]?.name;' } };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const data = init.body ? JSON.parse(init.body) : undefined;
    if (url.hostname === 'api.anthropic.com') {
      state.modelCalls++;
      if (options.modelError) return response({ error: { message: 'Unavailable' } }, 503);
      if (state.modelCalls % 2 === 1) return response({ content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'src/first.js' } }] });
      if (options.stale) pull.head.sha = 'c'.repeat(40);
      if (options.retarget) pull.base.ref = 'release';
      if (options.baseAdvance) pull.base.sha = 'd'.repeat(40);
      const findings = options.noFindings ? [] : [{ ...finding, ...(options.invalidLocation ? { line: 99 } : {}), ...(options.invalidFix ? { fix: { oldText: 'not found', newText: 'bad' } } : {}) }];
      if (options.deleted && findings.length) { findings[0].side = 'LEFT'; delete findings[0].fix; }
      return response({ content: [{ type: 'tool_use', id: 'final', name: 'submit_review', input: { summary: 'The empty-list case needs handling.', limitations: [], findings } }] });
    }
    const path = url.pathname.replace('/repos/team/repo', '');
    if (path === '/user') return response(state.actor);
    if (path === '/collaborators/maintainer/permission') return response({ permission: 'write' });
    if (path.startsWith('/collaborators/')) return response({ permission: 'read' });
    if (method !== 'GET') {
      state.writes++;
      if (options.denied) return response({ message: 'Resource not accessible by integration' }, 403);
    }
    if (path === '/issues/comments/1' && method === 'PATCH' && options.summaryDenied && state.reviews.length) return response({ message: 'Temporarily denied' }, 403);
    if (path === '/pulls/7' && method === 'GET') { state.pullReads++; return response(pull); }
    if (path === '/pulls/7/files') return response([{ filename: 'src/first.js', status: options.deleted ? 'removed' : 'added',
      patch: options.noPatch ? undefined : options.deleted ? '@@ -1,3 +0,0 @@\n-export function first(items) {\n-  return items[0].name;\n-}' : '@@ -0,0 +1,3 @@\n+export function first(items) {\n+  return items[0].name;\n+}' },
      ...(options.largeSummary ? Array.from({ length: 90 }, (_, index) => ({
        filename: `${('界'.repeat(80) + '/').repeat(3)}image-${index}.png`, status: 'modified',
      })) : [])]);
    if (path.startsWith('/git/trees/') && method === 'GET') return response({ sha: 'tree', truncated: false,
      tree: [{ path: 'src/first.js', mode: options.nonRegular ? '120000' : '100644', type: 'blob', sha: 'blob' }] });
    if (path.startsWith('/contents/')) return response({ type: 'file', encoding: 'base64', size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64') });
    if (path === '/issues/7/comments' && method === 'GET') return response(state.comments);
    if (path === '/issues/7/comments' && method === 'POST') {
      const comment = { id: 1, body: data.body, user: state.actor };
      state.comments.push(comment); return response(comment, 201);
    }
    if (path === '/issues/comments/1' && method === 'PATCH') { state.comments[0].body = data.body; return response(state.comments[0]); }
    if (path === '/pulls/7/reviews' && method === 'POST') { state.reviews.push(data); return response({ id: 1 }); }
    if (path === '/pulls/7/comments' && method === 'GET') return response(state.reviews.flatMap(review => review.comments.map((comment, index) => ({ ...comment, id: index + 1, user: state.actor }))));
    if (path === '/pulls' && method === 'GET') return response(state.companion ? [state.companion] : []);
    if (path === '/pulls' && method === 'POST') {
      if (options.proposalDenied) return response({ message: 'PR creation disabled' }, 403);
      state.companion = { ...pull, number: 8, user: state.actor,
        body: data.body, html_url: 'https://github.com/team/repo/pull/8', draft: true,
        head: { ...pull.head, ref: data.head }, base: { ...pull.base, ref: data.base } };
      return response(state.companion, 201);
    }
    if (path === '/pulls/8' && method === 'PATCH') { Object.assign(state.companion, data); return response(state.companion); }
    if (path.startsWith('/git/ref/heads/')) return state.branch ? response({ ref: 'refs/heads/agentic-review/pr-7', object: { sha: state.branch } }) : response({ message: 'Not Found' }, 404);
    if (path === '/git/refs' && method === 'POST') { state.branch = data.sha; return response({ ref: data.ref, object: { sha: data.sha } }, 201); }
    if (path.startsWith('/git/refs/heads/') && method === 'PATCH') { state.branch = data.sha; return response({ ref: 'refs/heads/agentic-review/pr-7', object: { sha: data.sha } }); }
    if (path.startsWith('/git/commits/') && method === 'GET') return response({ sha: pull.head.sha, tree: { sha: 'tree' } });
    if (path === '/git/trees' && method === 'POST') { state.trees.push(data); return response({ sha: 'new-tree' }, 201); }
    if (path === '/git/commits' && method === 'POST') return response({ sha: fixedSha, tree: { sha: data.tree } }, 201);
    throw new Error(`Unexpected fixture request: ${method} ${url}`);
  };
  const eventPath = join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ action: 'opened', pull_request: pull }));
  const outputPath = join(directory, 'outputs');
  const env = { GITHUB_OUTPUT: outputPath, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'team/repo',
    GITHUB_API_URL: 'https://api.github.com', 'INPUT_ANTHROPIC-API-KEY': 'fixture-key', 'INPUT_GITHUB-TOKEN': 'fixture-token',
    'INPUT_PROPOSE-FIXES': options.fixes === false ? 'false' : 'true' };
  return { state, options, pull, source, finding, env, fixedSha,
    outputs: async () => Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split(/\n/).map(line => line.split('='))),
    command: async (text, login = 'maintainer') => {
      env.GITHUB_EVENT_NAME = 'issue_comment';
      await writeFile(eventPath, JSON.stringify({ action: 'created', issue: { number: 7, pull_request: {} },
        comment: { body: text, user: { login } } }));
    },
    execute: () => run({ env, fetchImpl, log: text => state.logs.push(text) }),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
