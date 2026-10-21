# Plan

A reusable GitHub Action. No backend, database, dashboard, or agent framework.

## User experience

One workflow and your chosen provider credentials. Review opened, synchronized, reopened, ready, and retargeted PRs; accept trusted discussion commands. Skip drafts, forks without secrets, and generated fix PRs. Publish one updated summary and actionable inline findings on additions or deletions. Read relevant repository context through bounded tools. Reconcile findings on subsequent pushes. Propose fixes automatically in one draft companion PR for same-repository PRs. Never change the author's branch or merge.

## Architecture

Strict TypeScript targeting Node 24 ESM, native fetch, no runtime library dependencies. Compile and commit `dist/` so API consumers need no install/build step; the subscription engine uses an explicitly installed unmodified Claude Code CLI. Enforce strict compilation and typed ESLint rules against explicit `any`, unsafe operations, and unsafe type assertions. Small modules separate GitHub transport, disclosure-safe context, bounded provider review, PR state, and patch proposals. Use GitHub content/tree APIs at the exact PR SHA, not an untrusted checkout. Read/search/list tools only. A structured submit_review tool returns findings and optional exact-match replacements. External JSON is unknown until runtime validation. The coordinator discards stale results before writes.

## Shared module contracts

`src/reviewer.ts` exports typed `review(options): Promise<ReviewResult>`. Findings contain path, changed line, diff side, severity, category, title, explanation, and an optional exact replacement. Tools read/search/list tracked repository files at the reviewed SHA; they cannot run code. Direct API endpoints are fixed; Claude subscription requests stay inside the official CLI. Models are configurable. `fetchImpl` permits offline HTTP fixture verification.

`src/github.ts` exports typed endpoint methods with runtime response decoders. No model-provided URLs. `src/fixes.ts` validates unique non-overlapping replacements, preserves file modes, and publishes draft companion PRs without writing to the author branch.

## Guardrails

Repository content and model responses cannot authorize actions. No arbitrary command tool, no PR test execution, no untrusted checkout, no credential-bearing git subprocess. Limit file sizes, context, turns, findings, output tokens, and request duration. Reject unsafe paths and non-diff line comments. Validate exact replacements and publish only applicable non-overlapping replacements. Proposed fixes are not claimed behavior-verified; maintainers and normal CI validate behavior. Missing permissions yield explicit actionable messages, not silently successful fixes. Fork PRs skip by default because pull_request workflows lack secrets/write permissions. Never recommend pull_request_target as a shortcut.

## Verification

Offline integration smoke uses HTTP fixtures for Anthropic and GitHub, exercises actual action entrypoint, tool context reads, initial and subsequent reviews, stale SHA, draft/fork skips, fix creation/update, malformed model output, invalid patches, and permission failures. No claim of live API validation without credentials.

Live subscription/GitHub verification on temporary evaluation PR #6 detected a real authorization defect, produced the correct draft fix PR #7, avoided duplicate comments on a second pass, and reported a clean result after the fix. Hosted CI exercised the packaged Action without installing dependencies and verified the generated output. Direct Anthropic/OpenAI API credentials remain unavailable; those paths are protocol-fixture verified, not live-model verified.

## Adversarial review

Independent review identified unsafe generic JSON typing, potential summary/inline endpoint confusion, and force-updated refs that could overwrite newer runs. Resolve with runtime decoders, separate issue/review comment APIs, and non-force ref updates whose commit includes the previous fix tip as a parent. Track inline finding identifiers as well as summary state so interrupted publication does not duplicate comments. Recheck the source SHA before externally visible writes; GitHub has no atomic transaction spanning these writes, so every publication identifies its reviewed SHA.

Additional refinements: block automatic workflow/policy edits, skip recursive fix PRs, close obsolete proposals, and explicitly document that GITHUB_TOKEN-created PRs do not trigger normal CI automatically. Repository code goes to Anthropic; key holders must consent to that disclosure. Branch protection and organization policy may disallow fix publication; failures must be visible.

Implementation security review found three further issues, now addressed: ref deletion could erase concurrent edits (retain branches instead); retargeting a PR could publish stale findings (compare head SHA, base ref and base SHA); filtering every fix could leave obsolete proposals open (reconcile after filtering). Closed companion PRs remain discoverable so later fixes can safely reuse an owned branch. No behavior verification is claimed for model-generated code.

Behavioral review also identified oversized-summary failures, escaped-JSON input-budget overflow, and undisclosed search caps. Bound published summaries, fit the serialized context rather than raw text alone, and return explicit search truncation with automatic limitations. Preserve full patches for line validation. Regression coverage exercises deletion-only/no-patch revisions and Unicode summary limits.

## Initial release iteration

Repository: https://github.com/energee/reviewer. License: MIT (owner selected).

Release priorities:

1. Prevent sensitive-context disclosure ([#1](https://github.com/energee/reviewer/issues/1)).
2. Support publishing identities beyond GitHub's default bot ([#2](https://github.com/energee/reviewer/issues/2)).
3. Communicate current progress and failures on the PR, not just in Actions logs ([#3](https://github.com/energee/reviewer/issues/3)).
4. Recover interrupted fix publication using an authenticated checkpoint ([#4](https://github.com/energee/reviewer/issues/4)).
5. Support Anthropic/OpenAI API keys and official Claude Code authentication; do not route subscription tokens through custom HTTP clients.
6. Let trusted collaborators request another review or dismiss an intentional finding directly in PR discussion.

Verification proceeds locally first, using the owner's already-authenticated official Claude CLI and the real GitHub PR. Do not copy local credentials into GitHub. Add automatic model credentials only when the owner supplies a repository secret. CI must prove the checked-in Action build runs on GitHub independently of live model availability. Release notes must distinguish exercised paths from unavailable credentials.

Final adversarial release checks additionally track the native large-review timeout (#8), durable feedback queues (#9), discriminated native request schemas (#10), and clean distribution integrity (#11). The supported workflow uses one non-canceling `queue: max` group per PR. Local/CI review invocations must not overlap for the same PR.

The full native review completed, but positive thinking budgets still caused intermittent thinking-only CLI retries and timeouts. The native engine now explicitly disables extended thinking using the documented `MAX_THINKING_TOKENS=0` control rather than raising deadlines. A full live review completed in 16 seconds with that configuration. Maintainer feedback triages intentional privacy/error policies instead of accepting every model finding blindly. A separate real-GitHub probe found an actual symlink exclusion bypass (#12): the Contents API dereferences a regular-file target while reporting `type=file`. File reads now require a verified regular mode in the immutable Git tree; the same live probe is denied after the fix.
