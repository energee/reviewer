import { createHash } from 'node:crypto';
import { isObject as record, type Finding } from './reviewer.js';

export const SUMMARY_MARKER = '<!-- agentic-review:summary -->';
export type FindingLabel = { title: string; path: string };
export type ReviewState = {
  dismissed: Record<string, FindingLabel & { reason: string }>;
  findings: Record<string, FindingLabel>;
  pendingFixSha?: string;
};

export function findingId(finding: Finding): string {
  return createHash('sha256').update(JSON.stringify([
    finding.path, finding.side || 'RIGHT', finding.category, finding.title.trim().toLowerCase(),
  ])).digest('hex');
}

export function decodeState(body: string): ReviewState {
  const state: ReviewState = { dismissed: {}, findings: {} };
  const match = /<!-- agentic-review:state ([A-Za-z0-9+/=]+) -->/.exec(body);
  if (!match || match[1].length > 36_000) return state;
  try {
    const value: unknown = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!record(value)) return state;
    for (const field of ['findings', 'dismissed']) {
      const entries = value[field];
      if (!record(entries)) continue;
      for (const [id, item] of Object.entries(entries).slice(0, 30)) {
        if (!/^[a-f0-9]{64}$/.test(id) || !record(item) || typeof item.title !== 'string' ||
          typeof item.path !== 'string' || item.title.length > 240 || item.path.length > 1024) continue;
        if (field === 'dismissed' && typeof item.reason === 'string' && item.reason.length <= 300) {
          state.dismissed[id] = { title: item.title, path: item.path, reason: item.reason };
        } else if (field === 'findings') state.findings[id] = { title: item.title, path: item.path };
      }
    }
    if (typeof value.pendingFixSha === 'string' && /^[a-f0-9]{40,64}$/.test(value.pendingFixSha)) {
      state.pendingFixSha = value.pendingFixSha;
    }
  } catch { /* Invalid or old state cannot authorize a fix-branch write. */ }
  return state;
}

export function encodeState(state: ReviewState): string {
  const data = Buffer.from(JSON.stringify(state)).toString('base64');
  if (data.length > 36_000) throw new Error('Saved PR feedback exceeds its limit; use /review restore <id> to clear old dismissals.');
  return `<!-- agentic-review:state ${data} -->`;
}

export function safeText(value: unknown): string {
  return String(value).replace(/<!--[\s\S]*?-->/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/@/g, '@\u200b');
}
