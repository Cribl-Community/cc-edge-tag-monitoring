# Cribl Edge Monitoring via Tags

A Cribl app that reports **Edge data volume grouped by your custom node tags** —
dimensions like `site`, `env`, or `team` that Edge fleet metrics can't slice on
their own. It provisions the plumbing to get per-node byte volume into Cribl
Lake, then joins each node's throughput back to its tags so you can see who is
sending what.

## Installation

Install directly from the Cribl Marketplace (Organization administrators only):

1. Log in to Cribl and click **Apps** in the top navigation.
2. Open the **Cribl Marketplace** catalog and find **Cribl Edge Monitoring via Tags**.
3. Review the app's **Overview**, **Permissions**, and **External API Access**, then click **Install**.
4. Complete any pre-install checks Cribl prompts you with.

## What it does

1. **Groups volume by tag.** Rolls up Edge in/out bytes by any tag key on your
   nodes (for example `site`, `env`, `team`), not just by fleet. Tags must be in
   `key:value` form (see the requirement below).
2. **Guided setup.** The **Setup Guide** provisions the required Cribl resources
   for you — a Cribl Internal metrics source, a relay destination, a Stream
   Worker Group route, and a Cribl Lake destination — one confirmed step at a
   time. Nothing is written to your environment without an explicit confirmation.
3. **Dashboard.** The **Dashboard** shows total volume by tag as a time-series
   chart and a sortable table over a selectable window.
4. **Multi-fleet.** Monitor several Edge fleets at once; each fleet relays into
   the same Stream Worker Group, so a single route catches them all.
5. **Configurable dimensions.** **Settings** lets you choose which tag key to
   group by and pick the Lake dataset to query.
6. **Optional volume controls.** Per fleet you can filter the relay to
   throughput metrics only (less volume), and optionally bake node tags into
   events for tag-aware querying.
7. **Jump to Cribl Search.** Open the underlying query in the Cribl Search UI
   straight from the Dashboard.

### Requirement: tags must be `key:value`

> **Node tags must be in `key:value` form** (for example `site:nyc`, `env:prod`,
> `team:payments`). The app groups and filters by the **key**, so the colon is
> required: the part before the `:` becomes the dimension and the part after is
> the value. **Plain tags with no colon are silently ignored** — a node tagged
> only `production` (no colon) contributes no dimension and won't appear in any
> grouping. If the Dashboard shows "No tagged Edge nodes found," re-tag your
> nodes in `key:value` form and use **Re-check for tags** (or the **Refresh**
> button), which re-reads the node inventory without a full reload.

### How it works

Edge custom tags are **not** metric dimensions — they live per node at
`/master/workers` (`info.cribl.tags`), and fleet metrics only expose
throughput at the fleet level. To bridge that gap the app routes each node's
Cribl **internal metrics** (which carry the node `host` and per-source/dest
bytes) through a two-hop relay — **Edge fleet → Stream Worker Group → Cribl
Lake** — preserving `host`. The Dashboard then queries Cribl Search for
`sum(bytes) by host`, joins each `host` to its tags from `/master/workers`, and
rolls the totals up by the tag dimension you selected. Edge can't write to Cribl
Lake directly, so the Stream Worker Group hop does the final write.

## Project structure

* [`src/pages/SetupGuide.tsx`](src/pages/SetupGuide.tsx) — assisted, confirm-per-step provisioning of the source, relay destination, Stream route, and Lake destination for each fleet.
* [`src/pages/Dashboard.tsx`](src/pages/Dashboard.tsx) — volume-by-tag time-series chart, table, and Cribl Search deep link.
* [`src/pages/Settings.tsx`](src/pages/Settings.tsx) — dataset selection, tag dimension, and app configuration.
* [`src/api/cribl.ts`](src/api/cribl.ts) — Cribl API + Search client (fleets, workers, inputs/outputs/routes, pipelines, search jobs).
* [`src/lib/query.ts`](src/lib/query.ts) — builds the Cribl Search KQL and the Search UI deep link.
* [`src/lib/tags.ts`](src/lib/tags.ts) — indexes node tags and joins `host → tags`.
* [`src/lib/rollup.ts`](src/lib/rollup.ts) — rolls per-host byte totals up by the chosen tag dimension.
* [`src/lib/config.ts`](src/lib/config.ts) — app config schema, persisted in the Cribl KV store.
* [`src/components/`](src/components) — `AppShell`, `TimeSeriesChart`, and `VolumeTable`.
* [`config/`](config) — `proxies.yml` / `policies.yml` shipped as packaged defaults.

## Development

```bash
npm install
npm run dev
```

Package a release artifact locally with `npm run package -- --version "1.0.0"`
(produces `build/cc-edge-tag-monitoring-<version>.tgz`).

## Release Versions

| Version | Changes |
|---------|---------|
| 1.0.4   | Make the `key:value` tag requirement explicit (plain tags are ignored) across the README, Dashboard, Settings, and Setup Guide; re-check node tags on every launch (`no-store` worker fetch) and add on-demand "Re-check for tags" / "Re-check tags" controls so newly-applied tags surface without a full reload. |
| 1.0.3   | Documentation: install via the Cribl Marketplace (replaces Import from Git). |
| 1.0.0   | Initial release: tag-grouped Edge volume dashboard, guided multi-fleet setup, configurable dimensions, optional throughput-only filtering and tag baking, and Cribl Search deep links. |

## License

Licensed under the [Apache License 2.0](LICENSE).
