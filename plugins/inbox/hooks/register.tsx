import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, TrackedSession } from '../types'

const PANE = 'inbox'
const TITLE = 'Inbox'
const REFRESH_MS = 5 * 60 * 1000
const PAGES = 6
const PAGE_SIZE = 35
const MAX_WAITING = 5
const WAIT_WARN_HOURS = 24
const WAIT_ALARM_HOURS = 7 * 24
const RECENT_MS = 3 * 60 * 60 * 1000

const snapshot = atom(
  { plugin: 'inbox', key: 'snapshot' } as const,
  { sessions: [], fetchedAt: null, error: null } as Snapshot,
  { shape: 'snapshot-2' },
)

const showAllWaiting = atom({ plugin: 'inbox', key: 'showAllWaiting' } as const, false)

type RawSession = {
  id: string
  title?: string
  session_status?: string
  status_bucket?: string
  updated_at?: string
  post_turn_summary?: { needs_action?: string }
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
        ask,
        updatedAt: s.updated_at ?? '',
      }
    })
}

export function waitingOldestFirst(sessions: TrackedSession[]): TrackedSession[] {
  return sessions
    .filter(s => s.isWaiting)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
}

export function running(sessions: TrackedSession[]): TrackedSession[] {
  return sessions
    .filter(s => s.isRunning)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function recentlyActive(sessions: TrackedSession[], now: number): TrackedSession[] {
  return sessions
    .filter(s => !s.isRunning && now - Date.parse(s.updatedAt) <= RECENT_MS)
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

function announce($: EngineInterface, waiting: TrackedSession[]): void {
  for (const s of newlyWaiting(knownWaitingIds, waiting)) {
    $.ui.toast(`Waiting on you: ${s.title}`, { timeoutMs: 8000 })
  }
  knownWaitingIds = new Set(waiting.map(s => s.id))
  $.ui.status(
    waiting.length === 0
      ? undefined
      : `${waiting.length} ${waiting.length === 1 ? 'session' : 'sessions'} waiting`,
  )
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
    announce($, waitingOldestFirst(sessions))
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

    return { text: `${waitingOldestFirst(sessions).length} sessions waiting on you.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const state = await read($, snapshot)
    const now = await $.clock.now()
    const waiting = waitingOldestFirst(state.sessions)
    const busy = running(state.sessions)
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

    const card = (s: TrackedSession, accent: string, detail: string, ageColor?: string) => (
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
          <Box flexShrink={0}>
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
              card(s, 'success', s.isWaiting ? 'also waiting on you' : ''),
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
              .map(s => card(s, 'warning', `${s.reason}${s.ask !== null ? ` · ${s.ask}` : ''}`, waitColor(s)))}
            {hidden > 0 && (
              <Box key="toggle-row" flexDirection="row">
                <Button
                  key="toggle-waiting"
                  label={isExpanded ? 'Show less' : `+ ${hidden} more`}
                  onPress={() => update($, showAllWaiting, value => !value)}
                />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
