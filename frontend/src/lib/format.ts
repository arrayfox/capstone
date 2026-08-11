// Small pure formatters. Timestamps from the backend are "YYYY-MM-DD HH:MM:SS"
// in the simulator's clock — we parse them as-is (no timezone juggling) so what
// the dashboard shows matches the stored data exactly.

const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** Parse "YYYY-MM-DD HH:MM:SS" into parts without applying a timezone shift. */
function parseParts(ts: string | null | undefined) {
    if (!ts) return null
    const m = ts.match(
        /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
    )
    if (!m) return null
    return {
        y: +m[1], mo: +m[2], d: +m[3],
        h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0,
    }
}

/** "Aug 10, 14:32" — compact datetime for tables. */
export function fmtDateTime(ts: string | null | undefined): string {
    const p = parseParts(ts)
    if (!p) return '—'
    const hh = String(p.h).padStart(2, '0')
    const mm = String(p.mi).padStart(2, '0')
    return `${MONTHS[p.mo - 1]} ${p.d}, ${hh}:${mm}`
}

/** "Aug 10" — day only, for chart axes. */
export function fmtDay(ts: string | null | undefined): string {
    const p = parseParts(ts)
    if (!p) return '—'
    return `${MONTHS[p.mo - 1]} ${p.d}`
}

/** "14:32:05" — time only, for the live tail. */
export function fmtTime(ts: string | null | undefined): string {
    const p = parseParts(ts)
    if (!p) return '—'
    const hh = String(p.h).padStart(2, '0')
    const mm = String(p.mi).padStart(2, '0')
    const ss = String(p.s).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
}

/** Relative "3h ago" / "2d ago" from a hours-elapsed number. */
export function fmtHoursAgo(hours: number | null | undefined): string {
    if (hours === null || hours === undefined) return 'never'
    if (hours < 1) return `${Math.round(hours * 60)}m ago`
    if (hours < 48) return `${Math.round(hours)}h ago`
    return `${Math.round(hours / 24)}d ago`
}

/** Duration in minutes → "45m" or "1h 12m". */
export function fmtDuration(mins: number | null | undefined): string {
    if (mins === null || mins === undefined) return '—'
    const rounded = Math.round(mins)
    if (rounded < 60) return `${rounded}m`
    const h = Math.floor(rounded / 60)
    const m = rounded % 60
    return m ? `${h}h ${m}m` : `${h}h`
}

/** Compact integer with thousands separators; big values get k/M suffixes. */
export function fmtNumber(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—'
    return n.toLocaleString('en-US')
}

export function fmtCompact(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—'
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

/** A percent value already in 0–100 → "92.4%". */
export function fmtPct(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—'
    return `${n}%`
}

/** Turn a snake/upper code into Title Case words: RATE_LIMIT → "Rate Limit". */
export function humanize(code: string | null | undefined): string {
    if (!code) return '—'
    return code
        .toLowerCase()
        .split(/[_\s]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
}
