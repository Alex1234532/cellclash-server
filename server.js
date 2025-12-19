//-----------------------------------------------------------
// CELL CLASH — PRO MULTIPLAYER SERVER
// Authoritative tick-based world like Agar.io
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
// Utility
//-----------------------------------------------------------

function rand(min, max) {
    return Math.random() * (max - min) + min;
}

function newVec() {
    return { x: 0, y: 0 };
}

function normalize(v) {
    const d = Math.sqrt(v.x * v.x + v.y * v.y);
    if (d < 0.001) return { x: 0, y: 0 };
    return { x: v.x / d, y: v.y / d };
}

function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

//-----------------------------------------------------------
// CONSTANTS — MUST MATCH CODEA
//-----------------------------------------------------------

const WORLD_SIZE = 5200;
const TICK_RATE = 30;
const PLAYER_START_MASS = 40;
const VIRUS_COUNT = 28;
const VIRUS_R = 36;

//-----------------------------------------------------------
// Rooms
//-----------------------------------------------------------

let rooms = {}; // roomCode => { players, bots, pellets, viruses }

//-----------------------------------------------------------
// Create a new room
//-----------------------------------------------------------

function createRoom() {
    const code = uuid().slice(0, 6).toUpperCase();

    rooms[code] = {
        players: {},
        bots: {},
        pellets: [],
        viruses: [],
        created: Date.now(),
        lastActive: Date.now()
    };

    // Generate pellets
    for (let i = 0; i < 500; i++) {
        rooms[code].pellets.push({
            id: uuid(),
            x: rand(-WORLD_SIZE, WORLD_SIZE),
            y: rand(-WORLD_SIZE, WORLD_SIZE),
            r: rand(4, 8),
            value: rand(1, 3)
        });
    }

    // Generate viruses
    for (let i = 0; i < VIRUS_COUNT; i++) {
        rooms[code].viruses.push({
            id: uuid(),
            x: rand(-WORLD_SIZE, WORLD_SIZE),
            y: rand(-WORLD_SIZE, WORLD_SIZE),
            r: VIRUS_R
        });
    }

    return code;
}

//-----------------------------------------------------------
// Join room
//-----------------------------------------------------------

app.post("/join", (req, res) => {
    const { code, name, color, pattern } = req.body;

    if (!rooms[code]) {
        return res.json({ ok: false, error: "Room not found" });
    }

    const id = uuid();

    rooms[code].players[id] = {
        id,
        name,
        color,
        pattern,
        x: rand(-500, 500),
        y: rand(-500, 500),
        vx: 0,
        vy: 0,
        mass: PLAYER_START_MASS,
        alive: true,
        input: { x: 0, y: 0 }
    };

    rooms[code].lastActive = Date.now();

    res.json({ ok: true, id });
});

//-----------------------------------------------------------
// Create room
//-----------------------------------------------------------

app.post("/create", (req, res) => {
    const code = createRoom();
    res.json({ ok: true, code });
});

//-----------------------------------------------------------
// Input updates from clients
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
// World state
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
        pellets: rooms[code].pellets,
        viruses: rooms[code].viruses
    });
});

//-----------------------------------------------------------
// Ping
//-----------------------------------------------------------

app.get("/ping", (req, res) => {
    res.json({ ok: true, msg: "pong" });
});

//-----------------------------------------------------------
// Tick simulation
//-----------------------------------------------------------

setInterval(() => {

    for (const code in rooms) {
        const room = rooms[code];

        // Cleanup unused rooms
        if (Date.now() - room.lastActive > 1000 * 60 * 25) {
            delete rooms[code];
            continue;
        }

        // Update players
        Object.values(room.players).forEach(p => {
            if (!p.alive) return;

            const dir = normalize(p.input);
            const speed = Math.max(1.2, 7.5 - p.mass * 0.003);

            p.x += dir.x * speed;
            p.y += dir.y * speed;
        });

        // Player–Pellet eating
        for (const pid in room.players) {
            const p = room.players[pid];
            for (let i = room.pellets.length - 1; i >= 0; i--) {
                const pel = room.pellets[i];
                if (dist(p, pel) < p.mass * 0.25) {
                    p.mass += pel.value;
                    room.pellets.splice(i, 1);
                }
            }
        }

        // Respawn pellets
        while (room.pellets.length < 500) {
            room.pellets.push({
                id: uuid(),
                x: rand(-WORLD_SIZE, WORLD_SIZE),
                y: rand(-WORLD_SIZE, WORLD_SIZE),
                r: rand(4, 8),
                value: rand(1, 3)
            });
        }

        // Player–Player eating
        const players = Object.values(room.players);
        for (let i = 0; i < players.length; i++) {
            for (let j = 0; j < players.length; j++) {
                if (i === j) continue;

                const A = players[i];
                const B = players[j];

                if (!A.alive || !B.alive) continue;

                if (A.mass > B.mass * 1.22 && dist(A, B) < A.mass * 0.22) {
                    A.mass += B.mass * 0.9;
                    B.alive = false;
                }
            }
        }
    }

}, 1000 / TICK_RATE);

//-----------------------------------------------------------
// Start server
//-----------------------------------------------------------

app.listen(PORT, () => {
    console.log("CellClash server running on port", PORT);
});
