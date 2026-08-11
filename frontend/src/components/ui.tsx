// Shared presentational primitives used across pages: status/severity badges,
// dots, loading/empty/error states, skeletons, and small layout helpers. Kept
// dependency-free (just the design-token classes) so they stay fast + reusable.

import type { ReactNode } from 'react'
import { AlertCircle, Inbox, Loader2, WifiOff } from 'lucide-react'
import { ApiError } from '../lib/api'
import type {
    Criticality,
    RunStatus,
    Severity,
    ViolationStatus,
} from '../lib/types'

// ---- status dot + label for pipeline runs ----
export function StatusBadge({ status }: { status: RunStatus }) {
    const cls =
        status === 'SUCCESS'
            ? 'status-success'
            : status === 'FAILED'
                ? 'status-failed'
                : 'status-running'
    const dot =
        status === 'SUCCESS'
            ? 'dot-success'
            : status === 'FAILED'
                ? 'dot-failed'
                : 'dot-running'
    const label =
        status === 'SUCCESS' ? 'Success' : status === 'FAILED' ? 'Failed' : 'Running'
    return (
        <span className={`badge ${cls}`}>
            <span className={`dot ${dot}`} />
            {label}
        </span>
    )
}

export function SeverityBadge({ severity }: { severity: Severity }) {
    return <span className={`badge sev-${severity}`}>{titleCase(severity)}</span>
}

export function CriticalityBadge({ level }: { level: Criticality }) {
    const dot =
        level === 'HIGH' ? 'dot-failed' : level === 'MEDIUM' ? 'dot-warning' : 'dot-neutral'
    return (
        <span className="row gap-2 center nowrap">
            <span className={`dot ${dot}`} />
            {titleCase(level)}
        </span>
    )
}

export function ViolationStatusBadge({ status }: { status: ViolationStatus }) {
    return <span className={`badge vs-${status}`}>{titleCase(status)}</span>
}

export function FreshnessBadge({ fresh }: { fresh: boolean }) {
    return (
        <span className={`badge ${fresh ? 'status-success' : 'status-failed'}`}>
            <span className={`dot ${fresh ? 'dot-success' : 'dot-failed'}`} />
            {fresh ? 'Fresh' : 'Stale'}
        </span>
    )
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export function Spinner({ label }: { label?: string }) {
    return (
        <span className="row gap-2 center muted small">
            <Loader2 size={14} style={{ animation: 'spin 0.9s linear infinite' }} />
            {label}
        </span>
    )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
    return (
        <div className="state">
            <Loader2
                size={24}
                className="state-icon"
                style={{ animation: 'spin 0.9s linear infinite' }}
            />
            <div className="state-msg">{label}</div>
        </div>
    )
}

export function EmptyState({
    title = 'Nothing to show',
    message,
    icon,
}: {
    title?: string
    message?: string
    icon?: ReactNode
}) {
    return (
        <div className="state">
            <span className="state-icon">{icon ?? <Inbox size={26} />}</span>
            <div className="state-title">{title}</div>
            {message && <div className="state-msg">{message}</div>}
        </div>
    )
}

export function ErrorState({ error }: { error: unknown }) {
    const isNetwork = error instanceof ApiError && error.status === 0
    const message =
        error instanceof Error ? error.message : 'An unexpected error occurred.'
    return (
        <div className="state">
            <span className="state-icon state-error">
                {isNetwork ? <WifiOff size={26} /> : <AlertCircle size={26} />}
            </span>
            <div className="state-title state-error">
                {isNetwork ? 'Cannot reach the API' : 'Something went wrong'}
            </div>
            <div className="state-msg">{message}</div>
            {isNetwork && (
                <div className="state-msg faint">
                    Start it with:{' '}
                    <code className="mono">uvicorn backend.main:app --reload --port 8000</code>
                </div>
            )}
        </div>
    )
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
    return (
        <div style={{ padding: '4px 0' }}>
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className="skeleton skeleton-row"
                    style={{ width: `${70 + ((i * 13) % 25)}%` }}
                />
            ))}
        </div>
    )
}

export function Card({
    title,
    hint,
    action,
    children,
    className = '',
}: {
    title?: string
    hint?: string
    action?: ReactNode
    children: ReactNode
    className?: string
}) {
    return (
        <section className={`card ${className}`}>
            {(title || action) && (
                <div className="card-head">
                    <div className="row gap-2 center">
                        {title && <h3 className="card-title">{title}</h3>}
                        {hint && <span className="card-hint">{hint}</span>}
                    </div>
                    {action}
                </div>
            )}
            {children}
        </section>
    )
}

// KPI card — the metric tile used across Overview / Pipeline detail /
// Violations. `icon` should be a lucide icon; it gets sized + tinted by the
// `kpi-icon` wrapper (default accent tone, or a `tone` override).
export function Kpi({
    label,
    value,
    unit,
    foot,
    icon,
    tone = 'accent',
    loading,
}: {
    label: string
    value: string
    unit?: string
    foot?: string
    icon?: ReactNode
    tone?: 'accent' | 'success' | 'danger' | 'warning' | 'neutral'
    loading?: boolean
}) {
    return (
        <div className="kpi">
            <div className="kpi-label">
                {icon && <span className={`kpi-icon tone-${tone}`}>{icon}</span>}
                {label}
            </div>
            {loading ? (
                <div className="skeleton" style={{ height: 26, width: '60%' }} />
            ) : (
                <div className="kpi-value tnum">
                    {value}
                    {unit && <span className="unit">{unit}</span>}
                </div>
            )}
            {foot && <div className="kpi-foot">{foot}</div>}
        </div>
    )
}

export function Select({
    label,
    value,
    onChange,
    options,
    includeAll = true,
    allLabel = 'All',
}: {
    label?: string
    value: string
    onChange: (v: string) => void
    options: readonly { value: string; label: string }[] | readonly string[]
    includeAll?: boolean
    allLabel?: string
}) {
    const normalized = options.map((o) =>
        typeof o === 'string' ? { value: o, label: o } : o,
    )
    const select = (
        <select
            className="select"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
        >
            {includeAll && <option value="all">{allLabel}</option>}
            {normalized.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    )
    if (!label) return select
    return (
        <label className="field">
            <span className="field-label">{label}</span>
            {select}
        </label>
    )
}

// Spin keyframe (used by Loader2 icons above) lives here so it ships with the JS.
if (typeof document !== 'undefined' && !document.getElementById('spin-kf')) {
    const style = document.createElement('style')
    style.id = 'spin-kf'
    style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}'
    document.head.appendChild(style)
}
