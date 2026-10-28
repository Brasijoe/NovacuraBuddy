/* ============================================================
   Step Recorder model - turns what a user does in the Flow web client into numbered steps.
   One step per action (click, confirmed input, selection, switch); sub-workflow steps are numbered
   4.1, 4.2 ... under the step that started them. Sentences come from per-language templates (formal
   address, each language's own quotation marks). Pure functions only: capture happens in
   content/step-recorder.js, screenshots in background.js.
   ============================================================ */
(function (global) {
  const LANGS = ["en", "de", "fr"];
  const LANG_NAMES = { en: "English", de: "Deutsch", fr: "Français" };

  // Novacura design system defaults for generated documents (same tokens as sidepanel.css).
  const THEME = {
    colors: { accent: "#0C65F4", accentSoft: "#BED7FF", navy: "#141635", ink: "#000000", inkMuted: "#465466", surface: "#FFFFFF", surfaceRaised: "#E4E8EF" },
    fonts: { heading: 'Montserrat, Arial, sans-serif', body: 'Roboto, Arial, sans-serif' },
    titleCase: "upper", titleSuffix: "."
  };

  const TEMPLATES = {
    // A control without a name of its own: the sentence ends with the icon image, so no quotes and no full stop.
    generic: { en: "Click {button}", de: "Klicken Sie auf {button}", fr: "Cliquez sur {button}" },
    button: { en: 'Click "{button}".', de: "Klicken Sie auf „{button}“.", fr: "Cliquez sur « {button} »." },
    input: { en: 'Enter "{value}" in "{prompt}".', de: "Geben Sie „{value}“ in „{prompt}“ ein.", fr: "Saisissez « {value} » dans « {prompt} »." },
    freetext: { en: 'Enter "{prompt}".', de: "Geben Sie „{prompt}“ ein.", fr: "Saisissez « {prompt} »." },
    lov: { en: 'Select "{value}" from "{prompt}" (column "{column}").', de: "Wählen Sie „{value}“ aus „{prompt}“ (Spalte „{column}“).", fr: "Sélectionnez « {value} » dans « {prompt} » (colonne « {column} »)." },
    lovNoColumn: { en: 'Select "{value}" from "{prompt}".', de: "Wählen Sie „{value}“ aus „{prompt}“.", fr: "Sélectionnez « {value} » dans « {prompt} »." },
    list: { en: 'Select "{value}" in the list "{list}".', de: "Wählen Sie „{value}“ in der Liste „{list}“ aus.", fr: "Sélectionnez « {value} » dans la liste « {list} »." },
    multi: { en: 'Select {count} rows in "{list}".', de: "Wählen Sie {count} Zeilen in „{list}“ aus.", fr: "Sélectionnez {count} lignes dans « {list} »." },
    binary: { en: 'Set "{prompt}" to {state}.', de: "Setzen Sie „{prompt}“ auf {state}.", fr: "Réglez « {prompt} » sur {state}." },
    object: { en: 'Note "{value}".', de: "Beachten Sie „{value}“.", fr: "Notez « {value} »." },
    sub: { en: 'Open "{workflow}".', de: "Öffnen Sie „{workflow}“.", fr: "Ouvrez « {workflow} »." }
  };
  const STATES = { yes: { en: "Yes", de: "Ja", fr: "Oui" }, no: { en: "No", de: "Nein", fr: "Non" } };

  /** The sentence of a step in a language. `step.data` holds the placeholders; unknown kinds keep their own text. */
  function sentence(step, lang) {
    const l = LANGS.includes(lang) ? lang : "en";
    const d = step.data || {};
    let kind = step.kind;
    if (kind === "lov" && !d.column) kind = "lovNoColumn";
    const tpl = TEMPLATES[kind];
    if (!tpl) return step.text || "";
    const vars = { ...d };
    if (kind === "binary") vars.state = STATES[d.on ? "yes" : "no"][l];
    return tpl[l].replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));
  }

  /** Steps carry `sub` = the number of the sub-workflow they sit in (null at the top level). Numbers are derived. */
  function renumber(steps) {
    let main = 0;
    const subCount = new Map();
    for (const s of steps) {
      if (s.kind === "section") { s.number = ""; continue; }
      if (s.sub) {
        const n = (subCount.get(s.sub) || 0) + 1;
        subCount.set(s.sub, n);
        s.number = `${s.sub}.${n}`;
      } else {
        main += 1;
        s.number = String(main);
      }
    }
    // A sub-step's parent is the main step with that number; keep `sub` valid after deletions.
    return steps;
  }

  const TIMESTAMP_ID = () => "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const newId = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /** Appends a step. `sub` is the current sub-workflow's main-step number, or null. Returns the new step. */
  function addStep(steps, partial, sub) {
    const step = { id: newId(), kind: "custom", data: {}, text: "", note: "", screenshot: null, shotError: "", leads: false, marker: null, sub: sub || null, ...partial };
    step.text = step.text || sentence(step, partial.lang || "en");
    steps.push(step);
    renumber(steps);
    return step;
  }

  function removeStep(steps, id) {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 0) return steps;
    const gone = steps[i];
    handOverPage(steps, i);
    steps.splice(i, 1);
    // Deleting the step that started a sub-workflow lifts its steps back to the top level.
    for (const s of steps) if (s.sub === gone.number && !gone.sub) s.sub = null;
    return renumber(steps);
  }

  function moveStep(steps, id, delta) {
    const i = steps.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= steps.length) return steps;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    // The page screenshot belongs to the first position of its page, not to the step that was moved.
    for (const k of PAGE_FIELDS) [steps[i][k], steps[j][k]] = [steps[j][k], steps[i][k]];
    return renumber(steps);
  }

  /** Page metadata: a step with `leads` starts a page and holds its screenshot; the steps after it (up to the next lead) share it. */
  const PAGE_FIELDS = ["leads", "screenshot", "shotError"];

  /** The step at index i is going away: the next step of its page takes over the page's screenshot. */
  function handOverPage(steps, i) {
    const gone = steps[i];
    if (!gone.leads) return;
    for (let j = i + 1; j < steps.length; j++) {
      if (steps[j].kind === "section") continue;
      if (steps[j].leads) return;
      for (const k of PAGE_FIELDS) steps[j][k] = gone[k];
      return;
    }
  }

  /** Splits the steps into display runs: free text sections, and pages (a lead step plus the steps sharing its screenshot). */
  function pageRuns(steps) {
    const runs = [];
    let cur = null;
    for (const s of steps) {
      if (s.kind === "section") { runs.push({ type: "section", step: s }); cur = null; continue; }
      if (s.leads || s.screenshot || !cur) { cur = { type: "page", lead: s.leads || s.screenshot ? s : null, steps: [] }; runs.push(cur); }
      cur.steps.push(s);
    }
    return runs;
  }

  /** Moves a whole page (its lead step and followers) one page up or down. */
  function movePage(steps, leadId, delta) {
    const runs = pageRuns(steps);
    const i = runs.findIndex((r) => r.type === "page" && r.lead && r.lead.id === leadId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= runs.length) return steps;
    [runs[i], runs[j]] = [runs[j], runs[i]];
    steps.splice(0, steps.length, ...runs.flatMap((r) => (r.type === "section" ? [r.step] : r.steps)));
    return renumber(steps);
  }

  /** Makes a page's first step an ordinary step of the page before it; its screenshot is dropped. */
  function joinPreviousPage(steps, id) {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 1 || !steps[i].leads) return steps;
    const s = steps[i];
    s.leads = false; s.screenshot = null; s.shotError = "";
    return steps;
  }

  /** Crops move every marker of the page with the screenshot. */
  function cropPage(run, f) {
    for (const s of run.steps) s.marker = cropMarker(s.marker, f);
  }

  /** Merges step `id` into the one before it: sentences joined, notes joined, the earlier screenshot kept. */
  function mergeWithPrevious(steps, id) {
    const i = steps.findIndex((s) => s.id === id);
    if (i < 1) return steps;
    const prev = steps[i - 1], cur = steps[i];
    if (prev.kind === "section" || cur.kind === "section") return steps;
    prev.text = (prev.text + " " + cur.text).trim();
    prev.note = [prev.note, cur.note].filter(Boolean).join("\n");
    prev.kind = "custom";
    handOverPage(steps, i);
    steps.splice(i, 1);
    return renumber(steps);
  }

  /** Rewrites generated sentences in another language; sentences the user edited by hand (`edited`) stay. */
  function relanguage(steps, lang) {
    for (const s of steps) if (!s.edited && TEMPLATES[s.kind === "lov" && !(s.data || {}).column ? "lovNoColumn" : s.kind]) s.text = sentence(s, lang);
    return steps;
  }

  /** Headings the web client shows on every page ("Info") say nothing about the page and are left out of documents. */
  const GENERIC_HEADINGS = new Set(["info", "information", "informationen"]);
  const cleanScreen = (t) => (GENERIC_HEADINGS.has(String(t || "").trim().toLowerCase()) ? "" : String(t || ""));

  /** The heading of a page run for documents: its screen title unless that is generic (or headings are switched off). */
  function pageTitle(run, show) {
    if (show === false) return "";
    return cleanScreen((run.lead && run.lead.screen) || (run.steps && run.steps[0] && run.steps[0].screen));
  }

  /** Screens group steps: a step whose `screen` differs from the previous one starts a new heading. */
  function groupByScreen(steps) {
    const groups = [];
    for (const s of steps) {
      const title = s.screen || "";
      const last = groups[groups.length - 1];
      if (last && last.title === title) last.steps.push(s);
      else groups.push({ title, steps: [s] });
    }
    return groups;
  }


  /** A free text section (introduction, prerequisites, warning); it has a heading and a body but no number. */
  function addSection(steps, afterId, heading) {
    const sec = { id: newId(), kind: "section", data: {}, text: heading || "", note: "", screenshot: null, marker: null, sub: null, number: "" };
    const i = steps.findIndex((s) => s.id === afterId);
    if (i < 0) steps.unshift(sec); else steps.splice(i + 1, 0, sec);
    return renumber(steps), sec;
  }

  /** The marker after cropping the screenshot to a rectangle given as fractions of the image (fx, fy, fw, fh). */
  function cropMarker(marker, f) {
    if (!marker) return marker;
    const m = { ...marker };
    const ox = f.fx * marker.vw, oy = f.fy * marker.vh;
    m.vw = marker.vw * f.fw; m.vh = marker.vh * f.fh;
    m.x = marker.x - ox; m.y = marker.y - oy;
    return m;
  }

  const DOC_LABELS = {
    en: { contents: "Contents", step: "Step", page: "Page", author: "Author", version: "Version", date: "Date", workflow: "Workflow", language: "Language", untitled: "Untitled" },
    de: { contents: "Inhalt", step: "Schritt", page: "Seite", author: "Autor", version: "Version", date: "Datum", workflow: "Workflow", language: "Sprache", untitled: "Ohne Titel" },
    fr: { contents: "Sommaire", step: "Étape", page: "Page", author: "Auteur", version: "Version", date: "Date", workflow: "Workflow", language: "Langue", untitled: "Sans titre" }
  };

  /** The title the way the brand sets it: capitals and a trailing period. */
  function brandTitle(t) {
    const base = String(t || "").trim().replace(/[.\s]+$/, "");
    return base ? base.toUpperCase() + THEME.titleSuffix : "";
  }

  /** Table of contents entries: one per screen heading and per free text section, with the first step number it covers. */
  function contents(steps) {
    const out = [];
    let screen = null;
    for (const s of steps) {
      if (s.kind === "section") { out.push({ title: s.text, anchor: s.id }); continue; }
      const sc = cleanScreen(s.screen);
      if (sc && sc !== screen) out.push({ title: sc, anchor: s.id, from: s.number });
      screen = sc || screen;
    }
    return out;
  }

  /** Share of the visible controls/headings two page fingerprints have in common (1 when either is unknown). */
  function similarity(a, b) {
    if (!a || !b || !a.length || !b.length) return 1;
    const A = new Set(a), B = new Set(b);
    let n = 0;
    for (const x of A) if (B.has(x)) n++;
    return n / (A.size + B.size - n);
  }
  const SAME_PAGE = 0.6;

  /** Is an event on the same page as the page that is being recorded? page/ev = { screen, url, lov, sig } (ev.page is the URL). */
  function samePage(page, ev) {
    if (!page) return false;
    if (page.screen !== ev.screen) return false;
    if (!ev.screen && page.url !== ev.page) return false;
    if (!!page.lov !== !!ev.lov) return false;
    return similarity(page.sig, ev.sig) >= SAME_PAGE;
  }

  const MASK = "••••";
  /** Value to store for an input: password fields are never captured. */
  const safeValue = (type, value) => (String(type || "").toLowerCase() === "password" ? MASK : value);

  /**
   * Classifies a click/change reported by the page. `info` = { tag, role, type, label, value, checked, inList, listTitle,
   * rowKey, columnHeader, inLov, prompt }. Returns { kind, data } or null when the event is not worth a step.
   */
  function classify(info) {
    const i = info || {};
    const type = String(i.type || "").toLowerCase();
    // A click on read-only text (recorded only when the "any object" option is on) documents what the user points at.
    if (i.event === "click" && i.readonly) return i.label ? { kind: "object", data: { value: i.label } } : null;
    if (i.event === "change") {
      if (type === "checkbox" || type === "radio" || i.role === "switch" || i.role === "checkbox") {
        return { kind: "binary", data: { prompt: i.prompt || i.label || "", on: !!i.checked } };
      }
      if (["button", "submit", "reset", "file", "hidden"].includes(type)) return null;
      if (i.value === "" || i.value === undefined) return null;
      // A free text field (text area, multi-line or long text) is named by its prompt; what was typed is not part of the sentence.
      if (i.tag === "textarea" || /[\r\n]/.test(String(i.value)) || String(i.value).length > 60) return { kind: "freetext", data: { prompt: i.prompt || i.label || "", value: safeValue(type, i.value) } };
      return { kind: "input", data: { prompt: i.prompt || i.label || "", value: safeValue(type, i.value) } };
    }
    if (i.inLov && i.rowKey) return { kind: "lov", data: { prompt: i.prompt || i.listTitle || "", value: i.rowKey, column: i.columnHeader || "" } };
    if (i.inList && i.rowKey) return { kind: "list", data: { list: i.listTitle || "", value: i.rowKey } };
    if (type === "checkbox" || type === "radio" || i.role === "switch" || i.role === "checkbox") return null; // recorded on its change event
    if (["text", "number", "date", "password", "email", "search", "tel", "url", "time", "datetime-local", ""].includes(type) && i.tag === "input") return null; // recorded on change
    if (i.tag === "textarea") return null;
    if (!i.label) return null;
    if (i.generic) return { kind: "generic", data: { button: i.label } };
    return { kind: "button", data: { button: i.label } };
  }

  const api = { LANGS, LANG_NAMES, THEME, TEMPLATES, sentence, renumber, addStep, removeStep, moveStep, mergeWithPrevious, relanguage, groupByScreen, cleanScreen, pageTitle, similarity, samePage, SAME_PAGE, pageRuns, movePage, joinPreviousPage, cropPage, handOverPage, classify, addSection, cropMarker, DOC_LABELS, brandTitle, contents, safeValue, MASK, TIMESTAMP_ID };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.StepRecorder = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
