import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardState,
  COLUMN_COLORS,
  escapeHtml,
  capitalize,
  filterItems,
  groupItemsByStatus,
  createCardElement,
  renderBoard,
} from '../app.js';

describe('boardState', () => {
  it('does not contain hideDone property', () => {
    assert.equal('hideDone' in boardState, false);
  });
});

describe('COLUMN_COLORS', () => {
  it('does not define colors for removed Done status', () => {
    assert.equal('Done' in COLUMN_COLORS, false);
    assert.equal('done' in COLUMN_COLORS, false);
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and single quote', () => {
    const raw = `<script>alert("XSS" & 'test');</script>`;
    const escaped = escapeHtml(raw);
    assert.equal(escaped, '&lt;script&gt;alert(&quot;XSS&quot; &amp; &#39;test&#39;);&lt;/script&gt;');
  });

  it('handles non-string and nullish values defensively', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(123), '123');
    assert.equal(escapeHtml(true), 'true');
  });
});

describe('capitalize', () => {
  it('capitalizes the first character and lowercases the remainder', () => {
    assert.equal(capitalize('todo'), 'Todo');
    assert.equal(capitalize('IN PROGRESS'), 'In progress');
    assert.equal(capitalize('dOnE'), 'Done');
  });

  it('handles empty and nullish values safely', () => {
    assert.equal(capitalize(''), '');
    assert.equal(capitalize(null), '');
    assert.equal(capitalize(undefined), '');
  });
});

describe('filterItems', () => {
  const items = [
    {
      number: 1,
      title: 'Setup repository and workflows',
      action: 'NEEDS_PLAN',
      pullRequests: [],
    },
    {
      number: 2,
      title: 'Fix issue board refresh bug',
      action: 'USER_REPLIED',
      pullRequests: [{ number: 10, title: 'Fix refresh loop' }],
    },
    {
      number: 3,
      title: 'Update documentation for sidecars',
      action: 'WAITING_ON_USER',
      pullRequests: [{ number: 15, title: 'Docs update' }],
    },
  ];

  it('returns all items when query is empty or whitespace', () => {
    assert.equal(filterItems(items, '').length, 3);
    assert.equal(filterItems(items, '   ').length, 3);
    assert.equal(filterItems(items, null).length, 3);
  });

  it('filters by issue number', () => {
    const res = filterItems(items, '2');
    assert.equal(res.length, 1);
    assert.equal(res[0].number, 2);
  });

  it('filters by issue title substring case-insensitively', () => {
    const res = filterItems(items, 'BOARD');
    assert.equal(res.length, 1);
    assert.equal(res[0].number, 2);
  });

  it('filters by action status', () => {
    const res = filterItems(items, 'NEEDS_PLAN');
    assert.equal(res.length, 1);
    assert.equal(res[0].number, 1);
  });

  it('filters by linked PR number or title', () => {
    const byPrNum = filterItems(items, '15');
    assert.equal(byPrNum.length, 1);
    assert.equal(byPrNum[0].number, 3);

    const byPrTitle = filterItems(items, 'refresh loop');
    assert.equal(byPrTitle.length, 1);
    assert.equal(byPrTitle[0].number, 2);
  });

  it('handles missing or malformed item properties defensively', () => {
    const malformed = [{ number: null, title: null, action: null, pullRequests: null }];
    const res = filterItems(malformed, 'test');
    assert.equal(res.length, 0);
  });
});

describe('groupItemsByStatus', () => {
  const columns = [
    { id: 'todo', name: 'Todo' },
    { id: 'in_progress', name: 'In Progress' },
    { id: 'waiting', name: 'Waiting on User' },
    { id: 'in_review', name: 'In Review' },
  ];

  const items = [
    { id: '1', number: 1, status: 'Todo' },
    { id: '2', number: 2, status: 'In Progress' },
    { id: '3', number: 3, status: 'In Review' },
    { id: '4', number: 4, status: 'Waiting on User' },
    { id: '5', number: 5, status: 'Unknown' },
  ];

  it('groups items into sections according to status', () => {
    const grouped = groupItemsByStatus(columns, items);
    assert.equal(grouped.get('Todo')?.length, 1);
    assert.equal(grouped.get('In Progress')?.length, 1);
    assert.equal(grouped.get('In Review')?.length, 1);
    assert.equal(grouped.get('Waiting on User')?.length, 1);
    assert.equal(grouped.get('Unknown')?.length, 1);
  });

  it('initializes empty arrays for columns with no matching items', () => {
    const emptyItemsGrouped = groupItemsByStatus(columns, []);
    assert.equal(emptyItemsGrouped.get('Todo')?.length, 0);
    assert.equal(emptyItemsGrouped.get('In Progress')?.length, 0);
    assert.equal(emptyItemsGrouped.get('Waiting on User')?.length, 0);
    assert.equal(emptyItemsGrouped.get('In Review')?.length, 0);
  });
});

describe('createCardElement', () => {
  function createMockDocument() {
    return {
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: '',
          style: {},
          attributes: {},
          children: [],
          textContent: '',
          innerHTML: '',
          href: '',
          target: '',
          rel: '',
          title: '',
          setAttribute(name, val) { this.attributes[name] = val; },
          appendChild(child) { this.children.push(child); return child; },
          addEventListener() {},
        };
      },
    };
  }

  it('creates structured card element with direct links and badges', () => {
    const doc = createMockDocument();
    const item = {
      number: 42,
      title: 'Implement feature',
      url: 'https://github.com/org/repo/issues/42',
      action: 'NEEDS_PLAN',
      actionable: true,
      pullRequests: [
        {
          number: 100,
          title: 'PR for feature',
          url: 'https://github.com/org/repo/pull/100',
          state: 'OPEN',
          isDraft: false,
        },
      ],
    };

    const card = createCardElement(item, doc);
    assert.equal(card.className, 'card');
    assert.equal(card.children.length, 3); // cardTop, cardTitle, prsContainer

    const cardTop = card.children[0];
    const idLink = cardTop.children[0];
    assert.equal(idLink.href, item.url);
    assert.equal(idLink.textContent, '#42');

    const badgesContainer = cardTop.children[1];
    const badge = badgesContainer.children[0];
    assert.equal(badge.textContent, 'NEEDS_PLAN');
    assert.match(badge.className, /actionable/);

    const titleEl = card.children[1];
    assert.equal(titleEl.children[0].textContent, item.title);

    const prsContainer = card.children[2];
    assert.equal(prsContainer.children.length, 1);
    const prPill = prsContainer.children[0];
    assert.equal(prPill.href, 'https://github.com/org/repo/pull/100');
  });

  it('handles card with no action or PRs safely', () => {
    const doc = createMockDocument();
    const item = {
      number: 99,
      title: 'Simple task',
      url: 'https://github.com/org/repo/issues/99',
      action: 'NONE',
      actionable: false,
      pullRequests: [],
    };

    const card = createCardElement(item, doc);
    assert.equal(card.className, 'card');
    assert.equal(card.children.length, 2); // cardTop and cardTitle (no PRs container)
  });
});

describe('renderBoard', () => {
  it('renders stacked horizontal card sections into cards-container', () => {
    const mockElements = {
      'board-title': { textContent: '' },
      'repo-badge': { style: {}, textContent: '', title: '' },
      'cards-container': {
        innerHTML: '',
        children: [],
        appendChild(child) { this.children.push(child); return child; },
      },
    };
    const origDoc = globalThis.document;
    try {
      globalThis.document = {
        getElementById(id) { return mockElements[id] || null; },
        createElement(tag) {
          return {
            tagName: tag.toUpperCase(),
            className: '',
            style: {},
            attributes: {},
            children: [],
            textContent: '',
            innerHTML: '',
            setAttribute(name, val) { this.attributes[name] = val; },
            appendChild(child) { this.children.push(child); return child; },
            addEventListener() {},
          };
        },
      };

      boardState.repository = { slug: 'owner/repo', source: 'git' };
      boardState.columns = [
        { id: 'todo', name: 'Todo', color: '#89b4fa' },
        { id: 'in_progress', name: 'In Progress', color: '#fab387' },
      ];
      boardState.items = [
        { number: 1, title: 'Issue 1', status: 'Todo', action: 'NEEDS_PLAN', actionable: true, pullRequests: [] },
      ];
      boardState.filterQuery = '';

      renderBoard();

      assert.equal(mockElements['board-title'].textContent, 'GitHub Worker Board');
      assert.equal(mockElements['repo-badge'].textContent, 'owner/repo');
      assert.equal(mockElements['cards-container'].children.length, 2); // 2 sections

      const todoSection = mockElements['cards-container'].children[0];
      assert.match(todoSection.className, /board-section/);
      assert.equal(todoSection.children.length, 2); // header, cards body
    } finally {
      globalThis.document = origDoc;
    }
  });
});
