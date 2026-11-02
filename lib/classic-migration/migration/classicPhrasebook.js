const PHRASE_KEY_MAX_LENGTH = 32;
function createPhrasebook(defaultLang) {
  return { defaultLang: defaultLang || "en", phrases: [], usedKeys: /* @__PURE__ */ new Set(), references: /* @__PURE__ */ new Set() };
}
function phraseKeyBase(text) {
  const words = text.replace(/\{[^{}]*\}/g, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let key = words.map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
  if (!key) key = "phrase";
  if (/^[0-9]/.test(key)) key = `p${key}`;
  return key.slice(0, PHRASE_KEY_MAX_LENGTH);
}
function placeholderKeyBase(text) {
  const names = (text.match(/\{([A-Za-z0-9_]+)\}/g) || []).map((m) => m.slice(1, -1).replace(/_/g, ""));
  let key = names.map((n, i) => (i === 0 ? n.charAt(0).toLowerCase() : n.charAt(0).toUpperCase()) + n.slice(1)).join("");
  if (!key) key = "phrase";
  if (/^[0-9]/.test(key)) key = `p${key}`;
  return key.slice(0, PHRASE_KEY_MAX_LENGTH);
}
function uniqueKey(pb, base) {
  if (!pb.usedKeys.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, PHRASE_KEY_MAX_LENGTH - suffix.length) + suffix;
    if (!pb.usedKeys.has(candidate)) return candidate;
  }
}
function splitTemplate(text) {
  const parts = [];
  let buf = "";
  let inside = false;
  for (const ch of text) {
    if (ch === "{") {
      if (inside) return null;
      if (buf) parts.push({ literal: buf });
      buf = "";
      inside = true;
    } else if (ch === "}") {
      if (!inside) return null;
      parts.push({ expr: buf });
      buf = "";
      inside = false;
    } else {
      buf += ch;
    }
  }
  if (inside) return null;
  if (buf) parts.push({ literal: buf });
  return parts;
}
function placeholderNameFor(expr, taken, counter) {
  let name;
  if (/^[A-Za-z_]\w*$/.test(expr)) name = expr;
  else if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(expr)) name = expr.replace(/\./g, "_");
  else {
    do
      name = `value${++counter.n}`;
    while (taken.has(name));
  }
  return name;
}
function isSubset(small, big) {
  return Object.keys(small).every((lang) => lang in big && big[lang] === small[lang]);
}
function registerPhrase(pb, untrimmedTexts, translateArg) {
  const rawTexts = {};
  for (const [lang, text] of Object.entries(untrimmedTexts)) rawTexts[lang] = (text || "").trim();
  const langs = Object.keys(rawTexts).filter((l) => rawTexts[l]);
  if (new Set(langs.map((l) => rawTexts[l])).size <= 1) return null;
  langs.sort((a, b) => a === pb.defaultLang ? -1 : b === pb.defaultLang ? 1 : 0);
  const nameByArg = /* @__PURE__ */ new Map();
  const taken = /* @__PURE__ */ new Set();
  const counter = { n: 0 };
  const texts = {};
  for (const lang of langs) {
    const parts = splitTemplate(rawTexts[lang]);
    if (!parts) return null;
    texts[lang] = parts.map((p) => {
      if ("literal" in p) return p.literal;
      const expr = p.expr.trim();
      const arg = translateArg(expr);
      let name = nameByArg.get(arg);
      if (!name) {
        name = placeholderNameFor(expr, taken, counter);
        nameByArg.set(arg, name);
        taken.add(name);
      }
      return `{${name}}`;
    }).join("");
  }
  let phrase = pb.phrases.find((p) => isSubset(texts, p.texts) || isSubset(p.texts, texts));
  if (phrase) {
    if (Object.keys(texts).length > Object.keys(phrase.texts).length) phrase.texts = texts;
  } else {
    const keySource = texts[pb.defaultLang] ?? texts.en ?? texts[langs[0]];
    const key = uniqueKey(pb, phraseKeyBase(keySource) === "phrase" ? placeholderKeyBase(keySource) : phraseKeyBase(keySource));
    pb.usedKeys.add(key);
    phrase = { key, texts };
    pb.phrases.push(phrase);
  }
  const args = nameByArg.size === 1 ? [...nameByArg.keys()][0] : `{${[...nameByArg.entries()].map(([arg, name]) => `${name}: ${arg}`).join(", ")}}`;
  const ref = nameByArg.size === 0 ? `{Phrase.${phrase.key}}` : `{Phrase.${phrase.key}(${args})}`;
  pb.references.add(ref);
  return ref;
}
function isPhraseReference(pb, text) {
  return pb.references.has(text);
}
function phrasebookEntries(pb) {
  if (pb.phrases.length === 0) return [];
  const languages = /* @__PURE__ */ new Set();
  const phraseEntries = pb.phrases.map((p) => {
    const defaultLang = pb.defaultLang in p.texts ? pb.defaultLang : "en" in p.texts ? "en" : Object.keys(p.texts)[0];
    const translations = {};
    for (const [lang, text] of Object.entries(p.texts)) {
      if (lang === pb.defaultLang) continue;
      translations[lang] = text;
      languages.add(lang);
    }
    return { type: "phrase-added", key: p.key, defaultValue: p.texts[defaultLang], translations };
  });
  return [{ type: "languages-modified", languages: [...languages].sort() }, ...phraseEntries];
}
export {
  PHRASE_KEY_MAX_LENGTH,
  createPhrasebook,
  isPhraseReference,
  phraseKeyBase,
  phrasebookEntries,
  registerPhrase,
  splitTemplate
};
