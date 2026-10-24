// Runs in the Flow Designer page itself (MAIN world, document_start). The Designer draws the whole
// flow on one <canvas>, so its steps have no elements to find. This records where the page draws
// each text (fillText/strokeText, through the current canvas transform) and tells the extension's
// content script (content/designer.js) the on-screen position of every text, so the Module Compare
// marks can sit on the right steps. Read-only: the drawing calls are passed through unchanged.
(() => {
  if (window.__novacuraBuddyCanvasHook) return;
  window.__novacuraBuddyCanvasHook = true;
  const proto = CanvasRenderingContext2D.prototype;
  let batch = new Map(); // text -> [{ x, y, w, h, box }] in canvas pixels, from the current redraw
  let shapes = []; // filled/stroked shapes of the current redraw: { x0, y0, x1, y1 } in canvas pixels
  let path = null; // bounds of the path being built
  let latest = new Map(); // text -> same, merged over redraws
  let canvasEl = null;
  let lastDraw = 0;
  let timer = null;

  function record(ctx, text, x, y, maxWidth) {
    try {
      const t = String(text).trim();
      if (!t) return;
      newFrame();
      canvasEl = ctx.canvas;
      const m = ctx.getTransform();
      const width = Math.min(ctx.measureText(String(text)).width, maxWidth || Infinity);
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font || "") ? /(\d+(?:\.\d+)?)px/.exec(ctx.font)[1] : 12);
      const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
      const scale = Math.hypot(m.a, m.b) || 1;
      const list = batch.get(t) || [];
      const p = { x: px, y: py, w: width * scale, h: size * scale, align: ctx.textAlign, baseline: ctx.textBaseline };
      p.box = cardAround(textBox(p));
      list.push(p);
      batch.set(t, list);
      clearTimeout(timer);
      timer = setTimeout(publish, 60);
    } catch { /* never disturb the page's drawing */ }
  }

  function newFrame() {
    const now = performance.now();
    if (now - lastDraw > 30) { batch = new Map(); shapes = []; } // a new redraw started
    lastDraw = now;
  }

  /** The text's box in canvas pixels, whatever its alignment/baseline. */
  function textBox(p) {
    let x0 = p.x;
    if (p.align === "center") x0 -= p.w / 2; else if (p.align === "right" || p.align === "end") x0 -= p.w;
    let y0 = p.y;
    if (p.baseline === "middle") y0 -= p.h / 2; else if (p.baseline === "alphabetic" || p.baseline === "bottom" || p.baseline === "ideographic") y0 -= p.h;
    return { x0, y0, x1: x0 + p.w, y1: y0 + p.h };
  }

  /** The step card the text sits in: the smallest drawn shape around it that is still card sized. */
  function cardAround(t) {
    const tw = t.x1 - t.x0, th = t.y1 - t.y0;
    let best = null;
    for (let i = shapes.length - 1, n = 0; i >= 0 && n < 300; i--, n++) {
      const s = shapes[i];
      const w = s.x1 - s.x0, h = s.y1 - s.y0;
      if (s.x0 > t.x0 + 1 || s.y0 > t.y0 + 1 || s.x1 < t.x1 - 1 || s.y1 < t.y1 - 1) continue;
      if (h > th * 6 + 20 || w > tw * 4 + 400 || h < th) continue;
      if (!best || w * h < (best.x1 - best.x0) * (best.y1 - best.y0)) best = s;
    }
    return best && { ...best };
  }

  // Path bounds, through the transform at each call.
  function addPoint(ctx, x, y) {
    const m = ctx.getTransform();
    const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
    if (!path) path = { x0: px, y0: py, x1: px, y1: py };
    else { path.x0 = Math.min(path.x0, px); path.y0 = Math.min(path.y0, py); path.x1 = Math.max(path.x1, px); path.y1 = Math.max(path.y1, py); }
  }
  function addRect(ctx, x, y, w, h) {
    addPoint(ctx, x, y); addPoint(ctx, x + w, y); addPoint(ctx, x, y + h); addPoint(ctx, x + w, y + h);
  }
  function commitShape(box) {
    if (!box || !(box.x1 - box.x0 > 4) || !(box.y1 - box.y0 > 4)) return;
    newFrame();
    shapes.push({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
    if (shapes.length > 5000) shapes.splice(0, 1000);
  }
  const wrap = (name, before) => {
    const original = proto[name];
    if (typeof original !== "function") return;
    proto[name] = function () {
      try { before(this, arguments); } catch { /* never disturb the page's drawing */ }
      return original.apply(this, arguments);
    };
  };
  wrap("beginPath", () => { path = null; });
  wrap("moveTo", (c, a) => addPoint(c, a[0], a[1]));
  wrap("lineTo", (c, a) => addPoint(c, a[0], a[1]));
  wrap("quadraticCurveTo", (c, a) => { addPoint(c, a[0], a[1]); addPoint(c, a[2], a[3]); });
  wrap("bezierCurveTo", (c, a) => { addPoint(c, a[0], a[1]); addPoint(c, a[2], a[3]); addPoint(c, a[4], a[5]); });
  wrap("arcTo", (c, a) => { addPoint(c, a[0], a[1]); addPoint(c, a[2], a[3]); });
  wrap("arc", (c, a) => addRect(c, a[0] - a[2], a[1] - a[2], 2 * a[2], 2 * a[2]));
  wrap("ellipse", (c, a) => addRect(c, a[0] - a[2], a[1] - a[3], 2 * a[2], 2 * a[3]));
  wrap("rect", (c, a) => addRect(c, a[0], a[1], a[2], a[3]));
  wrap("roundRect", (c, a) => addRect(c, a[0], a[1], a[2], a[3]));
  wrap("fill", (c, a) => { if (!(a[0] instanceof Path2D)) commitShape(path); });
  wrap("stroke", (c, a) => { if (!(a[0] instanceof Path2D)) commitShape(path); });
  const rectShape = (c, a) => { const saved = path; path = null; addRect(c, a[0], a[1], a[2], a[3]); commitShape(path); path = saved; };
  wrap("fillRect", rectShape);
  wrap("strokeRect", rectShape);

  function publish() {
    for (const [t, list] of batch) latest.set(t, list);
    if (!canvasEl || !canvasEl.isConnected) return;
    const r = canvasEl.getBoundingClientRect();
    const sx = r.width / (canvasEl.width || 1), sy = r.height / (canvasEl.height || 1);
    const out = [];
    for (const [text, list] of latest) {
      for (const p of list) {
        // Boxes of the text and of its step card in viewport CSS pixels.
        const view = (b) => b && { left: r.left + b.x0 * sx, top: r.top + b.y0 * sy, width: (b.x1 - b.x0) * sx, height: (b.y1 - b.y0) * sy };
        out.push({ ...view(textBox(p)), text, card: view(p.box) });
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
