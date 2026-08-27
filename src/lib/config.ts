// App configuration, persisted in the app-scoped KV store (never browser
// storage). This holds the Lake dataset the dashboard reads, the field mapping
// used to build the Search query, and dashboard defaults.
//
// The field mapping is user-adjustable because the exact schema of routed
// internal metrics in the Lake dataset is verified live (Setup Guide) rather
// than assumed — accuracy is the priority, so the user confirms the mapping.

import { kvGet, kvSet } from '../api/cribl'

export const CONFIG_KEY = 'config/app'

export interface FieldMapping {
  /** Field holding the metric name, e.g. "_metric". */
  metricNameField: string
  /** Field holding the numeric value, e.g. "_value". */
  valueField: string
  /** Field holding the emitting host, e.g. "host". */
  hostField: string
  /** Metric name for bytes ingested. */
  inBytesMetric: string
  /** Metric name for bytes sent to a destination. */
  outBytesMetric: string
}

/** Transport for the Edge -> Stream relay hop. */
export type RelayTransport = 'cribl_http' | 'cribl_tcp'

export interface AppConfig {
  /** Cribl Lake id that holds the dataset (Cribl Cloud default is "default"). */
  lakeId: string
  /** Lake dataset name that routed internal metrics land in. */
  datasetName: string
  fieldMapping: FieldMapping
  /**
   * When true, the routed metrics are filtered down to only the throughput
   * (byte) metrics the dashboard sums, so far less data lands in Lake (fewer
   * credits). When false, the full internal-metrics stream is routed.
   */
  throughputOnly: boolean
  /**
   * Stream Worker Group that relays Edge data to Cribl Lake. Edge deployments
   * cannot write to Lake directly (HTTP 405), so metrics flow
   * Edge -> (Cribl HTTP/TCP) -> Stream WG -> Cribl Lake.
   */
  streamGroup: string
  /** Transport used for the Edge -> Stream hop. */
  relayTransport: RelayTransport
  /**
   * Id of the Cribl HTTP/TCP destination created on the Edge fleet that forwards
   * to Stream. Customizable: if the user renames the destination in Cribl, this
   * must follow, because the Stream route matches forwarded events on
   * __forwardedAttrs.__outputId == '<transport>:<relayDestId>'. Defaults to
   * "cc_edge_tag_relay".
   */
  relayDestId: string
  /**
   * Endpoint the Edge destination sends to: a full URL for Cribl HTTP
   * (e.g. https://host:10200) or a host for Cribl TCP. Best-effort auto-derived
   * from the Stream group's worker nodes, but user-editable — the Cloud ingest
   * address is not reliably discoverable via the API.
   */
  relayEndpoint: string
  /** Port the Stream source listens on / the Edge destination sends to. */
  relayPort: number
  /**
   * When true, bake each node's KEY:VALUE tags (from __metadata.cribl.tags) into
   * named fields on the events sent to Lake. This takes TWO config changes on the
   * Edge fleet: (1) remove the source's default cribl_metrics_rollup pre-processing
   * pipeline — it aggregates metrics but strips the tag metadata the enrich reads,
   * so tags can't be baked while it runs — and (2) set the cc_edge_tag_enrich
   * pipeline on the relay ROUTE to add the fields. Gives point-in-time tag
   * attribution (survives later tag changes / node removal) and lets the dashboard
   * group on the fields directly, instead of the live host->tag join from the
   * worker inventory. Trade-off: without the rollup, metrics reach Lake un-rolled
   * (higher storage volume; summed totals stay accurate). Off by default (the join
   * is the reliable, lower-volume path). Requires fleet metadata collection.
   */
  bakeTags: boolean
  /**
   * When true, bypass the dashboard's "run setup first" gate. For users who have
   * already provisioned everything (in Cribl or a prior session) and just want
   * to view the dashboard. Off by default. A dataset still has to be selected in
   * Settings for the dashboard to show data.
   */
  skipSetup: boolean
  /**
   * Edge fleets being monitored by this app (senders). A customer can relay
   * several fleets into the same Stream Worker Group; every fleet creates a relay
   * destination with the SAME id (relayDestId), so a single Stream route
   * (filtering on __forwardedAttrs.__outputId) receives them all. The Setup Guide
   * tracks these to show per-fleet status; the dashboard reads all of them from
   * the shared Lake dataset regardless. Auto-populated as fleets are configured.
   */
  edgeFleets: string[]
  /** Dimensions to expose in the dashboard. Empty = expose all discovered. */
  exposedDimensions: string[]
  /** Default dimension to group by. */
  defaultGroupBy: string
  /** Default time-range preset id (see query.ts). */
  defaultRangeId: string
}

export const DEFAULT_CONFIG: AppConfig = {
  lakeId: 'default',
  datasetName: '',
  fieldMapping: {
    // Verified live against the routed dataset (cc_edge_metrics) 2026-08-25:
    // _metric / _value / host are real, populated columns. The byte metrics
    // carry the cribl.logstream. prefix; host.in_bytes / host.out_bytes are the
    // per-host aggregate (one value per host per rollup window) — the cleanest
    // grain for summing volume per node, with no input/output double-counting.
    metricNameField: '_metric',
    valueField: '_value',
    hostField: 'host',
    inBytesMetric: 'cribl.logstream.host.in_bytes',
    outBytesMetric: 'cribl.logstream.host.out_bytes',
  },
  throughputOnly: true,
  streamGroup: '',
  relayTransport: 'cribl_http',
  relayDestId: 'cc_edge_tag_relay',
  relayEndpoint: '',
  relayPort: 10200,
  bakeTags: false,
  skipSetup: false,
  edgeFleets: [],
  exposedDimensions: [],
  defaultGroupBy: '',
  defaultRangeId: '24h',
}

// Configs saved before 2026-08-25 stored the byte-metric names without the
// `cribl.logstream.` prefix (and used `total.*`, which is split by output and
// double-counts our own relay). Those names match zero rows, so the dashboard
// showed "no volume". Upgrade ONLY these exact legacy values on load, leaving
// any deliberate user override untouched. See [[cribl-edge-tag-volume]].
const LEGACY_METRIC_NAMES: Record<string, string> = {
  'total.in_bytes': 'cribl.logstream.host.in_bytes',
  'total.out_bytes': 'cribl.logstream.host.out_bytes',
}

export async function loadConfig(signal?: AbortSignal): Promise<AppConfig> {
  const stored = await kvGet<Partial<AppConfig>>(CONFIG_KEY, signal)
  if (!stored) return { ...DEFAULT_CONFIG }
  // Merge so new fields added in later versions get sensible defaults.
  const fieldMapping = { ...DEFAULT_CONFIG.fieldMapping, ...(stored.fieldMapping ?? {}) }
  fieldMapping.inBytesMetric = LEGACY_METRIC_NAMES[fieldMapping.inBytesMetric] ?? fieldMapping.inBytesMetric
  fieldMapping.outBytesMetric = LEGACY_METRIC_NAMES[fieldMapping.outBytesMetric] ?? fieldMapping.outBytesMetric
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    fieldMapping,
    exposedDimensions: stored.exposedDimensions ?? [],
    edgeFleets: stored.edgeFleets ?? [],
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await kvSet(CONFIG_KEY, config)
}

/** Whether the app has enough config to run the dashboard. */
export function isConfigured(config: AppConfig): boolean {
  return config.datasetName.trim().length > 0
}
