import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../dist/github.js';

test('Git tree modes prevent Contents API symlink and submodule disclosure', async () => {
  const contentReads = [];
  const github = new GitHub({ token: 'fixture', repository: 'team/repo', fetchImpl: async input => {
    const path = new URL(input).pathname;
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({ truncated: false, tree: [
      { path: 'public-config', type: 'blob', mode: '120000', sha: 'a'.repeat(40) },
      { path: 'vendor/module', type: 'commit', mode: '160000', sha: 'b'.repeat(40) },
      { path: 'src/public.txt', type: 'blob', mode: '100644', sha: 'c'.repeat(40) },
    ] }));
    contentReads.push(path);
    const text = path.endsWith('/src/public.txt') ? 'public content' : 'excluded target content';
    return new Response(JSON.stringify({ type: 'file', size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64') }));
  } });
  await assert.rejects(github.readFile('public-config', 'd'.repeat(40)));
  await assert.rejects(github.readFile('vendor/module', 'd'.repeat(40)));
  assert.deepEqual(contentReads, []);
  assert.equal(await github.readFile('src/public.txt', 'd'.repeat(40)), 'public content');
});

test('an incomplete tree cannot authorize a contents read', async () => {
  let contentsRead = false;
  const github = new GitHub({ token: 'fixture', repository: 'team/repo', fetchImpl: async input => {
    if (new URL(input).pathname.includes('/git/trees/')) return new Response(JSON.stringify({ truncated: true, tree: [
      { path: 'public-config', type: 'blob', mode: '100644', sha: 'a'.repeat(40) },
    ] }));
    contentsRead = true;
    return new Response('{}');
  } });
  await assert.rejects(github.readFile('public-config', 'd'.repeat(40)));
  assert.equal(contentsRead, false);
});
