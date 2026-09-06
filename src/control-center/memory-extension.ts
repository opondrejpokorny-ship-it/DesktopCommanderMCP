import {
    getOperationalMemoryFilterOptions,
    getOperationalMemoryOverview,
    queryOperationalMemoryEvents,
    queryOperationalMemoryGroups,
    type MemoryBrowseScope,
    type MemoryEventQuery,
    type MemoryGroupQuery,
    type MemoryItemKind,
} from '../workflow/operational-memory-query.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
    ControlCenterRequestContextV1,
} from './contract.js';

const API_PREFIX = '/api/memory' as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SAFE_STRUCTURAL_VALUE = /^[A-Za-z0-9_.:@+\/-]{1,160}$/;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{4,1536}$/;

class MemoryRequestError extends Error {}

function badRequest(message = 'Invalid memory query.'): never {
    throw new MemoryRequestError(message);
}

function valuesFor(
    context: ControlCenterRequestContextV1,
    allowed: readonly string[],
): Record<string, string | undefined> {    const allowedSet = new Set(allowed);
    const result: Record<string, string | undefined> = Object.create(null);
    for (const [key, entries] of Object.entries(context.query)) {
        if (!allowedSet.has(key) || entries.length !== 1) badRequest();
        result[key] = entries[0];
    }
    return result;
}

function structural(value: string | undefined, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (!SAFE_STRUCTURAL_VALUE.test(value)) badRequest(`Invalid memory ${label}.`);
    return value;
}

function scope(value: string | undefined): MemoryBrowseScope {
    const resolved = value ?? 'project';
    if (resolved !== 'workflow' && resolved !== 'project' && resolved !== 'global') {
        badRequest('Invalid memory scope.');
    }
    return resolved;
}

function kind(value: string | undefined): MemoryItemKind | undefined {
    if (value === undefined) return undefined;
    if (value !== 'error' && value !== 'limit' && value !== 'lesson') {
        badRequest('Invalid memory kind.');
    }
    return value;
}
function positiveInteger(
    value: string | undefined,
    label: string,
    maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(value)) badRequest(`Invalid memory ${label}.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
        badRequest(`Invalid memory ${label}.`);
    }
    return parsed;
}

function date(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.length > 64) badRequest('Invalid memory date filter.');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) badRequest('Invalid memory date filter.');
    return new Date(parsed).toISOString();
}

function cursor(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!SAFE_CURSOR.test(value)) badRequest('Invalid memory cursor.');
    return value;
}

function validateDateRange(from: string | undefined, to: string | undefined): void {
    if (from && to && from > to) badRequest('Invalid memory date range.');
}
function isQueryCursorError(error: unknown): boolean {
    return error instanceof Error &&
        (error.message === 'Invalid memory cursor' ||
            error.message === 'Invalid memory event cursor');
}

async function respond(
    operation: () => Promise<unknown>,
): Promise<ControlCenterJsonResponseV1> {
    try {
        return { status: 200, body: await operation() };
    } catch (error) {
        if (error instanceof MemoryRequestError || isQueryCursorError(error)) {
            return { status: 400, body: { error: 'Invalid memory query.' } };
        }
        throw error;
    }
}

function parseGroups(context: ControlCenterRequestContextV1): MemoryGroupQuery {
    const values = valuesFor(context, [
        'projectId', 'scope', 'kind', 'reasonCode', 'lessonCode', 'sourceTool',
        'family', 'stageId', 'from', 'to', 'fingerprint', 'minOccurrences',
        'limit', 'cursor',
    ]);
    const from = date(values.from);
    const to = date(values.to);
    validateDateRange(from, to);
    const result: MemoryGroupQuery = {
        scope: scope(values.scope),
        limit: positiveInteger(values.limit, 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT,
    };    const projectId = structural(values.projectId, 'project');
    if (result.scope === 'global' && projectId !== undefined) badRequest();
    const itemKind = kind(values.kind);
    const reasonCode = structural(values.reasonCode, 'reason code');
    const lessonCode = structural(values.lessonCode, 'lesson code');
    const sourceTool = structural(values.sourceTool, 'source tool');
    const family = structural(values.family, 'family');
    const stageId = structural(values.stageId, 'stage');
    const fingerprint = structural(values.fingerprint, 'fingerprint');
    const minOccurrences = positiveInteger(values.minOccurrences, 'minimum occurrences');
    const nextCursor = cursor(values.cursor);
    return {
        ...result,
        ...(projectId ? { projectId } : {}),
        ...(itemKind ? { kind: itemKind } : {}),
        ...(reasonCode ? { reasonCode } : {}),
        ...(lessonCode ? { lessonCode } : {}),
        ...(sourceTool ? { sourceTool } : {}),
        ...(family ? { family } : {}),
        ...(stageId ? { stageId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(minOccurrences ? { minOccurrences } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
    };
}
function parseEvents(context: ControlCenterRequestContextV1): MemoryEventQuery {
    const values = valuesFor(context, [
        'projectId', 'workflowId', 'scope', 'from', 'to', 'limit', 'cursor',
    ]);
    const eventScope = scope(values.scope);
    const fingerprint = structural(context.params.fingerprint, 'fingerprint');
    if (!fingerprint) badRequest('Invalid memory fingerprint.');
    const projectId = structural(values.projectId, 'project');
    const workflowId = structural(values.workflowId, 'workflow');
    if (eventScope === 'global') {
        if (projectId !== undefined || workflowId !== undefined) badRequest();
    } else {
        if (!projectId) badRequest('Memory project is required.');
        if (eventScope === 'project' && workflowId !== undefined) badRequest();
        if (eventScope === 'workflow' && !workflowId) badRequest('Memory workflow is required.');
    }
    const from = date(values.from);
    const to = date(values.to);
    validateDateRange(from, to);
    const nextCursor = cursor(values.cursor);
    return {
        fingerprint,
        scope: eventScope,
        ...(projectId ? { projectId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: positiveInteger(values.limit, 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT,
        ...(nextCursor ? { cursor: nextCursor } : {}),
    };
}
async function handleOverview(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(async () => {
        valuesFor(context, []);
        return getOperationalMemoryOverview();
    });
}

async function handleGroups(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(() => queryOperationalMemoryGroups(parseGroups(context)));
}

async function handleEvents(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(() => queryOperationalMemoryEvents(parseEvents(context)));
}

async function handleFilterOptions(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(async () => {
        valuesFor(context, []);
        return getOperationalMemoryFilterOptions();
    });
}
export function createMemoryControlCenterExtension(): ControlCenterExtensionV1 {
    return {
        id: 'memory',
        apiPrefixes: [API_PREFIX],
        routes: [
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/overview',
                handle: handleOverview,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/groups',
                handle: handleGroups,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/groups/:fingerprint/events',
                handle: handleEvents,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/filter-options',
                handle: handleFilterOptions,
            },
        ],
        ui: {
            viewId: 'memory',
            label: 'Memory',
            html: MEMORY_UI_HTML,
            script: MEMORY_UI_SCRIPT,
        },
    };
}


const MEMORY_UI_HTML = `
<section id="memory-root">
  <h2>Memory</h2>
  <p id="memory-status">Open Memory to load the read-only index.</p>
  <div id="memory-overview">
    <strong data-memory-metric="total-events">—</strong> events ·
    <span data-memory-metric="fingerprints">—</span> fingerprints ·
    <span data-memory-metric="projects">—</span> projects ·
    <span data-memory-metric="health">—</span> index
  </div>
  <fieldset>
    <legend>Filters</legend>
    <label>Scope <select id="memory-filter-scope">
      <option value="project">Project</option>
      <option value="workflow">Workflow</option>
      <option value="global">Global</option>
    </select></label>
    <label>Project <select id="memory-filter-project"><option value="">All projects</option></select></label>
    <label>Kind <select id="memory-filter-kind">
      <option value="">All kinds</option><option value="error">Error</option>
      <option value="limit">Limit</option><option value="lesson">Lesson</option>
    </select></label>
    <label>Source tool <select id="memory-filter-source"><option value="">All tools</option></select></label>
    <label>Lesson <select id="memory-filter-lesson"><option value="">All lessons</option></select></label>
    <label>Minimum occurrences <input id="memory-filter-occurrences" type="number" min="1" step="1"></label>
    <label>From <input id="memory-filter-from" type="datetime-local"></label>
    <label>To <input id="memory-filter-to" type="datetime-local"></label>
  </fieldset>
  <h3>Groups</h3>
  <div id="memory-groups"><p class="dc-empty">Memory has not been loaded yet.</p></div>
  <button id="memory-load-more" type="button" hidden>Load more</button>
  <section aria-labelledby="memory-details-heading">
    <h3 id="memory-details-heading">Details</h3>
    <div id="memory-events"><p class="dc-empty">Select a group to inspect sanitized events.</p></div>
  </section>
</section>`;

const MEMORY_UI_SCRIPT = `(() => {
  const api = window.dcControlCenter.api;
  const byId = (id) => document.getElementById(id);
  const status = byId('memory-status');
  const groupsRoot = byId('memory-groups');
  const eventsRoot = byId('memory-events');
  const loadMore = byId('memory-load-more');
  let loaded = false;
  let loading = false;
  let nextCursor;
  let requestGeneration = 0;
  let eventRequestGeneration = 0;
  let activeAppendKey;

  function setText(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.textContent = String(value);
  }

  function empty(target, message) {
    target.replaceChildren();
    const node = document.createElement('p');
    node.className = 'dc-empty';
    node.textContent = message;
    target.append(node);
  }

  function fillSelect(id, values, labelFor) {
    const select = byId(id);
    const current = select.value;
    const first = select.firstElementChild.cloneNode(true);
    select.replaceChildren(first);
    for (const value of values) {
      const option = document.createElement('option');
      const raw = typeof value === 'string' ? value : value.projectId;
      option.value = raw;
      option.textContent = labelFor ? labelFor(value) : raw;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  function safePieces(values) {
    return values.filter((value) => value !== undefined && value !== null && value !== '').map(String);
  }
  function groupQuery(cursorValue) {
    const params = new URLSearchParams();
    const scope = byId('memory-filter-scope').value;
    params.set('scope', scope);
    params.set('limit', '50');
    const project = byId('memory-filter-project').value;
    if (scope !== 'global' && project) params.set('projectId', project);
    const mappings = [
      ['memory-filter-kind', 'kind'],
      ['memory-filter-source', 'sourceTool'],
      ['memory-filter-lesson', 'lessonCode'],
      ['memory-filter-occurrences', 'minOccurrences'],
      ['memory-filter-from', 'from'],
      ['memory-filter-to', 'to'],
    ];
    for (const [id, key] of mappings) {
      const value = byId(id).value;
      if (value) params.set(key, value);
    }
    if (cursorValue) params.set('cursor', cursorValue);
    return params;
  }

  function eventQuery(item) {
    const params = new URLSearchParams();
    params.set('scope', item.scope);
    params.set('limit', '50');
    if (item.scope !== 'global' && item.projectId) params.set('projectId', item.projectId);
    if (item.scope === 'workflow' && item.workflowId) params.set('workflowId', item.workflowId);
    return params;
  }
  function renderEvent(event) {
    const row = document.createElement('article');
    row.dataset.memoryEvent = 'true';
    const title = document.createElement('strong');
    title.textContent = safePieces([event.kind, event.reasonCode]).join(' · ');
    const meta = document.createElement('p');
    meta.textContent = safePieces([
      event.sourceTool, event.family, event.stageId, event.workflowId,
      event.taskId, event.runId, event.fingerprint, event.occurredAt,
    ]).join(' · ');
    row.append(title, meta);
    return row;
  }

  async function openDetails(item) {
    const generation = ++eventRequestGeneration;
    empty(eventsRoot, 'Loading sanitized events…');
    try {
      const params = eventQuery(item);
      const path = '/api/memory/groups/' + encodeURIComponent(item.fingerprint) + '/events?' + params;
      const page = await api(path);
      if (generation !== eventRequestGeneration) return;
      eventsRoot.replaceChildren();
      for (const event of page.items || []) eventsRoot.append(renderEvent(event));
      if (!eventsRoot.children.length) empty(eventsRoot, 'No sanitized events matched this group.');
    } catch (error) {
      if (generation !== eventRequestGeneration) return;
      empty(eventsRoot, error instanceof Error ? error.message : 'Unable to load memory events.');
    }
  }

  function renderGroup(item) {
    const row = document.createElement('article');
    row.dataset.memoryGroup = 'true';
    const title = document.createElement('strong');
    title.textContent = item.title || item.fingerprint;
    const lesson = document.createElement('p');
    lesson.textContent = item.lesson || '';
    const meta = document.createElement('p');
    meta.textContent = safePieces([
      item.scope, item.kind, item.reasonCode, item.lessonCode,
      item.sourceTool, item.family, item.stageId,
      item.projectDisplayName, item.workflowId,
      item.fingerprint, item.occurrences + ' occurrences', item.lastSeenAt,
    ]).join(' · ');
    const open = document.createElement('button');
    open.type = 'button';
    open.dataset.memoryOpen = 'true';
    open.textContent = 'Details';
    open.addEventListener('click', () => openDetails(item));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.memoryCopy = 'true';
    copy.textContent = 'Copy fingerprint';
    copy.addEventListener('click', async () => {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(item.fingerprint);
    });
    row.append(title, lesson, meta, open, copy);
    return row;
  }

  function appendGroups(items, append) {
    if (!append) groupsRoot.replaceChildren();
    for (const item of items) groupsRoot.append(renderGroup(item));
    if (!groupsRoot.children.length) empty(groupsRoot, 'No memory groups match these filters.');
  }

  async function refreshGroups(append = false) {
    const generation = append ? requestGeneration : ++requestGeneration;
    if (!append) {
      nextCursor = undefined;
      loadMore.hidden = true;
    }
    const cursorValue = append ? nextCursor : undefined;
    const appendKey = append && cursorValue ? String(generation) + ':' + cursorValue : undefined;
    if (append && (!cursorValue || activeAppendKey === appendKey)) return;
    if (append) activeAppendKey = appendKey;
    status.textContent = append ? 'Loading more memory…' : 'Loading memory groups…';
    try {
      const page = await api('/api/memory/groups?' + groupQuery(cursorValue));
      if (generation !== requestGeneration) return;
      appendGroups(page.items || [], append);
      nextCursor = page.nextCursor;
      loadMore.hidden = !nextCursor;
      status.textContent = page.health?.overall === 'healthy'
        ? 'Memory index ready.'
        : 'Memory index is ' + String(page.health?.overall || 'unavailable') + '.';
    } catch (error) {
      if (generation !== requestGeneration) return;
      nextCursor = undefined;
      loadMore.hidden = true;
      empty(groupsRoot, error instanceof Error ? error.message : 'Unable to load memory groups.');
      status.textContent = 'Memory groups unavailable.';
    } finally {
      if (append && activeAppendKey === appendKey) activeAppendKey = undefined;
    }
  }

  async function loadOverviewAndFilters() {
    const [overview, filters] = await Promise.all([
      api('/api/memory/overview'),
      api('/api/memory/filter-options'),
    ]);
    setText('[data-memory-metric="total-events"]', overview.totalEvents);
    setText('[data-memory-metric="fingerprints"]', overview.uniqueFingerprints);
    setText('[data-memory-metric="projects"]', overview.projectsWithMemory);
    setText('[data-memory-metric="health"]', overview.indexHealth?.overall || 'unavailable');
    fillSelect('memory-filter-project', filters.projects || [], (entry) => entry.displayName);
    fillSelect('memory-filter-source', filters.sourceTools || []);
    fillSelect('memory-filter-lesson', filters.lessonCodes || []);
  }
  function syncScope() {
    const global = byId('memory-filter-scope').value === 'global';
    const project = byId('memory-filter-project');
    project.disabled = global;
    if (global) project.value = '';
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    status.textContent = 'Loading read-only memory…';
    try {
      await loadOverviewAndFilters();
      await refreshGroups(false);
      loaded = true;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Memory is unavailable.';
    } finally {
      loading = false;
    }
  }

  const filterIds = [
    'memory-filter-scope', 'memory-filter-project', 'memory-filter-kind',
    'memory-filter-source', 'memory-filter-lesson', 'memory-filter-occurrences',
    'memory-filter-from', 'memory-filter-to',
  ];
  for (const id of filterIds) {
    byId(id).addEventListener('change', () => {
      if (id === 'memory-filter-scope') syncScope();
      eventRequestGeneration += 1;
      empty(eventsRoot, 'Select a group to inspect sanitized events.');
      if (loaded) refreshGroups(false);
    });
  }
  loadMore.addEventListener('click', () => {
    if (loaded && nextCursor) refreshGroups(true);
  });
  syncScope();
  const memoryButton = document.querySelector('[data-dc-target="memory"]');
  if (memoryButton) memoryButton.addEventListener('click', () => ensureLoaded());
})();`;
