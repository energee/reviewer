import { GitHub, type PullRequest } from './github.js';
import type { Finding } from './reviewer.js';

type Replacement = { oldText: string; newText: string };

export const FIX_MARKER = '<!-- agentic-review:fix -->';

// Match against the original file, never against earlier model replacements.
export function applyReplacements(original: string, replacements: Replacement[]): string {
  const edits = replacements.map(({ oldText, newText }) => {
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
      throw new Error('Fix needs a nonempty oldText and a string newText');
    }
    const start = original.indexOf(oldText);
    if (start < 0 || original.indexOf(oldText, start + 1) !== -1) {
      throw new Error('Fix must match exactly one occurrence in the original file');
    }
    if (oldText === newText) throw new Error('Fix does not change the file');
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) throw new Error('Fixes overlap');
  }
  let result = original;
  for (const edit of edits.toReversed()) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  if (Buffer.byteLength(result) > 100_000) throw new Error('Fixed file exceeds 100KB');
  if (result.includes('\0')) throw new Error('Fixed file contains binary content');
  return result;
}

export async function proposeFixes({ github, pull, findings, assertCurrent, actorLogin = 'github-actions[bot]',
  onPrepared, pendingFixSha }: {
  github: GitHub; pull: PullRequest; findings: Finding[]; assertCurrent: () => Promise<void>;
  actorLogin?: string; onPrepared?: (sha: string) => Promise<void>; pendingFixSha?: string;
}): Promise<{ url: string | null; notes: string[] }> {
  const grouped = new Map<string, Replacement[]>();
  for (const finding of findings) {
    if (!finding.fix) continue;
    if (!grouped.has(finding.path)) grouped.set(finding.path, []);
    grouped.get(finding.path)!.push(finding.fix);
  }
  const branch = `agentic-review/pr-${pull.number}`;
  const existing = await github.listPulls(`${pull.base.repo.owner.login}:${branch}`);
  const owned = (pr: PullRequest) => pr.head.ref === branch && pr.base.ref === pull.head.ref &&
    pr.body?.includes(FIX_MARKER) && pr.user?.login === actorLogin;
  const companion = existing.find(pr => pr.state === 'open' && owned(pr));
  const closedCompanion = existing.find(pr => pr.state === 'closed' && owned(pr));
  const ref = await github.getRef(branch);
  if (ref && companion && !companion.body?.includes(`<!-- fix-tip:${ref.object.sha} -->`)) {
    return { url: companion.html_url, notes: ['Fix branch changed outside this action; left untouched. Close the companion PR and delete its branch to allow a new proposal.'] };
  }
  const closeObsolete = async (notes: string[]) => {
    if (companion) {
      await assertCurrent();
      await github.updatePull(companion.number, { state: 'closed',
        body: `${companion.body || FIX_MARKER}\n<!-- fix-closed:obsolete -->\n\nClosed: the latest review has no applicable fixes. See #${pull.number}.` });
    }
    return { url: null, notes };
  };
  if (!grouped.size) return closeObsolete([]);
  const canRecoverOrphan = ref?.object.sha === pendingFixSha;
  const canReuseClosedBranch = !!ref && closedCompanion?.body?.includes('<!-- fix-closed:obsolete -->') &&
    closedCompanion.body.includes(`<!-- fix-tip:${ref.object.sha} -->`);
  if (!companion && closedCompanion && !closedCompanion.body?.includes('<!-- fix-closed:obsolete -->')) {
    return { url: null, notes: ['Previous companion PR was closed manually or merged; it was left untouched.'] };
  }
  if (ref && !companion && !canRecoverOrphan && !canReuseClosedBranch) {
    return { url: null, notes: [`Fix branch ${branch} already exists without an actor-owned open companion PR; left untouched.`] };
  }
  const commit = await github.getCommit(pull.head.sha);
  const tree = await github.getTree(commit.tree.sha);
  if (tree.truncated) throw new Error('Cannot safely prepare fixes: repository tree is truncated');
  const entries: { path: string; mode: string; type: 'blob'; content: string }[] = [];
  const notes: string[] = [];
  for (const [path, replacements] of grouped) {
    // Workflow and repository policy changes are outside automatic-fix authority.
    if (path.startsWith('.github/') || /(^|\/)(AGENTS\.md|CLAUDE\.md)$/i.test(path)) {
      notes.push(`No automatic fix for policy/workflow file ${path}.`);
      continue;
    }
    const source = tree.tree.find(entry => entry.path === path);
    if (!source || !['100644', '100755'].includes(source.mode)) {
      notes.push(`No automatic fix for non-regular file ${path}.`);
      continue;
    }
    try {
      const original = await github.readFile(path, pull.head.sha);
      const content = applyReplacements(original, replacements);
      entries.push({ path, mode: source.mode, type: 'blob', content });
    } catch (error) {
      notes.push(`Could not apply fix for ${path}: ${error instanceof Error ? error.message : 'invalid replacement'}`);
    }
  }
  if (!entries.length) return closeObsolete(notes);
  const bodyFor = (sha: string) => `${FIX_MARKER}\n<!-- fix-tip:${sha} -->\nSuggested fixes for #${pull.number} at ${pull.head.sha}.\n\n` +
    '**Verification:** replacements matched uniquely and did not overlap. No PR code or tests were executed. ' +
    'Behavior is not verified. Inspect the diff and run your normal CI before accepting.\n\n' +
    'This branch is regenerated on later reviews; do not edit it directly.\n\n' +
    `Changed files: ${entries.map(entry => `\`${entry.path}\``).join(', ')}.`;
  await assertCurrent();
  const newTree = await github.createTree(commit.tree.sha, entries);
  const newCommit = await github.createCommit(
    `Agentic review fixes for PR #${pull.number} (${pull.head.sha.slice(0, 12)})`, newTree.sha,
    ref ? [pull.head.sha, ref.object.sha] : [pull.head.sha]);
  await onPrepared?.(newCommit.sha);
  await assertCurrent();
  if (ref) await github.updateRef(branch, newCommit.sha);
  else await github.createRef(branch, newCommit.sha);
  const body = bodyFor(newCommit.sha);
  await assertCurrent();
  const result = companion
    ? await github.updatePull(companion.number, { body })
    : await github.createPull({ title: `Suggested fixes for #${pull.number}`, head: branch,
      base: pull.head.ref, body, draft: true, maintainer_can_modify: false });
  return { url: result.html_url, notes };
}
