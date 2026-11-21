import { div, svg, list } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  Button,
  Switch,
  Tabs,
  Tab,
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ScrollHandle,
  Scrollbar,
} from "gpui-base";
import { settings, theme, notify } from "herdr";
import { createColumnScrollLock } from "./scroll-lock.js";

const ROSCAELIFER_COLUMNS = [
  { key: "ready", label: "Ready", emptyText: "No ready beads" },
  { key: "queue", label: "Queue", emptyText: "No queued items" },
  { key: "running", label: "Running", emptyText: "No running tasks" },
  { key: "action", label: "Needs Action", emptyText: "Nothing waiting" },
  { key: "review", label: "Review", emptyText: "No items in review" },
  { key: "closed", label: "Closed", emptyText: "No recent closed items" },
];

const BEADS_COLUMNS = [
  { key: "backlog", label: "Backlog", emptyText: "No deferred beads" },
  { key: "ready", label: "Ready", emptyText: "No ready beads" },
  { key: "in_progress", label: "In Progress", emptyText: "No beads in progress" },
  { key: "blocked", label: "Blocked", emptyText: "No blocked beads" },
  { key: "closed", label: "Closed", emptyText: "No closed beads" },
];

function segmentTabs(id, t) {
  return Tabs.new(id)
    .flex()
    .items_center()
    .p(2)
    .gap(2)
    .rounded(7)
    .bg(t.background)
    .border_1()
    .border_color(t.border);
}

function segmentTab(id, label, active, extra, onClick, t) {
  return Tab.new(id)
    .selected(active)
    .h(22)
    .px(8)
    .rounded(5)
    .flex()
    .items_center()
    .gap(5)
    .text_size(11.5)
    .cursor_pointer()
    .bg(t.background)
    .text_color(active ? t.foreground : t.muted)
    .when(active, (el) => el.bg(t.selected).font_medium())
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => {
      onClick?.(cx);
      cx.notify();
    })
    .child(label)
    .when(Boolean(extra), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(extra)));
}

function priorityStyle(priority, t) {
  if (priority === 0) return { label: "P0", color: t.blocked || t.ansi1, bg: (t.blocked || t.ansi1) + "24" };
  if (priority === 1) return { label: "P1", color: t.ansi3 || t.blocked, bg: (t.ansi3 || t.blocked) + "22" };
  if (priority === 2) return { label: "P2", color: t.accent, bg: t.accent + "20" };
  if (priority === 3) return { label: "P3", color: t.muted, bg: t.raised };
  if (priority === 4) return { label: "P4", color: t.dim, bg: t.raised };
  return null;
}

function columnAccent(key, t) {
  switch (key) {
    case "queue":
      return t.accent;
    case "running":
    case "in_progress":
      return t.working || t.accent;
    case "action":
    case "blocked":
      return t.blocked || t.ansi1;
    case "backlog":
      return t.dim;
    case "review":
      return t.done || t.ansi2;
    case "closed":
      return t.dim;
    default:
      return t.muted;
  }
}

function actionReasonBadge(reason, t) {
  switch (reason) {
    case "waiting_approval":
      return { text: "Gate approval", color: t.blocked || t.ansi3 };
    case "needs_human":
      return { text: "Needs human", color: t.blocked || t.ansi1 };
    case "failed":
      return { text: "Failed", color: t.ansi1 || t.blocked };
    case "cancelled":
      return { text: "Cancelled", color: t.muted };
    case "invalid":
      return { text: "Invalid config", color: t.ansi1 || t.blocked };
    default:
      return null;
  }
}

/** Columns with more than this many cards are rendered as a virtual list. */
export const VIRTUALIZE_COLUMN_THRESHOLD = 20;

/**
 * A column is virtualized when it is the unbounded `closed` lane or when it
 * holds more cards than the threshold. Small columns keep the inline action
 * buttons that a virtual list's row renderer cannot own.
 */
export function shouldVirtualizeColumn(colKey, itemCount) {
  return colKey === "closed" || itemCount > VIRTUALIZE_COLUMN_THRESHOLD;
}

function chip(text, color, bg, borderColor = null) {
  return div()
    .px(6)
    .py(1)
    .rounded(5)
    .bg(bg)
    .when(Boolean(borderColor), (el) => el.border_1().border_color(borderColor))
    .text_size(10.5)
    .text_color(color)
    .whitespace_nowrap()
    .child(text);
}

function miniBtn(id, label, { bg, fg, border, busy = false, disabled = false, onClick }) {
  return Button.new(id)
    .h(22)
    .px(8)
    .rounded(5)
    .flex()
    .items_center()
    .gap(4)
    .bg(bg)
    .text_color(fg)
    .text_size(11)
    .font_medium()
    .when(Boolean(border), (el) => el.border_1().border_color(border))
    .disabled(disabled)
    .when(disabled, (el) => el.opacity(0.45))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.86)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      if (disabled) return;
      cx.stop_propagation();
      onClick?.(e, cx);
    })
    .when(busy, (el) =>
      el.child(svg("mods/roscaelifer-queue/icons/spinner.svg").size(10).flex_none().spin(900)),
    )
    .child(label);
}

export function projectDisplayCount(project, { excludeClosedStats = false } = {}) {
  if (!project || typeof project !== "object") return null;
  if (excludeClosedStats && Number.isFinite(project.openItemCount)) {
    return project.openItemCount;
  }
  return Number.isFinite(project.itemCount) ? project.itemCount : null;
}

export function totalProjectsDisplayCount(projects = [], { excludeClosedStats = false } = {}) {
  if (!Array.isArray(projects)) return 0;
  return projects.reduce((sum, project) => {
    const count = projectDisplayCount(project, { excludeClosedStats });
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);
}

function projectPill(t, project, active, onClick, { excludeClosedStats = false } = {}) {
  const hasError = Boolean(project.error);
  const displayCount = projectDisplayCount(project, { excludeClosedStats });
  const openCount = Number.isFinite(project.openItemCount) ? project.openItemCount : null;
  const closedCount = Number.isFinite(project.closedItemCount) ? project.closedItemCount : null;
  const countTip = !Number.isFinite(displayCount)
    ? ""
    : excludeClosedStats && closedCount !== null
      ? `${displayCount} active (${closedCount} closed excluded)`
      : !excludeClosedStats && openCount !== null && closedCount !== null
        ? `${displayCount} items (${openCount} active · ${closedCount} closed)`
        : `${displayCount} items`;

  return div()
    .id(`project-filter-${project.id}`)
    .h(22)
    .px(7)
    .gap(5)
    .flex()
    .items_center()
    .rounded(5)
    .bg(active ? t.selected : t.background)
    .when(active, (el) => el.border_1().border_color(t.border))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(
      [
        project.name || project.id,
        countTip,
        hasError ? `error: ${project.error}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    )
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick?.();
      cx.notify();
    })
    .child(div().size(7).rounded(4).bg(project.color || t.accent))
    .child(
      div()
        .text_size(11.5)
        .text_color(active ? t.foreground : t.muted)
        .when(active, (el) => el.font_medium())
        .child(project.name || project.id),
    )
    .when(Number.isFinite(displayCount), (el) =>
      el.child(div().text_size(10.5).text_color(t.dim).child(String(displayCount))),
    )
    .when(hasError, (el) =>
      el.child(
        div()
          .px(4)
          .rounded(3)
          .bg((t.ansi1 || t.blocked) + "28")
          .text_size(10)
          .font_semibold()
          .text_color(t.ansi1 || t.blocked)
          .child("!"),
      ),
    );
}

/** Shared `All Projects` + per-project filter pills for board and deps views. */
export function renderProjectFilterPills(
  t,
  {
    projects = [],
    projectFilter = "all",
    onSelectProjectFilter,
    countClosedStats = true,
    onToggleCountClosedStats,
    idPrefix = "project",
  } = {},
) {
  if (!Array.isArray(projects) || projects.length < 2) return null;
  const excludeClosedStats = !countClosedStats;
  const totalCount = totalProjectsDisplayCount(projects, { excludeClosedStats });
  const totalOpen = projects.reduce(
    (sum, project) => sum + (Number.isFinite(project?.openItemCount) ? project.openItemCount : 0),
    0,
  );
  const totalClosed = projects.reduce(
    (sum, project) => sum + (Number.isFinite(project?.closedItemCount) ? project.closedItemCount : 0),
    0,
  );
  const hasBreakdown = projects.some(
    (project) => Number.isFinite(project?.openItemCount) && Number.isFinite(project?.closedItemCount),
  );
  const allProjectsTooltip = hasBreakdown
    ? excludeClosedStats
      ? `${totalCount} active across ${projects.length} projects (${totalClosed} closed excluded)`
      : `${totalCount} items across ${projects.length} projects (${totalOpen} active · ${totalClosed} closed)`
    : `${totalCount} items across ${projects.length} projects`;

  return h_flex()
    .gap(6)
    .flex_wrap()
    .items_center()
    .child(
      segmentTabs(`board-project-tabs-${idPrefix}`, t)
        .tooltip(allProjectsTooltip)
        .child(
          segmentTab(
            `all-project-tab-${idPrefix}`,
            "All Projects",
            projectFilter === "all",
            String(totalCount),
            () => onSelectProjectFilter?.("all"),
            t,
          ),
        ),
    )
    .child(
      segmentTabs(`board-project-list-${idPrefix}`, t).children(
        projects.map((project) =>
          projectPill(
            t,
            project,
            projectFilter === project.id,
            () => onSelectProjectFilter?.(projectFilter === project.id ? "all" : project.id),
            { excludeClosedStats },
          ),
        ),
      ),
    )
    .when(typeof onToggleCountClosedStats === "function", (el) =>
      el.child(
        Switch.new(`project-count-closed-${idPrefix}`)
          .checked(countClosedStats)
          .on_change((_checked, clickCx) => {
            onToggleCountClosedStats?.(!countClosedStats, clickCx);
          })
          .tooltip(
            countClosedStats
              ? "Project badges include closed items. Turn off to exclude closed items from project counts without hiding the Closed column."
              : "Project badges exclude closed items. Turn on to include closed items in project counts.",
          )
          .flex()
          .items_center()
          .gap(7)
          .cursor_pointer()
          .child(
            h_flex()
              .w(28)
              .h(16)
              .p(2)
              .rounded(8)
              .items_center()
              .bg(countClosedStats ? t.accent : t.border)
              .when(countClosedStats, (sw) => sw.justify_end())
              .when(!countClosedStats, (sw) => sw.justify_start())
              .child(div().size(12).rounded(6).bg(countClosedStats ? t.accent_foreground : t.muted)),
          )
          .child(
            div()
              .text_size(11.5)
              .whitespace_nowrap()
              .text_color(countClosedStats ? t.foreground : t.muted)
              .child("Count closed"),
          ),
      ),
    );
}

export class BoardController {
  constructor(cx, { mode = "roscaelifer" } = {}) {
    this.mode = mode;
    this.envFilter = "all";
    this.onlyQueued = false;
    this.query = "";
    this.searchFocused = false;
    this.searchInput = InputState.new({ placeholder: "Search ID, title, label, formula…" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });
    this._lastVisible = [];
    this._filterCache = {
      queue: null,
      envFilter: null,
      onlyQueued: null,
      showEphemeral: null,
      query: null,
      columns: null,
      visibleAll: null,
      itemsByKeyByCol: null,
    };
    // The active columns and the horizontal row keep their scroll position by
    // name; a virtualized column (`closed`, or any past the threshold) is a
    // virtual `list()` and owns its own.
    this.colScrolls = {
      backlog: ScrollHandle.new(),
      ready: ScrollHandle.new(),
      queue: ScrollHandle.new(),
      in_progress: ScrollHandle.new(),
      blocked: ScrollHandle.new(),
      running: ScrollHandle.new(),
      action: ScrollHandle.new(),
      review: ScrollHandle.new(),
    };
    this.scrollX = 0;
    this.viewportW = 0;
    this.contentW = 0;
    this._minContentW = 0;
    this.bodyScrollLock = createColumnScrollLock({
      onHorizontalDelta: (rawDx, deltaCx) => this.scrollBy(rawDx, deltaCx),
    });
    this.outerScrollLock = createColumnScrollLock({
      onHorizontalDelta: (rawDx, deltaCx) => this.scrollBy(rawDx, deltaCx),
    });
    this._handleColumnScrollWheel = this.bodyScrollLock;
    this._handleOuterScrollWheel = this.outerScrollLock;
    void cx;
  }

  maxScrollX(contentW = Math.max(this.contentW, this._minContentW || 0)) {
    return Math.max(0, contentW - this.viewportW);
  }

  clampScrollX(contentW = Math.max(this.contentW, this._minContentW || 0)) {
    const next = Math.max(0, Math.min(this.scrollX, this.maxScrollX(contentW)));
    const changed = next !== this.scrollX;
    this.scrollX = next;
    return changed;
  }

  // `scrollX` stays fractional so wheel deltas accumulate smoothly; only a
  // change of the rendered integer offset is worth a full view-tree rebuild.
  scrollBy(rawDx, cx) {
    const prev = this.scrollX;
    const next = Math.max(0, Math.min(prev - rawDx, this.maxScrollX()));
    if (next === prev) return;
    this.scrollX = next;
    if (Math.round(next) !== Math.round(prev)) cx?.notify();
  }

  handleOuterScrollWheel(e, cx) {
    this._handleOuterScrollWheel(e, cx);
  }

  focusSearch() {
    this.searchInput.focus();
  }

  // A column scrolls vertically inside a horizontally scrolling row; the
  // gesture handling lives in `./scroll-lock.js` so the dependency-wave lanes
  // behave identically to the kanban board.
  handleColumnScrollWheel(e, cx) {
    this._handleColumnScrollWheel(e, cx);
  }

  getVisibleItems() {
    return this._lastVisible;
  }

  matchesFilter(item, { showEphemeral = true, projectFilter = "all" } = {}) {
    if (projectFilter && projectFilter !== "all" && item.projectId && item.projectId !== projectFilter) {
      return false;
    }
    if (item.ephemeral && !showEphemeral) {
      return false;
    }
    if (this.envFilter !== "all" && item.env !== this.envFilter) {
      return false;
    }
    if (this.mode === "roscaelifer" && this.onlyQueued && item.column === "ready") {
      return false;
    }
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return (item._searchText || "").includes(q);
  }

  renderAgentStatus(item, t, { interactive = true } = {}) {
    const st = item.agentStatus;
    if (!st) return null;
    if (st === "working") {
      return h_flex()
        .gap(4)
        .items_center()
        .flex_none()
        .child(
          // A virtual list's row renderer may not retain state, so the
          // spinner becomes a plain dot there.
          interactive
            ? svg("mods/roscaelifer-queue/icons/spinner.svg")
                .size(11)
                .flex_none()
                .text_color(t.working || t.accent)
                .spin(900)
            : div().size(6).rounded(3).bg(t.working || t.accent),
        )
        .child(div().text_size(10.5).text_color(t.working || t.accent).child("working"));
    }
    if (st === "blocked") {
      return div()
        .px(5)
        .py(1)
        .rounded(4)
        .flex_none()
        .bg((t.blocked || t.ansi1) + "24")
        .text_size(10)
        .font_semibold()
        .text_color(t.blocked || t.ansi1)
        .child("Needs you");
    }
    if (st === "done") {
      return h_flex()
        .gap(4)
        .items_center()
        .flex_none()
        .child(div().size(6).rounded(3).bg(t.done || t.ansi2))
        .child(div().text_size(10.5).text_color(t.done || t.ansi2).child("done"));
    }
    return h_flex()
      .gap(4)
      .items_center()
      .flex_none()
      .child(div().size(6).rounded(3).border_1().border_color(t.idle || t.dim))
      .child(div().text_size(10.5).text_color(t.dim).child("idle"));
  }

  renderStepProgress(item, t, { interactive = true } = {}) {
    const steps = item.steps || [];
    if (!steps.length) return null;
    const total = steps.length;
    const done = steps.filter((s) => s.status === "done").length;
    const cur = item.currentStep;
    const pct = Math.round((done / total) * 100);
    const barColor =
      cur?.status === "failed"
        ? t.ansi1 || t.blocked
        : cur?.status === "waiting_approval" || cur?.status === "needs_human"
          ? t.blocked || t.ansi3
          : t.accent;
    // `Progress` is a component with an identity of its own, which a virtual
    // list's row renderer cannot hold; there the same bar is drawn plainly.
    const bar = interactive
      ? Progress.new(`prog-${item.id}`)
          .value(pct)
          .child(
            ProgressTrack.new()
              .w_full()
              .h(3)
              .rounded(2)
              .bg(t.raised)
              .overflow_hidden()
              .child(
                ProgressIndicator.new()
                  .h_full()
                  .w(`${pct}%`)
                  .rounded(2)
                  .bg(barColor),
              ),
          )
      : div()
          .w_full()
          .h(3)
          .rounded(2)
          .bg(t.raised)
          .overflow_hidden()
          .child(div().h_full().w(`${pct}%`).rounded(2).bg(barColor));
    return v_flex()
      .gap(3)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(6)
          .text_size(10.5)
          .text_color(t.muted)
          .child(
            div()
              .truncate()
              .child(cur ? `${cur.stepId} (${cur.status})` : "steps"),
          )
          .child(div().flex_none().text_color(t.dim).child(`${done}/${total}`)),
      )
      .child(bar);
  }

  renderCardActions(item, { actions, onOpenDialog }, t) {
    const btns = [];
    const beadArgs = (extra = {}) => ({
      env: item.env,
      formula: item.formula || undefined,
      currentLabels: item.labels,
      bdStatus: item.bdStatus,
      wakeDeferred: item.bdStatus === "deferred",
      maxRunning: item.maxRunning ?? undefined,
      ctx: item.projectCtx || undefined,
      ...extra,
    });
    const active = item.taskStatus === "active";
    const addSessionButtons = (prefix = "") => {
      if (!item.hcAddress) return;
      btns.push(
        miniBtn(`act-open-${prefix}${item.id}`, "Open Session", {
          bg: t.raised,
          fg: t.foreground,
          border: t.border,
          onClick: () => actions.switchToSession(item),
        }),
        miniBtn(`act-peek-${prefix}${item.id}`, "Peek", {
          bg: t.raised,
          fg: t.foreground,
          border: t.border,
          onClick: () => actions.peekTerminal(item.hcAddress),
        }),
      );
    };
    const addGateButtons = ({ withSession = true } = {}) => {
      if (item.actionReason === "waiting_approval" && item.taskId && item.waitingStep) {
        btns.push(miniBtn(`act-app-${item.id}`, "Approve", {
          bg: t.solid, fg: t.solid_foreground,
          busy: actions.isBusy(`approve:${item.taskId}:${item.waitingStep.stepId}`),
          onClick: (_e, cx) => actions.approveGate(item.taskId, item.waitingStep.stepId, cx, item.projectCtx),
        }));
      }
      if ((item.actionReason === "failed" || item.actionReason === "cancelled") && item.taskId && item.waitingStep) {
        btns.push(miniBtn(`act-retry-${item.id}`, "Retry", {
          bg: t.solid, fg: t.solid_foreground,
          busy: actions.isBusy(`retry:${item.taskId}:${item.waitingStep.stepId}`),
          onClick: (_e, cx) => actions.retryTask(item.taskId, item.waitingStep.stepId, cx, item.projectCtx),
        }));
      }
      if (item.hasFailedLabel && item.beadId) {
        btns.push(miniBtn(`act-requeue-${item.id}`, "Re-queue", {
          bg: t.raised, fg: t.foreground, border: t.border,
          busy: actions.isBusy(`enqueue:${item.beadId}`),
          onClick: (_e, cx) => actions.requeueBead(item.beadId, item.labels, cx, item.projectCtx),
        }));
      }
      if (withSession && item.hcAddress) addSessionButtons("action-");
    };

    if (this.mode === "beads" && item.beadId && item.bdStatus !== "closed") {
      if (active) {
        addSessionButtons("bead-");
        if (item.taskId) {
          btns.push(miniBtn(`act-cancel-bead-${item.id}`, "Cancel", {
            bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
            busy: actions.isBusy(`cancel:${item.taskId}`),
            onClick: (_e, cx) => actions.cancelTask(item.taskId, cx, item.projectCtx),
          }));
        }
      } else if (!item.isOptedIn) {
        if (!item.isBlocked) {
          btns.push(miniBtn(`act-dispatch-${item.id}`, "Dispatch", {
            bg: t.solid, fg: t.solid_foreground,
            busy: actions.isBusy(`dispatch:${item.beadId}`),
            onClick: (_e, cx) => item.formula
              ? actions.dispatchBead(item.beadId, beadArgs(), cx)
              : onOpenDialog("enqueue", { item }),
          }));
        }
        btns.push(miniBtn(`act-queue-${item.id}`, "Queue", {
          bg: t.raised, fg: t.foreground, border: t.border,
          busy: actions.isBusy(`enqueue:${item.beadId}`),
          onClick: (_e, cx) => item.formula
            ? actions.enqueueBead(item.beadId, beadArgs(), cx)
            : onOpenDialog("enqueue", { item }),
        }));
      } else {
        if (!item.isBlocked) {
          btns.push(miniBtn(`act-dispatch-opt-${item.id}`, "Dispatch", {
            bg: t.solid, fg: t.solid_foreground,
            busy: actions.isBusy(`dispatch:${item.beadId}`),
            onClick: (_e, cx) => actions.dispatchBead(item.beadId, beadArgs(), cx),
          }));
        }
        btns.push(
          miniBtn(`act-options-${item.id}`, "Options", {
            bg: t.raised, fg: t.foreground, border: t.border,
            onClick: () => onOpenDialog("enqueue", { item }),
          }),
          miniBtn(`act-dequeue-${item.id}`, "Dequeue", {
            bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
            busy: actions.isBusy(`dequeue:${item.beadId}`),
            onClick: (_e, cx) => actions.dequeueBead(item.beadId, cx, item.projectCtx),
          }),
        );
      }
      if (item.column === "action") addGateButtons({ withSession: false });
    } else if (item.column === "queue") {
      if (item.taskId && item.taskStatus === "active") {
        // An active task whose steps are all pending: queued for a concurrency slot.
        if (item.beadId) btns.push(miniBtn(`act-options-queue-${item.id}`, "Options", {
          bg: t.raised, fg: t.foreground, border: t.border,
          onClick: () => onOpenDialog("enqueue", { item }),
        }));
        btns.push(miniBtn(`act-cancel-queue-${item.id}`, "Cancel", {
          bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
          busy: actions.isBusy(`cancel:${item.taskId}`),
          onClick: (_e, cx) => actions.cancelTask(item.taskId, cx, item.projectCtx),
        }));
      } else if (item.beadId) {
        // An opted-in bead that has no live task yet: ready to be dispatched.
        if (!item.isBlocked) {
          btns.push(miniBtn(`act-dispatch-queue-${item.id}`, "Dispatch", {
            bg: t.solid, fg: t.solid_foreground,
            busy: actions.isBusy(`dispatch:${item.beadId}`),
            onClick: (_e, cx) => item.formula
              ? actions.dispatchBead(item.beadId, beadArgs(), cx)
              : onOpenDialog("enqueue", { item }),
          }));
        }
        btns.push(miniBtn(`act-options-queue-${item.id}`, "Options", {
          bg: t.raised, fg: t.foreground, border: t.border,
          onClick: () => onOpenDialog("enqueue", { item }),
        }));
        if (item.isOptedIn) {
          btns.push(miniBtn(`act-dequeue-queue-${item.id}`, "Dequeue", {
            bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
            busy: actions.isBusy(`dequeue:${item.beadId}`),
            onClick: (_e, cx) => actions.dequeueBead(item.beadId, cx, item.projectCtx),
          }));
        }
      }
    } else if (item.column === "ready") {
      if (item.beadId && !item.isOptedIn) {
        btns.push(miniBtn(`act-q-${item.id}`, "Enqueue", {
          bg: t.solid, fg: t.solid_foreground,
          busy: actions.isBusy(`enqueue:${item.beadId}`),
          onClick: () => onOpenDialog("enqueue", { item }),
        }));
      } else if (item.beadId && item.isOptedIn) {
        btns.push(miniBtn(`act-edit-${item.id}`, "Options", {
          bg: t.raised, fg: t.foreground, border: t.border,
          onClick: () => onOpenDialog("enqueue", { item }),
        }));
      }
      // An active task without a running step is waiting for a concurrency slot: allow cancelling it.
      if (item.taskId && item.taskStatus === "active") {
        btns.push(miniBtn(`act-cancel-ready-${item.id}`, "Cancel", {
          bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
          busy: actions.isBusy(`cancel:${item.taskId}`),
          onClick: (_e, cx) => actions.cancelTask(item.taskId, cx, item.projectCtx),
        }));
      }
    } else if (item.column === "running") {
      addSessionButtons();
      if (item.taskId) btns.push(miniBtn(`act-cancel-${item.id}`, "Cancel", {
        bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
        busy: actions.isBusy(`cancel:${item.taskId}`),
        onClick: (_e, cx) => actions.cancelTask(item.taskId, cx, item.projectCtx),
      }));
    } else if (item.column === "action") {
      addGateButtons();
    } else if (item.column === "review") {
      if (item.beadId) btns.push(
        miniBtn(`act-pass-${item.id}`, "Pass", {
          bg: t.solid, fg: t.solid_foreground,
          busy: actions.isBusy(`approve-review:${item.beadId}`),
          onClick: (_e, cx) => actions.approveReview(item.beadId, cx, item.projectCtx),
        }),
        miniBtn(`act-reject-${item.id}`, "Reject", {
          bg: t.raised, fg: t.ansi1 || t.blocked, border: t.border,
          onClick: () => onOpenDialog("reject", { item }),
        }),
      );
    } else if (item.column === "closed") {
      if (item.pendingCleanup && item.taskId) btns.push(miniBtn(`act-clean-${item.id}`, "Clean", {
        bg: t.raised, fg: t.blocked || t.ansi3, border: t.border,
        onClick: () => onOpenDialog("clean-preview", { item, target: { taskId: item.taskId } }),
      }));
      if (item.beadId) btns.push(miniBtn(`act-reopen-${item.id}`, "Reopen", {
        bg: t.raised, fg: t.muted, border: t.border,
        busy: actions.isBusy(`reopen:${item.beadId}`),
        onClick: (_e, cx) => actions.reopenBead(item.beadId, cx, item.projectCtx),
      }));
    }
    if (!btns.length) return null;
    return h_flex().pt(2).gap(6).flex_wrap().children(btns);
  }

  renderCard(item, { selectedId, onSelectItem, actions, onOpenDialog }, t, { interactive = true } = {}) {
    const selected = item.id === selectedId;
    const pStyle = priorityStyle(item.priority, t);
    const reason = actionReasonBadge(item.actionReason, t);
    const sessionLabel = item.sessionInfo?.spaceName || item.sessionInfo?.tabName
      ? [item.sessionInfo.spaceName, item.sessionInfo.tabName].filter(Boolean).join(" · ")
      : item.hcAddress;
    const activeLink = Boolean(item.isRunningTask || item.column === "running");
    const actionLink = item.column === "action" ? `action: ${item.actionReason || "needs action"}` : null;
    const actionRow = interactive
      ? this.renderCardActions(item, { actions, onOpenDialog }, t)
      : null;
    const cardIdText = item.beadId && item.taskId ? `${item.beadId} · #${item.taskId}` : item.rawId || item.id;
    const cardCopyText = [
      cardIdText,
      String(item.title || ""),
      item.agentStatus ? `status: ${item.agentStatus}` : item.taskStatus ? `status: ${item.taskStatus}` : item.bdStatus ? `status: ${item.bdStatus}` : "",
      item.actionReason ? `action: ${item.actionReason}` : "",
      item.error || item.lastError ? `error: ${item.error || item.lastError}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return v_flex()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(selected ? t.selected : t.surface)
      .border_1()
      .border_color(selected ? t.accent : t.border)
      .cursor_pointer()
      .when(interactive, (el) =>
        el
          .id(`card-${item.id}`)
          .hover((s) => s.bg(selected ? t.selected : t.hover))
          .on_click((_e, cx) => {
            onSelectItem?.(item, cx);
          }),
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .when(Boolean(item.ephemeral), (el) =>
            el.child(chip("ephemeral", t.ansi3 || t.accent, (t.ansi3 || t.accent) + "22")),
          )
          .when(Boolean(pStyle), (el) =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(pStyle.bg)
                .text_size(10)
                .font_semibold()
                .text_color(pStyle.color)
                .child(pStyle.label),
            ),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.muted)
              .child(item.beadId && item.taskId ? `${item.beadId} · #${item.taskId}` : item.rawId || item.id),
          )
          .when(Boolean(item.agentStatus), (el) =>
            el.child(this.renderAgentStatus(item, t, { interactive })),
          )
          .when(Boolean(sessionLabel), (el) => el.child(chip(sessionLabel, t.accent, t.accent + "18")))
          .when(interactive, (el) =>
            el.child(
              miniBtn(`card-copy-${item.id}`, "Copy", {
                bg: t.raised,
                fg: t.muted,
                border: t.border,
                onClick: (_e, cx) => {
                  cx.write_to_clipboard(cardCopyText);
                  notify({ title: "Copied", body: cardIdText, level: "success", timeout: 1500 });
                },
              }),
            ),
          ),
      )
      .child(
        // A plain div: the card title is rebuilt for every visible row, and a
        // selectable TextView there is what made long columns scroll badly.
        // The Inspector still renders the title selectable.
        div().text_size(12.5).font_medium().text_color(t.foreground).child(item.title),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .when(Boolean(item.projectName), (el) =>
            el.child(
              chip(
                item.projectName,
                item.projectColor || t.accent,
                (item.projectColor || t.accent) + "22",
              ),
            ),
          )
          .when(Boolean(item.formula), (el) =>
            el.child(chip(item.formula, t.foreground, t.raised, t.border)),
          )
          .when(Boolean(item.env), (el) =>
            el.child(chip(`env:${item.env}`, t.muted, t.raised)),
          )
          .when(this.mode === "beads" && item.bdStatus === "deferred", (el) =>
            el.child(chip("deferred", t.ansi3 || t.accent, (t.ansi3 || t.accent) + "22")),
          )
          .when(this.mode === "beads" && (item.isBlocked || item.bdStatus === "blocked"), (el) =>
            el.child(chip(`blocked (${item.blockedBy.length})`, t.ansi1 || t.blocked, (t.ansi1 || t.blocked) + "1f")),
          )
          .when(this.mode === "beads" && item.isOptedIn, (el) => el.child(chip("queued", t.accent, t.accent + "1f")))
          .when(this.mode === "beads" && activeLink, (el) => el.child(chip("running", t.working || t.accent, (t.working || t.accent) + "20")))
          .when(this.mode === "beads" && Boolean(actionLink), (el) => el.child(chip(actionLink, t.blocked || t.ansi1, (t.blocked || t.ansi1) + "20")))
          .when(this.mode === "beads" && (item.needsReview || item.column === "review"), (el) => el.child(chip("review", t.done || t.ansi2, (t.done || t.ansi2) + "20")))
          .when(this.mode !== "beads" && item.isOptedIn && item.column === "ready" && !(item.taskId && item.taskStatus === "active"), (el) =>
            el.child(chip("queued", t.accent, t.accent + "1f")),
          )
          .when(this.mode !== "beads" && item.column === "queue" && item.taskId && item.taskStatus === "active" && !item.hasRunningStep, (el) =>
            el.child(chip("queued · pending", t.accent, t.accent + "1f")),
          )
          .when(this.mode !== "beads" && item.column === "queue" && item.isOptedIn && !(item.taskId && item.taskStatus === "active"), (el) =>
            el.child(chip("queued", t.accent, t.accent + "1f")),
          )
          .when(this.mode !== "beads" && (item.column === "ready" || item.column === "queue") && item.bdStatus === "in_progress" && item.taskStatus !== "active", (el) =>
            el.child(chip("bd:in_progress", t.muted, t.raised)),
          )
          .when(this.mode !== "beads" && (item.column === "ready" || item.column === "queue") && item.isBlocked, (el) =>
            el.child(chip(`blocked (${item.blockedBy.length})`, t.ansi1 || t.blocked, (t.ansi1 || t.blocked) + "1f")),
          )
          .when(this.mode !== "beads" && (item.column === "ready" || item.column === "queue") && item.bdStatus === "deferred", (el) =>
            el.child(chip("deferred", t.ansi3 || t.accent, (t.ansi3 || t.accent) + "22")),
          )
          .when(Boolean(reason) && !(this.mode === "beads" && Boolean(actionLink)), (el) =>
            el.child(chip(reason.text, reason.color, reason.color + "22")),
          )
          .when(item.pendingCleanup, (el) =>
            el.child(
              chip(
                `cleanup (${item.pendingCleanupCount})`,
                t.blocked || t.ansi3,
                (t.blocked || t.ansi3) + "20",
              ),
            ),
          ),
      )
      .when(item.steps && item.steps.length > 0, (el) =>
        el.child(this.renderStepProgress(item, t, { interactive })),
      )
      .when(Boolean(actionRow), (el) => el.child(actionRow));
  }

  // Env tabs only ever list real envs from config. Keep a stale filter from
  // hiding every card (or matching a synthetic "auto" env) by resetting it.
  syncEnvFilter(queue) {
    if (this.envFilter === "all") return false;
    const envs = Array.isArray(queue?.envs) ? queue.envs : [];
    const names = new Set(
      envs.map((env) => (typeof env === "string" ? env : env?.name)).filter(Boolean),
    );
    if (names.has(this.envFilter)) return false;
    this.envFilter = "all";
    return true;
  }

  renderFilterBar(queue, t, { showEphemeral = true, onToggleShowEphemeral, projects = [], projectFilter = "all", onSelectProjectFilter, countClosedStats = true, onToggleCountClosedStats } = {}) {
    this.syncEnvFilter(queue);
    const envs = queue?.envs || [];
    const multiProject = Array.isArray(projects) && projects.length > 1;

    const envTab = (id, label, active, extra, onClick) => {
      const tab = segmentTab(id, label, active, extra, onClick, t);
      if (!multiProject) return tab;
      const env = envs.find((entry) => (typeof entry === "string" ? entry : entry?.name) === label);
      const split = env?.byProject ? Object.entries(env.byProject) : [];
      if (split.length === 0) return tab;
      const tip = split
        .map(([projectId, counts]) => {
          const name = projects.find((project) => project.id === projectId)?.name || projectId;
          const cap = counts.maxRunning > 0 ? `${counts.runningWorkSteps}/${counts.maxRunning}` : `${counts.runningWorkSteps}`;
          return `${name}: ${cap}`;
        })
        .join(" · ");
      return tip ? tab.tooltip(tip) : tab;
    };

    return v_flex()
      .flex_none()
      .px(12)
      .py(8)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .when(multiProject, (el) =>
        el.child(
          h_flex()
            .w_full()
            .items_center()
            .child(
              renderProjectFilterPills(t, {
                projects,
                projectFilter,
                onSelectProjectFilter,
                countClosedStats,
                onToggleCountClosedStats,
                idPrefix: "board",
              }),
            ),
        ),
      )
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .flex_wrap()
              .items_center()
              .child(
                segmentTabs("board-env-tabs", t)
                  .child(envTab("env-tab-all", "All Envs", this.envFilter === "all", null, () => {
                    this.envFilter = "all";
                  }))
                  .children(
                    envs.map((env) => {
                      const scoped =
                        projectFilter !== "all" && env.byProject?.[projectFilter]
                          ? env.byProject[projectFilter]
                          : env;
                      const cap =
                        scoped.maxRunning > 0
                          ? `${scoped.runningWorkSteps}/${scoped.maxRunning}`
                          : scoped.runningWorkSteps > 0
                            ? `${scoped.runningWorkSteps}`
                            : null;
                      return envTab(
                        `env-tab-${env.name}`,
                        env.name,
                        this.envFilter === env.name,
                        cap,
                        () => {
                          this.envFilter = env.name;
                        },
                      );
                    }),
                  ),
              )
              .child(div().w(1).h(16).bg(t.border).mx(2))
              .when(this.mode === "roscaelifer", (el) =>
                el.child(
                  h_flex()
                    .gap(7)
                    .items_center()
                    .child(
                      Switch.new("filter-queued")
                        .checked(this.onlyQueued)
                        .on_change((checked, cx) => {
                          this.onlyQueued = Boolean(checked);
                          cx.notify();
                        })
                        .flex()
                        .items_center()
                        .gap(7)
                        .cursor_pointer()
                        .child(
                          h_flex()
                            .w(28)
                            .h(16)
                            .p(2)
                            .rounded(8)
                            .items_center()
                            .bg(this.onlyQueued ? t.accent : t.border)
                            .when(this.onlyQueued, (el) => el.justify_end())
                            .when(!this.onlyQueued, (el) => el.justify_start())
                            .child(
                              div()
                                .size(12)
                                .rounded(6)
                                .bg(this.onlyQueued ? t.accent_foreground : t.muted),
                            ),
                        )
                        .child(
                          div()
                            .text_size(11.5)
                            .text_color(this.onlyQueued ? t.foreground : t.muted)
                            .child("Queued only"),
                        ),
                    ),
                ),
              )
              .child(
                Switch.new("filter-ephemeral")
                  .checked(showEphemeral)
                  .on_change((checked, clickCx) => {
                    onToggleShowEphemeral?.(!showEphemeral, clickCx);
                  })
                  .flex()
                  .items_center()
                  .gap(7)
                  .cursor_pointer()
                  .child(
                    h_flex()
                      .w(28)
                      .h(16)
                      .p(2)
                      .rounded(8)
                      .items_center()
                      .bg(showEphemeral ? t.accent : t.border)
                      .when(showEphemeral, (el) => el.justify_end())
                      .when(!showEphemeral, (el) => el.justify_start())
                      .child(div().size(12).rounded(6).bg(showEphemeral ? t.accent_foreground : t.muted)),
                  )
                  .child(
                    div()
                      .text_size(11.5)
                      .text_color(showEphemeral ? t.foreground : t.muted)
                      .child("Ephemeral"),
                  ),
              ),
          )
          .child(
            h_flex()
              .w(240)
              .h(28)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(this.searchFocused ? t.accent : t.input)
              .bg(t.background)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(svg("mods/roscaelifer-queue/icons/search.svg").size(13).flex_none().text_color(t.dim))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .child(Input.new(this.searchInput).h(24).text_size(12).text_color(t.foreground)),
              )
              .when(Boolean(this.query), (el) =>
                el.child(
                  div()
                    .id("clear-search")
                    .p(2)
                    .cursor_pointer()
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.query = "";
                      this.searchInput.set_value("");
                      cx.notify();
                    })
                    .child(svg("mods/roscaelifer-queue/icons/close.svg").size(12)),
                ),
              ),
          ),
      );
  }

  renderActiveColumnBody(col, listItems, { selectedId, onSelectItem, actions, onOpenDialog }, t) {
    return div()
      .relative()
      .flex_1()
      .min_h(0)
      .on_scroll_wheel((_e, cx) => {
        if (!this.bodyScrollLock.isHorizontal()) cx?.stop_propagation();
      })
      .child(
        v_flex()
          .id(`col-scroll-${col.key}`)
          .track_scroll(this.colScrolls[col.key])
          .size_full()
          .overflow_y_scroll()
          .p(8)
          .gap(8)
          .when(listItems.length === 0, (el) =>
            el.child(
              div()
                .py(16)
                .px(8)
                .text_size(12)
                .text_color(t.dim)
                .child(col.emptyText),
            ),
          )
          .children(
            listItems.map((item) =>
              this.renderCard(item, { selectedId, onSelectItem, actions, onOpenDialog }, t),
            ),
          ),
      )
      .child(
        div()
          .id(`col-wheel-guard-${col.key}`)
          .absolute()
          .inset_0()
          .on_scroll_wheel(this._handleColumnScrollWheel),
      )
      .child(Scrollbar.vertical(`col-scroll-${col.key}`).absolute().inset_0());
  }

  // `closed` (and any column past `VIRTUALIZE_COLUMN_THRESHOLD` cards) is a
  // virtual list: only what is on screen is laid out. A row may register no
  // handlers of its own, which is why the card inside it is drawn display-only
  // and the press is answered by `on_item_click` on the list (the Inspector
  // carries the real actions).
  renderVirtualizedColumnBody(col, listItems, { selectedId, onSelectItem, itemsByKey }, t) {
    if (listItems.length === 0) {
      return div()
        .flex_1()
        .min_h(0)
        .p(8)
        .child(
          div()
            .py(16)
            .px(8)
            .text_size(12)
            .text_color(t.dim)
            .child(col.emptyText),
        );
    }

    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .on_scroll_wheel((_e, cx) => {
        if (!this.bodyScrollLock.isHorizontal()) cx?.stop_propagation();
      })
      .child(
        list(
          `col-scroll-${col.key}`,
          listItems.length,
          (i) => String(listItems[i].id),
          (i) => {
            const item = listItems[i];
            return div()
              .w_full()
              .px(8)
              .pt(i === 0 ? 8 : 0)
              .pb(8)
              .child(this.renderCard(item, { selectedId }, t, { interactive: false }));
          },
        )
          .size_full()
          .on_item_click((key, clickCx) => {
            const target = itemsByKey.get(key);
            if (target) onSelectItem?.(target, clickCx);
          }),
      )
      .child(
        div()
          .id(`col-wheel-guard-${col.key}`)
          .absolute()
          .inset_0()
          .on_scroll_wheel(this._handleColumnScrollWheel),
      )
      .child(Scrollbar.vertical(`col-scroll-${col.key}`).absolute().inset_0());
  }

  getFilteredColumns(queue, { showEphemeral = true, projectFilter = "all" } = {}) {
    this.syncEnvFilter(queue);
    const query = this.query.trim();
    const cached = this._filterCache;
    if (
      cached.queue === queue &&
      cached.envFilter === this.envFilter &&
      cached.onlyQueued === this.onlyQueued &&
      cached.showEphemeral === showEphemeral &&
      cached.projectFilter === projectFilter &&
      cached.query === query &&
      cached.mode === this.mode
    ) {
      return cached;
    }

    const cols = this.mode === "beads"
      ? queue?.beadColumns || { backlog: [], ready: [], in_progress: [], blocked: [], closed: [] }
      : queue?.columns || { ready: [], queue: [], running: [], action: [], review: [], closed: [] };
    const columns = {};
    const visibleAll = [];
    const boardColumns = this.mode === "beads" ? BEADS_COLUMNS : ROSCAELIFER_COLUMNS;
    for (const col of boardColumns) {
      const listItems = (cols[col.key] || []).filter((item) =>
        this.matchesFilter(item, { showEphemeral, projectFilter }),
      );
      columns[col.key] = listItems;
      visibleAll.push(...listItems);
    }
    const itemsByKeyByCol = new Map(
      Object.entries(columns).map(([key, list]) => [
        key,
        new Map(list.map((item) => [String(item.id), item])),
      ]),
    );
    this._filterCache = {
      queue,
      envFilter: this.envFilter,
      onlyQueued: this.onlyQueued,
      showEphemeral,
      projectFilter,
      query,
      mode: this.mode,
      columns,
      visibleAll,
      itemsByKeyByCol,
    };
    return this._filterCache;
  }

  render({ queue, selectedId, onSelectItem, actions, onOpenDialog, showEphemeral = true, onToggleShowEphemeral, projects = [], projectFilter = "all", onSelectProjectFilter, countClosedStats = true, onToggleCountClosedStats }, cx) {
    void cx;
    const t = theme();
    const { columns: cols, visibleAll, itemsByKeyByCol } = this.getFilteredColumns(queue, {
      showEphemeral,
      projectFilter,
    });
    const boardColumns = this.mode === "beads" ? BEADS_COLUMNS : ROSCAELIFER_COLUMNS;

    const colViews = boardColumns.map((col) => {
      const listItems = cols[col.key] || [];
      const accent = columnAccent(col.key, t);
      const virtual = shouldVirtualizeColumn(col.key, listItems.length);

      return v_flex()
        .id(`col-${col.key}`)
        .flex_1()
        .min_w(300)
        .h_full()
        .min_h(0)
        .rounded(8)
        .bg(t.canvas || t.chrome)
        .border_1()
        .border_color(t.border)
        .child(
          h_flex()
            .h(36)
            .flex_none()
            .px(10)
            .items_center()
            .justify_between()
            .border_b(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().size(7).rounded(4).bg(accent))
                .child(div().text_size(12).font_semibold().text_color(t.foreground).child(col.label)),
            )
            .child(
              div()
                .px(6)
                .py(1)
                .rounded(5)
                .bg(t.raised)
                .text_size(11)
                .text_color(t.muted)
                .child(String(listItems.length)),
            ),
        )
        .child(
          virtual
            ? this.renderVirtualizedColumnBody(
                col,
                listItems,
                {
                  selectedId,
                  onSelectItem,
                  itemsByKey: itemsByKeyByCol.get(col.key) ?? new Map(),
                },
                t,
              )
            : this.renderActiveColumnBody(
                col,
                listItems,
                { selectedId, onSelectItem, actions, onOpenDialog },
                t,
              ),
        );
    });

    this._lastVisible = visibleAll;
    const minContentW = boardColumns.length * 300 + (boardColumns.length - 1) * 10 + 20;
    this._minContentW = minContentW;
    this.clampScrollX(minContentW);

    return v_flex()
      .size_full()
      .min_h(0)
      .child(this.renderFilterBar(queue, t, { showEphemeral, onToggleShowEphemeral, projects, projectFilter, onSelectProjectFilter, countClosedStats, onToggleCountClosedStats }))
      .when(Boolean(queue && !queue.bdAvailable && queue.bdError), (el) =>
        el.child(
          h_flex()
            .px(12)
            .py(6)
            .gap(8)
            .items_center()
            .bg((t.blocked || t.ansi1) + "1c")
            .border_b(1)
            .border_color(t.border)
            .text_size(11.5)
            .text_color(t.blocked || t.ansi1)
            .child(`bd unavailable: ${queue.bdError}`),
        ),
      )
      .child(
        div()
          .id("kanban-cols")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_hidden()
          .on_size_change((size, sizeCx) => {
            const zoom = settings()?.zoom || 1;
            this.viewportW = size.width / zoom;
            if (this.clampScrollX()) sizeCx?.notify();
          })
          .on_scroll_wheel((e, scrollCx) => this.handleOuterScrollWheel(e, scrollCx))
          .child(
            h_flex()
              .id("kanban-cols-track")
              .h_full()
              .min_h(0)
              .w_full()
              .min_w(minContentW)
              .ml(-Math.round(this.scrollX))
              .p(10)
              .gap(10)
              .on_size_change((size, sizeCx) => {
                const zoom = settings()?.zoom || 1;
                this.contentW = size.width / zoom;
                if (this.clampScrollX()) sizeCx?.notify();
              })
              .children(colViews),
          ),
      );
  }
}
