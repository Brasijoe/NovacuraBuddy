const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Docx = require("./docx-writer.js");

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

test("crc32 of a known string", () => {
  assert.equal(Docx.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildDocx writes a zip with the expected parts, escaped text and one image per page", () => {
  const bytes = Docx.buildDocx({
    title: "PACK <A> SHIPMENT.", workflow: "Pack & Ship", meta: [["Author", "Johannes"], ["Version", ""]], contentsLabel: "Inhalt", toc: ["Pack (Schritt 1)"],
    pageLabel: "Seite", footerLeft: "Deutsch",
    blocks: [{ type: "section", heading: "Einleitung", text: "Zeile 1\nZeile 2" },
      { type: "page", screen: "Pack", image: { bytes: JPEG, w: 800, h: 450 }, steps: [{ number: "1", text: "Klicken Sie auf „OK“.", note: "Hinweis" }, { number: "2", text: "Weiter.", note: "" }] }]
  });
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-"));
  const file = path.join(dir, "t.docx");
  fs.writeFileSync(file, bytes);
  let listing = "";
  try { listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" }); } catch { return; } // unzip not installed: structure not checked here
  for (const part of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/footer1.xml", "word/media/image1.jpg", "word/_rels/document.xml.rels"]) assert.ok(listing.includes(part), part);
  assert.equal(execFileSync("unzip", ["-tq", file], { encoding: "utf8" }).includes("No errors"), true);
  const xml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
  assert.ok(xml.includes("PACK &lt;A&gt; SHIPMENT."));
  assert.ok(xml.includes("Klicken Sie auf „OK“."));
  assert.equal((xml.match(/<w:drawing>/g) || []).length, 1);
  assert.ok(!xml.includes("Version:"), "empty meta values are left out");
});
