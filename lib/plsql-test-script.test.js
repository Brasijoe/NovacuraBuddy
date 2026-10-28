const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBinds, buildTst, fileName } = require("./plsql-test-script.js");

test("binds: := is no bind; comments, strings and duplicates are ignored", () => {
  const sql = "declare\n a_ number := :Qty; -- :nope\n b_ varchar2(9) := ':text'; c_ date := :qty;\nbegin\n x := :shopOrder1__partNo; /* :hidden */\nend;";
  assert.deepEqual(extractBinds(sql), ["Qty", "shopOrder1__partNo"]);
});

test("tst: header, line count, unchanged code, variables with values", () => {
  const sql = "begin\n  a_ := :MyVar;\nend;\n";
  assert.equal(buildTst(sql, { myvar: "42" }), ["PL/SQL Developer Test script 3.0", "3", "begin", "  a_ := :MyVar;", "end;", "1", "MyVar", "5", "42", "0", ""].join("\r\n"));
});

test("tst: no binds and missing values", () => {
  assert.match(buildTst("begin null; end;", {}), /end;\r\n0\r\n0\r\n$/);
  assert.match(buildTst("x := :a;", {}), /1\r\na\r\n5\r\n\r\n0\r\n$/);
});

test("file name", () => assert.equal(fileName("print \nbarcode: Serial/label"), "print_barcode_Serial_label.tst"));

test("literals follow the test panel's type", () => {
  const { toLiteral } = require("./plsql-test-script.js");
  assert.equal(toLiteral('"O\'Neil"'), "'O''Neil'");
  assert.equal(toLiteral('""'), "''");
  assert.equal(toLiteral("0"), "0");
  assert.equal(toLiteral("-1.5"), "-1.5");
  assert.equal(toLiteral("null"), "NULL");
  assert.equal(toLiteral("true"), "1");
  assert.equal(toLiteral('Date("0001-01-01T00:00:00.0000000+00:00")'), "TO_DATE('0001-01-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS')");
  assert.equal(toLiteral('Date("2024-03-05T10:20:30Z")'), "TO_DATE('2024-03-05 10:20:30', 'YYYY-MM-DD HH24:MI:SS')");
});

test("inline: binds replaced in code only", () => {
  const { inlineBinds } = require("./plsql-test-script.js");
  const sql = "a_ := :Id; -- :Id\nb_ := ':Id'; c_ := :Rec__name; d_ := :Missing;";
  assert.equal(inlineBinds(sql, { id: "12", Rec__name: '"x"' }), "a_ := 12; -- :Id\nb_ := ':Id'; c_ := 'x'; d_ := NULL;");
});
