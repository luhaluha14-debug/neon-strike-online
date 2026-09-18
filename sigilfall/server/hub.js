/* placeholder replaced by the full lobby in the online step */
export class Hub {
  constructor() { this.clients = new Set(); }
  connect(ws) {
    const c = { ws, id: 0 };
    this.clients.add(c);
    try { ws.send(JSON.stringify({ t: 'welcome', id: 0 })); } catch (e) { /* closing */ }
    return c;
  }
  receive() {}
  disconnect(c) { this.clients.delete(c); }
  tick() {}
}
