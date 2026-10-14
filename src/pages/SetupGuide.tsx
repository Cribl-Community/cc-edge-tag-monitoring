// Setup Guide: explains the relay architecture and offers assisted,
// explicitly-confirmed provisioning of the pieces on a chosen Stream Worker
// Group (receiver) and Edge fleet (sender), plus a live verify step that shows
// the real field names so the Settings field mapping can be made accurate.
//
// Edge cannot write to Cribl Lake directly (HTTP 405 — destination/cribl_lake is
// disabled on Edge). Metrics relay through a Stream Worker Group:
//   Edge --(Cribl HTTP/TCP)--> Stream WG --(Cribl Lake)--> dataset --> Search.
//
// Every write (create source/destination, append route, deploy) happens only
// from a confirmation modal that names the exact resource + group — never
// automatically, on load, or on a timer (see AGENTS.md).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Collapse,
  EmptyState,
  Modal,
  Pill,
  SelectField,
  Spinner,
  Switch,
  Tag,
  Text,
  TextField,
} from '@capra/core'
import { HelpPopover } from '../components/HelpPopover'
import { StepRow } from '../components/StepRow'
import {
  apiBaseUrl,
  upsertRoute,
  upsertPipeline,
  commitAndDeployFleet,
  createInput,
  createLakeDataset,
  createOutput,
  findByType,
  findInternalSource,
  getFleets,
  getRouteTable,
  getStreamGroups,
  getWorkers,
  listInputs,
  listLakeDatasets,
  listOutputs,
  runSearch,
  updateInput,
  type ConfItem,
  type Fleet,
  type LakeDataset,
  type Pipeline,
  type WorkerNode,
  CriblApiError,
  NON_WRITABLE_DATASET_IDS,
  SYSTEM_DATASET_IDS,
} from '../api/cribl'
import { loadConfig, saveConfig, type AppConfig, type RelayTransport } from '../lib/config'
import { buildTagIndex } from '../lib/tags'
import { buildSampleQuery, rangeById, rangeBounds } from '../lib/query'

// Edge cannot write to Cribl Lake directly (HTTP 405 — destination/cribl_lake is
// disabled on Edge deployments). Metrics therefore relay through a Stream Worker
// Group: Edge --(Cribl HTTP/TCP)--> Stream WG --(Cribl Lake)--> dataset.
//
// Fixed ids for the resources this guide manages, so re-runs are idempotent
// (detection matches on these ids). The internal metrics SOURCE on Edge is built
// in and cannot be created — we detect/enable the existing one instead.
const EDGE_RELAY_ID = 'cc_edge_tag_relay' // Cribl HTTP/TCP destination on the Edge fleet
const STREAM_SRC_ID = 'cc_edge_tag_in' // Cribl HTTP/TCP source on the Stream WG
const LAKE_DEST_ID = 'cc_edge_tag_lake' // Cribl Lake destination on the Stream WG
const EDGE_ROUTE = 'cc_edge_tag_to_relay'
const STREAM_ROUTE = 'cc_edge_tag_to_lake'
const EDGE_ENRICH_PIPELINE = 'cc_edge_tag_enrich' // optional relay-route pipeline that bakes tags into fields
// The Cribl Internal metrics source ships with this pre-processing pipeline by
// default (verified live: CriblMetrics source → pipeline: 'cribl_metrics_rollup').
// It aggregates metrics into time windows AND strips __metadata.cribl.tags — so
// to bake tags we must remove it from the source (source.pipeline = '') and put
// the enrich pipeline on the route instead; stopping baking restores it.
const METRICS_ROLLUP_PIPELINE = 'cribl_metrics_rollup'
const ROUTE_TABLE = 'default'
const HTTP_PORT = 10200
const TCP_PORT = 10300
// Internal metrics arrive from the built-in Cribl Internal source; match by its
// input id, which Cribl stamps as "<type>:<id>". Both hops filter on the same
// prefixes, so build the two expressions from one place.
const INTERNAL_INPUT_PREFIXES = ['cribl:', 'criblmetrics:']
function internalInputMatch(field: string): string {
  return INTERNAL_INPUT_PREFIXES.map((p) => `${field}.startsWith('${p}')`).join(' || ')
}
// Edge side: the live __inputId on the fleet that produced the event.
const INPUT_MATCH = internalInputMatch('__inputId')
// Stream side: the relayed copy of that id. A Cribl HTTP/TCP source nests the
// sender's internal fields under __forwardedAttrs (copied, not moved — see
// docs.cribl.io "Internal Fields" for the Cribl HTTP/TCP sources), so the route
// matches on the ORIGINATING Edge source rather than on the relay destination
// id. That makes it independent of what the Edge destination is called, at the
// cost of also catching internal metrics relayed in by destinations this app
// didn't create. Guarded: events that didn't arrive over a relay have no
// __forwardedAttrs at all.
const STREAM_FILTER = `__forwardedAttrs && typeof __forwardedAttrs.__inputId === 'string' && (${internalInputMatch('__forwardedAttrs.__inputId')})`
// Stable empty-array fallback for config.edgeFleets so its reference doesn't change
// every render (keeps detectEdge / the addable-fleets memo from re-firing needlessly).
const NO_FLEETS: string[] = []

const TRANSPORT_ITEMS = [
  { id: 'cribl_http', label: 'Cribl HTTP' },
  { id: 'cribl_tcp', label: 'Cribl TCP' },
]

function transportLabel(t: RelayTransport): string {
  return t === 'cribl_http' ? 'Cribl HTTP' : 'Cribl TCP'
}

function defaultPort(t: RelayTransport): number {
  return t === 'cribl_http' ? HTTP_PORT : TCP_PORT
}

// Cribl.Cloud ingest hostname follows <group>.<workspace>.<orgId>.<domain>,
// while the API/UI host is <workspace>-<orgId>.<domain>. Reconstruct the ingest
// host from the API URL — so the environment (cribl.cloud vs cribl-staging.cloud)
// is inferred, never hard-coded — plus the chosen Worker Group. Returns '' when
// the host isn't a Cribl-managed Cloud host (self-managed deployments).
function deriveCloudEndpoint(
  apiUrl: string,
  streamGroup: string,
  transport: RelayTransport,
  port: number,
): string {
  if (!streamGroup) return ''
  let host: string
  try {
    host = new URL(apiUrl).hostname
  } catch {
    return ''
  }
  // e.g. main-confident-lamport-au67yec.cribl-staging.cloud
  if (!/\.cribl(-staging)?\.cloud$/i.test(host)) return ''
  const firstDot = host.indexOf('.')
  if (firstDot < 0) return ''
  const first = host.slice(0, firstDot) // <workspace>-<orgId>
  const domain = host.slice(firstDot + 1) // cribl.cloud | cribl-staging.cloud
  const firstHyphen = first.indexOf('-')
  if (firstHyphen < 0) return ''
  const workspace = first.slice(0, firstHyphen) // main
  const orgId = first.slice(firstHyphen + 1) // confident-lamport-au67yec
  if (!workspace || !orgId) return ''
  const ingestHost = `${streamGroup}.${workspace}.${orgId}.${domain}`
  // HTTP wants a full URL; TCP takes a bare host (port is a separate field).
  return transport === 'cribl_http' ? `https://${ingestHost}:${port}` : ingestHost
}

// Endpoint for the Edge -> Stream hop. For Cribl.Cloud we derive the ingest URL
// from the API host + Worker Group (reliable). For self-managed deployments the
// public address isn't in the API, so we fall back to a worker node's hostname
// as a best-effort pre-fill. Either way the field stays user-editable.
function deriveEndpoint(
  workers: WorkerNode[],
  streamGroup: string,
  transport: RelayTransport,
  port: number,
): { endpoint: string; isCloud: boolean } {
  const cloud = deriveCloudEndpoint(apiBaseUrl(), streamGroup, transport, port)
  if (cloud) return { endpoint: cloud, isCloud: true }
  const node = workers.find((w) => w.group === streamGroup && w.info?.hostname)
  const host = node?.info?.hostname ?? ''
  if (!host) return { endpoint: '', isCloud: false }
  const isCloud = Boolean(node?.info?.isSaasWorker)
  const endpoint = transport === 'cribl_http' ? `https://${host}:${port}` : host
  return { endpoint, isCloud }
}

// Build the Edge route filter. When throughputOnly is on, we additionally keep
// only byte-throughput metrics — those whose name ends in "in_bytes"/"out_bytes"
// (covers total.*, host.*, source.*, etc.) — so only what the dashboard sums is
// relayed, cutting volume (fewer credits). We key off the configured metric-name
// field and guard against non-string names so non-metric events are dropped.
// When off, the full internal-metrics stream is routed.
function buildRouteFilter(metricNameField: string, throughputOnly: boolean): string {
  if (!throughputOnly) return INPUT_MATCH
  const n = `(${metricNameField} || '')`
  return `(${INPUT_MATCH}) && (${n}.endsWith('in_bytes') || ${n}.endsWith('out_bytes'))`
}

// Build the optional "bake tags into events" pipeline. It's generic — it does
// NOT need the tag keys ahead of time, so it adapts to whatever tags a node
// carries:
//   1. Eval: build a temporary `_tagstr` from the node's __metadata.cribl.tags
//      (a "KEY:VALUE" string array) — joined with spaces, with ':' rewritten to
//      '=' → e.g. "site=1 test=no". Guarded so events without the metadata get "".
//   2. Serde (kvp, extract): parse `_tagstr` into like-named fields (site, test,
//      …) so the dashboard can group on them directly.
//   3. Eval: drop the temporary `_tagstr`.
// The Eval value is scope-free (a ternary over Array.isArray / join / replace, no
// arrow-function callback), which Cribl's jsExpression validator requires.
function buildEnrichPipeline(): Pipeline {
  return {
    id: EDGE_ENRICH_PIPELINE,
    conf: {
      description: 'cc-edge-tag-monitoring: surface node tags (__metadata.cribl.tags) into fields',
      streamtags: ['cc-edge-tag-monitoring'],
      groups: {},
      functions: [
        {
          id: 'eval',
          filter: 'true',
          conf: {
            printUndefineds: false,
            add: [
              {
                disabled: false,
                name: '_tagstr',
                value:
                  "(__metadata && __metadata.cribl && Array.isArray(__metadata.cribl.tags)) ? __metadata.cribl.tags.join(' ').replace(/:/g, '=') : ''",
              },
            ],
          },
        },
        {
          id: 'serde',
          filter: 'true',
          conf: {
            mode: 'extract',
            type: 'kvp',
            srcField: '_tagstr',
            cleanFields: false,
            allowedKeyChars: [],
            allowedValueChars: [],
            tagDatatype: false,
          },
        },
        {
          id: 'eval',
          filter: 'true',
          conf: {
            printUndefineds: false,
            add: [],
            remove: ['_tagstr'],
          },
        },
      ],
    },
  }
}

interface EdgeReadiness {
  /** The built-in internal metrics source, if present on the fleet. */
  source: ConfItem | null
  sourceEnabled: boolean
  hasRelay: boolean
  /** True when our tag-enrichment pipeline is set as the relay route's pipeline. */
  enrichEnabled: boolean
  /**
   * True when the source still runs the default cribl_metrics_rollup
   * pre-processing pipeline (which strips __metadata.cribl.tags). Baking tags
   * requires this to be removed; if enrichEnabled is true but this is still true,
   * baking is half-configured and tag fields won't land.
   */
  sourceRollup: boolean
}

interface StreamReadiness {
  /** The Cribl HTTP/TCP source that receives relayed Edge data, if present. */
  source: ConfItem | null
  sourceEnabled: boolean
  hasLakeDest: boolean
  lakeDataset: string | null
}

type Outcome = { kind: 'ok' | 'err'; message: string }

/** Collapsible sections of the guide. One is open at a time (see `expanded`). */
type SectionId = 'how' | 'dataset' | 'stream' | 'edge' | 'verify' | 'conn'

export function SetupGuide() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [fleets, setFleets] = useState<Fleet[]>([])
  const [streamGroups, setStreamGroups] = useState<Fleet[]>([])
  const [workers, setWorkers] = useState<WorkerNode[]>([])
  const [fleet, setFleet] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Per-fleet readiness, keyed by fleet id. Several Edge fleets can relay into the
  // same Stream group, so we track each fleet's status independently.
  const [edgeStatus, setEdgeStatus] = useState<Record<string, EdgeReadiness>>({})
  const [stream, setStream] = useState<StreamReadiness | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const [sample, setSample] = useState<Record<string, unknown>[] | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  // Accordion: exactly one section open at a time. Until the reader touches a
  // header, the open section is DERIVED from readiness (the first incomplete
  // one), so the guide opens on the next thing to do and advances by itself as
  // steps complete. The first header click pins the choice from then on — see
  // `expanded` below. Deriving rather than syncing avoids a setState-in-effect.
  const [pinnedSection, setPinnedSection] = useState<{ id: SectionId | null } | null>(null)

  // Load config + edge fleets + stream groups + workers once.
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const [cfg, fl, sg, wk] = await Promise.all([
          loadConfig(ctrl.signal),
          getFleets(ctrl.signal),
          getStreamGroups(ctrl.signal),
          getWorkers(ctrl.signal),
        ])
        setConfig(cfg)
        setFleets(fl)
        setStreamGroups(sg)
        setWorkers(wk)
        // Prefer a previously-monitored fleet; else the first available.
        setFleet((prev) => prev || cfg.edgeFleets[0] || fl[0]?.id || '')
      } catch (err) {
        if (!ctrl.signal.aborted) setLoadError(describe(err))
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [])

  const dataset = config?.datasetName?.trim() || ''
  const throughputOnly = config?.throughputOnly ?? true
  const streamGroup = config?.streamGroup ?? ''
  const transport = config?.relayTransport ?? 'cribl_http'
  const relayPort = config?.relayPort ?? HTTP_PORT
  const relayEndpoint = config?.relayEndpoint?.trim() ?? ''
  const bakeTags = config?.bakeTags ?? false
  // Id of the Edge relay destination. Customizable — the Stream route matches on
  // it, so a rename must flow through to the filter. Falls back to the default.
  // Shared across ALL monitored Edge fleets so one Stream route catches them all.
  const relayDestId = config?.relayDestId?.trim() || EDGE_RELAY_ID
  // Edge fleets being monitored (senders). Auto-tracked as fleets are configured.
  // Fall back to a stable module-level empty array so the reference doesn't change
  // every render (would otherwise re-fire detectEdge / the addable-fleets memo).
  const edgeFleets = config?.edgeFleets ?? NO_FLEETS
  // Readiness of the fleet currently open in the drilldown.
  const edge = fleet ? edgeStatus[fleet] ?? null : null

  // Tag KEYs present on the selected fleet's nodes — one enrichment field each.
  const fleetTagKeys = useMemo(() => {
    const index = buildTagIndex(workers.filter((w) => w.group === fleet))
    return [...index.dimensions.keys()].sort((a, b) => a.localeCompare(b))
  }, [workers, fleet])

  const routeFilter = useMemo(
    () => buildRouteFilter(config?.fieldMapping.metricNameField ?? '_metric', throughputOnly),
    [config?.fieldMapping.metricNameField, throughputOnly],
  )
  // Match relayed internal-metrics events by their originating Edge input id
  // (see STREAM_FILTER). Fixed — it depends on neither the transport nor the
  // relay destination id.
  const streamFilter = STREAM_FILTER

  // Persist a config patch immediately (KV write only — never volatile Cribl config).
  const patchConfig = (partial: Partial<AppConfig>): void => {
    if (!config) return
    const next = { ...config, ...partial }
    setConfig(next)
    void saveConfig(next).catch((err) => setOutcome({ kind: 'err', message: describe(err) }))
  }

  // Best-effort endpoint suggestion from the Stream group's worker nodes.
  const suggested = useMemo(
    () => deriveEndpoint(workers, streamGroup, transport, relayPort),
    [workers, streamGroup, transport, relayPort],
  )
  // Auto-fill the relay endpoint from the suggestion, and keep it in sync as the
  // group/port/transport change (the Cloud ingest URL embeds the group). A
  // manual edit stops the tracking: we only overwrite an empty field or one that
  // still holds our last suggestion. KV write only — never volatile Cribl config.
  const autoFilledRef = useRef<string>('')
  useEffect(() => {
    if (!config || !streamGroup || !suggested.endpoint) return
    const current = config.relayEndpoint?.trim() ?? ''
    if (current && current !== autoFilledRef.current) return // user-edited — leave it
    if (current === suggested.endpoint) {
      autoFilledRef.current = suggested.endpoint
      return
    }
    autoFilledRef.current = suggested.endpoint
    const next = { ...config, relayEndpoint: suggested.endpoint }
    setConfig(next)
    void saveConfig(next).catch(() => {})
  }, [config, streamGroup, suggested.endpoint])

  const detectEdge = useCallback(
    async (signal?: AbortSignal) => {
      // Detect every monitored fleet plus the active one (which may not be tracked
      // yet on first open) so the status list and the drilldown are both accurate.
      const ids = [...new Set([...edgeFleets, fleet].filter(Boolean))]
      if (ids.length === 0) {
        setEdgeStatus({})
        return
      }
      const entries = await Promise.all(
        ids.map(async (id) => {
          // The enrich pipeline lives on the relay ROUTE (not the source's
          // pre-processing slot, which holds the built-in cribl_metrics_rollup),
          // so read the route table to tell whether tags are being baked. The
          // table may not exist yet (best-effort → treat as not enriched).
          const [inputs, outputs, table] = await Promise.all([
            listInputs(id, signal),
            listOutputs(id, signal),
            getRouteTable(id, ROUTE_TABLE, signal).catch(() => null),
          ])
          const source = findInternalSource(inputs) ?? null
          const edgeRoute = table?.routes?.find((r) => r.name === EDGE_ROUTE)
          const readiness: EdgeReadiness = {
            source,
            sourceEnabled: Boolean(source) && source?.disabled !== true,
            hasRelay: outputs.some((o) => o.id === relayDestId),
            enrichEnabled: edgeRoute?.pipeline === EDGE_ENRICH_PIPELINE,
            sourceRollup: String(source?.pipeline ?? '') === METRICS_ROLLUP_PIPELINE,
          }
          return [id, readiness] as const
        }),
      )
      if (signal?.aborted) return
      setEdgeStatus(Object.fromEntries(entries))
    },
    [edgeFleets, fleet, relayDestId],
  )

  const detectStream = useCallback(
    async (signal?: AbortSignal) => {
      if (!streamGroup) {
        setStream(null)
        return
      }
      const [inputs, outputs] = await Promise.all([listInputs(streamGroup, signal), listOutputs(streamGroup, signal)])
      if (signal?.aborted) return
      const source = inputs.find((i) => i.id === STREAM_SRC_ID) ?? findByType(inputs, transport) ?? null
      const lake = outputs.find((o) => o.id === LAKE_DEST_ID) ?? null
      setStream({
        source,
        sourceEnabled: Boolean(source) && source?.disabled !== true,
        hasLakeDest: Boolean(lake),
        lakeDataset: lake ? String((lake as ConfItem).destPath ?? '') : null,
      })
    },
    [streamGroup, transport],
  )

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setChecking(true)
      try {
        await Promise.all([detectEdge(signal), detectStream(signal)])
      } catch (err) {
        if (!signal?.aborted) setOutcome({ kind: 'err', message: describe(err) })
      } finally {
        if (!signal?.aborted) setChecking(false)
      }
    },
    [detectEdge, detectStream],
  )

  // Re-detect whenever the selected fleet, stream group, or transport changes.
  useEffect(() => {
    const ctrl = new AbortController()
    void refresh(ctrl.signal)
    return () => ctrl.abort()
  }, [refresh])

  // Auto-track: opening a fleet in the drilldown adds it to the monitored set
  // (persisted in KV — non-volatile). Guarded so it settles after one write.
  useEffect(() => {
    if (!config || !fleet || config.edgeFleets.includes(fleet)) return
    patchConfig({ edgeFleets: [...config.edgeFleets, fleet] })
    // patchConfig/config intentionally omitted: we key off fleet membership, and
    // including config would re-run this on every unrelated config change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, config?.edgeFleets])

  const edgeFleetItems = useMemo(() => fleets.map((f) => ({ id: f.id, label: f.id })), [fleets])
  // Fleets not yet in the monitored set — the "Add fleet" dropdown.
  const addableFleetItems = useMemo(
    () => fleets.filter((f) => !edgeFleets.includes(f.id)).map((f) => ({ id: f.id, label: f.id })),
    [fleets, edgeFleets],
  )
  const streamItems = useMemo(() => streamGroups.map((g) => ({ id: g.id, label: g.id })), [streamGroups])

  if (loading) return <Spinner size="lg" title="Loading fleets…" />
  if (loadError) {
    return (
      <Alert appearance="danger" title="Couldn't load fleets">
        {loadError}
      </Alert>
    )
  }

  // Run a confirmed, volatile action, then refresh readiness + report outcome.
  const runConfirmed = (
    title: string,
    content: ReactNode,
    confirmLabel: string,
    action: () => Promise<void>,
    key: string,
  ): void => {
    setOutcome(null)
    Modal.warning({
      title,
      // Wrap plain-string bodies so long resource ids can break (see ConfirmBody).
      content: typeof content === 'string' ? <ConfirmBody text={content} /> : content,
      confirmButtonText: confirmLabel,
      cancelButtonText: 'Cancel',
      onConfirm: async () => {
        setBusy(key)
        try {
          await action()
          setOutcome({ kind: 'ok', message: `${title} — done.` })
          await refresh()
        } catch (err) {
          setOutcome({ kind: 'err', message: describe(err) })
        } finally {
          setBusy(null)
        }
      },
    })
  }

  const setThroughputOnly = (val: boolean): void => patchConfig({ throughputOnly: val })

  const onTransport = (t: RelayTransport): void => {
    const patch: Partial<AppConfig> = { relayTransport: t }
    // Flip the port to the new transport's default only if it's still a default.
    if (relayPort === HTTP_PORT || relayPort === TCP_PORT) patch.relayPort = defaultPort(t)
    patchConfig(patch)
  }

  const onPort = (v: string): void => {
    const n = Number(v)
    patchConfig({ relayPort: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 })
  }

  // --- Monitored Edge fleets (multiple senders) ----------------------------

  // Open a fleet in the drilldown. Auto-track (effect above) adds it to the set.
  const selectFleet = (id: string): void => setFleet(id)

  // Stop monitoring a fleet. Config-only — this never deletes the fleet's Cribl
  // source/destination/route; it just drops it from this app's tracked list.
  const removeFleet = (id: string): void => {
    const next = edgeFleets.filter((f) => f !== id)
    patchConfig({ edgeFleets: next })
    if (fleet === id) setFleet(next[0] ?? '')
  }

  // --- Stream Worker Group (receiver) actions ------------------------------

  const provisionStreamSource = (): void => {
    if (!streamGroup) return
    const src = stream?.source
    if (src) {
      runConfirmed(
        `Enable ${transportLabel(transport)} source on ${streamGroup}`,
        `This enables source "${src.id}" (type "${src.type}") on Stream group "${streamGroup}" so it can receive relayed Edge data on port ${relayPort}.`,
        'Enable source',
        async () => {
          await updateInput(streamGroup, src.id, { ...src, disabled: false })
        },
        'stream-src',
      )
      return
    }
    runConfirmed(
      `Create ${transportLabel(transport)} source on ${streamGroup}`,
      `This creates a ${transportLabel(transport)} source "${STREAM_SRC_ID}" on Stream group "${streamGroup}", listening on 0.0.0.0:${relayPort}, to receive relayed Edge data.`,
      'Create source',
      async () => {
        await createInput(streamGroup, { id: STREAM_SRC_ID, type: transport, host: '0.0.0.0', port: relayPort })
      },
      'stream-src',
    )
  }

  const createLakeDest = (): void => {
    if (!streamGroup) return
    if (!dataset) {
      setOutcome({ kind: 'err', message: 'Choose a Lake dataset above first.' })
      return
    }
    if (NON_WRITABLE_DATASET_IDS.includes(dataset)) {
      setOutcome({
        kind: 'err',
        message: `Dataset "${dataset}" is built-in and can't be a destination. Choose or create another above.`,
      })
      return
    }
    runConfirmed(
      `Create Lake destination on ${streamGroup}`,
      `This creates a Cribl Lake destination "${LAKE_DEST_ID}" on Stream group "${streamGroup}" writing to dataset "${dataset}". If your Lake storage location id differs, edit the destination in Stream after creation.`,
      'Create destination',
      async () => {
        await createOutput(streamGroup, { id: LAKE_DEST_ID, type: 'cribl_lake', destPath: dataset, format: 'json' })
      },
      'stream-dest',
    )
  }

  const addStreamRoute = (): void => {
    if (!streamGroup) return
    runConfirmed(
      `Add relay → Lake route on ${streamGroup}`,
      <ConfirmBody
        text={`This adds route "${STREAM_ROUTE}" to table "${ROUTE_TABLE}" on Stream group "${streamGroup}", just above the default route, sending data from the relay source to "${LAKE_DEST_ID}" via the built-in passthru pipeline.`}
        code={[{ label: 'Filter', value: streamFilter }]}
      />,
      'Add route',
      async () => {
        await upsertRoute(streamGroup, ROUTE_TABLE, {
          name: STREAM_ROUTE,
          filter: streamFilter,
          pipeline: 'passthru',
          output: LAKE_DEST_ID,
          // final: matched relay data goes only to Lake and isn't reprocessed by
          // the default catch-all route below it.
          final: true,
          disabled: false,
        })
      },
      'stream-route',
    )
  }

  const deployStream = (): void => {
    if (!streamGroup) return
    runConfirmed(
      `Commit & deploy ${streamGroup}`,
      `This commits all pending configuration changes on Stream group "${streamGroup}" and deploys them to its workers.`,
      'Commit & deploy',
      async () => {
        await commitAndDeployFleet(streamGroup, 'cc-edge-tag-monitoring: relay Edge metrics to Lake')
      },
      'stream-deploy',
    )
  }

  // --- Edge fleet (sender) actions -----------------------------------------

  const enableSource = (): void => {
    const src = edge?.source
    if (!src) {
      setOutcome({
        kind: 'err',
        message:
          'No Cribl Internal source found on this fleet. Open the fleet in Cribl → Sources → Cribl Internal and enable it, then re-check.',
      })
      return
    }
    runConfirmed(
      `Enable internal-metrics source on ${fleet}`,
      `This enables the built-in Cribl Internal source "${src.id}" (type "${src.type}") on fleet "${fleet}". These metrics carry per-host in/out bytes.`,
      'Enable source',
      async () => {
        await updateInput(fleet, src.id, { ...src, disabled: false })
      },
      'edge-src',
    )
  }

  const createRelay = (): void => {
    if (!fleet) return
    if (!relayEndpoint) {
      setOutcome({ kind: 'err', message: 'Set the Stream endpoint below first.' })
      return
    }
    const body: Record<string, unknown> =
      transport === 'cribl_http'
        ? { id: relayDestId, type: 'cribl_http', url: relayEndpoint }
        : { id: relayDestId, type: 'cribl_tcp', host: relayEndpoint, port: relayPort }
    const target = transport === 'cribl_http' ? relayEndpoint : `${relayEndpoint}:${relayPort}`
    runConfirmed(
      `Create ${transportLabel(transport)} destination on ${fleet}`,
      <ConfirmBody
        text={`This creates a ${transportLabel(transport)} destination "${relayDestId}" on fleet "${fleet}", sending to the "${streamGroup}" Stream group.`}
        code={[{ label: transport === 'cribl_http' ? 'Endpoint URL' : 'Host:port', value: target }]}
      />,
      'Create destination',
      async () => {
        await createOutput(fleet, body)
      },
      'edge-dest',
    )
  }

  // The relay route object, parameterized by the pipeline it runs. The pipeline
  // is either the built-in `passthru` (metrics are aggregated by the source's
  // default cribl_metrics_rollup pre-processing pipeline, so the route just passes
  // them through) or, when tag baking is on, our `cc_edge_tag_enrich` pipeline
  // that surfaces each node's tags into fields. Baking additionally REMOVES the
  // source's cribl_metrics_rollup pipeline (see applySourcePipeline) because that
  // rollup strips the __metadata.cribl.tags the enrich pipeline reads.
  const edgeRouteDef = (pipeline: string): Record<string, unknown> => ({
    name: EDGE_ROUTE,
    filter: routeFilter,
    pipeline,
    output: relayDestId,
    // final: matched metrics go only to the relay and aren't reprocessed by the
    // default catch-all route below it.
    final: true,
    disabled: false,
  })

  // Set the Cribl Internal source's pre-processing pipeline. Baking clears it
  // (`''` = no pre-processing) so __metadata.cribl.tags survive to the route;
  // otherwise it restores the default cribl_metrics_rollup. No-op if the source
  // isn't present yet or already holds the desired value. Must run inside a
  // confirmed action (mutates fleet config). Returns a human note for the summary.
  const applySourcePipeline = async (bake: boolean): Promise<string> => {
    const src = edge?.source
    if (!src) return ''
    const target = bake ? '' : METRICS_ROLLUP_PIPELINE
    if (String(src.pipeline ?? '') === target) return ''
    // Spread the whole source (matching the enable-source calls) so the PATCH
    // preserves every other field and only swaps the pre-processing pipeline.
    await updateInput(fleet, src.id, { ...src, pipeline: target })
    return bake
      ? ` Removes the "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline from source "${src.id}" (it strips the tag metadata).`
      : ` Restores the "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline on source "${src.id}".`
  }

  const addEdgeRoute = (): void => {
    if (!fleet) return
    // Bake tags on the route itself when the toggle is on. The enrich pipeline is
    // generic (runtime KVP extraction), so it applies even before the app has
    // discovered this fleet's tag keys — fleetTagKeys is display-only here.
    const useEnrich = bakeTags
    const pipeline = useEnrich ? EDGE_ENRICH_PIPELINE : 'passthru'
    const tagFields = fleetTagKeys.length > 0 ? ` (${fleetTagKeys.join(', ')})` : ''
    const via = useEnrich
      ? `the "${EDGE_ENRICH_PIPELINE}" pipeline (bakes node tags into fields${tagFields})`
      : 'the passthru pipeline'
    // Keep the source's pre-processing pipeline consistent with the route: cleared
    // when baking (so tag metadata survives), rollup restored otherwise.
    const srcNote = useEnrich
      ? ` The source's "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline is removed (it strips the tag metadata); metrics are no longer rolled up before Lake, so more data lands there.`
      : edge?.sourceRollup === false
        ? ` The source's "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline is restored.`
        : ''
    runConfirmed(
      `Add route on ${fleet}`,
      <ConfirmBody
        text={`This adds route "${EDGE_ROUTE}" to the "${ROUTE_TABLE}" routing table on fleet "${fleet}", just above the default route, sending ${throughputOnly ? 'throughput (byte) metrics only' : 'all internal metrics'} to "${relayDestId}" via ${via}.${srcNote}`}
        code={[{ label: 'Filter', value: routeFilter }]}
      />,
      'Add route',
      async () => {
        if (useEnrich) await upsertPipeline(fleet, buildEnrichPipeline())
        await applySourcePipeline(useEnrich)
        await upsertRoute(fleet, ROUTE_TABLE, edgeRouteDef(pipeline))
      },
      'edge-route',
    )
  }

  // Optional: bake each node's tags into event fields. This (1) creates the enrich
  // pipeline, (2) REMOVES the source's default cribl_metrics_rollup pre-processing
  // pipeline — required, because that rollup strips __metadata.cribl.tags before
  // the route runs — and (3) sets the enrich pipeline on the relay route. Gives
  // point-in-time tag attribution at the cost of un-rolled (higher-volume) metrics.
  const provisionEnrich = (): void => {
    if (!fleet) return
    if (!edge?.source) {
      setOutcome({ kind: 'err', message: 'Enable the Cribl Internal source (step 1) first.' })
      return
    }
    runConfirmed(
      `Bake node tags into events on ${fleet}`,
      `This creates pipeline "${EDGE_ENRICH_PIPELINE}" on fleet "${fleet}" — it extracts each node's tags into like-named fields${fleetTagKeys.length > 0 ? ` (${fleetTagKeys.join(', ')} on this fleet)` : ''}, removes the "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline from source "${edge.source.id}" (that rollup strips the tag metadata, so tags can't be baked while it runs), and sets the enrich pipeline on the relay route "${EDGE_ROUTE}". Metrics are no longer rolled up before Lake, so more data lands there (higher storage credits). Requires fleet metadata collection (Fleet Settings → Limits → Metadata → include "cribl").`,
      'Bake tags',
      async () => {
        await upsertPipeline(fleet, buildEnrichPipeline())
        await applySourcePipeline(true)
        await upsertRoute(fleet, ROUTE_TABLE, edgeRouteDef(EDGE_ENRICH_PIPELINE))
      },
      'edge-enrich',
    )
  }

  const removeEnrich = (): void => {
    if (!fleet) return
    const srcNote = edge?.source
      ? ` and restores the "${METRICS_ROLLUP_PIPELINE}" pre-processing pipeline on source "${edge.source.id}" (metrics are rolled up again before Lake)`
      : ''
    runConfirmed(
      `Stop baking tags on ${fleet}`,
      `This resets the relay route "${EDGE_ROUTE}" (fleet "${fleet}") back to the passthru pipeline${srcNote}, so node tags are no longer baked into events. The dashboard falls back to the live host → tag join.`,
      'Stop baking',
      async () => {
        await applySourcePipeline(false)
        await upsertRoute(fleet, ROUTE_TABLE, edgeRouteDef('passthru'))
      },
      'edge-enrich',
    )
  }

  const deployEdge = (): void => {
    if (!fleet) return
    runConfirmed(
      `Commit & deploy fleet ${fleet}`,
      `This commits all pending configuration changes on fleet "${fleet}" and deploys them to every node in the fleet.`,
      'Commit & deploy',
      async () => {
        await commitAndDeployFleet(fleet, 'cc-edge-tag-monitoring: route internal metrics to Stream relay')
      },
      'edge-deploy',
    )
  }

  const verify = async (): Promise<void> => {
    if (!dataset) {
      setVerifyError('Choose a Lake dataset above first.')
      return
    }
    setVerifying(true)
    setVerifyError(null)
    setSample(null)
    const ctrl = new AbortController()
    try {
      const range = rangeById('24h')
      const { earliest, latest } = rangeBounds(range)
      const rows = await runSearch(buildSampleQuery(dataset), earliest, latest, ctrl.signal)
      setSample(rows)
    } catch (err) {
      setVerifyError(describe(err))
    } finally {
      setVerifying(false)
    }
  }

  const sampleFields = sample && sample.length > 0 ? Object.keys(sample[0]).sort() : []

  // At-a-glance status for the collapsible section headers.
  const streamStatus: 'ready' | 'todo' | 'unknown' = !streamGroup || !stream
    ? 'unknown'
    : stream.sourceEnabled && stream.hasLakeDest
      ? 'ready'
      : 'todo'
  const streamStatusLabel =
    streamStatus === 'ready' ? 'Ready' : streamStatus === 'todo' ? 'Needs setup' : 'Not started'
  const edgeReadyCount = edgeFleets.filter((id) => {
    const s = edgeStatus[id]
    return Boolean(s?.sourceEnabled && s?.hasRelay)
  }).length
  const edgeStatusLabel =
    edgeFleets.length === 0
      ? 'No fleets'
      : `${edgeReadyCount}/${edgeFleets.length} ready`
  const edgeStatusKind: 'ready' | 'todo' | 'unknown' =
    edgeFleets.length === 0 ? 'unknown' : edgeReadyCount === edgeFleets.length ? 'ready' : 'todo'
  const dataFlowing = sample != null && sample.length > 0

  // The next thing to do, and the section that holds it. Drives both the status
  // strip's "Next" line and which section starts open.
  const next: { section: SectionId; label: string } | null = !dataset
    ? { section: 'dataset', label: 'choose or create the Lake dataset metrics land in' }
    : streamStatus !== 'ready'
      ? {
          section: 'stream',
          label: streamGroup
            ? `finish setting up Stream group “${streamGroup}”`
            : 'pick the Stream Worker Group that receives Edge data',
        }
      : edgeFleets.length === 0
        ? { section: 'edge', label: 'add the Edge fleets to monitor' }
        : edgeStatusKind !== 'ready'
          ? {
              section: 'edge',
              label: `finish ${edgeFleets.length - edgeReadyCount} of ${edgeFleets.length} Edge ${
                edgeFleets.length - edgeReadyCount === 1 ? 'fleet' : 'fleets'
              }`,
            }
          : !dataFlowing
            ? { section: 'verify', label: 'verify data is landing and check the field names' }
            : null

  // Pinned choice wins once the reader has clicked a header; before that, follow
  // the guide's own sense of what's next.
  const expanded: SectionId | null = pinnedSection ? pinnedSection.id : next?.section ?? null
  const section = (id: SectionId) => ({
    isExpanded: expanded === id,
    onExpandedChange: (open: boolean) => setPinnedSection({ id: open ? id : null }),
  })

  // Tag health: the dashboard groups volume by key:value node tags, so no
  // discovered dimensions means nothing to group by. Only warn when we have
  // nodes to look at — otherwise the explanation lives in "How this works".
  const monitoredWorkers = workers.filter((w) => edgeFleets.includes(w.group ?? ''))
  const tagsMissing = monitoredWorkers.length > 0 && buildTagIndex(monitoredWorkers).dimensions.size === 0

  return (
    <div className="page">
      <div className="setup-status">
        <div className="setup-status-row">
          <div className="setup-status-chips">
            <StatusChip label="Dataset" status={dataset ? 'ready' : 'todo'} value={dataset || 'Not set'} />
            <StatusChip label="Stream" status={streamStatus} value={streamStatusLabel} />
            <StatusChip label="Fleets" status={edgeStatusKind} value={edgeStatusLabel} />
            <StatusChip
              label="Data"
              status={dataFlowing ? 'ready' : 'unknown'}
              value={dataFlowing ? 'Flowing' : 'Not verified'}
            />
          </div>
          <div className="setup-status-action">
            <Button variant="secondary" disabled={checking} onClick={() => void refresh()}>
              {checking ? 'Checking…' : 'Re-check status'}
            </Button>
          </div>
        </div>
        <div className="setup-status-next">
          {next ? (
            <>
              <Text variant="body-sm-semibold">Next:</Text>
              <Text color="subtle" variant="body-sm-normal">
                {next.label}
              </Text>
              <Button variant="tertiary" size="sm" onClick={() => setPinnedSection({ id: next.section })}>
                Open
              </Button>
            </>
          ) : (
            <Text color="success" variant="body-sm-semibold">
              Setup complete — data is landing in “{dataset}”.
            </Text>
          )}
        </div>
      </div>

      {outcome && (
        <Alert
          appearance={outcome.kind === 'ok' ? 'success' : 'danger'}
          title={outcome.kind === 'ok' ? 'Success' : 'Action failed'}
          onDismiss={() => setOutcome(null)}
        >
          {outcome.message}
        </Alert>
      )}

      {tagsMissing && (
        <Alert appearance="warning" title="No key:value tags found on the monitored nodes">
          The dashboard groups volume by node tags, so each tag must be{' '}
          <code className="inline-code">key:value</code> (for example <code className="inline-code">site:nyc</code>).
          Plain tags with no colon are ignored. Tag the nodes in Edge, then Re-check status.
        </Alert>
      )}

      <Collapse title="How this works" {...section('how')}>
        <div className="section-stack">
          <Text color="subtle" variant="body-sm-normal">
            Edge can’t write to Cribl Lake directly, so this guide relays each fleet’s internal byte metrics through a
            Stream Worker Group into a Lake dataset. The dashboard then sums bytes per host and rolls volume up by your
            node tags. Every action below asks for confirmation and names the exact resource it touches.
          </Text>
          <div className="setup-flow">
            <Pill appearance="info">Edge fleets (1+)</Pill>
            <span className="setup-arrow">→</span>
            <Pill appearance="info">{transportLabel(transport)}</Pill>
            <span className="setup-arrow">→</span>
            <Pill appearance="info">Stream Worker Group</Pill>
            <span className="setup-arrow">→</span>
            <Pill appearance="info">Cribl Lake</Pill>
            <span className="setup-arrow">→</span>
            <Pill appearance="highlight">Search + tag roll-up</Pill>
          </div>
          <Text color="subtle" variant="body-sm-normal">
            Volume is grouped by your node tags, so each tag must be <code className="inline-code">key:value</code> (for
            example <code className="inline-code">site:nyc</code> or <code className="inline-code">env:prod</code>) — the
            key becomes the dimension, the value is what you group and filter by. Plain tags with no colon are ignored.
            Apply them per node or per fleet in Edge, then Re-check status.
          </Text>
        </div>
      </Collapse>

      {config && (
        <Collapse
          title="Step 1 · Lake dataset"
          {...section('dataset')}
          headerTrailingContentSlot={
            <SectionStatus status={dataset ? 'ready' : 'todo'} label={dataset || 'Not set'} />
          }
        >
          <DatasetPicker config={config} onChange={(c) => setConfig(c)} />
        </Collapse>
      )}

      {streamItems.length === 0 ? (
        <Alert appearance="warning" title="No Stream Worker Groups found">
          A Stream Worker Group is required to relay Edge data into Cribl Lake. Create one in Cribl first.
        </Alert>
      ) : (
        <Collapse
          title="Step 2 · Stream Worker Group (receiver)"
          {...section('stream')}
          headerTrailingContentSlot={<SectionStatus status={streamStatus} label={streamStatusLabel} />}
        >
          <div className="section-stack">
          <div className="controls">
            <SelectField
              label="Stream Worker Group"
              value={streamGroup || null}
              items={streamItems}
              onChange={(v) => patchConfig({ streamGroup: String(v ?? '') })}
            />
          </div>

          <div className="step-list">
              <StepRow
                n={1}
                title={`${transportLabel(transport)} source`}
                status={stream ? (stream.sourceEnabled ? 'ready' : 'missing') : 'unknown'}
                summary={
                  stream?.source
                    ? stream.sourceEnabled
                      ? `Source "${stream.source.id}" (type "${stream.source.type}") is enabled.`
                      : `Source "${stream.source.id}" exists but is disabled — enable it to receive data.`
                    : `Creates source "${STREAM_SRC_ID}" listening on 0.0.0.0:${relayPort}.`
                }
                help={
                  <>
                    <Text variant="body-sm-normal">
                      Every monitored Edge fleet sends to this one source, so there’s nothing to repeat per fleet.
                    </Text>
                    <Text variant="body-sm-normal">
                      Its port ({relayPort}) must match the port on each fleet’s forwarding destination — both come from
                      Connection settings.
                    </Text>
                  </>
                }
                action={
                  <Button
                    variant="primary"
                    pending={busy === 'stream-src'}
                    disabled={!streamGroup || stream?.sourceEnabled}
                    onClick={provisionStreamSource}
                  >
                    {stream?.sourceEnabled ? 'Enabled' : stream?.source ? 'Enable source' : 'Create source'}
                  </Button>
                }
              />
              <StepRow
                n={2}
                title="Cribl Lake destination"
                status={stream ? (stream.hasLakeDest ? 'ready' : 'missing') : 'unknown'}
                summary={
                  stream?.hasLakeDest
                    ? `Destination "${LAKE_DEST_ID}" → dataset "${stream.lakeDataset ?? ''}"`
                    : `Destination "${LAKE_DEST_ID}" → dataset "${dataset || '(choose above)'}"`
                }
                help={
                  <>
                    <Text variant="body-sm-normal">
                      Only Stream Worker Groups can write to Cribl Lake — Edge gets an HTTP 405 — which is the whole
                      reason data relays through this group.
                    </Text>
                    <Text variant="body-sm-normal">
                      If your Lake storage location id differs from “{LAKE_ID}”, edit the destination in Stream after
                      creating it.
                    </Text>
                  </>
                }
                action={
                  <Button
                    variant="primary"
                    pending={busy === 'stream-dest'}
                    disabled={!streamGroup || !dataset || stream?.hasLakeDest}
                    onClick={createLakeDest}
                  >
                    {stream?.hasLakeDest ? 'Present' : 'Create destination'}
                  </Button>
                }
              />
              <StepRow
                n={3}
                title="Route relay → Lake"
                status="unknown"
                summary={`Route “${STREAM_ROUTE}” sends relayed internal metrics to “${LAKE_DEST_ID}” via the passthru pipeline.`}
                caution="Added above existing routes with “final” set — adjust it if this group already forwards these metrics."
                help={
                  <>
                    <Text variant="body-sm-normal">
                      Added to table “{ROUTE_TABLE}” just above the default route. It matches on the originating Edge
                      source id, carried over in <code className="inline-code">__forwardedAttrs</code>, so it keeps
                      working whatever the Edge destination “{relayDestId}” is called.
                    </Text>
                    <pre className="code-block">{streamFilter}</pre>
                    <Text variant="body-sm-semibold">Already sending these metrics somewhere?</Text>
                    <Text variant="body-sm-normal">
                      The route carries <code className="inline-code">final</code>, so matched events stop here. If this
                      group already forwards the same metrics to other destinations, keep “{STREAM_ROUTE}”{' '}
                      <em>above</em> them but clear its <code className="inline-code">final</code> flag, so events
                      continue on after being copied to Lake.
                    </Text>
                    <Text variant="body-sm-normal">
                      Note the filter matches relayed internal metrics from <em>any</em> Edge relay into this group, not
                      only the fleets configured here — narrow it in Cribl if that’s too broad.
                    </Text>
                  </>
                }
                action={
                  <Button variant="secondary" pending={busy === 'stream-route'} disabled={!streamGroup} onClick={addStreamRoute}>
                    Add route
                  </Button>
                }
              />
              <StepRow
                n={4}
                title="Commit & deploy the group"
                status="unknown"
                summary="Commit pending changes and deploy them to the Stream group's workers."
                help={
                  <Text variant="body-sm-normal">
                    Routes and deploys can’t be auto-detected by this app, so these two steps never show a status —
                    re-running either one is always safe if you’re not sure.
                  </Text>
                }
                action={
                  <Button variant="secondary" pending={busy === 'stream-deploy'} disabled={!streamGroup} onClick={deployStream}>
                    Commit & deploy
                  </Button>
                }
              />
            </div>
          </div>
        </Collapse>
      )}

      {edgeFleetItems.length === 0 ? (
        <Alert appearance="warning" title="No Edge fleets found">
          No Edge fleets were returned. Create an Edge fleet in Cribl first.
        </Alert>
      ) : (
        <Collapse
          title="Step 3 · Edge fleets (senders)"
          {...section('edge')}
          headerTrailingContentSlot={<SectionStatus status={edgeStatusKind} label={edgeStatusLabel} />}
        >
          <div className="section-stack">
            <div className="setup-status-next">
              <Text color="subtle" variant="body-sm-normal">
                Add each Edge fleet that should relay volume into “{streamGroup || 'the Stream group'}”.
              </Text>
              <HelpPopover label="About Edge fleets">
                <Text variant="body-sm-normal">
                  Every fleet gets a forwarding destination with the same id (“{relayDestId}”) and the shared endpoint
                  from Connection settings, so the single Stream route receives them all — no extra route per fleet.
                </Text>
                <Text variant="body-sm-normal">
                  Removing a fleet here only stops tracking it; it never deletes anything in Cribl. Each button asks for
                  confirmation and names the exact resource it touches.
                </Text>
              </HelpPopover>
            </div>

            <div className="panel">
              <Text variant="body-sm-semibold">Monitored fleets</Text>
              {edgeFleets.length === 0 ? (
                <EmptyState
                  title="No fleets added yet"
                  description="Add one below — it'll be tracked here and you can configure its steps."
                />
              ) : (
                <div className="step-list">
                  {edgeFleets.map((id) => {
                    const st = edgeStatus[id]
                    const active = id === fleet
                    return (
                      <div key={id} className="step-row">
                        <div className="step-row-body">
                          <div className="step-row-head">
                            <Text variant="body-sm-semibold">{id}</Text>
                            {active && <Pill appearance="highlight" variant="muted">Configuring</Pill>}
                            <Pill appearance={st?.sourceEnabled ? 'success' : 'warning'} variant="muted">
                              {st ? (st.sourceEnabled ? 'Source ready' : 'Source missing') : 'Source ?'}
                            </Pill>
                            <Pill appearance={st?.hasRelay ? 'success' : 'warning'} variant="muted">
                              {st ? (st.hasRelay ? 'Destination ready' : 'Destination missing') : 'Destination ?'}
                            </Pill>
                            {st?.enrichEnabled && <Pill appearance="info" variant="muted">Baking tags</Pill>}
                          </div>
                        </div>
                        <div className="step-row-action">
                          <Button variant={active ? 'primary' : 'secondary'} disabled={active} onClick={() => selectFleet(id)}>
                            {active ? 'Configuring' : 'Configure'}
                          </Button>
                          <Button variant="tertiary" onClick={() => removeFleet(id)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="controls">
                <SelectField
                  label="Add Edge fleet"
                  value={null}
                  placeholder={addableFleetItems.length === 0 ? 'All fleets added' : 'Select a fleet to add…'}
                  items={addableFleetItems}
                  disabled={addableFleetItems.length === 0}
                  onChange={(v) => v != null && selectFleet(String(v))}
                  helperText="Adds the fleet to monitoring and opens it for configuration below."
                />
              </div>
            </div>

            {fleet && (
              <Text as="h3" variant="heading-sm">
                Configuring: {fleet}
              </Text>
            )}
            <div className="step-list">
              <StepRow
                n={1}
                title="Cribl Internal metrics source"
                status={edge ? (edge.sourceEnabled ? 'ready' : 'missing') : 'unknown'}
                summary={
                  edge?.source
                    ? edge.sourceEnabled
                      ? `Built-in source "${edge.source.id}" (type "${edge.source.type}") is enabled.`
                      : `Built-in source "${edge.source.id}" exists but is disabled — enable it to emit metrics.`
                    : 'Built-in Cribl Internal source — detected automatically.'
                }
                help={
                  <Text variant="body-sm-normal">
                    This source is built in and can’t be created through the API. If it isn’t detected, open the fleet
                    in Cribl → Sources → Cribl Internal and enable it there, then Re-check status. It’s what emits the
                    per-host byte counts the dashboard sums.
                  </Text>
                }
                action={
                  <Button variant="primary" pending={busy === 'edge-src'} disabled={edge?.sourceEnabled} onClick={enableSource}>
                    {edge?.sourceEnabled ? 'Enabled' : 'Enable source'}
                  </Button>
                }
              />
              <StepRow
                n={2}
                title={`${transportLabel(transport)} destination → Stream`}
                status={edge ? (edge.hasRelay ? 'ready' : 'missing') : 'unknown'}
                summary={
                  edge?.hasRelay
                    ? `Destination "${relayDestId}" exists.`
                    : relayEndpoint
                      ? `Destination "${relayDestId}" → ${transport === 'cribl_http' ? relayEndpoint : `${relayEndpoint}:${relayPort}`}`
                      : 'Set the Stream endpoint in Connection settings to enable this.'
                }
                help={
                  <Text variant="body-sm-normal">
                    Creates the forwarding destination on “{fleet}” pointing at the Stream group’s{' '}
                    {transportLabel(transport)} source. The id is shared across fleets so this guide can detect each
                    one; the endpoint and port come from Connection settings.
                  </Text>
                }
                action={
                  <Button
                    variant="primary"
                    pending={busy === 'edge-dest'}
                    disabled={!fleet || !relayEndpoint || edge?.hasRelay}
                    onClick={createRelay}
                  >
                    {edge?.hasRelay ? 'Present' : 'Create destination'}
                  </Button>
                }
              />
              <StepRow
                n={3}
                title="Route metrics to the relay"
                status="unknown"
                summary={`Route “${EDGE_ROUTE}” on “${ROUTE_TABLE}” → “${relayDestId}” via the passthru pipeline.`}
                caution="Inserted above existing routes with “final” set — adjust it if this fleet already routes internal metrics."
                help={
                  <>
                    <Text variant="body-sm-semibold">Already sending these metrics somewhere?</Text>
                    <Text variant="body-sm-normal">
                      The route goes in above the fleet’s existing routes and carries{' '}
                      <code className="inline-code">final</code>, so matched metrics go only to the relay. If this fleet
                      already routes internal metrics to another destination, clear the{' '}
                      <code className="inline-code">final</code> flag on “{EDGE_ROUTE}” in Cribl so those routes keep
                      receiving them.
                    </Text>
                    <Text variant="body-sm-normal">
                      What it matches depends on the volume setting below:
                    </Text>
                    <pre className="code-block">{routeFilter}</pre>
                  </>
                }
                action={
                  <Button variant="secondary" pending={busy === 'edge-route'} disabled={!fleet} onClick={addEdgeRoute}>
                    Add route
                  </Button>
                }
              />
            </div>

            <div className="setup-optional">
              <Collapse title="Optional: reduce volume & tag attribution" defaultExpanded={false}>
                <div className="setup-optional-body">
                  <div className="setup-optional-row">
                    <div className="toggle-row">
                      <Switch
                        aria-label="Route throughput metrics only"
                        checked={throughputOnly}
                        onChange={(e) => setThroughputOnly((e.target as HTMLInputElement).checked)}
                      />
                      <Text variant="body-sm-semibold">Throughput metrics only</Text>
                      <HelpPopover label="About reducing volume">
                        <Text variant="body-sm-normal">
                          Shared config: it shapes the route created on <em>every</em> monitored fleet, so re-run step 3
                          on each fleet after changing it.
                        </Text>
                        <Text variant="body-sm-normal">
                          On, only the byte metrics the dashboard sums are sent and the rest (CPU, memory, event counts)
                          are dropped. Off, the full internal-metrics stream is sent — more data, more credits.
                        </Text>
                        <pre className="code-block">{routeFilter}</pre>
                        <Text variant="body-sm-normal">
                          The Cribl Internal source ships with a{' '}
                          <code className="inline-code">{METRICS_ROLLUP_PIPELINE}</code> pre-processing pipeline that
                          already aggregates metrics into time windows, so the relay route just passes them through — no
                          extra rollup needed. Baking tags below removes that rollup.
                        </Text>
                      </HelpPopover>
                    </div>
                    <Text color="subtle" variant="body-sm-normal">
                      {throughputOnly
                        ? 'Only the byte metrics the dashboard sums are relayed — fewer credits.'
                        : 'The full internal-metrics stream is relayed — more data, more credits.'}
                    </Text>
                  </div>

                  <div className="setup-optional-row">
                    <div className="toggle-row">
                      <Switch
                        aria-label="Bake node tags into events"
                        checked={bakeTags}
                        onChange={(e) => patchConfig({ bakeTags: (e.target as HTMLInputElement).checked })}
                      />
                      <Text variant="body-sm-semibold">Bake node tags into events</Text>
                      <HelpPopover label="About baking node tags">
                        <Text variant="body-sm-normal">
                          By default the dashboard joins host → tags live from the node inventory, so it always reflects
                          current tags. Baking writes each tag into a like-named field at emit time, which survives later
                          tag changes or node removal and lets you group on the fields directly.
                        </Text>
                        <Text variant="body-sm-normal">
                          {fleetTagKeys.length > 0
                            ? `Fields added on this fleet: ${fleetTagKeys.join(', ')}.`
                            : 'No node tags discovered on this fleet yet — the pipeline is generic, so baking still applies and captures each node’s tags at runtime as they appear.'}
                        </Text>
                        <Text variant="body-sm-normal">
                          It takes <strong>two</strong> config changes, both handled by the button:{' '}
                          <strong>(1)</strong> the source’s default{' '}
                          <code className="inline-code">{METRICS_ROLLUP_PIPELINE}</code> pre-processing pipeline is{' '}
                          <strong>removed</strong> — it rolls metrics up but strips the{' '}
                          <code className="inline-code">__metadata.cribl.tags</code> the fields come from, so tags can’t
                          be baked while it runs; and <strong>(2)</strong> the{' '}
                          <code className="inline-code">{EDGE_ENRICH_PIPELINE}</code> pipeline is set on the relay route
                          to add the fields. Stopping baking reverses both.
                        </Text>
                        <Text variant="body-sm-normal">
                          Tags only reach events if the fleet collects node metadata: Fleet Settings → Limits → Metadata
                          → include <code className="inline-code">cribl</code>. Use Verify to confirm the fields land.
                        </Text>
                      </HelpPopover>
                    </div>
                    <Text color="subtle" variant="body-sm-normal">
                      {bakeTags
                        ? 'Each node’s tags are stamped onto its events — point-in-time attribution.'
                        : 'Off: the dashboard joins host → tags live from the node inventory.'}
                    </Text>
                    {bakeTags && (
                      <Alert appearance="warning" title="Baking increases the data sent to Lake">
                        Without <code className="inline-code">{METRICS_ROLLUP_PIPELINE}</code>, metrics reach Lake un-rolled
                        (not aggregated into windows), so more events land there — higher storage credits. Volume totals
                        stay accurate (the dashboard sums per-interval byte counts), but the data is finer-grained. This is
                        the trade-off for point-in-time tag attribution.
                      </Alert>
                    )}
                    {bakeTags && edge?.enrichEnabled && edge?.sourceRollup && (
                      <Alert appearance="danger" title="Baking is half-configured">
                        The relay route runs <code className="inline-code">{EDGE_ENRICH_PIPELINE}</code>, but source{' '}
                        “{edge.source?.id}” still runs{' '}
                        <code className="inline-code">{METRICS_ROLLUP_PIPELINE}</code>, which strips the tag metadata — so
                        no tag fields will land. Re-run “Bake tags” below to remove the rollup.
                      </Alert>
                    )}
                    {bakeTags && (
                      <div className="setup-optional-action">
                        {edge?.enrichEnabled ? (
                          <Button
                            variant="secondary"
                            pending={busy === 'edge-enrich'}
                            disabled={!fleet}
                            onClick={removeEnrich}
                          >
                            Stop baking
                          </Button>
                        ) : (
                          <Button
                            variant="primary"
                            pending={busy === 'edge-enrich'}
                            disabled={!fleet || !edge?.source}
                            onClick={provisionEnrich}
                          >
                            Bake tags
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Collapse>
            </div>
            <div className="step-list">
              <StepRow
                n={4}
                title="Commit & deploy the fleet"
                status="unknown"
                summary="Commit pending changes and deploy them so the new config takes effect on all nodes."
                help={
                  <Text variant="body-sm-normal">
                    Make any optional changes above first, then commit — they ship in the same deploy. Routes and
                    deploys can’t be auto-detected by this app, so re-running either is always safe if you’re not sure.
                  </Text>
                }
                action={
                  <Button variant="secondary" pending={busy === 'edge-deploy'} disabled={!fleet} onClick={deployEdge}>
                    Commit & deploy
                  </Button>
                }
              />
            </div>
          </div>
          </Collapse>
      )}

      <Collapse
        title="Step 4 · Verify data & field names"
        {...section('verify')}
        headerTrailingContentSlot={
          <SectionStatus
            status={dataFlowing ? 'ready' : 'unknown'}
            label={dataFlowing ? `${sampleFields.length} fields` : 'Not verified'}
          />
        }
      >
        <div className="section-stack">
        <div className="setup-status-next">
          <Text color="subtle" variant="body-sm-normal">
            Reads a small sample from “{dataset || 'the dataset'}” and lists its fields.
          </Text>
          <HelpPopover label="About verifying">
            <Text variant="body-sm-normal">
              Use the exact field names it reports in Settings → Field mapping, so the volume math is correct.
            </Text>
            <Text variant="body-sm-normal">
              Data can take a few minutes to appear after both groups deploy. If you turned on tag baking, this is where
              you confirm the tag fields actually landed.
            </Text>
          </HelpPopover>
        </div>
        <div className="controls">
          <Button variant="primary" pending={verifying} disabled={!dataset} onClick={() => void verify()}>
            Run sample query
          </Button>
        </div>
        {!dataset && (
          <Text color="subtle" variant="body-sm-normal">
            Choose a Lake dataset above to enable this.
          </Text>
        )}
        {verifyError && (
          <Alert appearance="danger" title="Sample query failed">
            {verifyError}
          </Alert>
        )}
        {sample && (
          <div className="verify-result">
            {sample.length === 0 ? (
              <Alert appearance="warning" title="No rows returned">
                The dataset returned no rows in the last 24h. If you just deployed, wait a few minutes for metrics to
                land, then re-run.
              </Alert>
            ) : (
              <>
                <Text variant="body-sm-semibold">Fields found ({sampleFields.length}):</Text>
                <div className="dim-values">
                  {sampleFields.map((f) => (
                    <Tag key={f} color="blue" size="sm">
                      {f}
                    </Tag>
                  ))}
                </div>
                <pre className="verify-sample">{JSON.stringify(sample[0], null, 2)}</pre>
                <MapButton dataset={dataset} config={config} sample={sample[0]} onSaved={(c) => setConfig(c)} />
              </>
            )}
          </div>
        )}
        </div>
      </Collapse>

      <Collapse
        title="Connection settings"
        {...section('conn')}
        headerTrailingContentSlot={
          <Pill appearance="info" variant="muted">
            {`${transportLabel(transport)} · port ${relayPort}`}
          </Pill>
        }
      >
        <div className="section-stack">
        <div className="setup-status-next">
          <Text color="subtle" variant="body-sm-normal">
            Defaults work for most Cribl.Cloud orgs and the endpoint auto-fills.
          </Text>
          <HelpPopover label="About connection settings">
            <Text variant="body-sm-normal">
              These control how Edge sends data to the Stream group: the transport, the port both sides use, the id of
              the forwarding destination created on each fleet, and the endpoint it sends to.
            </Text>
            <Text variant="body-sm-normal">
              Keep the destination id the same across monitored fleets so this guide can detect each fleet’s
              destination. The Stream route matches on the originating Edge source rather than this id, so renaming it
              won’t break routing.
            </Text>
            {suggested.isCloud && (
              <Text variant="body-sm-normal">
                The endpoint is auto-derived from your org URL and the selected Worker Group (
                <code className="inline-code">&lt;group&gt;.&lt;workspace&gt;.&lt;org&gt;.&lt;domain&gt;</code>) and
                updates if you change the group or port. Confirm the port matches the {transportLabel(transport)} source
                (default {defaultPort(transport)}), and edit it if your ingest address differs.
              </Text>
            )}
          </HelpPopover>
        </div>
        <div className="field-grid">
          <SelectField
            label="Transport"
            value={transport}
            items={TRANSPORT_ITEMS}
            onChange={(v) => v != null && onTransport(v as RelayTransport)}
          />
          <TextField
            label="Port"
            value={String(relayPort)}
            onChange={onPort}
            helperText={`Default ${defaultPort(transport)} for ${transportLabel(transport)}. Must match on the Stream source and every Edge destination.`}
          />
          <TextField
            label="Edge destination ID"
            value={config?.relayDestId ?? ''}
            onChange={(v) => patchConfig({ relayDestId: v })}
            placeholder={EDGE_RELAY_ID}
            helperText="Shared by every monitored fleet. Change it here if you renamed it in Cribl."
          />
          <TextField
            label={transport === 'cribl_http' ? 'Stream endpoint URL (shared)' : 'Stream receiver host (shared)'}
            value={config?.relayEndpoint ?? ''}
            onChange={(v) => patchConfig({ relayEndpoint: v })}
            helperText={
              transport === 'cribl_http'
                ? `e.g. https://<worker-host>:${relayPort}. Auto-filled from the Stream group when possible — edit if needed.`
                : 'Hostname of a Stream worker. Auto-filled when possible — edit if needed.'
            }
          />
        </div>
        </div>
      </Collapse>
    </div>
  )
}

// Choose the Lake dataset that routed metrics land in: reuse an existing one
// (fewer credits — no duplicate storage) or create a dedicated dataset with a
// short retention. Persists the choice (lake id + dataset) to the app config.
// New datasets are created as JSON to match the Lake destination's format.
const NEW_DATASET_FORMAT = 'json'
const NEW_ID_RE = /^[a-z0-9_]+$/

// Cribl Cloud orgs have a single lake, conventionally identified as "default",
// and there's no API to list lakes — so this is fixed rather than user-entered.
const LAKE_ID = 'default'

function DatasetPicker({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  const [datasets, setDatasets] = useState<LakeDataset[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const [newId, setNewId] = useState('')
  const [newRetention, setNewRetention] = useState('15')
  const [manualName, setManualName] = useState('')
  const [saving, setSaving] = useState<'select' | 'create' | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(null)
      try {
        const ds = await listLakeDatasets(LAKE_ID, signal)
        if (signal?.aborted) return
        setDatasets(ds)
      } catch (err) {
        if (!signal?.aborted) {
          setDatasets(null)
          setError(describe(err))
        }
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const selected = config.datasetName?.trim() || ''
  const items = useMemo(
    () =>
      (datasets ?? []).map((d) => {
        const bits: string[] = []
        if (typeof d.retentionPeriodInDays === 'number') bits.push(`${d.retentionPeriodInDays}d`)
        if (SYSTEM_DATASET_IDS.includes(d.id)) bits.push('built-in')
        if (NON_WRITABLE_DATASET_IDS.includes(d.id)) bits.push('not writable')
        return { id: d.id, label: bits.length ? `${d.id} · ${bits.join(' · ')}` : d.id }
      }),
    [datasets],
  )

  const persist = async (id: string): Promise<void> => {
    const next: AppConfig = { ...config, lakeId: LAKE_ID, datasetName: id }
    await saveConfig(next)
    onChange(next)
  }

  const onSelect = (id: string): void => {
    setMsg(null)
    setSaving('select')
    persist(id)
      .then(() => setMsg(`Using dataset "${id}".`))
      .catch((err) => setMsg(describe(err)))
      .finally(() => setSaving(null))
  }

  const onCreate = (): void => {
    const id = newId.trim()
    if (!NEW_ID_RE.test(id)) {
      setMsg('Dataset id must contain only lowercase letters, numbers, and underscores.')
      return
    }
    const retention = Number(newRetention)
    setMsg(null)
    Modal.warning({
      title: `Create Lake dataset "${id}"`,
      content: `This creates JSON dataset "${id}" (${Number.isFinite(retention) && retention > 0 ? `${retention}-day retention` : 'default retention'}) in lake "${LAKE_ID}" and sets it as the dashboard's data source. Lower retention = fewer storage credits.`,
      confirmButtonText: 'Create dataset',
      cancelButtonText: 'Cancel',
      onConfirm: async () => {
        setSaving('create')
        try {
          const body: Record<string, unknown> = { id, format: NEW_DATASET_FORMAT }
          if (Number.isFinite(retention) && retention > 0) body.retentionPeriodInDays = retention
          await createLakeDataset(LAKE_ID, body)
          await persist(id)
          setNewId('')
          setMsg(`Created and selected dataset "${id}".`)
          await load()
        } catch (err) {
          setMsg(describe(err))
        } finally {
          setSaving(null)
        }
      },
    })
  }

  const selectedIsNonWritable = NON_WRITABLE_DATASET_IDS.includes(selected)

  return (
    <div className="section-stack">
      <div className="setup-status-next">
        <Text color="subtle" variant="body-sm-normal">
          The Cribl Lake dataset routed Edge metrics land in.
        </Text>
        <HelpPopover label="About the Lake dataset">
          <Text variant="body-sm-normal">
            Reuse an existing dataset to avoid duplicate storage credits, or create a dedicated one — a shorter
            retention means fewer credits.
          </Text>
          <Text variant="body-sm-normal">
            The dashboard queries whatever you pick here directly through Cribl Search, and the Stream Lake destination
            writes to it.
          </Text>
        </HelpPopover>
      </div>

      {error && (
        <Alert appearance="warning" title="Couldn't list datasets" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {selectedIsNonWritable && (
        <Alert appearance="warning" title="Selected dataset is not writable">
          “{selected}” is a built-in Cribl dataset and cannot be a route destination. Pick another dataset or create one
          to receive the routed metrics.
        </Alert>
      )}

      <div className="panel">
        {/* Listing is Cribl.Cloud-only. When it fails, typing the name is the
            only way forward, so that field replaces the picker rather than
            hiding behind a disclosure. */}
        {error ? (
          <>
            <div className="field-grid">
              <TextField
                label="Dataset name"
                value={manualName}
                onChange={(v) => setManualName(v)}
                helperText="Type the exact name of an existing dataset — the dashboard queries it directly via Search."
              />
            </div>
            <div className="save-bar">
              <Button
                variant="primary"
                pending={saving === 'select'}
                disabled={!manualName.trim() || saving != null}
                onClick={() => onSelect(manualName.trim())}
              >
                Use this dataset
              </Button>
            </div>
          </>
        ) : (
          <div className="field-grid">
            <SelectField
              label="Dataset"
              value={items.some((i) => i.id === selected) ? selected : null}
              items={items}
              onChange={(v) => v != null && onSelect(String(v))}
              disabled={loading || saving != null || items.length === 0}
              helperText={
                items.length === 0
                  ? 'No datasets available — create one below.'
                  : selected
                    ? `Currently using “${selected}”.`
                    : 'Select a dataset to route Edge metrics into.'
              }
            />
          </div>
        )}

        <Collapse title="Create a new dataset" defaultExpanded={false}>
          <div className="section-stack">
            <div className="field-grid">
              <TextField
                label="New dataset id"
                value={newId}
                onChange={(v) => setNewId(v)}
                helperText="Lowercase letters, numbers, underscores."
              />
              <TextField
                label="Retention (days)"
                value={newRetention}
                onChange={(v) => setNewRetention(v)}
                helperText="Shorter retention = fewer credits."
              />
            </div>
            <div className="save-bar">
              <Button
                variant="primary"
                pending={saving === 'create'}
                disabled={!newId.trim() || saving != null}
                onClick={onCreate}
              >
                Create dataset
              </Button>
            </div>
          </div>
        </Collapse>

        <div className="save-bar">
          <Button variant="tertiary" disabled={loading} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Reload datasets'}
          </Button>
        </div>
      </div>

      {msg && (
        <Text color="subtle" variant="body-sm-normal">
          {msg}
        </Text>
      )}
    </div>
  )
}

// A small offer to persist the discovered dataset (already set) — mostly a
// convenience that confirms the mapping fields exist in the sample.
function MapButton({
  dataset,
  config,
  sample,
  onSaved,
}: {
  dataset: string
  config: AppConfig | null
  sample: Record<string, unknown>
  onSaved: (c: AppConfig) => void
}) {
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!config) return null
  const fm = config.fieldMapping
  const missing = [fm.hostField, fm.metricNameField, fm.valueField].filter((f) => !(f in sample))

  const confirm = (): void => {
    Modal.confirm({
      title: 'Save dataset to Settings',
      content: `Store dataset "${dataset}" as the dashboard's data source?`,
      confirmButtonText: 'Save',
      cancelButtonText: 'Cancel',
      onConfirm: async () => {
        setSaving(true)
        try {
          const next = { ...config, datasetName: dataset }
          await saveConfig(next)
          onSaved(next)
          setMsg('Saved.')
        } catch (err) {
          setMsg(describe(err))
        } finally {
          setSaving(false)
        }
      },
    })
  }

  return (
    <div className="verify-map">
      {missing.length > 0 && (
        <Alert appearance="warning" title="Mapped fields not in sample">
          The current Field mapping references {missing.map((m) => `"${m}"`).join(', ')}, which aren’t in this sample.
          Adjust the mapping in Settings to match the field names above.
        </Alert>
      )}
      <Button variant="secondary" pending={saving} onClick={confirm}>
        Save dataset to Settings
      </Button>
      {msg && (
        <Text color="subtle" variant="body-sm-normal">
          {msg}
        </Text>
      )}
    </div>
  )
}

// Body of a confirmation modal.
//
// The confirmation modal is a fixed width (ModalCreateOptions omits `size`) and
// clips overflow, so a long unbreakable value inlined in the sentence pushes
// the footer buttons out of the dialog — the ~190-character
// __forwardedAttrs.__inputId filter did exactly that. Long values go in a
// wrapping code block instead, and the prose itself is allowed to break so
// resource ids and ingest URLs can't overflow either.
function ConfirmBody({ text, code }: { text: string; code?: { label: string; value: string }[] }) {
  return (
    <div className="confirm-body">
      <Text variant="body-sm-normal">{text}</Text>
      {code?.map(({ label, value }) => (
        <div key={label} className="confirm-code">
          <Text color="subtle" variant="body-xs-normal">
            {label}
          </Text>
          <pre className="code-block">{value}</pre>
        </div>
      ))}
    </div>
  )
}

// Compact status pill for a collapsible section header (headerTrailingContentSlot).
function SectionStatus({ status, label }: { status: 'ready' | 'todo' | 'unknown'; label: string }) {
  const appearance = status === 'ready' ? 'success' : status === 'todo' ? 'warning' : 'info'
  return (
    <Pill appearance={appearance} variant="muted">
      {label}
    </Pill>
  )
}

// One readiness chip in the always-visible status strip: what it is, how it's
// doing. Lets a fully-collapsed guide still answer "where am I?".
function StatusChip({
  label,
  status,
  value,
}: {
  label: string
  status: 'ready' | 'todo' | 'unknown'
  value: string
}) {
  return (
    <span className="setup-chip">
      <Text color="subtle" variant="body-xs-normal">
        {label}
      </Text>
      <SectionStatus status={status} label={value} />
    </span>
  )
}

function describe(err: unknown): string {
  if (err instanceof CriblApiError) {
    const base = err.status ? `${err.message} (HTTP ${err.status})` : err.message
    if (err.status === 403) {
      return `${base}. This app may be missing a required API policy — grant the paths in policies.yml.`
    }
    // status 0 = client-side abort/timeout: the request reached the Cribl host
    // proxy but no response came back within the 30s limit. This is a transient
    // connectivity issue, not a permissions or app-code problem.
    if (err.status === 0 && /timed out|cancelled/i.test(err.message)) {
      return `${base}. The Cribl backend didn't respond in time — reload the Cribl browser tab to refresh the connection, then retry. If it persists, the fleet's leader may be busy or unreachable.`
    }
    return base
  }
  return err instanceof Error ? err.message : String(err)
}
