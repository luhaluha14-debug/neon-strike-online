// Multi-touch for the mobile suites: real touch points through Chrome's input
// pipeline (CDP Input.dispatchTouchEvent), as a phone's screen sends them.
// Each finger has an id; a start / move lists every finger down, an end the one lifted.

export async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1 })) });
  return {
    async start(id, x, y) {
      down.set(id, { x, y });
      await send('touchStart');
    },
    async move(id, x, y, steps = 1) {
      const p = down.get(id);
      const from = { ...p };
      for (let i = 1; i <= steps; i++) {
        p.x = from.x + ((x - from.x) * i) / steps;
        p.y = from.y + ((y - from.y) * i) / steps;
        await send('touchMove');
      }
    },
    async end(id) {
      const p = down.get(id);
      down.delete(id);
      // CDP: touchEnd lifts exactly the fingers it lists (the others stay down).
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id, x: p.x, y: p.y }] });
      return p;
    },
    async cancel() {
      down.clear();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    },
    async tap(x, y, id = 90) {
      await this.start(id, x, y);
      await this.end(id);
    },
    get count() {
      return down.size;
    },
  };
}

/** Centre of the first visible element matching `sel`. */
export async function centre(page, sel) {
  return page.evaluate((sel) => {
    const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, sel);
}
