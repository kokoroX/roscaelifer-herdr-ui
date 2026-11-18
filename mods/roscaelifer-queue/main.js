import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Tabs, Tab } from "gpui-base";
import {
  agents,
  terminals,
  spaces,
  panes,
  focused,
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
  contextKey,
  repoIdentityKey,
  repoLabel,
  loadRepoHistory,
  loadActiveRepo,
  loadActiveProjectMirror,
  loadGlobalProjectsConfig,
  buildContextFromProps,
  loadCachedSnapshot,
  saveCachedSnapshot,
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
const CLOSED_LIMIT_KEY = "roscaelifer.closedLimit.v2";
const SHOW_EPHEMERAL_KEY = "roscaelifer.showEphemeral.v1";
const ACTIVE_TAB_KEY = "roscaelifer.activeTab.v1";
const CLOSED_LIMIT_OPTIONS = [50, 500, 5000, "all"];
const DEFAULT_CLOSED_LIMIT = "all";

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
    const storedClosedLimit = safeStorageGet(CLOSED_LIMIT_KEY, DEFAULT_CLOSED_LIMIT);
    this.closedLimit =
      storedClosedLimit === "all" ||
      (Number.isInteger(storedClosedLimit) && CLOSED_LIMIT_OPTIONS.includes(storedClosedLimit))
        ? storedClosedLimit
        : DEFAULT_CLOSED_LIMIT;
    this.showEphemeral = Boolean(safeStorageGet(SHOW_EPHEMERAL_KEY, false));
    this.ctx = null;
    this.runner = null;
    this.snapshot = null;
    this.queue = null;
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
    this.size = null;
    this.watchedDirs = new Set();
    this.watchHandles = new Map();
    this.debounceTimer = null;
    this.pollTimer = null;
    this.pollIntervalMs = 0;
    this.refreshSeq = 0;
    this.refreshTask = null;
    this.loadingStartedAt = 0;
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
        this.snapshot = cached.snapshot;
        this.queue = this.getNormalizedQueue(cached.snapshot);
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
          this.actions.tick({}, cx);
        } else if (cmd === "new-bead") {
          this.openDialog("create");
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

  setClosedLimit(nextLimit, cx) {
    if (!CLOSED_LIMIT_OPTIONS.includes(nextLimit)) return;
    if (nextLimit === this.closedLimit) return;
    this.closedLimit = nextLimit;
    safeStorageSet(CLOSED_LIMIT_KEY, nextLimit);
    cx?.notify?.();
    this.refresh(cx, { forceContext: false, preempt: true });
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

  scheduleDebouncedRefresh(cx) {
    if (this.debounceTimer) this.debounceTimer.cancel();
    this.debounceTimer = cx.timer.after(250, (cx) => {
      this.debounceTimer = null;
      this.refresh(cx, { silent: true });
    });
  }

  ensureWatchers(ctx, cx) {
    if (!ctx || ctx.machine) {
      this.updatePollTimer(cx, FALLBACK_POLL_MS);
      return;
    }
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
      if (!dir || this.watchedDirs.has(dir)) continue;
      this.watchedDirs.add(dir);
      cx.spawn(async (watchCx) => {
        try {
          while (this.watchedDirs.has(dir)) {
            const handle = watchFolder(dir);
            this.watchHandles.set(dir, handle);
            await handle;
            if (!this.watchedDirs.has(dir)) break;
            this.scheduleDebouncedRefresh(watchCx);
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
      this.snapshot = cached.snapshot;
      this.queue = this.getNormalizedQueue(cached.snapshot);
      this.error = null;
    } else {
      this.snapshot = null;
      this.queue = null;
      this.error = null;
    }
    cx.notify();
  }

  refresh(cx, { forceContext = false, preempt = false, silent = false } = {}) {
    // Only an explicit override switch or signal refresh may preempt the refresh already
    // in flight: starting a second one bumps `refreshSeq` and strands the first one's
    // `loading`. A refresh that has been stuck for >35s is also reclaimed so the UI can
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
          closedLimit: this.closedLimit,
          includeEphemeral: this.showEphemeral,
          onRunnerResolved: (freshRunner) => {
            if (seq === this.refreshSeq) this.runner = freshRunner;
          },
        });
        if (seq !== this.refreshSeq) return;
        this.snapshot = snap;
        this.error = null;
        saveCachedSnapshot(this.ctx, snap);
        this.ensureWatchers(this.ctx, cx);

        this.queue = this.getNormalizedQueue(snap);

        const selected = this.selectedId ? this.queue.itemsById.get(this.selectedId) : null;
        if (selected && (selected.taskId || selected.beadId)) {
          // Detail fetch runs in its own task so a slow single item never blocks the
          // snapshot refresh or the Refresh button.
          cx.spawn(async (detailCx) => {
            await this.loadItemDetail(selected, { runnerOverride: runner, force: true });
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
          cx.notify();
        }
      }
    });
  }

  detailCacheKey(item) {
    return `${contextKey(this.ctx)}|ephemeral:${this.showEphemeral ? "1" : "0"}|${item?.taskId || ""}|${item?.beadId || ""}`;
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

  async loadItemDetail(item, { runnerOverride = null, force = false } = {}) {
    const taskId = item?.taskId || null;
    const beadId = item?.beadId || null;
    const itemId = item?.id || null;
    if (!itemId || !this.ctx || (!taskId && !beadId)) {
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
    this.detailLoading = true;
    this.detailError = null;
    this.detailItemId = itemId;
    this.detailTaskId = taskId;
    this.detailBeadId = beadId;

    try {
      const runner = runnerOverride || (await this.ensureRunner());
      if (this.detailReqSeq !== reqSeq || this.selectedId !== itemId) return;

      const [taskRes, beadRes] = await Promise.allSettled([
        taskId ? fetchTaskDetail(this.ctx, runner, taskId) : Promise.resolve(null),
        beadId
          ? fetchBeadDetail(this.ctx, runner, beadId, { includeEphemeral: this.showEphemeral })
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

  openDialog(dialogType, extra = {}) {
    if (this.isDialog) return;

    const dims = {
      create: { width: 520, height: 500 },
      enqueue: { width: 440, height: 340 },
      reject: { width: 460, height: 320 },
      "clean-preview": { width: 520, height: 420 },
      "project-config": { width: 600, height: 660 },
      "repo-config": { width: 600, height: 660 },
    };
    const size = dims[dialogType] || { width: 480, height: 380 };

    openOverlay({
      mod: "roscaelifer-queue",
      kind: "dialog",
      modal: true,
      width: size.width,
      height: size.height,
      props: {
        dialogType,
        ctx: this.ctx,
        formulas: this.queue?.formulas || [],
        envs: this.queue?.envs || [],
        items: (this.queue?.items || []).slice(0, 100).map((i) => ({
          id: i.id,
          beadId: i.beadId,
          title: i.title,
          status: i.status,
          column: i.column,
        })),
        history: loadRepoHistory(),
        projectsConfig: this.projectsConfig,
        ...extra,
      },
    });
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
      this.actions.tick({}, cx);
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
    const lockHeld = Boolean(queue?.runner?.lock_held);
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
              .child(div().max_w(180).truncate().child(this.ctx ? repoLabel(this.ctx) : "No project")),
          )
          .child(
            h_flex()
              .px(8)
              .h(24)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(lockHeld ? (t.working || t.accent) + "20" : t.raised)
              .text_size(11)
              .text_color(lockHeld ? t.working || t.accent : t.dim)
              .when(lockHeld, (el) =>
                el.child(
                  svg("mods/roscaelifer-queue/icons/spinner.svg")
                    .size(10)
                    .flex_none()
                    .spin(900),
                ),
              )
              .when(!lockHeld, (el) => el.child(div().size(6).rounded(3).bg(t.dim)))
              .child(lockHeld ? "Runner active" : "Runner idle"),
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
              onClick: (_e, cx) => this.actions.tick({}, cx),
            }),
          )
          .child(
            topButton("btn-clean", "Clean Pending", "mods/roscaelifer-queue/icons/clean.svg", {
              bg: t.raised,
              fg: pendingCleanups > 0 ? t.blocked || t.ansi3 : t.muted,
              border: t.border,
              badge: pendingCleanups,
              onClick: () => this.openDialog("clean-preview", {}),
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
    // Re-project live Herdr agents/terminals only when snapshot ref or live Herdr fingerprint changes.
    const queue = this.snapshot ? this.getNormalizedQueue(this.snapshot) : this.queue;
    if (queue) this.queue = queue;

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
                      queue,
                      selectedId: this.selectedId,
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      actions: this.actions,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      closedLimit: this.closedLimit,
                      onChangeClosedLimit: (nextLimit, clickCx) =>
                        this.setClosedLimit(nextLimit, clickCx),
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                    },
                    cx,
                  ),
                ),
              )
              .when(Boolean(queue) && this.tab === "queue", (el) =>
                el.child(
                  this.board.render(
                    {
                      queue,
                      selectedId: this.selectedId,
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      actions: this.actions,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      closedLimit: this.closedLimit,
                      onChangeClosedLimit: (nextLimit, clickCx) =>
                        this.setClosedLimit(nextLimit, clickCx),
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                    },
                    cx,
                  ),
                ),
              )
              .when(Boolean(queue) && (this.tab === "deps" || this.tab === "mirror"), (el) =>
                el.child(
                  this.deps.render(
                    {
                      queue,
                      snapshot: this.snapshot,
                      mode: this.tab,
                      selectedId: this.selectedId,
                      showEphemeral: this.showEphemeral,
                      onToggleShowEphemeral: (next, clickCx) =>
                        this.setShowEphemeral(next, clickCx),
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
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
                      ctx: this.ctx,
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
