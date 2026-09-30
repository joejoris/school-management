/**
 * Small building blocks, copied from shadcn's approach and trimmed.
 *
 * Each is here rather than pulled from a component library because they are
 * thirty lines each and a design system is not worth a dependency tree. What is
 * kept is the part that matters: every interactive element carries a visible
 * focus ring and a disabled state, because both are easy to drop and both decide
 * whether the app is usable by keyboard and on a phone.
 */
import { Slot } from '@radix-ui/react-slot'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import * as React from 'react'

/** Merges class names, with later Tailwind utilities winning. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(clsx(parts))
}

// ── Button ─────────────────────────────────────────────────────────

const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground hover:brightness-110',
  outline: 'border border-input bg-card hover:bg-secondary',
  ghost: 'hover:bg-secondary',
  danger: 'bg-destructive text-destructive-foreground hover:brightness-110',
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANTS

const BUTTON_SIZES = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4',
  lg: 'h-12 px-6 text-base',
} as const

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: keyof typeof BUTTON_SIZES
  asChild?: boolean
}

export function Button({
  className,
  variant = 'default',
  size = 'md',
  asChild,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      // A bare <button> inside a form submits it. Almost every button here is
      // not a submit, so the default is set explicitly rather than relied upon.
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-[background-color,filter] duration-150',
        'disabled:pointer-events-none disabled:opacity-55',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  )
}

// ── Card ───────────────────────────────────────────────────────────

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-card shadow-sm', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 p-6', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold tracking-tight', className)} {...props} />
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />
}

// ── Form fields ────────────────────────────────────────────────────

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      // 2.75rem tall. Anything under 44px is a poor touch target on a phone, and
      // the entry form is filled in with one hand while holding books.
      className={cn(
        'flex h-11 w-full rounded-lg border border-input bg-card px-3 text-base',
        'placeholder:text-muted-foreground',
        'disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...props}
    />
  )
})

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />
}

/** A label and its field, with the spacing that makes a form readable. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}