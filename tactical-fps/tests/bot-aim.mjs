// Bot aim measurement (Phase 23), shared by the test and the before / after
// numbers: one bot against the player in an open line of the map, at a
// distance, the player standing or strafing side to side; the player cannot
// die (health topped up) so every engagement runs its full time. Reaction =
// time from the start (target in view, bot already facing it within 25°) to
// the first round fired; hit rate = hits on the player / rounds fired.
// Everything goes through the game's own bot, weapons, hitscan and damage.

export async function measureBotAim(page, { distances = [10, 25, 40], moving = [false, true], trials = 6, seconds = 4, difficulty = null } = {}) {
  return page.evaluate(
    async ({ distances, moving, trials, seconds, difficulty }) => {
      const g = window.game;
      const V = g.camera.position.constructor;
      const bot = g.squad.bots[0];
      // The bot may kill the player many times over: the match must not end on its kills.
      g.match.config.killTarget = 1e9;
      g.match.timeLeft = 1e9;
      for (const b of g.squad.bots.slice(1)) b.combat.protection = 1e9;
      if (difficulty && bot.setDifficulty) bot.setDifficulty(difficulty);
      const col = g.map.collision;
      const nav = g.nav;
      let seed = 11;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const clear = (a, b) => {
        const d = b.clone().sub(a);
        const L = d.length();
        return col.raycast(a, d.normalize(), L) === null;
      };
      // A standing spot `p`, a target spot at distance d with a clear view both ways, and room to strafe 3 m each side.
      const findLine = (d) => {
        for (let k = 0; k < 6000; k++) {
          const c = nav.randomCell(rnd);
          if (c < 0) break;
          const p = nav.center(c);
          const a = rnd() * Math.PI * 2;
          const q = new V(p.x + Math.sin(a) * d, p.y, p.z + Math.cos(a) * d);
          const side = new V(Math.cos(a), 0, -Math.sin(a));
          // The whole strafe (every half metre of it), not just its ends and middle.
          const ok = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3].every((s) => {
            const t = q.clone().addScaledVector(side, s);
            const down = col.raycast(new V(t.x, t.y + 1.5, t.z), new V(0, -1, 0), 3);
            if (down === null || Math.abs(1.5 - down) > 0.3) return false;
            return clear(new V(p.x, p.y + 1.6, p.z), new V(t.x, t.y + 1.2, t.z)) && clear(new V(p.x, p.y + 1.6, p.z), new V(t.x, t.y + 1.7, t.z));
          });
          if (ok) return { p, q, side, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) };
        }
        return null;
      };
      const out = [];
      for (const d of distances) {
        const line = findLine(d);
        if (!line) {
          out.push({ d, none: true });
          continue;
        }
        for (const mv of moving) {
          let shots = 0;
          let hits = 0;
          const reactions = [];
          for (let t = 0; t < trials; t++) {
            // Fresh engagement: bot at p looking roughly at the target (within ±25°), the player at q.
            g.combat.reset();
            g.combat.protection = 0;
            g.player.teleport(line.q.clone(), line.yaw + Math.PI);
            bot.spawn(line.p.clone(), line.yaw + (rnd() - 0.5) * 0.87);
            bot.order = null;
            const hits0 = g.combat.hits;
            const shot0 = bot.weapons.shotsFired;
            let first = -1;
            const ticks = Math.round(seconds * 60);
            for (let i = 0; i < ticks; i++) {
              if (mv) {
                // Side to side, 4.5 m/s, turning every 1.2 s (a strafing player).
                const ph = (i / 60) % 2.4;
                const s = ph < 1.2 ? -3 + 5 * (ph / 1.2) : 2 - 5 * ((ph - 1.2) / 1.2);
                const pos = line.q.clone().addScaledVector(line.side, s);
                g.player.position.copy(pos);
                g.player.velocity.copy(line.side).multiplyScalar(ph < 1.2 ? 4.2 : -4.2);
              } else g.player.position.copy(line.q);
              g.player.health = 100;
              window.T.run(1);
              if (!g.combat.alive) g.combat.reset();
              if (first < 0 && bot.weapons.shotsFired > shot0) first = (i + 1) / 60;
            }
            shots += bot.weapons.shotsFired - shot0;
            hits += g.combat.hits - hits0;
            if (first >= 0) reactions.push(first);
          }
          reactions.sort((a, b) => a - b);
          out.push({
            d,
            moving: mv,
            shots,
            hits,
            hitRate: shots ? +(hits / shots).toFixed(3) : null,
            reaction: reactions.length ? +reactions[Math.floor(reactions.length / 2)].toFixed(3) : null,
            reactionMin: reactions.length ? +reactions[0].toFixed(3) : null,
            engaged: reactions.length,
          });
        }
      }
      return out;
    },
    { distances, moving, trials, seconds, difficulty },
  );
}

/** A deathmatch with one bot, frames driven by the test (no real loop). */
export async function oneBotMatch(env, openGame, installFrameDriver, opts = {}) {
  const page = await openGame(env, {
    mode: 'deathmatch',
    quality: 'low',
    seed: 7,
    init: { content: `localStorage.setItem('tactical-fps.match.v1', JSON.stringify({ bots: 1, killTarget: 1000, timeLimit: 900 }))` },
    ...opts,
  });
  await page.click('.play-button');
  await page.waitForFunction(() => window.game.input.active);
  await installFrameDriver(page);
  await page.evaluate(() => {
    window.T.stopLoop();
    window.T.run(30);
    window.game.squad.respawns = true;
  });
  return page;
}
