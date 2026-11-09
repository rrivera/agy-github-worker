---
name: github-worker
description: Use when polling, triaging, or executing open GitHub issues labeled "agent-ready" via gh CLI without a GitHub Projects board.
---

# GitHub Issue Worker Skill (`github-worker`)

Polls a GitHub repository's open `agent-ready` issues via `gh` CLI, dispatches parallel **`architect`** subagents (`define_subagent` + `invoke_subagent`) to plan and implement solutions in isolated git worktrees, coordinates 3-axis complexity-scaled peer PR reviews, and manages label-driven state transitions through automated merge and issue completion (`status:done`).

---

## 1. Prerequisites, Rate-Limit Resilience & Scoped Execution

1. **GitHub CLI (`gh`)**: Verify `gh auth status` succeeds with `repo` scope.
2. **Target Repository (`REPO`)**:
   - Inside a git repository, resolve `OWNER/REPO` via:
     ```bash
     REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
     ```
   - If run outside a git repository (or if `gh repo view` fails), **ask the user** for the target repository (`OWNER/REPO`) and local clone path before proceeding.
   - Pass `-R "$REPO"` to all `gh` commands.
3. **Baseline Branch Resolution (`BASE_BRANCH`)**:
   - If the user explicitly specifies a target baseline branch (e.g. `/github-worker against develop branch`, `targeting develop`, `on release-1.0 branch`), use that branch.
   - Otherwise, dynamically detect the repository's configured default branch:
     ```bash
     BASE_BRANCH=$(gh repo view -R "$REPO" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
     ```
   - All worktree creations, upstream rebases, PR base branches, and merge fast-forwards use `<BASE_BRANCH>`.
4. **Checking & Monitoring GitHub API Rate Limits**:
   - Check current rate limit quota before initiating polling or subagent operations:
     ```bash
     gh api rate_limit --jq '.rate | {limit, remaining, reset: (.reset | todate)}'
     ```
   - **Handling Low Quotas & Secondary Rate Limits**:
     - If `remaining < 20`: Quota is nearly exhausted. Note the `reset` timestamp and pause batch operations or subagent dispatches until quota restores.
     - If any `gh` command fails with HTTP 403 or 429 ("secondary rate limit" or "rate limit exceeded"): Inspect the reset timestamp via `gh api rate_limit` and wait for the reset window to elapse rather than retrying immediately in a tight loop.
5. **Targeted Scoping & Intent Detection**:
   The user can guide execution directly in their prompt:
   - **Baseline Branch**: e.g. `/github-worker against develop branch`, `/github-worker targeting staging`.
   - **Specific Issues**: e.g. `/github-worker for issue #12`, `/github-worker resolve 12 and 15`.
   - **Target Milestone**: e.g. `/github-worker for the v1.0 milestone`, `focus on milestone v1.0`.
   - **Target Label**: e.g. `/github-worker with priority:high label`, `triage bugs`.
   - **Auto-Merge Preference**: e.g. `/github-worker merge when approved and mark done without my review`.
   - If no specific scope is mentioned, default to polling **all** open `agent-ready` issues against the repository's default branch.

---

## 2. Opt-In Gate (`agent-ready`) & Label-Based Workflow State Machine

The worker **only** operates on issues carrying the **`agent-ready`** label. Removing `agent-ready` immediately opts an issue out of automated pickup.

| Workflow State | Required Labels | Issue State | Meaning & Actionability |
| :--- | :--- | :--- | :--- |
| **Todo** | `agent-ready` + (`status:todo` or no `status:*` label) | `OPEN` | **`NEEDS_PLAN`** if no comment contains `<!-- antigravity-agent:`; **`USER_REPLIED`** if the latest comment across the issue and linked PR is from a human. |
| **In Progress** | `agent-ready` + `status:in-progress` | `OPEN` | Active research, TDD implementation, and peer review loop. **`NEEDS_PLAN`** if no agent comment exists yet; **`NEEDS_REVISION`** if the latest agent review marker has `verdict=REQUEST_CHANGES`; **`USER_REPLIED`** if a human comments after the latest agent activity. |
| **Waiting on User** | `agent-ready` + `status:waiting-on-user` | `OPEN` | Paused awaiting human clarification or escalation resolution (e.g., after hitting the 3-cycle review cap). Actionable (**`USER_REPLIED`**) only when a human posts a comment or review after the latest `<!-- antigravity-agent:` marker. |
| **In Review** | `agent-ready` + `status:in-review` | `OPEN` | Open PR has 3/3 `APPROVE` peer reviews, rebased and verified against `<BASE_BRANCH>`. Stays in `status:in-review` for manual human merge by default (only auto-merges if explicitly requested by the user); becomes **`USER_REPLIED`** if a human posts new comments (including inline diff reviews). |
| **Done** | `agent-ready` + `status:done` | `CLOSED` | PR squash-merged, remote/local worktree branch cleaned up, and issue closed with `status:done`. Ignored during polling. |

### Helper Pattern: Transitioning an Issue's Status Label
Whenever transitioning an issue `<NUM>` to `<TARGET_STATUS>` (`status:todo`, `status:in-progress`, `status:waiting-on-user`, `status:in-review`, `status:done`), ensure the label exists and swap `status:*` labels while preserving `agent-ready` and all other labels:

```bash
# Colors: status:todo (0E8A16), status:in-progress (1D76DB), status:in-review (FBCA04), status:waiting-on-user (D93F0B), status:done (5319E7)
gh label create "<TARGET_STATUS>" -R "$REPO" --color "<HEX_COLOR>" --force
gh issue edit <NUM> -R "$REPO" \
  --add-label "<TARGET_STATUS>" \
  --remove-label "<ALL_OTHER_STATUS_LABELS_COMMA_SEPARATED>"
```

---

## 3. Polling & Classifying Actionable Issues

Fetch open issues, associated pull requests, and review comments to classify each issue's actionability state.

### A. Data Retrieval & Query Construction

1. **Issues (`gh issue list`)**:
   Fetch open issues labeled `agent-ready`:
   ```bash
   gh issue list -R "$REPO" --state open --label "agent-ready" --limit 100 \
     --json number,title,url,body,labels,comments
   ```
   - **Milestone filter**: If a milestone was specified (e.g. `for the v1.0 milestone`), append `--milestone "<NAME>"`.
   - **Additional label filter**: If extra labels were specified (e.g. `with priority:high label`), append `--label "<LABEL>"`.
   - **Specific issue filter**: If target issue numbers were specified (e.g. `for issue #12`), filter the returned issue list by issue number or query the specific issues directly via `gh issue view <NUM>`.

2. **Pull Requests (`gh pr list`)**:
   Fetch open pull requests to associate branch names with issues:
   ```bash
   gh pr list -R "$REPO" --state open --limit 100 \
     --json number,headRefName,url,comments,reviews
   ```

3. **Inline Review Comments (`gh api`)**:
   Fetch inline diff review comments across pull requests:
   ```bash
   gh api "repos/$REPO/pulls/comments?per_page=100" 2>/dev/null || echo "[]"
   ```

### B. Timeline Aggregation & Action Classification

Merge issue comments, PR thread comments, inline diff reviews, and PR review events chronologically by timestamp (`createdAt` / `submittedAt` / `created_at`).

- **Evaluate Actionability State**:
  - If no agent comment or marker exists yet (`<!-- antigravity-agent:`): issue is **`NEEDS_PLAN`**.
  - If a human commented or reviewed after the latest agent event: issue is **`USER_REPLIED`**.
  - If the latest agent event is a review requesting changes (`REQUEST_CHANGES`): issue is **`NEEDS_REVISION`**.
  - Otherwise, the issue is **`WAITING_ON_USER`** (not actionable).
- You can execute this classification logic via `jq` using the canonical filter in [`references/timeline-filter.jq`](references/timeline-filter.jq) or by evaluating the merged JSON timeline.

- If **no issues have `actionable: true`**:
  - If specific issue numbers were targeted (e.g. `#12`), verify if the issue exists and whether it lacks `agent-ready`. If the user explicitly requested to work on that issue, apply `agent-ready` (`gh issue edit <NUM> -R "$REPO" --add-label "agent-ready"`) and rerun polling.
  - Otherwise, report `"Repository is idle (no actionable agent-ready issues)"` and stop.
- If **1 or more issues have `actionable: true`**: Proceed immediately to **Section 4** and **spawn dedicated `architect` subagents for all actionable issues in parallel**.

---

## 4. In-Session Subagent Dispatch & Model Configuration (`define_subagent` + `invoke_subagent`)

The main orchestrator thread runs issue polling, label transitions, and top-level routing, while delegating each actionable issue to an **`architect`** subagent and PR reviews to **reviewer** subagents (`spec-reviewer`, `standards-reviewer`, `security-reviewer`).

1. **Register Dedicated Subagent Types via `define_subagent`**:
   Never use `TypeName: "self"` (which forces parent model inheritance). Define dedicated subagent types using the canonical templates in [`references/architect-prompt.md`](references/architect-prompt.md) and [`references/reviewer-prompts.md`](references/reviewer-prompts.md):
   - `architect` (`EnableWriteTools: true`, `EnableSubagentTools: true`): Researches the issue, posts the plan, manages `.worktrees/issue-<NUM>`, and either executes or delegates subtasks to worker subagents.
   - `spec-reviewer` (`EnableWriteTools: true`, `EnableSubagentTools: false`): Cold-start Spec & Requirement Compliance reviewer.
   - `standards-reviewer` (`EnableWriteTools: true`, `EnableSubagentTools: false`): Cold-start Standards, DRYness & Code Smell reviewer.
   - `security-reviewer` (`EnableWriteTools: true`, `EnableSubagentTools: false`): Cold-start Security & Vulnerability reviewer.

2. **How to Pass `Model` and `Reasoning-Level` to `invoke_subagent`**:
   - Pass the model tier (`"flash_lite"`, `"flash"`, or `"pro"`) via the `Model` argument of `invoke_subagent`.
   - Because `invoke_subagent` only accepts `Model`, `Prompt`, `Role`, `TypeName`, and `Workspace` in its tool schema, **always pass `Reasoning-Level: <low|medium|high>` as an explicit directive line at the top of the `Prompt` argument** (or inside `SystemPrompt` in `define_subagent`).

---

## 5. Comment State Marker Protocol (MANDATORY)

Every GitHub issue comment and PR review body posted by an agent must end with a hidden HTML state marker (`<!-- antigravity-agent: ... -->`) so subsequent polling runs distinguish agent messages from human replies:

- **Issue Comments (`plan-proposed`, `in-progress`, `question`, `review-ready`)**:
  ```markdown
  <!-- antigravity-agent: phase=<plan-proposed|in-progress|question|review-ready> -->
  ```
- **Pull Request Descriptions (`gh pr create`)**:
  Include `Closes #<NUM>` and a summary of implementation and test coverage.
- **Peer Code Reviews (`gh pr review`)**:
  ```markdown
  <!-- antigravity-agent: phase=pr-review role=<spec-reviewer|standards-reviewer|security-reviewer> verdict=<APPROVE|REQUEST_CHANGES> -->
  ```

---

## 6. Architect Execution Flows (`NEEDS_PLAN` vs. `USER_REPLIED` / `NEEDS_REVISION`)

Follow the full contract in [`references/architect-prompt.md`](references/architect-prompt.md) when dispatching `architect` (`Model: "pro"`, prompt directive `Reasoning-Level: medium` or `high` for complex architecture):

### Flow A: `NEEDS_PLAN` (Fresh Ticket)
1. **Transition Label**: Set `status:in-progress` on `<NUM>` (Section 2).
2. **Investigate & Post Plan**: Read issue and codebase in read-only mode, author `<PLAN_MD>` (architecture, public testing seams, table-driven tests, subtask delegation plan, and `<!-- antigravity-agent: phase=plan-proposed -->`), and post via `gh issue comment <NUM> -R "$REPO" --body-file <PLAN_MD>`. Proceed immediately to implementation.
3. **Create Isolated Worktree**:
   ```bash
   git fetch origin "<BASE_BRANCH>"
   git worktree add .worktrees/issue-<NUM> -b "feat/issue-<NUM>" "origin/<BASE_BRANCH>"
   ```
4. **TDD & Worker Delegation**: Write failing tests at public seams first (Red), implement or delegate subtasks to complexity-matched worker subagents (Green), and refactor with complete codebase-idiomatic doc comments (Refactor).
5. **Upstream Rebase, Conflict Resolution & Quality Gates**:
   - Fetch upstream changes from `origin/<BASE_BRANCH>`. If `<BASE_BRANCH>` has moved ahead while working, rebase the feature branch onto `origin/<BASE_BRANCH>` and resolve any merge conflicts cleanly before proceeding.
   - Inspect repository config (`Makefile`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `.github/workflows/`) and ensure all unit tests, race detectors, linters, typecheckers, and build checks pass cleanly.
6. **Commit, Push & Open PR**:
   - Commit the changes and push the feature branch to `origin`.
   - Open a Pull Request referencing the issue (`Closes #<NUM>`) targeting `--base "<BASE_BRANCH>"` with a summary of changes and test coverage via `gh pr create`.

### Flow B: `USER_REPLIED` or `NEEDS_REVISION` (Existing Worktree / Open PR)
1. **Transition Label**: Ensure `<NUM>` is labeled `status:in-progress`.
2. **Reuse or Reattach Worktree**:
   - Check out the existing `feat/issue-<NUM>` branch in `.worktrees/issue-<NUM>` (or recreate the worktree tracking `origin/feat/issue-<NUM>` if it was previously removed).
3. **Upstream Rebase, Delta Fixes & Quality Gates**:
   - Fetch `origin/<BASE_BRANCH>` and rebase onto latest `<BASE_BRANCH>`, resolving any conflicts cleanly.
   - Address every human comment, peer review finding, or CI failure inside `.worktrees/issue-<NUM>`, add regression tests, and re-run all quality gates until passing.
4. **Commit, Push & Update (Skip `gh pr create` if PR Exists)**:
   - Commit changes and push to `origin`.
   - If an open PR already exists, do not recreate it; post a concise status comment ending with `<!-- antigravity-agent: phase=in-progress -->`.

---

## 7. CI Gating, 3-Axis Peer Review Loop & Merge Completion (`status:done`)

### Step 7.0: CI / GitHub Actions Check Gating (Prior to Reviewer Dispatch)

If the repository has active GitHub Actions or CI workflows configured:
1. **Watch CI Status**: Wait for CI checks on the PR branch to conclude (`gh pr checks <PR_NUM> --watch`).
2. **Handle Failures**: If any check fails, inspect the failure logs (`gh run view --log-failed`) and route the issue back to the `architect` subagent as Flow B (`NEEDS_REVISION`) to resolve the regression before requesting reviews.
3. **Proceed on Green**: Once all checks pass (or if no CI workflows exist), proceed immediately to peer review dispatch.

Before spawning the 3 reviewer subagents on an open PR, classify PR complexity using:
```bash
gh pr view <PR_NUM> -R "$REPO" --json additions,deletions,changedFiles,files
```

### Complexity-Scaled Reviewer Selection Matrix (Model & Reasoning Only)

The complexity tier only selects each reviewer's `Model` and `Reasoning-Level` (passed as `Model` in `invoke_subagent` and `Reasoning-Level: <Level>` in the reviewer's `Prompt`). The actual review checks in [`references/reviewer-prompts.md`](references/reviewer-prompts.md) are triggered directly by what `gh pr diff` touches, so an underestimated complexity tier never skips required checks:

| Complexity Tier | PR Size & Scope Characteristics (Any Codebase) | Spec Reviewer (`spec-reviewer`) | Standards Reviewer (`standards-reviewer`) | Security Reviewer (`security-reviewer`) |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Small / Localized / Non-Behavioral** | < ~150 lines changed; isolated config, documentation, constants, formatting, or simple presentation tweaks with no new I/O, state machines, or external boundaries | `Model: "flash"`<br>Prompt: `Reasoning-Level: medium` | `Model: "flash"`<br>Prompt: `Reasoning-Level: medium` | `Model: "flash"`<br>Prompt: `Reasoning-Level: medium` |
| **Tier 2: Medium / Standard Feature or Module** | ~150–400 lines changed; standard feature logic, CLI commands, API/CRUD handlers, data transformations, or localized module refactoring without concurrency or auth changes | `Model: "pro"` (or `"flash"`)<br>Prompt: `Reasoning-Level: medium` (or `high`) | `Model: "flash"` (or `"pro"`)<br>Prompt: `Reasoning-Level: medium` (or `high`) | `Model: "pro"` (or `"flash"`)<br>Prompt: `Reasoning-Level: medium` (or `high`) |
| **Tier 3: High / Core Architecture / Security-Critical** | Multi-package/module architecture, transactions, concurrency/async coordination, auth/permissions, untrusted file/network parsing, or complex state machines | `Model: "pro"`<br>Prompt: `Reasoning-Level: high` | `Model: "pro"`<br>Prompt: `Reasoning-Level: high` | `Model: "pro"`<br>Prompt: `Reasoning-Level: high` |

### Reviewer Execution, Iteration Cap & Fallback Escalation
1. **Spawn Parallel Reviewers**: Invoke `spec-reviewer`, `standards-reviewer`, and `security-reviewer` in parallel using the diff-driven predicates and submission commands in [`references/reviewer-prompts.md`](references/reviewer-prompts.md).
2. **Feedback Loop (Max 3 Review Cycles)**:
   - If any reviewer submits `REQUEST_CHANGES`, message the `architect` subagent to execute **Flow B (`NEEDS_REVISION`)** inside `.worktrees/issue-<NUM>`, re-verify quality gates, commit, and push.
   - Re-trigger the rejecting reviewer(s) on the updated diff (up to **3 total review cycles**).
3. **Fallback Transition When 3-Cycle Cap Is Reached**:
   - If any reviewer still submits `REQUEST_CHANGES` on cycle 3, **stop iterating**.
   - Post an escalation summary to the issue detailing the remaining unresolved review findings, ending with `<!-- antigravity-agent: phase=question -->`.
   - Transition the issue label to `status:waiting-on-user`:
     ```bash
     gh label create "status:waiting-on-user" -R "$REPO" --color "D93F0B" --description "Blocked awaiting human clarification or review resolution" --force
     gh issue edit <NUM> -R "$REPO" \
       --add-label "status:waiting-on-user" \
       --remove-label "status:todo,status:in-progress,status:in-review,status:done"
     ```

### Rebase, Post-Rebase Quality Verification, Hand-Off & Merge Policy

Once all 3 peer reviewers record `APPROVE`:

1. **Final Upstream Rebase & Post-Rebase Quality Verification**:
   - Rebase the feature branch onto the latest `origin/<BASE_BRANCH>` in `.worktrees/issue-<NUM>` and resolve any merge conflicts.
   - If commits changed during rebase, re-run all mandatory quality gates (tests, linters, typecheckers, builds) before pushing to `origin`.
   - Confirm the pull request reports a clean mergeable status on GitHub (`gh pr view <PR_NUM> -R "$REPO" --json mergeable,mergeStateStatus`).

2. **Post `review-ready` Summary, Transition to `status:in-review` & Cleanup Worktree**:
   - Post the completion summary (ending with `<!-- antigravity-agent: phase=review-ready -->`) via `gh issue comment <NUM> -R "$REPO" --body-file <SUMMARY_MD>`.
   - Transition the issue label to `status:in-review` (Section 2).
   - Clean up the local worktree:
     ```bash
     git worktree remove ".worktrees/issue-<NUM>" --force
     ```

3. **Merge Policy: Manual Merge by Default vs. Explicit Auto-Merge Preference**:
   - **Default Behavior (Do Not Merge Automatically)**:
     By default, the worker **never** merges the PR or closes the issue. It stops here at `status:in-review` and awaits human review and manual merge. Notify the user with links to the issue, PR, and review reports.
   - **Explicit Opt-In (User Auto-Merge Preference)**:
     Only proceed to squash-merge and mark `status:done` if the user explicitly provided an auto-merge preference (for example: `"pull the issues with /github-worker. Proceed to merge them and mark as done without my review"`, `"auto-merge on approval"`, or `"merge automatically"`):
     ```bash
     # 1. Squash-merge PR and delete remote branch
     gh pr merge <PR_NUM> -R "$REPO" --squash --delete-branch

     # 2. Fast-forward local base branch
     git checkout "<BASE_BRANCH>" && git pull --ff-only origin "<BASE_BRANCH>"

     # 3. Transition issue label to status:done and ensure issue is closed
     gh label create "status:done" -R "$REPO" --color "5319E7" --description "Merged and completed" --force
     gh issue edit <NUM> -R "$REPO" \
       --add-label "status:done" \
       --remove-label "status:todo,status:in-progress,status:waiting-on-user,status:in-review"
     gh issue close <NUM> -R "$REPO"
     ```

**Completion Criterion**: Every actionable `agent-ready` issue has either completed all 3 peer reviews (`APPROVE`), passed post-rebase quality gates, and transitioned to `status:in-review` awaiting manual human merge (or merged cleanly to `<BASE_BRANCH>` with its worktree removed and label set to `status:done` if the user explicitly enabled auto-merge), or escalated cleanly to `status:waiting-on-user` with a `phase=question` comment.
