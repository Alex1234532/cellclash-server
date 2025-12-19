//-----------------------------------------------------------
// CELL CLASH — PRO MULTIPLAYER SERVER
// Tick simulation — Players, Bots, Pellets, Viruses, Splitting
//-----------------------------------------------------------

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuid } = require("uuid");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT || 10000;

//-----------------------------------------------------------
// CONSTANTS — MUST MATCH CODEA
//-----------------------------------------------------------

const WORLD_SIZE = 5200;
const TICK_RATE = 30;

const PLAYER_START_MASS = 40;
const BOT_COUNT = 12;
const VIRUS_COUNT = 28;

const PELLET_MIN = 500;     // always maintain
const PELLET_RESPAWN = 550; // if below, spawn more

//-----------------------------------------------------------
// Utility functions
//-----------------------------------------------------------

function rand(min, max) {
    return Math.random() * (max - min) + min;
}

function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function normalize(v) {
    const d = Math.sqrt(v.x * v.x + v.y * v.y);
    if (d < 0.001) return { x: 0, y: 0 };
    return { x: v.x / d, y: v.y / d };
}

//-----------------------------------------------------------
// ROOMS
//-----------------------------------------------------------

let rooms = {};  
// structure:
// rooms[code] = { players: {}, bots: {}, pellets, viruses, lastActive }

//-----------------------------------------------------------
// Create a New Room
//-----------------------------------------------------------

function createRoom() {
    const code = uuid().slice(0, 6).toUpperCase();

    rooms[code] = {
        players: {},
        bots: {},
        pellets: [],
        viruses: [],
        lastActive: Date.now()
    };

    //----------------------------------------
    // Spawn pellets
    //----------------------------------------
    for (let i = 0; i < PELLET_RESPAWN; i++) {
        rooms[code].pellets.push({
            id: uuid(),
            x: rand(-WORLD_SIZE, WORLD_SIZE),
            y: rand(-WORLD_SIZE, WORLD_SIZE),
            r: rand(4, 8),
            value: rand(1, 3)
        });
    }

    //----------------------------------------
    // Spawn viruses
    //----------------------------------------
    for (let i = 0; i < VIRUS_COUNT; i++) {
        rooms[code].viruses.push({
            id: uuid(),
            x: rand(-WORLD_SIZE, WORLD_SIZE),
            y: rand(-WORLD_SIZE, WORLD_SIZE),
            r: 36
        });
    }

    //----------------------------------------
    // Spawn bots
    //----------------------------------------
    for (let i = 0; i < BOT_COUNT; i++) {
        rooms[code].bots[uuid()] = {
            id: uuid(),
            name: "Bot" + Math.floor(Math.random()*999),
            x: rand(-WORLD_SIZE, WORLD_SIZE),
            y: rand(-WORLD_SIZE, WORLD_SIZE),
            mass: PLAYER_START_MASS,
            vx: 0, vy: 0
        };
    }

    return code;
}

//-----------------------------------------------------------
// API — Create Room
//-----------------------------------------------------------

app.post("/create", (req, res) => {
    const code = createRoom();
    res.json({ ok: true, code });
});

//-----------------------------------------------------------
// API — Join Room
//-----------------------------------------------------------

app.post("/join", (req, res) => {
    const { code, name, color, pattern } = req.body;

    if (!rooms[code]) return res.json({ ok: false, error: "Room not found" });

    const id = uuid();

    rooms[code].players[id] = {
        id,
        name,
        color,
        pattern,
        x: rand(-500, 500),
        y: rand(-500, 500),
        mass: PLAYER_START_MASS,
        vx: 0, vy: 0,
        alive: true,
        input: { x: 0, y: 0 }
    };

    rooms[code].lastActive = Date.now();

    res.json({ ok: true, id });
});

//-----------------------------------------------------------
// API — Player input
//-----------------------------------------------------------

app.post("/input", (req, res) => {
    const { code, id, input } = req.body;

    if (!rooms[code] || !rooms[code].players[id]) {
        return res.json({ ok: false });
    }

    rooms[code].players[id].input = input;
    rooms[code].lastActive = Date.now();

    res.json({ ok: true });
});

//-----------------------------------------------------------
// API — World State (sent to Codea)
//-----------------------------------------------------------

app.get("/state", (req, res) => {
    const code = req.query.code;

    if (!rooms[code]) {
        return res.json({ ok: false, error: "Room not found" });
    }

    rooms[code].lastActive = Date.now();

    res.json({
        ok: true,
        players: rooms[code].players,
        bots: rooms[code].bots,
        pellets: rooms[code].pellets,
        viruses: rooms[code].viruses
    });
});

//-----------------------------------------------------------
// API — Ping
//-----------------------------------------------------------

app.get("/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

//-----------------------------------------------------------
// GAME LOOP — TICK SIMULATION
//-----------------------------------------------------------

setInterval(() => {

    for (const code in rooms) {
        const R = rooms[code];

        //----------------------------------------
        // Remove inactive rooms (20 min)
        //----------------------------------------
        if (Date.now() - R.lastActive > 20 * 60 * 1000) {
            delete rooms[code];
            continue;
        }

        //----------------------------------------
        // Update bots
        //----------------------------------------
        for (const bid in R.bots) {
            const b = R.bots[bid];

            // Random movement
            b.vx += rand(-0.5, 0.5);
            b.vy += rand(-0.5, 0.5);

            const n = normalize({ x: b.vx, y: b.vy });
            const speed = Math.max(1.2, 7.5 - b.mass * 0.003);

            b.x += n.x * speed;
            b.y += n.y * speed;
        }

        //----------------------------------------
        // Update players
        //----------------------------------------
        for (const pid in R.players) {
            const p = R.players[pid];
            if (!p.alive) continue;

            const d = normalize(p.input);
            const speed = Math.max(1.2, 7.5 - p.mass * 0.003);

            p.x += d.x * speed;
            p.y += d.y * speed;
        }

        //----------------------------------------
        // Player eats pellets
        //----------------------------------------
        for (const pid in R.players) {
            const P = R.players[pid];
            if (!P.alive) continue;

            for (let i = R.pellets.length - 1; i >= 0; i--) {
                const pel = R.pellets[i];
                if (dist(P, pel) < P.mass * 0.25) {
                    P.mass += pel.value;
                    R.pellets.splice(i, 1);
                }
            }
        }

        //----------------------------------------
        // Respawn pellets
        //----------------------------------------
        while (R.pellets.length < PELLET_MIN) {
            R.pellets.push({
                id: uuid(),
                x: rand(-WORLD_SIZE, WORLD_SIZE),
                y: rand(-WORLD_SIZE, WORLD_SIZE),
                r: rand(4, 8),
                value: rand(1, 3)
            });
        }

        //----------------------------------------
        // Player-vs-player eating
        //----------------------------------------
        const allP = Object.values(R.players);
        for (let i = 0; i < allP.length; i++) {
            for (let j = 0; j < allP.length; j++) {
                if (i === j) continue;

                const A = allP[i];
                const B = allP[j];

                if (!A.alive || !B.alive) continue;

                if (A.mass > B.mass * 1.25 && dist(A, B) < A.mass * 0.20) {
                    A.mass += B.mass * 0.85;
                    B.alive = false;
                }
            }
        }
    }

}, 1000 / TICK_RATE);

//-----------------------------------------------------------
// START SERVER
//-----------------------------------------------------------

app.listen(PORT, () => {
    console.log("CellClash PRO server running on port", PORT);
});
