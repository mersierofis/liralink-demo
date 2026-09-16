/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_USE_MOCK: string
  readonly VITE_HORIZON_URL: string
  readonly VITE_EXPLORER_TX_URL: string
  readonly VITE_CONTRACT_RAIL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
