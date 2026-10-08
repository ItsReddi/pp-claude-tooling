import { clip } from './log'

export const TRIGGERS = ['abort', 'correction', 'tool-errors', 'subagent'] as const
export type Trigger = (typeof TRIGGERS)[number]

export const CATEGORIES = [
  'guidance-not-loaded',
  'guidance-ignored',
  'guidance-wrong',
  'guidance-conflict',
  'guidance-missing',
  'subagent-context',
  'tool-friction',
  'other',
] as const
export type Category = (typeof CATEGORIES)[number]

export const CONFIDENCES = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCES)[number]

/**
 * The template every observation follows, whichever session or model wrote it, so the retro
 * can group them by `category` and `tooling` without reading prose.
 */
export type Observation = {
  category: Category
  tooling: string
  summary: string
  evidence: string
  suggestion: string
  confidence: Confidence
}

export type TurnFacts = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  toolErrors: number
  spawnedAgents: number
  isCorrection: boolean
}

/** A single failed call is routine (a grep without match); two in one turn are a pattern. */
export const TOOL_ERROR_THRESHOLD = 2

export function triggersFor(turn: TurnFacts): Trigger[] {
  const triggers: Trigger[] = []

  if (turn.reason === 'aborted') {
    triggers.push('abort')
  }

  if (turn.isCorrection) {
    triggers.push('correction')
  }

  if (turn.toolErrors >= TOOL_ERROR_THRESHOLD) {
    triggers.push('tool-errors')
  }

  if (turn.spawnedAgents > 0) {
    triggers.push('subagent')
  }

  return triggers
}

const LIMITS = { tooling: 160, summary: 240, evidence: 400, suggestion: 400 } as const

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function toObservation(value: unknown): Observation | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const row = value as Record<string, unknown>
  const text = (key: keyof typeof LIMITS): string =>
    typeof row[key] === 'string' ? clip(row[key] as string, LIMITS[key]) : ''

  if (!isOneOf(CATEGORIES, row.category) || !isOneOf(CONFIDENCES, row.confidence)) {
    return undefined
  }

  const observation = {
    category: row.category,
    tooling: text('tooling'),
    summary: text('summary'),
    evidence: text('evidence'),
    suggestion: text('suggestion'),
    confidence: row.confidence,
  }

  return observation.summary === '' || observation.evidence === '' ? undefined : observation
}

/**
 * Reads the observer's reply: one JSON object per line, or NONE. Lines that are not a complete
 * observation are dropped rather than repaired, so a sloppy reply costs data, never shape.
 */
export function parseObservations(reply: string): Observation[] {
  return reply
    .split('\n')
    .map(line => line.trim().replace(/^```(json)?$/, ''))
    .filter(line => line.startsWith('{'))
    .flatMap(line => {
      try {
        const observation = toObservation(JSON.parse(line))

        return observation === undefined ? [] : [observation]
      } catch {
        return []
      }
    })
}
