// Overview — the decluttered landing page: KPI strip, exactly two trend charts,
// top-5 risky pipelines, recent open violations, and a disabled AI-insights slot.
// Everything reads the shared global filters, so the whole page re-scopes at once.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
    Activity,
    AlertTriangle,
    ArrowUpRight,
    CheckCircle2,
    ClipboardList,
    Sparkles,
    TrendingUp,
} from 'lucide-react'
import { Card, EmptyState, ErrorState, Kpi, SkeletonRows } from '../components/ui'
import {
    CriticalityBadge,
    SeverityBadge,
    ViolationStatusBadge,
} from '../components/ui'
import { Legend, StatusStackedBar, TrendLine } from '../components/charts'
import { useKpis, usePipelines, useTrends, useViolations } from '../lib/hooks'
import { useFilters } from '../lib/store'
import { CRITICALITY_WEIGHT, VIOLATION_LABELS } from '../lib/constants'
import { fmtDateTime, fmtNumber, fmtPct } from '../lib/format'
import type { PipelineHealth } from '../lib/types'

export default function Overview() {
    const { windowDays, category, criticality } = useFilters()

    const kpis = useKpis(windowDays)
    const trends = useTrends({ window_days: windowDays, category, criticality })
    const pipelines = usePipelines({ category, criticality, window_days: windowDays })
    // Note: /violations filters by category (not criticality) — keep this query
    // scoped to what the endpoint actually supports.
    const recentViolations = useViolations({
        category,
        status: 'open',
        limit: 5,
    })

    // Rank pipelines by (open violations, then criticality, then SLA breaches).
    const top5 = useMemo(() => {
        const items = pipelines.data?.items ?? []
        return [...items]
            .sort((a, b) => riskScore(b) - riskScore(a))
            .filter((p) => riskScore(p) > 0)
            .slice(0, 5)
    }, [pipelines.data])

    const series = trends.data?.series ?? []

    // Zoom the SLA axis to just below the observed minimum (floored to a tidy
    // step, never under 0) so a 90–100% band fills the chart instead of hugging
    // the top edge. Falls back to 0 when there's no data.
    const slaFloor = useMemo(() => {
        const vals = series
            .map((p) => p.sla_compliance)
            .filter((v): v is number => v != null)
        if (!vals.length) return 0
        const min = Math.min(...vals)
        return Math.max(0, Math.floor((min - 5) / 5) * 5)
    }, [series])

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div>
                    <h1 className="page-title">Overview</h1>
                    <p className="page-sub">Fleet health across the last {windowDays}-day window.</p>
                </div>
            </div>

            {/* KPI strip */}
            {kpis.isError ? (
                <Card>
                    <ErrorState error={kpis.error} />
                </Card>
            ) : (
                <div className="kpi-strip">
                    <Kpi
                        label="Total Pipelines"
                        icon={<Activity size={16} />}
                        tone="accent"
                        loading={kpis.isPending}
                        value={fmtNumber(kpis.data?.total_pipelines)}
                        foot={
                            kpis.data
                                ? `${kpis.data.healthy_pipelines} healthy · ${kpis.data.pipelines_with_issues} with issues`
                                : ''
                        }
                    />
                    <Kpi
                        label="Health score"
                        icon={<CheckCircle2 size={16} />}
                        tone="success"
                        loading={kpis.isPending}
                        value={kpis.data ? String(kpis.data.health_score) : '—'}
                        unit={kpis.data ? '/100' : ''}
                    />
                    <Kpi
                        label="SLA compliance"
                        icon={<TrendingUp size={16} />}
                        tone="accent"
                        loading={kpis.isPending}
                        value={fmtPct(kpis.data?.sla_compliance)}
                    />
                    <Kpi
                        label="Failure rate"
                        icon={<AlertTriangle size={16} />}
                        tone="danger"
                        loading={kpis.isPending}
                        value={fmtPct(kpis.data?.failure_rate)}
                        foot={kpis.data ? `${fmtNumber(kpis.data.total_runs)} runs` : ''}
                    />
                    <Kpi
                        label="Open violations"
                        icon={<ClipboardList size={16} />}
                        tone="warning"
                        loading={kpis.isPending}
                        value={fmtNumber(kpis.data?.open_violations)}
                        foot={severityBreakdown(kpis.data?.open_violations_by_severity)}
                    />
                </div>
            )}

            {/* Two charts, side by side */}
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Card
                    title="SLA compliance trend"
                    hint="daily %"
                    action={<Legend items={[{ label: 'SLA %', color: '#4f5bd5' }]} />}
                >
                    {trends.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : trends.isError ? (
                        <ErrorState error={trends.error} />
                    ) : (
                        <TrendLine
                            data={series}
                            dataKey="sla_compliance"
                            name="SLA %"
                            unit="%"
                            color="#4f5bd5"
                            domainMin={slaFloor}
                            domainMax={100}
                            area
                        />
                    )}
                </Card>

                <Card
                    title="Run status over time"
                    hint="success vs failed"
                    action={
                        <Legend
                            items={[
                                { label: 'Success', color: '#16a34a' },
                                { label: 'Failed', color: '#dc2626' },
                            ]}
                        />
                    }
                >
                    {trends.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : trends.isError ? (
                        <ErrorState error={trends.error} />
                    ) : (
                        <StatusStackedBar data={series} />
                    )}
                </Card>
            </div>

            {/* Top-5 risky + recent violations */}
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Card
                    title="Top 5 risky pipelines"
                    action={
                        <Link to="/pipelines" className="link row gap-1 center">
                            View all <ArrowUpRight size={14} />
                        </Link>
                    }
                >
                    {pipelines.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : pipelines.isError ? (
                        <ErrorState error={pipelines.error} />
                    ) : top5.length === 0 ? (
                        <EmptyState
                            title="All clear"
                            message="No open violations or SLA breaches in this window."
                            icon={<CheckCircle2 size={26} />}
                        />
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table className="data">
                                <thead>
                                    <tr>
                                        <th>Pipeline</th>
                                        <th>Category</th>
                                        <th>Criticality</th>
                                        <th className="num">Open</th>
                                        <th className="num">SLA breaches</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {top5.map((p) => (
                                        <tr key={p.pipeline_name}>
                                            <td>
                                                <Link
                                                    to={`/pipelines/${encodeURIComponent(p.pipeline_name)}`}
                                                    className="link"
                                                >
                                                    {p.pipeline_name}
                                                </Link>
                                            </td>
                                            <td className="muted">{p.pipeline_category}</td>
                                            <td>
                                                <CriticalityBadge level={p.criticality} />
                                            </td>
                                            <td className="num strong">{p.open_violations}</td>
                                            <td className="num">{p.sla_breaches}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>

                <Card
                    title="Recent open violations"
                    action={
                        <Link to="/violations" className="link row gap-1 center">
                            View all <ArrowUpRight size={14} />
                        </Link>
                    }
                >
                    {recentViolations.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : recentViolations.isError ? (
                        <ErrorState error={recentViolations.error} />
                    ) : (recentViolations.data?.items.length ?? 0) === 0 ? (
                        <EmptyState
                            title="No open violations"
                            message="Nothing needs review right now."
                            icon={<CheckCircle2 size={26} />}
                        />
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table className="data">
                                <thead>
                                    <tr>
                                        <th>Pipeline</th>
                                        <th>Type</th>
                                        <th>Severity</th>
                                        <th>Detected</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recentViolations.data!.items.map((v) => (
                                        <tr key={v.id}>
                                            <td>
                                                <Link
                                                    to={`/pipelines/${encodeURIComponent(v.pipeline_name)}`}
                                                    className="link"
                                                >
                                                    {v.pipeline_name}
                                                </Link>
                                            </td>
                                            <td>{VIOLATION_LABELS[v.violation_type] ?? v.violation_type}</td>
                                            <td>
                                                <SeverityBadge severity={v.severity} />
                                            </td>
                                            <td className="nowrap muted">{fmtDateTime(v.detected_at)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>

            {/* AI insights — reserved, visibly on hold */}
            <Card>
                <div className="banner">
                    <Sparkles size={18} />
                    <div className="grow">
                        <div className="banner-title">AI insights</div>
                        <div>
                            Automated root-cause summaries and remediation hints will appear here.
                            On hold until an LLM key is configured.
                        </div>
                    </div>
                    <span className="chip">On hold</span>
                </div>
            </Card>

            {/* Status pill legend for recent violations column */}
            <div className="row gap-3 wrap small faint" style={{ paddingLeft: 2 }}>
                <span className="row gap-1 center">
                    <ViolationStatusBadge status="open" /> awaiting review
                </span>
            </div>
        </div>
    )
}

function riskScore(p: PipelineHealth): number {
    return (
        p.open_violations * 100 +
        CRITICALITY_WEIGHT[p.criticality] * 10 +
        p.sla_breaches
    )
}

function severityBreakdown(
    by: Partial<Record<string, number>> | undefined,
): string {
    if (!by) return ''
    const parts: string[] = []
    if (by.CRITICAL) parts.push(`${by.CRITICAL} critical`)
    if (by.HIGH) parts.push(`${by.HIGH} high`)
    return parts.join(' · ')
}
