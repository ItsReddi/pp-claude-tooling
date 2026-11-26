import { expect, test } from 'claude-code/testing'

import {
  isSnoozed,
  newlyWaiting,
  readSnooze,
  recentlyActive,
  running,
  snoozeTag,
  track,
  waitingOldestFirst,
  waitingOpen,
} from '../hooks/register'

const NOW = Date.parse('2026-11-26T08:00:00Z')

const PANE = {
  plugin: 'inbox',
  component: 'Pane',
  requestId: 'inbox',
  props: {
    title: 'Inbox',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PAGE = {
  ccr: {
    data: [
      {
        id: 'session_blocked',
        title: 'Fix login redirect',
        session_status: 'SESSION_STATUS_IDLE',
        status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
        updated_at: '2026-11-26T07:00:00Z',
        post_turn_summary: { needs_action: 'Should I open the pull request?' },
      },
      {
        id: 'session_review',
        title: 'Review release notes',
        session_status: 'SESSION_STATUS_IDLE',
        status_bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
        updated_at: '2026-10-01T11:33:24Z',
      },
      {
        id: 'session_running',
        title: 'Running long',
        session_status: 'SESSION_STATUS_RUNNING',
        status_bucket: 'SESSION_STATUS_BUCKET_WORKING',
        updated_at: '2026-11-20T10:00:00Z',
      },
      {
        id: 'session_done',
        title: 'Finished recently',
        session_status: 'SESSION_STATUS_IDLE',
        status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED',
        updated_at: '2026-11-26T06:00:00Z',
      },
      {
        id: 'session_archived',
        title: 'Archived with a question',
        session_status: 'SESSION_STATUS_ARCHIVED',
        status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED',
        updated_at: '2026-11-26T07:30:00Z',
        post_turn_summary: { needs_action: 'Soll ich?' },
      },
    ],
    has_more: false,
  },
}

const RUN = {
  command: 'inbox',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

function engine(on: any, answer: () => unknown) {
  on('command.register', () => ({ value: { command: 'inbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('mcp.call', () => ({ value: answer() }))
}

test('lists waiting and working sessions as links, on every surface', async ($, on) => {
  engine(on, () => ({ content: [{ type: 'text', text: `<x>${JSON.stringify(PAGE)}</x>` }], isError: false }))

  const reply = await $.command.run(RUN)
  expect(reply.text).toBe('2 sessions waiting on you.')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Waiting on you$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Should I open the pull request/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Running now$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Recently active/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Running long/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Archived/ })).toBeUndefined()
    await ui.unmount()
  }
})

const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600000).toISOString()

test('waiting is oldest first; running includes background work updated in the last 15 minutes; recent is the rest of the last three hours', () => {
  const raw = [
    ...[1, 9, 3, 7, 5, 2].map(h => ({ id: `w${h}`, title: `w${h}`, status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(h) })),
    { id: 'old-running', title: 'old-running', session_status: 'SESSION_STATUS_RUNNING', updated_at: at(30) },
    { id: 'idle-4h', title: 'idle-4h', status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED', updated_at: at(4) },
    { id: 'stale-bucket', title: 'stale-bucket', session_status: 'SESSION_STATUS_IDLE', status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: at(10) },
    { id: 'subagents', title: 'subagents', session_status: 'SESSION_STATUS_IDLE', status_bucket: 'SESSION_STATUS_BUCKET_WORKING', updated_at: at(0.1) },
  ]
  const sessions = track(raw)

  expect(waitingOldestFirst(sessions).map(s => s.id)).toEqual(['w9', 'w7', 'w5', 'w3', 'w2', 'w1'])
  expect(running(sessions, NOW).map(s => s.id)).toEqual(['subagents', 'old-running'])
  expect(recentlyActive(sessions, NOW).map(s => s.id)).toEqual(['w1', 'w2', 'w3'])
})

test('a failed call shows the error', async ($, on) => {
  engine(on, () => ({ content: [{ type: 'text', text: 'server down' }], isError: true }))

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toBe('Loading failed: server down')
  await ui.unmount()
})

test('only sessions that were not waiting at the previous load are announced, none at the first', () => {
  const sessions = track([
    { id: 'a', title: 'a', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(1) },
    { id: 'b', title: 'b', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(2) },
  ])

  expect(newlyWaiting(null, sessions)).toEqual([])
  expect(newlyWaiting(new Set(['a']), sessions).map(s => s.id)).toEqual(['b'])
})

test('the extra waiting sessions fold out and back in', async ($, on) => {
  const many = {
    ccr: {
      data: [1, 2, 3, 4, 5, 6, 7].map(h => ({
        id: `w${h}`,
        title: `Waiting ${h}`,
        session_status: 'SESSION_STATUS_IDLE',
        status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED',
        updated_at: at(h * 24),
      })),
      has_more: false,
    },
  }
  engine(on, () => ({ content: [{ type: 'text', text: JSON.stringify(many) }], isError: false }))
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Waiting 1$/ })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-waiting' }))?.text).toBe('+ 2 more')

  await ui.press({ key: 'toggle-waiting' })
  expect(await ui.find({ type: 'Link', text: /Waiting 1$/ })).toBeDefined()
  expect((await ui.find({ key: 'toggle-waiting' }))?.text).toBe('Show less')

  await ui.press({ key: 'toggle-waiting' })
  expect(await ui.find({ type: 'Link', text: /Waiting 1$/ })).toBeUndefined()
  await ui.unmount()
})

test('a later page that does not parse keeps the last complete list and shows the error', async ($, on) => {
  const firstLoad = {
    ccr: {
      data: [{ id: 'kept', title: 'Kept waiting', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(48) }],
      has_more: false,
    },
  }
  const pageOne = {
    ccr: {
      data: [{ id: 'new', title: 'Newer', status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED', updated_at: at(1) }],
      has_more: true,
      last_id: 'new',
    },
  }
  const replies = [JSON.stringify(firstLoad), JSON.stringify(pageOne), 'Error: result exceeds maximum allowed tokens']
  let call = 0
  engine(on, () => ({ content: [{ type: 'text', text: replies[call++] ?? '' }], isError: false }))

  await $.command.run(RUN)
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Kept waiting/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Newer/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Loading failed: list_sessions returned no JSON/ })).toBeDefined()
  await ui.unmount()
})

test('a snooze tag reads back, hides the session until it runs out, and lets new activity through', () => {
  const tag = snoozeTag(NOW, 7)
  expect(tag).toBe('inbox-snooze:2026-11-26T08:00:00Z/2026-12-03T08:00:00Z')
  expect(readSnooze(['other', tag])).toEqual({ tag, at: '2026-11-26T08:00:00Z', until: '2026-12-03T08:00:00Z' })
  expect(readSnooze(['inbox-snooze:garbage'])).toBeNull()

  const [quiet, active] = track([
    { id: 'quiet', title: 'quiet', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(2), tags: [tag] },
    { id: 'active', title: 'active', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(-1), tags: [tag] },
  ])
  if (quiet === undefined || active === undefined) {
    throw new Error('track dropped a session')
  }

  expect(isSnoozed(quiet, NOW)).toBe(true)
  expect(isSnoozed(quiet, NOW + 8 * 24 * 3600000)).toBe(false)
  expect(isSnoozed(active, NOW + 3600000)).toBe(false)
  expect(waitingOpen([quiet, active], NOW + 3600000).map(s => s.id)).toEqual(['active'])
})

test('snooze and unsnooze from the pane set and clear the tag', async ($, on) => {
  const page = {
    ccr: {
      data: [{ id: 'ask', title: 'Open question', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(30) }],
      has_more: false,
    },
  }
  const tagCalls: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'inbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('mcp.call', (_: unknown, e: { tool: string; args: Record<string, unknown> }) => {
    if (e.tool === 'set_session_tags') {
      tagCalls.push(e.args)
      return { value: { content: [{ type: 'text', text: '{"updated":1}' }], isError: false } }
    }
    return { value: { content: [{ type: 'text', text: JSON.stringify(page) }], isError: false } }
  })
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'snooze-ask' })
  await ui.press({ key: 'snooze-ask-7' })

  expect(tagCalls).toEqual([{ session_ids: ['ask'], add: ['inbox-snooze:2026-11-26T08:00:00Z/2026-12-03T08:00:00Z'] }])
  expect(await ui.find({ key: 'snooze-ask-7' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: /Open question/ })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-snoozed' }))?.text).toBe('1 snoozed')

  await ui.press({ key: 'toggle-snoozed' })
  expect(await ui.find({ type: 'Text', text: /until 3 Dec/ })).toBeDefined()
  await ui.press({ key: 'unsnooze-ask' })

  expect(tagCalls[1]).toEqual({ session_ids: ['ask'], remove: ['inbox-snooze:2026-11-26T08:00:00Z/2026-12-03T08:00:00Z'] })
  expect(await ui.find({ key: 'toggle-snoozed' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: /Open question/ })).toBeDefined()
  await ui.unmount()
})

test('a recently active session that is snoozed drops the also waiting label', async ($, on) => {
  const page = {
    ccr: {
      data: [{ id: 'recent', title: 'Recent question', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', updated_at: at(1), tags: [snoozeTag(NOW - 1000, 7)] }],
      has_more: false,
    },
  }
  engine(on, () => ({ content: [{ type: 'text', text: JSON.stringify(page) }], isError: false }))
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Recent question/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /also waiting on you/ })).toBeUndefined()
  await ui.unmount()
})
