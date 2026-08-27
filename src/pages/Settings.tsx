// Settings: the Lake dataset the dashboard reads, the Search field mapping
// (kept adjustable because the routed-metric schema is verified live, not
// assumed), which discovered tag dimensions to expose, and dashboard defaults.
// Persisted to the app-scoped KV store.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Checkbox, SelectField, Spinner, Tag, Text, TextField } from '@capra/core'
import {
  getWorkers,
  listLakeDatasets,
  CriblApiError,
  NON_WRITABLE_DATASET_IDS,
  SYSTEM_DATASET_IDS,
  type LakeDataset,
} from '../api/cribl'
import { buildTagIndex, type TagIndex } from '../lib/tags'
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AppConfig } from '../lib/config'
import { TIME_RANGES } from '../lib/query'

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }

// Cribl Cloud orgs have a single lake, conventionally "default", and there's no
// API to list lakes — same fixed id the Setup Guide's dataset picker uses.
const LAKE_ID = 'default'

export function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [index, setIndex] = useState<TagIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })

  const [datasets, setDatasets] = useState<LakeDataset[] | null>(null)
  const [dsLoading, setDsLoading] = useState(true)
  const [dsError, setDsError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const [cfg, workers] = await Promise.all([loadConfig(ctrl.signal), getWorkers(ctrl.signal)])
        setConfig(cfg)
        setIndex(buildTagIndex(workers))
      } catch (err) {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [])

  // Load Lake datasets for the data-source dropdown (mirrors the Setup Guide).
  const loadDatasets = useCallback(async (signal?: AbortSignal) => {
    setDsLoading(true)
    setDsError(null)
    try {
      const ds = await listLakeDatasets(LAKE_ID, signal)
      if (signal?.aborted) return
      setDatasets(ds)
    } catch (err) {
      if (!signal?.aborted) {
        setDatasets(null)
        setDsError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (!signal?.aborted) setDsLoading(false)
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    void loadDatasets(ctrl.signal)
    return () => ctrl.abort()
  }, [loadDatasets])

  // Same option labeling as the Setup Guide's dataset picker (retention, built-in,
  // not-writable annotations) so the two dropdowns behave identically.
  const datasetItems = useMemo(() => {
    const items = (datasets ?? []).map((d) => {
      const bits: string[] = []
      if (typeof d.retentionPeriodInDays === 'number') bits.push(`${d.retentionPeriodInDays}d`)
      if (SYSTEM_DATASET_IDS.includes(d.id)) bits.push('built-in')
      if (NON_WRITABLE_DATASET_IDS.includes(d.id)) bits.push('not writable')
      return { id: d.id, label: bits.length ? `${d.id} · ${bits.join(' · ')}` : d.id }
    })
    // Always keep the currently-saved dataset selectable, even if the list hasn't
    // loaded yet or doesn't include it — otherwise the dropdown renders blank on
    // return and looks like the selection wasn't saved.
    const current = config?.datasetName?.trim()
    if (current && !items.some((i) => i.id === current)) {
      items.unshift({ id: current, label: `${current} · saved` })
    }
    return items
  }, [datasets, config?.datasetName])

  if (loading) return <Spinner size="lg" title="Loading settings…" />
  if (loadError || !config || !index) {
    return (
      <Alert appearance="danger" title="Couldn't load settings">
        {loadError ?? 'Unknown error'}
      </Alert>
    )
  }

  const discovered = [...index.dimensions.keys()].sort((a, b) => a.localeCompare(b))
  const exposed = config.exposedDimensions.length === 0 ? discovered : config.exposedDimensions
  const cfg = config // narrowed for handlers

  const update = (patch: Partial<AppConfig>): void => {
    setConfig({ ...cfg, ...patch })
    setSave({ kind: 'idle' })
  }
  const updateMapping = (patch: Partial<AppConfig['fieldMapping']>): void => {
    update({ fieldMapping: { ...cfg.fieldMapping, ...patch } })
  }
  const toggleExposed = (dim: string, on: boolean): void => {
    const base = new Set(exposed)
    if (on) base.add(dim)
    else base.delete(dim)
    update({ exposedDimensions: [...base] })
  }

  const onSave = async (): Promise<void> => {
    setSave({ kind: 'saving' })
    try {
      await saveConfig(cfg)
      setSave({ kind: 'saved' })
    } catch (err) {
      setSave({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="page">
      {save.kind === 'saved' && (
        <Alert appearance="success" title="Settings saved" onDismiss={() => setSave({ kind: 'idle' })}>
          Your changes are stored in the app KV store.
        </Alert>
      )}
      {save.kind === 'error' && (
        <Alert appearance="danger" title="Couldn't save settings">
          {save.message}
        </Alert>
      )}

      <Card>
        <Card.Header>
          <Card.Title>Data source</Card.Title>
          <Card.Description>
            The Cribl Lake dataset that routed internal metrics land in. Create datasets in the Setup Guide.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {dsError && (
            <Alert appearance="warning" title="Couldn't list datasets" onDismiss={() => setDsError(null)}>
              {dsError}
            </Alert>
          )}
          {cfg.datasetName && (
            <Text variant="body-sm-semibold">
              Current: <Tag color="blue" size="sm">{cfg.datasetName}</Tag>
            </Text>
          )}
          <div className="field-grid">
            <SelectField
              label="Lake dataset"
              value={datasetItems.some((i) => i.id === cfg.datasetName) ? cfg.datasetName : null}
              placeholder={dsLoading ? 'Loading…' : 'Select a dataset'}
              items={datasetItems}
              disabled={dsLoading || datasetItems.length === 0}
              onChange={(v) => v != null && update({ datasetName: String(v), lakeId: LAKE_ID })}
              helperText={
                datasetItems.length === 0
                  ? 'No datasets listed — enter the name manually below, or create one in the Setup Guide.'
                  : 'Choose the dataset the dashboard reads.'
              }
            />
          </div>
          {(dsError || datasetItems.length === 0) && (
            <div className="field-grid">
              <TextField
                label="Dataset name (manual)"
                value={cfg.datasetName}
                onChange={(v) => update({ datasetName: v, lakeId: LAKE_ID })}
                helperText="Can't list datasets (Lake listing is Cribl.Cloud-only). Type the exact dataset name your routed metrics land in — the dashboard queries it directly via Search."
              />
            </div>
          )}
          {NON_WRITABLE_DATASET_IDS.includes(cfg.datasetName) && (
            <Alert appearance="warning" title="Selected dataset is not writable">
              “{cfg.datasetName}” is a built-in Cribl dataset and can’t receive routed metrics. Pick another.
            </Alert>
          )}
          <div className="save-bar">
            <Button variant="secondary" disabled={dsLoading} onClick={() => void loadDatasets()}>
              {dsLoading ? 'Loading…' : 'Reload datasets'}
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Field mapping</Card.Title>
          <Card.Description>
            How the dashboard reads bytes from the dataset. Confirm these against the sample shown by the Setup Guide’s
            verify step — accurate mapping is what makes the volume numbers trustworthy.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="field-grid">
            <TextField label="Host field" value={cfg.fieldMapping.hostField} onChange={(v) => updateMapping({ hostField: v })} />
            <TextField label="Metric-name field" value={cfg.fieldMapping.metricNameField} onChange={(v) => updateMapping({ metricNameField: v })} />
            <TextField label="Value field" value={cfg.fieldMapping.valueField} onChange={(v) => updateMapping({ valueField: v })} />
            <TextField label="Ingest metric name" value={cfg.fieldMapping.inBytesMetric} onChange={(v) => updateMapping({ inBytesMetric: v })} />
            <TextField label="Sent metric name" value={cfg.fieldMapping.outBytesMetric} onChange={(v) => updateMapping({ outBytesMetric: v })} />
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Tag dimensions</Card.Title>
          <Card.Description>
            Auto-discovered from node tags (info.cribl.tags). Choose which to expose in the dashboard.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {discovered.length === 0 ? (
            <Text color="subtle">No tagged nodes discovered yet.</Text>
          ) : (
            <div className="dim-list">
              {discovered.map((dim) => (
                <div key={dim} className="dim-row">
                  <Checkbox
                    checked={exposed.includes(dim)}
                    onChange={(e) => toggleExposed(dim, (e.target as HTMLInputElement).checked)}
                  >
                    {dim}
                  </Checkbox>
                  <div className="dim-values">
                    {(index.dimensions.get(dim) ?? []).map((val) => (
                      <Tag key={val} color="blue" size="sm">
                        {val}
                      </Tag>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Defaults</Card.Title>
          <Card.Description>Initial selections when the dashboard opens.</Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="field-grid">
            <SelectField
              label="Default group-by"
              value={cfg.defaultGroupBy || null}
              placeholder="First available"
              onChange={(v) => update({ defaultGroupBy: String(v ?? '') })}
              items={exposed.map((d) => ({ id: d, label: d }))}
            />
            <SelectField
              label="Default time range"
              value={cfg.defaultRangeId}
              onChange={(v) => update({ defaultRangeId: String(v ?? '24h') })}
              items={TIME_RANGES.map((r) => ({ id: r.id, label: r.label }))}
            />
          </div>
        </Card.Content>
      </Card>

      <div className="save-bar">
        <Button variant="secondary" disabled={save.kind === 'saving'} onClick={() => update(DEFAULT_CONFIG)}>
          Reset to defaults
        </Button>
        <Button variant="primary" pending={save.kind === 'saving'} onClick={() => void onSave()}>
          Save settings
        </Button>
      </div>
    </div>
  )
}

// Surfaces the error type name for consistency with the rest of the app.
export type { CriblApiError }
