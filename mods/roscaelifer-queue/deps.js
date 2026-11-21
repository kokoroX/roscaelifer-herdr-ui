import { div, list } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Checkbox,
  Input,
  InputState,
  Progress,
  ProgressIndicator,
  ProgressTrack,
  ScrollHandle,
  Scrollbar,
} from "gpui-base";
import { settings, theme } from "herdr";
import { createColumnScrollLock } from "./scroll-lock.js";
import { renderProjectFilterPills } from "./board.js";

const alpha = (c, aa) => (typeof c === "string" && c.length === 7 ? c + aa : c);

/** Event streams longer than this become a virtual list. */
const EVENT_VIRTUALIZE_THRESHOLD = 30;

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
      return t.idle;
    case "queue":
    case "queued":
      return t.accent;
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
      const priority = (ia?.priority ?? 9) - (ib?.priority ?? 9);
      if (priority !== 0) return priority;
      return a < b ? -1 : a > b ? 1 : 0;
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

/**
 * Single source of truth for an epic's child counts. Both the sidebar filter
 * and the rendered rows read from here so the two never disagree.
 * Returns { total, done, pct }.
 */
function getEpicStats(ep) {
  const total = ep?.counts?.total ?? ep?.children?.length ?? ep?.total ?? 0;
  const done =
    ep?.counts !== undefined ? (ep.counts.closed ?? 0) + (ep.counts.review ?? 0) : (ep?.done ?? 0);
  const pct =
    typeof ep?.progress === "number"
      ? Math.round(ep.progress * 100)
      : total > 0
        ? Math.round((done / total) * 100)
        : ep?.status === "closed"
          ? 100
          : 0;
  return { total, done, pct };
}

function isEpicDone(ep) {
  if (ep?.status === "closed") return true;
  const { total, done } = getEpicStats(ep);
  return total > 0 && done >= total;
}

/**
 * Sidebar visibility rule: completed epics are hidden unless "Show Done" is on,
 * childless epics are hidden unless "Show 0" is on.
 */
function isEpicVisible(ep, { showDone, showEmpty }) {
  if (isEpicDone(ep)) return showDone;
  if (getEpicStats(ep).total <= 0) return showEmpty;
  return true;
}

/** Shared compact checkbox used by the epic sidebar filter bar. */
function renderFilterCheckbox(id, label, checked, onChange, t) {
  return Checkbox.new(id)
    .checked(checked)
    .on_change((value, cx) => onChange(Boolean(value), cx))
    .flex()
    .items_center()
    .gap(6)
    .cursor_pointer()
    .child(
      div()
        .size(14)
        .rounded(4)
        .border_1()
        .border_color(checked ? t.accent : t.input)
        .bg(checked ? t.accent : t.background)
        .flex()
        .items_center()
        .justify_center()
        .text_size(10)
        .text_color(t.accent_foreground)
        .child(checked ? "✓" : ""),
    )
    .child(div().text_size(11).text_color(checked ? t.foreground : t.muted).child(label));
}

export class DepsController {
  constructor(_cx) {
    this.epicsScroll = ScrollHandle.new();
    this.eventsScroll = ScrollHandle.new();
    this.wavesScrollX = 0;
    this.wavesViewportW = 0;
    this.wavesContentW = 0;
    this._minWavesContentW = 0;
    this.selectedEpicId = null; // null = All Issues
    this.chainFocusId = null;
    this.showClosedInWaves = false;
    this.showDoneEpics = false;
    this.showEmptyEpics = false;
    this.eventFilter = "";
    this.waveBodyScrollLock = createColumnScrollLock({
      onHorizontalDelta: (rawDx, deltaCx) => this.scrollWavesBy(rawDx, deltaCx),
    });
    this.waveOuterScrollLock = createColumnScrollLock({
      onHorizontalDelta: (rawDx, deltaCx) => this.scrollWavesBy(rawDx, deltaCx),
    });
    this.handleWaveScrollWheel = this.waveBodyScrollLock;
    this.handleWavesOuterScrollWheel = (e, cx) => this.waveOuterScrollLock(e, cx);
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
    this._sidebarCache = {
      queue: null,
      showDoneEpics: null,
      showEmptyEpics: null,
      projectFilter: null,
      stats: null,
    };
    this._waveCache = {
      queue: null,
      selectedEpicId: null,
      showClosedInWaves: null,
      projectFilter: null,
      data: null,
    };
    // Multi-project waves recompute a `computeWaves` per project section; the
    // section list is cached so a horizontal scroll frame reuses it.
    this._groupedWaveCache = {
      queue: null,
      projects: null,
      selectedEpicId: null,
      showClosedInWaves: null,
      showWip: null,
      showEphemeral: null,
      projectFilter: null,
      chainFocusId: null,
      selectedId: undefined,
      data: null,
    };
  }

  maxWavesScrollX(contentW = Math.max(this.wavesContentW, this._minWavesContentW || 0)) {
    return Math.max(0, contentW - this.wavesViewportW);
  }

  clampWavesScrollX(contentW = Math.max(this.wavesContentW, this._minWavesContentW || 0)) {
    const next = Math.max(0, Math.min(this.wavesScrollX, this.maxWavesScrollX(contentW)));
    const changed = next !== this.wavesScrollX;
    this.wavesScrollX = next;
    return changed;
  }

  // `wavesScrollX` stays fractional so wheel deltas accumulate smoothly; only
  // a change of the rendered integer offset is worth a full view-tree rebuild.
  scrollWavesBy(rawDx, cx) {
    const prev = this.wavesScrollX;
    const next = Math.max(0, Math.min(prev - rawDx, this.maxWavesScrollX()));
    if (next === prev) return;
    this.wavesScrollX = next;
    if (Math.round(next) !== Math.round(prev)) cx?.notify();
  }

  getSidebarStats(queue, epics, items, projectFilter = "all") {
    const cached = this._sidebarCache;
    if (
      cached.queue === queue &&
      cached.showDoneEpics === this.showDoneEpics &&
      cached.showEmptyEpics === this.showEmptyEpics &&
      cached.projectFilter === projectFilter
    ) {
      return cached.stats;
    }
    const nonEpicCount = items.filter((it) => it.issueType !== "epic").length;
    const closedCount = items.filter(
      (it) => it.issueType !== "epic" && (it.bdStatus === "closed" || it.column === "closed"),
    ).length;
    const visibleEpics = epics.filter((ep) =>
      isEpicVisible(ep, { showDone: this.showDoneEpics, showEmpty: this.showEmptyEpics }),
    );
    const stats = { nonEpicCount, closedCount, visibleEpics };
    this._sidebarCache = {
      queue,
      showDoneEpics: this.showDoneEpics,
      showEmptyEpics: this.showEmptyEpics,
      projectFilter,
      stats,
    };
    return stats;
  }

  getWaveData(queue, epics, items, { showWip = true, showEphemeral = false, projectFilter = "all" } = {}) {
    const cached = this._waveCache;
    if (
      cached.queue === queue &&
      cached.selectedEpicId === this.selectedEpicId &&
      cached.showClosedInWaves === this.showClosedInWaves &&
      cached.showWip === showWip &&
      cached.showEphemeral === showEphemeral &&
      cached.projectFilter === projectFilter
    ) {
      return cached.data;
    }
    const selectedEpic = this.selectedEpicId
      ? epics.find((e) => (e.id || e.beadId) === this.selectedEpicId)
      : null;
    const epicChildIds = selectedEpic
      ? new Set((selectedEpic.children ?? []).map((c) => c.beadId || c.id).filter(Boolean))
      : null;
    const scopedItems = items.filter((it) => {
      if (it.issueType === "epic") return false;
      if (it.isWip) {
        if (!showWip && !(showEphemeral && it.ephemeral)) return false;
      } else if (it.ephemeral && !showEphemeral) {
        return false;
      }
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
    const waveGraph = computeWaves(scopedItems);
    const data = { selectedEpic, scopedItems, ...waveGraph };
    this._waveCache = {
      queue,
      selectedEpicId: this.selectedEpicId,
      showClosedInWaves: this.showClosedInWaves,
      showWip,
      showEphemeral,
      projectFilter,
      data,
    };
    return data;
  }

  render({ queue, snapshot, mode = "deps", onSelectItem, selectedId, showWip = true, showEphemeral = false, onToggleShowEphemeral, projects = [], projectFilter = "all", onSelectProjectFilter, countClosedStats = true, onToggleCountClosedStats }, cx) {
    const t = theme();
    const monoFont = settings()?.font_family ?? "JetBrains Mono";
    const multi = Array.isArray(projects) && projects.length > 1;
    const byProject = (list) =>
      !multi || projectFilter === "all"
        ? list
        : list.filter((entry) => !entry?.projectId || entry.projectId === projectFilter);
    const items = byProject(queue?.items ?? []);
    const epics = byProject(queue?.epics ?? []);
    const mirrors = byProject(queue?.mirrorIntegrations ?? snapshot?.mirror_integrations ?? []);
    const events = byProject(queue?.events ?? snapshot?.events ?? []);

    const projectBar = multi
      ? renderProjectFilterPills(t, {
          projects,
          projectFilter,
          onSelectProjectFilter,
          countClosedStats,
          onToggleCountClosedStats,
          idPrefix: "deps",
        })
      : null;

    if (mode === "mirror") {
      return this.renderMirrorAndEvents(t, { queue, mirrors, events, onSelectItem, monoFont, multi, projectBar }, cx);
    }

    const sidebarStats = this.getSidebarStats(queue, epics, items, projectFilter);

    return v_flex()
      .id("deps-root")
      .size_full()
      .min_h(0)
      .p(10)
      .gap(8)
      .when(Boolean(projectBar), (el) => el.child(projectBar))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .gap(8)
          .child(this.renderEpicSidebar(t, { epics, items, monoFont, stats: sidebarStats, projects, projectFilter }))
          .child(this.renderWaveGraph(t, { queue, epics, items, onSelectItem, selectedId, monoFont, showWip, showEphemeral, onToggleShowEphemeral, projects, projectFilter })),
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
            .child(this.renderMirrorTable(t, mirrors, monoFont, { multi })),
        ),
      );
  }

  /** Clears the epic selection when the active filters hide the selected epic. */
  syncEpicFilterSelection(epics) {
    if (!this.selectedEpicId) return;
    const selected = epics.find((ep) => (ep.id || ep.beadId) === this.selectedEpicId);
    const stillVisible =
      selected &&
      isEpicVisible(selected, { showDone: this.showDoneEpics, showEmpty: this.showEmptyEpics });
    if (!stillVisible) {
      this.selectedEpicId = null;
      this.chainFocusId = null;
    }
  }

  renderEpicCard(t, ep, monoFont) {
    const id = ep.id || ep.beadId;
    const active = this.selectedEpicId === id;
    const { total, done, pct } = getEpicStats(ep);
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
          .child(div().text_size(10.5).font_family(monoFont).text_color(t.accent).child(ep.rawId || id))
          .child(div().text_size(10.5).font_family(monoFont).text_color(t.muted).child(`${done}/${total} (${pct}%)`)),
      )
      .child(div().text_size(12).font_medium().text_color(t.foreground).child(ep.title || id))
      .child(this.renderProgressBar(t, id, pct));
  }

  /** In multi-project mode epics are grouped per project so DAGs never mix. */
  renderEpicGroups(t, { visibleEpics, projects, monoFont }) {
    const multi = Array.isArray(projects) && projects.length > 1;
    if (!multi) return visibleEpics.map((ep) => this.renderEpicCard(t, ep, monoFont));
    const groups = new Map(projects.map((project) => [project.id, { project, epics: [] }]));
    for (const ep of visibleEpics) {
      const key = ep.projectId || projects[0]?.id;
      if (!groups.has(key)) groups.set(key, { project: null, epics: [] });
      groups.get(key).epics.push(ep);
    }
    const out = [];
    for (const { project, epics } of groups.values()) {
      if (epics.length === 0) continue;
      out.push(
        h_flex()
          .pt(4)
          .gap(6)
          .items_center()
          .child(div().size(7).rounded(4).bg(project?.color || t.accent))
          .child(div().text_size(10.5).font_semibold().text_color(project?.color || t.muted).child(project?.name || "Other")),
      );
      for (const ep of epics) out.push(this.renderEpicCard(t, ep, monoFont));
    }
    return out;
  }

  renderEpicSidebar(t, { epics, items, monoFont, stats = null, projects = [], projectFilter = "all" }) {
    void projectFilter;
    const cachedStats = stats || this.getSidebarStats(null, epics, items);
    const { nonEpicCount, closedCount, visibleEpics } = cachedStats;
    const filteredCountText =
      visibleEpics.length !== epics.length ? `${visibleEpics.length}/${epics.length}` : `${epics.length}`;

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
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div().text_size(12).font_semibold().text_color(t.foreground).child("Epics"),
              )
              .child(div().text_size(11).text_color(t.dim).child(filteredCountText)),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .h(30)
          .px(12)
          .gap(14)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            renderFilterCheckbox(
              "deps-show-done-epics",
              "Show Done",
              this.showDoneEpics,
              (checked, cx) => {
                this.showDoneEpics = checked;
                this.syncEpicFilterSelection(epics);
                cx.notify();
              },
              t,
            ),
          )
          .child(
            renderFilterCheckbox(
              "deps-show-empty-epics",
              "Show 0",
              this.showEmptyEpics,
              (checked, cx) => {
                this.showEmptyEpics = checked;
                this.syncEpicFilterSelection(epics);
                cx.notify();
              },
              t,
            ),
          ),
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
              .children(this.renderEpicGroups(t, { visibleEpics, projects, monoFont }))
              .when(visibleEpics.length === 0 && epics.length > 0, (el) =>
                el.child(
                  div()
                    .p(8)
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child('No active epics. Toggle "Show Done" or "Show 0" above.'),
                ),
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

  projectGroups(projects, items, projectFilter) {
    if (!Array.isArray(projects) || projects.length < 2) {
      return [{ id: null, project: null, items }];
    }
    const active =
      projectFilter && projectFilter !== "all"
        ? projects.filter((project) => project.id === projectFilter)
        : projects;
    return active.map((project) => ({
      id: project.id,
      project,
      items: items.filter((item) => item.projectId === project.id),
    }));
  }

  scopeItems(items, epics, selectedEpic, { showWip = true, showEphemeral = false } = {}) {
    void epics;
    const epicChildIds = selectedEpic
      ? new Set((selectedEpic.children ?? []).map((child) => child.id || child.beadId).filter(Boolean))
      : null;
    return items.filter((it) => {
      if (it.issueType === "epic") return false;
      if (it.isWip) {
        if (!showWip && !(showEphemeral && it.ephemeral)) return false;
      } else if (it.ephemeral && !showEphemeral) {
        return false;
      }
      if (selectedEpic) {
        const key = it.id || it.beadId;
        const inEpic =
          it.parent === selectedEpic.rawId ||
          it.parent === selectedEpic.id ||
          (epicChildIds && epicChildIds.has(key)) ||
          (it.rawId && it.rawId.startsWith(`${selectedEpic.rawId}.`));
        if (!inEpic) return false;
      }
      if (!this.showClosedInWaves && (it.bdStatus === "closed" || it.column === "closed")) return false;
      return true;
    });
  }

  renderWaveNode(t, it, { activeChainId, upstream, downstream, blockersOf, unlocksOf, scopedItems, onSelectItem, monoFont }) {
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
    const jumpTo = (targetId, cx) => {
      this.chainFocusId = targetId;
      const target = scopedItems.find((x) => (x.beadId || x.id) === targetId);
      if (target) onSelectItem?.(target, cx);
      cx.notify();
    };

    return v_flex()
      .id(`deps-node-${it.id}`)
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
              .child(div().text_size(11).font_family(monoFont).text_color(it.projectColor || t.accent).child(it.rawId || id))
              .when(Boolean(it.projectName), (el) => el.child(pill(t, it.projectName, it.projectColor || t.accent)))
              .when(Boolean(it.isWip), (el) => el.child(pill(t, "WIP", t.working || t.accent)))
              .when(Boolean(it.ephemeral && !it.isWip), (el) => el.child(pill(t, "ephemeral", t.ansi3 || t.accent)))
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
                  .id(`deps-blk-${it.id}-${bid}`)
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
                    jumpTo(bid, cx);
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
                  .id(`deps-unl-${it.id}-${uid}`)
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
                    jumpTo(uid, cx);
                  })
                  .child(uid),
              ),
            ),
        ),
      );
  }

  renderWaveToggles(t, { showEphemeral, onToggleShowEphemeral }) {
    return h_flex()
      .gap(6)
      .items_center()
      .child(
        div()
          .id("deps-toggle-ephemeral")
          .px(8)
          .py(3)
          .rounded(5)
          .border_1()
          .border_color(showEphemeral ? t.accent : t.border)
          .bg(showEphemeral ? alpha(t.accent, "22") : t.raised)
          .text_size(11)
          .text_color(showEphemeral ? t.accent : t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, clickCx) => {
            onToggleShowEphemeral?.(!showEphemeral, clickCx);
          })
          .child(showEphemeral ? "Showing Ephemeral" : "Show Ephemeral"),
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
      );
  }

  /**
   * Topological lanes for every project section, cached by the inputs that
   * define them. Scrolling horizontally only changes `wavesScrollX`, so the
   * cache turns those frames back into a pure re-layout.
   */
  getGroupedWaveSections(queue, epics, groups, projects, { showWip, showEphemeral, projectFilter, selectedId }) {
    const cached = this._groupedWaveCache;
    if (
      cached.queue === queue &&
      cached.projects === projects &&
      cached.selectedEpicId === this.selectedEpicId &&
      cached.showClosedInWaves === this.showClosedInWaves &&
      cached.showWip === showWip &&
      cached.showEphemeral === showEphemeral &&
      cached.projectFilter === projectFilter &&
      cached.chainFocusId === this.chainFocusId &&
      cached.selectedId === selectedId
    ) {
      return cached.data;
    }
    const selectedEpic = this.selectedEpicId
      ? epics.find((epic) => (epic.id || epic.beadId) === this.selectedEpicId)
      : null;
    const sections = groups.map((group) => {
      const scopedItems = this.scopeItems(group.items, epics, selectedEpic, { showWip, showEphemeral });
      const graph = computeWaves(scopedItems);
      const activeChainId =
        this.chainFocusId ||
        (scopedItems.some((it) => (it.beadId || it.id) === selectedId) ? selectedId : null);
      const chain = collectChain(activeChainId, graph.blockersOf, graph.unlocksOf);
      return {
        group,
        scopedItems,
        waves: graph.waves,
        blockersOf: graph.blockersOf,
        unlocksOf: graph.unlocksOf,
        activeChainId,
        upstream: chain.upstream,
        downstream: chain.downstream,
      };
    });
    const data = {
      sections,
      totalNodes: sections.reduce((sum, section) => sum + section.scopedItems.length, 0),
      totalWaves: sections.reduce((sum, section) => sum + section.waves.length, 0),
    };
    this._groupedWaveCache = {
      queue,
      projects,
      selectedEpicId: this.selectedEpicId,
      showClosedInWaves: this.showClosedInWaves,
      showWip,
      showEphemeral,
      projectFilter,
      chainFocusId: this.chainFocusId,
      selectedId,
      data,
    };
    return data;
  }

  /** Multi-project deps graph: one section per project, so blocks DAGs never mix. */
  renderGroupedWaves(t, { queue, epics, groups, projects, onSelectItem, selectedId, monoFont, showWip, showEphemeral, onToggleShowEphemeral, projectFilter = "all" }) {
    const selectedEpic = this.selectedEpicId
      ? epics.find((epic) => (epic.id || epic.beadId) === this.selectedEpicId)
      : null;
    const { sections, totalNodes, totalWaves } = this.getGroupedWaveSections(queue, epics, groups, projects, {
      showWip,
      showEphemeral,
      projectFilter,
      selectedId,
    });

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
                  .child(
                    selectedEpic
                      ? `Dependency Waves · ${selectedEpic.title || selectedEpic.rawId}`
                      : "Dependency Waves · All Projects",
                  ),
              )
              .child(div().text_size(11).text_color(t.dim).child(`${totalNodes} nodes · ${totalWaves} waves · ${groups.length} projects`)),
          )
          .child(this.renderWaveToggles(t, { showEphemeral, onToggleShowEphemeral })),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("deps-waves-scroll")
              .size_full()
              .overflow_y_scroll()
              .p(10)
              .gap(12)
              .when(totalNodes === 0, (el) =>
                el.child(
                  div()
                    .p(16)
                    .text_size(12.5)
                    .text_color(t.dim)
                    .child('No open dependency nodes in this scope. Toggle "Show Closed" to view completed items.'),
                ),
              )
              .children(
                sections.map((section) =>
                  v_flex()
                    .id(`deps-project-${section.group.id || "all"}`)
                    .gap(8)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.canvas)
                    .p(10)
                    .child(
                      h_flex()
                        .items_center()
                        .gap(6)
                        .child(div().size(8).rounded(4).bg(section.group.project?.color || t.accent))
                        .child(
                          div()
                            .text_size(12)
                            .font_semibold()
                            .text_color(t.foreground)
                            .child(section.group.project?.name || "All Projects"),
                        )
                        .child(
                          div()
                            .text_size(11)
                            .text_color(t.dim)
                            .child(`${section.scopedItems.length} nodes · ${section.waves.length} waves`),
                        )
                        .when(Boolean(section.activeChainId), (el) =>
                          el.child(
                            pill(
                              t,
                              `Chain: ${section.activeChainId} (↑${section.upstream.size} ↓${section.downstream.size})`,
                              t.accent,
                            ),
                          ),
                        ),
                    )
                    .when(section.scopedItems.length === 0, (el) =>
                      el.child(div().text_size(11.5).text_color(t.dim).child("No open items for this project.")),
                    )
                    .children(
                      section.waves.map((wave) =>
                        v_flex()
                          .gap(6)
                          .child(
                            h_flex()
                              .items_center()
                              .gap(6)
                              .child(div().text_size(11).font_semibold().text_color(t.muted).child(wave.label))
                              .child(div().text_size(10.5).text_color(t.dim).child(`${wave.items.length}`)),
                          )
                          .child(
                            h_flex()
                              .flex_wrap()
                              .gap(8)
                              .items_start()
                              .children(
                                wave.items.map((it) =>
                                  div().w(280).flex_none().child(
                                    this.renderWaveNode(t, it, {
                                      activeChainId: section.activeChainId,
                                      upstream: section.upstream,
                                      downstream: section.downstream,
                                      blockersOf: section.blockersOf,
                                      unlocksOf: section.unlocksOf,
                                      scopedItems: section.scopedItems,
                                      onSelectItem,
                                      monoFont,
                                    }),
                                  ),
                                ),
                              ),
                          ),
                      ),
                    ),
                ),
              ),
          )
          .child(Scrollbar.vertical("deps-waves-scroll").absolute().inset_0()),
      );
  }

  renderWaveGraph(t, { queue, epics, items, onSelectItem, selectedId, monoFont, showWip = true, showEphemeral = false, onToggleShowEphemeral, projects = [], projectFilter = "all" }) {
    const groups = this.projectGroups(projects, items, projectFilter);
    if (groups.length > 1) {
      return this.renderGroupedWaves(t, {
        queue,
        epics,
        groups,
        projects,
        onSelectItem,
        selectedId,
        monoFont,
        showWip,
        showEphemeral,
        onToggleShowEphemeral,
        projectFilter,
      });
    }
    const { selectedEpic, scopedItems, waves, blockersOf, unlocksOf } = this.getWaveData(queue, epics, items, { showWip, showEphemeral, projectFilter });
    const minContentW = waves.length > 0 ? waves.length * 280 + (waves.length - 1) * 10 + 20 : 0;
    this._minWavesContentW = minContentW;
    this.clampWavesScrollX(minContentW);
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
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .id("deps-toggle-ephemeral")
                  .px(8)
                  .py(3)
                  .rounded(5)
                  .border_1()
                  .border_color(showEphemeral ? t.accent : t.border)
                  .bg(showEphemeral ? alpha(t.accent, "22") : t.raised)
                  .text_size(11)
                  .text_color(showEphemeral ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, clickCx) => {
                    onToggleShowEphemeral?.(!showEphemeral, clickCx);
                  })
                  .child(showEphemeral ? "Showing Ephemeral" : "Show Ephemeral"),
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
      )
      // Wave Lanes (horizontal scroll)
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            div()
              .id("deps-waves-scroll")
              .size_full()
              .overflow_hidden()
              .on_size_change((size, sizeCx) => {
                const zoom = settings()?.zoom || 1;
                this.wavesViewportW = size.width / zoom;
                if (this.clampWavesScrollX()) sizeCx?.notify();
              })
              .on_scroll_wheel((e, scrollCx) => this.handleWavesOuterScrollWheel(e, scrollCx))
              .child(
                h_flex()
                  .id("deps-waves-track")
                  .h_full()
                  .min_h(0)
                  .w_full()
                  .min_w(minContentW)
                  .ml(-Math.round(this.wavesScrollX))
                  .on_size_change((size, sizeCx) => {
                    const zoom = settings()?.zoom || 1;
                    this.wavesContentW = size.width / zoom;
                    if (this.clampWavesScrollX()) sizeCx?.notify();
                  })
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
                      div()
                        .relative()
                        .flex_1()
                        .min_h(0)
                        .on_scroll_wheel((_e, cx) => {
                          if (!this.waveBodyScrollLock.isHorizontal()) cx?.stop_propagation();
                        })
                        .child(
                          v_flex()
                            .id(`deps-wave-col-${wave.index}`)
                            .size_full()
                            .overflow_y_scrollbar()
                            .p(8)
                            .gap(8)
                            .children(
                          wave.items.map((it) =>
                            this.renderWaveNode(t, it, {
                              activeChainId,
                              upstream,
                              downstream,
                              blockersOf,
                              unlocksOf,
                              scopedItems,
                              onSelectItem,
                              monoFont,
                            }),
                          ),
                            ),
                        )
                        .child(
                          div()
                            .id(`deps-wave-guard-${wave.index}`)
                            .absolute()
                            .inset_0()
                            .on_scroll_wheel(this.handleWaveScrollWheel),
                        ),
                      ),
                    ),
                ),
              ),
            ),
      );
  }

  renderMirrorTable(t, mirrors, monoFont, { multi = false } = {}) {
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
          .when(multi, (el) => el.child(div().w(110).flex_none().child("PROJECT")))
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
                .id(`mirror-row-${m.projectId || "p"}-${groupId}-${idx}`)
                .flex_none()
                .min_h(30)
                .px(12)
                .py(5)
                .gap(10)
                .items_center()
                .when(multi, (el) =>
                  el.child(
                    div()
                      .w(110)
                      .flex_none()
                      .truncate()
                      .child(pill(t, m.projectName || "-", m.projectColor || t.accent)),
                  ),
                )
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

  renderMirrorAndEvents(t, { queue, mirrors, events, onSelectItem, monoFont, multi = false, projectBar = null }, _cx) {
    const q = this.eventFilter.trim().toLowerCase();
    const filteredEvents = events.filter((ev) => {
      if (!q) return true;
      const hay = `${ev.task_id ?? ""} ${ev.step_id ?? ""} ${ev.from ?? ""} ${ev.to ?? ""} ${ev.kind ?? ""} ${ev.detail ?? ""} ${ev.message ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
    const eventIndex = this.buildEventItemIndex(queue?.items ?? []);
    const linkedItems = filteredEvents.map((ev) =>
      this.findEventItem(eventIndex, ev.task_id ?? ev.TaskID ?? "", ev.projectId),
    );
    const virtualizeEvents = filteredEvents.length > EVENT_VIRTUALIZE_THRESHOLD;

    return v_flex()
      .id("mirror-events-root")
      .size_full()
      .min_h(0)
      .p(10)
      .gap(8)
      .when(Boolean(projectBar), (el) => el.child(projectBar))
      .child(
        v_flex()
          .flex_none()
          .max_h(230)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.surface)
          .overflow_hidden()
          .child(this.renderMirrorTable(t, mirrors, monoFont, { multi })),
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
                virtualizeEvents
                  ? list(
                      "mirror-events-scroll",
                      filteredEvents.length,
                      (i) => String(i),
                      (i, rowCx) => {
                        void rowCx;
                        return div()
                          .w_full()
                          .px(8)
                          .pt(i === 0 ? 8 : 0)
                          .pb(4)
                          .child(
                            this.renderEventRow(
                              t,
                              filteredEvents[i],
                              linkedItems[i],
                              i,
                              monoFont,
                              { interactive: false },
                            ),
                          );
                      },
                    )
                      .size_full()
                      .on_item_click((key, clickCx) => {
                        const target = linkedItems[Number(key)];
                        if (target) onSelectItem?.(target, clickCx);
                      })
                  : v_flex()
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
                        filteredEvents.map((ev, idx) =>
                          this.renderEventRow(t, ev, linkedItems[idx], idx, monoFont, { onSelectItem }),
                        ),
                      ),
              )
              .child(Scrollbar.vertical("mirror-events-scroll").absolute().inset_0()),
          ),
      );
  }

  /**
   * O(1) event → item lookup. Each event row used to run
   * `queue.items.find(...)` over 1,800+ merged items, which is what made the
   * long event stream expensive to scroll.
   */
  buildEventItemIndex(items = []) {
    const byProjectAndKey = new Map();
    const byKey = new Map();
    for (const it of items) {
      for (const raw of [it.taskId, it.id, it.rawId, it.beadId]) {
        if (raw === undefined || raw === null || raw === "") continue;
        const key = String(raw);
        const composite = `${it.projectId ?? ""}\u0000${key}`;
        if (!byProjectAndKey.has(composite)) byProjectAndKey.set(composite, it);
        if (!byKey.has(key)) byKey.set(key, it);
      }
    }
    return { byProjectAndKey, byKey };
  }

  findEventItem(index, taskId, projectId) {
    if (taskId === undefined || taskId === null || taskId === "") return null;
    const key = String(taskId);
    if (projectId) return index.byProjectAndKey.get(`${projectId}\u0000${key}`) ?? null;
    return index.byKey.get(key) ?? null;
  }

  renderEventRow(t, ev, linkedItem, idx, monoFont, { interactive = true, onSelectItem = null } = {}) {
    const taskId = ev.task_id ?? ev.TaskID ?? "";
    const stepId = ev.step_id ?? ev.StepID ?? "";
    const from = ev.from ?? ev.From ?? "";
    const to = ev.to ?? ev.To ?? "";
    const kind =
      ev.kind ?? ev.Kind ?? (from && to ? `${from} -> ${to}` : to || from || "event");
    const statusKey = ev.kind ?? ev.Kind ?? to ?? from ?? "event";
    const detail = ev.detail ?? ev.Detail ?? ev.message ?? "";

    return h_flex()
      .when(interactive, (el) => el.id(`global-ev-${ev.projectId || "p"}-${ev.id ?? idx}`))
      .flex_none()
      .min_h(28)
      .px(10)
      .py(5)
      .gap(10)
      .items_center()
      .rounded(6)
      .when(interactive && Boolean(linkedItem), (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => onSelectItem?.(linkedItem, cx)),
      )
      .when(Boolean(ev.projectName), (el) =>
        el.child(pill(t, ev.projectName, ev.projectColor || t.accent)),
      )
      .child(div().w(115).flex_none().font_family(monoFont).text_size(11).text_color(t.dim).child(formatTimestamp(ev.created_at ?? ev.CreatedAt)))
      .child(div().w(120).flex_none().truncate().font_family(monoFont).text_size(11).text_color(t.accent).child(taskId || "-"))
      .child(div().w(95).flex_none().truncate().font_family(monoFont).text_size(11).text_color(t.muted).child(stepId || "-"))
      .child(div().w(135).flex_none().child(pill(t, kind, statusColor(statusKey, t))))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(String(detail || "")));
  }
}
