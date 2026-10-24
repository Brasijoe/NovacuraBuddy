// Runs in the Flow Designer page itself (MAIN world, document_start). The Designer draws the whole
// flow on one <canvas>, so its steps have no elements to find. This records where the page draws
// each text (fillText/strokeText, through the current canvas transform) and tells the extension's
// content script (content/designer.js) the on-screen position of every text, so the Module Compare
// marks can sit on the right steps. Read-only: the drawing calls are passed through unchanged.
(() => {
  if (window.__novacuraBuddyCanvasHook) return;
  window.__novacuraBuddyCanvasHook = true;
  const proto = CanvasRenderingContext2D.prototype;
  let batch = new Map(); // text -> [{ x, y, w, h }] in canvas pixels, from the current redraw
  let latest = new Map(); // text -> same, merged over redraws
  let canvasEl = null;
  let lastDraw = 0;
  let timer = null;

  function record(ctx, text, x, y, maxWidth) {
    try {
      const t = String(text).trim();
      if (!t) return;
      const now = performance.now();
      if (now - lastDraw > 30) batch = new Map(); // a new redraw started
      lastDraw = now;
      canvasEl = ctx.canvas;
      const m = ctx.getTransform();
      const width = Math.min(ctx.measureText(String(text)).width, maxWidth || Infinity);
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font || "") ? /(\d+(?:\.\d+)?)px/.exec(ctx.font)[1] : 12);
      const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
      const scale = Math.hypot(m.a, m.b) || 1;
      const list = batch.get(t) || [];
      list.push({ x: px, y: py, w: width * scale, h: size * scale, align: ctx.textAlign, baseline: ctx.textBaseline });
      batch.set(t, list);
      clearTimeout(timer);
      timer = setTimeout(publish, 60);
    } catch { /* never disturb the page's drawing */ }
  }

  function publish() {
    for (const [t, list] of batch) latest.set(t, list);
    if (!canvasEl || !canvasEl.isConnected) return;
    const r = canvasEl.getBoundingClientRect();
    const sx = r.width / (canvasEl.width || 1), sy = r.height / (canvasEl.height || 1);
    const out = [];
    for (const [text, list] of latest) {
      for (const p of list) {
        // Box of the text in viewport CSS pixels, whatever the text alignment/baseline.
        const w = p.w * sx, h = p.h * sy;
        let left = r.left + p.x * sx;
        if (p.align === "center") left -= w / 2; else if (p.align === "right" || p.align === "end") left -= w;
        let top = r.top + p.y * sy;
        if (p.baseline === "middle") top -= h / 2; else if (p.baseline === "alphabetic" || p.baseline === "bottom" || p.baseline === "ideographic") top -= h;
        out.push({ text, left, top, width: w, height: h });
      }
    }
    window.dispatchEvent(new CustomEvent("novacura-buddy-canvas-texts", { detail: JSON.stringify({ canvas: { left: r.left, top: r.top, width: r.width, height: r.height }, texts: out }) }));
  }

  for (const name of ["fillText", "strokeText"]) {
    const original = proto[name];
    proto[name] = function (text, x, y, maxWidth) {
      record(this, text, x, y, maxWidth);
      return original.apply(this, arguments);
    };
  }
  // The content script asks again when it starts later than the last redraw.
  window.addEventListener("novacura-buddy-canvas-ask", publish);
})();
