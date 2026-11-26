export type TrackedSession = {
  id: string
  title: string
  isWaiting: boolean
  reason: 'waiting' | 'review'
  isRunning: boolean
  isBackgroundWorking: boolean
  ask: string | null
  updatedAt: string
  snooze: Snooze | null
}

export type Snooze = { tag: string; at: string; until: string }

export type Snapshot = {
  sessions: TrackedSession[]
  fetchedAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'inbox': {
      snapshot: Shaped<Snapshot>
      showAllWaiting: boolean
      showSnoozed: boolean
      snoozeMenuFor: string | null
    }
  }
}
