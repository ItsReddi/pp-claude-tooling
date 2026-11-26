import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Snapshot, Snooze, TrackedSession } from '../types'

const PANE = 'inbox'
const TITLE = 'Inbox'
const REFRESH_MS = 5 * 60 * 1000
const PAGES = 6
const PAGE_SIZE = 35
const MAX_WAITING = 5
const WAIT_WARN_HOURS = 24
const WAIT_ALARM_HOURS = 7 * 24
const RECENT_MS = 3 * 60 * 60 * 1000
const BACKGROUND_FRESH_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SNOOZE_PREFIX = 'inbox-snooze:'
export const SNOOZE_DAYS = [1, 7, 14, 30] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const snapshot = atom(
  { plugin: 'inbox', key: 'snapshot' } as const,
  { sessions: [], fetchedAt: null, error: null } as Snapshot,
  { shape: 'snapshot-4' },
)

const showAllWaiting = atom({ plugin: 'inbox', key: 'showAllWaiting' } as const, false)
const showSnoozed = atom({ plugin: 'inbox', key: 'showSnoozed' } as const, false)
const snoozeMenuFor = atom({ plugin: 'inbox', key: 'snoozeMenuFor' } as const, null as string | null)

type RawSession = {
  id: string
  title?: string
  session_status?: string
  status_bucket?: string
  updated_at?: string
  post_turn_summary?: { needs_action?: string }
  tags?: string[]
}

type RawPage = { data?: RawSession[]; has_more?: boolean; last_id?: string }

export function parsePage(text: string): RawPage {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) {
    const preview = text.trim().slice(0, 160)
    throw new Error(`list_sessions returned no JSON: ${preview === '' ? '(empty)' : preview}`)
  }
  const parsed = JSON.parse(text.slice(start, end + 1))

  return (parsed.ccr ?? parsed) as RawPage
}

const isoSeconds = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`

export function snoozeTag(at: number, days: number): string {
  return `${SNOOZE_PREFIX}${isoSeconds(at)}/${isoSeconds(at + days * DAY_MS)}`
}

export function readSnooze(tags: readonly string[]): Snooze | null {
  const tag = tags.find(t => t.startsWith(SNOOZE_PREFIX))
  const [at, until] = tag?.slice(SNOOZE_PREFIX.length).split('/') ?? []
  if (tag === undefined || at === undefined || until === undefined || Number.isNaN(Date.parse(at)) || Number.isNaN(Date.parse(until))) {
    return null
  }

  return { tag, at, until }
}

export function isSnoozed(s: TrackedSession, now: number): boolean {
  return (
    s.snooze !== null &&
    Date.parse(s.snooze.until) > now &&
    Date.parse(s.updatedAt) <= Date.parse(s.snooze.at)
  )
}

export function track(raw: RawSession[]): TrackedSession[] {
  return raw
    .filter(s => s.session_status !== 'SESSION_STATUS_ARCHIVED')
    .map((s): TrackedSession => {
      const ask = s.post_turn_summary?.needs_action ?? null
      const isBlocked = s.status_bucket === 'SESSION_STATUS_BUCKET_BLOCKED'
      const isReview = s.status_bucket === 'SESSION_STATUS_BUCKET_REVIEW_READY'

      return {
        id: s.id,
        title: s.title ?? s.id,
        isWaiting: isBlocked || isReview || ask !== null,
        reason: isReview && !isBlocked ? 'review' : 'waiting',
        isRunning: s.session_status === 'SESSION_STATUS_RUNNING',
        isBackgroundWorking: s.status_bucket === 'SESSION_STATUS_BUCKET_WORKING',
        ask,
        updatedAt: s.updated_at ?? '',
        snooze: readSnooze(s.tags ?? []),
      }
    })
}

export function waitingOldestFirst(sessions: TrackedSession[]): TrackedSession[] {
  return sessions
    .filter(s => s.isWaiting)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
}

export function waitingOpen(sessions: TrackedSession[], now: number): TrackedSession[] {
  return waitingOldestFirst(sessions).filter(s => !isSnoozed(s, now))
}

export function waitingSnoozed(sessions: TrackedSession[], now: number): TrackedSession[] {
  return waitingOldestFirst(sessions)
    .filter(s => isSnoozed(s, now))
    .sort((a, b) => (a.snooze?.until ?? '').localeCompare(b.snooze?.until ?? ''))
}

export function staleSnoozes(sessions: TrackedSession[], now: number): TrackedSession[] {
  return sessions.filter(s => s.snooze !== null && !isSnoozed(s, now))
}

function isActiveNow(s: TrackedSession, now: number): boolean {
  return s.isRunning || (s.isBackgroundWorking && now - Date.parse(s.updatedAt) <= BACKGROUND_FRESH_MS)
}

export function running(sessions: TrackedSession[], now: number): TrackedSession[] {
  return sessions
    .filter(s => isActiveNow(s, now))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function recentlyActive(sessions: TrackedSession[], now: number): TrackedSession[] {
  return sessions
    .filter(s => !isActiveNow(s, now) && now - Date.parse(s.updatedAt) <= RECENT_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function age(iso: string, now: number): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000)
  if (!Number.isFinite(minutes)) {
    return ''
  }
  if (minutes < 60) {
    return minutes < 1 ? 'now' : `${minutes} min`
  }
  if (minutes < 48 * 60) {
    return `${Math.round(minutes / 60)} h`
  }

  return `${Math.round(minutes / 1440)} d`
}

let isFetching = false
let knownWaitingIds: Set<string> | null = null

export function newlyWaiting(known: Set<string> | null, waiting: TrackedSession[]): TrackedSession[] {
  return known === null ? [] : waiting.filter(s => !known.has(s.id))
}

function showCount($: EngineInterface, waiting: TrackedSession[]): void {
  $.ui.status(
    waiting.length === 0
      ? undefined
      : `${waiting.length} ${waiting.length === 1 ? 'session' : 'sessions'} waiting`,
  )
}

function announce($: EngineInterface, waiting: TrackedSession[]): void {
  for (const s of newlyWaiting(knownWaitingIds, waiting)) {
    $.ui.toast(`Waiting on you: ${s.title}`, { timeoutMs: 8000 })
  }
  knownWaitingIds = new Set(waiting.map(s => s.id))
  showCount($, waiting)
}

async function setTags($: EngineInterface, id: string, add: string[], remove: string[]): Promise<void> {
  const result = await $.mcp.call('claude-code-remote', 'set_session_tags', {
    session_ids: [id],
    ...(add.length > 0 ? { add } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  })
  if (result.isError) {
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    throw new Error(text || 'set_session_tags failed')
  }
}

async function applySnooze($: EngineInterface, id: string, snooze: Snooze | null): Promise<void> {
  await update($, snapshot, old => ({
    ...old,
    sessions: old.sessions.map(s => (s.id === id ? { ...s, snooze } : s)),
  }))
  const { sessions } = await read($, snapshot)
  showCount($, waitingOpen(sessions, await $.clock.now()))
}

async function snoozeFor($: EngineInterface, s: TrackedSession, days: number): Promise<void> {
  const tag = snoozeTag(await $.clock.now(), days)
  try {
    await setTags($, s.id, [tag], s.snooze === null ? [] : [s.snooze.tag])
    await update($, snoozeMenuFor, () => null)
    await applySnooze($, s.id, readSnooze([tag]))
  } catch (error) {
    $.ui.toast(`Snooze failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function unsnooze($: EngineInterface, s: TrackedSession): Promise<void> {
  if (s.snooze === null) {
    return
  }
  try {
    await setTags($, s.id, [], [s.snooze.tag])
    knownWaitingIds?.add(s.id)
    await applySnooze($, s.id, null)
  } catch (error) {
    $.ui.toast(`Unsnooze failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function clearStaleSnoozes($: EngineInterface, sessions: TrackedSession[], now: number): Promise<void> {
  for (const s of staleSnoozes(sessions, now)) {
    try {
      await setTags($, s.id, [], [s.snooze?.tag ?? ''])
    } catch {
      return
    }
  }
}

function untilDay(iso: string): string {
  const d = new Date(iso)

  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

async function refresh($: EngineInterface): Promise<void> {
  if (isFetching) {
    return
  }
  isFetching = true
  try {
    const raw: RawSession[] = []
    let after: string | undefined
    for (let page = 0; page < PAGES; page++) {
      const result = await $.mcp.call('claude-code-remote', 'list_sessions', {
        mine: true,
        limit: PAGE_SIZE,
        ...(after ? { after_id: after } : {}),
      })
      const text = result.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
      if (result.isError) {
        throw new Error(text || 'list_sessions failed')
      }
      const parsed: RawPage =
        result.structuredContent !== null && typeof result.structuredContent === 'object'
          ? (((result.structuredContent as { ccr?: RawPage }).ccr ?? result.structuredContent) as RawPage)
          : parsePage(text)
      raw.push(...(parsed.data ?? []))
      if (!parsed.has_more || !parsed.last_id) {
        break
      }
      after = parsed.last_id
    }
    const fetchedAt = await $.clock.now()
    const sessions = track(raw)
    await update($, snapshot, old => ({
      sessions: JSON.stringify(old.sessions) === JSON.stringify(sessions) ? old.sessions : sessions,
      fetchedAt,
      error: null,
    }))
    announce($, waitingOpen(sessions, fetchedAt))
    void clearStaleSnoozes($, sessions, fetchedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, snapshot, old => ({ ...old, error: message }))
  } finally {
    isFetching = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'inbox',
      description: 'Open the inbox pane and refresh the session list',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'inbox' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const { sessions } = await read($, snapshot)

    return { text: `${waitingOpen(sessions, await $.clock.now()).length} sessions waiting on you.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const state = await read($, snapshot)
    const now = await $.clock.now()
    const waiting = waitingOpen(state.sessions, now)
    const snoozed = waitingSnoozed(state.sessions, now)
    const isSnoozedShown = await read($, showSnoozed)
    const menuFor = await read($, snoozeMenuFor)
    const busy = running(state.sessions, now)
    const recent = recentlyActive(state.sessions, now)
    const isLoaded = state.fetchedAt !== null
    const isExpanded = await read($, showAllWaiting)
    const hidden = waiting.length - MAX_WAITING
    const standAge = age(new Date(state.fetchedAt ?? now).toISOString(), now)

    const heading = (color: string, title: string, count: number) => (
      <Box key={`heading-${title}`} flexDirection="row" gap="sm" alignItems="center">
        <Text color={color}>●</Text>
        <Text size="heading" weight="semibold">
          {title}
        </Text>
        <Text dimColor tabular>
          {count}
        </Text>
      </Box>
    )

    const card = (
      s: TrackedSession,
      accent: string,
      detail: string,
      ageColor?: string,
      headerAction?: RenderChildren,
      actions?: RenderChildren,
    ) => (
      <Box
        key={s.id}
        flexDirection="column"
        gap="xs"
        borderStyle="round"
        borderColor={accent}
        paddingX="sm"
        paddingY="xs"
      >
        <Box flexDirection="row" justifyContent="space-between" gap="sm">
          <Box flexShrink={1}>
            <Link href={`https://claude.ai/code/${s.id}`} label={s.title} />
          </Box>
          <Box flexDirection="row" gap="sm" alignItems="center" flexShrink={0}>
            {headerAction}
            <Text size="footnote" tabular wrap="truncate" color={ageColor} dimColor={ageColor === undefined}>
              {age(s.updatedAt, now)}
            </Text>
          </Box>
        </Box>
        {detail !== '' && (
          <Text size="footnote" dimColor maxLines={2}>
            {detail}
          </Text>
        )}
        {actions}
      </Box>
    )

    const snoozeButton = (s: TrackedSession) => (
      <Button
        key={`snooze-${s.id}`}
        label={menuFor === s.id ? 'Cancel' : 'Snooze'}
        plain
        dimColor
        onPress={() => update($, snoozeMenuFor, open => (open === s.id ? null : s.id))}
      />
    )

    const snoozeChoices = (s: TrackedSession) =>
      menuFor === s.id && (
        <Box key={`snooze-row-${s.id}`} flexDirection="row" gap="sm" alignItems="center">
          <Text size="footnote" dimColor>
            Snooze for
          </Text>
          {SNOOZE_DAYS.map(days => (
            <Button key={`snooze-${s.id}-${days}`} label={`${days} d`} plain onPress={() => void snoozeFor($, s, days)} />
          ))}
        </Box>
      )

    const waitColor = (s: TrackedSession) => {
      const hours = (now - Date.parse(s.updatedAt)) / 3600000

      return hours >= WAIT_ALARM_HOURS ? 'error' : hours >= WAIT_WARN_HOURS ? 'warning' : 'success'
    }

    return (
      <Box key="root" flexDirection="column" gap="md">
        <Box key="toolbar" flexDirection="row" gap="sm" alignItems="center">
          <Button key="refresh" label="Refresh" onPress={() => {
              void refresh($)
            }} />
          {isLoaded && (
            <Text size="caption" dimColor>
              Updated {standAge === 'now' ? 'just now' : `${standAge} ago`}
            </Text>
          )}
        </Box>
        {!isLoaded && state.error === null && <Text dimColor>Loading sessions…</Text>}
        {state.error !== null && <Text color="error">Loading failed: {state.error}</Text>}
        {isLoaded && (
          <Box key="section-running" flexDirection="column" gap="sm">
            {heading('success', 'Running now', busy.length)}
            {busy.length === 0 && <Text dimColor>No session running.</Text>}
            {busy.map(s =>
              card(s, 'success', [s.isRunning ? '' : 'background work', s.isWaiting ? 'also waiting on you' : ''].filter(Boolean).join(' · ')),
            )}
          </Box>
        )}
        {isLoaded && (
          <Box key="section-recent" flexDirection="column" gap="sm">
            {heading('inactive', 'Recently active (3 h)', recent.length)}
            {recent.length === 0 && <Text dimColor>None.</Text>}
            {recent.map(s =>
              card(s, 'subtle', s.isWaiting ? 'also waiting on you' : ''),
            )}
          </Box>
        )}
        {isLoaded && (
          <Box key="section-waiting" flexDirection="column" gap="sm">
            {heading('warning', 'Waiting on you', waiting.length)}
            {waiting.length === 0 && <Text dimColor>Nothing open.</Text>}
            {waiting
              .slice(0, isExpanded ? waiting.length : MAX_WAITING)
              .map(s =>
                card(
                  s,
                  'warning',
                  `${s.reason}${s.ask !== null ? ` · ${s.ask}` : ''}`,
                  waitColor(s),
                  snoozeButton(s),
                  snoozeChoices(s),
                ),
              )}
            {hidden > 0 && (
              <Box key="toggle-row" flexDirection="row">
                <Button
                  key="toggle-waiting"
                  label={isExpanded ? 'Show less' : `+ ${hidden} more`}
                  onPress={() => update($, showAllWaiting, value => !value)}
                />
              </Box>
            )}
            {snoozed.length > 0 && (
              <Box key="snoozed-toggle-row" flexDirection="row">
                <Button
                  key="toggle-snoozed"
                  label={isSnoozedShown ? 'Hide snoozed' : `${snoozed.length} snoozed`}
                  onPress={() => update($, showSnoozed, value => !value)}
                />
              </Box>
            )}
            {isSnoozedShown &&
              snoozed.map(s => (
                <Box key={`snoozed-${s.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
                  <Box flexShrink={1}>
                    <Link href={`https://claude.ai/code/${s.id}`} label={s.title} />
                  </Box>
                  <Box flexDirection="row" gap="xs" alignItems="center" flexShrink={0}>
                    <Text size="footnote" dimColor>
                      until {untilDay(s.snooze?.until ?? '')}
                    </Text>
                    <Button key={`unsnooze-${s.id}`} label="Unsnooze" plain dimColor onPress={() => void unsnooze($, s)} />
                  </Box>
                </Box>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
