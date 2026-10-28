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
