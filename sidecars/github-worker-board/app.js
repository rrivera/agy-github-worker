// GitHub Worker Board Sidecar Client Application

let boardState = {
  repository: null,
  columns: [],
  items: [],
  lastUpdated: null,
  activeWorkspaceUri: null,
  userOverrideRepo: '',
  filterQuery: '',
  hideDone: false,
  isRefreshing: false,
};

const COLUMN_COLORS = {
  'Todo': 'var(--status-todo)',
  'In progress': 'var(--status-in-progress)',
  'In Progress': 'var(--status-in-progress)',
  'Waiting on User': 'var(--status-waiting)',
  'In review': 'var(--status-in-review)',
  'In Review': 'var(--status-in-review)',
  'Done': 'var(--status-done)',
};

/**
 * Fetch wrapper that uses window.sidecar.fetch if available.
 */
async function apiFetch(url, options = {}) {
  if (window.sidecar && typeof window.sidecar.fetch === 'function') {
    return window.sidecar.fetch(url, options);
  }
  return fetch(url, options);
}

/**
 * Resolves current workspace URI.
 */
async function resolveWorkspaceUri() {
  if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
    try {
      const uris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(uris) && uris.length > 0) {
        return uris[0];
      }
    } catch (e) {
      console.warn('Could not get workspace uris from sidecar:', e);
    }
  }
  return '';
}

/**
 * Fetches the issue board data from backend.
 */
async function loadBoard() {
  if (boardState.isRefreshing) return;
  boardState.isRefreshing = true;

  const refreshBtn = document.getElementById('refresh-btn');
  const errorBanner = document.getElementById('error-banner');
  const errorMsg = document.getElementById('error-message');
  const promptBanner = document.getElementById('repo-prompt-banner');
  const statusBar = document.getElementById('last-updated-text');
  const changeRepoBtn = document.getElementById('change-repo-btn');

  refreshBtn?.classList.add('spinning');
  errorBanner.style.display = 'none';

  try {
    if (!boardState.activeWorkspaceUri) {
      boardState.activeWorkspaceUri = await resolveWorkspaceUri();
    }

    const params = new URLSearchParams();
    if (boardState.activeWorkspaceUri) {
      params.set('workspaceUri', boardState.activeWorkspaceUri);
    }
    if (boardState.userOverrideRepo) {
      params.set('targetRepo', boardState.userOverrideRepo);
    }

    const endpoint = `/api/issues?${params.toString()}`;
    const res = await apiFetch(endpoint);
    if (!res.ok) {
      const text = await res.text();
      let parsedErr = text;
      try {
        parsedErr = JSON.parse(text).error || text;
      } catch (_) {}
      throw new Error(parsedErr || `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.needsTargetRepo) {
      promptBanner.style.display = 'block';
      statusBar.textContent = 'Awaiting target repository';
      boardState.repository = null;
      boardState.items = [];
      renderBoard();
      return;
    }

    promptBanner.style.display = 'none';
    if (changeRepoBtn) changeRepoBtn.style.display = 'inline-flex';

    boardState.repository = data.repository;
    boardState.columns = data.columns || [];
    boardState.items = data.items || [];
    boardState.lastUpdated = data.lastUpdated;

    renderBoard();

    if (boardState.lastUpdated) {
      const timeStr = new Date(boardState.lastUpdated).toLocaleTimeString();
      const actionableCount = boardState.items.filter((i) => i.actionable).length;
      statusBar.textContent = `Updated at ${timeStr} • ${boardState.items.length} items (${actionableCount} actionable)`;
    }
  } catch (err) {
    console.error('Failed to load issues board:', err);
    errorMsg.textContent = `Error: ${err.message}`;
    errorBanner.style.display = 'flex';
    statusBar.textContent = 'Update failed';
  } finally {
    boardState.isRefreshing = false;
    refreshBtn?.classList.remove('spinning');
  }
}

/**
 * Renders the board columns and cards into the DOM.
 */
function renderBoard() {
  const boardTitleEl = document.getElementById('board-title');
  const repoBadgeEl = document.getElementById('repo-badge');
  const columnsContainer = document.getElementById('columns-container');

  if (boardState.repository && boardState.repository.slug) {
    boardTitleEl.textContent = 'GitHub Worker Board';
    repoBadgeEl.textContent = boardState.repository.slug;
    repoBadgeEl.style.display = 'inline-flex';
    repoBadgeEl.title = `Source: ${boardState.repository.source}`;
  } else {
    repoBadgeEl.style.display = 'none';
  }

  // Filter items by search query
  const query = (boardState.filterQuery || '').trim().toLowerCase();
  const filteredItems = boardState.items.filter((item) => {
    if (!query) return true;
    const matchNum = item.number && String(item.number).includes(query);
    const matchTitle = item.title && item.title.toLowerCase().includes(query);
    const matchAction = item.action && item.action.toLowerCase().includes(query);
    const matchPr = item.pullRequests && item.pullRequests.some(pr =>
      String(pr.number).includes(query) || (pr.title && pr.title.toLowerCase().includes(query))
    );
    return matchNum || matchTitle || matchAction || matchPr;
  });

  // Group items by column status
  const itemsByStatus = new Map();
  for (const col of boardState.columns) {
    itemsByStatus.set(col.name, []);
  }

  for (const item of filteredItems) {
    const status = item.status || 'Todo';
    if (!itemsByStatus.has(status)) {
      itemsByStatus.set(status, []);
    }
    itemsByStatus.get(status).push(item);
  }

  columnsContainer.innerHTML = '';

  for (const col of boardState.columns) {
    const isDone = col.name.toLowerCase() === 'done';
    if (isDone && boardState.hideDone) {
      continue;
    }

    const itemsInCol = itemsByStatus.get(col.name) || [];
    const colColor = col.color || COLUMN_COLORS[col.name] || 'var(--primary-color)';

    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.setAttribute('data-col-id', col.id);

    // Column Header
    const colHeader = document.createElement('div');
    colHeader.className = 'column-header';
    colHeader.innerHTML = `
      <div class="column-header-title">
        <span class="column-dot" style="background-color: ${colColor};"></span>
        <span>${escapeHtml(col.name)}</span>
      </div>
      <span class="column-count">${itemsInCol.length}</span>
    `;

    // Toggle collapse on header click
    colHeader.addEventListener('click', () => {
      colEl.classList.toggle('collapsed');
    });

    // Column Cards Body
    const cardsEl = document.createElement('div');
    cardsEl.className = 'column-cards';

    if (itemsInCol.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-column';
      emptyEl.style.cssText = 'color: var(--muted-fg); font-size: 11px; text-align: center; padding: 20px 8px;';
      emptyEl.textContent = 'No items';
      cardsEl.appendChild(emptyEl);
    } else {
      for (const item of itemsInCol) {
        cardsEl.appendChild(createCardElement(item));
      }
    }

    colEl.appendChild(colHeader);
    colEl.appendChild(cardsEl);
    columnsContainer.appendChild(colEl);
  }
}

/**
 * Creates DOM node for an issue card with direct links.
 */
function createCardElement(item) {
  const card = document.createElement('div');
  card.className = 'card';

  // Card Header (Direct Issue Link + Action Badge)
  const cardTop = document.createElement('div');
  cardTop.className = 'card-top';

  const idLink = document.createElement('a');
  idLink.className = 'card-id';
  idLink.href = item.url;
  idLink.target = '_blank';
  idLink.rel = 'noopener noreferrer';
  idLink.textContent = item.number ? `#${item.number}` : 'Issue';
  idLink.title = 'Open issue on GitHub';

  const badgesContainer = document.createElement('div');
  badgesContainer.className = 'card-badges';

  if (item.action && item.action !== 'NONE') {
    const actionBadge = document.createElement('span');
    const isActionable = item.actionable;
    actionBadge.className = `action-badge ${isActionable ? 'actionable' : 'waiting'}`;
    actionBadge.textContent = item.action;
    badgesContainer.appendChild(actionBadge);
  }

  cardTop.appendChild(idLink);
  cardTop.appendChild(badgesContainer);
  card.appendChild(cardTop);

  // Card Title with direct issue link
  const cardTitle = document.createElement('div');
  cardTitle.className = 'card-title';
  const titleLink = document.createElement('a');
  titleLink.href = item.url;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = item.title;
  titleLink.title = 'Open issue on GitHub';
  cardTitle.appendChild(titleLink);
  card.appendChild(cardTitle);

  // Associated PRs with direct links
  if (Array.isArray(item.pullRequests) && item.pullRequests.length > 0) {
    const prsContainer = document.createElement('div');
    prsContainer.className = 'card-prs';

    for (const pr of item.pullRequests) {
      const prPill = document.createElement('a');
      const prState = (pr.state || 'OPEN').toLowerCase();
      prPill.className = `pr-pill ${prState} ${pr.isDraft ? 'draft' : ''}`;
      prPill.href = pr.url;
      prPill.target = '_blank';
      prPill.rel = 'noopener noreferrer';
      prPill.title = pr.title || `Pull Request #${pr.number}`;

      const stateLabel = pr.isDraft ? 'Draft' : capitalize(prState);
      prPill.innerHTML = `<span>⑂ #${pr.number}</span> <span style="font-size: 10px; opacity: 0.85;">(${stateLabel})</span>`;
      prsContainer.appendChild(prPill);
    }

    card.appendChild(prsContainer);
  }

  return card;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Event Listeners setup
document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('refresh-btn');
  const retryBtn = document.getElementById('retry-btn');
  const filterInput = document.getElementById('filter-input');
  const hideDoneCheckbox = document.getElementById('hide-done-checkbox');
  const changeRepoBtn = document.getElementById('change-repo-btn');
  const repoForm = document.getElementById('repo-form');
  const repoInput = document.getElementById('repo-input');
  const promptBanner = document.getElementById('repo-prompt-banner');

  refreshBtn?.addEventListener('click', () => loadBoard());
  retryBtn?.addEventListener('click', () => loadBoard());

  changeRepoBtn?.addEventListener('click', () => {
    promptBanner.style.display = promptBanner.style.display === 'none' ? 'block' : 'none';
    if (promptBanner.style.display === 'block') {
      repoInput?.focus();
    }
  });

  repoForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (repoInput?.value || '').trim();
    if (val && val.includes('/')) {
      boardState.userOverrideRepo = val;
      loadBoard();
    }
  });

  filterInput?.addEventListener('input', (e) => {
    boardState.filterQuery = e.target.value;
    renderBoard();
  });

  hideDoneCheckbox?.addEventListener('change', (e) => {
    boardState.hideDone = e.target.checked;
    renderBoard();
  });

  // Re-resolve and reload when workspace changes in Antigravity
  if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
    window.sidecar.onWorkspaceChange((uris) => {
      if (Array.isArray(uris) && uris.length > 0) {
        boardState.activeWorkspaceUri = uris[0];
        boardState.userOverrideRepo = '';
        loadBoard();
      }
    });
  }

  // Initial load
  loadBoard();

  // Polling every 30 seconds
  setInterval(() => {
    loadBoard();
  }, 30000);
});
