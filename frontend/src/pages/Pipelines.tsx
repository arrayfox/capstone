// Pipelines — sortable/filterable list of all pipelines with health at a glance.
// Each row links to its own full detail page at /pipelines/:name.

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, GitBranch } from 'lucide-react'
import {
    Card,
    CriticalityBadge,
    EmptyState,
    ErrorState,
    FreshnessBadge,
    SkeletonRows,
} from '../components/ui'
import { usePipelines } from '../lib/hooks'
import { useFilters } from '../lib/store'
import { fmtHoursAgo } from '../lib/format'
import type { PipelineHealth } from '../lib/types'

type SortKey =
    | 'pipeline_name'
    | 'pipeline_category'
    | 'criticality'
    | 'hours_since_success'
    | 'sla_breaches'
    | 'open_violations'

export default function Pipelines() {
    const navigate = useNavigate()
    const { category, criticality, windowDays } = useFilters()
    const { data, isPending, isError, error } = usePipelines({
        category,
        criticality,
        window_days: windowDays,
    })

    const [sortKey, setSortKey] = useState<SortKey>('open_violations')
    const [asc, setAsc] = useState(false)

    const rows = useMemo(() => {
        const items = data?.items ?? []
        const sorted = [...items].sort((a, b) => cmp(a, b, sortKey))
        return asc ? sorted : sorted.reverse()
    }, [data, sortKey, asc])

    function toggleSort(key: SortKey) {
        if (key === sortKey) setAsc((v) => !v)
        else {
            setSortKey(key)
            setAsc(false)
        }
    }

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div>
                    <h1 className="page-title">Pipelines</h1>
                    <p className="page-sub">
                        {data ? `${data.count} pipelines` : 'Fleet'} · health over the last{' '}
                        {windowDays}-day window. Click a row to see more details.
                    </p>
                </div>
            </div>

            <Card>
                {isPending ? (
                    <SkeletonRows rows={7} />
                ) : isError ? (
                    <ErrorState error={error} />
                ) : rows.length === 0 ? (
                    <EmptyState
                        title="No pipelines"
                        message="Nothing matches these filters."
                        icon={<GitBranch size={26} />}
                    />
                ) : (
                    <div className="table-wrap" style={{ border: 'none' }}>
                        <table className="data">
                            <thead>
                                <tr>
                                    <SortableTh
                                        label="Pipeline"
                                        active={sortKey === 'pipeline_name'}
                                        asc={asc}
                                        onClick={() => toggleSort('pipeline_name')}
                                    />
                                    <SortableTh
                                        label="Category"
                                        active={sortKey === 'pipeline_category'}
                                        asc={asc}
                                        onClick={() => toggleSort('pipeline_category')}
                                    />
                                    <SortableTh
                                        label="Criticality"
                                        active={sortKey === 'criticality'}
                                        asc={asc}
                                        onClick={() => toggleSort('criticality')}
                                    />
                                    <th>Status</th>
                                    <SortableTh
                                        label="Freshness"
                                        active={sortKey === 'hours_since_success'}
                                        asc={asc}
                                        onClick={() => toggleSort('hours_since_success')}
                                    />
                                    <SortableTh
                                        label="SLA breaches"
                                        align="num"
                                        active={sortKey === 'sla_breaches'}
                                        asc={asc}
                                        onClick={() => toggleSort('sla_breaches')}
                                    />
                                    <SortableTh
                                        label="Open violations"
                                        align="num"
                                        active={sortKey === 'open_violations'}
                                        asc={asc}
                                        onClick={() => toggleSort('open_violations')}
                                    />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((p) => (
                                    <tr
                                        key={p.pipeline_name}
                                        className="clickable"
                                        title="Click to see more details"
                                        onClick={() =>
                                            navigate(`/pipelines/${encodeURIComponent(p.pipeline_name)}`)
                                        }
                                    >
                                        <td>
                                            <Link
                                                to={`/pipelines/${encodeURIComponent(p.pipeline_name)}`}
                                                className="link strong"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {p.pipeline_name}
                                            </Link>
                                        </td>
                                        <td>{p.pipeline_category}</td>
                                        <td>
                                            <CriticalityBadge level={p.criticality} />
                                        </td>
                                        <td>
                                            <FreshnessBadge fresh={p.is_fresh} />
                                        </td>
                                        <td className="nowrap muted">
                                            {fmtHoursAgo(p.hours_since_success)}
                                        </td>
                                        <td className="num">{p.sla_breaches}</td>
                                        <td className="num strong">
                                            {p.open_violations > 0 ? (
                                                <span style={{ color: 'var(--failed)' }}>
                                                    {p.open_violations}
                                                </span>
                                            ) : (
                                                <span className="faint">0</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </div>
    )
}

function cmp(a: PipelineHealth, b: PipelineHealth, key: SortKey): number {
    const av = a[key]
    const bv = b[key]
    // Nulls (e.g. never-succeeded freshness) sort as the largest value.
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return av - bv
    return String(av).localeCompare(String(bv))
}

function SortableTh({
    label,
    active,
    asc,
    onClick,
    align,
}: {
    label: string
    active: boolean
    asc: boolean
    onClick: () => void
    align?: 'num'
}) {
    return (
        <th
            className="sortable"
            onClick={onClick}
            style={align === 'num' ? { textAlign: 'right' } : undefined}
        >
            <span className="row gap-1 center" style={align === 'num' ? { justifyContent: 'flex-end' } : undefined}>
                {label}
                {active &&
                    (asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </span>
        </th>
    )
}
