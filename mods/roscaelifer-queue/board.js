import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Button, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { theme } from "herdr";

const COLUMNS = [
  { key: "ready", label: "Ready", emptyText: "No ready beads" },
  { key: "running", label: "Running", emptyText: "No running tasks" },
  { key: "action", label: "Needs Action", emptyText: "Nothing waiting" },
  { key: "review", label: "Review", emptyText: "No items in review" },
  { key: "closed", label: "Closed", emptyText: "No recent closed items" },
];

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

function chip(id, text, color, bg, borderColor = null) {
  return div()
    .id(id)
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
    void cx;
  }

  focusSearch() {
    this.searchInput.focus();
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

  renderAgentStatus(item, t) {
    const st = item.agentStatus;
    if (!st) return null;
    if (st === "working") {
      return h_flex()
        .gap(4)
        .items_center()
        .flex_none()
        .child(
          svg("mods/roscaelifer-queue/icons/spinner.svg")
            .size(11)
            .flex_none()
            .text_color(t.working || t.accent)
            .spin(900),
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

  renderStepProgress(item, t) {
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
      .child(
        Progress.new(`prog-${item.id}`)
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
          ),
      );
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

  renderCard(item, { selectedId, onSelectItem, actions, onOpenDialog }, t) {
    const selected = item.id === selectedId;
    const pStyle = priorityStyle(item.priority, t);
    const reason = actionReasonBadge(item.actionReason, t);
    const actionRow = this.renderCardActions(item, { actions, onOpenDialog }, t);

    return v_flex()
      .id(`card-${item.id}`)
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(selected ? t.selected : t.surface)
      .border_1()
      .border_color(selected ? t.accent : t.border)
      .cursor_pointer()
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        onSelectItem?.(item, cx);
      })
      .child(
        h_flex()
          .items_center()
          .gap(6)
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
          .when(Boolean(item.agentStatus), (el) => el.child(this.renderAgentStatus(item, t))),
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
            el.child(chip(`f-${item.id}`, item.formula, t.foreground, t.raised, t.border)),
          )
          .when(Boolean(item.env), (el) =>
            el.child(chip(`e-${item.id}`, `env:${item.env}`, t.muted, t.raised)),
          )
          .when(item.isOptedIn && item.column === "ready", (el) =>
            el.child(chip(`opt-${item.id}`, "queued", t.accent, t.accent + "1f")),
          )
          .when(item.isBlocked && item.column === "ready", (el) =>
            el.child(chip(`blk-${item.id}`, `blocked (${item.blockedBy.length})`, t.ansi1 || t.blocked, (t.ansi1 || t.blocked) + "1f")),
          )
          .when(Boolean(reason), (el) =>
            el.child(chip(`rsn-${item.id}`, reason.text, reason.color, reason.color + "22")),
          )
          .when(item.pendingCleanup, (el) =>
            el.child(
              chip(
                `cln-${item.id}`,
                `cleanup (${item.pendingCleanupCount})`,
                t.blocked || t.ansi3,
                (t.blocked || t.ansi3) + "20",
              ),
            ),
          ),
      )
      .when(item.steps && item.steps.length > 0, (el) => el.child(this.renderStepProgress(item, t)))
      .when(Boolean(actionRow), (el) => el.child(actionRow));
  }

  renderFilterBar(queue, t) {
    const envs = queue?.envs || [];
    const pill = (id, label, active, extra, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(9)
        .gap(5)
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.raised)
        .text_size(11.5)
        .text_color(active ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          onClick();
          cx.notify();
        })
        .child(label)
        .when(Boolean(extra), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(extra)));

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
            pill("env-all", "All Envs", this.envFilter === "all", null, () => {
              this.envFilter = "all";
            }),
          )
          .children(
            envs.map((env) => {
              const cap = env.maxRunning > 0 ? `${env.runningWorkSteps}/${env.maxRunning}` : env.runningWorkSteps > 0 ? `${env.runningWorkSteps}` : null;
              return pill(
                `env-${env.name}`,
                env.name,
                this.envFilter === env.name,
                cap,
                () => {
                  this.envFilter = env.name;
                },
              );
            }),
          )
          .child(
            pill(
              "filter-queued",
              "Queued only",
              this.onlyQueued,
              null,
              () => {
                this.onlyQueued = !this.onlyQueued;
              },
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

  render({ queue, selectedId, onSelectItem, actions, onOpenDialog }, cx) {
    void cx;
    const t = theme();
    const cols = queue?.columns || { ready: [], running: [], action: [], review: [], closed: [] };
    const visibleAll = [];

    const colViews = COLUMNS.map((col) => {
      const list = (cols[col.key] || []).filter((item) => this.matchesFilter(item));
      visibleAll.push(...list);
      const accent = columnAccent(col.key, t);

      return v_flex()
        .id(`col-${col.key}`)
        .flex_1()
        .min_w(215)
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
                .child(String(list.length)),
            ),
        )
        .child(
          v_flex()
            .id(`col-scroll-${col.key}`)
            .flex_1()
            .min_h(0)
            .p(8)
            .gap(8)
            .overflow_y_scrollbar()
            .when(list.length === 0, (el) =>
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
              list.map((item) =>
                this.renderCard(item, { selectedId, onSelectItem, actions, onOpenDialog }, t),
              ),
            ),
        );
    });

    this._lastVisible = visibleAll;

    return v_flex()
      .size_full()
      .min_h(0)
      .child(this.renderFilterBar(queue, t))
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
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(10)
          .overflow_x_scroll()
          .children(colViews),
      );
  }
}
