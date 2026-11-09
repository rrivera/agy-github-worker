---
name: github-worker
description: Use when polling, triaging, or executing open GitHub issues labeled "agent-ready" via gh CLI without a GitHub Projects board.
---

# GitHub Issue Worker Skill (`github-worker`)

Polls a GitHub repository's open `agent-ready` issues via `gh` CLI, dispatches parallel **`architect`** subagents (`define_subagent` + `invoke_subagent`) to plan and implement solutions in isolated git worktrees, coordinates 3-axis complexity-scaled peer PR reviews, and manages label-driven state transitions through automated merge and issue completion (`status:done`).

---

## 1. Prerequisites, Rate-Limit Resilience & Scoped Invocation

1. **GitHub CLI (`gh`)**: Verify `gh auth status` succeeds with `repo` scope.
2. **Target Repository (`REPO`)**:
   - Inside a git repository, resolve `OWNER/REPO` via:
     ```bash
     REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
     ```
   - If run outside a git repository (or if `gh repo view` fails), **ask the user** for the target repository (`OWNER/REPO`) and local clone path before proceeding.
   - Pass `-R "$REPO"` to all `gh` commands.
3. **Rate-Limit Resilience & Exponential Backoff**:
   - Inspect API quota before launching batch subagent operations:
     ```bash
     RATE_REMAINING=$(gh api rate_limit --jq '.rate.remaining' 2>/dev/null || echo "100")
     if [ "$RATE_REMAINING" -lt 20 ]; then
       RESET_TIME=$(gh api rate_limit --jq '.rate.reset | todate' 2>/dev/null)
       echo "Warning: GitHub API rate limit low ($RATE_REMAINING remaining, resets at $RESET_TIME). Throttling..." >&2
     fi
     ```
   - Wrap repeated or mutation commands with exponential backoff and jitter (`gh_retry`) to handle secondary rate limits (HTTP 403 / 429) defensively:
     ```bash
     gh_retry() {
       local max_attempts=5
       local delay=2
       local attempt=1
       while true; do
         "$@" && return 0
         local exit_code=$?
         if [ $attempt -ge $max_attempts ]; then
           echo "Error: gh command failed after $max_attempts attempts: $*" >&2
           return $exit_code
         fi
         local jitter=$(( (RANDOM % 1000) / 1000 ))
         echo "Warning: gh command failed (attempt $attempt/$max_attempts). Retrying in $((delay + jitter))s..." >&2
         sleep $((delay + jitter))
         delay=$((delay * 2))
         attempt=$((attempt + 1))
       done
     }
     ```
4. **Scoped / Targeted Invocation Detection**:
   The user may invoke the worker with explicit scope arguments in their prompt:
   - **Specific Issues**: e.g., `/github-worker #12`, `/github-worker 12, 15`, `"work on issue #12"`. Parse out issue numbers: `TARGET_ISSUES=(12 15)`.
   - **Target Milestone**: e.g., `/github-worker --milestone "v1.0"`, `"focus on v1.0 milestone"`. Parse: `TARGET_MILESTONE="v1.0"`.
   - **Target Extra Label**: e.g., `/github-worker --label priority:high`, `"triage high-priority issues"`. Parse: `TARGET_LABEL="priority:high"`.
   - If no scoping arguments are provided, default to polling **all** open `agent-ready` issues.

---

## 2. Opt-In Gate (`agent-ready`) & Label-Based Workflow State Machine

The worker **only** operates on issues carrying the **`agent-ready`** label. Removing `agent-ready` immediately opts an issue out of automated pickup.

| Workflow State | Required Labels | Issue State | Meaning & Actionability |
| :--- | :--- | :--- | :--- |
| **Todo** | `agent-ready` + (`status:todo` or no `status:*` label) | `OPEN` | **`NEEDS_PLAN`** if no comment contains `<!-- antigravity-agent:`; **`USER_REPLIED`** if the latest comment across the issue and linked PR is from a human. |
| **In Progress** | `agent-ready` + `status:in-progress` | `OPEN` | Active research, TDD implementation, and peer review loop. **`NEEDS_PLAN`** if no agent comment exists yet; **`NEEDS_REVISION`** if the latest agent review marker has `verdict=REQUEST_CHANGES`; **`USER_REPLIED`** if a human comments after the latest agent activity. |
| **Waiting on User** | `agent-ready` + `status:waiting-on-user` | `OPEN` | Paused awaiting human clarification or escalation resolution (e.g., after hitting the 3-cycle review cap). Actionable (**`USER_REPLIED`**) only when a human posts a comment or review after the latest `<!-- antigravity-agent:` marker. |
| **In Review** | `agent-ready` + `status:in-review` | `OPEN` | Open PR has 3/3 `APPROVE` peer reviews, rebased and verified against `main`. Stays in `status:in-review` for manual human merge by default (only auto-merges if explicitly instructed in conversation); becomes **`USER_REPLIED`** if a human posts new comments (including inline diff reviews). |
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

## 3. Polling & Classifying Actionable Issues (Merged Issue + PR Timeline `jq` Filter)

Fetch open `agent-ready` issues (applying any scoped flags like target issues, `--milestone`, or extra `--label`), open PRs, and inline PR review comments, then run this single `jq` filter to merge issue comments, PR issue-thread comments, inline PR diff comments, and PR reviews into one chronological timeline by timestamp (`createdAt` / `submittedAt` / `created_at`) and classify each issue:

```bash
# Build scoping flags based on user invocation arguments:
EXTRA_LABEL_ARGS=()
if [ -n "$TARGET_LABEL" ]; then
  EXTRA_LABEL_ARGS+=(--label "$TARGET_LABEL")
fi

MILESTONE_ARGS=()
if [ -n "$TARGET_MILESTONE" ]; then
  MILESTONE_ARGS+=(--milestone "$TARGET_MILESTONE")
fi

# Fetch issues with retry
ISSUES_JSON=$(gh_retry gh issue list -R "$REPO" --state open --label "agent-ready" \
  "${EXTRA_LABEL_ARGS[@]}" "${MILESTONE_ARGS[@]}" --limit 100 \
  --json number,title,url,body,labels,comments)

# If specific issues were targeted by number, verify opt-in and filter:
# Example: TARGET_ISSUES_JSON='[12, 15]' or '[]' for all
TARGET_ISSUES_JSON="${TARGET_ISSUES_JSON:-[]}"

PRS_JSON=$(gh_retry gh pr list -R "$REPO" --state open --limit 100 \
  --json number,headRefName,url,comments,reviews)
INLINE_COMMENTS_JSON=$(gh_retry gh api "repos/$REPO/pulls/comments?per_page=100" 2>/dev/null || echo "[]")

# Run timeline aggregation and issue classification filter
# (Uses canonical filter in references/timeline-filter.jq)
ACTIONABLE_ISSUES_JSON=$(jq -n \
  --argjson issues "$ISSUES_JSON" \
  --argjson prs "$PRS_JSON" \
  --argjson inlines "$INLINE_COMMENTS_JSON" \
  --argjson targets "$TARGET_ISSUES_JSON" \
  -f "${SKILL_DIR:-skills/github-worker}/references/timeline-filter.jq")
```

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
2. **Investigate & Post Plan**: Read issue and codebase in read-only mode, author `<PLAN_MD>` (architecture, public testing seams, table-driven tests, subtask delegation plan, and `<!-- antigravity-agent: phase=plan-proposed -->`), and post via `gh_retry gh issue comment <NUM> -R "$REPO" --body-file <PLAN_MD>`. Proceed immediately to implementation.
3. **Create Isolated Worktree**:
   ```bash
   git fetch origin main
   git worktree add .worktrees/issue-<NUM> -b "feat/issue-<NUM>" origin/main
   ```
4. **TDD & Worker Delegation**: Write failing tests at public seams first (Red), implement or delegate subtasks to complexity-matched worker subagents (Green), and refactor with complete codebase-idiomatic doc comments (Refactor).
5. **Upstream Rebase, Conflict Resolution & Mandatory Quality Gates**:
   - Check if `origin/main` has moved ahead while working:
     ```bash
     git -C ".worktrees/issue-<NUM>" fetch origin main
     BEHIND_COUNT=$(git -C ".worktrees/issue-<NUM>" rev-list --count HEAD..origin/main)
     if [ "$BEHIND_COUNT" -gt 0 ]; then
       echo "origin/main advanced by $BEHIND_COUNT commit(s). Rebasing feat/issue-<NUM>..."
       if ! git -C ".worktrees/issue-<NUM>" rebase origin/main; then
         echo "Conflicts detected during rebase. Inspecting unmerged files..."
         CONFLICTS=$(git -C ".worktrees/issue-<NUM>" diff --name-only --diff-filter=U)
         # Resolve conflicts cleanly preserving base changes and feature requirements
         git -C ".worktrees/issue-<NUM>" add $CONFLICTS
         git -C ".worktrees/issue-<NUM>" rebase --continue
       fi
     fi
     ```
   - Inspect repository config (`Makefile`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `.github/workflows/`) and pass all tests, race detectors, linters, typecheckers, and builds before committing.
6. **Commit, Push & Create PR**: Commit changes, `git -C ".worktrees/issue-<NUM>" push --force-with-lease -u origin "feat/issue-<NUM>"`, and create the PR via `gh_retry gh pr create -R "$REPO" --base main --head "feat/issue-<NUM>" --title "feat: <title> (#<NUM>)" --body-file <PR_BODY_MD>`.

### Flow B: `USER_REPLIED` or `NEEDS_REVISION` (Existing Worktree / Open PR)
1. **Transition Label**: Ensure `<NUM>` is labeled `status:in-progress`.
2. **Reuse or Reattach Worktree (Do Not Run `git worktree add -b`)**:
   - If `.worktrees/issue-<NUM>` exists, check out `feat/issue-<NUM>` and fast-forward pull from `origin`.
   - If `.worktrees/issue-<NUM>` was removed but `origin/feat/issue-<NUM>` exists, run `git worktree add ".worktrees/issue-<NUM>" -B "feat/issue-<NUM>" "origin/feat/issue-<NUM>"`.
3. **Upstream Rebase, Delta Fixes & Re-Verify Quality Gates**:
   - Fetch `origin/main` and rebase onto latest main, resolving any conflicts cleanly.
   - Address every human comment, peer review finding, or CI failure in `.worktrees/issue-<NUM>`, add regression tests, and re-run all quality gates.
4. **Commit, Push & Update Without `gh pr create`**:
   - Commit changes and push with lease: `git -C ".worktrees/issue-<NUM>" push --force-with-lease origin "feat/issue-<NUM>"`.
   - If an open PR already exists for `feat/issue-<NUM>`, do **not** run `gh pr create`; post a concise update comment ending with `<!-- antigravity-agent: phase=in-progress -->`.

---

## 7. CI Gating, 3-Axis Peer Review Loop & Merge Completion (`status:done`)

### Step 7.0: CI / GitHub Actions Check Gating (Prior to Reviewer Dispatch)

Before dispatching peer review subagents, verify whether the repository has active GitHub Actions workflows:

```bash
WORKFLOW_COUNT=$(gh workflow list -R "$REPO" --json id -q 'length' 2>/dev/null || echo "0")

if [ "$WORKFLOW_COUNT" -gt 0 ]; then
  echo "GitHub Actions detected ($WORKFLOW_COUNT workflows). Watching CI checks for PR #<PR_NUM>..."
  if ! gh pr checks "<PR_NUM>" -R "$REPO" --watch; then
    echo "CI checks failed on PR #<PR_NUM>. Capturing failure logs..."
    FAILING_RUN_ID=$(gh run list -R "$REPO" --branch "feat/issue-<NUM>" --status failure --json databaseId -q '.[0].databaseId // empty')
    if [ -n "$FAILING_RUN_ID" ]; then
      gh run view "$FAILING_RUN_ID" -R "$REPO" --log-failed | tail -n 120
    fi
    # Do NOT dispatch peer reviewers yet. Route failure back to architect subagent as Flow B (NEEDS_REVISION) to fix.
  else
    echo "All GitHub Actions checks PASSED on PR #<PR_NUM>. Proceeding to peer review dispatch."
  fi
fi
```

If CI checks fail, pause reviewer dispatch and trigger the `architect` subagent to fix the failing tests or linter checks in `.worktrees/issue-<NUM>`, push, and wait for green checks. Once green (or if no CI workflows are configured), proceed to the peer review loop below:

Before spawning the 3 reviewer subagents on an open PR, check whether the task complexity tier is specified in the issue description. Otherwise, classify complexity using:
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

1. **Mandatory Rebase & Post-Rebase Quality Gate Verification**:
   Inside `.worktrees/issue-<NUM>`, fetch `origin/main` and rebase:
   ```bash
   PRE_REBASE_SHA=$(git -C ".worktrees/issue-<NUM>" rev-parse HEAD)
   git -C ".worktrees/issue-<NUM>" fetch origin main
   git -C ".worktrees/issue-<NUM>" rebase origin/main
   POST_REBASE_SHA=$(git -C ".worktrees/issue-<NUM>" rev-parse HEAD)
   ```
   - **If conflicts occur**: Resolve conflicts cleanly inside `.worktrees/issue-<NUM>`, continue the rebase, and **re-run all mandatory quality gates**.
   - **If `PRE_REBASE_SHA != POST_REBASE_SHA`**: Because `HEAD` changed, **re-run all mandatory quality gates** (tests, linter, typecheck, build) before pushing:
     ```bash
     git -C ".worktrees/issue-<NUM>" push --force-with-lease origin "feat/issue-<NUM>"
     ```
   - Confirm clean merge state on GitHub:
     ```bash
     gh pr view <PR_NUM> -R "$REPO" --json mergeable,mergeStateStatus
     # Must report: "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"
     ```

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
   - **Explicit Opt-In (Per-Conversation Auto-Merge Preference)**:
     Only proceed to squash-merge and mark `status:done` if the user explicitly provided an auto-merge preference in their conversation request (for example: `"pull the issues with /github-worker. Proceed to merge them and mark as done without my review"`, `"auto-merge on approval"`, or `"merge automatically"`):
     ```bash
     # 1. Squash-merge PR and delete remote branch
     gh pr merge <PR_NUM> -R "$REPO" --squash --delete-branch

     # 2. Fast-forward local main
     git checkout main && git pull --ff-only origin main

     # 3. Transition issue label to status:done and ensure issue is closed
     gh label create "status:done" -R "$REPO" --color "5319E7" --description "Merged and completed" --force
     gh issue edit <NUM> -R "$REPO" \
       --add-label "status:done" \
       --remove-label "status:todo,status:in-progress,status:waiting-on-user,status:in-review"
     gh issue close <NUM> -R "$REPO"
     ```

**Completion Criterion**: Every actionable `agent-ready` issue has either completed all 3 peer reviews (`APPROVE`), passed post-rebase quality gates, and transitioned to `status:in-review` awaiting manual human merge (or merged cleanly to `main` with its worktree removed and label set to `status:done` if the user explicitly enabled auto-merge in the conversation), or escalated cleanly to `status:waiting-on-user` with a `phase=question` comment.
