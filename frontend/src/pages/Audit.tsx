// Audit — read-only compliance record of every review action. Filterable by
// actor / action / entity + date range. Actions are written automatically by the
// backend whenever a violation is reviewed on the Violations page.

import { useMemo, useState } from 'react'
import { ArrowUpFromLine, Check, FileClock, X } from 'lucide-react'
import type { ReactNode } from 'react'
import {
    Card,
    EmptyState,
    ErrorState,
    Select,
    SkeletonRows,
} from '../components/ui'
import { useAudit } from '../lib/hooks'
import { fmtDateTime, fmtNumber, humanize } from '../lib/format'
import type { AuditEntry } from '../lib/types'

const LIMIT = 100

// Review actions the backend records (action column is e.g. "review:approve").
const ACTION_OPTIONS = [
    { value: 'review:approve', label: 'Approve' },
    { value: 'review:dismiss', label: 'Dismiss' },
    { value: 'review:escalate', label: 'Escalate' },
]

export default function Audit() {
    const [action, setAction] = useState('all')
    const [actor, setActor] = useState('all')
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')

    const { data, isPending, isError, error, isPlaceholderData } = useAudit({
        action: action === 'all' ? undefined : action,
        actor: actor === 'all' ? undefined : actor,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        limit: LIMIT,
    })

    const items = data?.items ?? []

    // Distinct actors present, for the actor filter.
    const actorOptions = useMemo(
        () => Array.from(new Set(items.map((e) => e.actor))).sort(),
        [items],
    )

    // Tally review verbs across the currently-filtered entries for the summary
    // box. Verb lives after the ":" in actions like "review:approve".
    const summary = useMemo(() => {
        const acc = { approve: 0, dismiss: 0, escalate: 0 }
        for (const e of items) {
            const verb = e.action.includes(':') ? e.action.split(':')[1] : e.action
            if (verb in acc) acc[verb as keyof typeof acc] += 1
        }
        return acc
    }, [items])

    return (
        <div className="page col gap-4">
            <div className="page-head">
                <div>
                    <h1 className="page-title">Audit trail</h1>
                    <p className="page-sub">
                        Immutable record of every governance action. Read-only.
                    </p>
                </div>
            </div>

            {/* Review action summary — reflects the active filters */}
            {!isError && (
                <div className="summary-row">
                    <SummaryBox
                        label="Approved"
                        tone="success"
                        icon={<Check size={16} />}
                        value={isPending ? '—' : fmtNumber(summary.approve)}
                    />
                    <SummaryBox
                        label="Dismissed"
                        tone="neutral"
                        icon={<X size={16} />}
                        value={isPending ? '—' : fmtNumber(summary.dismiss)}
                    />
                    <SummaryBox
                        label="Escalated"
                        tone="danger"
                        icon={<ArrowUpFromLine size={16} />}
                        value={isPending ? '—' : fmtNumber(summary.escalate)}
                    />
                </div>
            )}

            <Card>
                <div className="filter-group mb-4">
                    <Select
                        label="Action"
                        value={action}
                        onChange={setAction}
                        options={ACTION_OPTIONS}
                    />
                    <Select label="Actor" value={actor} onChange={setActor} options={actorOptions} />
                    <label className="field">
                        <span className="field-label">From</span>
                        <input
                            type="date"
                            className="text-input"
                            value={dateFrom}
                            max={dateTo || undefined}
                            onChange={(e) => setDateFrom(e.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span className="field-label">To</span>
                        <input
                            type="date"
                            className="text-input"
                            value={dateTo}
                            min={dateFrom || undefined}
                            onChange={(e) => setDateTo(e.target.value)}
                        />
                    </label>
                </div>

                {isPending ? (
                    <SkeletonRows rows={10} />
                ) : isError ? (
                    <ErrorState error={error} />
                ) : items.length === 0 ? (
                    <EmptyState
                        title="No audit entries"
                        message="No review actions match these filters yet."
                        icon={<FileClock size={26} />}
                    />
                ) : (
                    <div
                        className="table-wrap"
                        style={{ border: 'none', opacity: isPlaceholderData ? 0.6 : 1 }}
                    >
                        <table className="data">
                            <thead>
                                <tr>
                                    <th>Timestamp</th>
                                    <th>Actor</th>
                                    <th>Action</th>
                                    <th>Entity</th>
                                    <th>Details</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((e) => (
                                    <AuditRow key={e.id} e={e} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {data && items.length >= LIMIT && (
                    <div className="pager">
                        <span className="small muted">
                            Showing the most recent {LIMIT} entries. Narrow the date range to see
                            older records.
                        </span>
                    </div>
                )}
            </Card>
        </div>
    )
}

function SummaryBox({
    label,
    value,
    icon,
    tone,
}: {
    label: string
    value: string
    icon: ReactNode
    tone: 'success' | 'danger' | 'neutral'
}) {
    return (
        <div className="summary-box">
            <span className={`s-icon tone-${tone}`}>{icon}</span>
            <div className="col">
                <span className="s-value tnum">{value}</span>
                <span className="s-label">{label}</span>
            </div>
        </div>
    )
}

function AuditRow({ e }: { e: AuditEntry }) {
    return (
        <tr>
            <td className="nowrap muted">{fmtDateTime(e.timestamp)}</td>
            <td className="strong">{e.actor}</td>
            <td>
                <ActionBadge action={e.action} />
            </td>
            <td className="nowrap">
                <span className="muted">{e.entity_type}</span>
                {e.entity_id != null && <span className="mono"> #{e.entity_id}</span>}
            </td>
            <td className="truncate" style={{ maxWidth: 360 }}>
                {e.details ? (
                    <span className="muted">{e.details}</span>
                ) : (
                    <span className="faint">—</span>
                )}
            </td>
        </tr>
    )
}

// Colour the verb by outcome: approve=success, escalate=danger, dismiss=neutral.
// Reuses the shared status-* badge classes so tones stay consistent app-wide.
function ActionBadge({ action }: { action: string }) {
    const verb = action.includes(':') ? action.split(':')[1] : action
    const cls =
        verb === 'approve'
            ? 'status-success'
            : verb === 'escalate'
                ? 'status-failed'
                : 'status-neutral'
    return <span className={`badge ${cls}`}>{humanize(verb)}</span>
}
