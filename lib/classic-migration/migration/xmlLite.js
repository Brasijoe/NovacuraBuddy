function localName(tag) {
  const idx = tag.indexOf(":");
  return idx === -1 ? tag : tag.slice(idx + 1);
}
function decodeEntities(text) {
  return String(text || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10))).replace(/&amp;/g, "&");
}
function parseXml(source) {
  let i = 0;
  const text = String(source || "");
  const len = text.length;
  function skipWhitespace() {
    while (i < len && /\s/.test(text[i])) i++;
  }
  function skipProlog() {
    while (i < len) {
      skipWhitespace();
      if (text.startsWith("<?", i)) {
        const end = text.indexOf("?>", i);
        i = end === -1 ? len : end + 2;
        continue;
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (text.startsWith("<!", i)) {
        const end = text.indexOf(">", i);
        i = end === -1 ? len : end + 1;
        continue;
      }
      break;
    }
  }
  function parseAttrs() {
    const attrs = {};
    while (true) {
      skipWhitespace();
      if (text[i] === ">" || text.startsWith("/>", i) || i >= len) break;
      const nameMatch = /^[^\s=/>]+/.exec(text.slice(i));
      if (!nameMatch) break;
      const name = nameMatch[0];
      i += name.length;
      skipWhitespace();
      if (text[i] !== "=") {
        attrs[name] = "";
        continue;
      }
      i++;
      skipWhitespace();
      const quote = text[i];
      if (quote !== '"' && quote !== "'") break;
      i++;
      const end = text.indexOf(quote, i);
      attrs[name] = decodeEntities(text.slice(i, end));
      i = end + 1;
    }
    return attrs;
  }
  function parseElement() {
    i++;
    const nameMatch = /^[^\s/>]+/.exec(text.slice(i));
    const tag = nameMatch[0];
    i += tag.length;
    const attrs = parseAttrs();
    skipWhitespace();
    if (text.startsWith("/>", i)) {
      i += 2;
      return { tag, localName: localName(tag), attrs, children: [], text: "" };
    }
    if (text[i] !== ">") throw new Error(`XmlLite: malformed start tag <${tag}> at position ${i}`);
    i++;
    const children = [];
    let textContent = "";
    while (true) {
      if (i >= len) throw new Error(`XmlLite: unexpected end of input inside <${tag}>`);
      if (text.startsWith("</", i)) {
        const closeMatch = /^<\/([^\s>]+)\s*>/.exec(text.slice(i));
        if (!closeMatch) throw new Error(`XmlLite: malformed end tag near position ${i}`);
        if (closeMatch[1] !== tag) {
          throw new Error(`XmlLite: mismatched close tag </${closeMatch[1]}> for <${tag}> at position ${i}`);
        }
        i += closeMatch[0].length;
        break;
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", i)) {
        const end = text.indexOf("]]>", i);
        const cdataEnd = end === -1 ? len : end;
        textContent += text.slice(i + 9, cdataEnd);
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (text[i] === "<") {
        children.push(parseElement());
        continue;
      }
      const nextTag = text.indexOf("<", i);
      const chunkEnd = nextTag === -1 ? len : nextTag;
      textContent += decodeEntities(text.slice(i, chunkEnd));
      i = chunkEnd;
    }
    return { tag, localName: localName(tag), attrs, children, text: textContent };
  }
  skipProlog();
  skipWhitespace();
  if (text[i] !== "<") throw new Error("XmlLite: no root element found");
  return parseElement();
}
function findChild(node, name) {
  if (!node) return null;
  return node.children.find((c) => c.localName === name) || null;
}
function findChildren(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.localName === name);
}
function childText(node, name) {
  const child = findChild(node, name);
  return child ? child.text : null;
}
function stripPrefix(value) {
  if (!value) return value;
  const idx = value.indexOf(":");
  return idx === -1 ? value : value.slice(idx + 1);
}
export {
  childText,
  decodeEntities,
  findChild,
  findChildren,
  parseXml,
  stripPrefix
};
