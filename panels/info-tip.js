/** Info icons: a small ⓘ that explains the thing next to it on hover, keyboard focus or click
 *  (click pins it open for touch; Escape or a click elsewhere closes it). Markup:
 *    <span class="info-tip" data-tip="What this does."></span>
 *  or infoTip("What this does.") for rows built in script. One shared bubble is positioned fixed
 *  next to the icon, so it is never clipped by a list row or a tab menu and stays inside the
 *  narrow side panel. */
const INFO_TIP_GAP = 6;
let infoTipBubble = null;
let infoTipShownFor = null;
let infoTipPinned = false;

function infoTip(text) {
  const tip = document.createElement("span");
  tip.className = "info-tip";
  tip.dataset.tip = text;
  prepareInfoTip(tip);
  return tip;
}

/** Makes an icon focusable and gives screen readers its text (static markup gets this at load). */
function prepareInfoTip(tip) {
  tip.tabIndex = 0;
  tip.setAttribute("role", "button");
  tip.setAttribute("aria-label", `Info: ${tip.dataset.tip}`);
}

function showInfoTip(tip, pinned) {
  if (!infoTipBubble) {
    infoTipBubble = document.createElement("div");
    infoTipBubble.className = "info-tip-bubble";
    infoTipBubble.setAttribute("role", "tooltip");
    document.body.appendChild(infoTipBubble);
  }
  if (infoTipShownFor && infoTipShownFor !== tip) infoTipShownFor.classList.remove("is-open");
  infoTipShownFor = tip;
  infoTipPinned = pinned;
  tip.classList.add("is-open");
  infoTipBubble.textContent = tip.dataset.tip;
  infoTipBubble.hidden = false;

  const icon = tip.getBoundingClientRect();
  const bubble = infoTipBubble.getBoundingClientRect();
  const left = Math.min(Math.max(INFO_TIP_GAP, icon.left + icon.width / 2 - bubble.width / 2), window.innerWidth - bubble.width - INFO_TIP_GAP);
  const below = icon.bottom + INFO_TIP_GAP;
  const top = below + bubble.height > window.innerHeight && icon.top - INFO_TIP_GAP - bubble.height > 0
    ? icon.top - INFO_TIP_GAP - bubble.height
    : below;
  infoTipBubble.style.left = `${Math.max(INFO_TIP_GAP, left)}px`;
  infoTipBubble.style.top = `${top}px`;
}

function hideInfoTip() {
  if (infoTipBubble) infoTipBubble.hidden = true;
  if (infoTipShownFor) infoTipShownFor.classList.remove("is-open");
  infoTipShownFor = null;
  infoTipPinned = false;
}

for (const tip of document.querySelectorAll(".info-tip")) prepareInfoTip(tip);

document.addEventListener("mouseover", (e) => {
  const tip = e.target.closest && e.target.closest(".info-tip");
  if (tip && tip !== infoTipShownFor && !infoTipPinned) showInfoTip(tip, false);
});
document.addEventListener("mouseout", (e) => {
  const tip = e.target.closest && e.target.closest(".info-tip");
  if (tip && tip === infoTipShownFor && !infoTipPinned && !tip.contains(e.relatedTarget) && document.activeElement !== tip) hideInfoTip();
});
document.addEventListener("focusin", (e) => {
  if (e.target.classList && e.target.classList.contains("info-tip")) showInfoTip(e.target, false);
});
document.addEventListener("focusout", (e) => {
  if (e.target === infoTipShownFor) hideInfoTip();
});
// Capture phase: a tip inside a <summary>, a tab menu or a clickable row only explains, it never
// also toggles the section, opens the menu or selects the row.
document.addEventListener("click", (e) => {
  const tip = e.target.closest && e.target.closest(".info-tip");
  if (!tip) { if (infoTipPinned) hideInfoTip(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (tip === infoTipShownFor && infoTipPinned) hideInfoTip();
  else showInfoTip(tip, true);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && infoTipShownFor) { hideInfoTip(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("info-tip")) {
    e.preventDefault();
    e.stopPropagation();
    if (infoTipPinned && e.target === infoTipShownFor) hideInfoTip();
    else showInfoTip(e.target, true);
  }
}, true);
window.addEventListener("scroll", hideInfoTip, true);
window.addEventListener("resize", hideInfoTip);
