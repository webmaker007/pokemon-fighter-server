"use strict";

/*
============================================================
 POKÉMON FIGHTER — REAL-TIME MATCH SERVER

 One always-on Node process that:
   1. Verifies each connecting player is a real signed-in Firebase
      user (so nobody can connect without a real account).
   2. Pairs exactly two connections that show up with the same
      roomId into a match.
   3. Runs the authoritative battle simulation (src/battle-sim.js)
      at a fixed tick rate — this is the "referee." Neither client
      runs its own physics for an online match; they just send
      inputs and render whatever this server broadcasts back.
   4. Reports the final result to Firestore directly (using
      firebase-admin, which bypasses normal Firestore security
      rules) so a tampered client can't fake a win.

 roomId values themselves come from Firestore matchmaking/room-code
 logic on the client side (a separate piece) — this server doesn't
 care how two players agreed on a roomId, only that exactly two of
 them show up with the same one.
============================================================ */

const http = require("http");
const { WebSocketServer } = require("ws");
const admin = require("firebase-admin");

const battleSim = require("./battle-sim");

/* ------------------------------------------------------------
   FIREBASE ADMIN SETUP

   Set the FIREBASE_SERVICE_ACCOUNT_KEY environment variable (on
   Render: Environment tab) to the full contents of a service
   account JSON key downloaded from:
   Firebase Console → Project settings → Service accounts →
   "Generate new private key". Paste the WHOLE file content as
   the env var's value (it's one JSON object).
------------------------------------------------------------ */

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error(
    "[fatal] FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.",
  );

  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error(
    "[fatal] FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON:",
    e.message,
  );

  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ------------------------------------------------------------
   HTTP + WEBSOCKET SERVER

   A plain HTTP server with a tiny health-check route (Render pings
   this to know the service is alive) plus the WebSocket upgrade.
------------------------------------------------------------ */

const PORT = process.env.PORT || 8080;

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

const DISCONNECT_FORFEIT_MS = 20000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pokemon Fighter match server is running.\n");
});

const wss = new WebSocketServer({ server: httpServer });

/* rooms: roomId -> { sockets: {a: ws|null, b: ws|null},
                       uids: {a: string|null, b: string|null},
                       match: object|null,
                       timer: intervalId|null,
                       lastTick: number,
                       disconnectTimer: {a, b} } */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);

  if (!room) {
    room = {
      roomId: roomId,
      sockets: { a: null, b: null },
      uids: { a: null, b: null },
      match: null,
      timer: null,
      lastTick: 0,
      disconnectTimers: { a: null, b: null },
    };

    rooms.set(roomId, room);
  }

  return room;
}

function sideFor(room, uid) {
  if (room.uids.a === uid) return "a";
  if (room.uids.b === uid) return "b";
  return null;
}

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload) {
  send(room.sockets.a, payload);
  send(room.sockets.b, payload);
}

/* ------------------------------------------------------------
   CONNECTION HANDLING
------------------------------------------------------------ */

wss.on("connection", async (ws, req) => {
  let url;

  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    ws.close(4000, "bad_request");
    return;
  }

  const token = url.searchParams.get("token");
  const roomId = url.searchParams.get("room");

  if (!token || !roomId) {
    ws.close(4001, "missing_token_or_room");
    return;
  }

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    ws.close(4002, "invalid_token");
    return;
  }

  const uid = decoded.uid;

  const room = getOrCreateRoom(roomId);

  /* Reconnect case: this uid already had a seat in this room. */
  let side = sideFor(room, uid);

  if (side) {
    clearDisconnectTimer(room, side);
    room.sockets[side] = ws;
  } else if (!room.uids.a) {
    side = "a";
    room.uids.a = uid;
    room.sockets.a = ws;
  } else if (!room.uids.b && room.uids.a !== uid) {
    side = "b";
    room.uids.b = uid;
    room.sockets.b = ws;
  } else {
    ws.close(4003, "room_full");
    return;
  }

  ws.side = side;
  ws.roomId = roomId;
  ws.uid = uid;
  ws.ready = false;

  send(ws, { type: "joined", side });

  ws.on("message", (raw) => handleMessage(room, ws, raw));

  ws.on("close", () => handleDisconnect(room, ws));
});

function handleMessage(room, ws, raw) {
  let msg;

  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    return;
  }

  if (msg.type === "ready") {
    handleReady(room, ws, msg);
    return;
  }

  if (!room.match) {
    return;
  }

  if (msg.type === "input") {
    battleSim.setInput(room.match, ws.side, {
      left: msg.left,
      right: msg.right,
      block: msg.block,
    });

    if (Array.isArray(msg.actions) && msg.actions.length) {
      battleSim.queueActions(room.match, ws.side, msg.actions);
    }
  }
}

/* Both players send "ready" with their team roster (name + resolved
   move data) once they've loaded the battle screen. The match only
   starts once both are in. */
function handleReady(room, ws, msg) {
  ws.team = sanitizeTeam(msg.team);
  ws.ready = true;

  const otherWs = ws.side === "a" ? room.sockets.b : room.sockets.a;

  send(ws, { type: "waiting_for_opponent" });

  if (
    room.sockets.a &&
    room.sockets.b &&
    room.sockets.a.ready &&
    room.sockets.b.ready &&
    !room.match
  ) {
    startMatch(room);
  } else if (otherWs) {
    send(otherWs, { type: "opponent_ready" });
  }
}

function sanitizeTeam(team) {
  if (!Array.isArray(team) || !team.length) {
    return [
      {
        name: "unknown",
        hp: battleSim.GAME.maxHP,
        move: {
          name: "Tackle",
          type: "normal",
          damage: 15,
          range: 150,
          projectile: false,
          speed: 12,
          color: "#ffffff",
        },
      },
    ];
  }

  return team.slice(0, 6).map((p) => ({
    name: String((p && p.name) || "unknown").slice(0, 40),
    hp: battleSim.GAME.maxHP,
    move: sanitizeMove(p && p.move),
  }));
}

function sanitizeMove(move) {
  const m = move || {};

  return {
    name: String(m.name || "Tackle").slice(0, 40),
    type: String(m.type || "normal").slice(0, 20),
    damage: clampNumber(m.damage, 1, 60, 15),
    range: clampNumber(m.range, 50, 500, 150),
    projectile: !!m.projectile,
    speed: clampNumber(m.speed, 1, 40, 12),
    color: /^#[0-9a-fA-F]{3,8}$/.test(m.color || "") ? m.color : "#ffffff",
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, n));
}

function startMatch(room) {
  room.match = battleSim.createMatch(room.sockets.a.team, room.sockets.b.team);

  broadcast(room, { type: "start" });

  room.lastTick = Date.now();

  room.timer = setInterval(() => tickRoom(room), TICK_MS);
}

function tickRoom(room) {
  if (!room.match) {
    return;
  }

  const now = Date.now();
  const elapsed = now - room.lastTick;

  room.lastTick = now;

  /* dt of 1 ≈ one 16.666ms frame, matching battle-sim's own
     convention (ported straight from the client's 60fps model).
     Clamp so a hiccup/stall doesn't cause one giant catch-up step. */
  const dt = Math.max(0.5, Math.min(3, elapsed / 16.666));

  battleSim.step(room.match, dt);

  broadcast(room, { type: "state", snapshot: battleSim.snapshot(room.match) });

  if (room.match.ended) {
    endMatch(room, room.match.winner === "a" ? room.uids.a : room.uids.b);
  }
}

async function endMatch(room, winnerUid, reason) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  const loserUid = winnerUid === room.uids.a ? room.uids.b : room.uids.a;

  broadcast(room, {
    type: "match_over",
    winnerUid: winnerUid,
    reason: reason || "ko",
  });

  /* Record the result server-side (bypasses Firestore rules via
     firebase-admin) so a tampered client can't fabricate a win.
     Reward amounts (coins/rank) are intentionally NOT decided
     here yet — this just records the verified fact of who won,
     for the client/app.js to react to and for you to later hook
     up whatever reward logic you want, in one trusted place. */
  try {
    await db.collection("matches").add({
      roomId: room.roomId || null,
      players: [room.uids.a, room.uids.b],
      winnerUid: winnerUid,
      loserUid: loserUid,
      reason: reason || "ko",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("[match] failed to record result:", e.message);
  }

  rooms.delete(room.roomId);
}

function handleDisconnect(room, ws) {
  if (room.sockets[ws.side] === ws) {
    room.sockets[ws.side] = null;
  }

  if (!room.match || room.match.ended) {
    /* Never actually started (or already over) — just clean up if
       both sides are now gone. */
    if (!room.sockets.a && !room.sockets.b) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(room.roomId);
    }

    return;
  }

  const otherSide = ws.side === "a" ? "b" : "a";

  send(room.sockets[otherSide], { type: "opponent_disconnected" });

  /* Give them a window to reconnect (e.g. a flaky connection or
     phone lock screen) before awarding the match by forfeit. */
  room.disconnectTimers[ws.side] = setTimeout(() => {
    if (!room.sockets[ws.side] && room.match && !room.match.ended) {
      endMatch(room, room.uids[otherSide], "forfeit");
    }
  }, DISCONNECT_FORFEIT_MS);
}

function clearDisconnectTimer(room, side) {
  if (room.disconnectTimers[side]) {
    clearTimeout(room.disconnectTimers[side]);
    room.disconnectTimers[side] = null;
  }
}

httpServer.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
