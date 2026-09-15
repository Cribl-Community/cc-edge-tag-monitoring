// Thin client over the Cribl REST API. The platform fetch proxy injects auth
// and scopes requests (see AGENTS.md) — we never handle tokens here.
//
// Conventions:
//  - Base URL is window.CRIBL_API_URL.
//  - Endpoints not under /system are contextual via /m/:groupId.
//  - Search endpoints ALWAYS use groupId "default_search".
//  - Proxied requests time out after 30s; we use AbortController to bound our own.

const API = (): string => window.CRIBL_API_URL
export const SEARCH_GROUP = 'default_search'

/** The Cribl API base URL the host proxy injects (e.g. https://main-org.cribl.cloud/api/v1). */
export function apiBaseUrl(): string {
  return API()
}

/** Error carrying the HTTP status so callers can detect 403 (permission) etc. */
export class CriblApiError extends Error {
  status: number
  path: string
  constructor(message: string, status: number, path: string) {
    super(message)
    this.name = 'CriblApiError'
    this.status = status
    this.path = path
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  /** Overall timeout in ms; capped below the 30s proxy limit by default. */
  timeoutMs?: number
  /**
   * Content-Type for the request body. Defaults to application/json (body is
   * JSON-encoded). Set to 'text/plain' to send `body` verbatim as a raw string
   * — the KV store stores values with String(), so config must arrive as text,
   * not a parsed JSON object (which becomes "[object Object]").
   */
  contentType?: string
  /**
   * Fetch cache mode. Defaults to the browser default. Set 'no-store' for reads
   * that must reflect current server state on every call (e.g. the node/tag
   * inventory), so a relaunch never serves a stale cached response.
   */
  cache?: RequestCache
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = 28_000, contentType, cache } = opts
  const url = `${API()}${path}`

  // Bound the request so a stuck proxy call never hangs the UI.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // text/plain sends the body verbatim (it must already be a string); the
  // default JSON-encodes it.
  const isText = contentType === 'text/plain'
  const outBody = body == null ? undefined : isText ? String(body) : JSON.stringify(body)
  const outHeaders = body == null ? undefined : { 'Content-Type': contentType ?? 'application/json' }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: outHeaders,
      body: outBody,
      signal: controller.signal,
      ...(cache ? { cache } : {}),
    })
  } catch (err) {
    clearTimeout(timer)
    if (controller.signal.aborted) {
      throw new CriblApiError(`Request timed out or was cancelled: ${path}`, 0, path)
    }
    throw new CriblApiError(`Network error calling ${path}: ${String(err)}`, 0, path)
  }
  clearTimeout(timer)

  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      detail = parsed.message || parsed.error || text
    } catch {
      // Non-JSON body. Proxies / the Leader return an HTML page (e.g. Express's
      // "Cannot GET /path") on 404s — don't surface raw markup to the user.
      if (/^\s*<(?:!doctype|html|pre)/i.test(text)) detail = ''
    }
    if (!detail) detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    throw new CriblApiError(detail, res.status, path)
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    // Some endpoints (search results) return NDJSON — callers handle those directly.
    return text as unknown as T
  }
}

// ---------------------------------------------------------------------------
// Config groups (fleets) and workers (nodes)
// ---------------------------------------------------------------------------

export interface Fleet {
  id: string
  isFleet?: boolean
  onPrem?: boolean
  workerCount?: number
}

export interface WorkerNode {
  id: string
  group: string
  info?: {
    hostname?: string
    /** Remote ip:port for the worker socket. */
    conn_ip?: string
    /** True when the node runs in Cribl.Cloud (its hostname isn't the public ingest address). */
    isSaasWorker?: boolean
    cribl?: { tags?: string[] }
  }
}

interface Listed<T> {
  items?: T[]
  count?: number
}

/** Config groups for a product ("edge", "stream", ...). */
export async function getGroups(product: string, signal?: AbortSignal): Promise<Fleet[]> {
  const data = await request<Listed<Fleet>>(`/master/groups?product=${encodeURIComponent(product)}`, { signal })
  return data.items ?? []
}

/** Edge fleets. */
export async function getFleets(signal?: AbortSignal): Promise<Fleet[]> {
  return getGroups('edge', signal)
}

/**
 * Stream Worker Groups. Edge cannot write to Cribl Lake directly, so a Stream
 * group relays the data (Edge -> Cribl HTTP/TCP -> Stream -> Lake).
 */
export async function getStreamGroups(signal?: AbortSignal): Promise<Fleet[]> {
  return getGroups('stream', signal)
}

/** All worker nodes, carrying hostname + custom tags for the host->tag join. */
export async function getWorkers(signal?: AbortSignal): Promise<WorkerNode[]> {
  // no-store: the node/tag inventory must reflect current state on every launch
  // and re-check, so newly-applied tags are never masked by a cached response.
  const data = await request<Listed<WorkerNode>>('/master/workers', { signal, cache: 'no-store' })
  return data.items ?? []
}

// ---------------------------------------------------------------------------
// Config resources (contextual, per fleet) — used by the Setup Guide
// ---------------------------------------------------------------------------

export interface ConfItem {
  id: string
  type?: string
  [k: string]: unknown
}

export async function listInputs(fleet: string, signal?: AbortSignal): Promise<ConfItem[]> {
  const data = await request<Listed<ConfItem>>(`/m/${fleet}/system/inputs`, { signal })
  return data.items ?? []
}

export async function listOutputs(fleet: string, signal?: AbortSignal): Promise<ConfItem[]> {
  const data = await request<Listed<ConfItem>>(`/m/${fleet}/system/outputs`, { signal })
  return data.items ?? []
}

/** Create a config input on a fleet. Volatile — call only from a confirmed action. */
export async function createInput(fleet: string, def: Record<string, unknown>): Promise<ConfItem> {
  return request<ConfItem>(`/m/${fleet}/system/inputs`, { method: 'POST', body: def })
}

/** Update an existing input on a fleet (e.g. enable it). Volatile — confirmed action only. */
export async function updateInput(fleet: string, id: string, def: Record<string, unknown>): Promise<ConfItem> {
  return request<ConfItem>(`/m/${fleet}/system/inputs/${encodeURIComponent(id)}`, { method: 'PATCH', body: def })
}

// The Cribl Internal source (built-in singleton on every fleet) emits the
// internal metrics that carry per-host in/out byte counts. It cannot be
// created via POST — it already exists — so we detect it by type.
export const INTERNAL_SOURCE_TYPES = ['criblmetrics', 'cribl']

/** Find the built-in Cribl Internal metrics source in a fleet's input list. */
export function findInternalSource(inputs: ConfItem[]): ConfItem | undefined {
  // Prefer a dedicated criblmetrics source; fall back to the combined `cribl` source.
  for (const t of INTERNAL_SOURCE_TYPES) {
    const found = inputs.find((i) => i.type === t)
    if (found) return found
  }
  return undefined
}

/** Find a config item (source/destination) by its connector type. */
export function findByType(items: ConfItem[], type: string): ConfItem | undefined {
  return items.find((i) => i.type === type)
}

/** Create a config output on a fleet. Volatile — call only from a confirmed action. */
export async function createOutput(fleet: string, def: Record<string, unknown>): Promise<ConfItem> {
  return request<ConfItem>(`/m/${fleet}/system/outputs`, { method: 'POST', body: def })
}

export interface RouteTable {
  id: string
  routes: Record<string, unknown>[]
  comments?: unknown[]
  groups?: Record<string, unknown>
  [k: string]: unknown
}

/** Fetch a routing table with its ordered routes. */
export async function getRouteTable(
  fleet: string,
  routeTableId: string,
  signal?: AbortSignal,
): Promise<RouteTable> {
  const data = await request<Listed<RouteTable>>(`/m/${fleet}/routes/${routeTableId}`, { signal })
  const table = data.items?.[0]
  if (!table) {
    throw new CriblApiError(`Routing table "${routeTableId}" not found`, 0, `/m/${fleet}/routes/${routeTableId}`)
  }
  return table
}

// The default route is a catch-all: its filter is empty or the literal `true`.
// Because it's also `final`, any route placed AFTER it never matches — the
// catch-all consumes every event first. New routes must go before it.
function isCatchAll(r: Record<string, unknown>): boolean {
  const f = String(r.filter ?? '').trim()
  return f === '' || f === 'true'
}

/**
 * Insert (or replace) a route so it sits ABOVE the default catch-all route.
 * Appending would place it after the `filter:"true"`/`final` default route,
 * where nothing reaches it — so we read the table and rewrite it (PATCH),
 * putting our route just before the first catch-all. Idempotent: a route with
 * the same name is replaced in place, so re-runs don't duplicate it. Volatile —
 * confirmed action only.
 */
export async function upsertRoute(
  fleet: string,
  routeTableId: string,
  route: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const table = await getRouteTable(fleet, routeTableId, signal)
  const routes = (table.routes ?? []).filter((r) => r.name !== route.name)
  let idx = routes.findIndex(isCatchAll)
  if (idx < 0) idx = routes.length
  routes.splice(idx, 0, route)
  const body: Record<string, unknown> = { id: routeTableId, routes }
  if (table.comments) body.comments = table.comments
  if (table.groups) body.groups = table.groups
  return request(`/m/${fleet}/routes/${routeTableId}`, { method: 'PATCH', body })
}

interface GitCommitSummary {
  commit?: string
}
interface CountedGitCommitSummary {
  items?: GitCommitSummary[]
  count?: number
}

/**
 * Commit a fleet's pending config changes. Returns the new commit hash, which
 * deploy needs. Volatile — confirmed action only.
 */
export async function commitFleet(fleet: string, message: string): Promise<string> {
  const res = await request<CountedGitCommitSummary>(`/m/${fleet}/version/commit`, {
    method: 'POST',
    body: { message },
  })
  const commit = res.items?.[0]?.commit
  if (!commit) throw new CriblApiError('Commit did not return a version hash', 0, `/m/${fleet}/version/commit`)
  return commit
}

/** Deploy a specific committed version to a fleet. Volatile — confirmed action only. */
export async function deployFleet(fleet: string, version: string): Promise<unknown> {
  return request(`/master/groups/${fleet}/deploy`, { method: 'PATCH', body: { version } })
}

/** Commit pending changes, then deploy the resulting version. Confirmed action only. */
export async function commitAndDeployFleet(fleet: string, message: string): Promise<string> {
  const version = await commitFleet(fleet, message)
  await deployFleet(fleet, version)
  return version
}

// ---------------------------------------------------------------------------
// Pipelines — used only for the optional "bake node tags into events" feature
// ---------------------------------------------------------------------------

export interface Pipeline {
  id: string
  conf: Record<string, unknown>
  [k: string]: unknown
}

/** Fetch a pipeline by id, or null if it doesn't exist. */
export async function getPipeline(fleet: string, id: string, signal?: AbortSignal): Promise<Pipeline | null> {
  try {
    const data = await request<Listed<Pipeline>>(`/m/${fleet}/pipelines/${encodeURIComponent(id)}`, { signal })
    return data.items?.[0] ?? null
  } catch (err) {
    if (err instanceof CriblApiError && err.status === 404) return null
    throw err
  }
}

/**
 * Create or update a pipeline (POST if new, PATCH if it exists) so re-runs are
 * idempotent. Volatile — call only from a confirmed action.
 */
export async function upsertPipeline(fleet: string, def: Pipeline, signal?: AbortSignal): Promise<Pipeline> {
  const existing = await getPipeline(fleet, def.id, signal)
  if (existing) {
    return request<Pipeline>(`/m/${fleet}/pipelines/${encodeURIComponent(def.id)}`, { method: 'PATCH', body: def })
  }
  return request<Pipeline>(`/m/${fleet}/pipelines`, { method: 'POST', body: def })
}

// ---------------------------------------------------------------------------
// Cribl Lake datasets — list existing / create new (for the Setup Guide)
// ---------------------------------------------------------------------------

export interface LakeDataset {
  id: string
  description?: string
  format?: string
  retentionPeriodInDays?: number
  storageLocationId?: string
  bucketName?: string
  /** Present on built-in datasets that started deletion; treated as unusable. */
  deletionStartedAt?: number
  [k: string]: unknown
}

// Built-in datasets Cribl provisions. cribl_metrics/cribl_logs hold Leader-node
// telemetry, are free-retained, and CANNOT be used as a route destination.
export const SYSTEM_DATASET_IDS = ['cribl_metrics', 'cribl_logs']
export const NON_WRITABLE_DATASET_IDS = ['cribl_metrics', 'cribl_logs']

/**
 * List datasets in a Cribl Lake. The Lake dataset API is Cribl.Cloud-only; on a
 * deployment that doesn't serve it the proxy/Leader returns 404, which we turn
 * into a clearer message so the UI can offer a manual dataset-name fallback.
 */
export async function listLakeDatasets(lakeId: string, signal?: AbortSignal): Promise<LakeDataset[]> {
  try {
    const data = await request<Listed<LakeDataset>>(
      `/products/lake/lakes/${encodeURIComponent(lakeId)}/datasets`,
      { signal },
    )
    return data.items ?? []
  } catch (err) {
    if (err instanceof CriblApiError && err.status === 404) {
      throw new CriblApiError(
        'The Cribl Lake dataset API is available on Cribl.Cloud only and was not found on this deployment. If you know the dataset name, enter it manually.',
        404,
        err.path,
      )
    }
    throw err
  }
}

/** Create a dataset in a Cribl Lake. Volatile — call only from a confirmed action. */
export async function createLakeDataset(lakeId: string, def: Record<string, unknown>): Promise<LakeDataset> {
  return request<LakeDataset>(`/products/lake/lakes/${encodeURIComponent(lakeId)}/datasets`, {
    method: 'POST',
    body: def,
  })
}

// ---------------------------------------------------------------------------
// Cribl Search — async job flow (submit -> poll -> results NDJSON)
// ---------------------------------------------------------------------------

export interface SearchJob {
  id: string
  status?: string
  state?: string
  isFinished?: boolean
}

// Both create and get-by-id return a CountedSearchJob envelope ({ items: [job],
// count }), not a bare job — the actual SearchJob (with its id/status) is the
// first item. Reading a top-level `.id` yields undefined and the poll 404s.
function firstJob(data: Listed<SearchJob>, path: string): SearchJob {
  const job = data.items?.[0]
  if (!job?.id) throw new CriblApiError('Search job response contained no job id', 0, path)
  return job
}

export async function submitSearch(
  query: string,
  earliest: string,
  latest: string,
  signal?: AbortSignal,
): Promise<SearchJob> {
  const path = `/m/${SEARCH_GROUP}/search/jobs`
  const data = await request<Listed<SearchJob>>(path, {
    method: 'POST',
    body: { query, earliest, latest },
    signal,
  })
  return firstJob(data, path)
}

export async function getSearchJob(id: string, signal?: AbortSignal): Promise<SearchJob> {
  const path = `/m/${SEARCH_GROUP}/search/jobs/${id}`
  const data = await request<Listed<SearchJob>>(path, { signal })
  return firstJob(data, path)
}

// The /results NDJSON stream carries a SearchJobResults metadata line (its
// required fields are `isFinished` + `job` + the event counts) interleaved with
// the actual event lines. It has no data fields, so callers that dump rows
// verbatim (the Setup Guide sample) would otherwise show "job information"
// instead of events, and aggregations get a phantom host-less row.
function isResultsEnvelope(r: Record<string, unknown>): boolean {
  return typeof r.isFinished === 'boolean' && typeof r.job === 'object' && r.job !== null
}

/** Fetch results as parsed NDJSON rows (event rows only, sans the metadata line). */
export async function getSearchResults(id: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const raw = await request<string>(`/m/${SEARCH_GROUP}/search/jobs/${id}/results`, { signal })
  const rows = parseNdjson(typeof raw === 'string' ? raw : JSON.stringify(raw))
  return rows.filter((r) => !isResultsEnvelope(r))
}

export function parseNdjson(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      /* skip non-JSON lines (e.g. trailing metadata) */
    }
  }
  return rows
}

const TERMINAL_OK = new Set(['completed', 'done', 'finished', 'success'])
const TERMINAL_BAD = new Set(['failed', 'error', 'canceled', 'cancelled'])

/** A completed search: its job id (for deep-linking into the Search UI) and rows. */
export interface SearchRun {
  jobId: string
  rows: Record<string, unknown>[]
}

/**
 * Run a search end to end: submit, poll with backoff, return the job id and
 * result rows. Bounded by the caller's AbortSignal and an overall wall-clock cap.
 * The job id is exposed so the caller can deep-link to /search/<jobId> in the UI
 * (a bare /search with no job id renders blank).
 */
export async function runSearchJob(
  query: string,
  earliest: string,
  latest: string,
  signal?: AbortSignal,
  maxWaitMs = 55_000,
): Promise<SearchRun> {
  const job = await submitSearch(query, earliest, latest, signal)
  const started = Date.now()
  let delay = 500
  // Poll until the job reaches a terminal state or we hit the wall-clock cap.
  for (;;) {
    if (signal?.aborted) throw new CriblApiError('Search cancelled', 0, 'search')
    if (Date.now() - started > maxWaitMs) {
      throw new CriblApiError('Search timed out before completing', 0, 'search')
    }
    const status = await getSearchJob(job.id, signal)
    const state = String(status.status ?? status.state ?? '').toLowerCase()
    if (status.isFinished || TERMINAL_OK.has(state)) break
    if (TERMINAL_BAD.has(state)) {
      throw new CriblApiError(`Search job ${state || 'failed'}`, 0, 'search')
    }
    await sleep(Math.min(delay, 3000), signal)
    delay = Math.min(delay * 1.5, 3000)
  }
  const rows = await getSearchResults(job.id, signal)
  return { jobId: job.id, rows }
}

/**
 * Run a search end to end and return just the result rows. Thin wrapper over
 * {@link runSearchJob} for callers that don't need the job id.
 */
export async function runSearch(
  query: string,
  earliest: string,
  latest: string,
  signal?: AbortSignal,
  maxWaitMs = 55_000,
): Promise<Record<string, unknown>[]> {
  const { rows } = await runSearchJob(query, earliest, latest, signal, maxWaitMs)
  return rows
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

// ---------------------------------------------------------------------------
// App-scoped KV store (persistence — never use browser storage)
// ---------------------------------------------------------------------------

// The KV GET does not always return the stored value as a bare object: Cribl
// list-style endpoints wrap results in an envelope (e.g. { items: [value] }),
// some stores wrap in { value } / { data }, and some return the value as a
// JSON-encoded string. If we don't normalize, a caller that spreads the result
// (e.g. loadConfig) silently drops every field and falls back to defaults.
// kvUnwrap peels these shapes back to the stored value; a bare object is
// returned untouched.
function kvUnwrap(raw: unknown): unknown {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string') {
    try {
      return kvUnwrap(JSON.parse(raw))
    } catch {
      // Not JSON. Our KV values are always JSON, so a bare string here is
      // corrupt/legacy data (e.g. an object once stored as "[object Object]").
      // Treat it as absent so callers fall back to defaults instead of spreading
      // the string into character-indexed keys.
      return null
    }
  }
  if (Array.isArray(raw)) {
    // A results array — the stored value is the first (only) element.
    return raw.length ? kvUnwrap(raw[0]) : null
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    // Cribl's standard list envelope.
    if (Array.isArray(obj.items)) return obj.items.length ? kvUnwrap(obj.items[0]) : null
    // Single-key value wrappers, only when that's the sole property so we never
    // strip a real config that happens to contain a `value`/`data` field.
    const keys = Object.keys(obj)
    if (keys.length === 1 && (keys[0] === 'value' || keys[0] === 'data')) return kvUnwrap(obj[keys[0]])
  }
  return raw
}

export async function kvGet<T>(key: string, signal?: AbortSignal): Promise<T | null> {
  let raw: unknown
  try {
    raw = await request<unknown>(`/kvstore/${key}`, { signal })
  } catch (err) {
    if (err instanceof CriblApiError && err.status === 404) return null
    throw err
  }
  return kvUnwrap(raw) as T | null
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  // The store persists values via String(): a JSON object PUT becomes the
  // literal "[object Object]". So we serialize to JSON text ourselves and send
  // it as text/plain — String(jsonText) is a no-op, so it round-trips intact.
  // (Sending the JSON string as application/json is rejected 400 by the strict
  // body parser, which is why text/plain is required.)
  await request(`/kvstore/${key}`, { method: 'PUT', body: JSON.stringify(value), contentType: 'text/plain' })
}
