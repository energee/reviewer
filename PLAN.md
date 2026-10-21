# Plan

A reusable GitHub Action. No backend, database, dashboard, or agent framework.

## User experience

One workflow and an Anthropic API key. Review opened, synchronized, reopened, ready, and retargeted PRs. Skip drafts, forks without secrets, and generated fix PRs. Publish one updated summary and actionable inline findings on additions or deletions. Read relevant repository context through bounded tools. Reconcile findings on subsequent pushes. Propose fixes automatically in one draft companion PR for same-repository PRs. Never change the author's branch or merge.

## Architecture

Strict TypeScript targeting Node 24 ESM, native fetch, no runtime dependencies. Compile and commit `dist/` so consumers need no install/build step. Enforce strict compilation and typed ESLint rules against explicit `any`, unsafe operations, and unsafe type assertions. Four modules: GitHub API/state and publishing; bounded Anthropic tool-use reviewer; action orchestration; patch validation. Use GitHub content/tree APIs at the exact PR SHA, not an untrusted checkout. Read/search/list tools only. A structured submit_review tool returns findings and optional exact-match replacements. External JSON is unknown until runtime validation. The coordinator discards stale results before writes.

## Shared module contracts

`src/reviewer.ts` exports typed `review(options): Promise<ReviewResult>`. Findings contain path, changed line, diff side, severity, category, title, explanation, and an optional exact replacement. Tools read/search/list tracked repository files at the reviewed SHA; they cannot run code. Anthropic endpoint is fixed, model configurable. `fetchImpl` permits offline HTTP fixture verification.

`src/github.ts` exports typed endpoint methods with runtime response decoders. No model-provided URLs. `src/fixes.ts` validates unique non-overlapping replacements, preserves file modes, and publishes draft companion PRs without writing to the author branch.

## Guardrails

Repository content and model responses cannot authorize actions. No arbitrary command tool, no PR test execution, no untrusted checkout, no credential-bearing git subprocess. Limit file sizes, context, turns, findings, output tokens, and request duration. Reject unsafe paths and non-diff line comments. Validate exact replacements and publish only applicable non-overlapping replacements. Proposed fixes are not claimed behavior-verified; maintainers and normal CI validate behavior. Missing permissions yield explicit actionable messages, not silently successful fixes. Fork PRs skip by default because pull_request workflows lack secrets/write permissions. Never recommend pull_request_target as a shortcut.

## Verification

Offline integration smoke uses HTTP fixtures for Anthropic and GitHub, exercises actual action entrypoint, tool context reads, initial and subsequent reviews, stale SHA, draft/fork skips, fix creation/update, malformed model output, invalid patches, and permission failures. No claim of live API validation without credentials.

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
