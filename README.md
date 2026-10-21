# Reviewer

Autonomous code review in your GitHub pull requests. It investigates relevant code, reports concrete bugs and worthwhile simplifications, and proposes fixes in a separate draft PR.

**No server. No dashboard. No changes to the author's branch.**

## Start in two minutes

1. Add **`ANTHROPIC_API_KEY`** to your repository's **Settings → Secrets and variables → Actions**. This is an API key, not a Claude subscription login.
2. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** so Reviewer can propose fixes.
3. Save the workflow below as **`.github/workflows/review.yml`**.
4. Open a non-draft PR from a branch in the same repository. Reviewer posts its progress and results on the PR.

```yaml
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write

jobs:
  review:
    if: >-
      github.event_name == 'pull_request' ||
      (github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/review') &&
       contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: ${{ github.event_name == 'pull_request' }}
    steps:
      # No checkout: untrusted PR code is read through GitHub's API, never executed.
      - uses: energee/reviewer@v1.0.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Prefer an immutable release commit SHA instead of a tag for stronger supply-chain pinning. [Copyable workflow](examples/review.yml).

### Want automatic fix proposals?

They are enabled by default. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Reviewer opens a draft companion PR targeting your working branch; it never merges it.

To get feedback without fixes:

```yaml
with:
  anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
  propose-fixes: 'false'
```

## Talk to it on the PR

| Comment | Result |
| --- | --- |
| `/review` | Review the latest revision again. |
| `/review dismiss <id> <reason>` | Mark a finding intentional for this PR and review again without proposing that fix. |
| `/review restore <id>` | Undo a dismissal and review again. |

Copy the finding ID from the summary or inline comment. Commands require repository **write** access. Feedback stays in this PR; it does not silently change policy for other repositories. The workflow must be on your default branch before discussion commands can run.

One summary shows the revision, current findings, dismissed findings, limitations, and available token usage. Failures are explicit; an incomplete run is not an approval. Historical inline threads remain visible.

## Choose your model access

### OpenAI API

Add `OPENAI_API_KEY` as a repository secret, then change the action inputs:

```yaml
with:
  provider: openai
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Default model: `gpt-5.4`. OpenAI API usage is separately billed from ChatGPT subscriptions.

### Claude subscription / official Claude Code

Use the unmodified official CLI, **not** subscription tokens sent to our API client. Generate a token locally with `claude setup-token` and save it as `CLAUDE_CODE_OAUTH_TOKEN` in repository Actions secrets. Replace the workflow's steps with:

```yaml
steps:
  - run: npm install --global @anthropic-ai/claude-code@2.1.306
  - uses: energee/reviewer@v1.0.0
    env:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    with:
      provider: claude-code
```

The CLI runs in a fresh temporary directory with built-in tools, hooks, plugins, and project discovery disabled. The coordinator allows only bounded repository read/search operations and validated review output. It cannot execute PR commands or publish to GitHub itself. An already signed-in local CLI can also be used for local verification; do not export or copy its credential cache.

[Official Claude Action authentication](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md). Subscription limits and Anthropic's terms apply.

**Codex / ChatGPT subscriptions:** not supported for this public-repository workflow. OpenAI's [account-auth CI guidance](https://developers.openai.com/codex/auth/ci-cd-auth) is for trusted private automation with persisted, serialized credentials. Use the OpenAI API input here instead.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `provider` | `anthropic` | `anthropic`, `openai`, or `claude-code`. |
| `anthropic-api-key` | — | Required for the Anthropic API engine. |
| `openai-api-key` | — | Required for the OpenAI API engine. |
| `model` | Provider default | `claude-sonnet-4-6` or `gpt-5.4`. |
| `propose-fixes` | `true` | Create/update a separate draft fix PR. |
| `exclude-paths` | — | Newline-separated repository-relative globs; excluded from the diff and all context tools. |
| `max-turns` | `10` | Investigation limit, 1–20. |
| `github-token` | Workflow token | Advanced: use a narrowly scoped GitHub App token if needed. PAT identity is detected. |
| `bot-login` | `github-actions[bot]` fallback | Advanced: publishing account for an installation token whose identity cannot be queried. |

Example exclusions:

```yaml
exclude-paths: |
  dist/**
  vendor/**
  internal/private/**
```

Sensitive paths such as `.env`, `.env.*`, private-key files, `credentials.json`, and `service-account*.json` are always excluded. `.env.example` and `.env.sample` remain reviewable. Absolute/traversal/negated patterns are rejected. Path exclusions are **not secret detection**: do not commit credentials or put them in PR descriptions.

## Know the boundaries

- Code and PR metadata are sent to your selected model provider. Review its data terms before enabling.
- Drafts, fork PRs, and generated companion PRs are skipped. Do not switch to `pull_request_target`.
- No PR code or tests run. Patches must match uniquely and not overlap; this does **not** establish behavioral correctness.
- GitHub's default `GITHUB_TOKEN` does **not** trigger normal CI on generated fix PRs. Run a manually dispatchable validation workflow, or use an appropriately scoped GitHub App token to trigger your existing CI. Never merge without checking the diff and tests.
- Manually edited fix branches are left untouched. Action-obsoleted proposals close without deleting branches. Manually closed/merged proposals are not reopened.
- Text diffs over 160KB fail explicitly. Binary/unavailable patches and bounded context/search results are disclosed as gaps. Reviews can miss bugs.

If no feedback appears, check the Actions run: verify the key, provider billing, PR state, and `pull-requests: write`. If fixes fail, check `contents: write` and the PR-creation setting above. Useful findings remain published even when fix publication fails; retry with `/review` after correcting permissions.

## Development

Node 24+, strict TypeScript, no runtime library dependencies. Optional Claude Code is installed separately.

```sh
npm ci --ignore-scripts
npm run check
```

This runs typed linting, strict compilation, regression tests, and executable offline smoke scenarios. Commit `dist/` after source changes: GitHub executes that build directly. CI rejects stale build output. API fixtures prove orchestration, not model judgment; live-model verification is reported separately in the release PR.

MIT licensed. Report bugs in [Issues](https://github.com/energee/reviewer/issues); report vulnerabilities privately through [GitHub security advisories](https://github.com/energee/reviewer/security/advisories/new).

### Review a PR locally

With `gh` authenticated and the official `claude` CLI signed in, run this from the repository containing the PR:

```sh
npm run build
npm run review -- 5
```

This posts a real review to PR #5 using your GitHub identity and existing Claude login. Replace `5` with your PR number. Add `--fixes` to propose a draft fix PR. Local runs exclude `dist/**` and `package-lock.json` by default; override with `INPUT_EXCLUDE-PATHS` if needed. No credentials are uploaded to GitHub secrets.

Use one reviewer job per PR: keep the example's shared concurrency group for pushes and discussion commands. Do not run local reviews concurrently with CI or another local review of the same PR. Feedback and fix checkpoints are stored in the summary, not in a separate transactional database.
