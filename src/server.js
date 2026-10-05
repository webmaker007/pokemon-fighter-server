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

/* ------------------------------------------------------------
   WAGERS

   The server — not either client — decides what the stake is and
   who gets paid. Both players must send the SAME allowed bet in
   their "ready" message or the match is cancelled. Stakes are
   taken at match start and the pot is paid at the end by writing
   "wallet adjustment" entries (walletAdjustments/{uid}/entries/{id})
   with firebase-admin. Clients can only READ and delete their own
   entries (see firestore.rules), so they can't forge winnings.
   Entry ids are deterministic per match, so a retry can never pay
   twice (create() fails if the id already exists).
------------------------------------------------------------ */

const ALLOWED_BETS = [
  { amount: 50, currency: "coins" },
  { amount: 150, currency: "coins" },
  { amount: 5, currency: "gems" },
  { amount: 15, currency: "gems" },
];

function sanitizeBet(bet) {
  const amount = Number(bet && bet.amount);
  const currency = bet && bet.currency === "gems" ? "gems" : "coins";

  const ok = ALLOWED_BETS.some(
    (b) => b.amount === amount && b.currency === currency,
  );

  return ok ? { amount, currency } : { amount: 0, currency: "coins" };
}

function adjustmentRef(uid, entryId) {
  return db
    .collection("walletAdjustments")
    .doc(uid)
    .collection("entries")
    .doc(entryId);
}

function writeAdjustment(batch, uid, entryId, bet, sign, reason, matchId) {
  batch.create(adjustmentRef(uid, entryId), {
    currency: bet.currency,
    delta: sign * bet.amount,
    reason: reason,
    matchId: matchId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Best-effort affordability check against each player's cloud save
   (players/{uid}). A missing/non-numeric balance counts as 0. */
async function canBothAfford(uidA, uidB, bet) {
  const field = bet.currency === "gems" ? "gems" : "coins";

  const [snapA, snapB] = await Promise.all([
    db.collection("players").doc(uidA).get(),
    db.collection("players").doc(uidB).get(),
  ]);

  /* A player whose save hasn't synced to the cloud yet has no
     numeric balance on record — don't block them (their device still
     checks its own balance). Only block a KNOWN balance that is too
     low. */
  const enough = (snap) => {
    const v = snap.exists ? snap.data()[field] : undefined;
    return typeof v !== "number" || v >= bet.amount;
  };

  return enough(snapA) && enough(snapB);
}

/* Takes both stakes (as negative entries) and records an "active"
   wager so a server restart mid-match can refund it (see
   refundStaleWagers). Returns false if the stake couldn't be taken. */
async function takeStakes(room) {
  const bet = room.bet;

  if (!bet || !bet.amount) return true;

  try {
    const batch = db.batch();

    writeAdjustment(batch, room.uids.a, room.matchId + "_stake", bet, -1, "wager_stake", room.matchId);
    writeAdjustment(batch, room.uids.b, room.matchId + "_stake", bet, -1, "wager_stake", room.matchId);

    batch.create(db.collection("wagers").doc(room.matchId), {
      players: [room.uids.a, room.uids.b],
      amount: bet.amount,
      currency: bet.currency,
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return true;
  } catch (e) {
    console.error("[wager] failed to take stakes:", e.message);
    return false;
  }
}

/* Pays the pot (2x stake) to the winner and closes the wager. */
async function payOutWager(room, winnerUid) {
  const bet = room.bet;

  if (!bet || !bet.amount || !room.matchId) return;

  try {
    const batch = db.batch();

    writeAdjustment(batch, winnerUid, room.matchId + "_payout", { amount: bet.amount * 2, currency: bet.currency }, 1, "wager_win", room.matchId);

    batch.update(db.collection("wagers").doc(room.matchId), {
      status: "settled",
      winnerUid: winnerUid,
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
  } catch (e) {
    console.error("[wager] failed to pay out:", e.message);
  }
}

/* On boot: any wager still "active" belongs to a match this process
   never finished (Render restarted/spun down mid-match). Refund both
   stakes so nobody loses currency to a crash. */
async function refundStaleWagers() {
  try {
    const snap = await db.collection("wagers").where("status", "==", "active").get();

    for (const doc of snap.docs) {
      const w = doc.data();
      const bet = { amount: w.amount, currency: w.currency };
      const batch = db.batch();

      for (const uid of w.players || []) {
        writeAdjustment(batch, uid, doc.id + "_refund", bet, 1, "wager_refund", doc.id);
      }

      batch.update(doc.ref, {
        status: "refunded",
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      console.log("[wager] refunded stale wager " + doc.id);
    }
  } catch (e) {
    console.error("[wager] stale refund failed:", e.message);
  }
}

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
  /* Serialize once, send to both players (this runs 30x/sec). */
  const text = JSON.stringify(payload);

  [room.sockets.a, room.sockets.b].forEach((ws) => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(text);
    }
  });
}

/* ------------------------------------------------------------
   CONNECTION HANDLING
------------------------------------------------------------ */

wss.on("connection", async (ws, req) => {
  let url;

  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    console.error("[ws] bad request url:", req.url);
    ws.close(4000, "bad_request");
    return;
  }

  const token = url.searchParams.get("token");
  const roomId = url.searchParams.get("room");

  if (!token || !roomId) {
    console.error("[ws] missing token or room on connect");
    ws.close(4001, "missing_token_or_room");
    return;
  }

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    console.error("[ws] token verification failed:", e.message);
    ws.close(4002, "invalid_token");
    return;
  }

  const uid = decoded.uid;

  console.log("[ws] connected: uid=" + uid + " room=" + roomId);

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
    console.error(
      "[ws] room full: room=" + roomId + " uid=" + uid +
        " a=" + room.uids.a + " b=" + room.uids.b,
    );
    ws.close(4003, "room_full");
    return;
  }

  console.log("[ws] assigned side=" + side + " room=" + roomId);

  ws.side = side;
  ws.roomId = roomId;
  ws.uid = uid;
  ws.ready = false;

  send(ws, { type: "joined", side });

  if (room.match && !room.match.ended && room.teams) {
    const other = side === "a" ? "b" : "a";

    send(ws, {
      type: "resume",
      side: side,
      myTeam: room.teams[side],
      opponentTeam: room.teams[other],
      bet: room.bet || null,
      snapshot: battleSim.snapshot(room.match),
    });

    send(room.sockets[other], { type: "opponent_reconnected" });

    console.log("[ws] resumed: uid=" + uid + " room=" + roomId + " side=" + side);
  }

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

  if (msg.type === "ping") {
    send(ws, { type: "pong", t: msg.t });
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
  /* A player who reconnected mid-match re-sends "ready" out of habit
     (the client does it on every "joined"). The match is already
     running and the server already sent "resume" — ignore it. */
  if (room.match) {
    return;
  }

  ws.team = sanitizeTeam(msg.team);
  ws.bet = sanitizeBet(msg.bet);
  ws.ready = true;

  console.log(
    "[ws] ready: room=" + room.roomId + " side=" + ws.side +
      " incomingTeamLen=" +
      (Array.isArray(msg.team) ? msg.team.length : "not-an-array:" + typeof msg.team) +
      " sanitizedLen=" + ws.team.length,
  );

  const otherWs = ws.side === "a" ? room.sockets.b : room.sockets.a;

  send(ws, { type: "waiting_for_opponent" });

  if (
    room.sockets.a &&
    room.sockets.b &&
    room.sockets.a.ready &&
    room.sockets.b.ready &&
    !room.match &&
    !room.starting
  ) {
    startMatch(room);
  } else if (otherWs) {
    send(otherWs, { type: "opponent_ready" });
  }
}

/* ------------------------------------------------------------
   AUTHORITATIVE POKÉMON TYPES

   Type effectiveness needs each Pokémon's real types. Look them up
   from PokéAPI by id (cached), so a modified client can't claim e.g.
   a Ghost type to dodge Normal hits. If the lookup fails or times
   out, the match falls back to the types the client reported.
------------------------------------------------------------ */

const typeCache = new Map();

async function fetchTypesFor(id) {
  if (!id) return null;

  if (typeCache.has(id)) return typeCache.get(id);

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);

    const res = await fetch("https://pokeapi.co/api/v2/pokemon/" + id, {
      signal: ctl.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();

    const types = (data.types || [])
      .map((t) => t && t.type && t.type.name)
      .filter((t) => typeof t === "string");

    if (types.length) {
      typeCache.set(id, types);

      return types;
    }
  } catch (e) {
    /* Fall back to client-reported types. */
  }

  return null;
}

async function attachAuthoritativeTypes(team) {
  await Promise.all(
    team.map(async (p) => {
      const types = await fetchTypesFor(p.id);

      if (types) p.simTypes = types;
    }),
  );
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
    id: clampNumber(p && p.id, 1, 100000, 0) || undefined,
    height: clampNumber(p && p.height, 0, 1000, undefined),
    types: sanitizeTypes(p && p.types),
    hp: battleSim.GAME.maxHP,
    move: sanitizeMove(p && p.move),
  }));
}

function sanitizeTypes(types) {
  if (!Array.isArray(types)) {
    return undefined;
  }

  /* Cosmetic only (which sprite/name shows on the opponent's
     screen) — not used by the authoritative simulation at all, so
     this only needs to be well-formed enough not to break
     rendering, not airtight against a tampered value. */
  return types.slice(0, 4).map((t) => ({
    type: { name: String((t && t.type && t.type.name) || "normal").slice(0, 20) },
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

async function startMatch(room) {
  /* Lock the room so a second "ready" can't start it twice while
     the async wager checks below are running. */
  room.starting = true;

  const betA = room.sockets.a.bet || { amount: 0, currency: "coins" };
  const betB = room.sockets.b.bet || { amount: 0, currency: "coins" };

  if (betA.amount !== betB.amount || betA.currency !== betB.currency) {
    cancelMatch(room, "bet_mismatch");
    return;
  }

  room.bet = betA;
  room.matchId = room.roomId + "_" + Date.now();

  if (room.bet.amount) {
    let affordable = false;

    try {
      affordable = await canBothAfford(room.uids.a, room.uids.b, room.bet);
    } catch (e) {
      console.error("[wager] balance check failed:", e.message);
    }

    if (!affordable) {
      cancelMatch(room, "cannot_afford");
      return;
    }

    if (!(await takeStakes(room))) {
      cancelMatch(room, "wager_failed");
      return;
    }
  }

  /* A player may have left while the checks ran. */
  if (!room.sockets.a || !room.sockets.b) {
    if (room.bet && room.bet.amount) {
      await refundRoomWager(room);
    }

    cancelMatch(room, "opponent_left");
    return;
  }

  console.log(
    "[ws] starting match: room=" + room.roomId +
      " teamA.len=" + room.sockets.a.team.length +
      " teamB.len=" + room.sockets.b.team.length,
  );

  await attachAuthoritativeTypes(room.sockets.a.team);
  await attachAuthoritativeTypes(room.sockets.b.team);

  /* A player may have left while the type lookups ran. */
  if (!room.sockets.a || !room.sockets.b) {
    if (room.bet && room.bet.amount) {
      await refundRoomWager(room);
    }

    cancelMatch(room, "opponent_left");
    return;
  }

  room.match = battleSim.createMatch(room.sockets.a.team, room.sockets.b.team);

  /* Kept so a player who drops and reconnects mid-match can be sent
     everything they need to pick up where they left off. */
  room.teams = { a: room.sockets.a.team, b: room.sockets.b.team };

  send(room.sockets.a, {
    type: "start",
    myTeam: room.sockets.a.team,
    opponentTeam: room.sockets.b.team,
    bet: room.bet,
  });

  send(room.sockets.b, {
    type: "start",
    myTeam: room.sockets.b.team,
    opponentTeam: room.sockets.a.team,
    bet: room.bet,
  });

  console.log("[ws] \"start\" sent to both sides: room=" + room.roomId);

  room.lastTick = Date.now();

  room.timer = setInterval(() => tickRoom(room), TICK_MS);
}

function cancelMatch(room, reason) {
  console.log("[ws] match cancelled: room=" + room.roomId + " reason=" + reason);

  broadcast(room, { type: "match_cancelled", reason: reason });

  if (room.timer) clearInterval(room.timer);

  rooms.delete(room.roomId);

  [room.sockets.a, room.sockets.b].forEach((sock) => {
    if (sock) {
      try {
        sock.close(1000, reason);
      } catch (e) {
        /* Already closed. */
      }
    }
  });
}

/* Gives both stakes back when a match never actually began. */
async function refundRoomWager(room) {
  try {
    const batch = db.batch();

    writeAdjustment(batch, room.uids.a, room.matchId + "_refund", room.bet, 1, "wager_refund", room.matchId);
    writeAdjustment(batch, room.uids.b, room.matchId + "_refund", room.bet, 1, "wager_refund", room.matchId);

    batch.update(db.collection("wagers").doc(room.matchId), {
      status: "refunded",
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
  } catch (e) {
    console.error("[wager] refund failed:", e.message);
  }
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
  /* Guard: a KO and a forfeit timer (or a duplicate tick) must never
     settle the same match twice. */
  if (room.settled) {
    return;
  }

  room.settled = true;

  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  const loserUid = winnerUid === room.uids.a ? room.uids.b : room.uids.a;

  broadcast(room, {
    type: "match_over",
    winnerUid: winnerUid,
    reason: reason || "ko",
    bet: room.bet || null,
  });

  await payOutWager(room, winnerUid);

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
      bet: room.bet || null,
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("[match] failed to record result:", e.message);
  }

  rooms.delete(room.roomId);
}

function handleDisconnect(room, ws) {
  /* This socket was already replaced by a reconnect (the player came
     back before the old, half-dead connection finally timed out).
     Nothing to do — in particular don't start a forfeit timer for a
     player who is actually still here. */
  if (room.sockets[ws.side] !== ws) {
    return;
  }

  room.sockets[ws.side] = null;

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

refundStaleWagers();

httpServer.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
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

/* ------------------------------------------------------------
   WAGERS

   The server — not either client — decides what the stake is and
   who gets paid. Both players must send the SAME allowed bet in
   their "ready" message or the match is cancelled. Stakes are
   taken at match start and the pot is paid at the end by writing
   "wallet adjustment" entries (walletAdjustments/{uid}/entries/{id})
   with firebase-admin. Clients can only READ and delete their own
   entries (see firestore.rules), so they can't forge winnings.
   Entry ids are deterministic per match, so a retry can never pay
   twice (create() fails if the id already exists).
------------------------------------------------------------ */

const ALLOWED_BETS = [
  { amount: 50, currency: "coins" },
  { amount: 150, currency: "coins" },
  { amount: 5, currency: "gems" },
  { amount: 15, currency: "gems" },
];

function sanitizeBet(bet) {
  const amount = Number(bet && bet.amount);
  const currency = bet && bet.currency === "gems" ? "gems" : "coins";

  const ok = ALLOWED_BETS.some(
    (b) => b.amount === amount && b.currency === currency,
  );

  return ok ? { amount, currency } : { amount: 0, currency: "coins" };
}

function adjustmentRef(uid, entryId) {
  return db
    .collection("walletAdjustments")
    .doc(uid)
    .collection("entries")
    .doc(entryId);
}

function writeAdjustment(batch, uid, entryId, bet, sign, reason, matchId) {
  batch.create(adjustmentRef(uid, entryId), {
    currency: bet.currency,
    delta: sign * bet.amount,
    reason: reason,
    matchId: matchId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Best-effort affordability check against each player's cloud save
   (players/{uid}). A missing/non-numeric balance counts as 0. */
async function canBothAfford(uidA, uidB, bet) {
  const field = bet.currency === "gems" ? "gems" : "coins";

  const [snapA, snapB] = await Promise.all([
    db.collection("players").doc(uidA).get(),
    db.collection("players").doc(uidB).get(),
  ]);

  /* A player whose save hasn't synced to the cloud yet has no
     numeric balance on record — don't block them (their device still
     checks its own balance). Only block a KNOWN balance that is too
     low. */
  const enough = (snap) => {
    const v = snap.exists ? snap.data()[field] : undefined;
    return typeof v !== "number" || v >= bet.amount;
  };

  return enough(snapA) && enough(snapB);
}

/* Takes both stakes (as negative entries) and records an "active"
   wager so a server restart mid-match can refund it (see
   refundStaleWagers). Returns false if the stake couldn't be taken. */
async function takeStakes(room) {
  const bet = room.bet;

  if (!bet || !bet.amount) return true;

  try {
    const batch = db.batch();

    writeAdjustment(batch, room.uids.a, room.matchId + "_stake", bet, -1, "wager_stake", room.matchId);
    writeAdjustment(batch, room.uids.b, room.matchId + "_stake", bet, -1, "wager_stake", room.matchId);

    batch.create(db.collection("wagers").doc(room.matchId), {
      players: [room.uids.a, room.uids.b],
      amount: bet.amount,
      currency: bet.currency,
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return true;
  } catch (e) {
    console.error("[wager] failed to take stakes:", e.message);
    return false;
  }
}

/* Pays the pot (2x stake) to the winner and closes the wager. */
async function payOutWager(room, winnerUid) {
  const bet = room.bet;

  if (!bet || !bet.amount || !room.matchId) return;

  try {
    const batch = db.batch();

    writeAdjustment(batch, winnerUid, room.matchId + "_payout", { amount: bet.amount * 2, currency: bet.currency }, 1, "wager_win", room.matchId);

    batch.update(db.collection("wagers").doc(room.matchId), {
      status: "settled",
      winnerUid: winnerUid,
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
  } catch (e) {
    console.error("[wager] failed to pay out:", e.message);
  }
}

/* On boot: any wager still "active" belongs to a match this process
   never finished (Render restarted/spun down mid-match). Refund both
   stakes so nobody loses currency to a crash. */
async function refundStaleWagers() {
  try {
    const snap = await db.collection("wagers").where("status", "==", "active").get();

    for (const doc of snap.docs) {
      const w = doc.data();
      const bet = { amount: w.amount, currency: w.currency };
      const batch = db.batch();

      for (const uid of w.players || []) {
        writeAdjustment(batch, uid, doc.id + "_refund", bet, 1, "wager_refund", doc.id);
      }

      batch.update(doc.ref, {
        status: "refunded",
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      console.log("[wager] refunded stale wager " + doc.id);
    }
  } catch (e) {
    console.error("[wager] stale refund failed:", e.message);
  }
}

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
  /* Serialize once, send to both players (this runs 30x/sec). */
  const text = JSON.stringify(payload);

  [room.sockets.a, room.sockets.b].forEach((ws) => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(text);
    }
  });
}

/* ------------------------------------------------------------
   CONNECTION HANDLING
------------------------------------------------------------ */

wss.on("connection", async (ws, req) => {
  let url;

  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    console.error("[ws] bad request url:", req.url);
    ws.close(4000, "bad_request");
    return;
  }

  const token = url.searchParams.get("token");
  const roomId = url.searchParams.get("room");

  if (!token || !roomId) {
    console.error("[ws] missing token or room on connect");
    ws.close(4001, "missing_token_or_room");
    return;
  }

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    console.error("[ws] token verification failed:", e.message);
    ws.close(4002, "invalid_token");
    return;
  }

  const uid = decoded.uid;

  console.log("[ws] connected: uid=" + uid + " room=" + roomId);

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
    console.error(
      "[ws] room full: room=" + roomId + " uid=" + uid +
        " a=" + room.uids.a + " b=" + room.uids.b,
    );
    ws.close(4003, "room_full");
    return;
  }

  console.log("[ws] assigned side=" + side + " room=" + roomId);

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

  if (msg.type === "ping") {
    send(ws, { type: "pong", t: msg.t });
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
  ws.bet = sanitizeBet(msg.bet);
  ws.ready = true;

  console.log(
    "[ws] ready: room=" + room.roomId + " side=" + ws.side +
      " incomingTeamLen=" +
      (Array.isArray(msg.team) ? msg.team.length : "not-an-array:" + typeof msg.team) +
      " sanitizedLen=" + ws.team.length,
  );

  const otherWs = ws.side === "a" ? room.sockets.b : room.sockets.a;

  send(ws, { type: "waiting_for_opponent" });

  if (
    room.sockets.a &&
    room.sockets.b &&
    room.sockets.a.ready &&
    room.sockets.b.ready &&
    !room.match &&
    !room.starting
  ) {
    startMatch(room);
  } else if (otherWs) {
    send(otherWs, { type: "opponent_ready" });
  }
}

/* ------------------------------------------------------------
   AUTHORITATIVE POKÉMON TYPES

   Type effectiveness needs each Pokémon's real types. Look them up
   from PokéAPI by id (cached), so a modified client can't claim e.g.
   a Ghost type to dodge Normal hits. If the lookup fails or times
   out, the match falls back to the types the client reported.
------------------------------------------------------------ */

const typeCache = new Map();

async function fetchTypesFor(id) {
  if (!id) return null;

  if (typeCache.has(id)) return typeCache.get(id);

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);

    const res = await fetch("https://pokeapi.co/api/v2/pokemon/" + id, {
      signal: ctl.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();

    const types = (data.types || [])
      .map((t) => t && t.type && t.type.name)
      .filter((t) => typeof t === "string");

    if (types.length) {
      typeCache.set(id, types);

      return types;
    }
  } catch (e) {
    /* Fall back to client-reported types. */
  }

  return null;
}

async function attachAuthoritativeTypes(team) {
  await Promise.all(
    team.map(async (p) => {
      const types = await fetchTypesFor(p.id);

      if (types) p.simTypes = types;
    }),
  );
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
    id: clampNumber(p && p.id, 1, 100000, 0) || undefined,
    height: clampNumber(p && p.height, 0, 1000, undefined),
    types: sanitizeTypes(p && p.types),
    hp: battleSim.GAME.maxHP,
    move: sanitizeMove(p && p.move),
  }));
}

function sanitizeTypes(types) {
  if (!Array.isArray(types)) {
    return undefined;
  }

  /* Cosmetic only (which sprite/name shows on the opponent's
     screen) — not used by the authoritative simulation at all, so
     this only needs to be well-formed enough not to break
     rendering, not airtight against a tampered value. */
  return types.slice(0, 4).map((t) => ({
    type: { name: String((t && t.type && t.type.name) || "normal").slice(0, 20) },
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

async function startMatch(room) {
  /* Lock the room so a second "ready" can't start it twice while
     the async wager checks below are running. */
  room.starting = true;

  const betA = room.sockets.a.bet || { amount: 0, currency: "coins" };
  const betB = room.sockets.b.bet || { amount: 0, currency: "coins" };

  if (betA.amount !== betB.amount || betA.currency !== betB.currency) {
    cancelMatch(room, "bet_mismatch");
    return;
  }

  room.bet = betA;
  room.matchId = room.roomId + "_" + Date.now();

  if (room.bet.amount) {
    let affordable = false;

    try {
      affordable = await canBothAfford(room.uids.a, room.uids.b, room.bet);
    } catch (e) {
      console.error("[wager] balance check failed:", e.message);
    }

    if (!affordable) {
      cancelMatch(room, "cannot_afford");
      return;
    }

    if (!(await takeStakes(room))) {
      cancelMatch(room, "wager_failed");
      return;
    }
  }

  /* A player may have left while the checks ran. */
  if (!room.sockets.a || !room.sockets.b) {
    if (room.bet && room.bet.amount) {
      await refundRoomWager(room);
    }

    cancelMatch(room, "opponent_left");
    return;
  }

  console.log(
    "[ws] starting match: room=" + room.roomId +
      " teamA.len=" + room.sockets.a.team.length +
      " teamB.len=" + room.sockets.b.team.length,
  );

  await attachAuthoritativeTypes(room.sockets.a.team);
  await attachAuthoritativeTypes(room.sockets.b.team);

  /* A player may have left while the type lookups ran. */
  if (!room.sockets.a || !room.sockets.b) {
    if (room.bet && room.bet.amount) {
      await refundRoomWager(room);
    }

    cancelMatch(room, "opponent_left");
    return;
  }

  room.match = battleSim.createMatch(room.sockets.a.team, room.sockets.b.team);

  send(room.sockets.a, {
    type: "start",
    myTeam: room.sockets.a.team,
    opponentTeam: room.sockets.b.team,
    bet: room.bet,
  });

  send(room.sockets.b, {
    type: "start",
    myTeam: room.sockets.b.team,
    opponentTeam: room.sockets.a.team,
    bet: room.bet,
  });

  console.log("[ws] \"start\" sent to both sides: room=" + room.roomId);

  room.lastTick = Date.now();

  room.timer = setInterval(() => tickRoom(room), TICK_MS);
}

function cancelMatch(room, reason) {
  console.log("[ws] match cancelled: room=" + room.roomId + " reason=" + reason);

  broadcast(room, { type: "match_cancelled", reason: reason });

  if (room.timer) clearInterval(room.timer);

  rooms.delete(room.roomId);

  [room.sockets.a, room.sockets.b].forEach((sock) => {
    if (sock) {
      try {
        sock.close(1000, reason);
      } catch (e) {
        /* Already closed. */
      }
    }
  });
}

/* Gives both stakes back when a match never actually began. */
async function refundRoomWager(room) {
  try {
    const batch = db.batch();

    writeAdjustment(batch, room.uids.a, room.matchId + "_refund", room.bet, 1, "wager_refund", room.matchId);
    writeAdjustment(batch, room.uids.b, room.matchId + "_refund", room.bet, 1, "wager_refund", room.matchId);

    batch.update(db.collection("wagers").doc(room.matchId), {
      status: "refunded",
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
  } catch (e) {
    console.error("[wager] refund failed:", e.message);
  }
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
  /* Guard: a KO and a forfeit timer (or a duplicate tick) must never
     settle the same match twice. */
  if (room.settled) {
    return;
  }

  room.settled = true;

  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  const loserUid = winnerUid === room.uids.a ? room.uids.b : room.uids.a;

  broadcast(room, {
    type: "match_over",
    winnerUid: winnerUid,
    reason: reason || "ko",
    bet: room.bet || null,
  });

  await payOutWager(room, winnerUid);

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
      bet: room.bet || null,
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

refundStaleWagers();

httpServer.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
