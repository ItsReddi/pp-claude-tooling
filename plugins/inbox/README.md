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
| Running now | sessions in the middle of a turn | newest activity first |
| Recently active (3 h) | idle sessions updated in the last three hours | newest activity first |
| Waiting on you | sessions blocked on you, ready for review, or ending on a question to you | oldest first, five shown, `+ N more` folds out the rest |

The pane leaves out archived sessions. Each session is a card that links to it. A card under
Waiting on you shows the open question and how long the session has waited, green under a day,
orange from one day, red from seven.

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

Running now goes by the session status alone. The board column `working` lags behind and still
holds sessions that finished a while ago.

The mod keeps the list and the fold-out state in `$.state` for the current session and writes
nothing anywhere else.

## Limits

- Sessions inside a claude.ai project never show up. `list_sessions` does not return them, and no
  session record carries a project name.
- Everything in the pane is as old as the last load, at most five minutes.
- The open question is the session's own summary, in whatever language that session used.

## Develop

```sh
claude plugin validate plugins/inbox
claude plugin test plugins/inbox
```
