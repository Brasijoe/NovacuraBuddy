/** Shared search-as-you-type for every selection list in the side panel.
 *  - Every <select> becomes a combobox: the field shows the chosen option, typing filters the open
 *    list in real time (no filter button), arrows/Enter/Escape and clicks pick. The <select> stays
 *    (hidden) as the value store, so code keeps using select.value, its options and its change event.
 *    Opt out with the attribute data-plain.
 *  - Every checklist (.checklist, .pc-dd-list) with many entries gets a search field that hides the
 *    non-matching entries as you type.
 *  Both are applied automatically, also to elements created later. */
(function () {
  const LIST_MIN = 6; // checklists with fewer entries need no search field

  /** An empty-valued option ending in "…" is a "Choose…" prompt, any other one is a real choice
   *  (All packages, None). */
  function emptyIsChoice(select) {
    const empty = [...select.options].find((o) => o.value === "");
    return !!empty && !/…\s*$|\.\.\.\s*$/.test(empty.textContent.trim());
  }

  function makeSearchable(select) {
    if (select.dataset.searchable) return;
    select.dataset.searchable = "1";
    const wrap = document.createElement("div");
    wrap.className = "combo";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "combo-input";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.autocomplete = "off";
    const list = document.createElement("ul");
    list.className = "combo-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    wrap.hidden = select.hidden;
    select.before(wrap);
    wrap.append(input, list, select);
    select.hidden = true;

    let active = -1;
    let shown = [];
    const allowEmpty = () => emptyIsChoice(select);
    const label = () => {
      const o = select.selectedOptions[0];
      return o && (o.value || allowEmpty()) ? o.textContent : "";
    };
    const sync = () => {
      if (document.activeElement !== input) input.value = label();
      input.placeholder = label() || (select.options[0] ? select.options[0].textContent : "Search…");
      input.disabled = select.disabled;
    };
    const render = (query) => {
      const q = (query || "").trim().toLowerCase();
      shown = [...select.options].filter((o) => (o.value || allowEmpty()) && (!q || o.textContent.toLowerCase().includes(q)));
      list.innerHTML = "";
      if (!shown.length) {
        const li = document.createElement("li");
        li.className = "combo-empty";
        li.textContent = select.options.length > 1 ? "No match" : (select.options[0] ? select.options[0].textContent : "Nothing to choose");
        list.append(li);
      }
      shown.forEach((o, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.className = `combo-option${o.value === select.value ? " is-selected" : ""}${i === active ? " is-active" : ""}`;
        li.textContent = o.textContent;
        li.onmousedown = (e) => { e.preventDefault(); pick(o); };
        list.append(li);
      });
      const activeLi = list.children[active];
      if (activeLi) activeLi.scrollIntoView({ block: "nearest" });
    };
    const open = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); render(input.value === label() ? "" : input.value); };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; input.value = label(); };
    const pick = (o) => {
      const changed = select.value !== o.value;
      select.value = o.value;
      close();
      input.blur();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    };

    input.addEventListener("focus", () => { input.select(); open(); });
    input.addEventListener("input", () => { active = 0; list.hidden = false; render(input.value); });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) open();
        active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        render(input.value === label() ? "" : input.value);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[active >= 0 ? active : 0]) pick(shown[active >= 0 ? active : 0]);
      } else if (e.key === "Escape") {
        close();
        input.blur();
      }
    });

    // Keep the field in step with the select when code refills it or sets value / disabled.
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(select, "value", { get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); sync(); } });
    const disabledDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "disabled");
    Object.defineProperty(select, "disabled", { get() { return disabledDesc.get.call(this); }, set(v) { disabledDesc.set.call(this, v); sync(); } });
    select.addEventListener("change", sync);
    new MutationObserver(() => { sync(); if (!list.hidden) render(input.value === label() ? "" : input.value); }).observe(select, { childList: true });
    // Code hides/shows a field with select.hidden: that now hides/shows the whole combobox.
    Object.defineProperty(select, "hidden", { get() { return wrap.hidden; }, set(v) { wrap.hidden = !!v; } });
    sync();
  }

  /** Search field above a checklist: hides the entries whose text does not match, as you type. */
  function makeListSearchable(container) {
    if (container.dataset.searchable) return;
    container.dataset.searchable = "1";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "list-search";
    input.placeholder = "Search…";
    input.autocomplete = "off";
    input.hidden = true;
    container.before(input);
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      for (const item of container.children) item.hidden = !!q && !item.textContent.toLowerCase().includes(q);
    };
    const update = () => {
      input.hidden = container.children.length < LIST_MIN || container.hidden;
      apply();
    };
    input.addEventListener("input", apply);
    input.addEventListener("click", (e) => e.stopPropagation());
    new MutationObserver(update).observe(container, { childList: true });
    new MutationObserver(update).observe(container, { attributes: true, attributeFilter: ["hidden"] });
    update();
  }

  function scan(root) {
    if (!root.querySelectorAll) return;
    const selects = root.matches && root.matches("select") ? [root] : root.querySelectorAll("select");
    selects.forEach((s) => { if (!s.hasAttribute("data-plain") && !s.closest(".combo")) makeSearchable(s); });
    const lists = root.matches && root.matches(".checklist, .pc-dd-list") ? [root] : root.querySelectorAll(".checklist, .pc-dd-list");
    lists.forEach(makeListSearchable);
  }

  window.NovaCombobox = { makeSearchable, makeListSearchable, scan };
  scan(document);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
})();
