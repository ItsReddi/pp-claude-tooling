# tooling-retro

Watches Claude Code sessions for moments where a repository's agent tooling let the agent down,
and turns them into retrospectives on that tooling: CLAUDE.md files, skills, agents, rules, hooks
and workflows.

Install: `/plugin install tooling-retro@pp-claude-tooling` (see the
[marketplace README](../../README.md) for adding the marketplace).

## How it works

**Collect, locally.** While a session runs, the mod writes one JSONL line per event to
`.git/tooling-retro/<session-id>.jsonl`: skill loads, subagent starts, every tool call (what it
touched, whether it failed, whether it read tooling), the person's prompts (clipped, redacted) and
how each turn ended. Each observer run adds a line with its triggers, its outcome and the
observer's reply (clipped to 4000 characters, redacted), so a NONE can be traced back too. This raw
log never leaves the machine.

To see whether and why the observer ran in a session:

```sh
grep -E '"type":"(turn_end|observer)"' .git/tooling-retro/<session-id>.jsonl
```

**Observe at triggers.** At the end of a turn the mod checks four triggers:

| Trigger | Detected by |
| --- | --- |
| `abort` | `turn.complete` reports the turn as interrupted |
| `correction` | the person's next prompt after a turn that edited files or ran commands, classified by the engine's small model as a correction |
| `tool-errors` | two or more failed tool calls in the turn |
| `subagent` | the turn started a subagent |

When one fires, the mod asks a fork of the session (`$.model.fork`) whether the moment points at
the repository's tooling. The fork sees the whole conversation from the prompt cache, runs on the
session's own model, has no tools and leaves the conversation untouched. It answers NONE or up to
three observations in a fixed template (`prompts/observer.md`):

```json
{"category":"guidance-not-loaded","tooling":".claude/skills/pest-testing/SKILL.md","summary":"…","evidence":"…","suggestion":"…","confidence":"high"}
```

Categories: `guidance-not-loaded`, `guidance-ignored`, `guidance-wrong`, `guidance-conflict`,
`guidance-missing`, `subagent-context`, `tool-friction`, `other`. Lines off the template are
dropped, fields are redacted and clipped. At most 20 observer runs per session. A toast says when
observations were noted, and the spinner shows the session's count.

**Push.** Observations go to `observations/<day>/<session-id>.jsonl` on the branch
`chore/tooling-retro`, together with `stats/<day>/<session-id>.json`: counts of turns, aborts,
corrections, tool calls and errors, tooling reads, and how often each skill and subagent type was
used. No prompt or file content. A push happens whenever new observations exist, stats alone at
most every 15 minutes and at session end, because cloud sessions lose anything that stays local.
The branch name is fixed, has a history of its own and never merges into the code branches. Commits
go through a temporary index and leave the working tree alone. A repository that opens pull
requests for new branches automatically will open one for this branch too; keeping it out is that
repository's call. A 403 or 407 on push stops pushing for the rest of the session.

**Retro.** `/tooling-retro [focus]` reads the observations and stats no earlier retro covered,
takes an inventory of the repository's tooling, groups observations by tooling and category, and
turns patterns into proposals. A proposal needs observations from at least two sessions, or one
high-confidence observation backed by the stats. The report goes to `retros/<day>.md` on the same
branch. Proposals are only implemented after the person accepts them, on a normal working branch.

Nothing in the mod is specific to one repository: it reads whatever tooling the repository has.

## Options

Set through `/config` or `pluginConfigs` in settings:

| Option | Default | Effect |
| --- | --- | --- |
| `push` | `true` | Push observations and stats. Off: they stay in `.git/tooling-retro/`. |

## Reading the observations by hand

```sh
git fetch origin +refs/heads/chore/tooling-retro:refs/tooling-retro/remote
git ls-tree -r --name-only refs/tooling-retro/remote
git show refs/tooling-retro/remote:observations/<day>/<session-id>.jsonl
```

## Develop

```sh
claude plugin validate plugins/tooling-retro
claude plugin test plugins/tooling-retro
claude --plugin-dir plugins/tooling-retro
```
