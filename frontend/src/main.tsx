// App bootstrap: one QueryClient for the whole tree + BrowserRouter. Query
// defaults are tuned for a live dashboard — background polling drives updates,
// so we don't also refetch on window focus, and data is treated as always stale
// (the per-hook refetchInterval is the real cadence).

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 0,
            refetchOnWindowFocus: false,
            retry: 1,
            // Keep polling even when the tab is backgrounded off by default; the
            // browser throttles timers anyway and "Last updated" stays honest.
            refetchIntervalInBackground: false,
        },
    },
})

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </QueryClientProvider>
    </StrictMode>,
)
