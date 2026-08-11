// Thin typed fetch client for the FastAPI backend. Every call goes through
// `request()` so error handling + JSON parsing live in one place.

import type {
    AuditResponse,
    Kpis,
    PipelineDetail,
    PipelinesResponse,
    RecentRunsResponse,
    ReportStub,
    ReviewAction,
    ReviewResponse,
    RunsResponse,
    TrendsResponse,
    ViolationsResponse,
    ViolationStats,
    ViolationTrendsResponse,
} from './types'


export const API_BASE =
    import.meta.env.VITE_API_BASE?.replace(/\/$/, '') || 'http://localhost:8000'

export class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
    }
}

/** Drop null/undefined/empty and "all" filter values, then build a query string. */
function qs(params: Record<string, string | number | undefined | null>): string {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '' || v === 'all') continue
        sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? `?${s}` : ''
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
        res = await fetch(`${API_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...init,
        })
    } catch {
        // Network-level failure (server down, CORS, offline).
        throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is it running?`)
    }

    if (!res.ok) {
        let detail = res.statusText
        try {
            const body = await res.json()
            if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
        } catch {
            /* non-JSON error body — keep statusText */
        }
        throw new ApiError(res.status, detail)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
}

// ---- Filter param shapes shared across pages ----
export interface CommonFilters {
    window_days?: number
    category?: string
    criticality?: string
    pipeline?: string
}

export interface RunFilters {
    pipeline?: string
    category?: string
    status?: string
    date_from?: string
    date_to?: string
    limit?: number
    offset?: number
}

export interface ViolationFilters {
    pipeline?: string
    category?: string
    type?: string
    severity?: string
    status?: string
    date_from?: string
    date_to?: string
    limit?: number
    offset?: number
}

export interface AuditFilters {
    actor?: string
    action?: string
    entity?: string
    date_from?: string
    date_to?: string
    limit?: number
}

// Aggregate params for the Violations page analytics.
export interface ViolationStatsFilters {
    pipeline?: string
    category?: string
    status?: string
    window_days?: number
    date_from?: string
    date_to?: string
}

export interface ViolationTrendFilters {
    window_days?: number
    pipeline?: string
    category?: string
    type?: string
    severity?: string
    status?: string
}

// ---- Endpoint wrappers ----
export const api = {
    health: () => request<{ status: string; service: string }>('/health'),

    kpis: (windowDays: number) =>
        request<Kpis>(`/kpis${qs({ window_days: windowDays })}`),

    trends: (f: CommonFilters) =>
        request<TrendsResponse>(`/trends${qs({ ...f })}`),

    pipelines: (f: { category?: string; criticality?: string; window_days?: number }) =>
        request<PipelinesResponse>(`/pipelines${qs({ ...f })}`),

    pipeline: (name: string, runsLimit = 20) =>
        request<PipelineDetail>(
            `/pipelines/${encodeURIComponent(name)}${qs({ runs_limit: runsLimit })}`,
        ),

    runs: (f: RunFilters) => request<RunsResponse>(`/runs${qs({ ...f })}`),

    recentRuns: (limit = 20) =>
        request<RecentRunsResponse>(`/runs/recent${qs({ limit })}`),

    violations: (f: ViolationFilters) =>
        request<ViolationsResponse>(`/violations${qs({ ...f })}`),

    violationStats: (f: ViolationStatsFilters) =>
        request<ViolationStats>(`/violations/stats${qs({ ...f })}`),

    violationTrends: (f: ViolationTrendFilters) =>
        request<ViolationTrendsResponse>(`/violations/trends${qs({ ...f })}`),

    review: (id: number, action: ReviewAction, reviewed_by: string, note?: string) =>
        request<ReviewResponse>(`/violations/${id}/review`, {
            method: 'POST',
            body: JSON.stringify({ action, reviewed_by, note: note || null }),
        }),

    audit: (f: AuditFilters) => request<AuditResponse>(`/audit${qs({ ...f })}`),

    report: (name: string) =>
        request<ReportStub>(`/report/${encodeURIComponent(name)}`),
}
