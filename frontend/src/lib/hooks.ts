// TanStack Query hooks. Each read hook subscribes to the shared poll interval
// from the Zustand store, so flipping auto-refresh (or its cadence) in the top
// bar transparently re-scopes background polling for every query on the page.

import {
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query'
import { api } from './api'
import type {
    AuditFilters,
    RunFilters,
    ViolationFilters,
    ViolationStatsFilters,
    ViolationTrendFilters,
} from './api'
import { usePollInterval } from './store'
import type { ReviewAction } from './types'

// ---- KPIs ----
export function useKpis(windowDays: number) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['kpis', windowDays],
        queryFn: () => api.kpis(windowDays),
        refetchInterval,
    })
}

// ---- Trends ----
export function useTrends(filters: {
    window_days?: number
    category?: string
    criticality?: string
    pipeline?: string
}) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['trends', filters],
        queryFn: () => api.trends(filters),
        refetchInterval,
    })
}

// ---- Pipelines list ----
export function usePipelines(filters: {
    category?: string
    criticality?: string
    window_days?: number
}) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['pipelines', filters],
        queryFn: () => api.pipelines(filters),
        refetchInterval,
    })
}

// ---- Pipeline detail ----
export function usePipeline(name: string | undefined, runsLimit = 20) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['pipeline', name, runsLimit],
        queryFn: () => api.pipeline(name as string, runsLimit),
        enabled: !!name,
        refetchInterval,
    })
}

// ---- Runs (paginated) ----
export function useRuns(filters: RunFilters) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['runs', filters],
        queryFn: () => api.runs(filters),
        refetchInterval,
        // Keep the previous page visible while the next one loads (no flicker).
        placeholderData: (prev) => prev,
    })
}

// ---- Recent runs (live tail) ----
export function useRecentRuns(limit = 15) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['recent-runs', limit],
        queryFn: () => api.recentRuns(limit),
        refetchInterval,
    })
}

// ---- Violations ----
export function useViolations(filters: ViolationFilters) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['violations', filters],
        queryFn: () => api.violations(filters),
        refetchInterval,
        placeholderData: (prev) => prev,
    })
}

// ---- Violation aggregates (KPIs + by-type pie) ----
export function useViolationStats(filters: ViolationStatsFilters) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['violation-stats', filters],
        queryFn: () => api.violationStats(filters),
        refetchInterval,
        placeholderData: (prev) => prev,
    })
}

// ---- Violation detection trend ----
export function useViolationTrends(filters: ViolationTrendFilters) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['violation-trends', filters],
        queryFn: () => api.violationTrends(filters),
        refetchInterval,
        placeholderData: (prev) => prev,
    })
}

// ---- Audit ----
export function useAudit(filters: AuditFilters) {
    const refetchInterval = usePollInterval()
    return useQuery({
        queryKey: ['audit', filters],
        queryFn: () => api.audit(filters),
        refetchInterval,
        placeholderData: (prev) => prev,
    })
}

// ---- Report stub ----
export function useReport(name: string | undefined) {
    return useQuery({
        queryKey: ['report', name],
        queryFn: () => api.report(name as string),
        enabled: !!name,
    })
}

// ---- Review mutation ----
// On success we invalidate everything a review touches: the violations list,
// the KPI counts, the pipeline rollups, and the audit trail. This is what makes
// a single review action ripple through the whole dashboard without a reload.
export function useReviewMutation() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (vars: {
            id: number
            action: ReviewAction
            reviewedBy: string
            note?: string
        }) => api.review(vars.id, vars.action, vars.reviewedBy, vars.note),
        onSettled: () => {
            invalidateReviewTouched(qc)
        },
    })
}

// ---- Batch review mutation ----
// Applies the same action to many violations at once (the Violations page's
// "process selected" bar). Runs sequentially so the backend writes one audit
// row per violation, then invalidates everything a review touches — once.
export function useBatchReviewMutation() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: async (vars: {
            ids: number[]
            action: ReviewAction
            reviewedBy: string
            note?: string
        }) => {
            const results = []
            for (const id of vars.ids) {
                results.push(await api.review(id, vars.action, vars.reviewedBy, vars.note))
            }
            return results
        },
        onSettled: () => {
            invalidateReviewTouched(qc)
        },
    })
}

// Everything a review action ripples through: the violations list + its
// aggregates, the KPI counts, the pipeline rollups, and the audit trail.
function invalidateReviewTouched(qc: ReturnType<typeof useQueryClient>) {
    qc.invalidateQueries({ queryKey: ['violations'] })
    qc.invalidateQueries({ queryKey: ['violation-stats'] })
    qc.invalidateQueries({ queryKey: ['violation-trends'] })
    qc.invalidateQueries({ queryKey: ['kpis'] })
    qc.invalidateQueries({ queryKey: ['pipelines'] })
    qc.invalidateQueries({ queryKey: ['pipeline'] })
    qc.invalidateQueries({ queryKey: ['audit'] })
}
