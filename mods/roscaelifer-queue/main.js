import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Tabs, Tab } from "gpui-base";
import {
  agents,
  terminals,
  spaces,
  panes,
  focused,
  home,
  props,
  theme,
  shared,
  setShared,
  openOverlay,
  watchFolder,
  nextCommand,
  checking,
} from "herdr";
import {
  resolveContext,
  resolveBinary,
  fetchSnapshot,
  fetchTaskDetail,
  fetchBeadDetail,
  normalizeQueue,
  mergeNormalizedQueues,
  resolveWorkspaceProjects,
  contextKey,
  repoIdentityKey,
  repoLabel,
  loadRepoHistory,
  loadActiveRepo,
  loadActiveProjectMirror,
  loadGlobalProjectsConfig,
  upsertGlobalProject,
  detectActiveRunnerMismatch,
  buildContextFromProps,
  loadCachedSnapshot,
  saveCachedSnapshot,
  PANEL_MODE_MULTI,
  safeStorageGet,
  safeStorageSet,
} from "./store.js";
import { createActions } from "./actions.js";
import { BoardController } from "./board.js";
import { InspectorController } from "./inspector.js";
import { DepsController } from "./deps.js";
import { DialogHandler } from "./dialogs.js";

const TABS = [
  { id: "beads", label: "Beads" },
  { id: "queue", label: "Roscaelifer" },
  { id: "deps", label: "Epics & Deps" },
  { id: "mirror", label: "Mirror & Events" },
];

const FALLBACK_POLL_MS = 10000;
const LOCAL_WATCH_POLL_MS = 30000;
const DETAIL_CACHE_TTL_MS = 20000;
const DETAIL_CACHE_MAX = 50;
const SHOW_EPHEMERAL_KEY = "roscaelifer.showEphemeral.v2";
const SHOW_DEFERRED_KEY = "roscaelifer.showDeferred.v1";
const COUNT_CLOSED_STATS_KEY = "roscaelifer.countClosedStats.v1";
const ACTIVE_TAB_KEY = "roscaelifer.activeTab.v1";

function herdrLiveFingerprint(agentList, termList, spaceList, paneList) {
  const aSig = (agentList || []).map((a) => `${a?.address || ""}:${a?.status || ""}`).join("|");
  const tSig = (termList || []).map((t) => `${t?.address || ""}:${t?.state || ""}:${t?.status || ""}`).join("|");
  const sSig = (spaceList || [])
    .map((s) => {
      const tabs = Array.isArray(s?.tabs) ? s.tabs : s?.tab ? [s.tab] : [];
      const tabSig = tabs.map((tab) => `${tab?.id || tab?.tab || tab}:${tab?.name || tab?.title || tab?.label || ""}`).join(",");
      return `${s?.id || ""}:${s?.name || ""}:${tabSig}`;
    })
    .join("|");
  const pSig = (paneList || []).map((p) => `${p?.terminal || p?.address || ""}:${p?.pane || p?.id || ""}`).join("|");
  return `${aSig}#${tSig}#${sSig}#${pSig}`;
}

function validTab(value) {
  return TABS.some((tab) => tab.id === value) ? value : "queue";
}

function guessInitialContext(rawProps, sharedOverride) {
  const fromOverride = buildContextFromProps(rawProps, sharedOverride);
  if (fromOverride) return fromOverride;
  const fromProps = buildContextFromProps(rawProps, null);
  if (fromProps) return fromProps;

  const focusedInfo = focused();
  const activeSpace = spaces().find((s) => s.active);
  const cwd = focusedInfo?.cwd || activeSpace?.folder || "";
  const machine = typeof activeSpace?.machine === "string" ? activeSpace.machine.trim() : "";
  const projectMirror = loadActiveProjectMirror();
  if (projectMirror) {
    const mirrored = buildContextFromProps(rawProps, { ...projectMirror, source: "project", projectId: projectMirror.projectId || projectMirror.id });
    if (mirrored) return mirrored;
  }
  const history = loadRepoHistory();

  if (cwd) {
    const cleanCwd = cwd.replace(/\/+$/, "") || "/";
    let best = null;
    for (const item of history) {
      if ((item.machine || "") !== machine || !item.repo) continue;
      const cleanRepo = item.repo.replace(/\/+$/, "") || "/";
      if (cleanCwd === cleanRepo || cleanCwd.startsWith(`${cleanRepo}/`)) {
        if (!best || cleanRepo.length > best.repo.length) {
          best = item;
        }
      }
    }
    if (best) {
      return {
        ...best,
        bin: best.bin || rawProps?.bin || "",
        source: "history",
      };
    }
    return null;
  }

  const activeSaved = loadActiveRepo();
  if (activeSaved) {
    return {
      ...activeSaved,
      bin: activeSaved.bin || rawProps?.bin || "",
      source: "history",
    };
  }
  if (history.length > 0) {
    return {
      ...history[0],
      bin: history[0].bin || rawProps?.bin || "",
      source: "history",
    };
  }
  return null;
}

// A cached snapshot may still carry the previous session's live runner state; clear it so a
// stale `Runner active` spinner never flashes before the first real `snapshot` returns.
function clearCachedRunnerState(snapshot) {
  if (!snapshot?.runner) return snapshot;
  return { ...snapshot, runner: { ...snapshot.runner, active: false, lock_held: false } };
}

function shortenHomePath(value) {
  const path = String(value || "").replace(/\/+$/, "");
  const userHome = String(home() || "").replace(/\/+$/, "");
  return userHome && path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path;
}

function topButton(id, label, iconPath, { bg, fg, border, busy = false, badge = null, onClick }) {
  return Button.new(id)
    .h(28)
    .px(10)
    .rounded(6)
    .flex()
    .items_center()
    .gap(6)
    .bg(bg)
    .text_color(fg)
    .text_size(12)
    .font_medium()
    .when(Boolean(border), (el) => el.border_1().border_color(border))
    .cursor_pointer()
    .hover((s) => s.opacity(0.88))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .when(busy, (el) =>
      el.child(svg("mods/roscaelifer-queue/icons/spinner.svg").size(12).flex_none().spin(900)),
    )
    .when(!busy && Boolean(iconPath), (el) =>
      el.child(svg(iconPath).size(13).flex_none()),
    )
    .child(label)
    .when(badge !== null && badge !== undefined && badge > 0, (el) =>
      el.child(
        div()
          .px(5)
          .py(1)
          .rounded(4)
          .bg(fg + "22")
          .text_size(10.5)
          .child(String(badge)),
      ),
    );
}

export default class RoscaeliferQueue extends View {
  init(rawProps, cx) {
    const initProps = {
      ...(rawProps && typeof rawProps === "object" ? rawProps : {}),
      ...(props() ?? {}),
    };
    if (initProps.dialogType) {
      this.isDialog = true;
      this.dialog = new DialogHandler(initProps, cx);
      return;
    }

    this.isDialog = false;
    this.handle = cx.focus_handle();
    this.tab = validTab(safeStorageGet(ACTIVE_TAB_KEY, "queue"));
    const storedShowEphemeral = safeStorageGet(SHOW_EPHEMERAL_KEY, true);
    this.showEphemeral =
      storedShowEphemeral === null || storedShowEphemeral === undefined
        ? true
        : Boolean(storedShowEphemeral);
    this.showDeferred = Boolean(safeStorageGet(SHOW_DEFERRED_KEY, false));
    const storedCountClosedStats = safeStorageGet(COUNT_CLOSED_STATS_KEY, true);
    this.countClosedStats =
      storedCountClosedStats === null || storedCountClosedStats === undefined
        ? true
        : Boolean(storedCountClosedStats);
    this.ctx = null;
    this.runner = null;
    this.snapshot = null;
    this.queue = null;
    // Multi-project workspace state.
    this.panelMode = "single";
    this.workspaceProjects = [];
    this.workspaceKey = "";
    this.projectSnapshots = [];
    this.projectFilter = "all";
    this._multiFp = null;
    this._multiQueue = null;
    this.pendingRefreshProjects = null;
    this.selectedId = null;
    this.detail = null;
    this.beadDetail = null;
    this.detailItemId = null;
    this.detailTaskId = null;
    this.detailBeadId = null;
    this.detailLoading = false;
    this.detailError = null;
    this.detailReqSeq = 0;
    this.detailCache = new Map();
    this.loading = false;
    this.loadingSilent = false;
    this.error = null;
    this.runnerMismatch = null;
    this.dismissedMismatchKey = "";
    this.size = null;
    this.watchedDirs = new Set();
    this.watchHandles = new Map();
    this.debounceTimer = null;
    this.pollTimer = null;
    this.pollIntervalMs = 0;
    this.refreshSeq = 0;
    this.refreshTask = null;
    this.loadingStartedAt = 0;
    this.ignoreSelfWatchUntil = 0;
    this._normSnapshot = null;
    this._normLiveFp = null;
    this._normQueue = null;
    this.lastRefreshSignal = shared("roscaelifer.refresh") ?? null;
    this.lastOverrideSignal = JSON.stringify(shared("roscaelifer.ctxOverride") ?? null);
    this.lastHerdrLocation = this.locationKey();
    this.signalTimer = null;
    this.projectsConfig = null;
    cx.spawn(async (loadCx) => {
      this.projectsConfig = await loadGlobalProjectsConfig();
      loadCx.notify();
    });

    this.beadsBoard = new BoardController(cx, { mode: "beads" });
    this.board = new BoardController(cx, { mode: "roscaelifer" });
    this.inspector = new InspectorController(cx);
    this.deps = new DepsController(cx);

    const guessedCtx = guessInitialContext(initProps, shared("roscaelifer.ctxOverride") ?? null);
    if (guessedCtx) {
      // Adopt the guessed context even without a cached snapshot, so the first render
      // does not see `!this.ctx` and kick off a second, competing refresh.
      const cached = loadCachedSnapshot(guessedCtx);
      this.ctx = guessedCtx;
      if (cached?.snapshot) {
        const cachedSnapshot = clearCachedRunnerState(cached.snapshot);
        this.snapshot = cachedSnapshot;
        this.queue = this.getNormalizedQueue(cachedSnapshot);
      }
    }

    this.actions = createActions({
      getCtx: () => this.ctx,
      getRunner: () => this.ensureRunner(),
      onBusyChange: (_busy, _keys, actionCx) => actionCx?.notify(),
      onRefresh: (actionCx) => {
        if (actionCx) {
          this.refresh(actionCx, { forceContext: false, preempt: true });
        } else {
          setShared("roscaelifer.refresh", Date.now());
        }
      },
    });

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "refresh") {
          this.refresh(cx, { forceContext: true, preempt: true });
        } else if (cmd === "tick") {
          this.runTick(cx);
        } else if (cmd === "new-bead") {
          this.openDialog("create");
        } else if (cmd === "new-wip") {
          this.openDialog("create-wip");
        } else if (cmd === "search") {
          this.setTab("queue");
          this.board.focusSearch();
        }
        cx.notify();
      }
    });

    // `herdr-app check` loads this mod for real: skip the background work it would start.
    if (checking()) return;

    // Gentle fallback polling (10s without local FS watch, relaxed to 30s when local watchFolder is active).
    this.updatePollTimer(cx, FALLBACK_POLL_MS);
    this.refresh(cx, { forceContext: true });
  }

  setTab(nextTab, cx = null) {
    const next = validTab(nextTab);
    if (next === this.tab) {
      cx?.notify?.();
      return;
    }
    this.tab = next;
    safeStorageSet(ACTIVE_TAB_KEY, next);
    cx?.notify?.();
  }

  close(cx) {
    if (this.isDialog) {
      return this.dialog?.close?.(cx);
    }
    if (this.debounceTimer) {
      this.debounceTimer.cancel();
      this.debounceTimer = null;
    }
    if (this.signalTimer) {
      this.signalTimer.cancel();
      this.signalTimer = null;
    }
    if (this.pollTimer) {
      this.pollTimer.cancel();
      this.pollTimer = null;
      this.pollIntervalMs = 0;
    }
    this.clearWatchers();
  }

  getNormalizedQueue(snapshot) {
    if (!snapshot) return null;
    const agentList = agents();
    const termList = terminals();
    const spaceList = spaces();
    const paneList = panes();
    const fp = herdrLiveFingerprint(agentList, termList, spaceList, paneList);
    if (this._normSnapshot === snapshot && this._normLiveFp === fp && this._normQueue) {
      return this._normQueue;
    }
    const q = normalizeQueue(snapshot, {
      agents: agentList,
      terminals: termList,
      spaces: spaceList,
      panes: paneList,
    });
    this._normSnapshot = snapshot;
    this._normLiveFp = fp;
    this._normQueue = q;
    return q;
  }

  liveHerdr() {
    return { agents: agents(), terminals: terminals(), spaces: spaces(), panes: panes() };
  }

  /** Re-merges pinned project queues, re-projecting live Herdr state only when it changes. */
  getAggregatedQueue() {
    const live = this.liveHerdr();
    const fp = herdrLiveFingerprint(live.agents, live.terminals, live.spaces, live.panes);
    if (this._multiFp === fp && this._multiQueue) return this._multiQueue;
    const merged = mergeNormalizedQueues(this.projectSnapshots, live);
    this._multiFp = fp;
    this._multiQueue = merged;
    return merged;
  }

  projectEntryFor(ctx) {
    if (!ctx) return null;
    const projectId = ctx.projectId || contextKey(ctx);
    return this.projectSnapshots.find((entry) => entry.projectId === projectId) || null;
  }

  selectedWorkspaceContexts() {
    const projects = this.workspaceProjects;
    if (this.projectFilter && this.projectFilter !== "all") {
      return projects.filter((ctx) => (ctx.projectId || contextKey(ctx)) === this.projectFilter);
    }
    return projects;
  }

  setProjectFilter(next, cx) {
    this.projectFilter = next || "all";
    if (this.deps) {
      this.deps.selectedEpicId = null;
      this.deps.chainFocusId = null;
    }
    this.selectedId = null;
    this.detail = null;
    this.beadDetail = null;
    this.detailItemId = null;
    this.detailTaskId = null;
    this.detailBeadId = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailReqSeq += 1;
    cx?.notify?.();
  }

  updatePollTimer(cx, intervalMs) {
    if (!cx?.timer || this.pollIntervalMs === intervalMs) return;
    if (this.pollTimer) {
      this.pollTimer.cancel();
      this.pollTimer = null;
    }
    this.pollIntervalMs = intervalMs;
    this.pollTimer = cx.timer.every(intervalMs, (tickCx) => this.refresh(tickCx, { silent: true }));
  }

  clearWatchers() {
    this.watchedDirs.clear();
    for (const handle of this.watchHandles.values()) {
      try {
        handle?.cancel?.();
      } catch {
        // Ignore cancel failures on already settled watches.
      }
    }
    this.watchHandles.clear();
  }

  setShowEphemeral(next, cx) {
    const value = Boolean(next);
    if (value === this.showEphemeral) return;
    this.showEphemeral = value;
    safeStorageSet(SHOW_EPHEMERAL_KEY, value);
    this.detailCache.clear();
    cx?.notify?.();
    this.refresh(cx, { forceContext: false, preempt: true });
  }

  setShowDeferred(next, cx) {
    const value = Boolean(next);
    if (value === this.showDeferred) return;
    this.showDeferred = value;
    safeStorageSet(SHOW_DEFERRED_KEY, value);
    cx?.notify?.();
  }

  setCountClosedStats(next, cx) {
    const value = Boolean(next);
    if (value === this.countClosedStats) return;
    this.countClosedStats = value;
    safeStorageSet(COUNT_CLOSED_STATS_KEY, value);
    cx?.notify?.();
  }

  async ensureRunner() {
    if (this.runner) return this.runner;
    this.runner = await resolveBinary(this.ctx);
    return this.runner;
  }

  locationKey() {
    const f = focused();
    const s = spaces().find((sp) => sp.active);
    return `${f?.cwd || ""}|${s?.id || ""}|${s?.folder || ""}|${s?.machine || ""}`;
  }

  scheduleDebouncedRefresh(cx, projectId = null) {
    if (projectId) {
      this.pendingRefreshProjects = this.pendingRefreshProjects || new Set();
      this.pendingRefreshProjects.add(projectId);
    }
    if (this.debounceTimer) this.debounceTimer.cancel();
    this.debounceTimer = cx.timer.after(250, (timerCx) => {
      this.debounceTimer = null;
      const only = this.pendingRefreshProjects;
      this.pendingRefreshProjects = null;
      this.refresh(timerCx, { silent: true, onlyProjectIds: only });
    });
  }

  shouldIgnoreSelfWatch(changed) {
    if (!this.loading && !this.detailLoading && Date.now() >= this.ignoreSelfWatchUntil) {
      return false;
    }
    if (!Array.isArray(changed) || changed.length === 0) return false;
    return changed.every((entry) => {
      const name = String(entry ?? "").split("/").pop();
      if (!name) return false;
      return (
        name.endsWith(".db-wal") ||
        name.endsWith(".db-shm") ||
        name.endsWith(".db.lock") ||
        name === "dolt-server.log" ||
        name.endsWith(".lock")
      );
    });
  }

  ensureWatchers(cx) {
    const targets = (
      this.panelMode === "multi" ? this.workspaceProjects : this.ctx ? [this.ctx] : []
    ).filter((ctx) => ctx && !ctx.machine);
    if (targets.length === 0) {
      this.clearWatchers();
      this.updatePollTimer(cx, FALLBACK_POLL_MS);
      return;
    }

    // `dir -> projectId` for every local project so a change only refreshes the
    // project that owns the directory, not the whole workspace.
    const wanted = new Map();
    for (const ctx of targets) {
      const projectId = ctx.projectId || contextKey(ctx);
      const dirs = new Set();
      if (ctx.repo) {
        dirs.add(`${ctx.repo}/.roscaelifer`);
        dirs.add(`${ctx.repo}/.beads`);
      }
      if (ctx.bdDir) dirs.add(ctx.bdDir);
      if (ctx.db) {
        const idx = ctx.db.lastIndexOf("/");
        if (idx > 0) dirs.add(ctx.db.slice(0, idx));
      }
      for (const dir of dirs) {
        if (dir && !wanted.has(dir)) wanted.set(dir, projectId);
      }
    }

    for (const dir of [...this.watchedDirs]) {
      if (wanted.has(dir)) continue;
      this.watchedDirs.delete(dir);
      const handle = this.watchHandles.get(dir);
      this.watchHandles.delete(dir);
      try {
        handle?.cancel?.();
      } catch {
        // Ignore cancel failures on already settled watches.
      }
    }

    for (const [dir, projectId] of wanted) {
      if (this.watchedDirs.has(dir)) continue;
      this.watchedDirs.add(dir);
      cx.spawn(async (watchCx) => {
        try {
          while (this.watchedDirs.has(dir)) {
            const handle = watchFolder(dir);
            this.watchHandles.set(dir, handle);
            const changed = await handle;
            if (!this.watchedDirs.has(dir)) break;
            if (Array.isArray(changed) && changed.length === 0) continue;
            if (this.shouldIgnoreSelfWatch(changed)) continue;
            this.scheduleDebouncedRefresh(watchCx, projectId);
          }
        } catch {
          this.watchedDirs.delete(dir);
          this.watchHandles.delete(dir);
          if (this.watchedDirs.size === 0) {
            this.updatePollTimer(watchCx, FALLBACK_POLL_MS);
          }
        }
      });
    }

    this.updatePollTimer(cx, this.watchedDirs.size > 0 ? LOCAL_WATCH_POLL_MS : FALLBACK_POLL_MS);
  }

  applyCachedContext(nextCtx, cx) {
    const cached = loadCachedSnapshot(nextCtx);
    if (cached?.snapshot) {
      const cachedSnapshot = clearCachedRunnerState(cached.snapshot);
      this.snapshot = cachedSnapshot;
      this.queue = this.getNormalizedQueue(cachedSnapshot);
      this.error = null;
    } else {
      this.snapshot = null;
      this.queue = null;
      this.error = null;
    }
    cx.notify();
  }

  buildProjectSnapshots(contexts) {
    return contexts.map((ctx) => {
      const projectId = ctx.projectId || contextKey(ctx);
      const cached = loadCachedSnapshot(ctx);
      const snapshot = cached?.snapshot ? clearCachedRunnerState(cached.snapshot) : null;
      return {
        projectId,
        projectName: ctx.label || repoLabel(ctx),
        projectCtx: ctx,
        snapshot,
        runner: null,
        error: null,
      };
    });
  }

  applyCachedWorkspace(cx) {
    this.projectSnapshots = this.buildProjectSnapshots(this.workspaceProjects);
    this._multiFp = null;
    this._multiQueue = null;
    this.snapshot = null;
    this.queue = this.getAggregatedQueue();
    this.error = null;
    cx?.notify?.();
  }

  resetDetailState() {
    this.selectedId = null;
    this.detail = null;
    this.beadDetail = null;
    this.detailItemId = null;
    this.detailTaskId = null;
    this.detailBeadId = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailReqSeq += 1;
    this.detailCache.clear();
  }

  refresh(cx, { forceContext = false, preempt = false, silent = false, onlyProjectIds = null } = {}) {
    // Only an explicit override switch or signal refresh may preempt the refresh already
    // in flight: starting a second one bumps refreshSeq and strands the first one's
    // loading. A refresh that has been stuck for >35s is also reclaimed so the UI can
    // never latch on a dead task.
    const stale = this.loadingStartedAt > 0 && Date.now() - this.loadingStartedAt > 35000;
    if (this.loading && !preempt && !stale) {
      // A silent background refresh is in flight; an explicit refresh must still give the
      // user feedback, so surface the busy state instead of swallowing the request.
      if (!silent && this.loadingSilent) {
        this.loadingSilent = false;
        cx.notify();
      }
      return;
    }
    const seq = ++this.refreshSeq;
    this.loading = true;
    this.loadingSilent = Boolean(silent);
    this.loadingStartedAt = Date.now();
    if (!silent) cx.notify();

    this.refreshTask = cx.spawn(async (cx) => {
      try {
        const rawProps = props() ?? {};
        const sharedOverride = shared("roscaelifer.ctxOverride") ?? null;
        // projects.json can change outside this view (dialog save, external edit),
        // so re-read it on every refresh; it is a single local file.
        {
          let config = null;
          try {
            config = await loadGlobalProjectsConfig();
          } catch {
            config = null;
          }
          if (seq !== this.refreshSeq) return;
          if (config) this.projectsConfig = config;
        }

        const workspace = this.projectsConfig
          ? resolveWorkspaceProjects(this.projectsConfig, rawProps)
          : { mode: "single", projects: [] };

        if (workspace.mode === PANEL_MODE_MULTI && workspace.projects.length > 1) {
          await this.refreshWorkspace(cx, { seq, workspace, onlyProjectIds });
          return;
        }

        if (this.panelMode === "multi") {
          this.panelMode = "single";
          this.workspaceProjects = [];
          this.projectSnapshots = [];
          this.workspaceKey = "";
          this.projectFilter = "all";
          this._multiFp = null;
          this._multiQueue = null;
          this.clearWatchers();
        }

        if (forceContext || !this.ctx || sharedOverride) {
          const nextCtx = await resolveContext(rawProps, {
            focusedInfo: focused(),
            spaceList: spaces(),
            paneList: panes(),
            sharedOverride,
          });
          if (seq !== this.refreshSeq) return;
          if (contextKey(nextCtx) !== contextKey(this.ctx)) {
            const repoChanged = repoIdentityKey(nextCtx) !== repoIdentityKey(this.ctx);
            this.runnerMismatch = null;
            this.ctx = nextCtx;
            this.runner = null;
            this.clearWatchers();
            this.updatePollTimer(cx, FALLBACK_POLL_MS);
            if (repoChanged) {
              this.selectedId = null;
              this.detail = null;
              this.beadDetail = null;
              this.detailItemId = null;
              this.detailTaskId = null;
              this.detailBeadId = null;
              this.detailError = null;
              this.detailLoading = false;
              this.detailReqSeq += 1;
              this.detailCache.clear();
            }
            if (nextCtx) {
              this.applyCachedContext(nextCtx, cx);
            }
          }
        }

        if (!this.ctx) {
          this.snapshot = null;
          this.queue = null;
          this.error = "No roscaelifer project detected. Open Project Config to select or create one.";
          return;
        }

        const runner = await this.ensureRunner();
        if (seq !== this.refreshSeq) return;
        const snap = await fetchSnapshot(this.ctx, runner, {
          includeEphemeral: this.showEphemeral,
          onRunnerResolved: (freshRunner) => {
            if (seq === this.refreshSeq) this.runner = freshRunner;
          },
        });
        if (seq !== this.refreshSeq) return;
        this.snapshot = snap;
        this.error = null;
        saveCachedSnapshot(this.ctx, snap);
        this.ensureWatchers(cx);

        if (snap?.runner?.active === true) {
          if (this.runnerMismatch) {
            this.runnerMismatch = null;
            cx.notify();
          }
        } else if (this.ctx && !checking()) {
          // Runner probing runs off the critical path so it cannot delay the first
          // paint or the Refresh button.
          const probeCtx = this.ctx;
          cx.spawn(async (mismatchCx) => {
            try {
              const mismatch = await detectActiveRunnerMismatch(probeCtx);
              if (seq !== this.refreshSeq || contextKey(probeCtx) !== contextKey(this.ctx)) return;
              if (this.snapshot?.runner?.active === true) return;
              const nextKey = mismatch ? JSON.stringify(mismatch) : "";
              const currentKey = this.runnerMismatch ? JSON.stringify(this.runnerMismatch) : "";
              if (nextKey !== currentKey) {
                this.runnerMismatch = mismatch;
                mismatchCx.notify();
              }
            } catch {
              // Best-effort probe: a ps failure must not affect the queue.
            }
          });
        }

        this.queue = this.getNormalizedQueue(snap);

        const selected = this.selectedId ? this.queue.itemsById.get(this.selectedId) : null;
        if (selected && (selected.taskId || selected.beadId)) {
          // Detail fetch runs in its own task so a slow single item never blocks the
          // snapshot refresh or the Refresh button.
          cx.spawn(async (detailCx) => {
            await this.loadItemDetail(selected, { runnerOverride: runner, force: true, silent: true });
            detailCx.notify();
          });
        } else if (!selected) {
          this.detail = null;
          this.beadDetail = null;
          this.detailItemId = null;
          this.detailTaskId = null;
          this.detailBeadId = null;
          this.detailError = null;
          this.detailLoading = false;
        }
      } catch (err) {
        if (seq === this.refreshSeq) {
          this.error = err?.message || String(err);
        }
      } finally {
        if (seq === this.refreshSeq) {
          this.loading = false;
          this.loadingSilent = false;
          this.loadingStartedAt = 0;
          this.ignoreSelfWatchUntil = Date.now() + 1200;
          cx.notify();
        }
      }
    });
  }

  /**
   * Multi-project refresh: one parallel fetchSnapshot per pinned project via
   * Promise.allSettled, so a single broken project keeps its error badge while the
   * others keep rendering. Only projects whose watch dirs changed are refetched.
   */
  async refreshWorkspace(cx, { seq, workspace, onlyProjectIds }) {
    const projects = workspace.projects;
    const workspaceKey = projects.map((ctx) => contextKey(ctx)).join("||");
    const previous = new Map(this.projectSnapshots.map((entry) => [entry.projectId, entry]));
    const entries = projects.map((ctx) => {
      const projectId = ctx.projectId || contextKey(ctx);
      const existing = previous.get(projectId);
      return {
        projectId,
        projectName: ctx.label || repoLabel(ctx),
        projectCtx: ctx,
        snapshot: existing?.snapshot || null,
        runner: existing?.runner || null,
        error: existing?.error || null,
      };
    });
    const contextChanged = this.panelMode !== "multi" || workspaceKey !== this.workspaceKey;
    this.panelMode = "multi";
    this.workspaceProjects = projects;
    this.workspaceKey = workspaceKey;
    this.projectSnapshots = entries;
    this.ctx = projects[0];

    if (contextChanged) {
      this.runnerMismatch = null;
      this.clearWatchers();
      this.updatePollTimer(cx, FALLBACK_POLL_MS);
      this.resetDetailState();
      if (
        this.projectFilter !== "all" &&
        !projects.some((ctx) => (ctx.projectId || contextKey(ctx)) === this.projectFilter)
      ) {
        this.projectFilter = "all";
      }
      this.applyCachedWorkspace(cx);
    }

    if (entries.length === 0) {
      this.snapshot = null;
      this.queue = null;
      this._multiFp = null;
      this._multiQueue = null;
      this.error = "No roscaelifer project detected. Open Project Config to select or create one.";
      return;
    }

    const targets = entries.filter(
      (entry) => !onlyProjectIds || onlyProjectIds.has(entry.projectId),
    );
    const fetchOpts = {
      includeEphemeral: this.showEphemeral,
    };
    const settled = await Promise.allSettled(
      targets.map(async (entry) => {
        const runner = await resolveBinary(entry.projectCtx);
        const snap = await fetchSnapshot(entry.projectCtx, runner, fetchOpts);
        return { entry, runner, snap };
      }),
    );
    if (seq !== this.refreshSeq) return;

    settled.forEach((result, index) => {
      const entry = targets[index];
      if (result.status === "fulfilled") {
        entry.snapshot = result.value.snap;
        entry.runner = result.value.runner;
        entry.error = null;
        saveCachedSnapshot(entry.projectCtx, result.value.snap);
      } else {
        entry.error = result.reason?.message || String(result.reason);
      }
    });

    this._multiFp = null;
    this._multiQueue = null;
    this.snapshot = null;
    this.queue = this.getAggregatedQueue();
    this.error = null;
    this.ensureWatchers(cx);

    const anyActive = entries.some((entry) => entry.snapshot?.runner?.active === true);
    if (anyActive && this.runnerMismatch) {
      this.runnerMismatch = null;
      cx.notify();
    }

    const selected = this.selectedId ? this.queue.itemsById.get(this.selectedId) : null;
    if (selected && (selected.taskId || selected.beadId)) {
      const owner = this.projectEntryFor(selected.projectCtx);
      cx.spawn(async (detailCx) => {
        await this.loadItemDetail(selected, {
          runnerOverride: owner?.runner || null,
          force: true,
          silent: true,
        });
        detailCx.notify();
      });
    } else if (!selected) {
      this.detail = null;
      this.beadDetail = null;
      this.detailItemId = null;
      this.detailTaskId = null;
      this.detailBeadId = null;
      this.detailError = null;
      this.detailLoading = false;
    }
  }

  switchToDetectedRunner(cx) {
    const mismatch = this.runnerMismatch;
    const ctx = this.ctx;
    if (!mismatch || !ctx) return;
    cx.spawn(async (switchCx) => {
      let savedProject = false;
      if (ctx.projectId) {
        try {
          const config = await loadGlobalProjectsConfig();
          const project = config.projects.find((item) => item.id === ctx.projectId);
          if (project) {
            await upsertGlobalProject(
              {
                ...project,
                db: mismatch.db,
                formulasDir: mismatch.formulasDir || project.formulasDir,
                config: project.config || mismatch.config,
                bdDir: project.bdDir || mismatch.bdDir,
                env: project.env || mismatch.env,
                updatedAt: Date.now(),
              },
              project.id,
            );
            savedProject = true;
          }
        } catch (err) {
          this.error = `Unable to update saved project: ${err?.message || String(err)}`;
        }
      }
      if (savedProject) {
        setShared("roscaelifer.ctxOverride", null);
      } else {
        setShared("roscaelifer.ctxOverride", {
          ...ctx,
          db: mismatch.db,
          formulasDir: mismatch.formulasDir || ctx.formulasDir,
          config: mismatch.config || ctx.config,
          bdDir: mismatch.bdDir || ctx.bdDir,
          env: mismatch.env || ctx.env,
          source: "runner",
          updatedAt: Date.now(),
        });
      }
      setShared("roscaelifer.refresh", Date.now());
      this.runnerMismatch = null;
      switchCx.notify();
      this.refresh(switchCx, { forceContext: true, preempt: true });
    });
  }

  detailCacheKey(item) {
    const includeEphemeral = Boolean(this.showEphemeral || item?.ephemeral);
    const itemCtx = item?.projectCtx || this.ctx;
    return `${contextKey(itemCtx)}|ephemeral:${includeEphemeral ? "1" : "0"}|${item?.taskId || ""}|${item?.beadId || ""}`;
  }

  setDetailCacheEntry(key, taskDetail, beadDetail) {
    if (this.detailCache.has(key)) {
      this.detailCache.delete(key);
    }
    this.detailCache.set(key, {
      taskDetail,
      beadDetail,
      fetchedAt: Date.now(),
    });
    while (this.detailCache.size > DETAIL_CACHE_MAX) {
      const oldestKey = this.detailCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.detailCache.delete(oldestKey);
    }
  }

  async loadItemDetail(item, { runnerOverride = null, force = false, silent = false } = {}) {
    const taskId = item?.taskId || null;
    const beadId = item?.beadId || null;
    const itemId = item?.id || null;
    // Items from the multi-project board carry their own project context; never
    // fall back to another project's DB/config when fetching details.
    const itemCtx = item?.projectCtx || this.ctx;
    if (!itemId || !itemCtx || (!taskId && !beadId)) {
      this.detail = null;
      this.beadDetail = null;
      this.detailItemId = itemId;
      this.detailTaskId = null;
      this.detailBeadId = null;
      this.detailError = null;
      this.detailLoading = false;
      return;
    }

    const cacheKey = this.detailCacheKey(item);
    if (!force && this.detailCache.has(cacheKey)) {
      const cached = this.detailCache.get(cacheKey);
      if (Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
        this.detail = cached.taskDetail;
        this.beadDetail = cached.beadDetail;
        this.detailItemId = itemId;
        this.detailTaskId = taskId;
        this.detailBeadId = beadId;
        this.detailError = null;
        this.detailLoading = false;
        return;
      }
      this.detailCache.delete(cacheKey);
    }

    const reqSeq = ++this.detailReqSeq;
    const quietUpdate =
      silent && this.detailItemId === itemId && (this.detail !== null || this.beadDetail !== null);
    if (!quietUpdate) {
      this.detailLoading = true;
    }
    this.detailError = null;
    this.detailItemId = itemId;
    this.detailTaskId = taskId;
    this.detailBeadId = beadId;

    try {
      const runner = runnerOverride || (await resolveBinary(itemCtx));
      if (this.detailReqSeq !== reqSeq || this.selectedId !== itemId) return;

      const [taskRes, beadRes] = await Promise.allSettled([
        taskId ? fetchTaskDetail(itemCtx, runner, taskId) : Promise.resolve(null),
        beadId
          ? fetchBeadDetail(itemCtx, runner, beadId, {
              includeEphemeral: Boolean(this.showEphemeral || item?.ephemeral),
            })
          : Promise.resolve(null),
      ]);
      if (this.detailReqSeq !== reqSeq || this.selectedId !== itemId) return;

      const errors = [];
      const nextTaskDetail = taskRes.status === "fulfilled" ? taskRes.value : null;
      if (taskRes.status === "rejected") {
        errors.push(taskRes.reason?.message || String(taskRes.reason));
      }
      const nextBeadDetail = beadRes.status === "fulfilled" ? beadRes.value : null;
      if (beadRes.status === "rejected") {
        errors.push(beadRes.reason?.message || String(beadRes.reason));
      }

      if (taskRes.status === "fulfilled") this.detail = nextTaskDetail;
      if (beadRes.status === "fulfilled") this.beadDetail = nextBeadDetail;
      this.detailError = errors.length > 0 ? errors.join(" | ") : null;

      if (errors.length === 0) {
        this.setDetailCacheEntry(cacheKey, nextTaskDetail, nextBeadDetail);
      }
    } catch (err) {
      if (this.detailReqSeq === reqSeq && this.selectedId === itemId) {
        this.detailError = err?.message || String(err);
      }
    } finally {
      this.ignoreSelfWatchUntil = Date.now() + 1200;
      if (this.detailReqSeq === reqSeq && this.selectedId === itemId) {
        this.detailLoading = false;
      }
    }
  }

  selectItem(item, cx, { forceDetail = false } = {}) {
    if (!item) {
      this.selectedId = null;
      this.detail = null;
      this.beadDetail = null;
      this.detailItemId = null;
      this.detailTaskId = null;
      this.detailBeadId = null;
      this.detailError = null;
      this.detailLoading = false;
      this.detailReqSeq += 1;
      cx?.notify();
      return;
    }

    const switching = this.detailItemId !== item.id;
    this.selectedId = item.id;
    this.detailItemId = item.id;
    this.detailTaskId = item.taskId || null;
    this.detailBeadId = item.beadId || null;
    this.detailError = null;
    if (switching) {
      this.detail = null;
      this.beadDetail = null;
    }

    if (!item.taskId && !item.beadId) {
      this.detail = null;
      this.beadDetail = null;
      this.detailLoading = false;
      this.detailReqSeq += 1;
      cx?.notify();
      return;
    }

    const cacheKey = this.detailCacheKey(item);
    if (!forceDetail && this.detailCache.has(cacheKey)) {
      const cached = this.detailCache.get(cacheKey);
      if (Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
        this.detail = cached.taskDetail;
        this.beadDetail = cached.beadDetail;
        this.detailLoading = false;
        this.detailReqSeq += 1;
        cx?.notify();
        return;
      }
    }

    this.detailLoading = true;
    cx?.notify();
    if (cx?.spawn) {
      cx.spawn(async (spawnCx) => {
        await this.loadItemDetail(item, { force: forceDetail });
        spawnCx.notify();
      });
    }
  }

  dialogTargetCtx(dialogType, extra = {}) {
    if (extra?.ctx) return extra.ctx;
    const itemCtx = extra?.item?.projectCtx || null;
    if (itemCtx) return itemCtx;
    // A single explicit `projects` override (e.g. Clean Pending scoped by the
    // project filter) targets that project.
    if (Array.isArray(extra?.projects) && extra.projects.length === 1 && extra.projects[0]?.ctx) {
      return extra.projects[0].ctx;
    }
    if (dialogType === "create" || dialogType === "create-wip") {
      if (this.panelMode === "multi") {
        if (this.projectFilter && this.projectFilter !== "all") {
          const match = this.workspaceProjects.find(
            (ctx) => (ctx.projectId || contextKey(ctx)) === this.projectFilter,
          );
          if (match) return match;
        }
        const activeId = this.projectsConfig?.activeProject;
        if (activeId) {
          const match = this.workspaceProjects.find((ctx) => ctx.projectId === activeId);
          if (match) return match;
        }
      }
      return this.workspaceProjects[0] || this.ctx;
    }
    return this.ctx;
  }

  openDialog(dialogType, extra = {}) {
    if (this.isDialog) return;

    const dims = {
      create: { width: 540, height: 560 },
      "create-wip": { width: 560, height: 660 },
      enqueue: { width: 460, height: 400 },
      reject: { width: 460, height: 320 },
      "clean-preview": { width: 560, height: 480 },
      "project-config": { width: 640, height: 720 },
      "repo-config": { width: 640, height: 720 },
    };
    const size = dims[dialogType] || { width: 480, height: 380 };
    const dialogCtx = this.dialogTargetCtx(dialogType, extra);
    const projectEntries = this.workspaceProjects.map((ctx) => ({
      id: ctx.projectId || contextKey(ctx),
      name: ctx.label || repoLabel(ctx),
      ctx,
    }));

    openOverlay({
      mod: "roscaelifer-queue",
      kind: "dialog",
      modal: true,
      width: size.width,
      height: size.height,
      props: {
        dialogType,
        ctx: dialogCtx,
        projects: projectEntries,
        targetProjectId: dialogCtx?.projectId || "",
        formulas: this.queue?.formulas || [],
        envs: this.queue?.envs || [],
        items: (this.queue?.items || []).slice(0, 100).map((i) => ({
          id: i.id,
          beadId: i.beadId,
          title: i.title,
          status: i.status,
          column: i.column,
          projectId: i.projectId,
          projectName: i.projectName,
        })),
        history: loadRepoHistory(),
        projectsConfig: this.projectsConfig,
        ...extra,
      },
    });
  }

  runTick(cx) {
    if (this.panelMode === "multi") {
      const targets = this.selectedWorkspaceContexts();
      if (targets.length === 0) return Promise.resolve();
      return this.actions.tickProjects(targets, cx);
    }
    return this.actions.tick({}, cx);
  }

  runCleanDialog() {
    if (this.panelMode === "multi") {
      const targets = this.selectedWorkspaceContexts();
      if (targets.length === 1) {
        const ctx = targets[0];
        this.openDialog("clean-preview", {
          projects: [{ id: ctx.projectId || contextKey(ctx), name: ctx.label || repoLabel(ctx), ctx }],
        });
        return;
      }
    }
    this.openDialog("clean-preview", {});
  }

  handleKeyDown(e, cx) {
    const activeBoard = this.tab === "beads" ? this.beadsBoard : this.tab === "queue" ? this.board : null;
    if (this.beadsBoard.searchFocused || this.board.searchFocused) {
      if (e.key === "escape") {
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }
    if (e.key === "escape" && this.selectedId) {
      this.selectItem(null, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "/") {
      if (activeBoard) activeBoard.focusSearch();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "r") {
      this.refresh(cx, { forceContext: false });
      cx.stop_propagation();
      return;
    }
    if (e.key === "t") {
      this.runTick(cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "n") {
      this.openDialog("create");
      cx.stop_propagation();
      return;
    }
    const shortcutTabs = { "1": "beads", "2": "queue", "3": "deps", "4": "mirror" };
    if (shortcutTabs[e.key]) {
      this.setTab(shortcutTabs[e.key], cx);
      cx.stop_propagation();
      return;
    }
    if (activeBoard && (e.key === "j" || e.key === "down" || e.key === "k" || e.key === "up")) {
      const visible = activeBoard.getVisibleItems();
      if (!visible.length) return;
      const idx = visible.findIndex((i) => i.id === this.selectedId);
      const step = e.key === "j" || e.key === "down" ? 1 : -1;
      const nextIdx = idx < 0 ? 0 : (idx + step + visible.length) % visible.length;
      this.selectItem(visible[nextIdx], cx);
      cx.stop_propagation();
    }
  }

  renderTopBar(t) {
    const queue = this.queue;
    const runner = queue?.runner || {};
    const multi = this.panelMode === "multi" && this.workspaceProjects.length > 1;
    const projectCount = this.workspaceProjects.length;
    const runnerPerProject = Array.isArray(runner.perProject) ? runner.perProject : [];
    const activeRunners = multi
      ? runnerPerProject.filter((entry) => entry.active).length
      : 0;
    const runnerActive = multi
      ? activeRunners > 0
      : runner.active !== undefined
        ? Boolean(runner.active)
        : Boolean(runner.lock_held);
    const runnerTooltip = multi
      ? [
          `${activeRunners}/${runnerPerProject.length || projectCount} runners active`,
          ...runnerPerProject.map((entry) =>
            [
              `${entry.projectName}: ${entry.active ? `active${entry.pid ? ` pid ${entry.pid}` : ""}` : "idle"}`,
              shortenHomePath(entry.db),
              entry.error ? `error: ${entry.error}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ].join("\n")
      : runnerActive
        ? [`Runner active`, runner.pid ? `pid ${runner.pid}` : "", runner.mode || "", runner.log_path || ""]
            .filter(Boolean)
            .join(" · ")
        : "Runner idle (starts automatically on Queue / Dispatch)";
    const runnerLabel = multi
      ? `${activeRunners}/${runnerPerProject.length || projectCount} runners active`
      : runnerActive
        ? "Runner active"
        : "Runner idle";
    const pickerLabel = multi
      ? `Multi · ${projectCount} projects`
      : this.ctx
        ? repoLabel(this.ctx)
        : "No project";
    const pendingCleanups = (queue?.items || []).reduce(
      (sum, item) => sum + (item.pendingCleanupCount || 0),
      0,
    );

    return h_flex()
      .flex_none()
      .h(46)
      .px(12)
      .gap(10)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            Button.new("project-picker")
              .h(28)
              .px(10)
              .gap(6)
              .rounded(6)
              .flex()
              .items_center()
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .font_medium()
              .text_color(t.foreground)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click(() => this.openDialog("project-config"))
              .child(svg("mods/roscaelifer-queue/icons/folder.svg").size(13).flex_none().text_color(t.muted))
              .child(div().max_w(180).truncate().child(pickerLabel)),
          )
          .child(
            h_flex()
              .px(8)
              .h(24)
              .gap(5)
              .items_center()
              .rounded(5)
              .tooltip(runnerTooltip)
              .bg(runnerActive ? (t.working || t.accent) + "20" : t.raised)
              .text_size(11)
              .text_color(runnerActive ? t.working || t.accent : t.dim)
              .when(runnerActive, (el) =>
                el.child(
                  svg("mods/roscaelifer-queue/icons/spinner.svg")
                    .size(10)
                    .flex_none()
                    .spin(900),
                ),
              )
              .child(div().size(6).rounded(3).bg(t.dim))
              .child(runnerLabel),
          ),
      )
      .child(
        Tabs.new("main-tabs")
          .flex()
          .items_center()
          .gap(4)
          .children(
            TABS.map((tb) => {
              const active = this.tab === tb.id;
              return Tab.new(`tab-${tb.id}`)
                .selected(active)
                .h(28)
                .px(10)
                .rounded(6)
                .flex()
                .items_center()
                .text_size(12)
                .font_medium()
                .cursor_pointer()
                .bg(active ? t.selected : t.chrome)
                .text_color(active ? t.foreground : t.muted)
                .when(active, (el) => el.border_1().border_color(t.border))
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.setTab(tb.id, cx);
                })
                .child(tb.label);
            }),
          ),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            topButton("btn-new-wip", "New WIP Card", "mods/roscaelifer-queue/icons/plus.svg", {
              bg: t.raised,
              fg: t.foreground,
              border: t.border,
              onClick: () => this.openDialog("create-wip"),
            }),
          )
          .child(
            topButton("btn-new-bead", "New Bead", "mods/roscaelifer-queue/icons/plus.svg", {
              bg: t.solid,
              fg: t.solid_foreground,
              onClick: () => this.openDialog("create"),
            }),
          )
          .child(
            topButton("btn-tick", "Tick", "mods/roscaelifer-queue/icons/play.svg", {
              bg: t.raised,
              fg: t.foreground,
              border: t.border,
              busy: this.actions.isBusy("tick"),
              onClick: (_e, cx) => this.runTick(cx),
            }),
          )
          .child(
            topButton("btn-clean", "Clean Pending", "mods/roscaelifer-queue/icons/clean.svg", {
              bg: t.raised,
              fg: pendingCleanups > 0 ? t.blocked || t.ansi3 : t.muted,
              border: t.border,
              badge: pendingCleanups,
              onClick: () => this.runCleanDialog(),
            }),
          )
          .child(
            topButton("btn-refresh", "Refresh", "mods/roscaelifer-queue/icons/refresh.svg", {
              bg: t.raised,
              fg: t.foreground,
              border: t.border,
              busy: this.loading && !this.loadingSilent,
              onClick: (_e, cx) => this.refresh(cx, { forceContext: false, preempt: true }),
            }),
          ),
      );
  }

  render(cx) {
    if (this.isDialog) {
      return this.dialog.render(cx);
    }

    const refreshSignal = shared("roscaelifer.refresh") ?? null;
    const overrideSignal = JSON.stringify(shared("roscaelifer.ctxOverride") ?? null);
    const loc = this.locationKey();
    const overrideChanged = overrideSignal !== this.lastOverrideSignal;
    const refreshChanged = refreshSignal !== this.lastRefreshSignal;
    if (
      (refreshSignal !== this.lastRefreshSignal ||
        overrideChanged ||
        (!this.ctx && !this.loading && loc !== this.lastHerdrLocation)) &&
      !checking()
    ) {
      this.lastRefreshSignal = refreshSignal;
      this.lastOverrideSignal = overrideSignal;
      this.lastHerdrLocation = loc;
      // `render` hands out a call-scoped `Context`; the timer callback owns the task.
      if (this.signalTimer) {
        this.signalTimer.cancel();
        this.signalTimer = null;
      }
      this.signalTimer = cx.timer.after(0, (timerCx) => {
        this.signalTimer = null;
        this.refresh(timerCx, {
          forceContext: overrideChanged || !this.ctx,
          preempt: overrideChanged || refreshChanged,
          silent: true,
        });
      });
    }

    const t = theme();
    const mismatch = this.runnerMismatch;
    const mismatchKey = mismatch && this.ctx ? `${this.ctx.db || ""}|${mismatch.db || ""}` : "";
    const showRunnerMismatch = Boolean(mismatch && mismatchKey && mismatchKey !== this.dismissedMismatchKey);
    const mismatchNote =
      mismatch?.formulasDir && this.ctx?.formulasDir && mismatch.formulasDir !== this.ctx.formulasDir
        ? ` · formulas ${shortenHomePath(mismatch.formulasDir)}`
        : "";
    // Re-project live Herdr agents/terminals only when snapshot ref or live Herdr fingerprint changes.
    const queue =
      this.panelMode === "multi"
        ? this.getAggregatedQueue()
        : this.snapshot
          ? this.getNormalizedQueue(this.snapshot)
          : this.queue;
    if (queue) this.queue = queue;
    const projectErrors =
      this.panelMode === "multi"
        ? (queue?.projects || []).filter((project) => Boolean(project.error))
        : [];

    const selectedItem =
      this.selectedId && queue ? queue.itemsById.get(this.selectedId) || null : null;

    const inspectorWidth = Math.min(420, Math.max(280, Math.round((this.size?.width ?? 1200) * 0.35)));

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.handleKeyDown(e, cx))
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .child(this.renderTopBar(t))
      .when(Boolean(this.error), (el) =>
        el.child(
          h_flex()
            .px(12)
            .py(8)
            .gap(8)
            .items_center()
            .justify_between()
            .bg((t.ansi1 || t.blocked) + "20")
            .border_b(1)
            .border_color(t.border)
            .child(div().text_size(12).text_color(t.ansi1 || t.blocked).child(this.error))
            .child(
              Button.new("err-project-cfg")
                .h(24)
                .px(8)
                .rounded(5)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11.5)
                .on_click(() => this.openDialog("project-config"))
                .child("Configure Project"),
            ),
        ),
      )
      .when(showRunnerMismatch, (el) =>
        el.child(
          h_flex()
            .px(12)
            .py(8)
            .gap(8)
            .items_center()
            .justify_between()
            .bg((t.ansi3 || t.blocked || t.accent) + "20")
            .border_b(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(t.ansi3 || t.blocked || t.accent)
                .child(
                  `Active runner (PID ${mismatch.pid}) detected on ${shortenHomePath(mismatch.db)}${mismatchNote}`,
                ),
            )
            .child(
              h_flex()
                .gap(6)
                .child(
                  Button.new("runner-mismatch-switch")
                    .h(24)
                    .px(8)
                    .rounded(5)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11.5)
                    .on_click((_e, clickCx) => this.switchToDetectedRunner(clickCx))
                    .child("Switch DB"),
                )
                .child(
                  Button.new("runner-mismatch-dismiss")
                    .h(24)
                    .px(8)
                    .rounded(5)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11.5)
                    .on_click((_e, clickCx) => {
                      this.dismissedMismatchKey = mismatchKey;
                      clickCx.notify();
                    })
                    .child("Dismiss"),
                ),
            ),
        ),
      )
      .when(projectErrors.length > 0, (el) =>
        el.child(
          v_flex()
            .flex_none()
            .bg((t.ansi1 || t.blocked) + "18")
            .border_b(1)
            .border_color(t.border)
            .children(
              projectErrors.map((project) =>
                h_flex()
                  .px(12)
                  .py(5)
                  .gap(8)
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(6)
                      .items_center()
                      .child(div().size(7).rounded(4).bg(project.color || t.accent))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(project.name))
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(11.5)
                          .text_color(t.ansi1 || t.blocked)
                          .tooltip(project.error)
                          .child(project.error),
                      ),
                  )
                  .child(
                    Button.new(`project-retry-${project.id}`)
                      .h(22)
                      .px(8)
                      .rounded(5)
                      .bg(t.raised)
                      .border_1()
                      .border_color(t.border)
                      .text_size(11)
                      .on_click((_e, clickCx) => {
                        this.refresh(clickCx, {
                          forceContext: false,
                          preempt: true,
                          onlyProjectIds: new Set([project.id]),
                        });
                      })
                      .child("Retry"),
                  ),
              ),
            ),
        ),
      )
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .h_full()
              .when(!queue && this.loading, (el) =>
                el.child(
                  h_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap(8)
                    .text_color(t.muted)
                    .child(svg("mods/roscaelifer-queue/icons/spinner.svg").size(16).spin(900))
                    .child("Loading roscaelifer queue…"),
                ),
              )
              .when(Boolean(queue) && this.tab === "beads", (el) =>
                el.child(
                  this.beadsBoard.render(
                    {
                      showDeferred: this.showDeferred,
                      onToggleShowDeferred: (next, clickCx) => this.setShowDeferred(next, clickCx),
                      queue,
                      selectedId: this.selectedId,
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      actions: this.actions,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                      projects: queue.projects || [],
                      projectFilter: this.projectFilter,
                      onSelectProjectFilter: (next) => this.setProjectFilter(next),
                      countClosedStats: this.countClosedStats,
                      onToggleCountClosedStats: (next, clickCx) =>
                        this.setCountClosedStats(next, clickCx),
                    },
                    cx,
                  ),
                ),
              )
              .when(Boolean(queue) && this.tab === "queue", (el) =>
                el.child(
                  this.board.render(
                    {
                      showDeferred: this.showDeferred,
                      onToggleShowDeferred: (next, clickCx) => this.setShowDeferred(next, clickCx),
                      queue,
                      selectedId: this.selectedId,
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      actions: this.actions,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                      projects: queue.projects || [],
                      projectFilter: this.projectFilter,
                      onSelectProjectFilter: (next) => this.setProjectFilter(next),
                      countClosedStats: this.countClosedStats,
                      onToggleCountClosedStats: (next, clickCx) =>
                        this.setCountClosedStats(next, clickCx),
                    },
                    cx,
                  ),
                ),
              )
              .when(Boolean(queue) && (this.tab === "deps" || this.tab === "mirror"), (el) =>
                el.child(
                  this.deps.render(
                    {
                      showDeferred: this.showDeferred,
                      onToggleShowDeferred: (next, clickCx) => this.setShowDeferred(next, clickCx),
                      queue,
                      snapshot: this.snapshot,
                      mode: this.tab,
                      selectedId: this.selectedId,
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      projects: queue.projects || [],
                      projectFilter: this.projectFilter,
                      onSelectProjectFilter: (next) => this.setProjectFilter(next),
                      countClosedStats: this.countClosedStats,
                      onToggleCountClosedStats: (next, clickCx) =>
                        this.setCountClosedStats(next, clickCx),
                    },
                    cx,
                  ),
                ),
              ),
          )
          .when(Boolean(selectedItem), (el) =>
            el.child(
              div()
                .w(inspectorWidth)
                .h_full()
                .flex_none()
                .border_l(1)
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  this.inspector.render(
                    {
                      item: selectedItem,
                      detail: this.detailItemId === selectedItem.id ? this.detail : null,
                      beadDetail: this.detailItemId === selectedItem.id ? this.beadDetail : null,
                      detailLoading: this.detailLoading && this.detailItemId === selectedItem.id,
                      detailError: this.detailItemId === selectedItem.id ? this.detailError : null,
                      actions: this.actions,
                      ctx: selectedItem?.projectCtx || this.ctx,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      onClose: (clickCx) => this.selectItem(null, clickCx),
                      showEphemeral: this.showEphemeral,
                      onRefreshDetail: (clickCx) => {
                        if (selectedItem?.taskId || selectedItem?.beadId) {
                          this.selectItem(selectedItem, clickCx, { forceDetail: true });
                        }
                      },
                    },
                    cx,
                  ),
                ),
            ),
          ),
      );
  }
}
