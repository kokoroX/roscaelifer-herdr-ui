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
import { theme } from "herdr";
import { createColumnScrollLock } from "./scroll-lock.js";

const COLUMNS = [
  { key: "ready", label: "Ready", emptyText: "No ready beads" },
  { key: "running", label: "Running", emptyText: "No running tasks" },
  { key: "action", label: "Needs Action", emptyText: "Nothing waiting" },
  { key: "review", label: "Review", emptyText: "No items in review" },
  { key: "closed", label: "Closed", emptyText: "No recent closed items" },
];

const CLOSED_LIMIT_OPTIONS = [
  { value: 50, label: "50" },
  { value: 500, label: "500" },
  { value: 5000, label: "5k" },
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
    case "running":
      return t.working || t.accent;
    case "action":
      return t.blocked || t.ansi1;
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

function miniBtn(id, label, { bg, fg, border, busy = false, onClick }) {
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
    .cursor_pointer()
    .hover((s) => s.opacity(0.86))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick?.(e, cx);
    })
    .when(busy, (el) =>
      el.child(svg("mods/roscaelifer-queue/icons/spinner.svg").size(10).flex_none().spin(900)),
    )
    .child(label);
}

export class BoardController {
  constructor(cx) {
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
    // The active columns and the horizontal row keep their scroll position by
    // name; `closed` is a virtual `list()` and owns its own.
    this.colScrolls = {
      ready: ScrollHandle.new(),
      running: ScrollHandle.new(),
      action: ScrollHandle.new(),
      review: ScrollHandle.new(),
    };
    this.colsScroll = ScrollHandle.new();
    this._handleColumnScrollWheel = createColumnScrollLock();
    void cx;
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

  matchesFilter(item) {
    if (this.envFilter !== "all" && item.env !== this.envFilter) {
      return false;
    }
    if (this.onlyQueued && item.column === "ready" && !item.isOptedIn && !item.taskId) {
      return false;
    }
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item.id,
      item.beadId,
      item.taskId,
      item.title,
      item.formula,
      item.env,
      item.project,
      item.branch,
      ...(item.labels || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
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
    if (item.column === "ready") {
      if (item.beadId && !item.isOptedIn && !item.isBlocked) {
        btns.push(
          miniBtn(`act-q-${item.id}`, "Enqueue", {
            bg: t.solid,
            fg: t.solid_foreground,
            busy: actions.isBusy(`enqueue:${item.beadId}`),
            onClick: () => onOpenDialog("enqueue", { item }),
          }),
        );
      } else if (item.beadId && item.isOptedIn) {
        btns.push(
          miniBtn(`act-edit-${item.id}`, "Options", {
            bg: t.raised,
            fg: t.foreground,
            border: t.border,
            onClick: () => onOpenDialog("enqueue", { item }),
          }),
        );
      }
    } else if (item.column === "running") {
      if (item.hcAddress) {
        btns.push(
          miniBtn(`act-peek-${item.id}`, "Peek", {
            bg: t.raised,
            fg: t.foreground,
            border: t.border,
            onClick: () => actions.peekTerminal(item.hcAddress),
          }),
          miniBtn(`act-focus-${item.id}`, "Focus", {
            bg: t.raised,
            fg: t.foreground,
            border: t.border,
            onClick: () => actions.focusAgent(item.hcAddress),
          }),
        );
      }
      if (item.taskId) {
        btns.push(
          miniBtn(`act-cancel-${item.id}`, "Cancel", {
            bg: t.raised,
            fg: t.ansi1 || t.blocked,
            border: t.border,
            busy: actions.isBusy(`cancel:${item.taskId}`),
            onClick: (_e, cx) => actions.cancelTask(item.taskId, cx),
          }),
        );
      }
    } else if (item.column === "action") {
      if (item.actionReason === "waiting_approval" && item.taskId && item.waitingStep) {
        btns.push(
          miniBtn(`act-app-${item.id}`, "Approve", {
            bg: t.solid,
            fg: t.solid_foreground,
            busy: actions.isBusy(`approve:${item.taskId}:${item.waitingStep.stepId}`),
            onClick: (_e, cx) => actions.approveGate(item.taskId, item.waitingStep.stepId, cx),
          }),
        );
      }
      if (
        (item.actionReason === "failed" || item.actionReason === "cancelled") &&
        item.taskId &&
        item.waitingStep
      ) {
        btns.push(
          miniBtn(`act-retry-${item.id}`, "Retry", {
            bg: t.solid,
            fg: t.solid_foreground,
            busy: actions.isBusy(`retry:${item.taskId}:${item.waitingStep.stepId}`),
            onClick: (_e, cx) => actions.retryTask(item.taskId, item.waitingStep.stepId, cx),
          }),
        );
      }
      if (item.hasFailedLabel && item.beadId) {
        btns.push(
          miniBtn(`act-requeue-${item.id}`, "Re-queue", {
            bg: t.raised,
            fg: t.foreground,
            border: t.border,
            busy: actions.isBusy(`enqueue:${item.beadId}`),
            onClick: (_e, cx) => actions.requeueBead(item.beadId, item.labels, cx),
          }),
        );
      }
      if (item.hcAddress) {
        btns.push(
          miniBtn(`act-peek2-${item.id}`, "Peek", {
            bg: t.raised,
            fg: t.foreground,
            border: t.border,
            onClick: () => actions.peekTerminal(item.hcAddress),
          }),
        );
      }
    } else if (item.column === "review") {
      if (item.beadId) {
        btns.push(
          miniBtn(`act-pass-${item.id}`, "Pass", {
            bg: t.solid,
            fg: t.solid_foreground,
            busy: actions.isBusy(`approve-review:${item.beadId}`),
            onClick: (_e, cx) => actions.approveReview(item.beadId, cx),
          }),
          miniBtn(`act-reject-${item.id}`, "Reject", {
            bg: t.raised,
            fg: t.ansi1 || t.blocked,
            border: t.border,
            onClick: () => onOpenDialog("reject", { item }),
          }),
        );
      }
    } else if (item.column === "closed") {
      if (item.pendingCleanup && item.taskId) {
        btns.push(
          miniBtn(`act-clean-${item.id}`, "Clean", {
            bg: t.raised,
            fg: t.blocked || t.ansi3,
            border: t.border,
            onClick: () => onOpenDialog("clean-preview", { item, target: { taskId: item.taskId } }),
          }),
        );
      }
      if (item.beadId) {
        btns.push(
          miniBtn(`act-reopen-${item.id}`, "Reopen", {
            bg: t.raised,
            fg: t.muted,
            border: t.border,
            busy: actions.isBusy(`reopen:${item.beadId}`),
            onClick: (_e, cx) => actions.reopenBead(item.beadId, cx),
          }),
        );
      }
    }

    if (!btns.length) return null;
    return h_flex().pt(2).gap(6).flex_wrap().children(btns);
  }

  renderCard(item, { selectedId, onSelectItem, actions, onOpenDialog }, t, { interactive = true } = {}) {
    const selected = item.id === selectedId;
    const pStyle = priorityStyle(item.priority, t);
    const reason = actionReasonBadge(item.actionReason, t);
    const actionRow = interactive
      ? this.renderCardActions(item, { actions, onOpenDialog }, t)
      : null;

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
              .child(item.beadId && item.taskId ? `${item.beadId} · #${item.taskId}` : item.id),
          )
          .when(Boolean(item.agentStatus), (el) =>
            el.child(this.renderAgentStatus(item, t, { interactive })),
          ),
      )
      .child(
        div()
          .text_size(12.5)
          .font_medium()
          .text_color(t.foreground)
          .child(item.title),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .when(Boolean(item.formula), (el) =>
            el.child(chip(item.formula, t.foreground, t.raised, t.border)),
          )
          .when(Boolean(item.env), (el) =>
            el.child(chip(`env:${item.env}`, t.muted, t.raised)),
          )
          .when(item.isOptedIn && item.column === "ready", (el) =>
            el.child(chip("queued", t.accent, t.accent + "1f")),
          )
          .when(item.isBlocked && item.column === "ready", (el) =>
            el.child(chip(`blocked (${item.blockedBy.length})`, t.ansi1 || t.blocked, (t.ansi1 || t.blocked) + "1f")),
          )
          .when(Boolean(reason), (el) =>
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

  renderFilterBar(queue, t, { closedLimit = 500, onChangeClosedLimit, showEphemeral = false, onToggleShowEphemeral } = {}) {
    const envs = queue?.envs || [];

    const envTab = (id, label, active, extra, onClick) =>
      segmentTab(id, label, active, extra, onClick, t);

    return h_flex()
      .flex_none()
      .px(12)
      .py(8)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
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
                  const cap =
                    env.maxRunning > 0
                      ? `${env.runningWorkSteps}/${env.maxRunning}`
                      : env.runningWorkSteps > 0
                        ? `${env.runningWorkSteps}`
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
          )
          .child(div().w(1).h(16).bg(t.border).mx(2))
          .child(div().text_size(11).text_color(t.dim).child("Closed"))
          .child(
            segmentTabs("board-closed-limit-tabs", t).children(
              CLOSED_LIMIT_OPTIONS.map((opt) =>
                segmentTab(
                  `closed-limit-${opt.value}`,
                  opt.label,
                  closedLimit === opt.value,
                  null,
                  (clickCx) => {
                    if (onChangeClosedLimit) {
                      onChangeClosedLimit(opt.value, clickCx);
                    } else {
                      clickCx?.notify();
                    }
                  },
                  t,
                ),
              ),
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
      );
  }

  renderActiveColumnBody(col, listItems, { selectedId, onSelectItem, actions, onOpenDialog }, t) {
    return div()
      .relative()
      .flex_1()
      .min_h(0)
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
      .child(Scrollbar.vertical(`col-scroll-${col.key}`).absolute().inset_0());
  }

  // `closed` can hold thousands of beads, so it is a virtual list: only what is
  // on screen is laid out. A row may register no handlers of its own, which is
  // why the card inside it is drawn display-only and the press is answered by
  // `on_item_click` on the list (the Inspector carries the real actions).
  renderClosedColumnBody(col, listItems, { selectedId, onSelectItem }, t) {
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

    const itemsByKey = new Map(listItems.map((item) => [String(item.id), item]));

    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
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
      .child(Scrollbar.vertical(`col-scroll-${col.key}`).absolute().inset_0());
  }

  render({ queue, selectedId, onSelectItem, actions, onOpenDialog, closedLimit = 500, onChangeClosedLimit, showEphemeral = false, onToggleShowEphemeral }, cx) {
    void cx;
    const t = theme();
    const cols = queue?.columns || { ready: [], running: [], action: [], review: [], closed: [] };
    const visibleAll = [];

    const colViews = COLUMNS.map((col) => {
      const listItems = (cols[col.key] || []).filter((item) => this.matchesFilter(item));
      visibleAll.push(...listItems);
      const accent = columnAccent(col.key, t);

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
        .on_scroll_wheel((e, cx) => this.handleColumnScrollWheel(e, cx))
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
          col.key === "closed"
            ? this.renderClosedColumnBody(col, listItems, { selectedId, onSelectItem }, t)
            : this.renderActiveColumnBody(
                col,
                listItems,
                { selectedId, onSelectItem, actions, onOpenDialog },
                t,
              ),
        );
    });

    this._lastVisible = visibleAll;

    return v_flex()
      .size_full()
      .min_h(0)
      .child(this.renderFilterBar(queue, t, { closedLimit, onChangeClosedLimit, showEphemeral, onToggleShowEphemeral }))
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
        h_flex()
          .id("kanban-cols")
          .track_scroll(this.colsScroll)
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(10)
          .overflow_x_scroll()
          .children(colViews),
      );
  }
}
