<p align="center">
  <img src="assets/logo.png" alt="agy-github-worker logo" width="128" height="128" />
</p>

# agy-github-worker

[![GitHub Repo](https://img.shields.io/badge/GitHub-rrivera%2Fagy--github--worker-blue.svg)](https://github.com/rrivera/agy-github-worker)
[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin-89b4fa.svg)](https://antigravity.google)

Antigravity plugin and live auxiliary-pane sidecar board for the `/github-worker` skill.

---

## Overview

`agy-github-worker` provides:
1. **`/github-worker` Skill**: Fully autonomous GitHub issue worker that:
   - Polls open issues labeled `agent-ready`.
   - Tracks workflow status via repository labels (`status:todo`, `status:in-progress`, `status:waiting-on-user`, `status:in-review`, `status:done`).
   - Dispatches parallel `architect` subagents with isolated git worktrees.
   - Executes Test-Driven Development (TDD) quality gates.
   - Coordinates 3-axis peer code reviews (Spec, Standards, Security) with diff-driven observable predicates.
   - Automatically squash-merges conflict-free approved PRs and marks issues `status:done`.
2. **`github-worker-board` Sidecar**: A live Kanban board embedded directly in Antigravity's auxiliary side pane:
   - Categorizes issues across **Todo**, **In Progress**, **Waiting on User**, **In Review**, and **Done**.
   - Displays real-time action status badges (`NEEDS_PLAN`, `USER_REPLIED`, `NEEDS_REVISION`, `WAITING_ON_USER`).
   - Surfaces direct clickable links to each GitHub issue and associated Pull Requests.
   - Auto-refreshes every 30 seconds and reacts to Antigravity workspace changes.

---

## Directory Structure

```text
agy-github-worker/
├── plugin.json                              # Plugin manifest
├── README.md                                # Repository & installation documentation
├── assets/
│   ├── logo.svg                             # Plugin icon (vector)
│   └── logo.png                             # Plugin icon (rendered PNG)
├── skills/
│   └── github-worker/
│       ├── SKILL.md                         # Main skill entrypoint
│       └── references/
│           ├── architect-prompt.md          # Canonical architect subagent contract
│           └── reviewer-prompts.md          # Canonical 3-axis reviewer contracts
└── sidecars/
    └── github-worker-board/
        ├── sidecar.json                     # Sidecar manifest for Antigravity UI
        ├── package.json
        ├── main.mjs                         # Backend server & GitHub CLI data fetcher
        ├── index.html                       # Sidecar HTML structure
        ├── styles.css                       # Catppuccin theme matching Antigravity
        └── app.js                           # Client-side reactivity & rendering
```

---

## Installation in Antigravity

Clone or symlink the repository into your Antigravity plugins directory:

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/rrivera/agy-github-worker ~/.gemini/config/plugins/agy-github-worker
```

Restart Antigravity to discover the plugin and sidecar. Once loaded, the `/github-worker` slash command and the sidecar board will be available globally across all workspaces.

---

## License

MIT
