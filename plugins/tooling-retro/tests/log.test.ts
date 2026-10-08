import { expect, test } from 'claude-code/testing'

import { clip, describeCall, isGuidancePath, redact, withoutCredentials } from '../hooks/log'

test('secrets never reach the log', () => {
  expect(redact('export API_KEY=abc123def')).toBe('export API_KEY=[redacted]')
  expect(redact('curl -H "Authorization: Bearer abcdefghijklmnop"')).not.toContain('abcdefghijklmnop')
  expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_')
  expect(redact('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw')).toBe('jwt [redacted]')
})

test('clip redacts, collapses whitespace and cuts', () => {
  expect(clip('a\n\n  b', 10)).toBe('a b')
  expect(clip('x'.repeat(20), 5)).toBe('xxxxx…')
})

test('tool calls are described by what they touched, relative to the repo', () => {
  expect(describeCall('Edit', { file_path: '/repo/app/Foo.php', new_string: 'secret body' }, '/repo')).toBe('app/Foo.php')
  expect(describeCall('Bash', { command: 'php artisan test --compact' })).toBe('php artisan test --compact')
  expect(describeCall('Skill', { skill: 'pest-testing' })).toBe('pest-testing')
})

test('reads of repo tooling are flagged as guidance', () => {
  for (const path of ['CLAUDE.md', 'Modules/X/CLAUDE.md', '.claude/skills/a/SKILL.md', '.ai/rules/index.md', '.github/workflows/ci.yml']) {
    expect(isGuidancePath(path)).toBe(true)
  }

  expect(isGuidancePath('app/Http/Controllers/FooController.php')).toBe(false)
})

test('remote urls lose embedded credentials', () => {
  expect(withoutCredentials('https://x-access-token:ghs_abc@github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(withoutCredentials('https://github.com/o/r')).toBe('https://github.com/o/r')
})
