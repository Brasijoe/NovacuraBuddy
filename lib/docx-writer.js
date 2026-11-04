/* ============================================================
   Minimal .docx writer for the Step Recorder: builds an editable Word document (cover, contents, pages with a
   screenshot and numbered steps, free text sections) in the Novacura design. A .docx is a zip of XML parts, so this
   file also holds a tiny zip writer (stored, no compression; JPEG screenshots do not compress anyway).
   Pure functions: no DOM, no chrome.* - the editor passes the screenshots in with their markers already drawn.
   ============================================================ */
(function (global) {
  const ACCENT = "0C65F4", NAVY = "141635", MUTED = "465466";
  const EMU_PER_PX = 9525;
  const MAX_IMG_EMU = 5580000; // 15.5 cm, the text width of A4 with 2 cm margins is 17 cm

  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : new (require("util").TextEncoder)();
  const utf8 = (s) => enc.encode(s);
  const esc = (s) => String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  // ---------- zip (store) ----------
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  /** files: [{ name, bytes: Uint8Array }] -> Uint8Array of a zip archive. */
  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (n) => [n & 255, (n >>> 8) & 255];
    const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    for (const f of files) {
      const name = utf8(f.name), crc = crc32(f.bytes), size = f.bytes.length;
      // 0x0800 = names are UTF-8; date 1980-01-01
      const local = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
      chunks.push(local, name, f.bytes);
      central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += local.length + name.length + size;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------- document parts ----------
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  const run = (text, o = {}) => `<w:r><w:rPr>${o.style ? `<w:rStyle w:val="${o.style}"/>` : ""}${o.bold ? "<w:b/>" : ""}${o.italic ? "<w:i/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}${o.size ? `<w:sz w:val="${o.size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  const para = (inner, o = {}) => `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ""}${o.keepNext ? "<w:keepNext/>" : ""}${o.tab ? `<w:tabs><w:tab w:val="left" w:pos="${o.tab}"/></w:tabs>` : ""}${o.indent ? `<w:ind w:left="${o.indent}" w:hanging="${o.hanging || 0}"/>` : ""}${o.spacingAfter !== undefined ? `<w:spacing w:after="${o.spacingAfter}"/>` : ""}</w:pPr>${inner}</w:p>`;
  const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  function imageXml(rid, id, wPx, hPx, descr) {
    let cx = Math.round(wPx * EMU_PER_PX), cy = Math.round(hPx * EMU_PER_PX);
    if (cx > MAX_IMG_EMU) { cy = Math.round(cy * (MAX_IMG_EMU / cx)); cx = MAX_IMG_EMU; }
    return `<w:p><w:pPr><w:keepNext/><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Screenshot ${id}" descr="${esc(descr)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="E4E8EF"/></a:solidFill></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }

  /** A small image inside a line of text (a step's icon), 0.55 cm high. */
  function inlineImageRun(rid, id, wPx, hPx) {
    const cy = 200000, cx = Math.max(1, Math.round(cy * (wPx / hPx)));
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Icon ${id}" descr="icon"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="icon${id}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  const STYLES = XML + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Roboto" w:hAnsi="Roboto" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="2400" w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Montserrat" w:hAnsi="Montserrat" w:cs="Arial"/><w:b/><w:color w:val="${NAVY}"/><w:sz w:val="68"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="600"/></w:pPr><w:rPr><w:rFonts w:ascii="Montserrat" w:hAnsi="Montserrat" w:cs="Arial"/><w:b/><w:color w:val="${ACCENT}"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="200"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Montserrat" w:hAnsi="Montserrat" w:cs="Arial"/><w:b/><w:color w:val="${ACCENT}"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="2" w:color="${ACCENT}"/></w:pBdr><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Montserrat" w:hAnsi="Montserrat" w:cs="Arial"/><w:b/><w:color w:val="${NAVY}"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Montserrat" w:hAnsi="Montserrat" w:cs="Arial"/><w:b/><w:color w:val="${ACCENT}"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:pos="9638"/></w:tabs><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="${MUTED}"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;

  /**
   * doc = { title, workflow, meta: [[label, value]], contentsLabel, toc: [string], pageLabel, footerLeft,
   *         blocks: [ { type: "section", heading, text } | { type: "page", screen, image: { bytes, w, h } | null, steps: [{ number, text, note }] } ] }
   * Returns the .docx as a Uint8Array.
   */
  function buildDocx(doc) {
    const media = [], rels = [];
    let imgId = 0;
    const body = [];
    body.push(para(run(doc.title || ""), { style: "Title" }));
    if (doc.workflow) body.push(para(run(doc.workflow), { style: "Subtitle" }));
    for (const [k, v] of doc.meta || []) if (v) body.push(para(run(k + ": ", { color: MUTED }) + run(v), { spacingAfter: 60 }));
    body.push(pageBreak());
    body.push(para(run(doc.contentsLabel || "Contents"), { style: "Heading1" }));
    for (const t of doc.toc || []) body.push(para(run(t), { indent: 360, hanging: 0, spacingAfter: 60 }));
    body.push(pageBreak());
    for (const b of doc.blocks || []) {
      if (b.type === "section") {
        body.push(para(run(b.heading), { style: "Heading3" }));
        for (const line of String(b.text || "").split(/\r?\n/)) body.push(para(run(line)));
        continue;
      }
      if (b.screen) body.push(para(run(b.screen), { style: "Heading2" }));
      if (b.image && b.image.bytes) {
        imgId += 1;
        const name = `image${imgId}.jpg`;
        media.push({ name: "word/media/" + name, bytes: b.image.bytes });
        rels.push(`<Relationship Id="rIdImg${imgId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
        body.push(imageXml("rIdImg" + imgId, imgId, b.image.w, b.image.h, b.screen || ""));
      }
      for (const s of b.steps || []) {
        let iconRun = "";
        if (s.icon && s.icon.bytes) {
          imgId += 1;
          const name = `icon${imgId}.png`;
          media.push({ name: "word/media/" + name, bytes: s.icon.bytes });
          rels.push(`<Relationship Id="rIdImg${imgId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
          iconRun = run(" ") + inlineImageRun("rIdImg" + imgId, imgId, s.icon.w, s.icon.h);
        }
        body.push(para(run(s.number, { bold: true, color: ACCENT, style: undefined }) + '<w:r><w:tab/></w:r>' + run(s.text) + iconRun, { tab: 720, indent: 720, hanging: 720, spacingAfter: s.note ? 20 : 100, keepNext: !!s.note }));
        if (s.note) for (const line of String(s.note).split(/\r?\n/)) body.push(para(run(line, { italic: true, color: MUTED, size: 20 }), { indent: 720, spacingAfter: 100 }));
      }
    }
    const sect = '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
    const document = XML + `<w:document ${NS}><w:body>${body.join("")}${sect}</w:body></w:document>`;
    const footer = XML + `<w:ftr ${NS}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>${run(doc.footerLeft || "")}<w:r><w:tab/></w:r>${run((doc.pageLabel || "Page") + " ")}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("1")}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
    const docRels = XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${rels.join("")}</Relationships>`;
    const types = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>';
    const rootRels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    return zip([
      { name: "[Content_Types].xml", bytes: utf8(types) },
      { name: "_rels/.rels", bytes: utf8(rootRels) },
      { name: "word/document.xml", bytes: utf8(document) },
      { name: "word/styles.xml", bytes: utf8(STYLES) },
      { name: "word/footer1.xml", bytes: utf8(footer) },
      { name: "word/_rels/document.xml.rels", bytes: utf8(docRels) },
      ...media
    ]);
  }

  const api = { buildDocx, zip, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.DocxWriter = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
