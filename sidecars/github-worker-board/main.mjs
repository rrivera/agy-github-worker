import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default columns configured for active issue workflow.
 */
export const COLUMNS = [
  { id: 'todo', name: 'Todo', color: '#89b4fa' },
  { id: 'in_progress', name: 'In Progress', color: '#fab387' },
  { id: 'waiting', name: 'Waiting on User', color: '#f9e2af' },
  { id: 'in_review', name: 'In Review', color: '#cba6f7' },
];

/**
 * Resolves target repository from workspace git repository or user-provided override.
 * Strictly follows github-worker Section 1:
 * - If user provides an explicit override in owner/repo format, prioritizes it.
 * - If inside a git repository, resolves via `gh repo view --json nameWithOwner -q .nameWithOwner`.
 * - If outside a git repository or unresolved, returns unresolved status for user prompting.
 *
 * @param {string} [workspaceUri] - Workspace URI or local filesystem path.
 * @param {string} [userOverrideRepo] - Optional user override in owner/repo format.
 * @param {Function} [execFn=execFileAsync] - Injectable process executor for testability.
 * @returns {Promise<{ repoSlug: string, owner: string, repo: string, source: string }>}
 */
export async function resolveRepoTarget(workspaceUri, userOverrideRepo, execFn = execFileAsync) {
  // If user provided a specific repository in the UI, prioritize it
  if (userOverrideRepo && typeof userOverrideRepo === 'string') {
    const slug = userOverrideRepo.trim();
    if (slug.includes('/')) {
      const parts = slug.split('/');
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { repoSlug: slug, owner: parts[0], repo: parts[1], source: 'user-prompt' };
      }
    }
  }

  let workspaceDir = '';
  if (workspaceUri && typeof workspaceUri === 'string') {
    workspaceDir = workspaceUri.startsWith('file://') ? fileURLToPath(workspaceUri) : workspaceUri;
  }

  // Attempt resolving from workspace directory using gh repo view
  if (workspaceDir && existsSync(workspaceDir)) {
    try {
      const { stdout } = await execFn('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        cwd: workspaceDir,
      });
      const slug = (stdout || '').trim();
      if (slug && slug.includes('/')) {
        const [owner, repo] = slug.split('/');
        if (owner && repo) {
          return { repoSlug: slug, owner, repo, source: `git (${workspaceDir})` };
        }
      }
    } catch (_) {
      // Not a git repo or gh repo view failed
    }
  }

  return { repoSlug: '', owner: '', repo: '', source: 'unresolved' };
}

/**
 * Determines Kanban column status from issue labels and closed status.
 *
 * @param {Array<string|{ name: string }>} [labels=[]] - GitHub issue labels.
 * @param {boolean} [isClosed=false] - Whether the issue is closed.
 * @returns {string} Column status name ('Todo', 'In Progress', 'Waiting on User', 'In Review', 'Done').
 */
export function determineIssueStatus(labels = [], isClosed = false) {
  const labelNames = Array.isArray(labels)
    ? labels.map((l) => (typeof l === 'string' ? l : l?.name || ''))
    : [];

  if (isClosed || labelNames.includes('status:done')) {
    return 'Done';
  }
  if (labelNames.includes('status:in-review')) {
    return 'In Review';
  }
  if (labelNames.includes('status:in-progress')) {
    return 'In Progress';
  }
  if (labelNames.includes('status:waiting-on-user')) {
    return 'Waiting on User';
  }
  return 'Todo';
}

/**
 * Indexes pull requests by issue number based on headRefName branch patterns,
 * body closing keywords (e.g., "Closes #12"), and issue references in titles.
 *
 * @param {Array<object>} [pullRequests=[]] - List of raw pull request objects from GitHub CLI.
 * @returns {Map<number, Array<object>>} Map of issue numbers to referencing PRs.
 */
export function indexPullRequestsByIssue(pullRequests = []) {
  const prsByIssue = new Map();
  if (!Array.isArray(pullRequests)) return prsByIssue;

  for (const pr of pullRequests) {
    if (!pr) continue;
    const matches = new Set();

    const branchMatch = /feat\/issue-(\d+)/i.exec(pr.headRefName || '');
    if (branchMatch) {
      matches.add(parseInt(branchMatch[1], 10));
    }

    const bodyMatches = (pr.body || '').matchAll(/(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/gi);
    for (const match of bodyMatches) {
      matches.add(parseInt(match[1], 10));
    }

    const titleMatches = (pr.title || '').matchAll(/#(\d+)/g);
    for (const match of titleMatches) {
      matches.add(parseInt(match[1], 10));
    }

    for (const issueNum of matches) {
      if (!prsByIssue.has(issueNum)) {
        prsByIssue.set(issueNum, []);
      }
      prsByIssue.get(issueNum).push(pr);
    }
  }

  return prsByIssue;
}

/**
 * Builds chronological timeline combining issue comments, PR comments, PR reviews, and inline diff comments.
 *
 * @param {object} [issue={}] - Raw GitHub issue object.
 * @param {object|null} [primaryPR=null] - Primary associated PR object.
 * @param {Array<object>} [inlineComments=[]] - Inline PR review diff comments.
 * @returns {Array<object>} Chronologically sorted timeline events.
 */
export function buildIssueTimeline(issue = {}, primaryPR = null, inlineComments = []) {
  const timeline = [];

  for (const comment of (issue?.comments || [])) {
    if (!comment) continue;
    timeline.push({
      source: 'issue_comment',
      author: comment.author?.login || '',
      body: comment.body || '',
      timestamp: comment.createdAt,
    });
  }

  if (primaryPR) {
    for (const comment of (primaryPR.comments || [])) {
      if (!comment) continue;
      timeline.push({
        source: 'pr_comment',
        author: comment.author?.login || '',
        body: comment.body || '',
        timestamp: comment.createdAt,
      });
    }

    for (const comment of (inlineComments || [])) {
      if (!comment) continue;
      timeline.push({
        source: 'pr_inline_comment',
        author: comment.user?.login || comment.author?.login || comment.author || '',
        body: comment.body || '',
        timestamp: comment.created_at || comment.createdAt || comment.timestamp,
      });
    }

    for (const review of (primaryPR.reviews || [])) {
      if (!review) continue;
      if (review.body || review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
        timeline.push({
          source: 'pr_review',
          author: review.author?.login || '',
          state: review.state,
          body: review.body || '',
          timestamp: review.submittedAt || review.createdAt,
        });
      }
    }
  }

  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return timeline;
}

/**
 * Classifies current issue actionability and recommended action based on workflow status and timeline.
 *
 * @param {string} status - Column status ('Todo', 'In Progress', 'In Review', 'Waiting on User', 'Done').
 * @param {Array<object>} [timeline=[]] - Chronological timeline events.
 * @returns {{ action: string, actionable: boolean }}
 */
export function classifyIssueAction(status, timeline = []) {
  let lastAgentIdx = -1;
  let lastAgentEvent = null;

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const body = item?.body || '';
    const isAgent =
      body.includes('<!-- antigravity-agent:') ||
      body.includes('verdict=REQUEST_CHANGES') ||
      body.includes('Verdict: REQUEST_CHANGES') ||
      item?.state === 'CHANGES_REQUESTED';

    if (isAgent) {
      lastAgentIdx = i;
      lastAgentEvent = item;
    }
  }

  const humanCommentsAfterAgent = timeline
    .slice(lastAgentIdx + 1)
    .filter((ev) => {
      const b = ev?.body || '';
      return !(
        b.includes('<!-- antigravity-agent:') ||
        b.includes('verdict=REQUEST_CHANGES') ||
        b.includes('Verdict: REQUEST_CHANGES') ||
        ev?.state === 'CHANGES_REQUESTED'
      );
    });

  let action = 'WAITING_ON_USER';
  if (status === 'Done') {
    action = 'NONE';
  } else if (status === 'Todo') {
    if (lastAgentIdx === -1) {
      action = 'NEEDS_PLAN';
    } else if (humanCommentsAfterAgent.length > 0) {
      action = 'USER_REPLIED';
    } else {
      action = 'WAITING_ON_USER';
    }
  } else if (humanCommentsAfterAgent.length > 0) {
    action = 'USER_REPLIED';
  } else if (status === 'In Progress') {
    if (lastAgentIdx === -1) {
      action = 'NEEDS_PLAN';
    } else {
      const body = lastAgentEvent?.body || '';
      const requestsChanges =
        body.includes('verdict=REQUEST_CHANGES') ||
        body.includes('Verdict: REQUEST_CHANGES') ||
        lastAgentEvent?.state === 'CHANGES_REQUESTED';
      action = requestsChanges ? 'NEEDS_REVISION' : 'WAITING_ON_USER';
    }
  } else {
    action = 'WAITING_ON_USER';
  }

  const actionable = action !== 'WAITING_ON_USER' && action !== 'NONE';
  return { action, actionable };
}

/**
 * Normalizes a raw GitHub issue and its associated PRs into a standardized board card item.
 *
 * @param {object} issue - Raw GitHub issue object.
 * @param {Array<object>} [issuePRs=[]] - List of PRs linked to this issue.
 * @param {Array<object>} [inlineComments=[]] - Inline PR review diff comments for the primary PR.
 * @returns {object} Standardized issue item.
 */
export function formatIssueItem(issue, issuePRs = [], inlineComments = []) {
  const labelNames = (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || ''));
  const isClosed = Boolean(issue?.closedAt || issue?.state === 'CLOSED');
  const status = determineIssueStatus(labelNames, isClosed);
  const primaryPR = issuePRs[0] || null;

  const timeline = buildIssueTimeline(issue, primaryPR, inlineComments);
  const { action, actionable } = classifyIssueAction(status, timeline);

  return {
    id: `issue-${issue.number}`,
    number: issue.number,
    title: issue.title || '',
    url: issue.url || '',
    state: isClosed ? 'CLOSED' : 'OPEN',
    status,
    action,
    actionable,
    labels: labelNames,
    updatedAt: issue.updatedAt || issue.createdAt || new Date().toISOString(),
    pullRequests: issuePRs.map((pr) => ({
      number: pr.number,
      title: pr.title || '',
      url: pr.url || '',
      state: pr.state || 'OPEN',
      isDraft: Boolean(pr.isDraft),
    })),
  };
}

/**
 * Fetches open issues labeled agent-ready, recent closed issues, associated PRs, and inline PR comments.
 *
 * @param {string} [workspaceUri] - Workspace directory URI.
 * @param {string} [userOverrideRepo] - Optional user override repository.
 * @param {Function} [execFn=execFileAsync] - Injectable process executor.
 * @returns {Promise<object>} Issue board data structure.
 */
export async function fetchIssuesData(workspaceUri, userOverrideRepo, execFn = execFileAsync) {
  const { repoSlug, owner, repo, source } = await resolveRepoTarget(workspaceUri, userOverrideRepo, execFn);

  if (!repoSlug) {
    return {
      needsTargetRepo: true,
      repository: null,
      columns: COLUMNS,
      items: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  const ghRepoArgs = ['-R', repoSlug];

  // Fetch open issues labeled agent-ready, PRs, and inline PR review comments in parallel
  const [openIssuesRes, prsRes, inlineCommentsRes] = await Promise.all([
    execFn('gh', [
      'issue',
      'list',
      ...ghRepoArgs,
      '--state',
      'open',
      '--label',
      'agent-ready',
      '--limit',
      '100',
      '--json',
      'number,title,url,body,labels,createdAt,updatedAt,comments',
    ], { maxBuffer: 15 * 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout || '[]')),

    execFn('gh', [
      'pr',
      'list',
      ...ghRepoArgs,
      '--state',
      'all',
      '--limit',
      '60',
      '--json',
      'number,title,url,state,headRefName,isDraft,createdAt,comments,reviews',
    ], { maxBuffer: 15 * 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout || '[]')).catch(() => []),

    execFn('gh', [
      'api',
      `repos/${repoSlug}/pulls/comments?per_page=100`,
    ], { maxBuffer: 10 * 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout || '[]')).catch(() => []),
  ]);

  const prsByIssue = indexPullRequestsByIssue(prsRes);
  const inlineCommentsByPr = new Map();
  for (const comment of inlineCommentsRes) {
    if (!comment) continue;
    const prNum = comment.pull_request_url
      ? parseInt(comment.pull_request_url.split('/').pop(), 10)
      : (comment.pr_number || null);
    if (prNum && !Number.isNaN(prNum)) {
      if (!inlineCommentsByPr.has(prNum)) {
        inlineCommentsByPr.set(prNum, []);
      }
      inlineCommentsByPr.get(prNum).push(comment);
    }
  }

  // Filter out any completed issues (closed or labeled status:done)
  const activeIssues = (Array.isArray(openIssuesRes) ? openIssuesRes : []).filter((issue) => {
    if (!issue) return false;
    const isClosed = Boolean(issue.closedAt || issue.state === 'CLOSED');
    if (isClosed) return false;
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const labelNames = labels.map((l) => (typeof l === 'string' ? l : l?.name || ''));
    return !labelNames.includes('status:done');
  });

  const items = activeIssues
    .map((issue) => {
      const prs = prsByIssue.get(issue.number) || [];
      const primaryPR = prs[0] || null;
      const inlines = primaryPR ? (inlineCommentsByPr.get(primaryPR.number) || []) : [];
      return formatIssueItem(issue, prs, inlines);
    })
    .filter((item) => item.status !== 'Done');

  return {
    needsTargetRepo: false,
    repository: {
      slug: repoSlug,
      owner,
      repo,
      source,
    },
    columns: COLUMNS,
    items,
    lastUpdated: new Date().toISOString(),
  };
}

// Check if running inside Antigravity Sidecar environment
const isAntigravityEnv = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);

/**
 * Loads app.js and strips ES module export directives for browser consumption as a classic script.
 *
 * @returns {string} Classic browser JavaScript code.
 */
export function getBrowserAppJs() {
  const raw = readFileSync(join(__dirname, 'app.js'), 'utf-8');
  return raw.replace(/^export\s+/gm, '');
}

/**
 * Initializes and starts the Sidecar application in Antigravity or standalone HTTP server mode.
 */
export async function start() {
  if (isAntigravityEnv) {
    const { SidecarApp, Response: SdkResponse } = await import('sidecar_sdk');
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
    app.page('/styles.css', () => new SdkResponse(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
      contentType: 'text/css',
    }));
    app.page('/app.js', () => new SdkResponse(getBrowserAppJs(), {
      contentType: 'application/javascript',
    }));

    app.api('/api/issues', async (data) => {
      const workspaceUri = data?.workspaceUri || '';
      const targetRepo = data?.targetRepo || '';
      return fetchIssuesData(workspaceUri, targetRepo);
    }, 'GET');

    app.api('/api/issues', async (data) => {
      const workspaceUri = data?.workspaceUri || '';
      const targetRepo = data?.targetRepo || '';
      return fetchIssuesData(workspaceUri, targetRepo);
    }, 'POST');

    await app.run();
    console.log('[github-worker-board] SidecarApp running in Antigravity environment');
  } else {
    // Standalone fallback HTTP server for testing
    const port = parseInt(process.env.PORT || '8999', 10);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
        return;
      }
      if (url.pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(readFileSync(join(__dirname, 'styles.css'), 'utf-8'));
        return;
      }
      if (url.pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(getBrowserAppJs());
        return;
      }
      if (url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          window.sidecar = {
            fetch: (url, opts) => fetch(url, opts),
            getWorkspaceUris: async () => [],
            onWorkspaceChange: () => () => {},
          };
        `);
        return;
      }
      if (url.pathname === '/api/issues') {
        try {
          const workspaceUri = url.searchParams.get('workspaceUri') || '';
          const targetRepo = url.searchParams.get('targetRepo') || '';
          const result = await fetchIssuesData(workspaceUri, targetRepo);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[github-worker-board] Standalone server listening at http://127.0.0.1:${port}`);
    });
  }
}

// Only start the server when run directly as CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((err) => {
    console.error('[github-worker-board] Fatal error:', err);
    process.exit(1);
  });
}
