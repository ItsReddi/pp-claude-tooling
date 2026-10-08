# pp-claude-tooling

A Claude Code plugin marketplace, `pp-claude-tooling`. Each plugin lives in its own folder under
`plugins/` with its own README.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`tooling-retro`](plugins/tooling-retro/README.md) | Observes sessions for moments where skills, agents or repo tooling let the agent down, pushes structured observations to `chore/tooling-retro` and runs `/tooling-retro` over them |

## Install

```text
/plugin marketplace add ItsReddi/pp-claude-tooling
/plugin install <plugin>@pp-claude-tooling
```

To offer a plugin to everyone working in a repository, commit this to that repository's
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "pp-claude-tooling": {
      "source": { "source": "github", "repo": "ItsReddi/pp-claude-tooling" }
    }
  },
  "enabledPlugins": {
    "tooling-retro@pp-claude-tooling": true
  }
}
```

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json` and the plugin's own `README.md`.
2. Add an entry to `.claude-plugin/marketplace.json` with `name`, `source: "./plugins/<name>"`,
   `description` and `version`.
3. Add a row to the table above.
4. Run `claude plugin validate .` and `claude plugin validate plugins/<name>`, and
   `claude plugin test plugins/<name>` when the plugin has tests.

Develop a plugin against a live session with `claude --plugin-dir plugins/<name>`.

## Branching

`develop` is the default branch. Work goes to `feature/`, `bugfix/` or `chore/` branches cut from
`develop` and comes back by pull request. Releases merge `develop` into `main` and are tagged
there. Hotfixes branch from `main` and merge into both.
