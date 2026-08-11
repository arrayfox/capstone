// Types mirror the backend REST surface (see backend/main.py + kpis.py).
// Kept hand-written and narrow so the UI is type-safe against the real payloads.

export type RunStatus = 'SUCCESS' | 'FAILED' | 'RUNNING'
export type Criticality = 'HIGH' | 'MEDIUM' | 'LOW'
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type ViolationStatus = 'open' | 'reviewed' | 'dismissed' | 'escalated'
export type ReviewAction = 'approve' | 'dismiss' | 'escalate'

export type ViolationType =
    | 'SLA_BREACH'
    | 'DELAYED_START'
    | 'VOLUME_ANOMALY'
    | 'FAILURE'
    | 'RECURRING_FAILURE'
    | 'MISSING_LOAD'
    | 'FRESHNESS'

// ---- KPIs (GET /kpis) ----
export interface Kpis {
    window_days: number
    data_now: string
    total_runs: number
    success_rate: number
    failure_rate: number
    sla_compliance: number
    health_score: number
    total_pipelines: number
    healthy_pipelines: number
    pipelines_with_issues: number
    open_violations: number
    open_violations_by_severity: Partial<Record<Severity, number>>
}

// ---- Trends (GET /trends) ----
export interface TrendPoint {
    date: string
    total: number
    successes: number
    failures: number
    sla_compliance: number | null
    avg_duration: number | null
}

export interface TrendsResponse {
    window_days: number
    bucket: string
    series: TrendPoint[]
}

// ---- Pipeline health rollup (GET /pipelines) ----
export interface PipelineHealth {
    pipeline_name: string
    pipeline_category: string
    criticality: Criticality
    runs: number
    successes: number
    failures: number
    sla_breaches: number
    last_success: string | null
    hours_since_success: number | null
    is_fresh: boolean
    open_violations: number
    status: 'healthy' | 'issues'
}

export interface PipelinesResponse {
    count: number
    items: PipelineHealth[]
}

// ---- Pipeline config (GET /pipelines/{name}.config) ----
export interface PipelineConfig {
    pipeline_name: string
    pipeline_category: string
    criticality: Criticality
    owner_team: string
    schedule_interval_minutes: number
    sla_minutes: number
    freshness_threshold_hours: number
    description: string
}

// ---- Runs (GET /runs, /runs/recent, and pipeline detail recent_runs) ----
export interface Run {
    run_id: string
    pipeline_name: string
    pipeline_category?: string
    scheduled_time: string
    actual_start_time: string | null
    end_time: string | null
    status: RunStatus
    rows_processed: number | null
    error_code: string | null
    error_message?: string | null
    duration_minutes: number | null
}

export interface RunsResponse {
    total: number
    limit: number
    offset: number
    items: Run[]
}

export interface RecentRunsResponse {
    count: number
    items: Run[]
}

// ---- Violations (GET /violations) ----
export interface Violation {
    id: number
    pipeline_name: string
    pipeline_category: string
    criticality: Criticality
    run_id: string | null
    violation_type: ViolationType
    severity: Severity
    detected_at: string
    details: string | null
    status: ViolationStatus
    reviewed_by: string | null
    reviewed_at: string | null
    note: string | null
}

export interface ViolationsResponse {
    total: number
    limit: number
    offset: number
    items: Violation[]
}

// ---- Violation aggregates (GET /violations/stats) ----
export interface ViolationStats {
    total: number
    by_type: Partial<Record<ViolationType, number>>
    by_severity: Partial<Record<Severity, number>>
}

// ---- Violation detection trend (GET /violations/trends) ----
export interface ViolationTrendPoint {
    date: string
    count: number
}

export interface ViolationTrendsResponse {
    window_days: number
    bucket: string
    series: ViolationTrendPoint[]
}


// Open violations returned inside pipeline detail have a narrower shape.
export interface PipelineOpenViolation {
    id: number
    run_id: string | null
    violation_type: ViolationType
    severity: Severity
    detected_at: string
    details: string | null
    status: ViolationStatus
}

export interface PipelineDetail {
    config: PipelineConfig
    recent_runs: Run[]
    open_violations: PipelineOpenViolation[]
}

// ---- Audit (GET /audit) ----
export interface AuditEntry {
    id: number
    timestamp: string
    actor: string
    action: string
    entity_type: string
    entity_id: string | null
    details: string | null
}

export interface AuditResponse {
    count: number
    items: AuditEntry[]
}

export interface ReviewResponse {
    id: number
    status: ViolationStatus
    reviewed_by: string
}

// ---- Report stub (GET /report/{name}) ----
export interface ReportStub {
    pipeline_name: string
    generated: boolean
    reason: string
    open_violations: number
    placeholder: string
}
