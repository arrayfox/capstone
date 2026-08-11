// Global top-bar controls in one tiny Zustand store. Every query reads these,
// so a single change (e.g. category) re-scopes the whole dashboard at once.

import { create } from 'zustand'
import { DEFAULT_POLL_SECONDS } from './constants'

// "all" is the sentinel for "no filter" — the api client strips it out.
export type AllOr<T extends string> = 'all' | T

interface FilterState {
    windowDays: number
    category: string
    criticality: string
    status: string

    // Auto-refresh controls (replace a Settings page).
    autoRefresh: boolean
    intervalSeconds: number

    setWindowDays: (n: number) => void
    setCategory: (v: string) => void
    setCriticality: (v: string) => void
    setStatus: (v: string) => void
    setAutoRefresh: (v: boolean) => void
    setIntervalSeconds: (n: number) => void
    reset: () => void
}

const initial = {
    windowDays: 7,
    category: 'all',
    criticality: 'all',
    status: 'all',
    autoRefresh: true,
    intervalSeconds: DEFAULT_POLL_SECONDS,
}

export const useFilters = create<FilterState>((set) => ({
    ...initial,
    setWindowDays: (windowDays) => set({ windowDays }),
    setCategory: (category) => set({ category }),
    setCriticality: (criticality) => set({ criticality }),
    setStatus: (status) => set({ status }),
    setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
    setIntervalSeconds: (intervalSeconds) => set({ intervalSeconds }),
    reset: () => set(initial),
}))

// ---- Sidebar collapse (desktop), persisted so it survives reloads ----
const SIDEBAR_KEY = 'pw.sidebarCollapsed'

function readCollapsed(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
        return false
    }
}

interface UiState {
    sidebarCollapsed: boolean
    toggleSidebar: () => void
    setSidebarCollapsed: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
    sidebarCollapsed: readCollapsed(),
    toggleSidebar: () =>
        set((s) => {
            const next = !s.sidebarCollapsed
            try {
                localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
            } catch {
                /* ignore quota / privacy-mode errors */
            }
            return { sidebarCollapsed: next }
        }),
    setSidebarCollapsed: (sidebarCollapsed) => {
        try {
            localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0')
        } catch {
            /* ignore */
        }
        set({ sidebarCollapsed })
    },
}))


/** Poll interval (ms) for TanStack Query — false disables polling entirely. */
export function usePollInterval(): number | false {
    const auto = useFilters((s) => s.autoRefresh)
    const seconds = useFilters((s) => s.intervalSeconds)
    return auto ? seconds * 1000 : false
}
