// Recharts wrappers with restrained, consistent defaults (thin strokes, muted
// grid, clean tooltip, no chartjunk). Polling re-renders these constantly, so
// animation is disabled — values update in place without re-drawing every 5s.

import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Line,
    LineChart,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts'
import { PIE_COLORS } from '../lib/constants'
import { fmtDay } from '../lib/format'
import type { TrendPoint, ViolationTrendPoint } from '../lib/types'
import { EmptyState } from './ui'

const AXIS = { stroke: 'transparent', tick: { fill: '#9ca3af', fontSize: 11 } }
const GRID = { stroke: '#eef0f2', vertical: false }

// Shared tooltip: white card, one row per series, tabular numbers.
function ChartTooltip({
    active,
    payload,
    label,
    unit,
    labelFmt,
}: {
    active?: boolean
    payload?: { name?: string; value?: number; color?: string; dataKey?: string }[]
    label?: string
    unit?: string
    labelFmt?: (v: string) => string
}) {
    if (!active || !payload?.length) return null
    return (
        <div className="chart-tip">
            <div className="chart-tip-label">{labelFmt ? labelFmt(String(label)) : label}</div>
            {payload.map((p, i) => (
                <div key={i} className="chart-tip-row">
                    <span className="legend-swatch" style={{ background: p.color }} />
                    <span className="chart-tip-name">{p.name}</span>
                    <span className="chart-tip-val tnum">
                        {p.value ?? '—'}
                        {unit ?? ''}
                    </span>
                </div>
            ))}
        </div>
    )
}

// ---- Single-metric trend line (SLA %, failures, avg duration) ----
export function TrendLine({
    data,
    dataKey,
    color = '#4f5bd5',
    name,
    unit,
    height = 240,
    area = false,
    domainMax,
    domainMin = 0,
}: {
    data: TrendPoint[]
    dataKey: keyof TrendPoint
    color?: string
    name: string
    unit?: string
    height?: number
    area?: boolean
    domainMax?: number
    // Lower bound of the Y axis. Defaults to 0, but a "zoomed" floor (e.g. for a
    // 90–100% SLA band) keeps the line off the top edge so its shape is legible.
    domainMin?: number
}) {
    if (!data.length) return <EmptyState message="No data in this range." />

    // Axis + grid + tooltip are inlined (not wrapped in a Fragment) as DIRECT
    // children of each chart: Recharts discovers <XAxis>/<YAxis> by scanning its
    // immediate children, and axes nested inside a Fragment get skipped — which
    // silently drops the dated x-axis and falls back to a bare index axis.
    return (
        <ResponsiveContainer width="100%" height={height}>
            {area ? (
                <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                        <linearGradient id={`grad-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="date" tickFormatter={fmtDay} {...AXIS} minTickGap={24} />
                    <YAxis
                        {...AXIS}
                        width={40}
                        domain={[domainMin, domainMax ?? 'auto']}
                        allowDecimals={false}
                    />
                    <Tooltip
                        content={<ChartTooltip unit={unit} labelFmt={fmtDay} />}
                        cursor={{ stroke: '#d1d5db', strokeWidth: 1 }}
                    />
                    <Area
                        type="monotone"
                        name={name}
                        dataKey={dataKey as string}
                        stroke={color}
                        strokeWidth={2}
                        fill={`url(#grad-${String(dataKey)})`}
                        dot={false}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                        connectNulls
                    />
                </AreaChart>
            ) : (
                <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="date" tickFormatter={fmtDay} {...AXIS} minTickGap={24} />
                    <YAxis
                        {...AXIS}
                        width={40}
                        domain={[domainMin, domainMax ?? 'auto']}
                        allowDecimals={false}
                    />
                    <Tooltip
                        content={<ChartTooltip unit={unit} labelFmt={fmtDay} />}
                        cursor={{ stroke: '#d1d5db', strokeWidth: 1 }}
                    />
                    <Line
                        type="monotone"
                        name={name}
                        dataKey={dataKey as string}
                        stroke={color}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                        connectNulls
                    />
                </LineChart>
            )}
        </ResponsiveContainer>
    )
}

// ---- Simple count trend line (e.g. violations detected per day) ----
export function CountTrend({
    data,
    name,
    color = '#4f5bd5',
    height = 240,
    emptyMessage = 'No data in this range.',
}: {
    data: ViolationTrendPoint[]
    name: string
    color?: string
    height?: number
    emptyMessage?: string
}) {
    if (!data.length) return <EmptyState message={emptyMessage} />
    return (
        <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <defs>
                    <linearGradient id="grad-count" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                        <stop offset="100%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...AXIS} minTickGap={24} />
                <YAxis {...AXIS} width={40} allowDecimals={false} />
                <Tooltip
                    content={<ChartTooltip labelFmt={fmtDay} />}
                    cursor={{ stroke: '#d1d5db', strokeWidth: 1 }}
                />
                <Area
                    type="monotone"
                    name={name}
                    dataKey="count"
                    stroke={color}
                    strokeWidth={2}
                    fill="url(#grad-count)"
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                />
            </AreaChart>
        </ResponsiveContainer>
    )
}

// ---- Run status over time (stacked bar: successes + failures) ----
export function StatusStackedBar({
    data,
    height = 240,
}: {
    data: TrendPoint[]
    height?: number
}) {
    if (!data.length) return <EmptyState message="No runs in this range." />
    return (
        <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
                <CartesianGrid {...GRID} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...AXIS} minTickGap={24} />
                <YAxis {...AXIS} width={40} allowDecimals={false} />
                <Tooltip
                    content={<ChartTooltip labelFmt={fmtDay} />}
                    cursor={{ fill: 'rgba(79,91,213,0.06)' }}
                />
                <Bar
                    dataKey="successes"
                    name="Success"
                    stackId="s"
                    fill="#16a34a"
                    radius={[0, 0, 0, 0]}
                    isAnimationActive={false}
                />
                <Bar
                    dataKey="failures"
                    name="Failed"
                    stackId="s"
                    fill="#dc2626"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                />
            </BarChart>
        </ResponsiveContainer>
    )
}

// ---- Distribution donut + legend (error codes, violation types, …) ----
// `emptyMessage` lets the same chart serve different contexts (a clean run
// history vs. no violations) without hard-coding one phrase.
export function ErrorPie({
    data,
    height = 240,
    emptyMessage = 'No errors — clean run history.',
}: {
    data: { name: string; value: number }[]
    height?: number
    emptyMessage?: string
}) {
    if (!data.length) return <EmptyState message={emptyMessage} />
    return (
        <div className="row gap-4 wrap center" style={{ justifyContent: 'space-around' }}>
            <ResponsiveContainer width="55%" height={height} minWidth={180}>
                <PieChart>
                    <Pie
                        data={data}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={82}
                        paddingAngle={2}
                        stroke="#fff"
                        strokeWidth={2}
                        isAnimationActive={false}
                    >
                        {data.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                </PieChart>
            </ResponsiveContainer>
            <div className="chart-legend col gap-2 scroll">
                {data.map((d, i) => (
                    <div key={d.name} className="li">
                        <span
                            className="legend-swatch"
                            style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                        />
                        <span className="grow">{d.name}</span>
                        <span className="tnum strong" style={{ marginLeft: 12 }}>
                            {d.value}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

// Small inline legend row for the stacked bar / lines.
export function Legend({
    items,
}: {
    items: { label: string; color: string }[]
}) {
    return (
        <div className="chart-legend">
            {items.map((it) => (
                <span key={it.label} className="li">
                    <span className="legend-swatch" style={{ background: it.color }} />
                    {it.label}
                </span>
            ))}
        </div>
    )
}
