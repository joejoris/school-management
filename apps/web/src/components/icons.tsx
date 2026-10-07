/**
 * The school crest, and the few icons used more than once.
 *
 * Icons are inline SVG rather than a dependency. They are twenty lines each, a
 * library would be a hundred kilobytes, and the ones this app needs are the
 * ones a librarian recognises: a book going out, a warning, a door.
 *
 * Every icon is `aria-hidden`. An icon beside a label is decoration; announcing
 * it duplicates the label for anyone using a screen reader.
 */
import type * as React from 'react'

interface IconProps extends React.SVGProps<SVGSVGElement> {
  className?: string
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function BookPlus({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22Z" />
      <path d="M20 16H6.5a2.5 2.5 0 0 0 0 5H20" />
      <path d="M12 6v6M9 9h6" />
    </svg>
  )
}

export function Sliders({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  )
}

/** Six counts at a glance. Reads as a bar chart with a baseline. */
export function ChartBars({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <line x1="4" y1="20" x2="20" y2="20" />
      <line x1="8" y1="20" x2="8" y2="10" />
      <line x1="12.5" y1="20" x2="12.5" y2="4" />
      <line x1="17" y1="20" x2="17" y2="14" />
    </svg>
  )
}

/** A download: an arrow down into a tray. For the reports rail entry. */
export function Download({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M12 3v11" />
      <path d="m7 9 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

/** A pencil: correcting a row's details. */
export function Pencil({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17z" />
      <path d="m14 6 4 4" />
    </svg>
  )
}

export function Library({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="16" rx="1" />
      <path d="m17 5 4 14M21 5l-4 14" />
    </svg>
  )
}

export function Users({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.4A6.5 6.5 0 0 1 21.5 20" />
    </svg>
  )
}

/** A receipt, for money owed. Reads as "a bill" rather than "a coin". */
export function Receipt({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  )
}

export function TableIcon({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </svg>
  )
}

export function Upload({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 9l5-5 5 5M12 4v12" />
    </svg>
  )
}

export function Archive({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  )
}

export function Search({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function Plus({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TriangleAlert({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function PanelLeft({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  )
}

export function LockKeyhole({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <circle cx="12" cy="16" r="1" />
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export function LogIn({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5M15 12H3" />
    </svg>
  )
}

export function LogOut({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </svg>
  )
}

export function UserPlus({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-4'} aria-hidden>
      <circle cx="10" cy="8" r="4" />
      <path d="M3 21a7 7 0 0 1 14 0" />
      <path d="M19 8v6M16 11h6" />
    </svg>
  )
}

/** The audit log: a page holding lines. */
export function ScrollText({ className, ...p }: IconProps) {
  return (
    <svg {...base} {...p} className={className ?? 'size-5'} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}

/**
 * The crest.
 *
 * Drawn rather than a photograph because it must stay sharp at 40px on a
 * sidebar and at 96px on a sign-in screen, and because an official emblem is
 * better represented by something legible than by something photographic and
 * grey at small sizes.
 */
export function SchoolLogo({ size = 52, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Dandora Secondary School"
      className={className}
    >
      <rect width="64" height="64" rx="14" fill="var(--color-primary)" />
      {/* An open book. Two pages, so it reads at 40px where a single shape is a blob. */}
      <path d="M12 20h17a5 5 0 0 1 5 5v21a6 6 0 0 0-6-4H12Z" fill="#fff" opacity="0.95" />
      <path d="M52 20H35a5 5 0 0 0-5 5v21a6 6 0 0 1 6-4h16Z" fill="var(--color-accent)" />
      <path d="M32 25v21" stroke="var(--color-primary)" strokeWidth="1.5" />
    </svg>
  )
}
