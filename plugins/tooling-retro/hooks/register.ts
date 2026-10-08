import type { EngineInterface, Register } from 'claude-code'

import { clip, describeCall, isGuidancePath, type LogEntry, toLine, withoutCredentials } from './log'
import { parseObservations, type Trigger, triggersFor } from './observe'

type Repo = { root: string; gitDir: string }
type Entry = Omit<LogEntry, 'at'>

type Stats = {
  session: string
  day: string
  model: string | null
  remote: string | null
  turns: number
  aborts: number
  corrections: number
  toolCalls: number
  toolErrors: number
  guidanceReads: number
  skills: Record<string, number>
  subagents: Record<string, number>
  observerRuns: number
  observations: number
}

type SessionState = {
  id: string
  raw: string
  observations: string
  stats: Stats
  isStatsDirty: boolean
  isObservationsDirty: boolean
  lastPushAt: number
}

type TurnState = { hasActed: boolean; toolErrors: number; spawnedAgents: number }

const COMMAND = 'tooling-retro'
const LOG_BRANCH = 'chore/tooling-retro'
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const ACTING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const CORRECTION_LABELS = ['correction', 'follow-up', 'new-task'] as const
const MAX_OBSERVER_RUNS = 20
const MAX_LOGGED_REPLY_CHARS = 4000
const STATS_PUSH_INTERVAL_MS = 15 * 60_000
const MAX_RAW_CHARS = 3_500_000
const PUSH_ATTEMPTS = 3

let isPushEnabled = true
let repo: Repo | undefined | null = null
let state: SessionState | undefined
let turn: TurnState = { hasActed: false, toolErrors: 0, spawnedAgents: 0 }
let hasPreviousTurnActed = false
let pendingCorrection: Promise<boolean> = Promise.resolve(false)
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)

  return next
}

async function git($: EngineInterface, root: string, args: readonly string[], env?: Record<string, string>) {
  return $.process.run(['git', ...args], { cwd: root, env, timeoutMs: 60_000 })
}

async function gitOut($: EngineInterface, root: string, args: readonly string[], env?: Record<string, string>) {
  const ran = await git($, root, args, env)

  if (ran.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${ran.stderr.trim().slice(0, 300)}`)
  }

  return ran.stdout.trim()
}

async function resolveRepo($: EngineInterface): Promise<Repo | undefined> {
  if (repo !== null) {
    return repo
  }

  const found = await $.session.repo()

  if (found === null || found.remote === null) {
    repo = undefined

    return repo
  }

  const ran = await git($, found.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  repo = ran.exitCode === 0 ? { root: found.root, gitDir: ran.stdout.trim() } : undefined

  return repo
}

function localPath(found: Repo, sessionId: string, suffix: string): string {
  return `${found.gitDir}/tooling-retro/${sessionId}${suffix}`
}

async function readOrEmpty($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

/**
 * The state of the session the engine runs now. A /clear starts a new session id, so the state
 * is rebuilt from the local files whenever the id changes, and after a hot reload.
 */
async function currentSession($: EngineInterface, found: Repo, sessionId?: string): Promise<SessionState> {
  const id = sessionId ?? (await $.session.id())

  if (state !== undefined && state.id === id) {
    return state
  }

  const statsText = await readOrEmpty($, localPath(found, id, '.stats.json'))
  const remoteUrl = (await $.session.repo())?.remote
  const remote = remoteUrl === undefined || remoteUrl === null ? null : withoutCredentials(remoteUrl)
  const stats: Stats =
    statsText === ''
      ? {
          session: id,
          day: (await nowIso($)).slice(0, 10),
          model: await $.session.model(),
          remote,
          turns: 0,
          aborts: 0,
          corrections: 0,
          toolCalls: 0,
          toolErrors: 0,
          guidanceReads: 0,
          skills: {},
          subagents: {},
          observerRuns: 0,
          observations: 0,
        }
      : (JSON.parse(statsText) as Stats)

  state = {
    id,
    raw: await readOrEmpty($, localPath(found, id, '.jsonl')),
    observations: await readOrEmpty($, localPath(found, id, '.observations.jsonl')),
    stats,
    isStatsDirty: false,
    isObservationsDirty: false,
    lastPushAt: 0,
  }

  return state
}

function record($: EngineInterface, entry: Entry, update?: (stats: Stats) => void, sessionId?: string): Promise<void> {
  return serial(() => writeRaw($, entry, update, sessionId))
}

async function writeRaw($: EngineInterface, entry: Entry, update?: (stats: Stats) => void, sessionId?: string) {
  const found = await resolveRepo($)

  if (found === undefined) {
    return
  }

  const session = await currentSession($, found, sessionId)

  if (update !== undefined) {
    update(session.stats)
    session.isStatsDirty = true
  }

  if (session.raw.length > MAX_RAW_CHARS) {
    return
  }

  session.raw += toLine({ ...entry, at: await nowIso($) } as LogEntry)
  await $.fs.write(localPath(found, session.id, '.jsonl'), session.raw)
}

async function persistStats($: EngineInterface, found: Repo, session: SessionState): Promise<void> {
  await $.fs.write(localPath(found, session.id, '.stats.json'), `${JSON.stringify(session.stats, null, 2)}\n`)
}

function flush($: EngineInterface, isForced: boolean): Promise<void> {
  return serial(() => pushIfDue($, isForced))
}

async function pushIfDue($: EngineInterface, isForced: boolean): Promise<void> {
  const found = await resolveRepo($)

  if (found === undefined || state === undefined) {
    return
  }

  const session = state
  await persistStats($, found, session)
  const now = await $.clock.now()
  const isStatsDue = session.isStatsDirty && (isForced || now - session.lastPushAt >= STATS_PUSH_INTERVAL_MS)

  if (!isPushEnabled || session.stats.turns === 0 || (!session.isObservationsDirty && !isStatsDue)) {
    return
  }

  try {
    await pushSession($, found, session)
    session.isStatsDirty = false
    session.isObservationsDirty = false
    session.lastPushAt = now
    $.ui.status(undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'push failed'

    if (/\b40[37]\b/.test(message)) {
      isPushEnabled = false
      $.ui.status(`tooling-retro: push to ${LOG_BRANCH} refused by policy, observations stay local`)

      return
    }

    $.ui.status(`tooling-retro: ${message.slice(0, 120)}`)
  }
}

/**
 * Commits the session's observations and stats onto the log branch without touching the working
 * tree or the real index: a temporary index, `commit-tree`, and a push of that commit. The raw
 * event log never leaves the machine. Each session owns its files, so a rejected push only needs
 * a refetch, never a merge. The commit uses the person's own git identity.
 */
async function pushSession($: EngineInterface, found: Repo, session: SessionState): Promise<void> {
  const files = [{ source: localPath(found, session.id, '.stats.json'), target: `stats/${session.stats.day}/${session.id}.json` }]

  if (session.observations !== '') {
    files.push({
      source: localPath(found, session.id, '.observations.jsonl'),
      target: `observations/${session.stats.day}/${session.id}.jsonl`,
    })
  }

  const index = { GIT_INDEX_FILE: `${found.gitDir}/tooling-retro/index.tmp` }
  const root = found.root
  let lastError = ''

  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    const fetched = await git($, root, ['fetch', '--quiet', 'origin', `+refs/heads/${LOG_BRANCH}:refs/tooling-retro/remote`])
    const parent = fetched.exitCode === 0 ? await gitOut($, root, ['rev-parse', 'refs/tooling-retro/remote']) : undefined

    await gitOut($, root, parent === undefined ? ['read-tree', '--empty'] : ['read-tree', parent], index)

    for (const file of files) {
      const blob = await gitOut($, root, ['hash-object', '-w', file.source])
      await gitOut($, root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.target}`], index)
    }

    const tree = await gitOut($, root, ['write-tree'], index)

    if (parent !== undefined && tree === (await gitOut($, root, ['rev-parse', `${parent}^{tree}`]))) {
      return
    }

    const commit = await gitOut($, root, [
      'commit-tree',
      tree,
      ...(parent === undefined ? [] : ['-p', parent]),
      '-m',
      `tooling-retro: ${session.stats.observations} observations, session ${session.id}`,
    ])
    const pushed = await git($, root, ['push', '--quiet', 'origin', `${commit}:refs/heads/${LOG_BRANCH}`])

    if (pushed.exitCode === 0) {
      return
    }

    lastError = pushed.stderr.trim().slice(0, 300)
  }

  throw new Error(`push to ${LOG_BRANCH} failed: ${lastError}`)
}

async function classifyCorrection($: EngineInterface, text: string): Promise<boolean> {
  try {
    return (await $.model.classify(clip(text, 2000), CORRECTION_LABELS)) === 'correction'
  } catch {
    return false
  }
}

/**
 * Asks a fork of this very session, which sees the whole conversation from the prompt cache,
 * whether the triggers point at the repository's tooling. Only the parsed observations are kept.
 */
async function observe($: EngineInterface, triggers: readonly Trigger[]): Promise<void> {
  const found = await resolveRepo($)

  if (found === undefined) {
    return
  }

  try {
    await runObserver($, found, triggers)
  } finally {
    await flush($, false)
  }
}

async function runObserver($: EngineInterface, found: Repo, triggers: readonly Trigger[]): Promise<void> {
  const template = await $.fs.read(`${$.plugin.root}/prompts/observer.md`)
  const reply = await $.model.fork({ prompt: template.replaceAll('{{triggers}}', triggers.join(', ')) })

  if (!reply.isAnswered) {
    await record($, { type: 'observer', triggers, outcome: reply.reason })

    return
  }

  const observations = parseObservations(reply.text)
  await record($, {
    type: 'observer',
    triggers,
    outcome: `${observations.length} observations`,
    reply: clip(reply.text, MAX_LOGGED_REPLY_CHARS),
  })

  if (observations.length === 0) {
    return
  }

  const at = await nowIso($)
  const model = await $.session.model()

  await serial(async () => {
    const session = await currentSession($, found)
    session.observations += observations.map(observation => toLine({ ...observation, triggers, model, at } as unknown as LogEntry)).join('')
    session.stats.observations += observations.length
    session.isObservationsDirty = true
    session.isStatsDirty = true
    await $.fs.write(localPath(found, session.id, '.observations.jsonl'), session.observations)
  })

  $.ui.toast(`tooling-retro: ${observations.length} ${observations.length === 1 ? 'observation' : 'observations'} noted`)
  $.ui.invalidate('ui.render')
}

async function startRetro($: EngineInterface, focus: string): Promise<void> {
  const template = await $.fs.read(`${$.plugin.root}/prompts/tooling-retro.md`)
  const text = template
    .replaceAll('{{branch}}', LOG_BRANCH)
    .replaceAll('{{focus}}', focus === '' ? 'none, cover everything' : focus)

  await flush($, true)
  await $.prompt.submit({ text })
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

export const register: Register = (on, options) => {
  isPushEnabled = options.push !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: `Retro over the observations on ${LOG_BRANCH}: how skills, agents and repo tooling should change`,
      argumentHint: '[focus]',
    })
    void record($, { type: 'session_start', model: await $.session.model(), interactive: e.isInteractive })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (HUMAN_ORIGINS.has(e.origin.kind)) {
      pendingCorrection = hasPreviousTurnActed ? classifyCorrection($, e.text) : Promise.resolve(false)
      void record($, { type: 'prompt', origin: e.origin.kind, text: clip(e.text, 400) })
    }

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    void record($, { type: 'skill', skill: e.skill }, stats => increment(stats.skills, e.skill))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    turn.spawnedAgents++
    void record(
      $,
      { type: 'agent', agentId: e.parentAgentId, subagentType: e.subagentType, description: clip(e.description, 120) },
      stats => increment(stats.subagents, e.subagentType),
    )

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const target = describeCall(tool, e as unknown as Record<string, unknown>, repo?.root)
    const hasFailed = ran.deny !== undefined || ran.isError === true
    const isGuidance = isGuidancePath(target)

    if (hasFailed) {
      turn.toolErrors++
    }

    if (e.agentId === undefined && ACTING_TOOLS.has(tool)) {
      turn.hasActed = true
    }

    void record(
      $,
      {
        type: 'tool',
        tool,
        agentId: e.agentId,
        target,
        ...(isGuidance ? { guidance: true } : {}),
        ...(hasFailed ? { error: clip(ran.deny ?? ran.text ?? '', 400) } : {}),
      },
      stats => {
        stats.toolCalls++
        stats.toolErrors += hasFailed ? 1 : 0
        stats.guidanceReads += isGuidance ? 1 : 0
      },
    )

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      return done
    }

    const finished = turn
    turn = { hasActed: false, toolErrors: 0, spawnedAgents: 0 }
    hasPreviousTurnActed = finished.hasActed

    const isCorrection = await pendingCorrection
    pendingCorrection = Promise.resolve(false)
    const triggers = triggersFor({ reason: e.reason, toolErrors: finished.toolErrors, spawnedAgents: finished.spawnedAgents, isCorrection })
    let isObserving = false

    await record($, { type: 'turn_end', reason: e.reason, triggers }, stats => {
      stats.turns++
      stats.aborts += e.reason === 'aborted' ? 1 : 0
      stats.corrections += isCorrection ? 1 : 0

      if (triggers.length > 0 && stats.observerRuns < MAX_OBSERVER_RUNS) {
        stats.observerRuns++
        isObserving = true
      }
    })

    void (isObserving ? observe($, triggers) : flush($, false))

    return done
  })

  on('session.end', async ($, e, next) => {
    await record($, { type: 'session_end', reason: e.reason }, undefined, e.sessionId)
    await flush($, true)

    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const count = state?.stats.observations ?? 0

    return count === 0 ? next(e) : next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · tooling-retro: ${count}` } })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    void startRetro($, e.args.trim())

    return { text: `Tooling retro over ${LOG_BRANCH} starts once this session's observations are pushed.` }
  })
}
