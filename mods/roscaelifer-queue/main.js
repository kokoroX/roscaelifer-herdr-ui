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
} from "herdr";
import {
  resolveContext,
  resolveBinary,
  fetchSnapshot,
  fetchTaskDetail,
  normalizeQueue,
  saveRepoContext,
  contextKey,
  repoLabel,
  loadRepoHistory,
} from "./store.js";
import { createActions } from "./actions.js";
import { BoardController } from "./board.js";
import { InspectorController } from "./inspector.js";
import { DepsController } from "./deps.js";
import { DialogHandler } from "./dialogs.js";

const TABS = [
  { id: "queue", label: "Queue" },
  { id: "deps", label: "Epics & Deps" },
  { id: "mirror", label: "Mirror & Events" },
];

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
    if (rawProps?.dialogType) {
      this.isDialog = true;
      this.dialog = new DialogHandler(rawProps, cx);
      return;
    }

    this.isDialog = false;
    this.handle = cx.focus_handle();
    this.tab = "queue";
    this.ctx = null;
    this.runner = null;
    this.snapshot = null;
    this.queue = null;
    this.selectedId = null;
    this.detail = null;
    this.detailTaskId = null;
    this.detailLoading = false;
    this.detailError = null;
    this.loading = false;
    this.error = null;
    this.size = null;
    this.watchedDirs = new Set();
    this.debounceTimer = null;
    this.lastRefreshSignal = shared("roscaelifer.refresh") ?? null;
    this.lastOverrideSignal = JSON.stringify(shared("roscaelifer.ctxOverride") ?? null);
    this.lastHerdrLocation = "";

    this.board = new BoardController(cx);
    this.inspector = new InspectorController(cx);
    this.deps = new DepsController(cx);

    this.actions = createActions({
      getCtx: () => this.ctx,
      getRunner: () => this.ensureRunner(),
      onBusyChange: (_busy, _keys, actionCx) => actionCx?.notify(),
      onRefresh: (actionCx) => {
        if (actionCx) {
          this.refresh(actionCx, { forceContext: false });
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
          this.refresh(cx, { forceContext: true });
        } else if (cmd === "tick") {
          this.actions.tick({}, cx);
        } else if (cmd === "new-bead") {
          this.openDialog("create");
        } else if (cmd === "search") {
          this.tab = "queue";
          this.board.focusSearch();
        }
        cx.notify();
      }
    });

    // Gentle 10s fallback polling for external changes (dolt, remote machines, CLI).
    cx.timer.every(10000, (cx) => this.refresh(cx, { silent: true }));
    this.refresh(cx, { forceContext: true });
  }

  close(cx) {
    if (this.isDialog) {
      return this.dialog?.close?.(cx);
    }
    if (this.debounceTimer) {
      this.debounceTimer.cancel();
      this.debounceTimer = null;
    }
  }

  async ensureRunner() {
    if (this.runner) return this.runner;
    this.runner = await resolveBinary(this.ctx);
    return this.runner;
  }

  locationKey() {
    const f = focused();
    const s = spaces().find((sp) => sp.active);
    return `${f?.cwd || ""}|${s?.id || ""}|${s?.folder || ""}`;
  }

  scheduleDebouncedRefresh(cx) {
    if (this.debounceTimer) this.debounceTimer.cancel();
    this.debounceTimer = cx.timer.after(250, (cx) => {
      this.debounceTimer = null;
      this.refresh(cx, { silent: true });
    });
  }

  ensureWatchers(ctx, cx) {
    if (!ctx) return;
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
      cx.spawn(async (cx) => {
        try {
          while (this.watchedDirs.has(dir)) {
            await watchFolder(dir);
            if (!this.watchedDirs.has(dir)) break;
            this.scheduleDebouncedRefresh(cx);
          }
        } catch {
          this.watchedDirs.delete(dir);
        }
      });
    }
  }

  refresh(cx, { forceContext = false, silent = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    if (!silent) cx.notify();

    cx.spawn(async (cx) => {
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
          if (contextKey(nextCtx) !== contextKey(this.ctx)) {
            this.ctx = nextCtx;
            this.runner = null;
            this.watchedDirs.clear();
            this.detail = null;
            this.detailTaskId = null;
          }
        }

        if (!this.ctx) {
          this.snapshot = null;
          this.queue = null;
          this.error = "No roscaelifer repository detected. Open Repo Config to choose one.";
          return;
        }

        const runner = await this.ensureRunner();
        const snap = await fetchSnapshot(this.ctx, runner);
        this.snapshot = snap;
        this.error = null;
        saveRepoContext(this.ctx);
        this.ensureWatchers(this.ctx, cx);

        this.queue = normalizeQueue(snap, {
          agents: agents(),
          terminals: terminals(),
          spaces: spaces(),
        });

        const selected = this.selectedId ? this.queue.itemsById.get(this.selectedId) : null;
        if (selected?.taskId) {
          await this.loadDetailInternal(selected.taskId, runner);
        } else {
          this.detail = null;
          this.detailTaskId = null;
        }
      } catch (err) {
        this.error = err?.message || String(err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async loadDetailInternal(taskId, runnerOverride = null) {
    if (!taskId || !this.ctx) {
      this.detail = null;
      this.detailTaskId = null;
      this.detailError = null;
      return;
    }
    this.detailLoading = true;
    this.detailError = null;
    this.detailTaskId = taskId;
    try {
      const runner = runnerOverride || (await this.ensureRunner());
      this.detail = await fetchTaskDetail(this.ctx, runner, taskId);
    } catch (err) {
      this.detailError = err?.message || String(err);
    } finally {
      this.detailLoading = false;
    }
  }

  selectItem(item, cx) {
    if (!item) {
      this.selectedId = null;
      this.detail = null;
      this.detailTaskId = null;
      cx?.notify();
      return;
    }
    this.selectedId = item.id;
    this.detailError = null;
    if (item.taskId) {
      this.detailLoading = true;
      this.detailTaskId = item.taskId;
      cx?.notify();
      cx?.spawn(async (cx) => {
        await this.loadDetailInternal(item.taskId);
        cx.notify();
      });
    } else {
      this.detail = null;
      this.detailTaskId = null;
      this.detailLoading = false;
      cx?.notify();
    }
  }

  openDialog(dialogType, extra = {}) {
    const dims = {
      create: { width: 520, height: 500 },
      enqueue: { width: 440, height: 340 },
      reject: { width: 460, height: 320 },
      "clean-preview": { width: 520, height: 420 },
      "repo-config": { width: 520, height: 420 },
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
        ...extra,
      },
    });
  }

  handleKeyDown(e, cx) {
    if (this.board.searchFocused) {
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
      this.tab = "queue";
      this.board.focusSearch();
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
    if (e.key === "1") {
      this.tab = "queue";
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "2") {
      this.tab = "deps";
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "3") {
      this.tab = "mirror";
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.tab === "queue" && (e.key === "j" || e.key === "down" || e.key === "k" || e.key === "up")) {
      const visible = this.board.getVisibleItems();
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
            Button.new("repo-picker")
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
              .on_click(() => this.openDialog("repo-config"))
              .child(svg("mods/roscaelifer-queue/icons/folder.svg").size(13).flex_none().text_color(t.muted))
              .child(div().max_w(180).truncate().child(repoLabel(this.ctx))),
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
                  this.tab = tb.id;
                  cx.notify();
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
              busy: this.loading,
              onClick: (_e, cx) => this.refresh(cx, { forceContext: false }),
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
    if (
      refreshSignal !== this.lastRefreshSignal ||
      overrideChanged ||
      (!this.ctx && loc !== this.lastHerdrLocation)
    ) {
      this.lastRefreshSignal = refreshSignal;
      this.lastOverrideSignal = overrideSignal;
      this.lastHerdrLocation = loc;
      this.refresh(cx, { forceContext: overrideChanged || !this.ctx, silent: true });
    }

    const t = theme();
    // Re-project live Herdr agents/terminals whenever Herdr live data updates.
    const queue = this.snapshot
      ? normalizeQueue(this.snapshot, {
          agents: agents(),
          terminals: terminals(),
          spaces: spaces(),
        })
      : this.queue;
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
              Button.new("err-repo-cfg")
                .h(24)
                .px(8)
                .rounded(5)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11.5)
                .on_click(() => this.openDialog("repo-config"))
                .child("Configure Repo"),
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
              .when(Boolean(queue) && this.tab === "queue", (el) =>
                el.child(
                  this.board.render(
                    {
                      queue,
                      selectedId: this.selectedId,
                      onSelectItem: (item, clickCx) => this.selectItem(item, clickCx),
                      actions: this.actions,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
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
                      detail: this.detailTaskId === selectedItem.taskId ? this.detail : null,
                      detailLoading: this.detailLoading && this.detailTaskId === selectedItem.taskId,
                      detailError: this.detailTaskId === selectedItem.taskId ? this.detailError : null,
                      actions: this.actions,
                      ctx: this.ctx,
                      onOpenDialog: (type, extra) => this.openDialog(type, extra),
                      onClose: (clickCx) => this.selectItem(null, clickCx),
                      onRefreshDetail: (clickCx) => {
                        if (selectedItem?.taskId) {
                          this.selectItem(selectedItem, clickCx);
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
