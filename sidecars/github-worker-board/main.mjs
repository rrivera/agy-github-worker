import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const COLUMNS = [
  { id: 'todo', name: 'Todo', color: '#89b4fa' },
  { id: 'in_progress', name: 'In Progress', color: '#fab387' },
  { id: 'waiting', name: 'Waiting on User', color: '#f9e2af' },
  { id: 'in_review', name: 'In Review', color: '#cba6f7' },
  { id: 'done', name: 'Done', color: '#a6e3a1' },
];

/**
 * Parses simple .env format key=value pairs into an object.
 */
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = {};
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  } catch (err) {
    console.error(`Failed to read env file at ${filePath}:`, err);
    return {};
  }
}

/**
 * Resolves repository target and git working directory.
 */
async function resolveRepoTarget(workspaceUri) {
  const candidates = [];
  let workspaceDir = '';

  if (workspaceUri) {
    const rawPath = workspaceUri.startsWith('file://') ? fileURLToPath(workspaceUri) : workspaceUri;
    workspaceDir = rawPath;
    candidates.push(resolve(rawPath, '.env'));
  }
  candidates.push(resolve(process.cwd(), '.env'));
  candidates.push('/home/null/projects/remote-work/.env');

  let envData = {};
  let resolvedEnvPath = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      envData = parseEnvFile(candidate);
      resolvedEnvPath = candidate;
      break;
    }
  }

  // 1. Try environment variables / .env
  const owner = envData.GITHUB_OWNER || process.env.GITHUB_OWNER || '';
  const repoName = envData.GITHUB_REPO || process.env.GITHUB_REPO || '';
  if (owner && repoName) {
    return {
      repoSlug: `${owner}/${repoName}`,
      owner,
      repo: repoName,
      source: `env (${resolvedEnvPath || 'environment'})`,
    };
  }

  // 2. Try git remote in workspace directory
  if (workspaceDir && existsSync(workspaceDir)) {
    try {
      const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        cwd: workspaceDir,
      });
      const slug = stdout.trim();
      if (slug && slug.includes('/')) {
        const [o, r] = slug.split('/');
        return { repoSlug: slug, owner: o, repo: r, source: `git (${workspaceDir})` };
      }
    } catch (_) {}
  }

  // 3. Fallback to process cwd git
  try {
    const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const slug = stdout.trim();
    if (slug && slug.includes('/')) {
      const [o, r] = slug.split('/');
      return { repoSlug: slug, owner: o, repo: r, source: 'current directory' };
    }
  } catch (_) {}

  return { repoSlug: '', owner: '', repo: '', source: 'unresolved' };
}

/**
 * Fetches open issues labeled agent-ready and recent closed issues labeled agent-ready.
 */
async function fetchIssuesData(workspaceUri) {
  const { repoSlug, owner, repo, source } = await resolveRepoTarget(workspaceUri);
  if (!repoSlug) {
    throw new Error('Could not resolve target GitHub repository. Ensure GITHUB_OWNER and GITHUB_REPO are set in .env or run inside a GitHub repository.');
  }

  const ghRepoArgs = ['-R', repoSlug];

  // Fetch open issues labeled agent-ready, recent closed issues, and open PRs in parallel
  const [openIssuesRes, closedIssuesRes, prsRes] = await Promise.all([
    execFileAsync('gh', [
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

    execFileAsync('gh', [
      'issue',
      'list',
      ...ghRepoArgs,
      '--state',
      'closed',
      '--label',
      'agent-ready',
      '--limit',
      '30',
      '--json',
      'number,title,url,body,labels,createdAt,updatedAt,closedAt',
    ], { maxBuffer: 10 * 1024 * 1024 }).then(({ stdout }) => JSON.parse(stdout || '[]')).catch(() => []),

    execFileAsync('gh', [
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
  ]);

  // Index PRs by issue number (feat/issue-<NUM> or Closes #<NUM>)
  const prsByIssue = new Map();
  for (const pr of prsRes) {
    const matches = new Set();
    const branchMatch = /feat\/issue-(\d+)/i.exec(pr.headRefName || '');
    if (branchMatch) matches.add(parseInt(branchMatch[1], 10));

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

  // Combine issues and determine their workflow state and actionability
  const items = [];
  const allIssues = [...openIssuesRes, ...closedIssuesRes];

  for (const issue of allIssues) {
    const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const isClosed = issue.closedAt || issue.state === 'CLOSED';

    let status = 'Todo';
    if (labelNames.includes('status:done') || isClosed) {
      status = 'Done';
    } else if (labelNames.includes('status:in-review')) {
      status = 'In Review';
    } else if (labelNames.includes('status:in-progress')) {
      status = 'In Progress';
    } else if (labelNames.includes('status:waiting-on-user')) {
      status = 'Waiting on User';
    } else {
      status = 'Todo';
    }

    const issuePRs = prsByIssue.get(issue.number) || [];
    const primaryPR = issuePRs[0] || null;

    // Timeline merge for action classification
    const timeline = [];
    for (const comment of (issue.comments || [])) {
      timeline.push({
        source: 'issue_comment',
        author: comment.author?.login || '',
        body: comment.body || '',
        timestamp: comment.createdAt,
      });
    }
    if (primaryPR) {
      for (const comment of (primaryPR.comments || [])) {
        timeline.push({
          source: 'pr_comment',
          author: comment.author?.login || '',
          body: comment.body || '',
          timestamp: comment.createdAt,
        });
      }
      for (const review of (primaryPR.reviews || [])) {
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

    let lastAgentIdx = -1;
    let lastAgentEvent = null;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      const isAgent = (item.body || '').includes('<!-- antigravity-agent:');
      if (isAgent) {
        lastAgentIdx = i;
        lastAgentEvent = item;
      }
    }

    const humanCommentsAfterAgent = timeline
      .slice(lastAgentIdx + 1)
      .filter((ev) => !(ev.body || '').includes('<!-- antigravity-agent:'));

    let action = 'WAITING_ON_USER';
    if (status === 'Done') {
      action = 'NONE';
    } else if (status === 'Todo') {
      if (lastAgentIdx === -1) action = 'NEEDS_PLAN';
      else if (humanCommentsAfterAgent.length > 0) action = 'USER_REPLIED';
      else action = 'WAITING_ON_USER';
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

    items.push({
      id: `issue-${issue.number}`,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: isClosed ? 'CLOSED' : 'OPEN',
      status,
      action,
      actionable,
      labels: labelNames,
      updatedAt: issue.updatedAt || issue.createdAt,
      pullRequests: issuePRs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: Boolean(pr.isDraft),
      })),
    });
  }

  return {
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

async function start() {
  if (isAntigravityEnv) {
    const { SidecarApp, Response: SdkResponse } = await import('sidecar_sdk');
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
    app.page('/styles.css', () => new SdkResponse(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
      contentType: 'text/css',
    }));
    app.page('/app.js', () => new SdkResponse(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
      contentType: 'application/javascript',
    }));

    app.api('/api/issues', async (data) => {
      const workspaceUri = data?.workspaceUri || '';
      return fetchIssuesData(workspaceUri);
    }, 'GET');

    app.api('/api/issues', async (data) => {
      const workspaceUri = data?.workspaceUri || '';
      return fetchIssuesData(workspaceUri);
    }, 'POST');

    await app.run();
    console.log('[github-worker-board] SidecarApp running in Antigravity environment');
  } else {
    // Standalone fallback HTTP server for testing or standalone browser use
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
        res.end(readFileSync(join(__dirname, 'app.js'), 'utf-8'));
        return;
      }
      if (url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          window.sidecar = {
            fetch: (url, opts) => fetch(url, opts),
            getWorkspaceUris: async () => ["file:///home/null/projects/remote-work"],
            onWorkspaceChange: () => () => {},
          };
        `);
        return;
      }
      if (url.pathname === '/api/issues') {
        try {
          const workspaceUri = url.searchParams.get('workspaceUri') || '';
          const result = await fetchIssuesData(workspaceUri);
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

start().catch((err) => {
  console.error('[github-worker-board] Fatal error:', err);
  process.exit(1);
});
