# roscaelifer-herdr-ui

A Herdr mod (`roscaelifer-queue`) and layout (`roscaelifer.json`) for operating the `roscaelifer` execution queue and `bd` (beads) issue tracker side by side with live Herdr agent terminals.

## Install & Verify

Symlink the mod into your Herdr config directory (`~/.config/herdr-app` or `$HERDR_APP_HOME`):

```bash
./scripts/install-mod.sh
```

To also symlink the example workspace layout (`layouts/roscaelifer.json`):

```bash
./scripts/install-mod.sh --with-layout
```

Validate the mod with Herdr's static check:

```bash
./scripts/check.sh
```

Select the `roscaelifer` layout in Herdr (`Layout` -> `roscaelifer`) or embed `{ "mod": "roscaelifer-queue", "props": {} }` in any custom layout block.

## Repository Detection & `props`

When `props` is `{}` (default), the mod detects context in order:
1. Active repo override saved via the top-bar repository picker (`Repo Config` dialog).
2. Explicit block `props`:
   - `repo`: repository root directory
   - `db`: path to `roscaelifer.db`
   - `bdDir`: path to `.beads` directory
   - `config`: path to `roscaelifer.toml`
   - `formulasDir`: path to `formulas/` directory
   - `bin`: explicit path to the `roscaelifer` executable
   - `env`: default environment name
   - `dialogType`: internal prop used by modal dialog overlays (`enqueue`, `create`, `reject`, `clean-preview`, `repo-config`)
3. Focused Herdr pane/space working directory (walking parent directories for `.beads/` or `roscaelifer.db` / `roscaelifer.toml`).

If `roscaelifer` is not on `PATH` (or `~/.local/bin/roscaelifer`, `~/go/bin/roscaelifer`), and `repo/cmd/roscaelifer/main.go` exists with `go` available, it falls back to `go run ./cmd/roscaelifer`.

## Views

- **Queue (Kanban)**: Five columns — `Ready`, `Running`, `Needs Action`, `Review`, and `Closed` — with environment capacity pills, `Queued only` filter, search input, card priority/agent status badges, step progress bar, and inline action buttons (`Enqueue`, `Options`, `Peek`, `Focus`, `Cancel`, `Approve`, `Retry`, `Re-queue`, `Pass`, `Reject`, `Clean`, `Reopen`).
- **Epics & Deps**: Epic sidebar with completion progress bars paired with topological `Wave 0`, `Wave 1`, ... lanes derived from `blocks` dependencies, `Blocked by` / `Unlocks` chips, click-to-highlight upstream/downstream chain, and a `Mirror Integrations` table.
- **Mirror & Events**: `Mirror Integrations` table (`group_id`, `target_branch`, `status`, `commit_sha`, `detail`) above a searchable stream of task/step state transitions (`from -> to`).
- **Inspector Drawer**: Right-hand panel (`280px`–`420px`) showing bead/task IDs, priority, labels, metadata (`Env`, `Formula`, `Project`, `Branch`, `Worktree`, `Terminal`, `Link`), Markdown-rendered description, acceptance criteria, notes, and latest attempt reply, expandable pipeline steps with attempt counts/rounds/elapsed time, `Live Terminal` (`Peek`, `Focus`, `Keep`, `Open Worktree`, and manual `Refresh` running `hc read <addr> --lines 35`), and task event timeline.
- **Dialogs**: Modal overlays for `Enqueue Bead`, `Create Bead` (with formula, env, `blocks`, and immediate enqueue toggle), `Reject Review` (required feedback note + reopen), `Cleanup Preview` (`roscaelifer clean --dry-run --json`), and `Repository Configuration` (with folder picker and recent repo history).

## Keyboard Shortcuts

When the `roscaelifer-queue` block is focused (outside search input):

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Switch between `Queue`, `Epics & Deps`, and `Mirror & Events` |
| `/` | Switch to `Queue` and focus search input (`Esc` blurs back to board) |
| `j` / `Down`, `k` / `Up` | Select next / previous visible card in `Queue` |
| `Esc` | Deselect current card / close Inspector drawer |
| `n` | Open `Create Bead` dialog |
| `t` | Run `roscaelifer tick` |
| `r` | Refresh snapshot and context |

## Files

- `mods/roscaelifer-queue/` — Herdr mod (`mod.json`, `main.js`, `store.js`, `actions.js`, `board.js`, `inspector.js`, `dialogs.js`, `deps.js`, `icons/*.svg`)
- `layouts/roscaelifer.json` — Split workspace layout with sidebar, tabs, `roscaelifer-queue`, active terminal pane, collapsible `files`/`changes` stack, and `workspace-status` bar
- `scripts/install-mod.sh` — Symlinks the mod (and optionally the layout) into `$HERDR_APP_HOME`
- `scripts/check.sh` — Runs `herdr-app check` on the installed mod
- `RECIPE.md` — Herdr build recipe specification
