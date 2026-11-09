---
name: github-worker-setup
description: Interactive setup wizard to configure and save project or global preferences for the /github-worker skill into AGENTS.md.
---

# GitHub Worker Setup (`github-worker-setup`)

An interactive configuration wizard to establish and persist preferences for the `/github-worker` skill. It codifies baseline branches, merge automation policies, and CI gating rules into a structured configuration block inside `AGENTS.md`.

---

## 1. Preflight & Target Scope Detection

1. **Verify Git Context**:
   - Ensure the current workspace is inside a git repository:
     ```bash
     REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
     ```
   - Resolve the target repository slug via `gh repo view --json nameWithOwner -q .nameWithOwner`.
2. **Detect Current Default Branch**:
   - Query the repository's configured default branch:
     ```bash
     DEFAULT_BRANCH=$(gh repo view -R "$REPO" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
     ```
3. **Determine Target `AGENTS.md` File Scope**:
   - **Project Scope (Recommended)**: Look for `./AGENTS.md` (or `.agents/rules/AGENTS.md`). If neither exists, target `./AGENTS.md` at the repository root so preferences are version-controlled and shared with the team.
   - **Global Scope**: If the user explicitly asks for global configuration (e.g. `"set up global worker defaults"`), target `~/.gemini/config/rules/AGENTS.md`.
   - By default, always recommend and use **Project Scope**.

---

## 2. Interactive Configuration (3 Decisions)

Gather preferences from the user using `ask_question` or interactive prompt:

### Question 1: Baseline Target Branch
- **Purpose**: Which branch should feature worktrees branch from, rebase against, and target in Pull Requests?
- **Options**:
  - `(Recommended) <DEFAULT_BRANCH>` (use the repository's detected default branch)
  - `develop`
  - `staging`
  - `Other` (allow custom branch name)

### Question 2: Merge Policy
- **Purpose**: Should the worker stop at `status:in-review` for manual review, or auto-merge after 3/3 peer review approvals?
- **Options**:
  - `(Recommended) manual` (PR stays in review for human approval; never merges automatically)
  - `auto-merge` (Squash-merge PR, fast-forward base branch, and close issue as `status:done` once all 3 peer reviews approve and CI passes)

### Question 3: CI Gating
- **Purpose**: How should the worker handle automated continuous integration checks on the PR branch?
- **Options**:
  - `(Recommended) strict` (Wait for all GitHub Actions checks to pass before dispatching peer reviewers)
  - `permissive` (Dispatch peer reviewers immediately without waiting for CI checks)

---

## 3. Codification into `AGENTS.md`

1. **Construct the Delimited Configuration Block**:
   ```markdown
   <!-- github-worker:config -->
   ## GitHub Worker Policy
   - **Base Branch**: `<CHOSEN_BRANCH>`
   - **Merge Policy**: `<manual|auto-merge>`
   - **CI Gating**: `<strict|permissive>`
   <!-- /github-worker:config -->
   ```

2. **Write or Update `AGENTS.md`**:
   - Read the existing content of the target `AGENTS.md` file (if present).
   - If an existing `<!-- github-worker:config -->...<!-- /github-worker:config -->` block is found, replace that contiguous section with the new block.
   - If no existing block is found, append the section to the end of `AGENTS.md`.
   - **Preserve Documentation**: Retain all other existing guidelines, instructions, rules, and comments in `AGENTS.md`.

---

## 4. Confirmation & Next Steps

Summarize the configured settings to the user:
- Target file updated (e.g. `./AGENTS.md`).
- Confirmed Base Branch, Merge Policy, and CI Gating.
- Remind the user that invoking `/github-worker` will now automatically honor these settings on every run without needing manual parameters.
