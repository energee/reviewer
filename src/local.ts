import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './main.js';

const execute = promisify(execFile);

async function main(): Promise<void> {
  const [number, ...options] = process.argv.slice(2);
  if (!number || !/^\d+$/.test(number) || options.some(option => option !== '--fixes')) {
    throw new Error('Usage: npm run review -- <PR number> [--fixes]. Uses the current gh repository and official local Claude login.');
  }
  const { stdout: name } = await execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const repository = name.trim();
  const { stdout: credential } = await execute('gh', ['auth', 'token']);
  const token = credential.trim();
  const { stdout: identity } = await execute('gh', ['api', 'user', '--jq', '.login']);
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-local-'));
  try {
    const path = join(directory, 'event.json');
    await writeFile(path, JSON.stringify({ action: 'created', issue: { number: Number(number), pull_request: {} },
      comment: { body: '/review', user: { login: identity.trim() } } }), { mode: 0o600 });
    await run({ env: { ...process.env, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: repository, 'INPUT_GITHUB-TOKEN': token, INPUT_PROVIDER: 'claude-code',
      'INPUT_PROPOSE-FIXES': options.includes('--fixes') ? 'true' : 'false',
      'INPUT_EXCLUDE-PATHS': process.env['INPUT_EXCLUDE-PATHS'] || 'dist/**\npackage-lock.json',
    } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local review failed');
  process.exitCode = 1;
});
