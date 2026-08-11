// App shell: left sidebar nav + sticky top bar of global controls. The top bar
// owns the shared filters (time range / category / criticality / status) and the
// auto-refresh switch — these live in the Zustand store and drive every query,
// so changing one re-scopes the whole dashboard without a page reload.

import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import {
    Activity,
    FileClock,
    GitBranch,
    LayoutDashboard,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    RefreshCw,
    ScrollText,
    ShieldAlert,
} from 'lucide-react'
import {
    CATEGORIES,
    CRITICALITIES,
    REFRESH_INTERVALS,
    RUN_STATUSES,
    TIME_RANGES,
} from '../lib/constants'
import { useFilters, useUi } from '../lib/store'
import { Select } from './ui'

const NAV = [
    { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/pipelines', label: 'Pipelines', icon: GitBranch, end: false },
    { to: '/executions', label: 'Executions', icon: ScrollText, end: false },
    { to: '/violations', label: 'Violations', icon: ShieldAlert, end: false },
    { to: '/audit', label: 'Audit', icon: FileClock, end: false },
]

function Sidebar({
    open,
    onClose,
    collapsed,
    onToggleCollapse,
}: {
    open: boolean
    onClose: () => void
    collapsed: boolean
    onToggleCollapse: () => void
}) {
    return (
        <>
            <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} />
            <aside className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
                <div className="brand-row">
                    <div className="brand">
                        <span className="brand-mark">
                            <Activity size={17} />
                        </span>
                        <span className="brand-text">PipelineWatch</span>
                    </div>
                    <button
                        className="collapse-btn"
                        onClick={onToggleCollapse}
                        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    >
                        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
                    </button>
                </div>
                <nav className="col gap-1">
                    {NAV.map(({ to, label, icon: Icon, end }) => (
                        <NavLink
                            key={to}
                            to={to}
                            end={end}
                            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                            onClick={onClose}
                            title={collapsed ? label : undefined}
                        >
                            <Icon size={18} />
                            <span className="nav-label">{label}</span>
                        </NavLink>
                    ))}
                </nav>
                <div className="sidebar-foot">
                    Data freshness monitoring
                    <br />& governance
                </div>
            </aside>
        </>
    )
}

// "Last updated Xs ago" — recomputed each second, reset whenever a background
// fetch settles so the freshness read-out tracks real polling activity.
function LastUpdated() {
    const fetching = useIsFetching()
    const [last, setLast] = useState<number>(() => Date.now())
    const [, force] = useState(0)
    const wasFetching = useRef(false)

    useEffect(() => {
        if (fetching > 0) wasFetching.current = true
        else if (wasFetching.current) {
            wasFetching.current = false
            setLast(Date.now())
        }
    }, [fetching])

    useEffect(() => {
        const id = setInterval(() => force((n) => n + 1), 1000)
        return () => clearInterval(id)
    }, [])

    const secs = Math.max(0, Math.round((Date.now() - last) / 1000))
    const text =
        fetching > 0 ? 'Updating…' : secs < 2 ? 'Just now' : `Updated ${secs}s ago`
    return (
        <span className="row gap-2 center small muted nowrap" aria-live="polite">
            <span className={`pulse ${fetching > 0 ? 'on' : 'off'}`} />
            {text}
        </span>
    )
}

function TopBar({ onMenu }: { onMenu: () => void }) {
    const qc = useQueryClient()
    const {
        windowDays,
        category,
        criticality,
        status,
        autoRefresh,
        intervalSeconds,
        setWindowDays,
        setCategory,
        setCriticality,
        setStatus,
        setAutoRefresh,
        setIntervalSeconds,
    } = useFilters()

    return (
        <header className="topbar">
            <button className="btn btn-icon btn-ghost menu-btn" onClick={onMenu} aria-label="Open menu">
                <Menu size={18} />
            </button>

            <div className="filter-group">
                <Select
                    label="Time range"
                    value={String(windowDays)}
                    onChange={(v) => setWindowDays(Number(v))}
                    includeAll={false}
                    options={TIME_RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
                />
                <Select
                    label="Category"
                    value={category}
                    onChange={setCategory}
                    options={CATEGORIES.map((c) => ({ value: c, label: c }))}
                />
                <Select
                    label="Criticality"
                    value={criticality}
                    onChange={setCriticality}
                    options={CRITICALITIES.map((c) => ({ value: c, label: title(c) }))}
                />
                <Select
                    label="Status"
                    value={status}
                    onChange={setStatus}
                    options={RUN_STATUSES.map((s) => ({ value: s, label: title(s) }))}
                />
            </div>

            <div className="spacer" />

            <div className="filter-group">
                <LastUpdated />

                <label className="switch" title="Toggle background auto-refresh">
                    <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(e) => setAutoRefresh(e.target.checked)}
                    />
                    <span className="track" />
                    <span className="thumb" />
                    <span className="small muted">Auto</span>
                </label>

                <Select
                    value={String(intervalSeconds)}
                    onChange={(v) => setIntervalSeconds(Number(v))}
                    includeAll={false}
                    options={REFRESH_INTERVALS.map((r) => ({
                        value: String(r.seconds),
                        label: r.label,
                    }))}
                />

                <button
                    className="btn btn-icon"
                    onClick={() => qc.invalidateQueries()}
                    aria-label="Refresh now"
                    title="Refresh now"
                >
                    <RefreshCw size={15} />
                </button>
            </div>
        </header>
    )
}

function title(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export default function Layout() {
    const [menuOpen, setMenuOpen] = useState(false)
    const { sidebarCollapsed, toggleSidebar } = useUi()
    return (
        <div className={`app-shell ${sidebarCollapsed ? 'collapsed' : ''}`}>
            <Sidebar
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                collapsed={sidebarCollapsed}
                onToggleCollapse={toggleSidebar}
            />
            <div className="main">
                <TopBar onMenu={() => setMenuOpen(true)} />
                <Outlet />
            </div>
        </div>
    )
}
