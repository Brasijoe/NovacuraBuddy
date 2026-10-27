// Permission Check tab. Step 1: scan the flow open in the Designer for the IFS projections it calls.
function pcHint(text) {
  const el = document.getElementById("pcHint");
  el.textContent = text || "";
  el.hidden = !text;
}

document.getElementById("pcScanBtn").addEventListener("click", async () => {
  const btn = document.getElementById("pcScanBtn");
  btn.disabled = true;
  document.getElementById("pcResult").hidden = true;
  pcHint("Reading the flow and everything it uses…");
  const response = await send({ type: "PC_SCAN" });
  btn.disabled = false;
  if (!response.ok) return pcHint(response.error);
  pcHint("");
  const list = document.getElementById("pcList");
  list.innerHTML = "";
  for (const { projection, assets } of response.projections) {
    const li = document.createElement("li");
    li.textContent = `${projection} — used by ${assets.join(", ")}`;
    list.appendChild(li);
  }
  document.getElementById("pcSummary").textContent = response.projections.length
    ? `${response.flowName || "Open flow"}: ${response.projections.length} projection(s) called.`
    : `${response.flowName || "Open flow"}: no IFS projection calls found.`;
  document.getElementById("pcResult").hidden = false;
});
