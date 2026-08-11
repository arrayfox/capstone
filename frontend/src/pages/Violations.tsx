// Violations — the governance workspace. Filterable table with restrained
// severity badges and inline review actions (approve / dismiss / escalate),
// now surfaced as compact icon buttons with hover labels. Above the table sit
// six at-a-glance KPIs and two analytics charts (violations by type + a daily
// detection trend). Rows can be selected and actioned in a single batch.
//
// A review posts to the backend (which also writes the audit trail); rows update
// in place via query invalidation — no page reload. Deep-linkable via
// `/violations?pipeline=<name>&type=<TYPE>` (used by the pipeline detail page).

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
    ArrowUpFromLine,
    BarChart3,
    Check,
    ChevronRight,
    Clock,
    Droplet,
    Package,
    Repeat,
    ShieldAlert,
    X,
} from 'lucide-react'
import {
    Card,
    EmptyState,
    ErrorState,
    Kpi,
    SeverityBadge,
    Select,
    SkeletonRows,
    Spinner,
    ViolationStatusBadge,
} from '../components/ui'
import { CountTrend, ErrorPie } from '../components/charts'
import {
    useBatchReviewMutation,
    usePipelines,
    useReviewMutation,
    useViolations,
    useViolationStats,
    useViolationTrends,
} from '../lib/hooks'
import { useFilters } from '../lib/store'
import {
    REVIEWER,
    SEVERITIES,
    VIOLATION_LABELS,
    VIOLATION_TYPES,
} from '../lib/constants'
import { fmtDateTime, fmtNumber } from '../lib/format'
import type { ReviewAction, Violation, ViolationStatus } from '../lib/types'

const PAGE_SIZE = 25

const STATUS_OPTIONS: { value: ViolationStatus; label: string }[] = [
    { value: 'open', label: 'Open' },
    { value: 'reviewed', label: 'Reviewed' },
    { value: 'dismissed', label: 'Dismissed' },
    { value: 'escalated', label: 'Escalated' },
]

export default function Violations() {
    const { category, windowDays } = useFilters()
    const [searchParams, setSearchParams] = useSearchParams()

    // Deep-link seeds (e.g. from a pipeline detail page).
    const urlPipeline = searchParams.get('pipeline') ?? 'all'
    const urlType = searchParams.get('type') ?? 'all'

    // Local (page-scoped) filters — the top bar's category + time range feed in.
    const [type, setType] = useState(urlType)
    const [severity, setSeverity] = useState('all')
    const [status, setStatus] = useState<string>('open')
    const [pipeline, setPipeline] = useState(urlPipeline)
    const [page, setPage] = useState(0)

    // Batch selection (violation ids) + a shared note for the batch action.
    const [selected, setSelected] = useState<Set<number>>(new Set())
    const [batchNote, setBatchNote] = useState('')

    // Keep local filters in sync when the URL deep-link changes.
    useEffect(() => {
        setPipeline(urlPipeline)
        setPage(0)
    }, [urlPipeline])
    useEffect(() => {
        setType(urlType)
        setPage(0)
    }, [urlType])

    const filters = {
        category,
        type,
        severity,
        status,
        pipeline: pipeline === 'all' ? undefined : pipeline,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
    }

    const { data, isPending, isError, error, isPlaceholderData } =
        useViolations(filters)

    // KPI + pie aggregates. Type/severity are intentionally omitted so the
    // by-type breakdown stays complete regardless of the table's type filter.
    const stats = useViolationStats({
        category,
        pipeline: pipeline === 'all' ? undefined : pipeline,
        status,
        window_days: windowDays,
    })

    // Detection trend mirrors exactly what the table shows (honors every filter).
    const trends = useViolationTrends({
        window_days: windowDays,
        category,
        pipeline: pipeline === 'all' ? undefined : pipeline,
        type,
        severity,
        status,
    })

    const batch = useBatchReviewMutation()

    const items = data?.items ?? []
    const total = data?.total ?? 0
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const pipelinesList = usePipelines({})
    const pipelineOptions = (pipelinesList.data?.items ?? [])
        .map((p) => p.pipeline_name)
        .sort()

    // Pie slices from the type breakdown (skip zero-count types).
    const pieData = useMemo(() => {
        const by = stats.data?.by_type ?? {}
        return VIOLATION_TYPES.filter((t) => (by[t] ?? 0) > 0).map((t) => ({
            name: VIOLATION_LABELS[t],
            value: by[t] as number,
        }))
    }, [stats.data])

    const trendSeries = trends.data?.series ?? []

    // ---- selection helpers (only OPEN violations are actionable) ----
    const openIds = items.filter((v) => v.status === 'open').map((v) => v.id)
    const allSelected = openIds.length > 0 && openIds.every((id) => selected.has(id))

    function toggleAll() {
        setSelected(allSelected ? new Set() : new Set(openIds))
    }
    function toggleOne(id: number) {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    // Clear any selection when the visible slice changes (avoid acting on rows
    // that are no longer on screen).
    useEffect(() => {
        setSelected(new Set())
    }, [status, type, severity, pipeline, category, page])

    function runBatch(action: ReviewAction) {
        const ids = Array.from(selected)
        if (ids.length === 0) return
        batch.mutate(
            { ids, action, reviewedBy: REVIEWER, note: batchNote.trim() || undefined },
            {
                onSuccess: () => {
                    setSelected(new Set())
                    setBatchNote('')
                },
            },
        )
    }

    function resetToFirstPage<T>(setter: (v: T) => void) {
        return (v: T) => {
            setter(v)
            setPage(0)
        }
    }

    // Filter changes that should also update the shareable URL.
    function onPipelineChange(v: string) {
        setPipeline(v)
        setPage(0)
        const next = new URLSearchParams(searchParams)
        if (v === 'all') next.delete('pipeline')
        else next.set('pipeline', v)
        setSearchParams(next, { replace: true })
    }
    function onTypeChange(v: string) {
        setType(v)
        setPage(0)
        const next = new URLSearchParams(searchParams)
        if (v === 'all') next.delete('type')
        else next.set('type', v)
        setSearchParams(next, { replace: true })
    }

    const by = stats.data?.by_type ?? {}

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div>
                    <h1 className="page-title">Violations</h1>
                    <p className="page-sub">
                        Review and action governance violations. Every action is written to the
                        audit trail.
                    </p>
                </div>
            </div>

            {/* KPI strip (6 metrics) */}
            {stats.isError ? (
                <Card>
                    <ErrorState error={stats.error} />
                </Card>
            ) : (
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        gap: 'var(--sp-4)',
                    }}
                >
                    <Kpi
                        label="Total violations"
                        icon={<ShieldAlert size={16} />}
                        tone="accent"
                        loading={stats.isPending}
                        value={fmtNumber(stats.data?.total)}
                    />
                    <Kpi
                        label="SLA breaches"
                        icon={<Clock size={16} />}
                        tone="danger"
                        loading={stats.isPending}
                        value={fmtNumber(by.SLA_BREACH ?? 0)}
                    />
                    <Kpi
                        label="Missing loads"
                        icon={<Package size={16} />}
                        tone="warning"
                        loading={stats.isPending}
                        value={fmtNumber(by.MISSING_LOAD ?? 0)}
                    />
                    <Kpi
                        label="Freshness violations"
                        icon={<Droplet size={16} />}
                        tone="warning"
                        loading={stats.isPending}
                        value={fmtNumber(by.FRESHNESS ?? 0)}
                    />
                    <Kpi
                        label="Volume anomaly"
                        icon={<BarChart3 size={16} />}
                        tone="neutral"
                        loading={stats.isPending}
                        value={fmtNumber(by.VOLUME_ANOMALY ?? 0)}
                    />
                    <Kpi
                        label="Recurring failures"
                        icon={<Repeat size={16} />}
                        tone="danger"
                        loading={stats.isPending}
                        value={fmtNumber(by.RECURRING_FAILURE ?? 0)}
                    />
                </div>
            )}

            {/* Analytics: by-type pie + daily detection trend */}
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Card title="Violations by type" hint="current filters">
                    {stats.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : stats.isError ? (
                        <ErrorState error={stats.error} />
                    ) : (
                        <ErrorPie
                            data={pieData}
                            emptyMessage="No violations match these filters."
                        />
                    )}
                </Card>

                <Card title="Detection trend" hint={`last ${windowDays} days`}>
                    {trends.isPending ? (
                        <SkeletonRows rows={5} />
                    ) : trends.isError ? (
                        <ErrorState error={trends.error} />
                    ) : (
                        <CountTrend
                            data={trendSeries}
                            name="Detected"
                            color="#4f5bd5"
                            emptyMessage="No violations detected in this range."
                        />
                    )}
                </Card>
            </div>

            <Card>
                <div className="filter-group mb-4">
                    <Select
                        label="Pipeline"
                        value={pipeline}
                        onChange={onPipelineChange}
                        options={pipelineOptions}
                    />
                    <Select
                        label="Type"
                        value={type}
                        onChange={onTypeChange}
                        options={VIOLATION_TYPES.map((t) => ({
                            value: t,
                            label: VIOLATION_LABELS[t],
                        }))}
                    />
                    <Select
                        label="Severity"
                        value={severity}
                        onChange={resetToFirstPage(setSeverity)}
                        options={SEVERITIES.map((s) => ({ value: s, label: title(s) }))}
                    />
                    <Select
                        label="Status"
                        value={status}
                        onChange={resetToFirstPage(setStatus)}
                        options={STATUS_OPTIONS}
                    />
                </div>

                {/* Batch action bar — appears once anything is selected */}
                {selected.size > 0 && (
                    <div className="batch-bar">
                        <span className="batch-count">{selected.size} selected</span>
                        <input
                            className="text-input"
                            placeholder="Optional note (applied to all)…"
                            value={batchNote}
                            onChange={(e) => setBatchNote(e.target.value)}
                            style={{ minWidth: 220, flex: '1 1 220px' }}
                        />
                        <div className="row gap-2">
                            <button
                                className="btn btn-sm btn-success"
                                onClick={() => runBatch('approve')}
                                disabled={batch.isPending}
                            >
                                <Check size={14} /> Approve
                            </button>
                            <button
                                className="btn btn-sm"
                                onClick={() => runBatch('dismiss')}
                                disabled={batch.isPending}
                            >
                                <X size={14} /> Dismiss
                            </button>
                            <button
                                className="btn btn-sm btn-danger"
                                onClick={() => runBatch('escalate')}
                                disabled={batch.isPending}
                            >
                                <ArrowUpFromLine size={14} /> Escalate
                            </button>
                            <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => setSelected(new Set())}
                                disabled={batch.isPending}
                            >
                                Clear
                            </button>
                        </div>
                        {batch.isPending && <Spinner label="Processing…" />}
                    </div>
                )}

                {isPending ? (
                    <SkeletonRows rows={8} />
                ) : isError ? (
                    <ErrorState error={error} />
                ) : items.length === 0 ? (
                    <EmptyState
                        title="No violations"
                        message="Nothing matches these filters."
                        icon={<ShieldAlert size={26} />}
                    />
                ) : (
                    <div
                        className="table-wrap"
                        style={{ border: 'none', opacity: isPlaceholderData ? 0.6 : 1 }}
                    >
                        <table className="data">
                            <thead>
                                <tr>
                                    <th className="check-cell">
                                        <input
                                            type="checkbox"
                                            className="check"
                                            checked={allSelected}
                                            onChange={toggleAll}
                                            disabled={openIds.length === 0}
                                            aria-label="Select all open violations on this page"
                                        />
                                    </th>
                                    <th style={{ width: 32 }} />
                                    <th>Pipeline</th>
                                    <th>Type</th>
                                    <th>Severity</th>
                                    <th>Detected</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'right' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((v) => (
                                    <ViolationRow
                                        key={v.id}
                                        v={v}
                                        selected={selected.has(v.id)}
                                        onToggle={() => toggleOne(v.id)}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Pagination */}
                {total > PAGE_SIZE && (
                    <div className="pager">
                        <span>
                            Showing {page * PAGE_SIZE + 1}–
                            {Math.min((page + 1) * PAGE_SIZE, total)} of {fmtNumber(total)}
                        </span>
                        <div className="row gap-2 center">
                            <button
                                className="btn btn-sm"
                                disabled={page === 0}
                                onClick={() => setPage((p) => Math.max(0, p - 1))}
                            >
                                Previous
                            </button>
                            <span className="small muted">
                                Page {page + 1} / {pageCount}
                            </span>
                            <button
                                className="btn btn-sm"
                                disabled={page + 1 >= pageCount || isPlaceholderData}
                                onClick={() => setPage((p) => p + 1)}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    )
}

function ViolationRow({
    v,
    selected,
    onToggle,
}: {
    v: Violation
    selected: boolean
    onToggle: () => void
}) {
    const [expanded, setExpanded] = useState(false)
    const [note, setNote] = useState('')
    const [showNote, setShowNote] = useState(false)
    const review = useReviewMutation()

    const isOpen = v.status === 'open'

    function act(action: ReviewAction) {
        review.mutate(
            { id: v.id, action, reviewedBy: REVIEWER, note: note.trim() || undefined },
            {
                onSuccess: () => {
                    setNote('')
                    setShowNote(false)
                },
            },
        )
    }

    return (
        <>
            <tr
                className={`clickable ${expanded ? 'expanded' : ''}`}
                onClick={() => setExpanded((e) => !e)}
            >
                <td className="check-cell" onClick={(e) => e.stopPropagation()}>
                    <input
                        type="checkbox"
                        className="check"
                        checked={selected}
                        onChange={onToggle}
                        disabled={!isOpen}
                        aria-label={`Select violation #${v.id}`}
                    />
                </td>
                <td>
                    <ChevronRight
                        size={15}
                        style={{
                            transform: expanded ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.15s ease',
                            color: 'var(--text-faint)',
                        }}
                    />
                </td>
                <td>
                    <Link
                        to={`/pipelines/${encodeURIComponent(v.pipeline_name)}`}
                        className="link"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {v.pipeline_name}
                    </Link>
                    <div className="small faint">{v.pipeline_category}</div>
                </td>
                <td>{VIOLATION_LABELS[v.violation_type] ?? v.violation_type}</td>
                <td>
                    <SeverityBadge severity={v.severity} />
                </td>
                <td className="nowrap muted">{fmtDateTime(v.detected_at)}</td>
                <td>
                    <ViolationStatusBadge status={v.status} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                    {review.isPending ? (
                        <div style={{ textAlign: 'right' }}>
                            <Spinner label="Saving…" />
                        </div>
                    ) : isOpen ? (
                        <div className="icon-actions">
                            <button
                                className="icon-btn act-approve"
                                title="Approve (acknowledge & close)"
                                aria-label="Approve"
                                onClick={() => act('approve')}
                            >
                                <Check size={15} />
                            </button>
                            <button
                                className="icon-btn act-dismiss"
                                title="Dismiss (not a real issue)"
                                aria-label="Dismiss"
                                onClick={() => act('dismiss')}
                            >
                                <X size={15} />
                            </button>
                            <button
                                className="icon-btn act-escalate"
                                title="Escalate"
                                aria-label="Escalate"
                                onClick={() => act('escalate')}
                            >
                                <ArrowUpFromLine size={15} />
                            </button>
                        </div>
                    ) : (
                        <span className="small faint" style={{ display: 'block', textAlign: 'right' }}>
                            {v.reviewed_by ? `by ${v.reviewed_by}` : 'reviewed'}
                        </span>
                    )}
                </td>
            </tr>

            {expanded && (
                <tr>
                    <td colSpan={8} style={{ padding: 0 }}>
                        <div className="expand-panel">
                            <div className="detail-grid">
                                <Detail k="Violation ID" v={`#${v.id}`} />
                                <Detail k="Run ID" v={v.run_id ?? '—'} mono />
                                <Detail k="Detected at" v={fmtDateTime(v.detected_at)} />
                                <Detail k="Criticality" v={title(v.criticality)} />
                                {v.reviewed_by && <Detail k="Reviewed by" v={v.reviewed_by} />}
                                {v.reviewed_at && (
                                    <Detail k="Reviewed at" v={fmtDateTime(v.reviewed_at)} />
                                )}
                            </div>

                            {v.details && (
                                <div className="mt-3">
                                    <div className="detail-item">
                                        <div className="k">Details</div>
                                        <div className="v" style={{ fontWeight: 400 }}>
                                            {v.details}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {v.note && (
                                <div className="mt-3">
                                    <div className="detail-item">
                                        <div className="k">Reviewer note</div>
                                        <div className="v" style={{ fontWeight: 400 }}>
                                            {v.note}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {review.isError && (
                                <div className="mt-3 small" style={{ color: 'var(--failed)' }}>
                                    Failed to save: {(review.error as Error).message}
                                </div>
                            )}

                            {isOpen && (
                                <div className="mt-4 col gap-2" style={{ maxWidth: 520 }}>
                                    {showNote ? (
                                        <textarea
                                            className="text-input"
                                            placeholder="Optional note (stored on the audit record)…"
                                            rows={2}
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            style={{ resize: 'vertical', minWidth: 320 }}
                                        />
                                    ) : (
                                        <button
                                            className="btn btn-sm btn-ghost"
                                            style={{ alignSelf: 'flex-start' }}
                                            onClick={() => setShowNote(true)}
                                        >
                                            + Add a note
                                        </button>
                                    )}
                                    <div className="row gap-2">
                                        <button
                                            className="btn btn-sm btn-success"
                                            onClick={() => act('approve')}
                                            disabled={review.isPending}
                                        >
                                            <Check size={14} /> Approve
                                        </button>
                                        <button
                                            className="btn btn-sm"
                                            onClick={() => act('dismiss')}
                                            disabled={review.isPending}
                                        >
                                            <X size={14} /> Dismiss
                                        </button>
                                        <button
                                            className="btn btn-sm btn-danger"
                                            onClick={() => act('escalate')}
                                            disabled={review.isPending}
                                        >
                                            <ArrowUpFromLine size={14} /> Escalate
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </td>
                </tr>
            )}
        </>
    )
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
    return (
        <div className="detail-item">
            <div className="k">{k}</div>
            <div className={`v ${mono ? 'mono' : ''}`}>{v}</div>
        </div>
    )
}

function title(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
