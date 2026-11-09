---
name: github-worker
description: Use when polling, triaging, or executing open GitHub issues labeled "agent-ready" via gh CLI without a GitHub Projects board.
---

# GitHub Issue Worker Skill (`github-worker`)

Polls a GitHub repository's open `agent-ready` issues via `gh` CLI, dispatches parallel **`architect`** subagents (`define_subagent` + `invoke_subagent`) to plan and implement solutions in isolated git worktrees, coordinates 3-axis complexity-scaled peer PR reviews, and manages label-driven state transitions through automated merge and issue completion (`status:done`).

---

## 1. Prerequisites & Target Repository Resolution

1. **GitHub CLI (`gh`)**: Verify `gh auth status` succeeds with `repo` scope.
2. **Target Repository (`REPO`)**:
   - Inside a git repository, resolve `OWNER/REPO` via:
     ```bash
     REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
     ```
   - If run outside a git repository (or if `gh repo view` fails), **ask the user** for the target repository (`OWNER/REPO`) and local clone path before proceeding.
   - Pass `-R "$REPO"` to all `gh` commands.

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

Fetch open `agent-ready` issues, open PRs, and inline PR review comments, then run this single `jq` filter to merge issue comments, PR issue-thread comments, inline PR diff comments, and PR reviews into one chronological timeline by timestamp (`createdAt` / `submittedAt` / `created_at`) and classify each issue:

```bash
ISSUES_JSON=$(gh issue list -R "$REPO" --state open --label "agent-ready" --limit 100 \
  --json number,title,url,body,labels,comments)
PRS_JSON=$(gh pr list -R "$REPO" --state open --limit 100 \
  --json number,headRefName,url,comments,reviews)
INLINE_COMMENTS_JSON=$(gh api "repos/$REPO/pulls/comments?per_page=100" 2>/dev/null || echo "[]")

jq -n --argjson issues "$ISSUES_JSON" --argjson prs "$PRS_JSON" --argjson inlines "$INLINE_COMMENTS_JSON" '
  $issues | map(
    . as $issue |
    ("feat/issue-" + ($issue.number | tostring)) as $branch |
    ($prs | map(select(.headRefName == $branch)) | .[0] // null) as $pr |
    ($issue.labels | map(.name)) as $labels |
    (
      if ($labels | index("status:done")) then "Done"
      elif ($labels | index("status:in-review")) then "In Review"
      elif ($labels | index("status:in-progress")) then "In Progress"
      elif ($labels | index("status:waiting-on-user")) then "Waiting on User"
      else "Todo"
      end
    ) as $status |
    select($status != "Done") |
    (
      [
        ($issue.comments // [] | map({
          source: "issue_comment",
          author: .author.login,
          body: (.body // ""),
          timestamp: .createdAt
        })),
        ($pr.comments // [] | map({
          source: "pr_comment",
          author: .author.login,
          body: (.body // ""),
          timestamp: .createdAt
        })),
        ($inlines // [] | map(
          select($pr != null and ((.pull_request_url // "") | endswith("/" + ($pr.number | tostring)))) | {
            source: "pr_inline_comment",
            author: .user.login,
            body: (.body // ""),
            timestamp: .created_at
          }
        )),
        ($pr.reviews // [] | map(select((.body // "") != "" or .state == "APPROVED" or .state == "CHANGES_REQUESTED") | {
          source: "pr_review",
          author: .author.login,
          state: .state,
          body: (.body // ""),
          timestamp: (.submittedAt // .createdAt)
        }))
      ]
      | flatten
      | map(select(.timestamp != null))
      | sort_by(.timestamp)
      | map(. + {
          is_agent: (.body | contains("<!-- antigravity-agent:")),
          requests_changes: (
            (.body | contains("<!-- antigravity-agent:")) and
            ((.body | contains("verdict=REQUEST_CHANGES")) or (.body | contains("Verdict: REQUEST_CHANGES")) or (.state == "CHANGES_REQUESTED"))
          )
        })
    ) as $timeline |
    ($timeline | map(.is_agent) | rindex(true)) as $last_agent_idx |
    (if $last_agent_idx == null then null else $timeline[$last_agent_idx] end) as $last_agent_event |
    (if $last_agent_idx == null then $timeline else $timeline[($last_agent_idx + 1):] end | map(select(.is_agent | not))) as $latest_human |
    (
      if $status == "Todo" then
        if $last_agent_idx == null then "NEEDS_PLAN"
        elif ($latest_human | length) > 0 then "USER_REPLIED"
        else "WAITING_ON_USER"
        end
      elif ($latest_human | length) > 0 then "USER_REPLIED"
      elif ($status == "In Progress" and $last_agent_idx == null) then "NEEDS_PLAN"
      elif ($status == "In Progress" and ($last_agent_event.requests_changes // false)) then "NEEDS_REVISION"
      else "WAITING_ON_USER"
      end
    ) as $action |
    {
      issue_number: $issue.number,
      title: $issue.title,
      url: $issue.url,
      body: $issue.body,
      status: $status,
      labels: $labels,
      pr_number: ($pr.number // null),
      actionable: ($action != "WAITING_ON_USER"),
      action: $action,
      latest_human_comments: $latest_human
    }
  )
'
```

- If **no issues have `actionable: true`**: Report `"Repository is idle (no actionable agent-ready issues)"` and stop.
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
   git fetch origin main
   git worktree add .worktrees/issue-<NUM> -b "feat/issue-<NUM>" origin/main
   ```
4. **TDD & Worker Delegation**: Write failing tests at public seams first (Red), implement or delegate subtasks to complexity-matched worker subagents (Green), and refactor with complete codebase-idiomatic doc comments (Refactor).
5. **Mandatory Quality Gates**: Inspect repository config (`Makefile`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `.github/workflows/`) and pass all tests, race detectors, linters, typecheckers, and builds before committing.
6. **Commit, Push & Create PR**: Commit changes, `git push -u origin "feat/issue-<NUM>"`, and create the PR via `gh pr create -R "$REPO" --base main --head "feat/issue-<NUM>" --title "feat: <title> (#<NUM>)" --body-file <PR_BODY_MD>`.

### Flow B: `USER_REPLIED` or `NEEDS_REVISION` (Existing Worktree / Open PR)
1. **Transition Label**: Ensure `<NUM>` is labeled `status:in-progress`.
2. **Reuse or Reattach Worktree (Do Not Run `git worktree add -b`)**:
   - If `.worktrees/issue-<NUM>` exists, check out `feat/issue-<NUM>` and fast-forward pull from `origin`.
   - If `.worktrees/issue-<NUM>` was removed but `origin/feat/issue-<NUM>` exists, run `git worktree add ".worktrees/issue-<NUM>" -B "feat/issue-<NUM>" "origin/feat/issue-<NUM>"`.
3. **Apply Delta Fixes & Re-Verify Quality Gates**:
   - Address every human comment or peer review finding in `.worktrees/issue-<NUM>`, add regression tests, and re-run all quality gates.
4. **Commit, Push & Update Without `gh pr create`**:
   - Commit changes and `git push origin "feat/issue-<NUM>"`.
   - If an open PR already exists for `feat/issue-<NUM>`, do **not** run `gh pr create`; post a concise update comment ending with `<!-- antigravity-agent: phase=in-progress -->`.

---

## 7. Automated 3-Axis Peer Review Loop & Merge Completion (`status:done`)

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
