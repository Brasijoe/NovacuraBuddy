import { decodeIncludedWorkflow, collectAllItems } from "./classicDecoder.js";
function directDependencies(decodedFlow) {
  const versionIds = /* @__PURE__ */ new Set();
  collectAllItems(decodedFlow.items).forEach((item) => {
    if (item.stepType !== "IncludedWorkflowItem" || !item.tagNode) return;
    const ref = decodeIncludedWorkflow(item.tagNode);
    if (ref.versionIdentifier) versionIds.add(ref.versionIdentifier);
  });
  return [...versionIds];
}
function buildIncludeDependencyOrder(decodedFlows) {
  const byVersionIdentifier = new Map(decodedFlows.map((f) => [f.versionIdentifier, f]));
  const dependencies = /* @__PURE__ */ new Map();
  const dependents = /* @__PURE__ */ new Map();
  const unresolvedReferences = [];
  decodedFlows.forEach((f) => {
    dependencies.set(f, /* @__PURE__ */ new Set());
    dependents.set(f, /* @__PURE__ */ new Set());
  });
  decodedFlows.forEach((f) => {
    directDependencies(f).forEach((versionId) => {
      const target = byVersionIdentifier.get(versionId);
      if (!target) {
        unresolvedReferences.push({ flow: f, versionIdentifier: versionId });
        return;
      }
      if (target === f) return;
      dependencies.get(f).add(target);
      dependents.get(target).add(f);
    });
  });
  const indegree = new Map(decodedFlows.map((f) => [f, dependencies.get(f).size]));
  const queue = decodedFlows.filter((f) => indegree.get(f) === 0);
  const order = [];
  const visited = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const f = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    order.push(f);
    dependents.get(f).forEach((dependent) => {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    });
  }
  const cyclic = decodedFlows.filter((f) => !visited.has(f));
  return { order, unresolvedReferences, cyclic };
}
function transitiveDependencies(flow, allFlows) {
  const byVersionIdentifier = new Map(allFlows.map((f) => [f.versionIdentifier, f]));
  const needed = /* @__PURE__ */ new Set();
  const stack = [flow];
  while (stack.length > 0) {
    const current = stack.pop();
    directDependencies(current).forEach((versionId) => {
      const dep = byVersionIdentifier.get(versionId);
      if (dep && dep !== flow && !needed.has(dep)) {
        needed.add(dep);
        stack.push(dep);
      }
    });
  }
  return needed;
}
export {
  buildIncludeDependencyOrder,
  directDependencies,
  transitiveDependencies
};
