// Enum values that drive the filter dropdowns. Sourced from the synthetic-data
// catalog + detection module so the UI's options exactly match the backend.

import type { Criticality, RunStatus, Severity, ViolationType } from './types'

export const CATEGORIES = [
    'CRM',
    'Claims',
    'Compliance',
    'Sales',
    'Patient',
    'Marketing',
] as const

export const CRITICALITIES: Criticality[] = ['HIGH', 'MEDIUM', 'LOW']

export const RUN_STATUSES: RunStatus[] = ['SUCCESS', 'FAILED', 'RUNNING']

export const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

export const VIOLATION_TYPES: ViolationType[] = [
    'SLA_BREACH',
    'DELAYED_START',
    'VOLUME_ANOMALY',
    'FAILURE',
    'RECURRING_FAILURE',
    'MISSING_LOAD',
    'FRESHNESS',
]

// Human-friendly labels for the violation type codes.
export const VIOLATION_LABELS: Record<ViolationType, string> = {
    SLA_BREACH: 'SLA breach',
    DELAYED_START: 'Delayed start',
    VOLUME_ANOMALY: 'Volume anomaly',
    FAILURE: 'Failure',
    RECURRING_FAILURE: 'Recurring failure',
    MISSING_LOAD: 'Missing load',
    FRESHNESS: 'Freshness',
}

// Time-range options (map to the backend's window_days query param).
export const TIME_RANGES = [
    { label: '24 hours', days: 1 },
    { label: '7 days', days: 7 },
    { label: '14 days', days: 14 },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
] as const

// Auto-refresh interval choices (seconds). Default mirrors POLL_SECONDS (5s).
export const REFRESH_INTERVALS = [
    { label: '5s', seconds: 5 },
    { label: '10s', seconds: 10 },
    { label: '30s', seconds: 30 },
    { label: '60s', seconds: 60 },
] as const

export const DEFAULT_POLL_SECONDS = 5

// Ordering weight for sorting by severity (higher = more severe).
export const SEVERITY_WEIGHT: Record<Severity, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
}

export const CRITICALITY_WEIGHT: Record<Criticality, number> = {
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
}

// Palette for the error-distribution pie (neutral/restrained, cycled by index).
export const PIE_COLORS = [
    '#4f5bd5',
    '#6b7280',
    '#d97706',
    '#0891b2',
    '#7c3aed',
    '#dc2626',
    '#059669',
    '#9ca3af',
    '#be185d',
]

export const REVIEWER = 'analyst'
