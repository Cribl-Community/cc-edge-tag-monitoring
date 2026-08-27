// Globals injected by the Cribl App Platform at runtime (see AGENTS.md).
// These are read-only and always present when running inside Cribl — never
// define, assign, or polyfill them.
export {}

declare global {
  interface CriblUser {
    id: string
    username: string
    email?: string
    firstName?: string
    lastName?: string
    initials?: string
  }

  interface Window {
    /** Base URL for all Cribl API calls, e.g. https://localhost:9000/api/v1 */
    CRIBL_API_URL: string
    /** Base path the app is mounted at, e.g. /app-ui/my-app */
    CRIBL_BASE_PATH: string
    /** Resolves to the currently signed-in Cribl user. Memoized. */
    getCriblUser: () => Promise<CriblUser>
  }
}
