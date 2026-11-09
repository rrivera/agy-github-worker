import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS,
  resolveRepoTarget,
  determineIssueStatus,
  indexPullRequestsByIssue,
  buildIssueTimeline,
  classifyIssueAction,
  formatIssueItem,
  fetchIssuesData,
} from '../main.mjs';

describe('COLUMNS', () => {
  it('contains only active workflow statuses and excludes Done', () => {
    const columnIds = COLUMNS.map((c) => c.id);
    assert.deepEqual(columnIds, ['todo', 'in_progress', 'waiting', 'in_review']);
    assert.equal(COLUMNS.some((c) => c.id === 'done'), false);
    assert.equal(COLUMNS.some((c) => c.name.toLowerCase() === 'done'), false);
  });
});

describe('resolveRepoTarget', () => {
  it('resolves repository from user override when valid slug is provided', async () => {
    const res = await resolveRepoTarget('', ' facebook/react ');
    assert.deepEqual(res, {
      repoSlug: 'facebook/react',
      owner: 'facebook',
      repo: 'react',
      source: 'user-prompt',
    });
  });

  it('ignores invalid user override without slash and falls back', async () => {
    const res = await resolveRepoTarget('', 'invalid-repo-name');
    assert.deepEqual(res, {
      repoSlug: '',
      owner: '',
      repo: '',
      source: 'unresolved',
    });
  });

  it('resolves repository from workspace git directory via execFn', async () => {
    const mockExec = async (cmd, args, opts) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(args, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
      assert.equal(opts.cwd, process.cwd());
      return { stdout: 'owner/repo\n' };
    };

    const res = await resolveRepoTarget(process.cwd(), '', mockExec);
    assert.equal(res.repoSlug, 'owner/repo');
    assert.equal(res.owner, 'owner');
    assert.equal(res.repo, 'repo');
    assert.match(res.source, /^git \(/);
  });

  it('handles file:// workspace URI properly', async () => {
    const mockExec = async () => ({ stdout: 'org/project\n' });
    const fileUri = `file://${process.cwd()}`;
    const res = await resolveRepoTarget(fileUri, '', mockExec);
    assert.equal(res.repoSlug, 'org/project');
    assert.equal(res.owner, 'org');
    assert.equal(res.repo, 'project');
  });

  it('returns unresolved when gh command throws an error', async () => {
    const mockExec = async () => {
      throw new Error('Not a git repository');
    };
    const res = await resolveRepoTarget(process.cwd(), '', mockExec);
    assert.deepEqual(res, {
      repoSlug: '',
      owner: '',
      repo: '',
      source: 'unresolved',
    });
  });

  it('returns unresolved when workspace directory does not exist', async () => {
    const res = await resolveRepoTarget('/path/that/definitely/does/not/exist/12345', '');
    assert.deepEqual(res, {
      repoSlug: '',
      owner: '',
      repo: '',
      source: 'unresolved',
    });
  });

  it('returns unresolved when no workspace URI and no override provided', async () => {
    const res = await resolveRepoTarget('', '');
    assert.deepEqual(res, {
      repoSlug: '',
      owner: '',
      repo: '',
      source: 'unresolved',
    });
  });
});

describe('determineIssueStatus', () => {
  it('returns Done if status:done label is present', () => {
    assert.equal(determineIssueStatus(['agent-ready', 'status:done'], false), 'Done');
  });

  it('returns Done if isClosed is true regardless of labels', () => {
    assert.equal(determineIssueStatus(['agent-ready', 'status:in-progress'], true), 'Done');
  });

  it('returns In Review if status:in-review is present', () => {
    assert.equal(determineIssueStatus(['agent-ready', 'status:in-review'], false), 'In Review');
  });

  it('returns In Progress if status:in-progress is present', () => {
    assert.equal(determineIssueStatus(['agent-ready', 'status:in-progress'], false), 'In Progress');
  });

  it('returns Waiting on User if status:waiting-on-user is present', () => {
    assert.equal(determineIssueStatus(['agent-ready', 'status:waiting-on-user'], false), 'Waiting on User');
  });

  it('defaults to Todo for open issues without status labels', () => {
    assert.equal(determineIssueStatus(['agent-ready'], false), 'Todo');
    assert.equal(determineIssueStatus([], false), 'Todo');
    assert.equal(determineIssueStatus(null, false), 'Todo');
  });

  it('handles label objects with name property', () => {
    const labels = [{ name: 'agent-ready' }, { name: 'status:in-review' }];
    assert.equal(determineIssueStatus(labels, false), 'In Review');
  });
});

describe('indexPullRequestsByIssue', () => {
  it('indexes PRs referencing issues in branch name, body keywords, and title', () => {
    const pullRequests = [
      {
        number: 101,
        title: 'Feature A',
        headRefName: 'feat/issue-1',
        body: 'Implements feature\nCloses #2 and fixes #3',
      },
      {
        number: 102,
        title: 'Fix issue (#4)',
        headRefName: 'fix-bug',
        body: 'Resolves #2',
      },
      {
        number: 103,
        title: 'Unrelated PR',
        headRefName: 'chore/cleanup',
        body: 'Clean up files',
      },
    ];

    const map = indexPullRequestsByIssue(pullRequests);

    // Issue 1 matched by headRefName
    assert.equal(map.get(1)?.length, 1);
    assert.equal(map.get(1)[0].number, 101);

    // Issue 2 matched by PR 101 (Closes #2) and PR 102 (Resolves #2)
    assert.equal(map.get(2)?.length, 2);
    assert.equal(map.get(2)[0].number, 101);
    assert.equal(map.get(2)[1].number, 102);

    // Issue 3 matched by PR 101 (fixes #3)
    assert.equal(map.get(3)?.length, 1);
    assert.equal(map.get(3)[0].number, 101);

    // Issue 4 matched by PR 102 title (#4)
    assert.equal(map.get(4)?.length, 1);
    assert.equal(map.get(4)[0].number, 102);

    // Unrelated issue
    assert.equal(map.has(999), false);
  });

  it('handles empty or non-array inputs defensively', () => {
    assert.equal(indexPullRequestsByIssue([]).size, 0);
    assert.equal(indexPullRequestsByIssue(null).size, 0);
    assert.equal(indexPullRequestsByIssue(undefined).size, 0);
  });
});

describe('buildIssueTimeline', () => {
  it('merges issue comments, PR comments, and PR reviews in chronological order', () => {
    const issue = {
      comments: [
        { author: { login: 'user1' }, body: 'Issue comment 1', createdAt: '2026-11-01T10:00:00Z' },
        { author: { login: 'agent' }, body: '<!-- antigravity-agent: phase=plan-proposed -->', createdAt: '2026-11-01T12:00:00Z' },
      ],
    };
    const primaryPR = {
      comments: [
        { author: { login: 'reviewer' }, body: 'PR comment', createdAt: '2026-11-01T11:00:00Z' },
      ],
      reviews: [
        { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix X', submittedAt: '2026-11-01T13:00:00Z' },
      ],
    };

    const timeline = buildIssueTimeline(issue, primaryPR);
    assert.equal(timeline.length, 4);
    assert.equal(timeline[0].body, 'Issue comment 1');
    assert.equal(timeline[1].body, 'PR comment');
    assert.equal(timeline[2].body, '<!-- antigravity-agent: phase=plan-proposed -->');
    assert.equal(timeline[3].state, 'CHANGES_REQUESTED');
  });

  it('incorporates inline PR review comments chronologically', () => {
    const issue = { comments: [] };
    const primaryPR = {
      comments: [
        { author: { login: 'agent' }, body: '<!-- antigravity-agent: phase=review-ready -->', createdAt: '2026-11-01T10:00:00Z' },
      ],
      reviews: [],
    };
    const inlineComments = [
      {
        user: { login: 'human' },
        body: 'Please clarify this line',
        created_at: '2026-11-01T11:00:00Z',
      },
    ];

    const timeline = buildIssueTimeline(issue, primaryPR, inlineComments);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].body, '<!-- antigravity-agent: phase=review-ready -->');
    assert.equal(timeline[1].source, 'pr_inline_comment');
    assert.equal(timeline[1].author, 'human');
    assert.equal(timeline[1].body, 'Please clarify this line');
  });

  it('handles missing comments or primaryPR gracefully', () => {
    assert.deepEqual(buildIssueTimeline({}, null), []);
    assert.deepEqual(buildIssueTimeline({ comments: null }, undefined), []);
  });
});

describe('classifyIssueAction', () => {
  it('returns NONE for Done status', () => {
    const res = classifyIssueAction('Done', []);
    assert.deepEqual(res, { action: 'NONE', actionable: false });
  });

  it('returns NEEDS_PLAN for Todo status with no agent comments', () => {
    const timeline = [
      { author: 'user', body: 'Please help', timestamp: '2026-11-01T10:00:00Z' },
    ];
    const res = classifyIssueAction('Todo', timeline);
    assert.deepEqual(res, { action: 'NEEDS_PLAN', actionable: true });
  });

  it('returns WAITING_ON_USER for Todo status after agent proposed plan without user reply', () => {
    const timeline = [
      { author: 'agent', body: 'Plan details\n<!-- antigravity-agent: phase=plan-proposed -->', timestamp: '2026-11-01T10:00:00Z' },
    ];
    const res = classifyIssueAction('Todo', timeline);
    assert.deepEqual(res, { action: 'WAITING_ON_USER', actionable: false });
  });

  it('returns USER_REPLIED when human comments after agent event', () => {
    const timeline = [
      { author: 'agent', body: 'Plan\n<!-- antigravity-agent: phase=plan-proposed -->', timestamp: '2026-11-01T10:00:00Z' },
      { author: 'user', body: 'Looks good, please proceed', timestamp: '2026-11-01T11:00:00Z' },
    ];
    const res = classifyIssueAction('Todo', timeline);
    assert.deepEqual(res, { action: 'USER_REPLIED', actionable: true });
  });

  it('returns NEEDS_PLAN for In Progress status with no agent event', () => {
    const res = classifyIssueAction('In Progress', []);
    assert.deepEqual(res, { action: 'NEEDS_PLAN', actionable: true });
  });

  it('returns NEEDS_REVISION for In Progress status when agent or reviewer requested changes', () => {
    const timeline1 = [
      { author: 'agent', body: 'verdict=REQUEST_CHANGES\nPlease fix', timestamp: '2026-11-01T10:00:00Z' },
    ];
    assert.deepEqual(classifyIssueAction('In Progress', timeline1), { action: 'NEEDS_REVISION', actionable: true });

    const timeline2 = [
      { author: 'agent', state: 'CHANGES_REQUESTED', body: 'Needs changes', timestamp: '2026-11-01T10:00:00Z' },
    ];
    assert.deepEqual(classifyIssueAction('In Progress', timeline2), { action: 'NEEDS_REVISION', actionable: true });
  });

  it('returns WAITING_ON_USER for In Progress status without changes requested or user comments', () => {
    const timeline = [
      { author: 'agent', body: '<!-- antigravity-agent: phase=implementation --> Working...', timestamp: '2026-11-01T10:00:00Z' },
    ];
    assert.deepEqual(classifyIssueAction('In Progress', timeline), { action: 'WAITING_ON_USER', actionable: false });
  });
});

describe('formatIssueItem', () => {
  it('formats raw GitHub issue and associated PRs into standardized Kanban card item', () => {
    const issue = {
      number: 1,
      title: 'Fix bug',
      url: 'https://github.com/org/repo/issues/1',
      body: 'Bug report',
      labels: [{ name: 'agent-ready' }, { name: 'status:in-progress' }],
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T11:00:00Z',
      comments: [],
    };
    const prs = [
      {
        number: 10,
        title: 'Fix bug PR',
        url: 'https://github.com/org/repo/pull/10',
        state: 'OPEN',
        isDraft: false,
      },
    ];

    const item = formatIssueItem(issue, prs);
    assert.equal(item.id, 'issue-1');
    assert.equal(item.number, 1);
    assert.equal(item.title, 'Fix bug');
    assert.equal(item.status, 'In Progress');
    assert.equal(item.action, 'NEEDS_PLAN');
    assert.equal(item.actionable, true);
    assert.deepEqual(item.labels, ['agent-ready', 'status:in-progress']);
    assert.equal(item.pullRequests.length, 1);
    assert.equal(item.pullRequests[0].number, 10);
  });

  it('marks issue actionable with USER_REPLIED when human leaves an inline review comment after agent event', () => {
    const issue = {
      number: 2,
      title: 'Review ticket',
      url: 'https://github.com/org/repo/issues/2',
      body: 'Task',
      labels: [{ name: 'agent-ready' }, { name: 'status:in-review' }],
      createdAt: '2026-11-01T10:00:00Z',
      comments: [
        { author: { login: 'agent' }, body: '<!-- antigravity-agent: phase=review-ready -->', createdAt: '2026-11-01T11:00:00Z' },
      ],
    };
    const prs = [
      {
        number: 20,
        title: 'PR for #2',
        url: 'https://github.com/org/repo/pull/20',
        state: 'OPEN',
        isDraft: false,
      },
    ];
    const inlineComments = [
      {
        pull_request_url: 'https://api.github.com/repos/org/repo/pulls/20',
        user: { login: 'human' },
        body: 'Can you check this line?',
        created_at: '2026-11-01T12:00:00Z',
      },
    ];

    const item = formatIssueItem(issue, prs, inlineComments);
    assert.equal(item.status, 'In Review');
    assert.equal(item.action, 'USER_REPLIED');
    assert.equal(item.actionable, true);
  });
});

describe('fetchIssuesData', () => {
  it('returns needsTargetRepo: true when target cannot be resolved', async () => {
    const mockExec = async () => {
      throw new Error('Not git');
    };
    const res = await fetchIssuesData('', '', mockExec);
    assert.equal(res.needsTargetRepo, true);
    assert.equal(res.repository, null);
    assert.deepEqual(res.columns, COLUMNS);
    assert.deepEqual(res.items, []);
  });

  it('fetches open issues and PRs without querying closed issues', async () => {
    let queriedClosedIssues = false;
    const mockExec = async (cmd, args) => {
      if (args.includes('closed')) {
        queriedClosedIssues = true;
      }
      if (args.includes('issue') && args.includes('open')) {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              title: 'Open Issue 1',
              url: 'https://github.com/owner/repo/issues/1',
              body: 'Issue 1 body',
              labels: ['agent-ready'],
              createdAt: '2026-11-01T00:00:00Z',
              comments: [],
            },
          ]),
        };
      }
      if (args.includes('pr')) {
        return {
          stdout: JSON.stringify([
            {
              number: 10,
              title: 'PR for #1',
              headRefName: 'feat/issue-1',
              url: 'https://github.com/owner/repo/pull/10',
              state: 'OPEN',
              isDraft: false,
              comments: [],
              reviews: [],
            },
          ]),
        };
      }
      return { stdout: '[]' };
    };

    const res = await fetchIssuesData('', 'owner/repo', mockExec);
    assert.equal(res.needsTargetRepo, false);
    assert.equal(res.repository.slug, 'owner/repo');
    assert.equal(queriedClosedIssues, false, 'Should not query closed issues from GitHub');
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].number, 1);
    assert.equal(res.items[0].pullRequests.length, 1);
    assert.equal(res.items[0].pullRequests[0].number, 10);
  });

  it('discards completed issues (status:done label or closed state)', async () => {
    const mockExec = async (cmd, args) => {
      if (args.includes('issue') && args.includes('open')) {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              title: 'Active Issue',
              url: 'https://github.com/owner/repo/issues/1',
              body: 'Active issue body',
              labels: ['agent-ready', 'status:in-progress'],
              createdAt: '2026-11-01T00:00:00Z',
              comments: [],
            },
            {
              number: 2,
              title: 'Done Label Issue',
              url: 'https://github.com/owner/repo/issues/2',
              body: 'Completed with label',
              labels: ['agent-ready', 'status:done'],
              createdAt: '2026-11-01T00:00:00Z',
              comments: [],
            },
            {
              number: 3,
              title: 'Closed State Issue',
              url: 'https://github.com/owner/repo/issues/3',
              body: 'Closed issue',
              state: 'CLOSED',
              labels: ['agent-ready'],
              createdAt: '2026-11-01T00:00:00Z',
              comments: [],
            },
            {
              number: 4,
              title: 'Issue With closedAt',
              url: 'https://github.com/owner/repo/issues/4',
              body: 'Issue with closedAt date',
              closedAt: '2026-11-02T00:00:00Z',
              labels: ['agent-ready'],
              createdAt: '2026-11-01T00:00:00Z',
              comments: [],
            },
          ]),
        };
      }
      return { stdout: '[]' };
    };

    const res = await fetchIssuesData('', 'owner/repo', mockExec);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].number, 1);
    assert.equal(res.items[0].title, 'Active Issue');
    assert.equal(res.items.some((i) => i.status === 'Done'), false);
  });
});
