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

## Project Configuration & `props`

The top-bar `project-picker` opens **Project Configuration**. It manages the global file `~/.config/roscaelifer/projects.json`, whose version 1 shape is:

```json
{
  "version": 1,
  "activeProject": "jikerental",
  "projects": [
    {
      "id": "jikerental",
      "name": "JikeRental",
      "repo": "/Users/kokoro/work/chenlei/JikeRental",
      "machine": "",
      "db": "/Users/kokoro/work/chenlei/JikeRental/.roscaelifer/roscaelifer.db",
      "bdDir": "/Users/kokoro/work/chenlei/JikeRental/.beads",
      "config": "/Users/kokoro/work/chenlei/JikeRental/roscaelifer.toml",
      "formulasDir": "/Users/kokoro/work/chenlei/JikeRental/formulas",
      "bin": "",
      "env": "",
      "updatedAt": 0
    }
  ]
}
```

A Project needs a non-empty `name` and at least one of `repo`, `db`, `bdDir`, `config`, or `formulasDir`. The name is user-defined and does not have to match the repository directory. `Project Configuration` lists saved projects, supports `+ New Project`, `Auto-Detect`, folder browsing with path derivation, `Save & Activate` / `Create & Activate`, deletion, and `Use Auto-Detect`. Missing or invalid global JSON falls back to an empty in-memory configuration; valid legacy `roscaelifer.repoHistory.v1` and `roscaelifer.activeRepo.v1` entries are migrated in memory and saved when the user next saves a project.

Context resolution for an empty `props` block is ordered as follows: the session override sent by the dialog, the matching `activeProject` in `projects.json`, explicit block props, automatic detection from the focused pane / active space / pane working directories, and finally no context. Automatic detection never changes `activeProject`. The active project is mirrored in localStorage only for the synchronous first-frame cache; the global JSON remains authoritative after asynchronous resolution.

Supported block `props` fields are:

- `repo`: optional project root directory
- `db`: path to `roscaelifer.db`
- `bdDir`: path to `.beads` directory
- `config`: path to `roscaelifer.toml`
- `formulasDir`: path to `formulas/` directory
- `bin`: explicit path to the `roscaelifer` executable
- `env`: default environment name; `auto` defers env selection to the scheduler (see `Queue (Kanban)` above)
- `dialogType`: internal modal prop (`enqueue`, `create`, `reject`, `clean-preview`, `project-config`; `repo-config` remains accepted for compatibility)

If `roscaelifer` is not on `PATH` (or `~/.local/bin/roscaelifer`, `~/go/bin/roscaelifer`), and `repo/cmd/roscaelifer/main.go` exists with `go` available, it falls back to `go run ./cmd/roscaelifer`.

## Views

- **Queue (Kanban)**: Six columns — `Ready`, `Queue`, `Running`, `Needs Action`, `Review`, and `Closed` — with environment capacity pills, `Queued only` filter, search input, card priority/agent status badges, step progress bar, and inline action buttons (`Enqueue`, `Dispatch`, `Options`, `Dequeue`, `Peek`, `Focus`, `Cancel`, `Approve`, `Retry`, `Re-queue`, `Pass`, `Reject`, `Clean`, `Reopen`). `Queue` holds work already waiting to run — `roscaelifer`-labelled beads awaiting intake/dependencies/a tick, plus active tasks whose steps are all still pending a concurrency slot — while `Running` only holds tasks with a step actually executing.

  Environments come only from the backend `[env.*]` config: the env tabs are built from `config.envs`, so a task without a concrete env is simply filtered out of a specific-env tab and never gets an `env:auto` chip. If the selected env filter disappears from the config, the filter safely falls back to `All Envs`.

  When `default_env = "auto"` the scheduler picks the env per task, so the board does not invent an `auto` tab. Items that have no explicit `env:<name>` label, no concrete `intake_preview` env, and no scheduler-locked task `resolved_env` render without an `env:` chip and carry an env-pending marker; their inspector metadata row shows `Env: auto (pending)`. Only an explicit env or a locked `resolved_env` shows a concrete env name (and `env:<name>` chip).
- **Epics & Deps**: Epic sidebar with completion progress bars paired with topological `Wave 0`, `Wave 1`, ... lanes derived from `blocks` dependencies, `Blocked by` / `Unlocks` chips, click-to-highlight upstream/downstream chain, and a `Mirror Integrations` table.
- **Mirror & Events**: `Mirror Integrations` table (`group_id`, `target_branch`, `status`, `commit_sha`, `detail`) above a searchable stream of task/step state transitions (`from -> to`).
- **Inspector Drawer**: Right-hand panel (`280px`–`420px`) showing bead/task IDs, priority, labels, metadata (`Env`, `Formula`, `Project`, `Branch`, `Worktree`, `Terminal`, `Link`), Markdown-rendered description, acceptance criteria, notes, and latest attempt reply, expandable pipeline steps with attempt counts/rounds/elapsed time, `Live Terminal` (`Peek`, `Focus`, `Keep`, `Open Worktree`, and manual `Refresh` running `hc read <addr> --lines 35`), and task event timeline.
- **Dialogs**: Modal overlays for `Enqueue Bead`, `Create Bead` (with formula, env, `blocks`, and immediate enqueue toggle), `Reject Review` (required feedback note + reopen), `Cleanup Preview` (`roscaelifer clean --dry-run --json`), and `Project Configuration` (saved Projects, folder pickers, Auto-Detect, activation, deletion, and global `projects.json` persistence).

## Keyboard Shortcuts

When the `roscaelifer-queue` block is focused (outside search input):

| Key | Action |
| --- | --- |
| `1` / `2` / `3` / `4` | Switch between `Beads`, `Roscaelifer`, `Epics & Deps`, and `Mirror & Events` |
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
