import type { HttpHandler } from 'msw'

// Filled in during the MSW step (03-MERCHANT-WEB.md build order, step 7): one handler per
// merchant endpoint in docs/00-PROJECT.md §6, stateful in memory, seeded with the demo
// merchant + 6 links matching the real backend's shapes. Kept empty for now so scaffolding
// with VITE_USE_MOCK=false against the real API isn't blocked on it.
export const handlers: HttpHandler[] = []
