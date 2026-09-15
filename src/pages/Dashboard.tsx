// Dashboard: pick a time range, group by one tag dimension, filter on others;
// see ingest + sent volume per tag value as a table and a time-series chart.
// Read-only. Volume comes from Search-over-Lake; the host->tag roll-up is done
// app-side (see lib/rollup).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, ButtonLink, EmptyState, SelectField, Spinner, Text } from '@capra/core'
import { ArrowUpRightFromSquare } from '@capra/icons'
import { getWorkers, runSearchJob, apiBaseUrl, CriblApiError } from '../api/cribl'
import { buildTagIndex, type TagIndex } from '../lib/tags'
import { loadConfig, saveConfig, isConfigured, type AppConfig } from '../lib/config'
import { buildVolumeQuery, buildSearchUiUrl, rangeBounds, rangeById, TIME_RANGES } from '../lib/query'
import { rollup, type RollupResult } from '../lib/rollup'
import { VolumeTable } from '../components/VolumeTable'
import { TimeSeriesChart } from '../components/TimeSeriesChart'

const ALL = '__all__'

export function Dashboard() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [index, setIndex] = useState<TagIndex | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [initLoading, setInitLoading] = useState(true)

  const [rangeId, setRangeId] = useState('24h')
  const [groupBy, setGroupBy] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})

  const [result, setResult] = useState<RollupResult | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [recheckingTags, setRecheckingTags] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  // Job id of the last completed search, so "Investigate in Cribl Search" can
  // deep-link to /search/<jobId> (a bare /search renders blank). Null while a
  // search is in flight or before the first run, which hides the link.
  const [jobId, setJobId] = useState<string | null>(null)
  const rawRef = useRef<Record<string, unknown>[]>([])

  // Load config + node tag index once.
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const [cfg, workers] = await Promise.all([loadConfig(ctrl.signal), getWorkers(ctrl.signal)])
        const idx = buildTagIndex(workers)
        setConfig(cfg)
        setIndex(idx)
        const dims = availableDims(cfg, idx)
        setRangeId(cfg.defaultRangeId || '24h')
        setGroupBy(cfg.defaultGroupBy && dims.includes(cfg.defaultGroupBy) ? cfg.defaultGroupBy : dims[0] ?? '')
      } catch (err) {
        if (!ctrl.signal.aborted) setInitError(describe(err))
      } finally {
        if (!ctrl.signal.aborted) setInitLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [])

  const dims = useMemo(() => (config && index ? availableDims(config, index) : []), [config, index])
  const filterDims = useMemo(() => dims.filter((d) => d !== groupBy), [dims, groupBy])

  // Deep link to the same search in the Cribl Search UI, so the user can open and
  // explore the exact query the dashboard runs (per-host in/out bytes for the
  // selected range; the host->tag roll-up is applied app-side). Follows the
  // dataset/range, not the group/filter selects — those aren't part of the query.
  // Uses the job id from the dashboard's own last-completed search: the UI needs
  // /search/<jobId> to load results, so the link only appears once a search has
  // run (jobId != null). rangeId/config match the job that produced jobId because
  // runQuery clears jobId on each new run and sets it from the same inputs.
  const searchUiUrl = useMemo(() => {
    if (!config || !isConfigured(config) || !jobId) return null
    const range = rangeById(rangeId)
    const query = buildVolumeQuery(config.datasetName, config.fieldMapping, range)
    const { earliest, latest } = rangeBounds(range)
    return buildSearchUiUrl(apiBaseUrl(), jobId, query, earliest, latest)
  }, [config, rangeId, jobId])

  // "Skip setup" — the user asserts everything is already provisioned, so bypass
  // the setup gate and remember the choice (persisted in KV, not browser storage).
  const skipSetup = useCallback((): void => {
    setConfig((prev) => {
      if (!prev || prev.skipSetup) return prev
      const next: AppConfig = { ...prev, skipSetup: true }
      void saveConfig(next).catch((err) => setInitError(describe(err)))
      return next
    })
  }, [])

  // Re-read the node/tag inventory from /master/workers and rebuild the tag
  // index, so tags applied to Edge nodes after the dashboard opened surface
  // without a full page reload. Fetch is no-store, so this always reflects the
  // current tags. The dims memo picks up any newly-discovered dimensions.
  const reloadTags = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setRecheckingTags(true)
    try {
      const workers = await getWorkers(signal)
      if (signal?.aborted) return
      setIndex(buildTagIndex(workers))
    } catch (err) {
      if (!signal?.aborted) setSearchError(describe(err))
    } finally {
      if (!signal?.aborted) setRecheckingTags(false)
    }
  }, [])

  // Group/filter are applied app-side, so changing them only re-rolls the last
  // result — no new Search. Only the time range / dataset changes the query.
  const recompute = useCallback(() => {
    if (!config || !index || !groupBy || rawRef.current.length === 0) {
      setResult(null)
      return
    }
    setResult(rollup(rawRef.current, index, config.fieldMapping.hostField, groupBy, activeFilters(filters)))
  }, [config, index, groupBy, filters])

  const runQuery = useCallback(
    async (signal: AbortSignal) => {
      if (!config || !index || !isConfigured(config)) return
      setSearching(true)
      setSearchError(null)
      setJobId(null)
      try {
        const range = rangeById(rangeId)
        const query = buildVolumeQuery(config.datasetName, config.fieldMapping, range)
        const { earliest, latest } = rangeBounds(range)
        const { jobId: id, rows } = await runSearchJob(query, earliest, latest, signal)
        if (signal.aborted) return
        rawRef.current = rows
        setJobId(id)
        setDataVersion((v) => v + 1)
      } catch (err) {
        if (!signal.aborted) {
          setSearchError(describe(err))
          setResult(null)
        }
      } finally {
        if (!signal.aborted) setSearching(false)
      }
    },
    [config, index, rangeId],
  )

  // Fetch when the query (range/dataset) changes.
  useEffect(() => {
    const ctrl = new AbortController()
    void runQuery(ctrl.signal)
    return () => ctrl.abort()
  }, [runQuery])

  // Re-roll up when new data arrives or when group/filter selections change.
  useEffect(() => {
    recompute()
  }, [recompute, dataVersion])

  if (initLoading) return <Spinner size="lg" title="Loading configuration…" />

  if (initError) {
    return (
      <Alert appearance="danger" title="Couldn't load the dashboard">
        {permissionHint(initError)}
      </Alert>
    )
  }

  if (config && !isConfigured(config) && !config.skipSetup) {
    return (
      <EmptyState
        illustration="EmptyFolder"
        size="lg"
        title="Set up per-node volume capture first"
        description="The dashboard reads Edge volume from a Cribl Lake dataset of routed internal metrics. Run the Setup Guide to provision it, then choose the dataset in Settings. Already provisioned everything? Skip straight to the dashboard."
      >
        <ButtonLink href="/setup" variant="primary">
          Open Setup Guide
        </ButtonLink>
        <Button variant="secondary" onClick={skipSetup}>
          Skip setup — I&apos;ve configured everything
        </Button>
      </EmptyState>
    )
  }

  if (dims.length === 0) {
    return (
      <EmptyState
        illustration="MissingSock"
        size="lg"
        title="No tagged Edge nodes found"
        description="No custom tags were discovered on any Edge node (info.cribl.tags). Tags must be in key:value form (for example site:nyc) — plain tags with no colon are ignored, since the dashboard groups by the key. Apply key:value tags to your nodes, then re-check."
      >
        <Button variant="primary" disabled={recheckingTags} onClick={() => void reloadTags()}>
          {recheckingTags ? 'Re-checking…' : 'Re-check for tags'}
        </Button>
        <ButtonLink href="/setup" variant="secondary">
          How to tag nodes
        </ButtonLink>
      </EmptyState>
    )
  }

  return (
    <div className="page">
      {config && !isConfigured(config) && (
        <Alert appearance="warning" title="No dataset selected">
          Setup is skipped, but no Cribl Lake dataset is chosen yet, so there&apos;s nothing to query. Pick the dataset
          your routed metrics land in on the Settings page.
          <div className="controls-action">
            <ButtonLink href="/settings" variant="secondary">
              Open Settings
            </ButtonLink>
          </div>
        </Alert>
      )}
      <div className="controls-block">
        <div className="controls">
          <SelectField
            label="Time range"
            value={rangeId}
            onChange={(v) => setRangeId(String(v ?? '24h'))}
            items={TIME_RANGES.map((r) => ({ id: r.id, label: r.label }))}
          />
          <SelectField
            label="Group by"
            value={groupBy}
            onChange={(v) => setGroupBy(String(v ?? ''))}
            items={dims.map((d) => ({ id: d, label: d }))}
          />
          {filterDims.map((d) => (
            <SelectField
              key={d}
              label={`Filter: ${d}`}
              value={filters[d] ?? ALL}
              onChange={(v) => setFilters((f) => ({ ...f, [d]: String(v ?? ALL) }))}
              items={[{ id: ALL, label: 'All' }, ...(index!.dimensions.get(d) ?? []).map((val) => ({ id: val, label: val }))]}
            />
          ))}
          <div className="controls-action">
            <Button
              variant="secondary"
              disabled={searching || recheckingTags}
              onClick={() => {
                const ctrl = new AbortController()
                // Re-check node tags (surface newly-applied tags) and re-run the
                // volume search together, so one button refreshes both.
                void reloadTags(ctrl.signal)
                void runQuery(ctrl.signal)
              }}
            >
              {searching || recheckingTags ? 'Refreshing…' : 'Refresh'}
            </Button>
            {searchUiUrl && (
              <ButtonLink
                href={searchUiUrl}
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                trailingIcon={ArrowUpRightFromSquare}
              >
                Investigate in Cribl Search
              </ButtonLink>
            )}
          </div>
        </div>
        {searchUiUrl && (
          <div className="controls-note">
            <Text as="p" variant="body-sm-normal" color="subtle">
              “Investigate in Cribl Search” opens the query behind this dashboard — total in/out volume{' '}
              <strong>per host</strong> over the selected time range. Grouping by “{groupBy}” and any filters are applied
              here in the app (Edge tags aren’t fields in the dataset), so that view lists individual hosts, not{' '}
              {groupBy} values.
            </Text>
          </div>
        )}
      </div>

      {searchError && (
        <Alert appearance="danger" title="Search failed">
          {permissionHint(searchError)}
        </Alert>
      )}

      {searching && !result && <Spinner size="lg" title="Running search…" />}

      {result && (
        <>
          {result.table.length === 0 ? (
            <EmptyState
              illustration="EmptyBowl"
              title="No volume in this range"
              description="The dataset returned no rows for the selected time range and filters. Try a wider range, or verify the field mapping in Settings."
            >
              {searchUiUrl && (
                <ButtonLink
                  href={searchUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="secondary"
                  trailingIcon={ArrowUpRightFromSquare}
                >
                  Investigate in Cribl Search
                </ButtonLink>
              )}
            </EmptyState>
          ) : (
            <>
              {result.droppedNoHost > 0 && (
                <Alert appearance="warning" title="Some rows had no host field">
                  {result.droppedNoHost} result row(s) were missing the “{config!.fieldMapping.hostField}” field and were
                  excluded. Check the field mapping in Settings so no volume is dropped.
                </Alert>
              )}
              <section className="panel">
                <Text as="h2" variant="heading-sm">
                  Volume by {groupBy}
                </Text>
                <VolumeTable rows={result.table} totals={result.totals} groupBy={groupBy} />
              </section>
              <section className="panel">
                <Text as="h2" variant="heading-sm">
                  Volume over time
                </Text>
                <TimeSeriesChart
                  buckets={result.buckets}
                  series={result.series}
                  rangeSeconds={rangeById(rangeId).seconds}
                />
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}

function availableDims(config: AppConfig, index: TagIndex): string[] {
  const all = [...index.dimensions.keys()].sort((a, b) => a.localeCompare(b))
  if (config.exposedDimensions.length === 0) return all
  return config.exposedDimensions.filter((d) => index.dimensions.has(d))
}

function activeFilters(filters: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(filters)) if (v && v !== ALL) out[k] = v
  return out
}

function describe(err: unknown): string {
  if (err instanceof CriblApiError) return err.status ? `${err.message} (HTTP ${err.status})` : err.message
  return err instanceof Error ? err.message : String(err)
}

function permissionHint(msg: string): string {
  if (/403|forbidden|permission/i.test(msg)) {
    return `${msg}. This app may be missing a required API policy — ask your admin to grant the paths declared in the app's policies.yml.`
  }
  return msg
}
