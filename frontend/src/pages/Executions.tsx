// Executions — the run log for investigation. Paginated, filterable table of
// every pipeline run. Rows expand to show config context + the error message
// for failed runs. Deep-linkable: `/executions?pipeline=<name>` pre-filters to
// one pipeline (used by the "open run log" link on a pipeline's detail page).

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronRight, ScrollText } from 'lucide-react'
import {
    Card,
    EmptyState,
    ErrorState,
    Select,
    SkeletonRows,
    StatusBadge,
} from '../components/ui'
import { usePipelines, useRuns } from '../lib/hooks'
import { useFilters } from '../lib/store'
import { RUN_STATUSES } from '../lib/constants'
import {
    fmtDateTime,
    fmtDuration,
    fmtNumber,
    humanize,
} from '../lib/format'
import type { Run } from '../lib/types'

const PAGE_SIZE = 25

export default function Executions() {
    const { category, status: globalStatus } = useFilters()
    const [searchParams, setSearchParams] = useSearchParams()

    // Seed the pipeline filter from the URL (deep link from pipeline detail).
    const urlPipeline = searchParams.get('pipeline') ?? 'all'
    const [pipeline, setPipeline] = useState(urlPipeline)
    const [status, setStatus] = useState<string>(globalStatus)
    const [page, setPage] = useState(0)

    // Keep local state in sync if the URL changes while mounted.
    useEffect(() => {
        setPipeline(urlPipeline)
        setPage(0)
    }, [urlPipeline])

    const runs = useRuns({
        category,
        status,
        pipeline: pipeline === 'all' ? undefined : pipeline,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
    })
    // All pipelines, for a stable filter dropdown (independent of the page data).
    const pipelinesList = usePipelines({})

    const items = runs.data?.items ?? []
    const total = runs.data?.total ?? 0
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const pipelineOptions = (pipelinesList.data?.items ?? [])
        .map((p) => p.pipeline_name)
        .sort()

    function onPipelineChange(v: string) {
        setPipeline(v)
        setPage(0)
        // Reflect the choice in the URL so the view is shareable / back-navigable.
        const next = new URLSearchParams(searchParams)
        if (v === 'all') next.delete('pipeline')
        else next.set('pipeline', v)
        setSearchParams(next, { replace: true })
    }

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div>
                    <h1 className="page-title">Executions</h1>
                    <p className="page-sub">Every pipeline run, newest first.</p>
                </div>
                <div className="col" style={{ alignItems: 'flex-end' }}>
                    <span className="kpi-value tnum" style={{ fontSize: 22 }}>
                        {runs.isPending ? '—' : fmtNumber(total)}
                    </span>
                    <span className="small faint">execution logs</span>
                </div>
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
                        label="Status"
                        value={status}
                        onChange={(v) => {
                            setStatus(v)
                            setPage(0)
                        }}
                        options={RUN_STATUSES.map((s) => ({ value: s, label: title(s) }))}
                    />
                </div>

                {runs.isPending ? (
                    <SkeletonRows rows={10} />
                ) : runs.isError ? (
                    <ErrorState error={runs.error} />
                ) : items.length === 0 ? (
                    <EmptyState
                        title="No runs"
                        message="Nothing matches these filters."
                        icon={<ScrollText size={26} />}
                    />
                ) : (
                    <div
                        className="table-wrap"
                        style={{
                            border: 'none',
                            opacity: runs.isPlaceholderData ? 0.6 : 1,
                        }}
                    >
                        <table className="data">
                            <thead>
                                <tr>
                                    <th style={{ width: 32 }} />
                                    <th>Pipeline</th>
                                    <th>Scheduled</th>
                                    <th>Started</th>
                                    <th>Status</th>
                                    <th className="num">Rows</th>
                                    <th className="num">Duration</th>
                                    <th>Error</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((r) => (
                                    <RunRow key={r.run_id} r={r} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

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
                                disabled={page + 1 >= pageCount || runs.isPlaceholderData}
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

function RunRow({ r }: { r: Run }) {
    const [expanded, setExpanded] = useState(false)
    const failed = r.status === 'FAILED'

    return (
        <>
            <tr
                className={`clickable ${expanded ? 'expanded' : ''}`}
                onClick={() => setExpanded((e) => !e)}
            >
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
                        to={`/pipelines/${encodeURIComponent(r.pipeline_name)}`}
                        className="link"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {r.pipeline_name}
                    </Link>
                    {r.pipeline_category && (
                        <div className="small faint">{r.pipeline_category}</div>
                    )}
                </td>
                <td className="nowrap muted">{fmtDateTime(r.scheduled_time)}</td>
                <td className="nowrap muted">{fmtDateTime(r.actual_start_time)}</td>
                <td>
                    <StatusBadge status={r.status} />
                </td>
                <td className="num">{r.rows_processed != null ? fmtNumber(r.rows_processed) : '—'}</td>
                <td className="num">{fmtDuration(r.duration_minutes)}</td>
                <td className="truncate">
                    {r.error_code ? (
                        <span className="row gap-2 center">
                            <span className="chip" style={{ color: 'var(--failed)' }}>
                                {r.error_code}
                            </span>
                        </span>
                    ) : (
                        <span className="faint">—</span>
                    )}
                </td>
            </tr>

            {expanded && (
                <tr>
                    <td colSpan={8} style={{ padding: 0 }}>
                        <div className="expand-panel">
                            <div className="detail-grid">
                                <Detail k="Run ID" v={r.run_id} mono />
                                <Detail k="Scheduled" v={fmtDateTime(r.scheduled_time)} />
                                <Detail k="Started" v={fmtDateTime(r.actual_start_time)} />
                                <Detail k="Ended" v={fmtDateTime(r.end_time)} />
                                <Detail k="Duration" v={fmtDuration(r.duration_minutes)} />
                                <Detail
                                    k="Rows processed"
                                    v={r.rows_processed != null ? fmtNumber(r.rows_processed) : '—'}
                                />
                                {r.error_code && <Detail k="Error code" v={humanize(r.error_code)} />}
                            </div>

                            {failed && r.error_message && (
                                <div className="mt-3">
                                    <div className="detail-item">
                                        <div className="k">Error message</div>
                                        <div
                                            className="v mono"
                                            style={{ fontWeight: 400, color: 'var(--failed)' }}
                                        >
                                            {r.error_message}
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="mt-3">
                                <Link
                                    to={`/pipelines/${encodeURIComponent(r.pipeline_name)}`}
                                    className="link"
                                >
                                    View pipeline detail →
                                </Link>
                            </div>
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
