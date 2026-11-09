import test from "node:test";
import assert from "node:assert/strict";
import { translateExpression } from "./migration/classicScriptTranslator.js";

const expr = "count(Outer where any(Inner as r where r.A = A)) > 0";

test("decision steps (no Seq) never emit .filter for 'x as r where ...'", () => {
  const out = translateExpression(expr, { noSeqAvailable: true });
  assert.ok(!out.includes(".filter("), out);
  assert.ok(out.includes("Inner as r where"), out);
});
test("outside decisions the Seq .filter form is kept", () => {
  const out = translateExpression(expr, {});
  assert.ok(out.includes(".filter(r =>"), out);
});
