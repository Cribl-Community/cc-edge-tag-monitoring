// App chrome: title bar + tab navigation. Wraps the routed pages in Capra's
// RouterProvider so TabNav/links navigate client-side through React Router.

import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { RouterProvider, TabNav, Text } from '@capra/core'

const TABS = [
  { key: '/', name: 'Dashboard', href: '/' },
  { key: '/setup', name: 'Setup Guide', href: '/setup' },
  { key: '/settings', name: 'Settings', href: '/settings' },
]

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const activeKey = TABS.some((t) => t.key === location.pathname) ? location.pathname : '/'

  return (
    <RouterProvider navigate={(path) => navigate(path)}>
      <div className="app-shell">
        <header className="app-header">
          <Text as="h1" variant="heading-md">
            Cribl Edge Monitoring via Tags
          </Text>
          <Text color="subtle" variant="body-sm-normal">
            Data volume grouped by custom Edge node tags
          </Text>
        </header>
        <nav className="app-nav">
          <TabNav activeKey={activeKey} items={TABS} aria-label="Primary" />
        </nav>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </RouterProvider>
  )
}
