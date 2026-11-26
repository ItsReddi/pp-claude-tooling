# inbox

A pane beside the chat that lists your Claude Code cloud sessions, so you can see which ones need
you without opening the session list.

Install with `/plugin install inbox@pp-claude-tooling`. The [marketplace README](../../README.md)
explains how to add the marketplace.

It only works in Claude Code cloud sessions. The mod reads the session list from the
`claude-code-remote` MCP server, and a local terminal session has no such server.

## What it shows

| Section | Contains | Order |
| --- | --- | --- |
| Running now | sessions in the middle of a turn, or whose subagents still work after the turn ended | newest activity first |
| Recently active (3 h) | idle sessions updated in the last three hours | newest activity first |
| Waiting on you | sessions blocked on you, ready for review, or ending on a question to you | oldest first, five shown, `+ N more` folds out the rest |

The pane leaves out archived sessions. Each session is a card that links to it. A card under
Waiting on you shows the open question and how long the session has waited, green under a day,
orange from one day, red from seven.

## Snooze

Each card under Waiting on you has a small `Snooze` button. It offers 1, 7, 14 or 30 days. A
snoozed session leaves the list, the status line count and the toasts. `N snoozed` at the bottom
folds out the snoozed sessions with their end date and an `Unsnooze` button.

The snooze is a tag on the session itself, such as
`inbox-snooze:2026-11-26T11:20:00Z/2026-12-03T11:20:00Z`, set through `set_session_tags` on the
`claude-code-remote` server. claude.ai keeps the tag, so every session that runs `inbox` sees the
same snoozes. A local store would not do: it lives in the cloud container and goes with it.

A snoozed session comes back early when it is updated after the snooze, so a new question in it
is not missed. When the snooze runs out, it comes back with a toast. In both cases the mod removes
the old tag on the next load. Setting a tag leaves the session's `updated_at` alone, so the age on
the card stays right.

## Status line and toasts

Outside the pane, the status line under the prompt reads `12 sessions waiting` and disappears when
nothing waits. A toast names each session that started waiting since the previous load. The first
load after the session starts or the mod reloads stays quiet, otherwise every waiting session would
pop up at once.

## How it works

At session start the mod opens the pane, registers `/inbox` and loads the list. It loads again
every five minutes, when you press `Refresh`, and when you run `/inbox`, which also reopens the
pane.

The mod calls `list_sessions` on the `claude-code-remote` server for your own sessions. It asks for
pages of 35 and stops after six. The server sorts by creation date, newest first, and a session that
waits on you can be weeks old, so one page is not enough. Pages stay small because the engine does
not hand a mod a reply as large as 100 sessions, about 50,000 characters.

A session whose turn has ended but whose subagents still work reads as idle with the board column
`working`. Running now counts it while that column is set and the session was updated in the last
15 minutes, and its card says `background work`. The 15 minutes keep a column that never clears
from holding a session there for good.

The mod keeps the list and the fold-out state in `$.state` for the current session and writes
nothing anywhere else.

## Limits

- Sessions inside a claude.ai project never show up. `list_sessions` does not return them, and no
  session record carries a project name.
- Everything in the pane is as old as the last load, at most five minutes.
- If opening or reading a session ever moves its `updated_at`, looking at a snoozed session would
  bring it back. The mod cannot tell that apart from new activity.
- The open question is the session's own summary, in whatever language that session used.

## Develop

```sh
claude plugin validate plugins/inbox
claude plugin test plugins/inbox
```
