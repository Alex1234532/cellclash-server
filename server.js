import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- GAME SETTINGS ----
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;

const WORLD = 5200;
const PELLET_TARGET = 700;
const VIRUS_COUNT = 32;

const BOT_DEFAULT = 45;
const PLAYER_TTL = 12; // seconds: remove inactive players so rooms don't fill forever

// ---- ROOMS ----
const rooms = new Map(); // code -> room

// ---- UTIL ----
function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function hashSeed(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h || 1;
}

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(x, y) {
  const L = Math.hypot(x, y);
  if (L < 1e-6) return [0, 0];
  return [x / L, y / L];
}

const BOT_NAMES = [
  "Nova","Jax","Raven","Milo","Sable","Kairo","Vex","Lyra","Nico","Aria","Blitz","Echo",
  "Zane","Iris","Orion","Skye","Rune","Onyx","Atlas","Luna","Koda","Seraph","Quinn","Nyx",
  "Axel","Rowan","Dante","Freya","Kai","Mako","Haze","Drift","Hex","Titan","Ghost","Feral",
  "Sol","Astra","Rook","Saffron","Vanta","Mira","Piper","Juno","Vale","Cove","Wren","Indi"
];

// ---- GAME CORE ----
function spawnAgent(id, name, isBot, rng) {
  const startMass = isBot ? (32 + rng() * 70) : 55;
  const startR = isBot ? (22 + rng() * 20) : 36;

  const col = {
    r: Math.floor(70 + rng() * 185),
    g: Math.floor(70 + rng() * 185),
    b: Math.floor(70 + rng() * 185)
  };

  return {
    id, name, isBot,
    col,
    dead: false,
    aimX: 0,
    aimY: 0,
    boost: false,
    lastSeen: Date.now() / 1000,
    blobs: [{
      x: 280 + rng() * (WORLD - 560),
      y: 280 + rng() * (WORLD - 560),
      vx: 0,
      vy: 0,
      mass: startMass,
      r: startR,
      splitTimer: 999
    }]
  };
}

function agentMass(a) {
  return a.blobs.reduce((s, b) => s + b.mass, 0);
}

function canEat(er, pr) { return er > pr * 1.12; }
function canEngulf(ex, ey, er, px, py, pr) {
  const d = Math.hypot(ex - px, ey - py);
  return d < (er - pr * 0.65);
}

function baseSpeed(r, totalMass, boosting) {
  const sizePenalty = Math.max(0.26, 1.0 - (r / 215));
  const softCap = 1400;
  let capPenalty = 1.0;
  if (totalMass > softCap) {
    const over = (totalMass - softCap) / softCap;
    capPenalty = clamp(1.0 - over * 0.55, 0.55, 1.0);
  }
  let v = 260 * sizePenalty * capPenalty;
  if (boosting) v *= 1.55;
  return v;
}

function grow(b, amount) {
  const softCap = 1400;
  const softCapMinPenalty = 0.25;
  let penalty = 1.0;
  if (b.mass > softCap) {
    penalty = clamp(softCap / b.mass, softCapMinPenalty, 1.0);
  }
  const gain = amount * penalty;
  b.mass += gain;
  b.r += gain * 0.22;
}

function makeRoom(code, maxPlayers = 60, bots = BOT_DEFAULT) {
  const seed = hashSeed(code);
  const rng = mulberry32(seed);

  const room = {
    code, seed, rng,
    maxPlayers: clamp(maxPlayers, 8, 80),
    bots: clamp(bots, 0, 120),
    t: 0,
    agents: new Map(),
    pellets: [],
    viruses: []
  };

  for (let i = 0; i < PELLET_TARGET; i++) {
    room.pellets.push({
      x: rng() * WORLD,
      y: rng() * WORLD,
      r: 4 + rng() * 5,
      v: 1 + Math.floor(rng() * 2)
    });
  }

  for (let i = 0; i < VIRUS_COUNT; i++) {
    room.viruses.push({
      x: 240 + rng() * (WORLD - 480),
      y: 240 + rng() * (WORLD - 480),
      r: 36
    });
  }

  const used = new Set();
  for (let i = 0; i < room.bots; i++) {
    let nm = "Bot" + Math.floor(rng() * 900 + 100);
    for (let tries = 0; tries < 200; tries++) {
      const candidate = BOT_NAMES[Math.floor(rng() * BOT_NAMES.length)];
      if (!used.has(candidate)) { used.add(candidate); nm = candidate; break; }
    }
    const id = "bot_" + i + "_" + code;
    room.agents.set(id, spawnAgent(id, nm, true, room.rng));
  }

  return room;
}

function tickRoom(room) {
  room.t += DT;

  // remove inactive humans
  const now = Date.now() / 1000;
  for (const [id, a] of room.agents.entries()) {
    if (!a.isBot && (now - (a.lastSeen || now)) > PLAYER_TTL) {
      room.agents.delete(id);
    }
  }

  // bot AI
  for (const a of room.agents.values()) {
    if (a.dead || !a.isBot) continue;
    const b = a.blobs[0];
    if (!b) continue;

    let aimX = 0, aimY = 0;
    let bestThreat = null, bestThreatD = 1e9;
    let bestPrey = null, bestPreyD = 1e9;

    for (const o of room.agents.values()) {
      if (o.id === a.id || o.dead) continue;
      for (const ob of o.blobs) {
        const d = Math.hypot(b.x - ob.x, b.y - ob.y);
        if (d < 900) {
          if (ob.r > b.r * 1.10 && d < bestThreatD) { bestThreatD = d; bestThreat = ob; }
          if (b.r > ob.r * 1.20 && d < bestPreyD) { bestPreyD = d; bestPrey = ob; }
        }
      }
    }

    if (bestThreat) {
      aimX = b.x - bestThreat.x; aimY = b.y - bestThreat.y;
      a.boost = false;
    } else if (bestPrey) {
      aimX = bestPrey.x - b.x; aimY = bestPrey.y - b.y;
      a.boost = Math.random() < 0.20;
    } else {
      const p = room.pellets[Math.floor(room.rng() * room.pellets.length)];
      if (p) { aimX = p.x - b.x; aimY = p.y - b.y; }
      a.boost = false;
    }

    const n = normalize(aimX, aimY);
    a.aimX = n[0]; a.aimY = n[1];
  }

  // movement + decay
  for (const a of room.agents.values()) {
    if (a.dead) continue;
    const total = agentMass(a);

    for (const b of a.blobs) {
      const v = baseSpeed(b.r, total, a.boost);
      b.x += a.aimX * v * DT;
      b.y += a.aimY * v * DT;

      b.x = clamp(b.x, b.r, WORLD - b.r);
      b.y = clamp(b.y, b.r, WORLD - b.r);

      b.x += b.vx * DT; b.y += b.vy * DT;
      b.vx *= (1 - clamp(DT * 3.8, 0, 1));
      b.vy *= (1 - clamp(DT * 3.8, 0, 1));
      b.splitTimer += DT;

      const decay = (a.isBot ? 0.16 : 0.22) * DT;
      b.mass = Math.max(10, b.mass - decay);
      b.r = Math.max(14, b.r - decay * 0.08);

      if (!a.isBot && a.boost) {
        const d = 1.75 * DT * (b.mass / Math.max(1, total));
        b.mass = Math.max(10, b.mass - d);
        b.r = Math.max(14, b.r - d * 0.12);
      }
    }
  }

  // eat pellets
  for (const a of room.agents.values()) {
    if (a.dead) continue;
    for (const b of a.blobs) {
      for (let i = room.pellets.length - 1; i >= 0; i--) {
        const p = room.pellets[i];
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < (b.r + p.r)) {
          grow(b, p.v);
          room.pellets.splice(i, 1);
        }
      }
    }
  }

  // refill pellets
  while (room.pellets.length < PELLET_TARGET) {
    const rng = room.rng;
    room.pellets.push({
      x: rng() * WORLD,
      y: rng() * WORLD,
      r: 4 + rng() * 5,
      v: 1 + Math.floor(rng() * 2)
    });
  }

  // viruses pop big blobs
  for (const a of room.agents.values()) {
    if (a.dead) continue;
    for (let bi = a.blobs.length - 1; bi >= 0; bi--) {
      const b = a.blobs[bi];
      for (const v of room.viruses) {
        const d = Math.hypot(b.x - v.x, b.y - v.y);
        if (d < (b.r + v.r)) {
          if (b.r >= 62) {
            const pieces = 8;
            const totalMass = b.mass;
            const pieceMass = totalMass / pieces;
            const pieceR = Math.max(14, b.r / Math.sqrt(pieces));
            a.blobs.splice(bi, 1);

            for (let k = 0; k < pieces; k++) {
              const ang = Math.random() * Math.PI * 2;
              const dx = Math.cos(ang), dy = Math.sin(ang);
              a.blobs.push({
                x: b.x + dx * (b.r + 10),
                y: b.y + dy * (b.r + 10),
                vx: dx * (270 + Math.random() * 220),
                vy: dy * (270 + Math.random() * 220),
                mass: pieceMass,
                r: pieceR,
                splitTimer: 0
              });
            }
          } else {
            const n = normalize(b.x - v.x, b.y - v.y);
            b.vx += n[0] * 220; b.vy += n[1] * 220;
          }
        }
      }
    }
  }

  // eat players (engulf rule)
  const arr = Array.from(room.agents.values());
  for (let i = 0; i < arr.length; i++) {
    const A = arr[i]; if (A.dead) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const B = arr[j]; if (B.dead) continue;

      for (let ai = A.blobs.length - 1; ai >= 0; ai--) {
        const ab = A.blobs[ai]; if (!ab) continue;
        for (let bi = B.blobs.length - 1; bi >= 0; bi--) {
          const bb = B.blobs[bi]; if (!bb) continue;

          if (canEat(ab.r, bb.r) && canEngulf(ab.x, ab.y, ab.r, bb.x, bb.y, bb.r)) {
            const ratio = clamp(bb.mass / Math.max(1, ab.mass), 0.12, 0.50);
            grow(ab, bb.mass * ratio);
            B.blobs.splice(bi, 1);
          } else if (canEat(bb.r, ab.r) && canEngulf(bb.x, bb.y, bb.r, ab.x, ab.y, ab.r)) {
            const ratio = clamp(ab.mass / Math.max(1, bb.mass), 0.12, 0.50);
            grow(bb, ab.mass * ratio);
            A.blobs.splice(ai, 1);
            break;
          }
        }
      }

      if (A.blobs.length === 0) A.dead = true;
      if (B.blobs.length === 0) B.dead = true;
    }
  }

  // respawn bots
  for (const a of room.agents.values()) {
    if (a.dead && a.isBot) {
      room.agents.set(a.id, spawnAgent(a.id, a.name, true, room.rng));
    }
  }
}

// ---- API ----

// Host creates a room
app.post("/create", (req, res) => {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();

  const maxPlayers = req.body?.maxPlayers ?? 60;
  const bots = req.body?.bots ?? BOT_DEFAULT;

  rooms.set(code, makeRoom(code, maxPlayers, bots));
  res.json({ ok: true, code });
});

// Join room
app.post("/join", (req, res) => {
  const code = String(req.body?.code || "").toUpperCase();
  const name = String(req.body?.name || "Player").slice(0, 14);
  const id = String(req.body?.id || ("p_" + Math.random().toString(36).slice(2)));

  const room = rooms.get(code);
  if (!room) return res.json({ ok: false, error: "Room not found" });

  let humans = 0;
  for (const a of room.agents.values()) if (!a.isBot) humans++;
  if (humans >= room.maxPlayers) return res.json({ ok: false, error: "Room full" });

  room.agents.set(id, spawnAgent(id, name, false, room.rng));
  res.json({ ok: true, id, code, world: WORLD });
});

// Send input (called repeatedly)
app.post("/input", (req, res) => {
  const code = String(req.body?.code || "").toUpperCase();
  const id = String(req.body?.id || "");
  const room = rooms.get(code);
  if (!room) return res.json({ ok: false });

  const a = room.agents.get(id);
  if (!a || a.dead) return res.json({ ok: false });

  a.lastSeen = Date.now() / 1000;

  const ax = Number(req.body?.aimX) || 0;
  const ay = Number(req.body?.aimY) || 0;
  const n = normalize(ax, ay);
  a.aimX = n[0]; a.aimY = n[1];
  a.boost = !!req.body?.boost;

  // optional: server split (client can request)
  if (req.body?.split === true) {
    let best = 0;
    for (let i = 1; i < a.blobs.length; i++) if (a.blobs[i].r > a.blobs[best].r) best = i;
    const b = a.blobs[best];
    if (b && b.r >= 14 * 2.2) {
      const dir = normalize(a.aimX, a.aimY);
      const newMass = b.mass * 0.5;
      b.mass *= 0.5;
      b.r = Math.max(14, b.r * 0.72);
      a.blobs.push({
        x: b.x + dir[0] * (b.r + 8),
        y: b.y + dir[1] * (b.r + 8),
        vx: dir[0] * 580,
        vy: dir[1] * 580,
        mass: newMass,
        r: Math.max(14, b.r),
        splitTimer: 0
      });
      b.splitTimer = 0;
    }
  }

  res.json({ ok: true });
});

// Get state snapshot (client polls this)
app.get("/state", (req, res) => {
  const code = String(req.query.code || "").toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.json({ ok: false, error: "Room not found" });

  const leaderboard = Array.from(room.agents.values())
    .filter(a => !a.dead)
    .map(a => ({ id: a.id, name: a.name, mass: Math.floor(agentMass(a)) }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);

  res.json({
    ok: true,
    t: room.t,
    world: WORLD,
    pellets: room.pellets,
    viruses: room.viruses,
    players: Array.from(room.agents.values())
      .filter(a => !a.dead)
      .map(a => ({
        id: a.id,
        name: a.name,
        col: a.col,
        blobs: a.blobs.map(b => ({ x: b.x, y: b.y, r: b.r })),
        mass: Math.floor(agentMass(a))
      })),
    leaderboard
  });
});

// Tick loop
setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("CellClash server running on port", PORT));
