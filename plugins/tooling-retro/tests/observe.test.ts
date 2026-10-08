import { expect, test } from 'claude-code/testing'

import { parseObservations, triggersFor } from '../hooks/observe'

const quiet = { reason: 'answer', toolErrors: 0, spawnedAgents: 0, isCorrection: false } as const

const observation = {
  category: 'guidance-not-loaded',
  tooling: '.claude/skills/pest-testing/SKILL.md',
  summary: 'Tests were written without the pest-testing skill.',
  evidence: 'Write tests/Feature/FooTest.php, skill never loaded in the session',
  suggestion: 'Name test paths in the skill description so it triggers on them.',
  confidence: 'high',
}

test('a quiet turn triggers nothing', () => {
  expect(triggersFor(quiet)).toEqual([])
})

test('each trigger fires on its own fact', () => {
  expect(triggersFor({ ...quiet, reason: 'aborted' })).toEqual(['abort'])
  expect(triggersFor({ ...quiet, isCorrection: true })).toEqual(['correction'])
  expect(triggersFor({ ...quiet, spawnedAgents: 1 })).toEqual(['subagent'])
})

test('one failed tool call is routine, two are a trigger', () => {
  expect(triggersFor({ ...quiet, toolErrors: 1 })).toEqual([])
  expect(triggersFor({ ...quiet, toolErrors: 2 })).toEqual(['tool-errors'])
})

test('NONE and prose yield no observations', () => {
  expect(parseObservations('NONE')).toEqual([])
  expect(parseObservations('Nothing here points at the tooling.')).toEqual([])
})

test('observations that follow the template are kept, inside a code fence too', () => {
  const reply = ['```json', JSON.stringify(observation), JSON.stringify({ ...observation, confidence: 'low' }), '```'].join('\n')

  expect(parseObservations(reply)).toEqual([observation, { ...observation, confidence: 'low' }])
})

test('observations off the template are dropped, not repaired', () => {
  const reply = [
    JSON.stringify({ ...observation, category: 'vibes' }),
    JSON.stringify({ ...observation, confidence: 'certain' }),
    JSON.stringify({ ...observation, evidence: '' }),
    '{"category": "other", broken',
  ].join('\n')

  expect(parseObservations(reply)).toEqual([])
})

test('fields are redacted and clipped to the template limits', () => {
  const [parsed] = parseObservations(
    JSON.stringify({ ...observation, evidence: `curl -H "Authorization: Bearer abcdefghijklmnop" ${'x'.repeat(500)}` }),
  )

  expect(parsed?.evidence).not.toContain('abcdefghijklmnop')
  expect(parsed?.evidence.length).toBeLessThanOrEqual(401)
})
