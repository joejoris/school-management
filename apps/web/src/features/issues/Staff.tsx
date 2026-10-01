/**
 * Staff accounts.
 *
 * ── Why this screen was missing, and why it mattered ─────────────────
 *
 * Until now the *only* way to create an account was the first-run setup. Which
 * means a school with two members of staff could not give the second one access —
 * not because it was forbidden, but because there was no button anywhere.
 *
 * Somebody would have shared one login, and then a register would carry a single
 * author's name for every book issued that term. The record of who voided what is
 * worth keeping precisely because it is per-person.
 *
 * ── Nobody can switch themselves off ─────────────────────────────────
 *
 * Both the domain and this screen refuse it, and both for the same reason: the last
 * administrator who disables themselves has locked the school out of its own
 * register, and the only way back is editing the database. Refused at the domain
 * rather than merely hidden, because a hidden button is a button somebody will find
 * a way round.
 *
 * ── Why an assistant cannot be an administrator by accident ──────────
 *
 * The role is chosen on the form, not assigned automatically. \`createUser\` forces the
 * very first account to be an administrator whatever it asks for — somebody has to be
 * able to create the others — but every account after that is exactly what was asked
 * for, so granting the wrong one is a deliberate act rather than a side effect.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Role } from '@library/contracts'
import { api } from '../../api'
import { Button, Card, Field, Input, cn } from '../../components/ui'
import { LogOut, TriangleAlert, UserPlus } from '../../components/icons'

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : 'never'

export function Staff() {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.listUsers(),
    staleTime: 10_000,
  })

  const me = useQuery({
    queryKey: ['session'],
    queryFn: () => api.currentUser(),
    staleTime: 30_000,
  })

  const change = useMutation({
    mutationFn: async (input: { id: string; status?: 'active' | 'disabled'; role?: Role }) => {
      if (input.status) await api.setUserStatus(input.id, input.status)
      if (input.role) await api.setUserRole(input.id, input.role)
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'That did not work.'),
  })

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Staff</h1>
        <p className="text-sm text-muted-foreground">
          Who can sign in, and what they are allowed to do.
        </p>
      </header>

      <AddStaff />

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {users.isPending ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : users.isError ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not load the accounts. {users.error instanceof Error ? users.error.message : ''}
        </p>
      ) : (
        <ul className="grid gap-2">
          {users.data?.map((u) => {
            const self = u.id === me.data?.id
            return (
              <li key={u.id}>
                <Card className={cn('px-4 py-3', u.status === 'disabled' && 'opacity-60')}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {u.name}
                        {self ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {u.email}
                        {' · '}
                        <span className="capitalize">{u.role}</span>
                        {u.status === 'disabled' ? ' · switched off' : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">Last signed in {date(u.lastLoginAt)}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {/* Self-management is refused by the domain, so the control is
                          disabled rather than hidden: a missing button invites the
                          question "can I switch myself off?", and a disabled one with
                          a reason beside it answers it. */}
                      <select
                        aria-label={`Role for ${u.name}`}
                        value={u.role}
                        disabled={self}
                        onChange={(e) => change.mutate({ id: u.id, role: e.target.value as Role })}
                        className="h-10 rounded-lg border border-input bg-card px-2 text-sm disabled:opacity-50"
                      >
                        {Role.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>

                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={self || change.isPending}
                        onClick={() =>
                          change.mutate({
                            id: u.id,
                            status: u.status === 'active' ? 'disabled' : 'active',
                          })
                        }
                      >
                        {u.status === 'active' ? 'Switch off' : 'Switch on'}
                      </Button>
                    </div>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <LogOut className="mt-0.5 size-3.5 shrink-0" />
        <span>
          An assistant can issue books, take them back, work the register and read
          fines. What an assistant cannot do is change these rules or manage accounts —
          the two things that should not be lying around on a shared desk. Nobody can
          switch off their own account, because the last one to do so locks the school
          out.
        </span>
      </p>
    </div>
  )
}

function AddStaff() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('assistant')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () =>
      api.createUser({ name: name.trim(), email: email.trim(), password, role }),
    onSuccess: async () => {
      setName('')
      setEmail('')
      setPassword('')
      setRole('assistant')
      setError(null)
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not add that account.'),
  })

  const canSubmit = name.trim().length > 0 && email.trim().length > 2 && password.length > 0

  if (!open) {
    return (
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          <UserPlus /> Add someone
        </Button>
      </div>
    )
  }

  return (
    <Card className="p-5">
      <h2 className="font-medium">Add someone</h2>

      <form
        className="mt-4 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          add.mutate()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="staff-name">
            <Input
              id="staff-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Wanjiru"
              autoComplete="off"
              autoFocus
            />
          </Field>

          <Field label="Email address" htmlFor="staff-email">
            <Input
              id="staff-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@dandorasecondary.go.ke"
              autoComplete="off"
            />
          </Field>

          <Field label="Password" htmlFor="staff-password" hint="They choose their own when they first sign in.">
            <Input
              id="staff-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <Field
            label="Role"
            htmlFor="staff-role"
            hint="Assistants run the desk. Administrators also manage accounts and these rules."
          >
            <select
              id="staff-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="h-11 w-full rounded-lg border border-input bg-card px-3"
            >
              {Role.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add the account'}
          </Button>
        </div>
      </form>
    </Card>
  )
}