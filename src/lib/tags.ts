// Custom-tag handling. Edge node tags live at info.cribl.tags as a KEY:VALUE
// array (e.g. ["site:1","test:no"]). Tags are orthogonal named dimensions: a
// user groups by one dimension and filters on others. The join key from a
// Search row (host) back to a node is info.hostname.

import type { WorkerNode } from '../api/cribl'

export const UNTAGGED = '(untagged)'
export const UNKNOWN_HOST = '(unknown host)'

export interface HostTags {
  /** dimension key -> value for one host */
  [dimension: string]: string
}

export interface TagIndex {
  /** hostname (lowercased) -> its tag map */
  byHost: Map<string, HostTags>
  /** discovered dimension key -> sorted distinct values */
  dimensions: Map<string, string[]>
}

/** Parse a single "key:value" tag. Value may itself contain colons. */
export function parseTag(tag: string): [string, string] | null {
  const idx = tag.indexOf(':')
  if (idx <= 0) return null
  const key = tag.slice(0, idx).trim()
  const value = tag.slice(idx + 1).trim()
  if (!key) return null
  return [key, value]
}

/** Build the host->tags map and discover dimensions/values from worker nodes. */
export function buildTagIndex(workers: WorkerNode[]): TagIndex {
  const byHost = new Map<string, HostTags>()
  const dimValues = new Map<string, Set<string>>()

  for (const w of workers) {
    const hostname = w.info?.hostname
    if (!hostname) continue
    const tags = w.info?.cribl?.tags ?? []
    const hostTags: HostTags = {}
    for (const raw of tags) {
      const parsed = parseTag(raw)
      if (!parsed) continue
      const [key, value] = parsed
      hostTags[key] = value
      if (!dimValues.has(key)) dimValues.set(key, new Set())
      dimValues.get(key)!.add(value)
    }
    byHost.set(hostname.toLowerCase(), hostTags)
  }

  const dimensions = new Map<string, string[]>()
  for (const [key, values] of dimValues) {
    dimensions.set(key, [...values].sort((a, b) => a.localeCompare(b)))
  }
  return { byHost, dimensions }
}

/** The value a host carries for a dimension, or UNTAGGED. null if host unknown. */
export function tagValueForHost(
  index: TagIndex,
  host: string,
  dimension: string,
): string | null {
  const tags = index.byHost.get(host.toLowerCase())
  if (!tags) return null // host not found in /master/workers
  return tags[dimension] ?? UNTAGGED
}

/** True if a host passes all active filters (dimension -> required value). */
export function hostPassesFilters(
  index: TagIndex,
  host: string,
  filters: Record<string, string>,
): boolean {
  const tags = index.byHost.get(host.toLowerCase())
  for (const [dim, want] of Object.entries(filters)) {
    if (!want) continue
    const have = tags?.[dim] ?? UNTAGGED
    if (have !== want) return false
  }
  return true
}
