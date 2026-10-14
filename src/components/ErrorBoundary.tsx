// Catches render-time failures so one broken chunk can't white-screen the app.
//
// This bit us for real: Capra's EmptyState lazy-loads its illustration, and when
// the dev server answered that chunk with a 504 (stale node_modules/.vite cache
// after new Capra imports were added), the rejected dynamic import tore down the
// whole React tree — a blank page, with the cause visible only in the console.
// The same failure mode exists in production when a cached index.html points at
// chunks a redeploy has replaced.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Alert, Button, Text } from '@capra/core'

/** A failed dynamic import reads differently in each browser. */
function isChunkLoadError(message: string): boolean {
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i.test(
    message,
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place the component stack is available, and it's
    // what you need when a page blanks.
    console.error('[cc-edge-tag-monitoring] uncaught render error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="page">
        <Alert appearance="danger" title="Something went wrong on this page">
          <div className="section-stack">
            {isChunkLoadError(error.message) ? (
              <Text variant="body-sm-normal">
                Part of the app failed to download. Reload the page — if it keeps happening on a dev server, its
                dependency cache is stale: stop it, run{' '}
                <code className="inline-code">rm -rf node_modules/.vite</code>, and start it again.
              </Text>
            ) : (
              <Text variant="body-sm-normal">
                The rest of the app still works — switch tabs, or reload to start over. Details are in the browser
                console.
              </Text>
            )}
            <pre className="code-block">{error.message}</pre>
            <div className="save-bar">
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload the app
              </Button>
            </div>
          </div>
        </Alert>
      </div>
    )
  }
}
