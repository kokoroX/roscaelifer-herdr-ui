# Roscaelifer Queue

A split Herdr workspace with the standard space/agent sidebar on the left, a five-column `roscaelifer` + `bd` work queue in the center with an on-demand task inspector drawer, and the active terminal pane plus collapsible file/git drawer on the right.

![Roscaelifer Queue](preview.png)

**What you see:**

Left to right inside a `row` root (`background: "canvas"`, `1px` `"border"` dividers, `12px`/`14px` terminal padding, macOS traffic lights at `[12, 16]`):
- **Left sidebar** (`248px` fixed width, `min: 44`, `max: 480`, `background: "chrome"`): a `46px` draggable brand header (`workspace-chrome`), two equal-weight (`weight: 1`, `min: 90px`) stacked lists (`spaces` over `agents`), and a `69px` footer (`workspace-chrome` with `footer: true`).
- **Work area** (remaining width, vertical column):
  - **Top tab bar** (`42px`, `window_drag: true`): shipped `tabs` mod.
  - **Work body** (`row`, `padding: 8`, `gap: 8`):
    - **Roscaelifer Queue block** (`weight: 3`, `min: 520px`, `background` theme token):
      - **Mod header** (`46px`, `t.chrome`, bottom `1px` `t.border`): project picker button (`28px` high, `folder.svg` + current Project name or `No project`), runner lock pill (`24px` high: `"Runner active"` or `"Runner idle"`), `Tabs` (`Queue`, `Epics & Deps`, `Mirror & Events`, each `28px` high), and right-side buttons (`New Bead` in `t.solid`, `Tick`, `Clean Pending` with pending count badge, `Refresh`).
      - **Error banner** (conditional, `t.ansi1`/`t.blocked` tinted `20`): CLI/project error message + `Configure Project` button (`24px` high). Missing context reads `No roscaelifer project detected. Open Project Config to select or create one.`
      - **Main view + Inspector row**:
        - In `Queue`: a filter bar (`t.chrome`, env pills showing active `runningWorkSteps` counts when non-zero, `Queued only` toggle pill, `240px × 28px` search box), optional `bd unavailable` warning bar, and six horizontally scrolling Kanban columns (`min_w: 215px` each, `t.canvas`/`t.chrome` cards on `t.surface`): `Ready`, `Queue`, `Running` (header includes active env concurrency limit `max N` when configured), `Needs Action`, `Review`, `Closed`. `Queue` holds work that is already queued but not executing: beads carrying the `roscaelifer` label and waiting for intake/dependencies/a tick, plus active tasks whose steps are all still `pending` a concurrency slot (chips `queued` / `queued · pending`, actions `Dispatch`/`Options`/`Dequeue`/`Cancel`); `Running` only holds roscaelifer tasks that have a step in `running`; a bare `bd` `in_progress` bead without the label stays in `Ready` (chip `bd:in_progress`). The `Queued only` toggle hides the `Ready` column. Each card (`rounded: 8`, `p: 10`) shows priority badge (`P0`–`P4`), bead/task ID, live agent status indicator, title, metadata chips (`formula`, `env:<name>`, `queued`, `blocked (N)`, action reason, `cleanup (N)`), a `3px`-tall step `Progress` bar, and inline action buttons (`22px` high).
        - In `Epics & Deps`: a `260px` left Epic sidebar (`All Issues` + epic cards with completion `Progress` bars and `ready`/`queue`/`running`/`action`/`review`/`closed` counts) beside horizontally scrolling topological Wave lanes (`Wave 0`, `Wave 1`, ..., each `280px` wide) with `Blocked by` and `Unlocks` chips and a `190px`-max-height bottom `Mirror Integrations` table.
        - In `Mirror & Events`: a `230px`-max-height `Mirror Integrations` table (`GROUP ID`, `TARGET BRANCH`, `STATUS`, `COMMIT`, `DETAIL`) above a scrollable `Recent Events` feed (`40px` header with `280px × 26px` filter input, showing timestamp, `task_id`, `step_id`, `from -> to` pill, and `detail`).
      - **Inspector drawer** (visible when an item is selected, right edge, clamped `280px`–`420px` at ~35% of mod width, `t.surface`): fixed header (IDs, priority, task/agent status, refresh & close `24px` icon buttons, title, labels, contextual action buttons) and scrollable body (key/value metadata box, `TextView.markdown` Description / Acceptance Criteria / Latest Reply / Notes, expandable `Pipeline Steps` with `attempts: n/max`, `rounds: r/max`, `dispatch failures`, elapsed runtime, terminal/worktree/branch/link info, `Live Terminal` with `Peek`/`Focus`/`Keep`/`Open Worktree`/`Refresh` and a `210px` monospace terminal tail viewer, and chronological-reversed `Events` list capped at 60).
    - **Active terminal pane** (`weight: 2`, `min: 320px`, `"tab": "active"`): `10px` radius, `background` fill, `1px` `"border"` (`"accent"` when focused), `30px` top `pane` header (`reveal: "always"`).
    - **Right utility column** (`368px` wide, `hidden: true`, `min: 280`, `max: 900`): `stack` switching between `files` and `changes`.
  - **Bottom status bar** (`28px`, `workspace-status`).

**How it behaves:**

- **Agent status mapping** (projected live from Herdr `agents()` matching card `hcAddress`/`paneId`/`marker`/`worktree` with `current_attempt` fallback, ranked `blocked` > `done` > `working` > `idle`):
  - `working`: spinning `spinner.svg` (`11px`, `900ms`, `t.working || t.accent`) + `"working"` label.
  - `blocked`: filled badge (`(t.blocked || t.ansi1) + "24"`, `t.blocked || t.ansi1`) reading `"Needs you"`.
  - `done`: `6px` solid dot (`t.done || t.ansi2`) + `"done"` label.
  - `idle`: `6px` hollow circle (`1px` `t.idle || t.dim` border) + `"idle"` label.
- **Clicks & hovers**:
  - Clicking a card selects it, opens the right-hand Inspector drawer, fetches `roscaelifer show --json <task>`, and reads the last 35 lines of `hcAddress` via `hc(["read", addr, "--lines", "35"])`.
  - Card inline buttons (`Enqueue`, `Options`, `Peek`, `Focus`, `Cancel`, `Approve`, `Retry`, `Re-queue`, `Pass`, `Reject`, `Clean`, `Reopen`) call `stop_propagation()` so they act without toggling selection, opening modal overlays (`enqueue`, `reject`, `clean-preview`) or executing `roscaelifer` / `herdr.run` commands immediately.
  - In `Epics & Deps`, clicking an epic filters the Wave lanes; clicking a dependency card focuses its chain (highlighting upstream blockers in `t.blocked`, downstream unlocks in `t.done`, and dimming unrelated cards to `0.42` opacity); clicking a `Blocked by` or `Unlocks` chip jumps to and inspects that issue.
  - In `Mirror & Events`, clicking an event row with a matching item selects and inspects it.
  - Clicking `Peek`, `Focus`, `Keep`, or `Open Worktree` in the Inspector triggers `terminal.peek`, `agent.focus`, `terminal.keep`, or `space.new`.
  - Clicking the top-bar project button opens the `project-config` modal. It reads and writes `~/.config/roscaelifer/projects.json`, shows Saved Projects, supports `+ New Project`, `Auto-Detect`, folder browsing, `Save & Activate` / `Create & Activate`, `Delete`, and `Use Auto-Detect`; `repo-config` remains accepted as a compatibility alias.
- **Keys** (when `roscaelifer-queue` has focus and search input is not focused):
  - `1`, `2`, `3`, `4`: switch tabs (`Beads`, `Roscaelifer`, `Epics & Deps`, `Mirror & Events`).
  - `/`: switch to `Queue` and focus the search input (`Esc` returns focus to the board).
  - `j`/`Down` and `k`/`Up`: step selection through visible cards in `Queue`.
  - `Esc`: clear selection and close Inspector (or close active dropdown / modal in dialogs).
  - `n`: open `Create Bead` dialog (`520 × 500`).
  - `t`: run `roscaelifer tick`.
  - `r`: refresh snapshot.
- **Background updates**: watches `.roscaelifer/`, `.beads/`, `bdDir`, and `roscaelifer.db` parent directory via `watchFolder` (250ms debounce), polls every `10000ms` via `cx.timer.every`, and reacts immediately to Herdr live `agents()`/`terminals()`/`spaces()` updates and `shared("roscaelifer.refresh")` / `shared("roscaelifer.ctxOverride")` signals from dialog overlays.

**Built from:**

- **Layout (`layouts/roscaelifer.json`)**: `root` (`row`) -> `sidebar` (`column`, `248px`) [`brand` (`workspace-chrome`), `sidebar-lists` (`spaces`, `agents`), `sidebar-footer` (`workspace-chrome` `{ "footer": true }`)] + `work` (`column`) [`tabs` (`42px`), `work-body` (`row`, `padding: 8`, `gap: 8`: `queue` `roscaelifer-queue` `weight: 3` `min: 520`, `main` `tab: "active"` `weight: 2` `min: 320` with `pane` header, hidden `panel` `368px` `stack` of `files`/`changes`), `status` (`workspace-status` `28px`)].
- **Mod (`mods/roscaelifer-queue/`)**:
  - `mod.json`: `{ "place": "none", "title": "Roscaelifer Queue", "focusable": true }`.
  - `main.js`: `RoscaeliferQueue` (`View`), top bar, tab switching, keyboard navigation, `openOverlay` dispatcher, `watchFolder` & `10s` polling, context resolution.
  - `store.js`: `resolveContext`, Project configuration loading and atomic persistence for `~/.config/roscaelifer/projects.json`, legacy repo-history migration, active Project cache mirroring, `resolveBinary`, `fetchSnapshot`, `fetchTaskDetail`, and `normalizeQueue` (columns, epics, envs, formulas, mirror integrations, events, agent projection).
  - `actions.js`: `createActions` wrapping `roscaelifer` CLI commands (`tick`, `approve`, `retry`, `cancel`, `add`, `clean --all-pending --json`, `clean <task> [step] --json`, `bd-exec -- create/update/update --append-notes/close/reopen/dep add`) and Herdr commands (`terminal.peek`, `agent.focus`, `terminal.keep`, `space.new`).
  - `board.js`: `BoardController` (filter bar, 5 Kanban columns, card rendering, inline actions).
  - `inspector.js`: `InspectorController` (detail header, metadata, `TextView.markdown`, pipeline steps & attempts, `Live Terminal` with `hc read --lines 35`, events timeline).
  - `dialogs.js`: `DialogController` (`DialogHandler`) for `dialogType`: `"enqueue"` (`440×340`), `"create"` (`520×500`), `"reject"` (`460×320`), `"clean-preview"` (`520×420`), and `"project-config"` (`600×660`, with `"repo-config"` compatibility support).
  - `deps.js`: `DepsController` for `Epics & Deps` (`computeWaves`, `collectChain`, epic `Progress` bars, `Mirror Integrations`) and `Mirror & Events` (table + filterable event stream).
- **`props` roles**: `{ repo, db, bdDir, config, formulasDir, bin, env, dialogType, ctx, item, target, formulas, envs, items, history, projectsConfig }` (a Project may omit `repo` when it has `db`, `bdDir`, `config`, or `formulasDir`; modal overlays receive `dialogType` and snapshot context).
- **Shipped mods used**: `workspace-chrome`, `spaces`, `agents`, `tabs`, `pane`, `files`, `changes`, `workspace-status`.
- **Herdr APIs & commands**: `exec`, `hc`, `run` (`terminal.peek`, `agent.focus`, `terminal.keep`, `space.new`), `agents`, `terminals`, `spaces`, `panes`, `focused`, `theme`, `settings`, `props`, `shared`, `setShared`, `openOverlay`, `closeOverlay`, `pickFolder`, `notify`, `watchFolder`, `nextCommand`, `home`.
- **Programs run**: `roscaelifer` (`snapshot --json`, `show --json`, `bd-show --json <bead-id>`, `tick`, `approve`, `retry`, `cancel`, `add`, `clean --dry-run --json`, `clean --json`, `bd-exec`), `hc` (`read <addr> --lines 35`), and `go run ./cmd/roscaelifer` fallback when `cmd/roscaelifer/main.go` exists and no compiled binary is found.
- **Art**: `icons/board.svg`, `check.svg`, `clean.svg`, `close.svg`, `folder.svg`, `play.svg`, `plus.svg`, `refresh.svg`, `search.svg`, `spinner.svg`, `terminal.svg`.

**Watch out:**

- **Subprocess environment**: Herdr launches without Node APIs, `setTimeout`/`setInterval`, or HTML/CSS; timers must use `cx.timer`, and `cx` must never be captured across `await`.
- **Global Project storage**: `~/.config/roscaelifer/projects.json` is the authoritative version 1 configuration. The mod reads it with `readTextFile`; writes use the Herdr `exec` shell helper for atomic replacement and are skipped while `checking()` is true. Each mod instance/overlay copy has isolated `localStorage`, so the active Project is mirrored there only as a first-frame cache; dialogs communicate changes via `setShared("roscaelifer.ctxOverride", ...)` and `setShared("roscaelifer.refresh", ...)`.
- **Backend CLI assumptions**: Requires the updated `roscaelifer` binary supporting `snapshot --json`, `show --json`, `bd-show --json`, `clean --dry-run --json`, and `bd-exec -- ...` (or running inside the `roscaelifer` repo with `go` on `PATH`); older `roscaelifer` binaries without `snapshot` will trigger the error banner until rebuilt/installed.
- **Limits & truncation**: Dialog `blocks` selector receives up to `100` items from `main.js`; `snapshot` defaults to `events` / `closed` limits controlled by CLI defaults unless overridden (`--events-limit`, `--closed-limit`); Inspector renders up to `60` task events and `hc read --lines 35`; `recent` repo history stores `10` entries.
- **`preview.png`**: Not generated automatically by CLI checks; capture manually from a live Herdr window using `layouts/roscaelifer.json`.
- **Hidden panel**: The layout's right-hand `panel` (`files`/`changes`) starts `"hidden": true` and relies on Herdr's workspace-chrome/panel toggle command to reveal.

**Project configuration:** `Project Configuration` displays the subtitle `Manage saved projects (~/.config/roscaelifer/projects.json) or switch the active project.`. `Save & Activate` keeps the selected Project active across Herdr restarts; `Use Auto-Detect` clears `activeProject` and lets context resolution fall back to the focused workspace.

**Done when:**

- `./scripts/install-mod.sh --with-layout` symlinks `mods/roscaelifer-queue` and `layouts/roscaelifer.json` into `~/.config/herdr-app/` with exit code `0`.
- `./scripts/check.sh` runs `herdr-app check ~/.config/herdr-app/mods/roscaelifer-queue` and exits `0` with `check passed`.
- Opening Herdr with the `roscaelifer` layout loads the 5-column queue from a `roscaelifer` repo (or shows the repo error banner with working `Configure Project` override when launched outside a repo), selecting a card renders its Markdown description/steps/live terminal tail, switching tabs (`1`/`2`/`3`/`4`) renders `Epics & Deps` waves and `Mirror & Events`, and `New Bead` / `Enqueue` / `Clean Pending` dialogs open and close cleanly.
