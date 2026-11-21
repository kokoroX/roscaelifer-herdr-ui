import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, TextView, ScrollHandle, Scrollbar } from "gpui-base";
import { hc, theme, settings, notify } from "herdr";
import { formatDispatchModel } from "./store.js";

const I = (name) => `mods/roscaelifer-queue/icons/${name}.svg`;
const alpha = (c, aa) => (typeof c === "string" && c.length === 7 ? c + aa : c);

function parseTimeMs(val) {
  if (!val) return 0;
  if (typeof val === "number") return val > 1e12 ? val : val * 1000;
  const ms = Date.parse(String(val));
  return Number.isNaN(ms) ? 0 : ms;
}

function formatElapsed(iso) {
  const ms = parseTimeMs(iso);
  if (!ms) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

function formatTimestamp(iso) {
  const ms = parseTimeMs(iso);
  if (!ms) return String(iso ?? "");
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");
}

// Renders text verbatim (no Markdown parsing, so command args, paths and `[...]`
// survive) inside a selectable TextView so it can be drag-selected and copied.
function selectableText(id, text) {
  return TextView.html(id, `<span>${escapeHtml(text)}</span>`).selectable(true);
}

function copyBtn(t, id, text) {
  const value = String(text ?? "");
  return Button.new(id)
    .h(20)
    .px(6)
    .flex()
    .items_center()
    .gap(4)
    .rounded(5)
    .bg(t.raised)
    .border_1()
    .border_color(t.border)
    .text_size(10.5)
    .font_medium()
    .text_color(t.muted)
    .cursor_pointer()
    .tooltip("Copy to clipboard")
    .when(!value, (el) => el.opacity(0.45).disabled(true))
    .when(Boolean(value), (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => {
      if (!value) return;
      cx.write_to_clipboard(value);
      notify({
        title: "Copied",
        body: value.length > 90 ? `${value.slice(0, 87)}…` : value,
        level: "success",
        timeout: 1500,
      });
    })
    .child("Copy");
}

function statusColor(status, t) {
  switch (String(status ?? "").toLowerCase()) {
    case "working":
    case "running":
    case "dispatching":
    case "in_progress":
    case "active":
      return t.working;
    case "blocked":
    case "needs_human":
    case "waiting_approval":
    case "action":
      return t.blocked;
    case "done":
    case "closed":
    case "review":
      return t.done;
    case "failed":
    case "error":
    case "cancelled":
      return t.ansi1;
    case "idle":
    case "ready":
    case "open":
    case "pending":
      return t.idle;
    default:
      return t.muted;
  }
}

function badge(t, label, color, filled = false) {
  return div()
    .px(6)
    .py(2)
    .rounded(5)
    .border_1()
    .border_color(filled ? color : alpha(color, "55"))
    .bg(filled ? color : alpha(color, "1c"))
    .text_size(10.5)
    .font_medium()
    .text_color(filled ? t.solid_foreground : color)
    .child(label);
}

function actionBtn(t, id, label, onClick, opts = {}) {
  const { primary = false, danger = false, disabled = false, icon = null } = opts;
  const bg = primary ? t.solid : danger ? alpha(t.ansi1, "20") : t.raised;
  const fg = primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground;
  const border = primary ? t.solid : danger ? alpha(t.ansi1, "66") : t.input;
  return Button.new(id)
    .h(26)
    .px(9)
    .flex()
    .items_center()
    .gap(5)
    .rounded(6)
    .border_1()
    .border_color(border)
    .bg(bg)
    .text_size(11.5)
    .font_medium()
    .text_color(fg)
    .disabled(disabled)
    .when(disabled, (el) => el.opacity(0.45))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.86)))
    .on_click((e, cx) => {
      if (!disabled) onClick(e, cx);
    })
    .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(12).text_color(fg)))
    .child(label);
}

function sectionHeader(t, title, right = null) {
  return h_flex()
    .items_center()
    .justify_between()
    .pt(4)
    .pb(4)
    .child(div().text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase()))
    .when(Boolean(right), (el) => el.child(right));
}

export class InspectorController {
  constructor(_cx) {
    this.scroll = ScrollHandle.new();
    this.tailScroll = ScrollHandle.new();
    this.hcAddress = null;
    this.hcTail = null;
    this.hcLoading = false;
    this.hcError = null;
    this.expandedStep = null;
    this.copiedKey = null;
  }

  copyToClipboard(cx, key, text) {
    const value = String(text ?? "");
    if (!value) return;
    cx.write_to_clipboard(value);
    this.copiedKey = key;
    cx.notify();
    cx?.timer?.after(1500, (tickCx) => {
      if (this.copiedKey !== key) return;
      this.copiedKey = null;
      tickCx.notify();
    });
  }

  refreshTail(address, cx) {
    if (!address || this.hcLoading) return;
    this.hcAddress = address;
    this.hcLoading = true;
    this.hcError = null;
    cx.spawn(async (cx) => {
      try {
        const res = await hc(["read", address, "--lines", "35"]);
        if (this.hcAddress !== address) return;
        if (res.code === 0) {
          this.hcTail = res.stdout || "(terminal buffer is empty)";
          this.hcError = null;
        } else {
          this.hcError = (res.stderr || res.stdout || `hc read exited ${res.code}`).trim();
        }
      } catch (err) {
        if (this.hcAddress === address) {
          this.hcError = String(err?.message ?? err);
        }
      } finally {
        if (this.hcAddress === address) {
          this.hcLoading = false;
          cx.notify();
        }
      }
    });
  }

  resetTail() {
    this.hcAddress = null;
    this.hcTail = null;
    this.hcLoading = false;
    this.hcError = null;
  }

  render({ item, detail, beadDetail, detailLoading, detailError, actions, ctx, onOpenDialog, onClose, onRefreshDetail }, cx) {
    const t = theme();
    if (!item) {
      return v_flex()
        .id("inspector-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p(20)
        .gap(8)
        .bg(t.surface)
        .border_l(1)
        .border_color(t.border)
        .child(div().text_size(13).font_medium().text_color(t.muted).child("No item selected"))
        .child(div().text_size(11.5).text_color(t.dim).child("Click any card on the board or graph to inspect steps, logs, and terminal output."));
    }

    const taskDetail = detail?.task ?? detail ?? null;
    const steps = Array.isArray(detail?.steps) && detail.steps.length > 0 ? detail.steps : (item.steps ?? []);
    const events = Array.isArray(detail?.events) ? detail.events : [];
    const detailLinks = detail?.links && typeof detail.links === "object" ? detail.links : {};

    let latestReply = detail?.reply ?? taskDetail?.reply ?? null;
    if (!latestReply) {
      for (let i = steps.length - 1; i >= 0 && !latestReply; i -= 1) {
        const s = steps[i];
        const attempts = Array.isArray(s.attempts) ? s.attempts : [];
        for (let j = attempts.length - 1; j >= 0 && !latestReply; j -= 1) {
          if (attempts[j]?.reply && String(attempts[j].reply).trim()) {
            latestReply = attempts[j].reply;
          }
        }
        const curA = s.current_attempt ?? s.currentAttempt;
        if (!latestReply && curA?.reply && String(curA.reply).trim()) {
          latestReply = curA.reply;
        }
      }
    }
    const reply = latestReply;

    const currentStep =
      steps.find((s) => s.status === "running" || s.status === "waiting_approval" || s.status === "needs_human" || s.status === "failed") ??
      item.currentStep ??
      steps[steps.length - 1] ??
      null;

    const curStepId = currentStep?.step_id ?? currentStep?.stepId ?? currentStep?.id ?? null;
    const curAttempt = currentStep?.current_attempt ?? currentStep?.currentAttempt ?? (Array.isArray(currentStep?.attempts) && currentStep.attempts.length ? currentStep.attempts[currentStep.attempts.length - 1] : null);
    const hcAddress = item.hcAddress || curAttempt?.hc_address || curAttempt?.hcAddress || currentStep?.hc_address || currentStep?.hcAddress || null;
    const worktree = item.worktree || curAttempt?.worktree || currentStep?.worktree || null;
    const branch = item.branch || curAttempt?.branch || currentStep?.branch || null;
    const link = item.link || curAttempt?.effective_link || curAttempt?.link || (curStepId ? detailLinks[curStepId] : null) || null;

    if (hcAddress && hcAddress !== this.hcAddress && !this.hcLoading) {
      this.refreshTail(hcAddress, cx);
    } else if (!hcAddress && this.hcAddress) {
      this.resetTail();
    }

    const bodyText = taskDetail?.body || beadDetail?.description || item.body || item.description || "";
    const acText = beadDetail?.acceptance_criteria || item.acceptanceCriteria || item.issue?.acceptance_criteria || "";
    const notesText = beadDetail?.notes || item.notes || item.issue?.notes || "";
    const closeReason = beadDetail?.close_reason || item.closeReason || item.issue?.close_reason || "";
    const busy = actions?.isBusy ? actions.isBusy() : false;
    const routeCtx = item?.projectCtx || ctx || null;
    const monoFont = settings()?.font_family ?? "JetBrains Mono";
    const resolvedMachine =
      item.machine ||
      item.resolvedEnv?.machine ||
      (hcAddress && hcAddress.includes("/") ? hcAddress.split("/")[0] : null);

    const prioLabel = item.priority !== undefined && item.priority !== null ? `P${item.priority}` : null;
    const statusText = item.taskStatus || item.bdStatus || item.status || "open";
    const statusCol = statusColor(item.agentStatus || statusText, t);

    // Quick contextual actions
    const actionButtons = [];
    if (actions) {
      if (item.beadId && !item.isOptedIn && item.bdStatus !== "closed" && !item.taskId) {
        actionButtons.push(
          actionBtn(t, "insp-act-enqueue", "Enqueue", () => onOpenDialog?.("enqueue", { item }), { disabled: busy, icon: "play" }),
          actionBtn(t, "insp-act-dispatch", "Dispatch Now", (_e, cx) => item.formula
            ? actions.dispatchBead(item.beadId, {
                formula: item.formula,
                env: item.env,
                currentLabels: item.labels || [],
                bdStatus: item.bdStatus,
                wakeDeferred: item.bdStatus === "deferred",
                maxRunning: item.maxRunning ?? undefined,
                ctx: routeCtx || undefined,
              }, cx)
            : onOpenDialog?.("enqueue", { item }), { primary: true, disabled: busy || item.isBlocked, icon: "play" }),
        );
      }
      if (item.beadId && item.isOptedIn && item.bdStatus !== "closed" && !item.taskId) {
        actionButtons.push(
          actionBtn(t, "insp-act-dispatch-opt", "Dispatch", (_e, cx) => actions.dispatchBead(item.beadId, {
            formula: item.formula || undefined,
            env: item.env,
            currentLabels: item.labels || [],
            bdStatus: item.bdStatus,
            wakeDeferred: item.bdStatus === "deferred",
            maxRunning: item.maxRunning ?? undefined,
            ctx: routeCtx || undefined,
          }, cx), { primary: true, disabled: busy || item.isBlocked, icon: "play" }),
          actionBtn(t, "insp-act-options", "Options", () => onOpenDialog?.("enqueue", { item }), { disabled: busy }),
          actionBtn(t, "insp-act-dequeue", "Dequeue", (_e, cx) => actions.dequeueBead(item.beadId, cx, routeCtx), { disabled: busy, icon: "close" }),
        );
      }
      if (item.needsReview && item.beadId) {
        actionButtons.push(
          actionBtn(t, "insp-act-approve-rev", "Approve Review", (_e, cx) => actions.approveReview(item.beadId, cx, routeCtx), { primary: true, disabled: busy, icon: "check" }),
          actionBtn(t, "insp-act-reject-rev", "Reject…", () => onOpenDialog?.("reject", { item }), { danger: true, disabled: busy }),
        );
      }
      if (item.taskId && currentStep && (currentStep.status === "waiting_approval" || currentStep.status === "needs_human")) {
        const sid = currentStep.step_id ?? currentStep.stepId ?? currentStep.id;
        actionButtons.push(
          actionBtn(t, "insp-act-approve-gate", `Approve ${sid}`, (_e, cx) => actions.approveGate(item.taskId, sid, cx, routeCtx), { primary: true, disabled: busy, icon: "check" }),
        );
      }
      if (item.taskId && currentStep && currentStep.status === "failed") {
        const sid = currentStep.step_id ?? currentStep.stepId ?? currentStep.id;
        actionButtons.push(
          actionBtn(t, "insp-act-retry", `Retry ${sid}`, (_e, cx) => actions.retryTask(item.taskId, sid, cx, routeCtx), { primary: true, disabled: busy, icon: "refresh" }),
        );
      } else if (item.beadId && item.hasFailedLabel) {
        actionButtons.push(
          actionBtn(t, "insp-act-requeue", "Requeue", (_e, cx) => actions.requeueBead(item.beadId, item.labels || [], cx, routeCtx), { primary: true, disabled: busy, icon: "refresh" }),
        );
      }
      if (item.taskId && item.taskStatus === "active") {
        actionButtons.push(
          actionBtn(t, "insp-act-cancel", "Cancel Task", (_e, cx) => actions.cancelTask(item.taskId, cx, routeCtx), { danger: true, disabled: busy }),
        );
      }
      if (item.beadId && item.bdStatus !== "closed" && !item.needsReview) {
        actionButtons.push(
          actionBtn(t, "insp-act-close-bead", "Close Bead", (_e, cx) => actions.closeBead(item.beadId, "", cx, routeCtx), { disabled: busy }),
        );
      }
      if (item.beadId && item.bdStatus === "closed") {
        actionButtons.push(
          actionBtn(t, "insp-act-reopen-bead", "Reopen Bead", (_e, cx) => actions.reopenBead(item.beadId, cx, routeCtx), { disabled: busy }),
        );
      }
      if (item.pendingCleanup && item.taskId) {
        actionButtons.push(
          actionBtn(t, "insp-act-clean", "Clean…", () => onOpenDialog?.("clean-preview", { item, target: { taskId: item.taskId } }), { disabled: busy, icon: "clean" }),
        );
      }
    }

    const taskVars = taskDetail?.vars ?? detail?.vars ?? item.task?.vars ?? {};
    const beadMeta = beadDetail?.metadata ?? item.issue?.metadata ?? {};
    const varCwd = taskVars?.cwd || beadMeta?.["roscaelifer.var.cwd"] || "";
    const curModelLabel = formatDispatchModel(curAttempt?.provider, curAttempt?.model);
    const varModelLabel = formatDispatchModel(
      taskVars?.provider || beadMeta?.["roscaelifer.var.provider"] || "",
      taskVars?.model || beadMeta?.["roscaelifer.var.model"] || "",
    );
    const modelLabel = curModelLabel || item.dispatchModelLabel || varModelLabel;
    const varMcp = taskVars?.mcp_profile || beadMeta?.["roscaelifer.var.mcp_profile"] || "";

    const metaRows = [];
    if (item.env) metaRows.push(["Env", item.env]);
    else if (item.envPendingAuto) metaRows.push(["Env", "auto (pending)"]);
    if (item.formula) metaRows.push(["Formula", item.formula]);
    if (item.project) metaRows.push(["Project", item.project]);
    if (item.projectName) metaRows.push(["Workspace Project", item.projectName]);
    if (varCwd && varCwd !== worktree) metaRows.push(["Cwd", varCwd]);
    if (modelLabel) metaRows.push(["Model", modelLabel]);
    if (varMcp) metaRows.push(["MCP Profile", varMcp]);
    if (branch) metaRows.push(["Branch", branch]);
    if (worktree) metaRows.push(["Worktree", worktree]);
    if (hcAddress) metaRows.push(["Terminal", hcAddress]);
    if (item.sessionInfo?.spaceName || item.sessionInfo?.tabName) {
      metaRows.push(["Space / Tab", [item.sessionInfo.spaceName, item.sessionInfo.tabName].filter(Boolean).join(" · ")]);
    }
    if (link) metaRows.push(["Link", link]);

    return v_flex()
      .id("inspector-drawer")
      .size_full()
      .min_h(0)
      .bg(t.surface)
      .border_l(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      // Fixed Header Bar
      .child(
        v_flex()
          .flex_none()
          .p(14)
          .gap(8)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .gap(8)
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .flex_wrap()
                  .when(Boolean(item.beadId), (el) =>
                    el.child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.raised)
                        .font_family(monoFont)
                        .text_size(11)
                        .text_color(t.accent)
                        .cursor_pointer()
                        .tooltip("Click to copy")
                        .on_click((_e, cx) => this.copyToClipboard(cx, `bead-${item.id}`, item.beadId))
                        .child(this.copiedKey === `bead-${item.id}` ? `${item.beadId} ✓` : item.beadId),
                    ),
                  )
                  .when(Boolean(item.taskId), (el) =>
                    el.child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.raised)
                        .font_family(monoFont)
                        .text_size(11)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .tooltip("Click to copy")
                        .on_click((_e, cx) => this.copyToClipboard(cx, `task-${item.id}`, `#${item.taskId}`))
                        .child(this.copiedKey === `task-${item.id}` ? `#${item.taskId} ✓` : `#${item.taskId}`),
                    ),
                  )
                  .when(Boolean(item.projectName), (el) =>
                    el.child(
                      badge(t, item.projectName, item.projectColor || t.accent),
                    ),
                  )
                  .when(Boolean(prioLabel), (el) => el.child(badge(t, prioLabel, item.priority <= 1 ? t.ansi1 : t.muted)))
                  .when(Boolean(item.ephemeral || beadDetail?.ephemeral), (el) => el.child(badge(t, "ephemeral", t.ansi3 || t.accent)))
                  .child(badge(t, statusText, statusCol))
                  .when(Boolean(item.agentStatus), (el) => el.child(badge(t, `agent:${item.agentStatus}`, statusColor(item.agentStatus, t))))
                  .when(Boolean(item.sessionInfo?.spaceName || item.sessionInfo?.tabName), (el) => el.child(badge(t, [item.sessionInfo.spaceName, item.sessionInfo.tabName].filter(Boolean).join(" · "), t.accent))),
              )
              .child(
                h_flex()
                  .items_center()
                  .gap(4)
                  .flex_none()
                  .when(Boolean((item.taskId || item.beadId) && onRefreshDetail), (el) =>
                    el.child(
                      Button.new("insp-refresh-detail")
                        .size(24)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(5)
                        .hover((s) => s.bg(t.hover))
                        .tooltip("Refresh detail")
                        .on_click((_e, cx) => onRefreshDetail(cx))
                        .when(detailLoading, (el) =>
                          el.child(svg(I("spinner")).size(13).flex_none().text_color(t.muted).spin(900)),
                        )
                        .when(!detailLoading, (el) =>
                          el.child(svg(I("refresh")).size(13).flex_none().text_color(t.muted)),
                        ),
                    ),
                  )
                  .when(Boolean(onClose), (el) =>
                    el.child(
                      Button.new("insp-close")
                        .size(24)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(5)
                        .hover((s) => s.bg(t.hover))
                        .tooltip("Close inspector")
                        .on_click((_e, cx) => onClose(cx))
                        .child(svg(I("close")).size(13).text_color(t.muted)),
                    ),
                  ),
              ),
          )
          .child(div().text_size(14.5).font_semibold().line_height("20px").text_color(t.foreground).child(selectableText(`insp-title-${item.id}`, item.title || item.id)))
          .when((item.labels ?? []).length > 0, (el) =>
            el.child(
              h_flex()
                .gap(4)
                .flex_wrap()
                .children((item.labels ?? []).map((lbl) => badge(t, lbl, lbl.startsWith("roscaelifer-") ? t.blocked : t.dim))),
            ),
          )
          .when(actionButtons.length > 0, (el) => el.child(h_flex().pt(2).gap(6).flex_wrap().children(actionButtons))),
      )
      // Scrollable Body
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("inspector-scroll")
              .track_scroll(this.scroll)
              .size_full()
              .overflow_y_scroll()
              .p(14)
              .gap(14)
              // Metadata grid
              .when(metaRows.length > 0, (el) =>
                el.child(
                  v_flex()
                    .p(10)
                    .gap(5)
                    .rounded(8)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .children(
                      metaRows.map(([k, v]) =>
                        h_flex()
                          .gap(8)
                          .items_start()
                          .child(div().w(68).flex_none().text_size(11).text_color(t.dim).child(k))
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .text_size(11.5)
                              .font_family(monoFont)
                              .text_color(t.foreground)
                              .child(selectableText(`insp-meta-${item.id}-${String(k).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, String(v))),
                          ),
                      ),
                    ),
                ),
              )
              // Detail error banner
              .when(Boolean(detailError), (el) =>
                el.child(
                  div()
                    .p(8)
                    .rounded(6)
                    .bg(alpha(t.ansi1, "18"))
                    .border_1()
                    .border_color(alpha(t.ansi1, "44"))
                    .text_size(11.5)
                    .text_color(t.ansi1)
                    .child(selectableText(`insp-detail-error-${item.id}`, `Detail error: ${detailError}`)),
                ),
              )
              // Detail loading indicator (when brief snapshot omitted text fields)
              .when(
                detailLoading &&
                  !bodyText.trim() &&
                  !acText.trim() &&
                  !notesText.trim() &&
                  !closeReason.trim() &&
                  !detailError,
                (el) =>
                  el.child(
                    h_flex()
                      .p(10)
                      .gap(8)
                      .items_center()
                      .rounded(8)
                      .bg(t.background)
                      .border_1()
                      .border_color(t.border)
                      .text_size(11.5)
                      .text_color(t.muted)
                      .child(svg(I("spinner")).size(12).flex_none().spin(900))
                      .child("Loading bead details…"),
                  ),
              )
              // Body / Description
              .when(Boolean(bodyText.trim()), (el) =>
                el.child(
                  v_flex()
                    .gap(4)
                    .child(sectionHeader(t, "Description"))
                    .child(
                      div()
                        .p(10)
                        .rounded(8)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(12.5)
                        .text_color(t.foreground)
                        .child(TextView.markdown(`insp-body-${item.id}`, bodyText).selectable(true)),
                    ),
                ),
              )
              // Acceptance Criteria
              .when(Boolean(acText.trim()), (el) =>
                el.child(
                  v_flex()
                    .gap(4)
                    .child(sectionHeader(t, "Acceptance Criteria"))
                    .child(
                      div()
                        .p(10)
                        .rounded(8)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(12.5)
                        .text_color(t.foreground)
                        .child(TextView.markdown(`insp-ac-${item.id}`, acText).selectable(true)),
                    ),
                ),
              )
              // Step Pipeline
              .when(steps.length > 0, (el) => el.child(this.renderSteps(t, steps, detailLinks, monoFont, item.id)))
              // Latest Reply
              .when(Boolean(reply && String(reply).trim()), (el) =>
                el.child(
                  v_flex()
                    .gap(4)
                    .child(sectionHeader(t, "Latest Reply"))
                    .child(
                      div()
                        .p(10)
                        .rounded(8)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(12)
                        .text_color(t.foreground)
                        .child(TextView.markdown(`insp-reply-${item.id}`, String(reply)).selectable(true)),
                    ),
                ),
              )
              // Live Terminal Section
              .when(Boolean(hcAddress || worktree), (el) =>
                el.child(this.renderLiveTerminal(t, { item, hcAddress, worktree, resolvedMachine, actions, monoFont })),
              )
              // Notes / Close reason
              .when(Boolean(notesText.trim() || closeReason.trim()), (el) =>
                el.child(
                  v_flex()
                    .gap(6)
                    .child(sectionHeader(t, "Notes"))
                    .when(Boolean(closeReason.trim()), (c) =>
                      c.child(
                        div()
                          .p(8)
                          .rounded(6)
                          .bg(alpha(t.done, "18"))
                          .border_1()
                          .border_color(alpha(t.done, "44"))
                          .text_size(12)
                          .text_color(t.foreground)
                          .child(selectableText(`insp-close-reason-${item.id}`, `Close reason: ${closeReason}`)),
                      ),
                    )
                    .when(Boolean(notesText.trim()), (c) =>
                      c.child(
                        div()
                          .p(10)
                          .rounded(8)
                          .bg(t.background)
                          .border_1()
                          .border_color(t.border)
                          .text_size(12)
                          .text_color(t.foreground)
                          .child(TextView.markdown(`insp-notes-${item.id}`, notesText).selectable(true)),
                      ),
                    ),
                ),
              )
              // Events Timeline
              .when(events.length > 0, (el) => el.child(this.renderEvents(t, events, monoFont, item.id))),
          )
          .child(Scrollbar.vertical("inspector-scroll").absolute().inset_0()),
      );
  }

  renderSteps(t, steps, detailLinks, monoFont, itemId = "item") {
    return v_flex()
      .gap(6)
      .child(sectionHeader(t, `Pipeline Steps (${steps.length})`))
      .children(
        steps.map((s) => {
          const stepId = s.step_id ?? s.stepId ?? s.id ?? "step";
          const attempts = Array.isArray(s.attempts) ? s.attempts : [];
          const cur = s.current_attempt ?? s.currentAttempt ?? (attempts.length ? attempts[attempts.length - 1] : null);
          const attemptNum = cur?.n ?? attempts.length ?? 0;
          const maxAttempts = s.max_attempts ?? s.maxAttempts ?? 1;
          const rounds = s.rounds ?? 0;
          const maxRounds = s.max_rounds ?? s.maxRounds ?? 0;
          const dispatchFailures = s.dispatch_failures ?? s.dispatchFailures ?? 0;
          const runningSince = s.running_since ?? s.runningSince;
          const runningElapsed = s.status === "running" && runningSince ? formatElapsed(runningSince) : "";
          const curHandle = cur?.hc_address || cur?.hcAddress || cur?.thread_id || cur?.threadId;
          const curModel = formatDispatchModel(cur?.provider, cur?.model);
          const stepCol = statusColor(s.status, t);
          const isExpanded = this.expandedStep === stepId;

          return v_flex()
            .id(`insp-step-${stepId}`)
            .p(10)
            .gap(5)
            .rounded(8)
            .bg(t.background)
            .border_1()
            .border_color(s.status === "running" ? alpha(t.working, "66") : s.status === "failed" ? alpha(t.ansi1, "66") : t.border)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .gap(6)
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .child(div().font_semibold().text_size(12.5).text_color(t.foreground).child(stepId))
                    .child(badge(t, s.kind ?? "work", t.dim))
                    .child(badge(t, s.status ?? "pending", stepCol)),
                )
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .when(Boolean(runningElapsed), (el) => el.child(div().text_size(11).font_family(monoFont).text_color(t.working).child(runningElapsed)))
                    .when(attempts.length > 0, (el) =>
                      el.child(
                        div()
                          .id(`insp-step-exp-${stepId}`)
                          .px(5)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.muted)
                          .cursor_pointer()
                          .hover((st) => st.bg(t.hover))
                          .on_click((_e, cx) => {
                            this.expandedStep = isExpanded ? null : stepId;
                            cx.notify();
                          })
                          .child(isExpanded ? "Hide attempts" : `${attempts.length} attempts`),
                      ),
                    ),
                ),
            )
            .child(
              h_flex()
                .gap(10)
                .flex_wrap()
                .text_size(11)
                .text_color(t.muted)
                .child(`attempts: ${attemptNum}/${maxAttempts}`)
                .when(maxRounds > 0 || rounds > 0, (el) => el.child(`rounds: ${rounds}/${maxRounds}`))
                .when(dispatchFailures > 0, (el) => el.child(div().text_color(t.ansi1).child(`dispatch failures: ${dispatchFailures}`))),
            )
            .when(Boolean(cur?.worktree || cur?.branch || curHandle || cur?.link || curModel), (el) =>
              el.child(
                v_flex()
                  .gap(2)
                  .pt(2)
                  .text_size(11)
                  .font_family(monoFont)
                  .text_color(t.dim)
                  .when(Boolean(curModel), (c) =>
                    c.child(selectableText(`insp-step-meta-${itemId}-${stepId}-model`, `model: ${curModel}`)),
                  )
                  .when(Boolean(curHandle), (c) =>
                    c.child(selectableText(`insp-step-meta-${itemId}-${stepId}-terminal`, `terminal: ${curHandle}`)),
                  )
                  .when(Boolean(cur?.branch), (c) =>
                    c.child(selectableText(`insp-step-meta-${itemId}-${stepId}-branch`, `branch: ${cur.branch}`)),
                  )
                  .when(Boolean(cur?.worktree), (c) =>
                    c.child(selectableText(`insp-step-meta-${itemId}-${stepId}-worktree`, `worktree: ${cur.worktree}`)),
                  )
                  .when(Boolean(cur?.effective_link || cur?.link || detailLinks?.[stepId]), (c) =>
                    c.child(
                      selectableText(
                        `insp-step-meta-${itemId}-${stepId}-link`,
                        `link: ${cur?.effective_link || cur?.link || detailLinks?.[stepId]}`,
                      ),
                    ),
                  ),
              ),
            )
            .when(Boolean(s.detail), (el) =>
              el.child(
                div()
                  .p(7)
                  .rounded(6)
                  .bg(t.raised)
                  .child(
                    h_flex()
                      .items_start()
                      .justify_between()
                      .gap(6)
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .text_size(11.5)
                          .text_color(s.status === "failed" ? t.ansi1 : t.muted)
                          .child(selectableText(`insp-step-detail-${itemId}-${stepId}`, String(s.detail))),
                      )
                      .child(copyBtn(t, `insp-step-detail-copy-${itemId}-${stepId}`, String(s.detail))),
                  ),
              ),
            )
            .when(isExpanded && attempts.length > 0, (el) =>
              el.child(
                v_flex()
                  .pt(4)
                  .gap(4)
                  .border_t(1)
                  .border_color(t.border)
                  .children(
                    attempts.map((a, ai) =>
                      v_flex()
                        .p(6)
                        .gap(2)
                        .rounded(5)
                        .bg(t.raised)
                        .text_size(11)
                        .child(
                          h_flex()
                            .justify_between()
                            .child(div().font_medium().text_color(t.foreground).child(`#${a.n} · ${a.status}`))
                            .child(div().text_color(t.dim).child(formatTimestamp(a.created_at || a.started_at))),
                        )
                        .when(Boolean(formatDispatchModel(a.provider, a.model)), (c) =>
                          c.child(
                            div()
                              .font_family(monoFont)
                              .text_color(t.dim)
                              .child(
                                selectableText(
                                  `insp-att-${itemId}-${stepId}-${ai}-model`,
                                  `model: ${formatDispatchModel(a.provider, a.model)}`,
                                ),
                              ),
                          ),
                        )
                        .when(Boolean(a.hc_address || a.thread_id), (c) =>
                          c.child(
                            div()
                              .font_family(monoFont)
                              .text_color(t.dim)
                              .child(
                                selectableText(
                                  `insp-att-${itemId}-${stepId}-${ai}-handle`,
                                  `handle: ${a.hc_address || a.thread_id}`,
                                ),
                              ),
                          ),
                        )
                        .when(Boolean(a.error), (c) =>
                          c.child(
                            div()
                              .text_color(t.ansi1)
                              .child(selectableText(`insp-att-${itemId}-${stepId}-${ai}-error`, String(a.error))),
                          ),
                        )
                        .when(Boolean(a.reply && String(a.reply).trim()), (c) =>
                          c.child(
                            div()
                              .pt(2)
                              .text_color(t.muted)
                              .child(
                                selectableText(
                                  `insp-att-${itemId}-${stepId}-${ai}-reply`,
                                  String(a.reply).slice(0, 280),
                                ),
                              ),
                          ),
                        ),
                    ),
                  ),
              ),
            );
        }),
      );
  }

  renderLiveTerminal(t, { item, hcAddress, worktree, resolvedMachine, actions, monoFont }) {
    return v_flex()
      .gap(6)
      .child(
        sectionHeader(
          t,
          "Live Terminal",
          hcAddress
            ? h_flex()
                .gap(4)
                .child(
                  Button.new("insp-term-refresh")
                    .h(22)
                    .px(7)
                    .flex()
                    .items_center()
                    .gap(4)
                    .rounded(5)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.refreshTail(hcAddress, cx))
                    .when(this.hcLoading, (el) =>
                      el.child(svg(I("spinner")).size(11).flex_none().text_color(t.muted).spin(900)),
                    )
                    .when(!this.hcLoading, (el) =>
                      el.child(svg(I("refresh")).size(11).flex_none().text_color(t.muted)),
                    )
                    .child("Refresh"),
                )
                .child(copyBtn(t, "insp-term-copy", this.hcTail || ""))
            : null,
        ),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .when(Boolean(hcAddress && actions), (el) =>
            el
              .child(actionBtn(t, "insp-term-peek", "Peek", () => actions.peekTerminal(hcAddress), { icon: "terminal" }))
              .child(actionBtn(t, "insp-term-open", "Open Session", () => actions.switchToSession(item)))
              .child(actionBtn(t, "insp-term-keep", "Keep", () => actions.keepTerminal(hcAddress))),
          )
          .when(Boolean(worktree && actions), (el) =>
            el.child(
              actionBtn(t, "insp-term-open-wt", "Open Worktree", () =>
                actions.openWorktree({
                  name: item.beadId || item.taskId || item.title,
                  folder: worktree,
                  machine: resolvedMachine,
                  envSpace: item.sessionInfo?.envSpace ?? null,
                  projectRepo: item.projectCtx?.repo ?? null,
                }),
                { icon: "folder" },
              ),
            ),
          ),
      )
      .when(Boolean(hcAddress), (el) =>
        el.child(
          div()
            .relative()
            .h(210)
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .child(
              v_flex()
                .id("insp-hc-tail-scroll")
                .track_scroll(this.tailScroll)
                .size_full()
                .overflow_y_scroll()
                .p(8)
                .font_family(monoFont)
                .text_size(11)
                .line_height("15px")
                .when(this.hcLoading && !this.hcTail, (c) => c.child(div().text_color(t.dim).child(`Reading ${hcAddress}…`)))
                .when(Boolean(this.hcError), (c) =>
                  c.child(selectableText(`insp-hc-error-${item.id}`, String(this.hcError))),
                )
                .when(Boolean(this.hcTail && !this.hcError), (c) =>
                  c.child(selectableText(`insp-hc-tail-${item.id}`, String(this.hcTail))),
                ),
            )
            .child(Scrollbar.vertical("insp-hc-tail-scroll").absolute().inset_0()),
        ),
      );
  }

  renderEvents(t, events, monoFont, itemId = "item") {
    const ordered = [...events].reverse();
    return v_flex()
      .gap(6)
      .child(sectionHeader(t, `Events (${events.length})`))
      .child(
        v_flex()
          .p(8)
          .gap(6)
          .rounded(8)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .children(
            ordered.slice(0, 60).map((ev, idx) => {
              const evLabel =
                ev.kind ??
                (ev.from && ev.to ? `${ev.from} -> ${ev.to}` : ev.to || ev.from || "event");
              const evCol = statusColor(ev.kind ?? ev.to ?? ev.from, t);
              return v_flex()
                .id(`insp-ev-${ev.id ?? idx}`)
                .gap(2)
                .pb(5)
                .when(idx < ordered.length - 1, (el) => el.border_b(1).border_color(t.border))
                .child(
                  h_flex()
                    .justify_between()
                    .gap(6)
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(div().text_size(11).font_semibold().text_color(evCol).child(evLabel))
                        .when(Boolean(ev.step_id), (el) => el.child(div().text_size(10.5).font_family(monoFont).text_color(t.muted).child(ev.step_id))),
                    )
                    .child(div().text_size(10.5).font_family(monoFont).text_color(t.dim).child(formatTimestamp(ev.created_at))),
                )
                .when(Boolean(ev.detail || ev.message), (el) =>
                  el.child(
                    selectableText(
                      `insp-ev-detail-${itemId}-${idx}-${ev.id ?? "event"}`,
                      String(ev.detail || ev.message),
                    ),
                  ),
                );
            }),
          ),
      );
  }
}
