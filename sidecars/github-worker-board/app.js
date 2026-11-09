// GitHub Worker Board Sidecar Client Application

export const boardState = {
  repository: null,
  columns: [],
  items: [],
  lastUpdated: null,
  activeWorkspaceUri: null,
  userOverrideRepo: '',
  filterQuery: '',
  isRefreshing: false,
};

export const COLUMN_COLORS = {
  'Todo': 'var(--status-todo)',
  'In progress': 'var(--status-in-progress)',
  'In Progress': 'var(--status-in-progress)',
  'Waiting on User': 'var(--status-waiting)',
  'In review': 'var(--status-in-review)',
  'In Review': 'var(--status-in-review)',
};

/**
 * Escapes special HTML characters defensively to mitigate XSS vulnerabilities.
 * Safely handles strings, numbers, null, and undefined values.
 *
 * @param {*} str - Input value to escape.
 * @returns {string} Escaped string.
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalizes string casing with capitalized first letter.
 *
 * @param {string} s - Input string.
 * @returns {string} Capitalized string.
 */
export function capitalize(s) {
  if (!s) return '';
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Filters board items against search query across issue numbers, titles,
 * action states, and linked PR numbers/titles.
 *
 * @param {Array<object>} items - Array of board items.
 * @param {string} query - Search query.
 * @returns {Array<object>} Filtered items array.
 */
export function filterItems(items, query) {
  if (!Array.isArray(items)) return [];
  const q = (query || '').trim().toLowerCase();
  if (!q) return items;

  return items.filter((item) => {
    if (!item) return false;
    const matchNum = item.number != null && String(item.number).includes(q);
    const matchTitle = item.title && item.title.toLowerCase().includes(q);
    const matchAction = item.action && item.action.toLowerCase().includes(q);
    const matchPr = Array.isArray(item.pullRequests) && item.pullRequests.some((pr) =>
      (pr?.number != null && String(pr.number).includes(q)) ||
      (pr?.title && pr.title.toLowerCase().includes(q))
    );
    return Boolean(matchNum || matchTitle || matchAction || matchPr);
  });
}

/**
 * Groups items into a Map indexed by column/status name.
 * Pre-populates buckets for all configured columns.
 *
 * @param {Array<object>} columns - Configured columns.
 * @param {Array<object>} items - Board items to group.
 * @returns {Map<string, Array<object>>} Map of status names to items.
 */
export function groupItemsByStatus(columns, items) {
  const map = new Map();
  const validCols = Array.isArray(columns) ? columns : [];
  for (const col of validCols) {
    map.set(col.name, []);
  }

  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (!item) continue;
    const status = item.status || 'Todo';
    if (!map.has(status)) {
      map.set(status, []);
    }
    map.get(status).push(item);
  }

  return map;
}

/**
 * Fetch wrapper that prioritizes window.sidecar.fetch when running in Antigravity.
 *
 * @param {string} url - Request URL.
 * @param {object} [options={}] - Fetch options.
 * @returns {Promise<Response>} Fetch response.
 */
export async function apiFetch(url, options = {}) {
  if (typeof window !== 'undefined' && window.sidecar && typeof window.sidecar.fetch === 'function') {
    return window.sidecar.fetch(url, options);
  }
  return fetch(url, options);
}

/**
 * Resolves current workspace URI from window.sidecar when available.
 * Uses a safe timeout race to prevent indefinite suspension if host events are delayed.
 *
 * @param {number} [timeoutMs=2000] - Timeout in milliseconds for resolution.
 * @returns {Promise<string>} Workspace URI or empty string.
 */
export async function resolveWorkspaceUri(timeoutMs = 2000) {
  if (typeof window !== 'undefined' && window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
    try {
      const urisPromise = window.sidecar.getWorkspaceUris();
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs));
      const uris = await Promise.race([urisPromise, timeoutPromise]);
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
 * Creates DOM node for an issue card with direct links and action badges.
 * Accepts an injectable document context for unit testability in non-browser environments.
 *
 * @param {object} item - Issue card item data.
 * @param {Document|object} [doc=(typeof document !== 'undefined' ? document : null)] - DOM document context.
 * @returns {HTMLElement|null}
 */
export function createCardElement(item, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || !doc.createElement || !item) return null;

  const card = doc.createElement('div');
  card.className = 'card';

  // Card Header (Direct Issue Link + Action Badge)
  const cardTop = doc.createElement('div');
  cardTop.className = 'card-top';

  const idLink = doc.createElement('a');
  idLink.className = 'card-id';
  idLink.href = item.url || '#';
  idLink.target = '_blank';
  idLink.rel = 'noopener noreferrer';
  idLink.textContent = item.number ? `#${item.number}` : 'Issue';
  idLink.title = 'Open issue on GitHub';

  const badgesContainer = doc.createElement('div');
  badgesContainer.className = 'card-badges';

  if (item.action && item.action !== 'NONE') {
    const actionBadge = doc.createElement('span');
    const isActionable = Boolean(item.actionable);
    actionBadge.className = `action-badge ${isActionable ? 'actionable' : 'waiting'}`;
    actionBadge.textContent = item.action;
    badgesContainer.appendChild(actionBadge);
  }

  cardTop.appendChild(idLink);
  cardTop.appendChild(badgesContainer);
  card.appendChild(cardTop);

  // Card Title with direct issue link
  const cardTitle = doc.createElement('div');
  cardTitle.className = 'card-title';
  const titleLink = doc.createElement('a');
  titleLink.href = item.url || '#';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = item.title || '';
  titleLink.title = 'Open issue on GitHub';
  cardTitle.appendChild(titleLink);
  card.appendChild(cardTitle);

  // Associated PRs with direct links
  if (Array.isArray(item.pullRequests) && item.pullRequests.length > 0) {
    const prsContainer = doc.createElement('div');
    prsContainer.className = 'card-prs';

    for (const pr of item.pullRequests) {
      if (!pr) continue;
      const prPill = doc.createElement('a');
      const prState = (pr.state || 'OPEN').toLowerCase();
      prPill.className = `pr-pill ${prState} ${pr.isDraft ? 'draft' : ''}`;
      prPill.href = pr.url || '#';
      prPill.target = '_blank';
      prPill.rel = 'noopener noreferrer';
      prPill.title = pr.title || `Pull Request #${pr.number}`;

      const stateLabel = pr.isDraft ? 'Draft' : capitalize(prState);
      prPill.innerHTML = `<span>⑂ #${pr.number}</span> <span style="font-size: 10px; opacity: 0.85;">(${escapeHtml(stateLabel)})</span>`;
      prsContainer.appendChild(prPill);
    }

    card.appendChild(prsContainer);
  }

  return card;
}

/**
 * Fetches the issue board data from backend and updates UI.
 */
export async function loadBoard() {
  if (boardState.isRefreshing) return;
  boardState.isRefreshing = true;

  const refreshBtn = typeof document !== 'undefined' ? document.getElementById('refresh-btn') : null;
  const errorBanner = typeof document !== 'undefined' ? document.getElementById('error-banner') : null;
  const errorMsg = typeof document !== 'undefined' ? document.getElementById('error-message') : null;
  const promptBanner = typeof document !== 'undefined' ? document.getElementById('repo-prompt-banner') : null;
  const statusBar = typeof document !== 'undefined' ? document.getElementById('last-updated-text') : null;
  const changeRepoBtn = typeof document !== 'undefined' ? document.getElementById('change-repo-btn') : null;

  refreshBtn?.classList.add('spinning');
  if (errorBanner) errorBanner.style.display = 'none';

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
      if (promptBanner) promptBanner.style.display = 'block';
      if (statusBar) statusBar.textContent = 'Awaiting target repository';
      boardState.repository = null;
      boardState.items = [];
      renderBoard();
      return;
    }

    if (promptBanner) promptBanner.style.display = 'none';
    if (changeRepoBtn) changeRepoBtn.style.display = 'inline-flex';

    boardState.repository = data.repository;
    boardState.columns = data.columns || [];
    boardState.items = data.items || [];
    boardState.lastUpdated = data.lastUpdated;

    renderBoard();

    if (boardState.lastUpdated && statusBar) {
      const timeStr = new Date(boardState.lastUpdated).toLocaleTimeString();
      const actionableCount = boardState.items.filter((i) => i.actionable).length;
      statusBar.textContent = `Updated at ${timeStr} • ${boardState.items.length} items (${actionableCount} actionable)`;
    }
  } catch (err) {
    console.error('Failed to load issues board:', err);
    if (errorMsg) errorMsg.textContent = `Error: ${err.message}`;
    if (errorBanner) errorBanner.style.display = 'flex';
    if (statusBar) statusBar.textContent = 'Update failed';
  } finally {
    boardState.isRefreshing = false;
    refreshBtn?.classList.remove('spinning');
  }
}

/**
 * Renders the stacked horizontal cards grouped cleanly by status into the DOM.
 */
export function renderBoard() {
  if (typeof document === 'undefined') return;

  const boardTitleEl = document.getElementById('board-title');
  const repoBadgeEl = document.getElementById('repo-badge');
  const cardsContainer = document.getElementById('cards-container') || document.getElementById('columns-container');
  if (!cardsContainer) return;

  if (boardState.repository && boardState.repository.slug) {
    if (boardTitleEl) boardTitleEl.textContent = 'GitHub Worker Board';
    if (repoBadgeEl) {
      repoBadgeEl.textContent = boardState.repository.slug;
      repoBadgeEl.style.display = 'inline-flex';
      repoBadgeEl.title = `Source: ${boardState.repository.source}`;
    }
  } else if (repoBadgeEl) {
    repoBadgeEl.style.display = 'none';
  }

  const filteredItems = filterItems(boardState.items, boardState.filterQuery);
  const itemsByStatus = groupItemsByStatus(boardState.columns, filteredItems);

  cardsContainer.innerHTML = '';

  for (const col of boardState.columns) {
    const itemsInCol = itemsByStatus.get(col.name) || [];
    const colColor = col.color || COLUMN_COLORS[col.name] || 'var(--primary-color)';

    const sectionEl = document.createElement('div');
    sectionEl.className = 'board-section column';
    sectionEl.setAttribute('data-col-id', col.id);

    // Section Header
    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'section-header column-header';
    sectionHeader.innerHTML = `
      <div class="section-header-title column-header-title">
        <span class="section-dot column-dot" style="background-color: ${escapeHtml(colColor)};"></span>
        <span>${escapeHtml(col.name)}</span>
      </div>
      <span class="section-count column-count">${itemsInCol.length}</span>
    `;

    sectionHeader.addEventListener('click', () => {
      sectionEl.classList.toggle('collapsed');
    });

    // Section Cards Body
    const cardsEl = document.createElement('div');
    cardsEl.className = 'section-cards column-cards';

    if (itemsInCol.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-section empty-column';
      emptyEl.style.cssText = 'color: var(--muted-fg); font-size: 11px; text-align: center; padding: 12px 8px;';
      emptyEl.textContent = 'No items';
      cardsEl.appendChild(emptyEl);
    } else {
      for (const item of itemsInCol) {
        const cardNode = createCardElement(item, document);
        if (cardNode) {
          cardsEl.appendChild(cardNode);
        }
      }
    }

    sectionEl.appendChild(sectionHeader);
    sectionEl.appendChild(cardsEl);
    cardsContainer.appendChild(sectionEl);
  }
}

/**
 * Initializes DOM event listeners and triggers initial board load.
 */
function initApp() {
  const refreshBtn = document.getElementById('refresh-btn');
  const retryBtn = document.getElementById('retry-btn');
  const filterInput = document.getElementById('filter-input');
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
}

// Event Listeners setup for browser execution
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
