/* Crops the icon of an unnamed control out of its page screenshot (the step stores where the control was, in viewport
   pixels), so a step can read "Click [icon]". DOM only (canvas); used by the side panel, the editor and the exports. */
(function (global) {
  const MAX_H = 48; // output height in px

  /** Resolves with { url, w, h } (a small PNG data URL), or null when there is nothing to crop. */
  function cropIcon(screenshot, icon) {
    if (!screenshot || !icon || !icon.vw || !icon.vh || !icon.w || !icon.h) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const sx = img.naturalWidth / icon.vw, sy = img.naturalHeight / icon.vh;
        const pad = 3;
        const x = Math.max(0, (icon.x - pad) * sx), y = Math.max(0, (icon.y - pad) * sy);
        const w = Math.min(img.naturalWidth - x, (icon.w + 2 * pad) * sx), h = Math.min(img.naturalHeight - y, (icon.h + 2 * pad) * sy);
        if (w < 2 || h < 2) { resolve(null); return; }
        const k = Math.min(1, MAX_H / h);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
        resolve({ url: c.toDataURL("image/png"), w: c.width, h: c.height });
      };
      img.onerror = () => resolve(null);
      img.src = screenshot;
    });
  }

  const cache = new Map();
  /** Same as cropIcon, remembered per step and screenshot so re-rendering the list does not crop again. */
  function stepIcon(step, lead) {
    if (!step || !step.icon || !lead || !lead.screenshot) return Promise.resolve(null);
    const key = step.id + ":" + lead.screenshot.length + ":" + JSON.stringify(step.icon);
    if (!cache.has(key)) cache.set(key, cropIcon(lead.screenshot, step.icon));
    return cache.get(key);
  }

  global.StepIcon = { cropIcon, stepIcon };
})(typeof globalThis !== "undefined" ? globalThis : this);
