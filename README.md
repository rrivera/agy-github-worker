<p align="center">
  <img src="assets/logo.png" alt="agy-github-worker logo" width="128" height="128" />
</p>

# agy-github-worker

[![GitHub Repo](https://img.shields.io/badge/GitHub-rrivera%2Fagy--github--worker-blue.svg)](https://github.com/rrivera/agy-github-worker)
[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin-89b4fa.svg)](https://antigravity.google)

Core Antigravity plugin providing the autonomous `/github-worker` skill for agent-ready GitHub issue workflows.

---

## Overview

`agy-github-worker` is a fully autonomous issue worker engine built specifically for Antigravity:

- **Autonomous Issue Polling & Scoped Targeting**: Scans target repositories for issues opted in via `agent-ready`. Supports targeting specific tickets (`/github-worker for issue #12`), milestones (`for the v1.0 milestone`), labels (`with priority:high label`), or baseline branches (`/github-worker against develop branch`).
- **Persistent Configuration (`/setup-github-worker`)**: Interactively establishes and records project or global worker policies directly in `AGENTS.md`.
- **Workflow State Management**: Manages state progression through labels (`status:todo`, `status:in-progress`, `status:waiting-on-user`, `status:in-review`, `status:done`).
- **Parallel Subagent Dispatch**: Spawns isolated `architect` subagents in dedicated git worktrees (`.worktrees/issue-<number>`), isolating builds and tests.
- **Dynamic Rebasing & Merge Safety**: Automatically rebases cleanly against upstream changes, resolves merge conflicts, and keeps PRs in `status:in-review` for human approval by default.
- **TDD Quality Gate**: Enforces Test-Driven Development (Red -> Green -> Refactor) and empirical verification before opening Pull Requests.
- **CI / GitHub Actions Gating**: Automatically watches PR status checks on repositories with active GitHub Actions workflows, ensuring all CI tests pass before dispatching peer reviewers.
- **3-Axis Peer Code Review**: Automatically dispatches parallel read-only review subagents (`spec-reviewer`, `standards-reviewer`, `security-reviewer`) to evaluate changes against observable predicates.

---

## Companion UI Board

Looking for the live Kanban auxiliary side pane? Install the standalone companion UI plugin:

👉 [**`rrivera/agy-github-worker-board`**](https://github.com/rrivera/agy-github-worker-board)

The companion board runs as an isolated sidecar webview in Antigravity's auxiliary side pane, providing real-time issue cards and GitHub navigation with zero AI token overhead.

---

## Included Skills

This plugin provides two complementary skills:

- [**`/github-worker`**](skills/github-worker/): The core autonomous execution engine. Polls `agent-ready` issues, creates isolated git worktrees, enforces TDD, rebases against the baseline branch, gates on GitHub Actions CI, runs 3-axis peer code reviews (`spec`, `standards`, `security`), and manages PR workflows.
- [**`/setup-github-worker`**](skills/setup-github-worker/): Interactive configuration wizard. Sets up and persists project or global defaults for baseline branch, merge policy (`manual` vs `auto-merge`), and CI gating rules inside `AGENTS.md`.

---

## Installation in Antigravity

Install directly from GitHub via the Antigravity CLI:

```bash
# Install the core issue worker skill
agy plugin install https://github.com/rrivera/agy-github-worker
```

Alternatively, you can clone and copy the skills directly into your global skills directory:

```bash
git clone https://github.com/rrivera/agy-github-worker /tmp/agy-github-worker
mkdir -p ~/.gemini/config/skills
cp -r /tmp/agy-github-worker/skills/* ~/.gemini/config/skills/
```

Restart Antigravity. The `/github-worker` and `/setup-github-worker` slash commands will be available across all your workspaces.

---

## Configuration (`/setup-github-worker`)

Instead of repeatedly specifying branch targets, merge policies, or CI rules in your prompts, run `/setup-github-worker` to establish persistent repository or global defaults.

### Interactive Setup Wizard
```text
/setup-github-worker
```
The wizard guides you through three key decisions and codifies your preferences into an isolated, delimited policy block inside your project's `AGENTS.md` (or globally in `~/.gemini/config/rules/AGENTS.md`):

```markdown
<!-- github-worker:config -->
## GitHub Worker Policy
- **Base Branch**: main
- **Merge Policy**: manual
- **CI Gating**: strict
- **Force Model Tier**: pro          # optional manual override: pro | flash | inherit
<!-- /github-worker:config -->
```

### Configurable Options

| Option | Values | Default | Description |
| :--- | :--- | :--- | :--- |
| **Base Branch** | `<branch-name>` | Detected default branch (e.g. `main`) | The upstream branch that feature worktrees branch from, rebase against, and target in PRs (e.g. `main`, `develop`, `release/*`). Configured via `/setup-github-worker`. |
| **Merge Policy** | `manual` \| `auto-merge` | `manual` | • **`manual`**: Safe default. Completes worktrees, passes CI, collects 3 peer reviews, sets `status:in-review`, and pauses for human approval.<br>• **`auto-merge`**: Autonomous completion. Automatically squash-merges the PR, deletes the remote branch, and marks `status:done` once CI passes and all 3 peer reviews approve. Configured via `/setup-github-worker`. |
| **CI Gating** | `strict` \| `permissive` | `strict` | • **`strict`**: Monitors GitHub Actions workflow runs on open PRs and blocks peer review dispatch until all checks succeed.<br>• **`permissive`**: Bypasses GitHub Actions status polling, relying strictly on the local test suite executed during development. Configured via `/setup-github-worker`. |
| **Force Model Tier** | `pro` \| `flash` \| `inherit` | *(Unspecified / Role Matrix)* | *Optional manual setting in `AGENTS.md`*:<br>• **Unspecified (Default)**: The orchestrator automatically passes role-matched tiers to `invoke_subagent`—`architect` **always** uses `"pro"` (the flagship model, e.g. Argon 4) even inside a Flash session, while reviewers follow the PR complexity matrix and mechanical workers use `"flash"`.<br>• **`pro`**: Forces `"pro"` across all subagents (`architect` and all reviewers).<br>• **`flash`**: Forces `"flash"` across all subagents.<br>• **`inherit`**: Subagents inherit the active orchestrator session model. |

### Precedence Hierarchy

When `/github-worker` executes, preferences are resolved in the following order:

1. **Prompt Instructions**: Any explicit request in your prompt takes highest priority (e.g., `/github-worker against develop branch`, `auto-merge on approval`).
2. **Project Policy (`./AGENTS.md` or `.agents/rules/AGENTS.md`)**: Checked next for the `<!-- github-worker:config -->` section.
3. **Global Policy (`~/.gemini/config/rules/AGENTS.md`)**: Used if no project-level policy exists.
4. **Built-in Defaults**: Detected repository default branch, `manual` merge policy, and `strict` CI gating.

---

## Usage

### 1. Interactive Policy Setup
Run the setup wizard to configure or update your repository preferences:
```text
/setup-github-worker
```

### 2. Default Run (Poll All Actionable `agent-ready` Issues Against Configured Base)
```text
/github-worker
```

### 3. Targeting a Specific Baseline Branch
```text
/github-worker against develop branch
/github-worker targeting staging
```

### 4. Targeted Issue Run
```text
/github-worker for issue #12
/github-worker resolve issues 12 and 15
```

### 5. Milestone or Label Filtered Run
```text
/github-worker for the v1.0 milestone
/github-worker with priority:high label
```

### 6. Multi-Option Targeting & Auto-Merge
```text
/github-worker for issue #12 against develop branch. Proceed to merge on approval and mark done without my review.
```

---

## License

MIT
