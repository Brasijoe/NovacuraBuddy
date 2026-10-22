/* Linked Flows tab: copies of one flow in several packages, linked by a shared id in their
 * descriptions (lib/flow-links.js). Any copy can be edited and pushed to the others. The tab shows
 * the open flow's link state, a filterable list to link flows (and create linked copies in other
 * packages in the same run), every link group with a status per copy, and the push / pull
 * preview with a step diff. Reuses the Import/Export tab's chips and tree styles. */

const lf = {
  inited: false,
  orgId: null,
  itemId: null,
  hasToken: false,
  orgsLoaded: false,
  scan: null,
  statuses: {},
  statusesLoading: false,
  work: null, // the open link / push / result view
  busy: false,
  loadSeq: 0,
  page: { selGroup: null, selMember: null } // overview tab: the picked cell
};

const lfEl = (id) => document.getElementById(id);

/** Tiny element builder: lfH("div", { className: "x", onclick }, child, "text", ...). */
function lfH(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "className" || k === "textContent" || k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "title" || k === "type" || k === "name") node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// The same script runs in the side panel and in the full-tab overview (linked-flows.html).
const LF_PAGE = document.body.classList.contains("lf-page");

const LF_ICONS = {
  sync: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
  push: '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>',
  pull: '<path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  deploy: '<path d="M5 15c-1.5 1.5-2 4-2 6 2 0 4.5-.5 6-2"/><path d="M9 15l-3-3c1-4 4.5-8 12-9-1 7.5-5 11-9 12z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  expand: '<path d="M14 4h6v6"/><path d="m20 4-7 7"/><path d="M10 20H4v-6"/><path d="m4 20 7-7"/>'
};

function lfIcon(name) {
  const span = lfH("span", { className: "lf-cta-icon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LF_ICONS[name] || ""}</svg>`;
  return span;
}

/** The big one-line action button: icon, optional badge, label, arrow end. Tones: sync, push,
 *  pull, link, deploy. */
function lfCta({ icon, label, badge, tone, title, disabled, onclick, compact }) {
  const btn = lfH("button", { type: "button", className: `lf-cta lf-cta-${tone || icon}${compact ? " lf-cta-compact" : ""}`, title, disabled, onclick },
    lfIcon(icon),
    badge ? lfH("span", { className: "lf-cta-badge", textContent: badge }) : null,
    lfH("span", { className: "lf-cta-label", textContent: label }),
    lfH("span", { className: "lf-cta-arrow", "aria-hidden": "true" }));
  return btn;
}

function lfSetLabel(btn, text) {
  const label = btn.querySelector(".lf-cta-label");
  if (label) label.textContent = text; else btn.textContent = text;
}
const lfLabelOf = (btn) => (btn.querySelector(".lf-cta-label") || btn).textContent;

const LF_STATUS = {
  in_sync: ["In sync", "ok", "This copy has the latest pushed version and no own changes."],
  changed: ["Changed, not pushed", "info", "Edited here after the last push. Push it to share the change with the other copies."],
  behind: ["Behind", "info", "Another copy pushed a newer version. Pull latest is safe: this copy has no own changes."],
  conflict: ["Conflict", "warn", "Edited here, and another copy pushed in the meantime. Pull latest drops the change here; Push from here overwrites the newer version. Both show the difference first."],
  differs: ["Steps differ", "warn", "Linked with different steps and not pushed or pulled since. Push the version you want to keep, or pull another."],
  unknown: ["Unreadable", "muted", "This copy could not be read."],
  checking: ["Checking…", "muted", ""]
};

function lfStatusChip(status) {
  const [text, tone, tip] = LF_STATUS[status] || LF_STATUS.unknown;
  return ftChip(text, tone, tip);
}

const lfFlows = () => (lf.scan ? lf.scan.assets.filter((a) => a.type !== "module") : []);
const lfAsset = (id) => (lf.scan ? lf.scan.assets.find((a) => a.id === id) : null);
const lfStatusOf = (id) => (lf.statuses[id] ? lf.statuses[id].status : "checking");

function lfGroups() {
  const groups = new Map();
  for (const a of lfFlows()) {
    if (!a.tag) continue;
    if (!groups.has(a.tag.id)) groups.set(a.tag.id, []);
    groups.get(a.tag.id).push(a);
  }
  for (const list of groups.values()) list.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return groups;
}

const lfMaxRev = (members) => members.reduce((m, a) => Math.max(m, a.tag.rev), 0);

/** The Copy & link tab (linked-copy.html), with `flowId` as the source when given. */
function lfOpenCopy(flowId) {
  const q = new URLSearchParams();
  if (lf.orgId) q.set("org", lf.orgId);
  if (flowId) q.set("flow", flowId);
  chrome.tabs.create({ url: chrome.runtime.getURL(`linked-copy.html?${q}`) });
}

function lfOpenInDesigner(id) {
  chrome.tabs.create({ url: `https://build.novacura.com/admin/design/designer/organizations/${lf.orgId}/items/${id}` });
}

/** Matches when every word of the filter is in the flow's or the package's name. */
function lfMatches(filter, ...texts) {
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/* --- loading --- */

function initLinkedFlowsPanel() {
  if (lf.inited) return;
  lf.inited = true;
  const on = (id, ev, fn) => { const el = lfEl(id); if (el) el.addEventListener(ev, fn); };
  on("lfOrg", "change", () => { lf.orgId = lfEl("lfOrg").value; lfCloseWork(); lfLoad(false); });
  on("lfRescanBtn", "click", () => lfLoad(true));
  on("lfGroupFilter", "input", lfRenderGroups);
  on("lfOnlyAttention", "change", lfRenderGroups);
  const copySlot = lfEl("lfCopySlot");
  if (copySlot) {
    copySlot.append(lfCta({ icon: "link", tone: "blue", label: "Copy & link flows", title: "Pick a flow and the packages to copy or link it to, in a browser tab", onclick: () => lfOpenCopy(lf.itemId) }),
      infoTip("Opens a browser tab: pick the source flow on the left and the target packages on the right. Packages that don't have the flow get a new linked copy; packages that already have one can link it instead. You see the plan before anything is written."));
  }
  const slot = lfEl("lfOverviewSlot");
  if (slot) {
    slot.append(lfCta({ icon: "expand", tone: "blue", label: "Open overview in a tab", title: "All groups in one table, with Sync and deploy, in a browser tab",
      onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL(`linked-flows.html${lf.orgId ? `?org=${encodeURIComponent(lf.orgId)}` : ""}`) }) }),
      infoTip("Opens a bigger, calmer view of all linked groups in a browser tab: a row per flow, a column per package, Sync per group and the deploy step."));
  }
}

function lfOnShow() {
  initLinkedFlowsPanel();
  refreshLinkedFlowsState(true);
}

function lfVisible() {
  const panel = lfEl("panel-linked-flows");
  return panel && !panel.hidden;
}

/** From the 5s poll: follows the Designer tab (open flow, organisation) while the tab is shown. */
async function refreshLinkedFlowsState(first) {
  if (!lfVisible()) return;
  const ctx = await send({ type: "LF_CONTEXT" });
  if (!ctx.ok) return;
  const hint = lfEl("lfSessionHint");
  lf.hasToken = ctx.hasFlowToken;
  hint.textContent = ctx.hasFlowToken ? "" : "No Flow session yet: open Flow in a tab (or refresh the open Flow tab) and click in it once.";
  hint.hidden = !hint.textContent;
  if (!ctx.hasFlowToken) return;
  const itemChanged = ctx.itemId !== lf.itemId;
  lf.itemId = ctx.itemId;
  if (!lf.orgsLoaded) await lfFillOrgs(ctx.orgId);
  if (!lf.orgId && ctx.orgId) lf.orgId = ctx.orgId;
  if (first || !lf.scan) return lfLoad(false);
  if (itemChanged) lfRenderOpen();
}

async function lfFillOrgs(preferred) {
  const response = await send({ type: "FT_ORGS" });
  if (!response.ok) return;
  const select = lfEl("lfOrg");
  select.innerHTML = "";
  for (const o of response.orgs) select.appendChild(lfH("option", { value: o.id, textContent: o.name }));
  lf.orgsLoaded = true;
  const pick = lf.orgId || preferred;
  if (pick && response.orgs.some((o) => o.id === pick)) select.value = pick;
  lf.orgId = select.value || null;
}

async function lfLoad(force) {
  if (!lf.orgId) return;
  const seq = ++lf.loadSeq;
  const groupsEl = lfEl("lfGroups");
  if (groupsEl) {
    groupsEl.innerHTML = "";
    groupsEl.appendChild(lfH("li", { className: "ft-env-status", textContent: "Reading packages…" }));
  }
  if (typeof lcOnLoading === "function") lcOnLoading();
  const response = await sendOrShowError({ type: "LF_SCAN", orgId: lf.orgId, force }, true);
  if (seq !== lf.loadSeq) return;
  if (!response) { if (groupsEl) groupsEl.innerHTML = ""; return; }
  lf.scan = response.scan;
  lfRenderOpen();
  lfRenderGroups();
  if (typeof lcOnScan === "function") lcOnScan();
  lf.statusesLoading = true;
  const st = await send({ type: "LF_STATUSES", orgId: lf.orgId, linkIds: [] });
  if (seq !== lf.loadSeq) return;
  lf.statusesLoading = false;
  lf.statuses = st.ok ? st.statuses : {};
  lfRenderOpen();
  lfRenderGroups();
  if (typeof lcOnScan === "function") lcOnScan();
}

/* --- open flow --- */

function lfRenderOpen() {
  const box = lfEl("lfOpen");
  if (!box) return;
  box.innerHTML = "";
  box.className = "lf-strip lf-strip-quiet";
  const asset = lf.itemId ? lfAsset(lf.itemId) : null;
  if (!lf.itemId) { box.appendChild(lfH("span", { className: "api-hint", textContent: "Open a flow in the Flow Designer to see its link state here." })); return; }
  if (!lf.scan) { box.appendChild(lfH("span", { className: "api-hint", textContent: "Loading…" })); return; }
  if (!asset) { box.appendChild(lfH("span", { className: "api-hint", textContent: "The open flow is not in this organisation, or was created after the last scan. Pick its organisation or Rescan." })); return; }
  const head = lfH("div", { className: "lf-strip-title" }, ftKindIcon(asset.type), lfH("span", { className: "ft-name", textContent: asset.name }));
  box.appendChild(head);
  if (!asset.tag) {
    head.appendChild(ftChip("Not linked", "muted"));
    const same = lfFlows().filter((a) => a.id !== asset.id && a.packageId !== asset.packageId && a.name.toUpperCase() === asset.name.toUpperCase());
    box.appendChild(lfH("span", { className: "api-hint", textContent: `${asset.packageName}${same.length ? ` · a flow with this name is also in ${same.map((a) => a.packageName).join(", ")}` : ""}` }));
    box.appendChild(lfH("div", { className: "lf-cta-row" },
      lfCta({ icon: "link", tone: "blue", label: "Copy & link to packages", onclick: () => lfOpenCopy(asset.id) }),
      infoTip("Copy this flow into other packages as linked copies, and/or link flows that already exist there. You pick the packages and see the plan before anything is written.")));
    return;
  }
  const group = lfGroups().get(asset.tag.id) || [asset];
  const status = lfStatusOf(asset.id);
  head.appendChild(ftChip(`⛓ ${asset.tag.id}`, "muted", "Link id, the same in every copy"));
  box.className = "lf-strip" + (status === "conflict" || status === "differs" ? " lf-strip-warn" : "");
  box.appendChild(lfH("span", { className: "api-hint", textContent: `${asset.packageName} · linked with ${group.length - 1} other package${group.length === 2 ? "" : "s"} · rev ${asset.tag.rev} of ${lfMaxRev(group)}` }));
  box.appendChild(ftChipRow(lfStatusChip(status)));
  box.appendChild(lfMemberActions(asset, status, true));
}

/** The buttons a copy offers for its status. */
function lfMemberActions(asset, status, primary) {
  const row = lfH("div", { className: "deploy-actions lf-actions" });
  const pushTip = "Push this version to the other copies (you see the difference first)";
  const pullTip = "Replace this copy with the group's latest version (you see the difference first)";
  const push = primary
    ? lfCta({ icon: "push", label: "Push from here", title: pushTip, onclick: () => lfStartPush(asset.id, null, null) })
    : lfH("button", { textContent: "Push from here…", title: pushTip, onclick: () => lfStartPush(asset.id, null, null) });
  const pull = primary
    ? lfCta({ icon: "pull", label: "Pull latest", title: pullTip, onclick: () => lfStartPull(asset) })
    : lfH("button", { textContent: "Pull latest…", title: pullTip, onclick: () => lfStartPull(asset) });
  const ctas = primary ? lfH("div", { className: "lf-cta-stack" }) : row;
  if (status === "changed" || status === "differs") ctas.appendChild(push);
  if (status === "behind" || status === "conflict" || status === "differs") ctas.appendChild(pull);
  if (status === "conflict") ctas.appendChild(push);
  if (!primary) row.appendChild(lfH("button", { className: "btn-ghost", textContent: "Open", onclick: () => lfOpenInDesigner(asset.id) }));
  if (primary) ctas.appendChild(lfCta({ icon: "link", tone: "blue", label: "Copy to more packages", title: "Create more linked copies of this flow in other packages", onclick: () => lfOpenCopy(asset.id) }));
  row.appendChild(lfUnlinkButton(asset));
  return primary ? lfH("div", { className: "lf-browse" }, ctas.childNodes.length ? ctas : null, row) : row;
}

function lfUnlinkButton(asset) {
  const btn = lfH("button", { className: "btn-ghost", textContent: "Unlink", title: "Remove the link tag from this flow only. The flow stays as it is; the other copies stay linked." });
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to unlink";
      setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Unlink"; }, 4000);
      return;
    }
    btn.disabled = true;
    const ok = await sendOrShowError({ type: "LF_UNLINK", orgId: lf.orgId, assetId: asset.id }, true);
    if (ok) showNotice(`${asset.name} in ${asset.packageName} is no longer linked.`);
    lfLoad(true);
  });
  return btn;
}

/* --- groups overview --- */

/** What Sync does for a group: push the one copy edited since the last push, otherwise the
 *  latest version, to every other copy. null when all copies are in sync (or still checking). */
function lfSyncPlan(members) {
  const st = members.map((m) => [m, lfStatusOf(m.id)]);
  if (st.some(([, s]) => s === "checking")) return null;
  const off = st.filter(([, s]) => s !== "in_sync" && s !== "unknown");
  if (!off.length) return null;
  const edited = st.filter(([, s]) => s === "changed" || s === "differs").map(([m]) => m);
  const conflicts = st.filter(([, s]) => s === "conflict").length;
  const maxRev = lfMaxRev(members);
  const top = members.find((m) => m.tag.rev === maxRev);
  const latest = members.find((m) => top && m.id === top.tag.src) || top;
  const source = edited.length === 1 && !conflicts ? edited[0] : latest;
  const count = (s) => st.filter(([, x]) => x === s).length;
  const badge = [count("changed") ? `${count("changed")} changed` : null, count("behind") ? `${count("behind")} behind` : null,
    conflicts ? `${conflicts} conflict` : null, count("differs") ? `${count("differs")} differ` : null].filter(Boolean).join(" · ");
  return { source, badge };
}

function lfSyncButton(members, compact) {
  const sync = lfSyncPlan(members);
  if (!sync) return null;
  return lfCta({
    icon: "sync", tone: "blue", label: compact ? "Sync" : "Sync group", badge: compact ? null : sync.badge, compact,
    title: `Push the version in ${sync.source.packageName} to the other copies. You see the difference per copy and can deploy afterwards.`,
    onclick: () => lfStartPush(sync.source.id, null, null, { sync: true })
  });
}

function lfShownGroups() {
  const groups = [...lfGroups().entries()];
  const filter = lfEl("lfGroupFilter") ? lfEl("lfGroupFilter").value : "";
  const only = lfEl("lfOnlyAttention") ? lfEl("lfOnlyAttention").checked : false;
  const needs = (members) => members.some((m) => lfStatusOf(m.id) !== "in_sync" && lfStatusOf(m.id) !== "checking");
  const attention = groups.filter(([, m]) => needs(m)).length;
  if (lfEl("lfGroupCount")) lfEl("lfGroupCount").textContent = groups.length ? `${groups.length}${attention ? ` · ${attention} need attention` : ""}` : "";
  const shown = groups
    .filter(([, m]) => lfMatches(filter, m[0].name, ...m.map((a) => a.packageName)))
    .filter(([, m]) => !only || needs(m))
    .sort((a, b) => a[1][0].name.localeCompare(b[1][0].name));
  return { groups, shown };
}

const lfLatestOf = (members) => {
  const maxRev = lfMaxRev(members);
  const top = members.find((m) => m.tag.rev === maxRev);
  return members.find((m) => top && m.id === top.tag.src) || null;
};

function lfRenderGroups() {
  if (!lfEl("lfGroups")) return;
  if (LF_PAGE) return lfRenderMatrix();
  const ul = lfEl("lfGroups");
  ul.innerHTML = "";
  if (!lf.scan) return;
  const { groups, shown } = lfShownGroups();
  if (!shown.length) {
    ul.appendChild(lfH("li", { className: "ft-env-status", textContent: groups.length ? "No group matches." : "No linked flows yet. Use Copy & link flows to start a group." }));
    return;
  }
  for (const [linkId, members] of shown) {
    const maxRev = lfMaxRev(members);
    const latest = lfLatestOf(members);
    const card = lfH("div", { className: "ft-node" },
      lfH("div", { className: "ft-node-head" },
        lfH("span", { className: "ft-icon lf-icon-link", textContent: "⛓" }),
        lfH("span", { className: "ft-name", textContent: members[0].name }),
        ftChip(linkId, "muted", "Link id")),
      lfH("span", { className: "ft-kind", textContent: `${members.length} package${members.length === 1 ? "" : "s"} · rev ${maxRev}${latest ? ` from ${latest.packageName}` : ""}${lf.statusesLoading ? " · checking…" : ""}` }));
    const sync = lfSyncButton(members, false);
    if (sync) card.appendChild(sync);
    card.appendChild(lfCta({ icon: "link", tone: "blue", label: "Copy to more packages", title: "Copy this flow into more packages, linked to the group",
      onclick: () => lfOpenCopy((members.find((m) => lfStatusOf(m.id) === "in_sync") || members[0]).id) }));
    const rows = lfH("ul", {});
    for (const m of members) {
      const status = lfStatusOf(m.id);
      const node = lfH("div", { className: "ft-node lf-member" },
        lfH("div", { className: "ft-node-head" },
          lfH("span", { className: `ft-icon ft-icon-${m.packageId ? "package" : "library"}`, textContent: m.packageId ? "P" : "L" }),
          lfH("span", { className: "ft-name", textContent: m.packageName }),
          m === latest ? lfH("span", { className: "ft-kind", textContent: "latest", title: "The newest version came from this copy" }) : null,
          m.id === lf.itemId ? ftChip("open", "info") : null,
          lfStatusChip(status)));
      rows.appendChild(lfH("li", {}, node));
    }
    ul.appendChild(lfH("li", {}, card, rows));
  }
}

/* --- full-tab overview (linked-flows.html): one row per group, one column per package --- */

const LF_DOT = { in_sync: "ok", changed: "info", behind: "info", conflict: "warn", differs: "warn", unknown: "muted", checking: "muted" };

function lfRenderMatrix() {
  const root = lfEl("lfGroups");
  root.innerHTML = "";
  if (!lf.scan) return;
  const { groups, shown } = lfShownGroups();
  if (!shown.length) {
    root.appendChild(lfH("p", { className: "ft-env-status", textContent: groups.length ? "No group matches." : "No linked flows yet. Link flows from the Linked Flows tab in the side panel." }));
    return;
  }
  const pkgs = new Map();
  for (const [, members] of shown) for (const m of members) pkgs.set(m.packageId || "", m.packageName);
  const cols = [...pkgs.entries()].sort((a, b) => (a[0] !== "") - (b[0] !== "") || a[1].localeCompare(b[1]));
  const head = lfH("tr", {}, lfH("th", { className: "lf-mx-flow", textContent: "Flow" }),
    ...cols.map(([, name]) => lfH("th", { className: "lf-mx-pkg" }, lfH("span", { textContent: name, title: name }))),
    lfH("th", { className: "lf-mx-act", textContent: "" }));
  const body = lfH("tbody", {});
  for (const [linkId, members] of shown) {
    const latest = lfLatestOf(members);
    const tr = lfH("tr", { className: lf.page.selGroup === linkId ? "is-selected" : "" },
      lfH("td", { className: "lf-mx-flow" },
        lfH("strong", { textContent: members[0].name }),
        lfH("span", { className: "api-hint", textContent: `⛓ ${linkId} · rev ${lfMaxRev(members)}${latest ? ` from ${latest.packageName}` : ""}` }),
        (lfSyncPlan(members) || {}).badge ? lfH("span", { className: "lf-mx-need", textContent: lfSyncPlan(members).badge }) : null));
    for (const [pkgId] of cols) {
      const m = members.find((x) => (x.packageId || "") === pkgId);
      if (!m) { tr.appendChild(lfH("td", { className: "lf-mx-cell lf-mx-empty" }, lfH("span", { textContent: "·" }))); continue; }
      const status = lfStatusOf(m.id);
      const [text, , tip] = LF_STATUS[status] || LF_STATUS.unknown;
      const cell = lfH("button", { type: "button", className: `lf-mx-dot lf-mx-${LF_DOT[status] || "muted"}${lf.page.selMember === m.id ? " is-active" : ""}`, title: `${m.packageName}: ${text}${tip ? `. ${tip}` : ""}` },
        lfH("span", { className: "lf-mx-pip" }), lfH("span", { textContent: text }), m === latest ? lfH("span", { className: "lf-mx-latest", textContent: "latest" }) : null);
      cell.addEventListener("click", () => { lf.page.selGroup = linkId; lf.page.selMember = m.id; lfRenderMatrix(); lfRenderMemberDetail(m); });
      tr.appendChild(lfH("td", { className: "lf-mx-cell" }, cell));
    }
    tr.appendChild(lfH("td", { className: "lf-mx-act" }, lfSyncButton(members, true) || lfH("span", { className: "lf-mx-ok", textContent: lf.statusesLoading ? "Checking…" : "✓ In sync" })));
    body.appendChild(tr);
  }
  root.appendChild(lfH("div", { className: "lf-mx-wrap" }, lfH("table", { className: "lf-matrix" }, lfH("thead", {}, head), body)));
}

/** The aside of the overview: one copy, what its status means, and what it can do. */
function lfRenderMemberDetail(m) {
  const status = lfStatusOf(m.id);
  const [, , tip] = LF_STATUS[status] || LF_STATUS.unknown;
  const group = lfGroups().get(m.tag.id) || [m];
  const root = lfH("div", { className: "lf-browse" },
    lfH("div", { className: "lf-strip-title" }, ftKindIcon(m.type), lfH("span", { className: "ft-name", textContent: m.name })),
    lfH("span", { className: "api-hint", textContent: `${m.packageName} · rev ${m.tag.rev} of ${lfMaxRev(group)}` }),
    ftChipRow(lfStatusChip(status)),
    tip ? lfH("p", { className: "api-hint", textContent: tip }) : null,
    status !== "checking" ? lfMemberActions(m, status, true) : null,
    lfH("button", { className: "btn-ghost", textContent: "Open in the Designer", onclick: () => lfOpenInDesigner(m.id) }));
  lfShowWork(root, true);
}

/* --- work views --- */

function lfShowWork(node, keepWork) {
  const work = lfEl("lfWork");
  if (!keepWork && LF_PAGE) lf.page.selMember = null;
  work.innerHTML = "";
  work.appendChild(node);
  work.hidden = false;
  if (LF_PAGE) return; // the overview keeps the table next to the work view
  if (lfEl("lfBrowse")) lfEl("lfBrowse").hidden = true;
  work.scrollIntoView({ block: "start" });
}

function lfCloseWork() {
  lf.work = null;
  if (typeof lcReset === "function") return lcReset();
  if (LF_PAGE) { lf.page.selMember = null; lfPagePlaceholder(); if (lf.scan) lfRenderMatrix(); return; }
  lfEl("lfWork").hidden = true;
  lfEl("lfWork").innerHTML = "";
  if (lfEl("lfBrowse")) lfEl("lfBrowse").hidden = false;
}

function lfPagePlaceholder() {
  const work = lfEl("lfWork");
  if (!work) return;
  work.hidden = false;
  work.innerHTML = "";
  work.appendChild(lfH("div", { className: "lf-empty-aside" },
    lfIcon("sync"),
    lfH("strong", { textContent: "Pick a copy or sync a group" }),
    lfH("span", { className: "api-hint", textContent: "Click a status in the table to see that copy and what you can do with it. Sync pushes a group's newest version to all its copies, and you can deploy the result to your environments." })));
}

async function lfBusy(btn, label, action) {
  const text = lfLabelOf(btn);
  lf.busy = true;
  btn.disabled = true;
  lfSetLabel(btn, label);
  try { await action(); } finally { lf.busy = false; btn.disabled = false; lfSetLabel(btn, text); }
}

const LF_REF_LABEL = {
  own: ["its own", "info", "Uses the module or flow of the same name in this package"],
  library: ["App Library", "info", "Shared by all packages, nothing to do"],
  "copy-in": ["copied in", "ok", "Not in this package yet: a copy of the module is created there first"],
  missing: ["missing", "warn", "Not in this package. A sub-flow has to be linked or copied there first"]
};

function lfRefList(refs) {
  if (!refs || !refs.length) return lfH("span", { className: "api-hint", textContent: "Uses no modules or sub-flows." });
  const ul = lfH("ul", { className: "lf-refs" });
  for (const r of refs) {
    const [text, tone, tip] = LF_REF_LABEL[r.mode];
    ul.appendChild(lfH("li", {}, lfH("span", { className: `ft-icon ft-icon-${r.type === "module" ? "module" : "flow"}`, textContent: r.type === "module" ? "M" : "F" }), lfH("span", { className: "ft-name", textContent: r.name }), ftChip(text, tone, tip)));
  }
  return ul;
}

/** Link plan: start version, existing flows to link, packages to get a new linked copy. */
/* --- push / pull --- */

async function lfStartPull(asset) {
  const response = await sendOrShowError({ type: "LF_LATEST", orgId: lf.orgId, linkId: asset.tag.id, exceptId: asset.id }, true);
  if (!response) return;
  if (!response.latest) { showError("No other copy in this group to pull from.", true); return; }
  lfStartPush(response.latest.id, [asset.id], asset);
}

/** Push preview. `pullInto` (an asset) makes it a pull: the latest copy pushed into that one. */
async function lfStartPush(sourceId, targetIds, pullInto, opts) {
  const root = lfH("div", { className: "api-loaded" }, lfH("span", { className: "ft-env-status", textContent: "Comparing the copies…" }));
  lfShowWork(root);
  const response = await sendOrShowError({ type: "LF_PLAN_PUSH", orgId: lf.orgId, sourceId, targetIds }, true);
  if (!response) { lfCloseWork(); return; }
  const plan = response.plan;
  // The deploy choice lives only in this preview: it is never stored, so every sync asks again.
  const w = { kind: "push", plan, pullInto, sync: !!(opts && opts.sync), selected: 0, include: {}, overwrite: {}, deploy: new Set(), prodOk: false, envs: null };
  lf.work = w;
  for (const t of plan.targets) w.include[t.asset.id] = !t.blocked;
  lfRenderPush();
  lfLoadEnvironments(w);
}

/** Environments for the deploy chips, and where the group's flows are deployed now. */
async function lfLoadEnvironments(w) {
  if (!lfDeployable(lfAsset(w.plan.sourceId))) return;
  const flows = [lfAsset(w.plan.sourceId), ...w.plan.targets.map((t) => t.asset)].filter(Boolean).map((a) => ({ id: a.id, packageId: a.packageId }));
  const response = await send({ type: "LF_ENVIRONMENTS", orgId: lf.orgId, flows });
  // Development is where flows are built; Flow deploys only to the other environments.
  w.envs = response.ok ? { list: response.environments.filter((e) => e.type !== "dev"), deployed: response.deployed || {} } : { list: [], deployed: {}, error: response.error };
  if (lf.work === w) lfRenderPush();
}

/** The flows a sync commits: the copies it pushes to, and the source itself. */
const lfSyncedIds = (w) => [...(w.pullInto ? [] : [w.plan.sourceId]), ...w.plan.targets.filter((x) => w.include[x.asset.id] && !x.blocked && (!x.losesWork || w.overwrite[x.asset.id])).map((x) => x.asset.id)];

function lfRenderDeploy(w) {
  const box = lfH("div", { className: "lf-deploy" });
  box.appendChild(lfH("div", { className: "lf-label" }, lfH("h2", { textContent: "Deploy after sync" }),
    infoTip("Optional. Tick the environments that should get the new versions right after the push. Each synced copy is deployed from its own package. Nothing is remembered: every sync starts with none ticked.")));
  const src = lfAsset(w.plan.sourceId);
  if (!lfDeployable(src)) {
    box.appendChild(lfH("span", { className: "api-hint", textContent: `Only flows and automations can be deployed. ${src ? src.name : "This"} is a ${ftKind(src && src.type).label.toLowerCase()} (${src ? src.type : "unknown"}), which reaches an environment with the flows that use it.` }));
    return box;
  }
  if (!w.envs) { box.appendChild(lfH("span", { className: "api-hint", textContent: "Reading environments…" })); return box; }
  if (w.envs.error) { box.appendChild(lfH("span", { className: "api-hint", textContent: `Environments could not be read: ${w.envs.error}` })); return box; }
  if (!w.envs.list.length) { box.appendChild(lfH("span", { className: "api-hint", textContent: "This organisation has no environments to deploy to." })); return box; }
  const ids = lfSyncedIds(w);
  const chips = lfH("div", { className: "lf-env-chips" });
  for (const env of w.envs.list) {
    const on = w.deploy.has(env.id);
    const live = ids.filter((id) => (w.envs.deployed[id] || []).includes(env.id)).length;
    const chip = lfH("button", { type: "button", className: `lf-env-chip lf-env-${env.isProduction ? "prod" : env.type}${on ? " is-on" : ""}`, "aria-pressed": String(on),
      title: `${env.name} (${env.type})${live ? ` · ${live} of these flows deployed there now` : ""}` },
      lfH("span", { className: "lf-env-check", textContent: on ? "✓" : "" }),
      lfH("span", { textContent: env.name }),
      env.isProduction ? lfH("span", { className: "lf-env-tag", textContent: "PROD" }) : null,
      live ? lfH("span", { className: "lf-env-live", title: "Deployed there now" }) : null);
    chip.addEventListener("click", () => {
      if (on) w.deploy.delete(env.id); else w.deploy.add(env.id);
      if (!lfDeployProd(w).length) w.prodOk = false;
      lfRenderPush();
    });
    chips.appendChild(chip);
  }
  box.appendChild(chips);
  const prod = lfDeployProd(w);
  if (prod.length) {
    const ok = lfH("input", { type: "checkbox", checked: w.prodOk });
    ok.addEventListener("change", () => { w.prodOk = ok.checked; lfRenderPush(); });
    box.appendChild(lfH("div", { className: "lf-strip lf-strip-danger" },
      lfH("strong", { textContent: `⚠ Deploying to production: ${prod.map((e) => e.name).join(", ")}` }),
      lfH("span", { className: "api-hint", textContent: "Users there get the new versions as soon as the deploy finishes." }),
      lfH("label", { className: "api-check" }, ok, lfH("span", { textContent: `Yes, deploy to ${prod.map((e) => e.name).join(", ")}` }))));
  }
  return box;
}

// Flow deploys products only: flows (applications) and automations, never sub-flows (components) or modules.
const lfDeployable = (asset) => !!asset && /^(application|automation|workflow|page)$/i.test(String(asset.type || ""));

const lfDeployProd = (w) => (w.envs ? w.envs.list.filter((e) => e.isProduction && w.deploy.has(e.id)) : []);

function lfRenderPush() {
  const w = lf.work;
  const { plan } = w;
  const root = lfH("div", { className: "api-loaded" });
  const title = w.pullInto ? `Pull latest into ${w.pullInto.packageName}` : w.sync ? `Sync ${plan.sourceName}` : `Push ${plan.sourceName} from ${plan.sourcePackage}`;
  root.appendChild(lfH("div", { className: "api-summary" }, lfH("strong", { textContent: title }),
    lfH("span", { className: "list-count", textContent: w.pullInto ? `from ${plan.sourcePackage} (rev ${plan.maxRev}) · committed as a new version` : `${w.sync ? `from ${plan.sourcePackage} ` : ""}to ${plan.targets.length} linked flow${plan.targets.length === 1 ? "" : "s"} · becomes rev ${plan.newRev} · committed as a new version` })));
  if (!plan.targets.length) {
    root.appendChild(lfH("p", { className: "empty-state", textContent: "No other copies in this group." }));
    root.appendChild(lfH("button", { className: "btn-ghost", textContent: "Back", onclick: lfCloseWork }));
    lfShowWork(root);
    return;
  }
  // Target pills
  const pills = lfH("div", { className: "ft-chips lf-pills" });
  plan.targets.forEach((t, i) => {
    const needs = t.losesWork && !w.overwrite[t.asset.id];
    const tone = t.blocked ? "warn" : t.losesWork ? "warn" : t.sameSteps ? "ok" : "info";
    const pill = lfH("button", { type: "button", className: `ft-chip ft-chip-${tone} lf-pill${i === w.selected ? " is-active" : ""}`, textContent: `${t.asset.packageName}${needs ? " ●" : ""}` });
    pill.addEventListener("click", () => { w.selected = i; lfRenderPush(); });
    pills.appendChild(pill);
  });
  root.appendChild(lfH("div", { className: "lf-label" }, pills, infoTip("One pill per copy that gets this version. Click one to see what changes there. A dot marks a copy with changes of its own that needs your choice.")));

  const t = plan.targets[w.selected];
  const detail = lfH("div", { className: "ft-node lf-target" });
  const inc = lfH("input", { type: "checkbox", checked: !!w.include[t.asset.id], disabled: !!t.blocked });
  inc.addEventListener("change", () => { w.include[t.asset.id] = inc.checked; lfRenderPush(); });
  detail.appendChild(lfH("div", { className: "ft-node-head" }, lfH("label", { className: "api-check" }, inc, lfH("strong", { textContent: t.asset.packageName })), lfStatusChip(t.status)));
  if (t.blocked) detail.appendChild(lfH("span", { className: "ft-note ft-differs", textContent: t.blocked }));
  else if (t.sameSteps) detail.appendChild(lfH("span", { className: "api-hint", textContent: "Same steps already. Only the link tag is updated." }));
  else {
    const d = t.diff;
    detail.appendChild(ftChipRow(
      d.changed ? ftChip(`${d.changed} changed`, "warn") : null,
      d.added ? ftChip(`${d.added} added`, "ok") : null,
      d.removed ? ftChip(`${d.removed} removed`, "warn") : null,
      d.arrows ? ftChip(`${d.arrows} connection${d.arrows === 1 ? "" : "s"}`, "muted", "Arrows between steps that change") : null,
      infoTip("Steps in flow order, matched by id, or by type and name when the copies have different ids. Every setting of a step is compared: = unchanged, ~ changed, + added by this push, − removed by this push. Click a changed script step to see its lines.")));
    detail.appendChild(lfDiffList(d));
  }
  if (t.losesWork && !t.blocked) {
    const name = `lfOverwrite-${t.asset.id}`;
    const choice = (value, label) => {
      const r = lfH("input", { type: "radio", name, checked: !!w.overwrite[t.asset.id] === value });
      r.addEventListener("change", () => { w.overwrite[t.asset.id] = value; lfRenderPush(); });
      return lfH("label", { className: "api-check" }, r, lfH("span", { textContent: label }));
    };
    detail.appendChild(lfH("div", { className: "lf-strip lf-strip-warn" },
      lfH("strong", { textContent: `${t.asset.packageName} has changes of its own` }),
      lfH("span", { className: "api-hint", textContent: t.status === "behind" || t.status === "in_sync" ? "It holds a newer version than this one. Pushing replaces it." : "They are not in this version. Pushing replaces them (Undo is offered afterwards)." }),
      choice(false, `Skip ${t.asset.packageName} for now`),
      choice(true, `Overwrite ${t.asset.packageName}`)));
  }
  if (!t.blocked) {
    detail.appendChild(lfH("div", { className: "lf-label" }, lfH("h2", { textContent: `Kept in ${t.asset.packageName}` }), infoTip("Menus, the name and the package stay as they are. Modules and sub-flows are pointed at this package's own ones (same name), or at the shared App Library one.")));
    detail.appendChild(lfRefList(t.refs));
  }
  root.appendChild(detail);
  root.appendChild(lfRenderDeploy(w));

  const chosen = plan.targets.filter((x) => w.include[x.asset.id] && !x.blocked && (!x.losesWork || w.overwrite[x.asset.id]));
  const envCount = w.deploy.size;
  const blockedByProd = lfDeployProd(w).length > 0 && !w.prodOk;
  const verb = w.pullInto ? "Pull" : w.sync ? `Sync ${chosen.length} cop${chosen.length === 1 ? "y" : "ies"}` : `Push to ${chosen.length}`;
  const run = lfCta({
    icon: w.pullInto ? "pull" : w.sync ? "sync" : "push",
    label: envCount ? `${verb} & deploy` : verb,
    badge: envCount ? `${envCount} environment${envCount === 1 ? "" : "s"}` : null,
    disabled: !chosen.length || blockedByProd,
    title: blockedByProd ? "Confirm the production deploy first." : ""
  });
  run.addEventListener("click", () => lfBusy(run, w.pullInto ? "Pulling…" : envCount ? "Syncing and deploying…" : "Pushing…", lfRunPush));
  root.appendChild(lfH("div", { className: "lf-cta-row" }, run));
  root.appendChild(lfH("div", { className: "deploy-actions" }, lfH("button", { className: "btn-ghost", textContent: "Cancel", onclick: lfCloseWork })));
  lfShowWork(root);
}

function lfDiffList(d) {
  const box = lfH("div", { className: "lf-diff" });
  const marks = { same: "=", changed: "~", added: "+", removed: "−" };
  const unchanged = d.rows.filter((r) => r.change === "same").length;
  let showSame = false;
  const render = () => {
    box.innerHTML = "";
    for (const r of d.rows) {
      if (r.change === "same" && !showSame) continue;
      const row = lfH("div", { className: `lf-diff-row lf-diff-${r.change}` },
        lfH("span", { className: "lf-diff-mark", textContent: marks[r.change] }),
        lfH("span", { className: "lf-diff-label", textContent: r.label || "(no name)" }),
        lfH("span", { className: "ft-kind", textContent: r.stepType }));
      box.appendChild(row);
      if (r.script) {
        const pre = lfH("pre", { className: "lf-code", hidden: true });
        for (const l of r.script) pre.appendChild(lfH("span", { className: l.op === "+" ? "lf-add" : l.op === "-" ? "lf-del" : "", textContent: `${l.op === "=" ? " " : l.op} ${l.text}\n` }));
        row.classList.add("lf-clickable");
        row.title = "Show the script lines";
        row.addEventListener("click", () => { pre.hidden = !pre.hidden; });
        box.appendChild(pre);
      }
    }
    if (unchanged) {
      box.appendChild(lfH("button", { type: "button", className: "btn-ghost lf-diff-toggle", textContent: showSame ? "Hide unchanged steps" : `Show ${unchanged} unchanged step${unchanged === 1 ? "" : "s"}`, onclick: () => { showSame = !showSame; render(); } }));
    }
    if (!d.rows.some((r) => r.change !== "same") && !d.arrows) box.prepend(lfH("span", { className: "api-hint", textContent: "Only settings or layout differ." }));
  };
  render();
  return box;
}

async function lfRunPush() {
  const w = lf.work;
  const { plan } = w;
  const targets = plan.targets.filter((x) => w.include[x.asset.id] && !x.blocked).map((x) => ({ id: x.asset.id, overwrite: !!w.overwrite[x.asset.id] }));
  const response = await sendOrShowError({ type: "LF_PUSH", orgId: lf.orgId, sourceId: plan.sourceId, targets, expectedMaxRev: plan.maxRev, expectedSourceFp: plan.sourceFp, expectedSourceETag: plan.sourceETag }, true);
  if (!response) return;
  const o = response.outcome;
  const pushed = o.results.filter((r) => r.outcome === "pushed");
  const rows = o.results.map((r) => ({
    ...r,
    note: r.outcome === "pushed" ? [r.unchanged ? "same steps, tag updated" : "steps now match, committed", r.overwrote ? "overwrote its own changes" : null, r.copiedIn && r.copiedIn.length ? `copied in ${r.copiedIn.join(", ")}` : null].filter(Boolean).join(" · ") : r.reason
  }));
  // Deploy only what this sync committed: the pushed copies and the source.
  const envs = w.envs && lfDeployable(lfAsset(plan.sourceId)) ? w.envs.list.filter((e) => w.deploy.has(e.id)) : [];
  if (envs.length && pushed.length) {
    const ids = [...(w.pullInto ? [] : [plan.sourceId]), ...pushed.map((r) => r.id)];
    const name = (id) => { const a = lfAsset(id); return a ? a.packageName : id; };
    for (const env of envs) {
      const res = await send({ type: "LF_DEPLOY", orgId: lf.orgId, envId: env.id, assetIds: ids });
      if (!res.ok) { rows.push({ outcome: "failed", packageName: `Deploy to ${env.name}`, reason: res.error }); continue; }
      const good = res.results.filter((x) => x.ok);
      const bad = res.results.filter((x) => !x.ok);
      rows.push({
        outcome: bad.length && !good.length ? "failed" : "deployed",
        packageName: `${!good.length ? "Not deployed to" : bad.length ? `Partly deployed to` : "Deployed to"} ${env.name}${env.isProduction ? " (PROD)" : ""}`,
        note: [good.length ? `${good.map((x) => name(x.id)).join(", ")}` : null, ...bad.map((x) => `${name(x.id)}: ${x.error}`)].filter(Boolean).join(" · ")
      });
    }
  }
  if (LF_PAGE) lfLoad(true); // the table shows the new state next to the results
  lfShowResults(w.pullInto ? `Pulled rev ${plan.maxRev} from ${plan.sourcePackage}` : `${w.sync ? "Synced" : "Pushed"} ${o.sourceName} rev ${o.rev} to ${pushed.length} of ${o.results.length}`, rows);
}

/* --- results --- */

function lfShowResults(title, rows) {
  const ok = rows.some((r) => r.outcome === "pushed");
  const root = lfH("div", { className: "ft-result" },
    lfH("div", { className: ok ? "banner banner-deployed" : "banner banner-warning", textContent: title }));
  for (const r of rows) {
    const mark = r.outcome === "pushed" || r.outcome === "deployed" ? ["✓", "ok"] : r.outcome === "skipped" ? ["–", "skip"] : ["!", "fail"];
    const actions = lfH("span", { className: "lf-res-actions" });
    if (r.id && r.outcome !== "failed") actions.appendChild(lfH("button", { className: "btn-ghost", textContent: "Open", onclick: () => lfOpenInDesigner(r.id) }));
    if (r.undo) {
      const undo = lfH("button", { className: "btn-ghost", textContent: "Undo", title: "Put this copy back to what it was before the push (as a new version)" });
      undo.addEventListener("click", () => lfBusy(undo, "Undoing…", async () => {
        const res = await sendOrShowError({ type: "LF_UNDO", orgId: lf.orgId, assetId: r.id, undo: r.undo }, true);
        if (res) { r.undo = null; undo.remove(); showNotice(`${r.packageName} is back to its version before the push.`); }
      }));
      actions.appendChild(undo);
    }
    root.appendChild(lfH("div", { className: "lf-res" },
      lfH("span", { className: `lf-mark lf-mark-${mark[1]}`, textContent: mark[0] }),
      lfH("span", { className: "lf-res-text" }, lfH("strong", { textContent: r.packageName || r.name }), lfH("span", { className: "api-hint", textContent: r.note || "" })),
      actions));
  }
  root.appendChild(lfH("div", { className: "deploy-actions" }, lfH("button", { textContent: "Back to linked flows", onclick: () => { lfCloseWork(); lfLoad(true); } })));
  lf.work = { kind: "results" };
  lfShowWork(root);
}
