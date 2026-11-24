/* Small UI helpers shared by the Flow tabs (Commit Dependencies): an element builder, the big
 * one-line action button (icon, badge, label, arrow end) and the "can Flow deploy this" check. */

/** Tiny element builder: uiH("div", { className: "x", onclick }, child, "text", ...). */
function uiH(tag, attrs, ...children) {
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

const UI_ICONS = {
  push: '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>'
};

function uiIcon(name) {
  const span = uiH("span", { className: "lf-cta-icon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || ""}</svg>`;
  return span;
}

/** The big one-line action button: icon, optional badge, label, arrow end. */
function uiCta({ icon, label, badge, tone, title, disabled, onclick, compact }) {
  return uiH("button", { type: "button", className: `lf-cta lf-cta-${tone || icon}${compact ? " lf-cta-compact" : ""}`, title, disabled, onclick },
    uiIcon(icon),
    badge ? uiH("span", { className: "lf-cta-badge", textContent: badge }) : null,
    uiH("span", { className: "lf-cta-label", textContent: label }),
    uiH("span", { className: "lf-cta-arrow", "aria-hidden": "true" }));
}

function uiSetLabel(btn, text) {
  const label = btn.querySelector(".lf-cta-label");
  if (label) label.textContent = text; else btn.textContent = text;
}

// Flow deploys products only: flows (applications) and automations, never sub-flows (components) or modules.
const uiDeployable = (asset) => !!asset && /^(application|automation|workflow|page)$/i.test(String(asset.type || ""));
