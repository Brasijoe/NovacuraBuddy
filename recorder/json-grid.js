/* ============================================================
   JSON-Grid Interactive Component
   ============================================================ */
(function (global) {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function makePrimitive(val) {
    const s = document.createElement("span");
    if (val === null) { s.className = "jg-null"; s.textContent = "null"; }
    else if (typeof val === "string") { s.className = "jg-str"; s.textContent = `"${val}"`; }
    else if (typeof val === "number") { s.className = "jg-num"; s.textContent = String(val); }
    else if (typeof val === "boolean") { s.className = "jg-bool"; s.textContent = String(val); }
    else { s.className = "jg-other"; s.textContent = String(val); }
    return s;
  }

  function getBadge(v) {
    const b = document.createElement("span");
    b.className = "jg-badge";
    if (Array.isArray(v)) {
      b.textContent = `${v.length} item${v.length === 1 ? '' : 's'}`;
    } else if (isObject(v)) {
      b.textContent = `${Object.keys(v).length} keys`;
    }
    return b;
  }

  function createNode(val, depth) {
    const wrapper = document.createElement("div");
    wrapper.className = "jg-node";

    const header = document.createElement("div");
    header.className = "jg-head";

    const caret = document.createElement("span");
    caret.className = "jg-caret";

    const label = document.createElement("span");
    label.className = "jg-type-label";
    label.textContent = Array.isArray(val) ? "Array" : "Object";

    header.append(caret, label, getBadge(val));

    const body = document.createElement("div");
    body.className = "jg-body";
    body.appendChild(buildStructure(val, depth));

    let isOpen = depth < 1;
    const renderState = () => {
      body.style.display = isOpen ? "block" : "none";
      caret.innerHTML = isOpen
        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
      header.classList.toggle("collapsed", !isOpen);
    };

    header.onclick = (e) => {
      e.stopPropagation();
      isOpen = !isOpen;
      renderState();
    };

    renderState();
    wrapper.append(header, body);
    return wrapper;
  }

  function buildCell(val, depth) {
    if (val === undefined) {
      const s = document.createElement("span");
      s.className = "jg-null"; s.textContent = "—";
      return s;
    }
    if (val === null || typeof val !== "object") return makePrimitive(val);
    if (Array.isArray(val) && val.length === 0) {
      const s = document.createElement("span"); s.className = "jg-empty"; s.textContent = "[]"; return s;
    }
    if (isObject(val) && Object.keys(val).length === 0) {
      const s = document.createElement("span"); s.className = "jg-empty"; s.textContent = "{}"; return s;
    }
    return createNode(val, depth + 1);
  }

  function buildStructure(data, depth) {
    // Array of Objects -> Grid Table with sticky columns
    if (Array.isArray(data)) {
      const allObjects = data.length > 0 && data.every(isObject);
      const table = document.createElement("table");
      table.className = "jg-table";

      if (allObjects) {
        const columns = [];
        data.forEach(item => {
          Object.keys(item).forEach(k => {
            if (!columns.includes(k)) columns.push(k);
          });
        });

        const thead = table.createTHead().insertRow();
        const thIndex = document.createElement("th");
        thIndex.className = "jg-idx-col";
        thIndex.textContent = "#";
        thead.appendChild(thIndex);

        columns.forEach(c => {
          const th = document.createElement("th");
          th.textContent = c;
          thead.appendChild(th);
        });

        const tbody = table.createTBody();
        data.forEach((row, i) => {
          const tr = tbody.insertRow();
          const idxCell = tr.insertCell();
          idxCell.className = "jg-idx";
          idxCell.textContent = String(i);
          columns.forEach(col => {
            const cell = tr.insertCell();
            cell.appendChild(buildCell(row[col], depth));
          });
        });
      } else {
        const thead = table.createTHead().insertRow();
        thead.innerHTML = `<th class="jg-idx-col">#</th><th>Value</th>`;
        const tbody = table.createTBody();
        data.forEach((item, i) => {
          const tr = tbody.insertRow();
          const idxCell = tr.insertCell();
          idxCell.className = "jg-idx";
          idxCell.textContent = String(i);
          tr.insertCell().appendChild(buildCell(item, depth));
        });
      }
      return table;
    }

    // Object -> Key/Value Grid
    if (isObject(data)) {
      const table = document.createElement("table");
      table.className = "jg-table jg-kv";
      const tbody = table.createTBody();
      Object.keys(data).forEach(key => {
        const tr = tbody.insertRow();
        const keyCell = tr.insertCell();
        keyCell.className = "jg-key";
        keyCell.textContent = key;
        const valCell = tr.insertCell();
        valCell.appendChild(buildCell(data[key], depth));
      });
      return table;
    }

    return makePrimitive(data);
  }

  global.jsonGrid = function (val) {
    const root = document.createElement("div");
    root.className = "jg-container";
    if (val === null || typeof val !== "object") {
      root.appendChild(makePrimitive(val));
      return root;
    }
    root.appendChild(buildStructure(val, 0));
    return root;
  };

  global.tryParseJson = function (str) {
    if (typeof str !== "string") return { ok: false };
    const trimmed = str.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (e) {
      return { ok: false };
    }
  };
})(window);