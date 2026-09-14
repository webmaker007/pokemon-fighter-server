"use strict";

/*
============================================================
 BATTLE-SIM.JS

 The authoritative, headless port of the physics + combat rules
 from the client's game.js. This is what actually decides who hit
 whom, for how much damage, and who wins an online match — the
 server runs this, and both clients just render whatever state it
 produces. No canvas, no DOM, no PokéAPI calls: everything a match
 needs (each fighter's move data) is handed in up front when the
 match is created.

 Kept deliberately close to game.js's own numbers/behavior so an
 online battle feels the same as a local one. If you tune combat
 in game.js, mirror the change here too — these are two
 independent copies of the same rules, not a shared import,
 because game.js is a browser file full of canvas/DOM code that
 has no place running on a server.
============================================================
*/

const GAME = {
  width: 1200,
  height: 650,

  ground: 505,

  gravity: 1.18,
  jumpPower: -19,

  playerSpeed: 6.2,

  maxHP: 100,

  minDistance: 115,

  attackCooldown: 430,
  attackDuration: 270,
  attackHitFrame: 155,

  maxProjectiles: 10,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ============================================================
   FIGHTER
============================================================ */

function createFighter(x, facing, team) {
  return {
    x: x,
    y: GAME.ground,

    vx: 0,
    vy: 0,

    hp: team[0] && typeof team[0].hp === "number" ? team[0].hp : GAME.maxHP,

    facing: facing,

    jumping: false,
    attacking: false,
    blocking: false,
    dodging: false,
    invulnerable: false,

    attackTimer: 0,
    attackCooldown: 0,
    attackHit: false,

    hitTimer: 0,
    dodgeTimer: 0,

    combo: 0,
    comboTimer: 0,

    hitFlash: 0,

    swapTimer: 0,

    teamIndex: 0,
  };
}

/* ============================================================
   MATCH

   team: array of { name, hp (optional, defaults to maxHP),
                     move: { name, type, damage, range, projectile,
                             speed, color } }
     — the client resolves each Pokémon's real move (via PokéAPI)
     and sends the resolved move data at match creation, so the
     server never needs network calls of its own mid-battle.
============================================================ */

function createMatch(teamA, teamB) {
  return {
    fighters: {
      a: createFighter(300, 1, teamA),
      b: createFighter(900, -1, teamB),
    },

    teams: {
      a: teamA.map((p) => ({ ...p, fainted: false })),
      b: teamB.map((p) => ({ ...p, fainted: false })),
    },

    projectiles: [],

    /* Latest known input state per side — updated whenever a
       message arrives, applied every tick. */
    inputs: {
      a: freshInput(),
      b: freshInput(),
    },

    /* One-shot actions queued by an input message, consumed on
       the very next tick so a held key doesn't repeat the action
       every tick. */
    pendingActions: {
      a: [],
      b: [],
    },

    winner: null,
    ended: false,

    tick: 0,
  };
}

function freshInput() {
  return { left: false, right: false, block: false };
}

function currentMove(match, side) {
  const team = match.teams[side];
  const idx = match.fighters[side].teamIndex;

  return (team[idx] && team[idx].move) || {
    name: "Tackle",
    type: "normal",
    damage: 15,
    range: 150,
    projectile: false,
    speed: 12,
    color: "#ffffff",
  };
}

function otherSide(side) {
  return side === "a" ? "b" : "a";
}

/* ============================================================
   APPLYING NETWORK INPUT

   input: { left, right, block } — held state, applied every tick
   actions: subset of ["jump","attack","dodge","switch"] — one-shot,
            queued and consumed on the next tick
============================================================ */

function setInput(match, side, input) {
  const f = match.fighters[side];

  match.inputs[side].left = !!input.left;
  match.inputs[side].right = !!input.right;

  /* Blocking only actually applies while grounded and not mid
     some other action — mirrors game.js's handleKeyUp/Down, which
     just sets the flag and lets updatePhysics/movement checks
     gate everything else. */
  f.blocking = !!input.block && !f.attacking && !f.dodging && f.hitTimer <= 0;
}

function queueActions(match, side, actions) {
  if (!Array.isArray(actions) || !actions.length) {
    return;
  }

  match.pendingActions[side].push(...actions);
}

/* ============================================================
   TICK — advance the match by one fixed step (dt = 1 ≈ one
   60fps frame, matching game.js's own dt convention so the
   damage/cooldown numbers feel identical to local play).
============================================================ */

function step(match, dt) {
  if (match.ended) {
    return;
  }

  match.tick += 1;

  processPendingActions(match, "a");
  processPendingActions(match, "b");

  updateMovement(match, "a", dt);
  updateMovement(match, "b", dt);

  updatePhysics(match, "a", dt);
  updatePhysics(match, "b", dt);

  updateFacing(match);
  separateFighters(match);

  updateAttack(match, "a", "b", dt);
  updateAttack(match, "b", "a", dt);

  updateProjectiles(match, dt);
}

function processPendingActions(match, side) {
  const actions = match.pendingActions[side];

  if (!actions.length) {
    return;
  }

  match.pendingActions[side] = [];

  const f = match.fighters[side];

  actions.forEach((action) => {
    if (action === "jump") {
      doJump(f);
    } else if (action === "attack") {
      doStartAttack(match, side);
    } else if (action === "dodge") {
      doDodge(f);
    } else if (action === "switch") {
      doVoluntarySwitch(match, side);
    }
  });
}

function updateMovement(match, side, dt) {
  const f = match.fighters[side];
  const input = match.inputs[side];

  if (f.hitTimer > 0 || f.attacking || f.blocking || f.dodging) {
    return;
  }

  let moving = false;

  if (input.left) {
    f.x -= GAME.playerSpeed * dt;
    moving = true;
  }

  if (input.right) {
    f.x += GAME.playerSpeed * dt;
    moving = true;
  }

  f.vx = moving ? f.vx * 0.85 : 0;
}

function doJump(f) {
  if (f.jumping || f.attacking || f.hitTimer > 0 || f.dodging) {
    return;
  }

  f.jumping = true;
  f.vy = GAME.jumpPower;
}

function doDodge(f) {
  if (f.dodging || f.attacking || f.hitTimer > 0) {
    return;
  }

  f.dodging = true;
  f.invulnerable = true;
  f.dodgeTimer = 220;
  f.x += f.facing * 60;
}

function doStartAttack(match, side) {
  const f = match.fighters[side];

  if (
    f.attacking ||
    f.blocking ||
    f.dodging ||
    f.hitTimer > 0 ||
    f.attackCooldown > 0 ||
    f.hp <= 0
  ) {
    return;
  }

  f.attacking = true;
  f.attackTimer = GAME.attackDuration;
  f.attackCooldown = GAME.attackCooldown;
  f.attackHit = false;
}

function doVoluntarySwitch(match, side) {
  const f = match.fighters[side];
  const team = match.teams[side];

  if (f.attacking || f.dodging || f.hitTimer > 0 || f.swapTimer > 0) {
    return;
  }

  let nextIndex = -1;

  for (let i = 1; i <= team.length; i++) {
    const idx = (f.teamIndex + i) % team.length;

    if (team[idx] && !team[idx].fainted) {
      nextIndex = idx;
      break;
    }
  }

  if (nextIndex === -1 || nextIndex === f.teamIndex) {
    return;
  }

  /* Bench the current member at its current HP, send in the new one. */
  team[f.teamIndex].hp = f.hp;

  f.teamIndex = nextIndex;

  f.hp =
    typeof team[nextIndex].hp === "number" ? team[nextIndex].hp : GAME.maxHP;

  f.invulnerable = true;
  f.swapTimer = 650;
}

function updatePhysics(match, side, dt) {
  const f = match.fighters[side];

  if (f.jumping) {
    f.vy += GAME.gravity * dt;
    f.y += f.vy * dt;

    if (f.y >= GAME.ground) {
      f.y = GAME.ground;
      f.vy = 0;
      f.jumping = false;
    }
  }

  if (f.dodging) {
    f.x += f.facing * 11 * dt;
    f.dodgeTimer -= 16.666 * dt;

    if (f.dodgeTimer <= 0) {
      f.dodging = false;
      f.invulnerable = false;
    }
  }

  if (f.swapTimer > 0) {
    f.swapTimer -= 16.666 * dt;

    if (f.swapTimer <= 0) {
      f.swapTimer = 0;
      f.invulnerable = false;
    }
  }

  if (f.attackCooldown > 0) {
    f.attackCooldown = Math.max(0, f.attackCooldown - 16.666 * dt);
  }

  if (f.hitTimer > 0) {
    f.hitTimer = Math.max(0, f.hitTimer - 16.666 * dt);
  }

  if (f.comboTimer > 0) {
    f.comboTimer -= 16.666 * dt;
  } else {
    f.combo = 0;
  }

  if (f.hitFlash > 0) {
    f.hitFlash -= dt;
  }

  f.x = clamp(f.x, 90, GAME.width - 90);
}

function updateFacing(match) {
  const a = match.fighters.a;
  const b = match.fighters.b;

  if (!a.dodging && a.hitTimer <= 0) {
    a.facing = b.x > a.x ? 1 : -1;
  }

  if (!b.dodging && b.hitTimer <= 0) {
    b.facing = a.x > b.x ? 1 : -1;
  }
}

function separateFighters(match) {
  const a = match.fighters.a;
  const b = match.fighters.b;

  const dx = b.x - a.x;
  const distance = Math.abs(dx);

  if (distance >= GAME.minDistance) {
    return;
  }

  const push = (GAME.minDistance - distance) / 2;

  if (dx >= 0) {
    a.x -= push;
    b.x += push;
  } else {
    a.x += push;
    b.x -= push;
  }

  a.x = clamp(a.x, 90, GAME.width - 90);
  b.x = clamp(b.x, 90, GAME.width - 90);
}

function updateAttack(match, side, targetSide, dt) {
  const attacker = match.fighters[side];

  if (!attacker.attacking) {
    return;
  }

  attacker.attackTimer -= 16.666 * dt;

  if (attacker.attackTimer <= GAME.attackHitFrame && !attacker.attackHit) {
    attacker.attackHit = true;
    performAttack(match, side, targetSide);
  }

  if (attacker.attackTimer <= 0) {
    attacker.attacking = false;
    attacker.attackHit = false;
  }
}

function performAttack(match, side, targetSide) {
  const attacker = match.fighters[side];
  const target = match.fighters[targetSide];
  const move = currentMove(match, side);

  if (move.projectile) {
    createProjectile(match, side, targetSide, move);
    return;
  }

  const distance = Math.abs(attacker.x - target.x);

  if (distance <= move.range && Math.abs(attacker.y - target.y) < 160) {
    hitTarget(match, side, targetSide, move);
  }
}

function createProjectile(match, side, targetSide, move) {
  if (match.projectiles.length >= GAME.maxProjectiles) {
    return;
  }

  const attacker = match.fighters[side];
  const target = match.fighters[targetSide];

  const startX = attacker.x + attacker.facing * 60;
  const startY = attacker.y - 120;

  const targetX = target.x;
  const targetY = target.y - 115;

  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy) || 1;

  const speed = move.speed || 12;

  match.projectiles.push({
    x: startX,
    y: startY,
    vx: (dx / distance) * speed,
    vy: (dy / distance) * speed,
    side: side,
    targetSide: targetSide,
    move: move,
    life: 1000,
  });
}

function updateProjectiles(match, dt) {
  const projectiles = match.projectiles;

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= 16.666 * dt;

    const target = match.fighters[p.targetSide];

    const distance = Math.hypot(p.x - target.x, p.y - (target.y - 115));

    if (distance < 50 && target.hp > 0) {
      if (!target.invulnerable) {
        hitTarget(match, p.side, p.targetSide, p.move);
      }

      projectiles.splice(i, 1);
      continue;
    }

    if (
      p.life <= 0 ||
      p.x < -100 ||
      p.x > GAME.width + 100 ||
      p.y < -100 ||
      p.y > GAME.height + 100
    ) {
      projectiles.splice(i, 1);
    }
  }
}

function hitTarget(match, attackerSide, targetSide, move) {
  const attacker = match.fighters[attackerSide];
  const target = match.fighters[targetSide];

  if (target.hp <= 0 || target.invulnerable) {
    return;
  }

  let damage = move.damage || 15;

  if (target.blocking) {
    damage = Math.max(3, Math.round(damage * 0.25));
  }

  target.hp = clamp(target.hp - damage, 0, GAME.maxHP);
  target.hitTimer = target.blocking ? 90 : 180;
  target.hitFlash = 8;

  target.x += attacker.facing * (target.blocking ? 7 : 22);

  attacker.combo += 1;
  attacker.comboTimer = 850;

  if (target.hp <= 0) {
    handleFaint(match, targetSide, attackerSide);
  }
}

function handleFaint(match, side, attackerSide) {
  const f = match.fighters[side];
  const team = match.teams[side];

  if (team[f.teamIndex]) {
    team[f.teamIndex].fainted = true;
    team[f.teamIndex].hp = 0;
  }

  let nextIndex = -1;

  for (let i = 0; i < team.length; i++) {
    if (i === f.teamIndex) {
      continue;
    }

    if (team[i] && !team[i].fainted) {
      nextIndex = i;
      break;
    }
  }

  if (nextIndex === -1) {
    match.ended = true;
    match.winner = attackerSide;
    return;
  }

  f.teamIndex = nextIndex;
  f.hp =
    typeof team[nextIndex].hp === "number" ? team[nextIndex].hp : GAME.maxHP;
  f.invulnerable = true;
  f.swapTimer = 650;
  f.jumping = false;
  f.attacking = false;
  f.dodging = false;
}

/* ============================================================
   SNAPSHOT — the compact state broadcast to both clients after
   each tick (or every few ticks). Both clients render this
   directly; neither one runs its own physics for an online match.
============================================================ */

function snapshot(match) {
  return {
    tick: match.tick,
    ended: match.ended,
    winner: match.winner,
    fighters: {
      a: publicFighter(match, "a"),
      b: publicFighter(match, "b"),
    },
    projectiles: match.projectiles.map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
      side: p.side,
      color: p.move.color,
      type: p.move.type,
    })),
  };
}

function publicFighter(match, side) {
  const f = match.fighters[side];
  const team = match.teams[side];

  return {
    x: Math.round(f.x),
    y: Math.round(f.y),
    facing: f.facing,
    hp: f.hp,
    teamIndex: f.teamIndex,
    jumping: f.jumping,
    attacking: f.attacking,
    blocking: f.blocking,
    dodging: f.dodging,
    invulnerable: f.invulnerable,
    hitFlash: f.hitFlash > 0,
    combo: f.combo,
    fainted: team.map((p) => !!p.fainted),
    name: team[f.teamIndex] ? team[f.teamIndex].name : null,
  };
}

module.exports = {
  GAME,
  createMatch,
  setInput,
  queueActions,
  step,
  snapshot,
  otherSide,
};
