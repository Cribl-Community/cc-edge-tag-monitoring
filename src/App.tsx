// Router root. The platform serves the app under a base path, so React Router
// is mounted with basename={window.CRIBL_BASE_PATH} (see AGENTS.md).

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { SetupGuide } from './pages/SetupGuide'
import { Settings } from './pages/Settings'

function App() {
  return (
    <BrowserRouter basename={window.CRIBL_BASE_PATH}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="setup" element={<SetupGuide />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
