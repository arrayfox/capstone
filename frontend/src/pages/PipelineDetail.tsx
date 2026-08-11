// Pipeline detail — its own full page. KPIs (derived from recent runs + config),
// an error-distribution donut, failure & avg-duration trends, recent executions,
// recent open violations, the config block, and a disabled LLM report slot.

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle2,
    Droplet,
    ShieldAlert,
    Sparkles,
    TrendingUp,
} from 'lucide-react'
import {
    Card,
    CriticalityBadge,
    EmptyState,
    ErrorState,
    FreshnessBadge,
    SeverityBadge,
    SkeletonRows,
    StatusBadge,
} from '../components/ui'
import { ErrorPie, Legend, TrendLine } from '../components/charts'
import { usePipeline, useTrends } from '../lib/hooks'
import { useFilters } from '../lib/store'
import { VIOLATION_LABELS } from '../lib/constants'
import {
    fmtDateTime,
    fmtDuration,
    fmtHoursAgo,
    fmtNumber,
    fmtPct,
    humanize,
} from '../lib/format'
import type { PipelineDetail as Detail, Run } from '../lib/types'

export default function PipelineDetail() {
    const { name } = useParams<{ name: string }>()
    const { windowDays } = useFilters()

    const detail = usePipeline(name, 25)
    const trends = useTrends({ window_days: windowDays, pipeline: name })

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div className="col gap-1">
                    <Link to="/pipelines" className="link row gap-1 center small">
                        <ArrowLeft size={14} /> Pipelines
                    </Link>
                    <h1 className="page-title">{name}</h1>
                </div>
            </div>

            {detail.isPending ? (
                <Card>
                    <SkeletonRows rows={6} />
                </Card>
            ) : detail.isError ? (
                <Card>
                    <ErrorState error={detail.error} />
                </Card>
            ) : detail.data ? (
                <Body detail={detail.data} trends={trends} />
            ) : null}
        </div>
    )
}

function Body({
    detail,
    trends,
}: {
    detail: Detail
    trends: ReturnType<typeof useTrends>
}) {
    const { config, recent_runs, open_violations } = detail
    const summary = useMemo(() => summarize(recent_runs, config.sla_minutes), [
        recent_runs,
        config.sla_minutes,
    ])

    // Error distribution across recent runs (9 possible codes).
    const errorDist = useMemo(() => {
        const counts = new Map<string, number>()
        for (const r of recent_runs) {
            if (r.error_code) counts.set(r.error_code, (counts.get(r.error_code) ?? 0) + 1)
        }
        return Array.from(counts.entries())
            .map(([code, value]) => ({ name: humanize(code), value }))
            .sort((a, b) => b.value - a.value)
    }, [recent_runs])

    const series = trends.data?.series ?? []

    return (
        <>
            {/* KPI strip */}
            <div className="kpi-strip">
                <Kpi
                    label="Criticality"
                    icon={<AlertTriangle size={16} />}
                    tone="accent"
                    node={<CriticalityBadge level={config.criticality} />}
                />
                <Kpi
                    label="Freshness"
                    icon={<Droplet size={16} />}
                    tone="accent"
                    value={fmtHoursAgo(summary.hoursSinceSuccess)}
                    node={<FreshnessBadge fresh={summary.isFresh(config.freshness_threshold_hours)} />}
                />
                <Kpi
                    label="Success rate"
                    icon={<CheckCircle2 size={16} />}
                    tone="success"
                    value={fmtPct(summary.successRate)}
                    foot={`${summary.total} recent runs`}
                />
                <Kpi
                    label="SLA compliance"
                    icon={<TrendingUp size={16} />}
                    tone="accent"
                    value={fmtPct(summary.slaCompliance)}
                    foot={`SLA ${config.sla_minutes}m`}
                />
                <Kpi
                    label="Open violations"
                    icon={<ShieldAlert size={16} />}
                    tone={open_violations.length > 0 ? 'warning' : 'neutral'}
                    value={String(open_violations.length)}
                    foot={config.owner_team}
                />
            </div>

            {/* Error distribution + failure trend */}
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Card title="Error distribution" hint="recent runs">
                    <ErrorPie data={errorDist} />
                </Card>
                <Card
                    title="Failure trend"
                    hint="daily"
                    action={<Legend items={[{ label: 'Failures', color: '#dc2626' }]} />}
                >
                    {trends.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : trends.isError ? (
                        <ErrorState error={trends.error} />
                    ) : (
                        <TrendLine data={series} dataKey="failures" name="Failures" color="#dc2626" />
                    )}
                </Card>
            </div>

            {/* Avg duration trend (moved here from Overview) */}
            <Card
                title="Average duration trend"
                hint="minutes/run"
                action={<Legend items={[{ label: 'Avg duration', color: '#4f5bd5' }]} />}
            >
                {trends.isPending ? (
                    <SkeletonRows rows={4} />
                ) : trends.isError ? (
                    <ErrorState error={trends.error} />
                ) : (
                    <TrendLine
                        data={series}
                        dataKey="avg_duration"
                        name="Avg duration"
                        unit="m"
                        color="#4f5bd5"
                        area
                    />
                )}
            </Card>

            {/* Recent executions + open violations */}
            <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
                <Card
                    title="Recent executions"
                    action={
                        <Link
                            to={`/executions?pipeline=${encodeURIComponent(config.pipeline_name)}`}
                            className="link small"
                        >
                            Open run log →
                        </Link>
                    }
                >
                    {recent_runs.length === 0 ? (
                        <EmptyState message="No runs recorded." />
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table className="data">
                                <thead>
                                    <tr>
                                        <th>Started</th>
                                        <th>Status</th>
                                        <th className="num">Rows</th>
                                        <th className="num">Duration</th>
                                        <th>Error</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recent_runs.slice(0, 8).map((r) => (
                                        <tr key={r.run_id}>
                                            <td className="nowrap muted">
                                                {fmtDateTime(r.actual_start_time ?? r.scheduled_time)}
                                            </td>
                                            <td>
                                                <StatusBadge status={r.status} />
                                            </td>
                                            <td className="num">
                                                {r.rows_processed != null ? fmtNumber(r.rows_processed) : '—'}
                                            </td>
                                            <td className="num">{fmtDuration(r.duration_minutes)}</td>
                                            <td className="truncate">
                                                {r.error_code ? (
                                                    <span className="chip" style={{ color: 'var(--failed)' }}>
                                                        {r.error_code}
                                                    </span>
                                                ) : (
                                                    <span className="faint">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>

                <Card
                    title="Open violations"
                    action={
                        <Link
                            to={`/violations?pipeline=${encodeURIComponent(config.pipeline_name)}`}
                            className="link small"
                        >
                            All violations →
                        </Link>
                    }
                >
                    {open_violations.length === 0 ? (
                        <EmptyState message="No open violations." />
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table className="data">
                                <thead>
                                    <tr>
                                        <th>Type</th>
                                        <th>Severity</th>
                                        <th>Detected</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {open_violations.slice(0, 8).map((v) => (
                                        <tr key={v.id}>
                                            <td>
                                                {VIOLATION_LABELS[v.violation_type] ?? v.violation_type}
                                            </td>
                                            <td>
                                                <SeverityBadge severity={v.severity} />
                                            </td>
                                            <td className="nowrap muted">
                                                {fmtDateTime(v.detected_at)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>

            {/* Config + LLM slot */}
            <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
                <Card title="Pipeline information">
                    {config.description && (
                        <p className="muted" style={{ marginTop: 0, marginBottom: 'var(--sp-4)' }}>
                            {config.description}
                        </p>
                    )}
                    <div className="detail-grid">
                        <Detail k="Category" v={config.pipeline_category} />
                        <Detail k="Owner team" v={config.owner_team} />
                        <Detail k="Schedule" v={`every ${config.schedule_interval_minutes} min`} />
                        <Detail k="SLA" v={`${config.sla_minutes} min`} />
                        <Detail k="Freshness threshold" v={`${config.freshness_threshold_hours} h`} />
                        <Detail k="Last success" v={summary.lastSuccess ? fmtDateTime(summary.lastSuccess) : 'Never'} />
                    </div>
                </Card>

                <Card title="AI report">
                    <div className="banner" style={{ height: '100%' }}>
                        <Sparkles size={18} />
                        <div className="grow">
                            <div className="banner-title">On hold</div>
                            <div>
                                An AI-generated root-cause report for this pipeline will appear here
                                once an LLM key is configured.
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        </>
    )
}

// Derive a small health summary from the recent-runs window. We treat the newest
// run's timestamp as the data clock (the dataset is simulated), so freshness is
// measured relative to that rather than wall-clock now.
function summarize(runs: Run[], slaMinutes: number) {
    const total = runs.length
    const successes = runs.filter((r) => r.status === 'SUCCESS').length
    const failures = runs.filter((r) => r.status === 'FAILED').length
    const successRate = total ? (successes / total) * 100 : null

    const timed = runs.filter((r) => r.duration_minutes != null)
    const withinSla = timed.filter((r) => (r.duration_minutes as number) <= slaMinutes).length
    const slaCompliance = timed.length ? (withinSla / timed.length) * 100 : null

    const times = runs
        .map((r) => r.end_time ?? r.actual_start_time ?? r.scheduled_time)
        .filter(Boolean)
        .map((t) => new Date(t as string).getTime())
    const dataClock = times.length ? Math.max(...times) : Date.now()

    const lastSuccessRun = runs
        .filter((r) => r.status === 'SUCCESS' && (r.end_time ?? r.actual_start_time))
        .sort(
            (a, b) =>
                new Date(b.end_time ?? b.actual_start_time!).getTime() -
                new Date(a.end_time ?? a.actual_start_time!).getTime(),
        )[0]

    const lastSuccess = lastSuccessRun?.end_time ?? lastSuccessRun?.actual_start_time ?? null
    const hoursSinceSuccess = lastSuccess
        ? (dataClock - new Date(lastSuccess).getTime()) / 3_600_000
        : null

    return {
        total,
        successes,
        failures,
        successRate,
        slaCompliance,
        lastSuccess,
        hoursSinceSuccess,
        isFresh: (thresholdHours: number) =>
            hoursSinceSuccess != null && hoursSinceSuccess <= thresholdHours,
    }
}

// Local KPI variant that also supports a `node` (a badge shown under the value),
// which the shared ui Kpi doesn't. Icon + tone mirror the shared styling so the
// detail page reads consistently with the rest of the app.
function Kpi({
    label,
    value,
    foot,
    node,
    icon,
    tone = 'accent',
}: {
    label: string
    value?: string
    foot?: string
    node?: ReactNode
    icon?: ReactNode
    tone?: 'accent' | 'success' | 'danger' | 'warning' | 'neutral'
}) {
    return (
        <div className="kpi">
            <div className="kpi-label">
                {icon && <span className={`kpi-icon tone-${tone}`}>{icon}</span>}
                {label}
            </div>
            {value != null ? (
                <div className="kpi-value tnum">{value}</div>
            ) : (
                <div style={{ marginTop: 4 }}>{node}</div>
            )}
            {value != null && node && <div style={{ marginTop: 4 }}>{node}</div>}
            {foot && <div className="kpi-foot">{foot}</div>}
        </div>
    )
}

function Detail({ k, v }: { k: string; v: string }) {
    return (
        <div className="detail-item">
            <div className="k">{k}</div>
            <div className="v">{v}</div>
        </div>
    )
}
