import { div } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Input,
  InputState,
  Progress,
  ProgressIndicator,
  ProgressTrack,
  ScrollHandle,
  Scrollbar,
} from "gpui-base";
import { settings, theme } from "herdr";

const alpha = (c, aa) => (typeof c === "string" && c.length === 7 ? c + aa : c);

function statusColor(status, t) {
  switch (String(status ?? "").toLowerCase()) {
    case "working":
    case "running":
    case "active":
    case "in_progress":
    case "integrating":
      return t.working;
    case "blocked":
    case "action":
    case "waiting_approval":
    case "needs_human":
    case "conflict":
      return t.blocked;
    case "done":
    case "closed":
    case "merged":
    case "succeeded":
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

function formatTimestamp(iso) {
  if (!iso) return "";
  const ms = typeof iso === "number" ? (iso > 1e12 ? iso : iso * 1000) : Date.parse(String(iso));
  if (Number.isNaN(ms)) return String(iso);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pill(t, label, color) {
  return div()
    .px(5)
    .py(1)
    .rounded(4)
    .border_1()
    .border_color(alpha(color, "55"))
    .bg(alpha(color, "1c"))
    .text_size(10.5)
    .font_medium()
    .text_color(color)
    .child(label);
}

/**
 * Computes topological Wave lanes from items' `blockedBy` / `blocks` relations.
 * Returns { waves: Array<{ index: number, label: string, items: QueueItem[] }>, blockersOf: Map<string, string[]>, unlocksOf: Map<string, string[]> }.
 */
function computeWaves(items) {
  const byId = new Map();
  for (const it of items) {
    const key = it.beadId || it.id;
    if (key) byId.set(key, it);
  }

  const blockersOf = new Map();
  const unlocksOf = new Map();
  for (const key of byId.keys()) {
    blockersOf.set(key, new Set());
    unlocksOf.set(key, new Set());
  }

  for (const it of items) {
    const id = it.beadId || it.id;
    if (!id) continue;
    for (const b of it.blockedBy ?? []) {
      const bid = typeof b === "string" ? b : b?.id || b?.depends_on_id;
      if (bid && bid !== id && byId.has(bid)) {
        blockersOf.get(id).add(bid);
        unlocksOf.get(bid).add(id);
      }
    }
    for (const u of it.blocks ?? []) {
      const uid = typeof u === "string" ? u : u?.id || u?.issue_id;
      if (uid && uid !== id && byId.has(uid)) {
        unlocksOf.get(id).add(uid);
        blockersOf.get(uid).add(id);
      }
    }
  }

  // Kahn's topological layering
  const inDegree = new Map();
  for (const [id, deps] of blockersOf.entries()) {
    inDegree.set(id, deps.size);
  }

  const waves = [];
  const placed = new Set();
  let frontier = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) frontier.push(id);
  }

  const sortIds = (ids) =>
    ids.sort((a, b) => {
      const ia = byId.get(a);
      const ib = byId.get(b);
      return (ia?.priority ?? 9) - (ib?.priority ?? 9) || a.localeCompare(b);
    });

  let waveIndex = 0;
  while (frontier.length > 0) {
    sortIds(frontier);
    waves.push({
      index: waveIndex,
      label: `Wave ${waveIndex}`,
      items: frontier.map((id) => byId.get(id)),
    });
    const nextFrontier = [];
    for (const id of frontier) {
      placed.add(id);
      for (const child of unlocksOf.get(id) ?? []) {
        const nextDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, nextDeg);
        if (nextDeg === 0 && !placed.has(child)) {
          nextFrontier.push(child);
        }
      }
    }
    frontier = nextFrontier;
    waveIndex += 1;
  }

  // Handle any cycle nodes gracefully
  const remaining = [...byId.keys()].filter((id) => !placed.has(id));
  if (remaining.length > 0) {
    sortIds(remaining);
    waves.push({
      index: waveIndex,
      label: `Wave ${waveIndex} (Cycle)`,
      items: remaining.map((id) => byId.get(id)),
    });
  }

  return {
    waves,
    blockersOf: new Map([...blockersOf.entries()].map(([k, v]) => [k, [...v]])),
    unlocksOf: new Map([...unlocksOf.entries()].map(([k, v]) => [k, [...v]])),
  };
}

function collectChain(rootId, blockersOf, unlocksOf) {
  const upstream = new Set();
  const downstream = new Set();
  if (!rootId) return { upstream, downstream };

  const walk = (start, map, out) => {
    const stack = [...(map.get(start) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (out.has(cur) || cur === rootId) continue;
      out.add(cur);
      for (const next of map.get(cur) ?? []) {
        if (!out.has(next)) stack.push(next);
      }
    }
  };

  walk(rootId, blockersOf, upstream);
  walk(rootId, unlocksOf, downstream);
  return { upstream, downstream };
}

export class DepsController {
  constructor(_cx) {
    this.epicsScroll = ScrollHandle.new();
    this.wavesScroll = ScrollHandle.new();
    this.eventsScroll = ScrollHandle.new();
    this.selectedEpicId = null; // null = All Issues
    this.chainFocusId = null;
    this.showClosedInWaves = false;
    this.eventFilter = "";
    this.eventFilterInput = InputState.new({ placeholder: "Filter events by task, kind, or message…" });
    this.eventFilterInput.on("change", (_e, cx) => {
      this.eventFilter = this.eventFilterInput.value();
      cx.notify();
    });
    this.eventInputFocused = false;
    this.eventFilterInput.on("focus", (_e, cx) => {
      this.eventInputFocused = true;
      cx.notify();
    });
    this.eventFilterInput.on("blur", (_e, cx) => {
      this.eventInputFocused = false;
      cx.notify();
    });
  }

  render({ queue, snapshot, mode = "deps", onSelectItem, selectedId }, cx) {
    const t = theme();
    const monoFont = settings()?.font_family ?? "JetBrains Mono";
    const items = queue?.items ?? [];
    const epics = queue?.epics ?? [];
    const mirrors = queue?.mirrorIntegrations ?? snapshot?.mirror_integrations ?? [];
    const events = queue?.events ?? snapshot?.events ?? [];

    if (mode === "mirror") {
      return this.renderMirrorAndEvents(t, { queue, mirrors, events, onSelectItem, monoFont }, cx);
    }

    return v_flex()
      .id("deps-root")
      .size_full()
      .min_h(0)
      .gap(8)
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .gap(8)
          .child(this.renderEpicSidebar(t, { epics, items, monoFont }))
          .child(this.renderWaveGraph(t, { epics, items, onSelectItem, selectedId, monoFont })),
      )
      .when(mirrors.length > 0, (el) =>
        el.child(
          v_flex()
            .flex_none()
            .max_h(190)
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.surface)
            .overflow_hidden()
            .child(this.renderMirrorTable(t, mirrors, monoFont)),
        ),
      );
  }

  renderEpicSidebar(t, { epics, items, monoFont }) {
    const nonEpicCount = items.filter((it) => it.issueType !== "epic").length;
    const closedCount = items.filter((it) => it.issueType !== "epic" && (it.bdStatus === "closed" || it.column === "closed")).length;

    return v_flex()
      .id("deps-epic-sidebar")
      .w(260)
      .flex_none()
      .h_full()
      .min_h(0)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .child(
        h_flex()
          .flex_none()
          .h(36)
          .px(12)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Epics"))
          .child(div().text_size(11).text_color(t.dim).child(`${epics.length}`)),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("deps-epics-scroll")
              .track_scroll(this.epicsScroll)
              .size_full()
              .overflow_y_scroll()
              .p(8)
              .gap(6)
              // All issues option
              .child(
                v_flex()
                  .id("deps-epic-all")
                  .p(9)
                  .gap(5)
                  .rounded(7)
                  .border_1()
                  .border_color(this.selectedEpicId === null ? t.accent : t.border)
                  .bg(this.selectedEpicId === null ? t.selected : t.background)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.selectedEpicId = null;
                    this.chainFocusId = null;
                    cx.notify();
                  })
                  .child(
                    h_flex()
                      .justify_between()
                      .items_center()
                      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("All Issues"))
                      .child(div().text_size(11).font_family(monoFont).text_color(t.muted).child(`${closedCount}/${nonEpicCount}`)),
                  )
                  .child(this.renderProgressBar(t, "all", nonEpicCount > 0 ? Math.round((closedCount / nonEpicCount) * 100) : 0)),
              )
              .children(
                epics.map((ep) => {
                  const id = ep.id || ep.beadId;
                  const active = this.selectedEpicId === id;
                  const total = ep.counts?.total ?? ep.children?.length ?? ep.total ?? 0;
                  const done =
                    ep.counts !== undefined
                      ? (ep.counts.closed ?? 0) + (ep.counts.review ?? 0)
                      : (ep.done ?? 0);
                  const pct =
                    typeof ep.progress === "number"
                      ? Math.round(ep.progress * 100)
                      : total > 0
                        ? Math.round((done / total) * 100)
                        : ep.status === "closed"
                          ? 100
                          : 0;
                  return v_flex()
                    .id(`deps-epic-${id}`)
                    .p(9)
                    .gap(5)
                    .rounded(7)
                    .border_1()
                    .border_color(active ? t.accent : t.border)
                    .bg(active ? t.selected : t.background)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.selectedEpicId = active ? null : id;
                      this.chainFocusId = null;
                      cx.notify();
                    })
                    .child(
                      h_flex()
                        .justify_between()
                        .items_center()
                        .gap(6)
                        .child(div().text_size(10.5).font_family(monoFont).text_color(t.accent).child(id))
                        .child(div().text_size(10.5).font_family(monoFont).text_color(t.muted).child(`${done}/${total} (${pct}%)`)),
                    )
                    .child(div().text_size(12).font_medium().text_color(t.foreground).child(ep.title || id))
                    .child(this.renderProgressBar(t, id, pct));
                }),
              )
              .when(epics.length === 0, (el) =>
                el.child(div().p(8).text_size(11.5).text_color(t.dim).child("No epics found in current bd snapshot.")),
              ),
          )
          .child(Scrollbar.vertical("deps-epics-scroll").absolute().inset_0()),
      );
  }

  renderProgressBar(t, id, pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    return Progress.new(`epic-prog-${id}`)
      .value(clamped)
      .w_full()
      .child(
        ProgressTrack.new()
          .w_full()
          .h(5)
          .rounded(3)
          .bg(t.border)
          .child(ProgressIndicator.new().h_full().rounded(3).bg(clamped === 100 ? t.done : t.accent).w(`${clamped}%`)),
      );
  }

  renderWaveGraph(t, { epics, items, onSelectItem, selectedId, monoFont }) {
    const selectedEpic = this.selectedEpicId ? epics.find((e) => (e.id || e.beadId) === this.selectedEpicId) : null;
    const epicChildIds = selectedEpic
      ? new Set((selectedEpic.children ?? []).map((c) => c.beadId || c.id).filter(Boolean))
      : null;
    const scopedItems = items.filter((it) => {
      if (it.issueType === "epic") return false;
      if (this.selectedEpicId) {
        const key = it.beadId || it.id;
        const inEpic =
          it.parent === this.selectedEpicId ||
          (epicChildIds && epicChildIds.has(key)) ||
          (key && key.startsWith(`${this.selectedEpicId}.`));
        if (!inEpic) return false;
      }
      if (!this.showClosedInWaves && (it.bdStatus === "closed" || it.column === "closed")) return false;
      return true;
    });

    const { waves, blockersOf, unlocksOf } = computeWaves(scopedItems);
    const activeChainId = this.chainFocusId || (scopedItems.some((it) => (it.beadId || it.id) === selectedId) ? selectedId : null);
    const { upstream, downstream } = collectChain(activeChainId, blockersOf, unlocksOf);

    return v_flex()
      .id("deps-waves-pane")
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      // Header bar
      .child(
        h_flex()
          .flex_none()
          .h(36)
          .px(12)
          .items_center()
          .justify_between()
          .gap(10)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(
                div()
                  .text_size(12)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(selectedEpic ? `Dependency Waves · ${selectedEpic.title || selectedEpic.id}` : "Dependency Waves · All Issues"),
              )
              .child(div().text_size(11).text_color(t.dim).child(`${scopedItems.length} nodes · ${waves.length} waves`))
              .when(Boolean(activeChainId), (el) =>
                el.child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(pill(t, `Chain: ${activeChainId} (↑${upstream.size} ↓${downstream.size})`, t.accent))
                    .child(
                      div()
                        .id("deps-clear-chain")
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .text_size(10.5)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => {
                          this.chainFocusId = null;
                          cx.notify();
                        })
                        .child("Clear"),
                    ),
                ),
              ),
          )
          .child(
            div()
              .id("deps-toggle-closed")
              .px(8)
              .py(3)
              .rounded(5)
              .border_1()
              .border_color(this.showClosedInWaves ? t.accent : t.border)
              .bg(this.showClosedInWaves ? alpha(t.accent, "22") : t.raised)
              .text_size(11)
              .text_color(this.showClosedInWaves ? t.accent : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.showClosedInWaves = !this.showClosedInWaves;
                cx.notify();
              })
              .child(this.showClosedInWaves ? "Showing Closed" : "Show Closed"),
          ),
      )
      // Wave Lanes (horizontal scroll)
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            h_flex()
              .id("deps-waves-scroll")
              .track_scroll(this.wavesScroll)
              .size_full()
              .overflow_x_scroll()
              .p(10)
              .gap(10)
              .items_start()
              .when(waves.length === 0, (el) =>
                el.child(div().p(16).text_size(12.5).text_color(t.dim).child("No open dependency nodes in this scope. Toggle \"Show Closed\" to view completed items.")),
              )
              .children(
                waves.map((wave) =>
                  v_flex()
                    .id(`deps-wave-${wave.index}`)
                    .w(280)
                    .flex_none()
                    .h_full()
                    .min_h(0)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.canvas)
                    .overflow_hidden()
                    .child(
                      h_flex()
                        .flex_none()
                        .h(32)
                        .px(10)
                        .items_center()
                        .justify_between()
                        .border_b(1)
                        .border_color(t.border)
                        .bg(t.raised)
                        .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(wave.label))
                        .child(div().text_size(11).text_color(t.dim).child(`${wave.items.length}`)),
                    )
                    .child(
                      v_flex()
                        .id(`deps-wave-col-${wave.index}`)
                        .flex_1()
                        .min_h(0)
                        .overflow_y_scrollbar()
                        .p(8)
                        .gap(8)
                        .children(
                          wave.items.map((it) => {
                            const id = it.beadId || it.id;
                            const isFocused = activeChainId === id;
                            const isUpstream = upstream.has(id);
                            const isDownstream = downstream.has(id);
                            const dimmed = Boolean(activeChainId) && !isFocused && !isUpstream && !isDownstream;
                            const blockers = blockersOf.get(id) ?? [];
                            const unlocks = unlocksOf.get(id) ?? [];
                            const col = statusColor(it.agentStatus || it.column || it.status, t);

                            const borderCol = isFocused
                              ? t.accent
                              : isUpstream
                                ? t.blocked
                                : isDownstream
                                  ? t.done
                                  : t.border;

                            return v_flex()
                              .id(`deps-node-${id}`)
                              .p(9)
                              .gap(6)
                              .rounded(7)
                              .border_1()
                              .border_color(borderCol)
                              .bg(isFocused ? t.selected : t.surface)
                              .when(dimmed, (el) => el.opacity(0.42))
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => {
                                this.chainFocusId = this.chainFocusId === id ? null : id;
                                onSelectItem?.(it, cx);
                                cx.notify();
                              })
                              .child(
                                h_flex()
                                  .items_center()
                                  .justify_between()
                                  .gap(6)
                                  .child(
                                    h_flex()
                                      .items_center()
                                      .gap(5)
                                      .child(div().text_size(11).font_family(monoFont).text_color(t.accent).child(id))
                                      .when(it.priority !== undefined && it.priority !== null, (el) =>
                                        el.child(pill(t, `P${it.priority}`, it.priority <= 1 ? t.ansi1 : t.muted)),
                                      ),
                                  )
                                  .child(pill(t, it.column || it.status || "open", col)),
                              )
                              .child(div().text_size(12).font_medium().line_height("16px").text_color(t.foreground).child(it.title || id))
                              .when(isUpstream || isDownstream, (el) =>
                                el.child(
                                  div()
                                    .text_size(10.5)
                                    .font_semibold()
                                    .text_color(isUpstream ? t.blocked : t.done)
                                    .child(isUpstream ? "↑ Upstream Blocker" : "↓ Downstream Unlocked"),
                                ),
                              )
                              .when(blockers.length > 0, (el) =>
                                el.child(
                                  h_flex()
                                    .gap(4)
                                    .flex_wrap()
                                    .items_center()
                                    .child(div().text_size(10).text_color(t.dim).child("Blocked by:"))
                                    .children(
                                      blockers.map((bid) =>
                                        div()
                                          .id(`deps-blk-${id}-${bid}`)
                                          .px(5)
                                          .py(1)
                                          .rounded(4)
                                          .bg(alpha(t.blocked, "1e"))
                                          .text_size(10)
                                          .font_family(monoFont)
                                          .text_color(t.blocked)
                                          .cursor_pointer()
                                          .on_click((e, cx) => {
                                            cx.stop_propagation();
                                            this.chainFocusId = bid;
                                            const target = scopedItems.find((x) => (x.beadId || x.id) === bid);
                                            if (target) onSelectItem?.(target, cx);
                                            cx.notify();
                                          })
                                          .child(bid),
                                      ),
                                    ),
                                ),
                              )
                              .when(unlocks.length > 0, (el) =>
                                el.child(
                                  h_flex()
                                    .gap(4)
                                    .flex_wrap()
                                    .items_center()
                                    .child(div().text_size(10).text_color(t.dim).child("Unlocks:"))
                                    .children(
                                      unlocks.map((uid) =>
                                        div()
                                          .id(`deps-unl-${id}-${uid}`)
                                          .px(5)
                                          .py(1)
                                          .rounded(4)
                                          .bg(alpha(t.done, "1e"))
                                          .text_size(10)
                                          .font_family(monoFont)
                                          .text_color(t.done)
                                          .cursor_pointer()
                                          .on_click((e, cx) => {
                                            cx.stop_propagation();
                                            this.chainFocusId = uid;
                                            const target = scopedItems.find((x) => (x.beadId || x.id) === uid);
                                            if (target) onSelectItem?.(target, cx);
                                            cx.notify();
                                          })
                                          .child(uid),
                                      ),
                                    ),
                                ),
                              );
                          }),
                        ),
                    ),
                ),
              ),
          ),
      );
  }

  renderMirrorTable(t, mirrors, monoFont) {
    return v_flex()
      .size_full()
      .min_h(0)
      .child(
        h_flex()
          .flex_none()
          .h(32)
          .px(12)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Mirror Integrations"))
          .child(div().text_size(11).text_color(t.dim).child(`${mirrors.length} records`)),
      )
      .child(
        h_flex()
          .flex_none()
          .h(26)
          .px(12)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .text_size(10.5)
          .font_semibold()
          .text_color(t.dim)
          .child(div().w(140).flex_none().child("GROUP ID"))
          .child(div().w(130).flex_none().child("TARGET BRANCH"))
          .child(div().w(90).flex_none().child("STATUS"))
          .child(div().w(90).flex_none().child("COMMIT"))
          .child(div().flex_1().min_w(0).child("DETAIL")),
      )
      .child(
        v_flex()
          .id("deps-mirror-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(mirrors.length === 0, (el) =>
            el.child(div().p(12).text_size(12).text_color(t.dim).child("No mirror integration runs recorded.")),
          )
          .children(
            mirrors.map((m, idx) => {
              const groupId = m.group_id ?? m.GroupID ?? "-";
              const branch = m.target_branch ?? m.TargetBranch ?? "-";
              const status = m.status ?? m.Status ?? "-";
              const sha = m.commit_sha ?? m.CommitSHA ?? "";
              const detail = m.detail ?? m.Detail ?? "";
              return h_flex()
                .id(`mirror-row-${groupId}-${idx}`)
                .flex_none()
                .min_h(30)
                .px(12)
                .py(5)
                .gap(10)
                .items_center()
                .border_b(1)
                .border_color(t.border)
                .text_size(11.5)
                .child(div().w(140).flex_none().truncate().font_family(monoFont).text_color(t.foreground).child(groupId))
                .child(div().w(130).flex_none().truncate().font_family(monoFont).text_color(t.muted).child(branch))
                .child(div().w(90).flex_none().child(pill(t, status, statusColor(status, t))))
                .child(div().w(90).flex_none().truncate().font_family(monoFont).text_color(t.accent).child(sha ? sha.slice(0, 8) : "-"))
                .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(detail || "-"));
            }),
          ),
      );
  }

  renderMirrorAndEvents(t, { queue, mirrors, events, onSelectItem, monoFont }, _cx) {
    const q = this.eventFilter.trim().toLowerCase();
    const filteredEvents = events.filter((ev) => {
      if (!q) return true;
      const hay = `${ev.task_id ?? ""} ${ev.step_id ?? ""} ${ev.from ?? ""} ${ev.to ?? ""} ${ev.kind ?? ""} ${ev.detail ?? ""} ${ev.message ?? ""}`.toLowerCase();
      return hay.includes(q);
    });

    return v_flex()
      .id("mirror-events-root")
      .size_full()
      .min_h(0)
      .gap(8)
      .child(
        v_flex()
          .flex_none()
          .max_h(230)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.surface)
          .overflow_hidden()
          .child(this.renderMirrorTable(t, mirrors, monoFont)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.surface)
          .overflow_hidden()
          .child(
            h_flex()
              .flex_none()
              .h(40)
              .px(12)
              .gap(10)
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color(t.border)
              .bg(t.chrome)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Recent Events"))
                  .child(div().text_size(11).text_color(t.dim).child(`${filteredEvents.length}/${events.length}`)),
              )
              .child(
                Input.new(this.eventFilterInput)
                  .w(280)
                  .h(26)
                  .px(8)
                  .rounded(6)
                  .border_1()
                  .border_color(this.eventInputFocused ? t.accent : t.input)
                  .bg(t.background)
                  .text_size(11.5)
                  .text_color(t.foreground),
              ),
          )
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("mirror-events-scroll")
                  .track_scroll(this.eventsScroll)
                  .size_full()
                  .overflow_y_scroll()
                  .p(8)
                  .gap(4)
                  .when(filteredEvents.length === 0, (el) =>
                    el.child(div().p(12).text_size(12).text_color(t.dim).child("No matching events.")),
                  )
                  .children(
                    filteredEvents.map((ev, idx) => {
                      const taskId = ev.task_id ?? ev.TaskID ?? "";
                      const stepId = ev.step_id ?? ev.StepID ?? "";
                      const from = ev.from ?? ev.From ?? "";
                      const to = ev.to ?? ev.To ?? "";
                      const kind =
                        ev.kind ??
                        ev.Kind ??
                        (from && to ? `${from} -> ${to}` : to || from || "event");
                      const statusKey = ev.kind ?? ev.Kind ?? to ?? from ?? "event";
                      const detail = ev.detail ?? ev.Detail ?? ev.message ?? "";
                      const linkedItem =
                        (queue?.items ?? []).find((it) => it.taskId === taskId || it.id === taskId || it.beadId === taskId) ?? null;

                      return h_flex()
                        .id(`global-ev-${ev.id ?? idx}`)
                        .flex_none()
                        .min_h(28)
                        .px(10)
                        .py(5)
                        .gap(10)
                        .items_center()
                        .rounded(6)
                        .when(Boolean(linkedItem), (el) =>
                          el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onSelectItem?.(linkedItem, cx)),
                        )
                        .child(div().w(115).flex_none().font_family(monoFont).text_size(11).text_color(t.dim).child(formatTimestamp(ev.created_at ?? ev.CreatedAt)))
                        .child(div().w(120).flex_none().truncate().font_family(monoFont).text_size(11).text_color(t.accent).child(taskId || "-"))
                        .child(div().w(95).flex_none().truncate().font_family(monoFont).text_size(11).text_color(t.muted).child(stepId || "-"))
                        .child(div().w(135).flex_none().child(pill(t, kind, statusColor(statusKey, t))))
                        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(String(detail || "")));
                    }),
                  ),
              )
              .child(Scrollbar.vertical("mirror-events-scroll").absolute().inset_0()),
          ),
      );
  }
}
