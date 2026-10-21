import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../dist/context.js';

function callbacks(contents) {
  return {
    listFiles: async () => Object.keys(contents),
    readFile: async path => {
      if (!(path in contents)) throw new Error(`missing ${path}`);
      return contents[path];
    },
  };
}

test('context removes sensitive and custom excluded paths before exposing files or tools', async () => {
  const source = callbacks({
    '.env': 'SECRET',
    '.env.production': 'SECRET',
    '.env.example': 'SAFE=true',
    'keys/deploy.pem': 'SECRET',
    'credentials.json': 'SECRET',
    '.git/config': 'SECRET',
    'private/notes.txt': 'SECRET',
    'src/app.ts': 'export const app = true;',
  });
  const context = await createContext({
    files: [
      { path: '.env', status: 'modified', patch: 'SECRET' },
      { path: 'keys/deploy.pem', status: 'modified', patch: 'SECRET' },
      { path: 'private/notes.txt', status: 'modified', patch: 'SECRET' },
      { path: 'src/app.ts', status: 'modified', patch: 'safe' },
    ],
    ...source,
    excludePaths: ['private/**\n*.ignored'],
  });

  assert.deepEqual(context.files.map(file => file.path), ['src/app.ts']);
  assert.deepEqual((await context.listFiles()).sort(), ['.env.example', 'src/app.ts']);
  await assert.rejects(context.readFile('.env'));
  await assert.rejects(context.readFile('keys/deploy.pem'));
  await assert.rejects(context.readFile('private/notes.txt'));
  await assert.rejects(context.readFile('../src/app.ts'));
  assert.equal(await context.readFile('.env.example'), 'SAFE=true');
  assert.equal(await context.readFile('src/app.ts'), 'export const app = true;');
});

test('context reads root and changed-file ancestor instructions only from the safe list', async () => {
  const source = callbacks({
    'AGENTS.md': 'root instruction',
    'src/AGENTS.md': 'source instruction',
    'src/nested/CLAUDE.md': 'nested instruction',
    'src/nested/app.ts': 'export const app = true;',
    'unrelated/CLAUDE.md': 'do not include',
  });
  const context = await createContext({
    files: [{ path: 'src/nested/app.ts', status: 'modified', patch: 'safe' }],
    ...source,
    excludePaths: [],
  });

  assert.doesNotMatch(context.instructions, /do not include/);
});

test('context retains changed files when a bounded listing would otherwise omit them', async () => {
  const contents = { 'z/changed.ts': 'changed' };
  for (let index = 0; index < 5_100; index++) contents[`a/${String(index).padStart(4, '0')}.ts`] = 'other';
  const source = callbacks(contents);
  const context = await createContext({
    files: [{ path: 'z/changed.ts', status: 'modified', patch: 'safe' }],
    ...source,
    excludePaths: [],
  });

  const paths = await context.listFiles();
  assert.equal(paths.length, 5_000);
  assert.equal(paths.includes('z/changed.ts'), true);
  assert.equal(await context.readFile('z/changed.ts'), 'changed');
});

test('unreadable optional instructions do not fail context creation', async () => {
  const context = await createContext({
    files: [{ path: 'src/app.ts', status: 'modified', patch: 'safe' }],
    listFiles: async () => ['AGENTS.md', 'src/app.ts'],
    readFile: async path => {
      if (path === 'AGENTS.md') throw new Error('unavailable');
      return 'export const app = true;';
    },
    excludePaths: [],
  });

  assert.equal(context.instructions, '');
  assert.equal(await context.readFile('src/app.ts'), 'export const app = true;');
});

test('invalid exclusion patterns fail closed before reading any repository content', async () => {
  let reads = 0;
  await assert.rejects(createContext({
    files: [{ path: 'src/a.ts', status: 'modified', patch: 'source' }],
    excludePaths: ['../secrets/**'],
    listFiles: async () => { reads++; return ['src/a.ts']; },
    readFile: async () => { reads++; return 'source'; },
  }));
  assert.equal(reads, 0);
});
