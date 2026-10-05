"use strict";

/* ============================================================
   GAME RULES SHARED WITH THE CLIENT (ported from game.js)

   The local/CPU battle applies type effectiveness, immunities and
   the Legendary/Mythical damage bonuses. The online simulation was
   ignoring all of that (every hit was just the move's flat damage),
   so Raichu and Mewtwo hit and defended identically online. These
   are the same tables and multipliers the client uses, so an online
   battle plays by the same rules as a CPU battle.
============================================================ */

const LEGENDARY_DAMAGE_TAKEN_MULT = 0.55; // takes ~45% less damage
const LEGENDARY_DAMAGE_DEALT_MULT = 1.65; // deals ~65% more damage

const LEGENDARY_POKEMON = new Set(
  [
    "mew",
    "mewtwo",
    "articuno",
    "zapdos",
    "moltres",
    "raikou",
    "entei",
    "suicune",
    "lugia",
    "ho-oh",
    "celebi",
    "regirock",
    "regice",
    "registeel",
    "latias",
    "latios",
    "kyogre",
    "groudon",
    "rayquaza",
    "jirachi",
    "deoxys",
    "uxie",
    "mesprit",
    "azelf",
    "dialga",
    "palkia",
    "giratina",
    "giratina-altered",
    "giratina-origin",
    "heatran",
    "regigigas",
    "cresselia",
    "phione",
    "manaphy",
    "darkrai",
    "shaymin",
    "shaymin-land",
    "shaymin-sky",
    "arceus",
    "victini",
    "cobalion",
    "terrakion",
    "virizion",
    "tornadus",
    "thundurus",
    "landorus",
    "reshiram",
    "zekrom",
    "kyurem",
    "keldeo",
    "meloetta",
    "genesect",
    "xerneas",
    "yveltal",
    "zygarde",
    "diancie",
    "hoopa",
    "volcanion",
    "type-null",
    "silvally",
    "tapu-koko",
    "tapu-lele",
    "tapu-bulu",
    "tapu-fini",
    "cosmog",
    "cosmoem",
    "solgaleo",
    "lunala",
    "necrozma",
    "magearna",
    "marshadow",
    "zeraora",
    "meltan",
    "melmetal",
    "zacian",
    "zamazenta",
    "eternatus",
    "kubfu",
    "urshifu",
    "zarude",
    "regieleki",
    "regidrago",
    "glastrier",
    "spectrier",
    "calyrex",
    "enamorus",
    "wo-chien",
    "chien-pao",
    "ting-lu",
    "chi-yu",
    "koraidon",
    "miraidon",
    "ogerpon",
    "terapagos",
    "pecharunt",
  ].map(cleanPokemonName),
);

const TYPE_EFFECTIVENESS = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: {
    fire: 0.5,
    water: 0.5,
    grass: 2,
    ice: 2,
    bug: 2,
    rock: 0.5,
    dragon: 0.5,
    steel: 2,
  },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: {
    water: 2,
    electric: 0.5,
    grass: 0.5,
    ground: 0,
    flying: 2,
    dragon: 0.5,
  },
  grass: {
    fire: 0.5,
    water: 2,
    grass: 0.5,
    poison: 0.5,
    ground: 2,
    flying: 0.5,
    bug: 0.5,
    rock: 2,
    dragon: 0.5,
    steel: 0.5,
  },
  ice: {
    fire: 0.5,
    water: 0.5,
    grass: 2,
    ice: 0.5,
    ground: 2,
    flying: 2,
    dragon: 2,
    steel: 0.5,
  },
  fighting: {
    normal: 2,
    ice: 2,
    poison: 0.5,
    flying: 0.5,
    psychic: 0.5,
    bug: 0.5,
    rock: 2,
    ghost: 0,
    dark: 2,
    steel: 2,
    fairy: 0.5,
  },
  poison: {
    grass: 2,
    poison: 0.5,
    ground: 0.5,
    rock: 0.5,
    ghost: 0.5,
    steel: 0,
    fairy: 2,
  },
  ground: {
    fire: 2,
    electric: 2,
    grass: 0.5,
    poison: 2,
    flying: 0,
    bug: 0.5,
    rock: 2,
    steel: 2,
  },
  flying: {
    electric: 0.5,
    grass: 2,
    fighting: 2,
    bug: 2,
    rock: 0.5,
    steel: 0.5,
  },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: {
    fire: 0.5,
    grass: 2,
    fighting: 0.5,
    poison: 0.5,
    flying: 0.5,
    psychic: 2,
    ghost: 0.5,
    dark: 2,
    steel: 0.5,
    fairy: 0.5,
  },
  rock: {
    fire: 2,
    ice: 2,
    fighting: 0.5,
    ground: 0.5,
    flying: 2,
    bug: 2,
    steel: 0.5,
  },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: {
    fire: 0.5,
    water: 0.5,
    electric: 0.5,
    ice: 2,
    rock: 2,
    steel: 0.5,
    fairy: 2,
  },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

function cleanPokemonName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isLegendaryPokemon(pokemon) {
  if (!pokemon || !pokemon.name) return false;

  const full = cleanPokemonName(pokemon.name);

  if (LEGENDARY_POKEMON.has(full)) return true;

  const raw = String(pokemon.name).toLowerCase();

  // Hyphenated species: ho-oh, type-null, tapu-*, wo-chien, ...
  const parts = raw.split("-");

  for (let n = parts.length - 1; n >= 1; n--) {
    if (LEGENDARY_POKEMON.has(cleanPokemonName(parts.slice(0, n).join("-")))) {
      return true;
    }
  }

  return false;
}

/* defenderTypes: array of type-name strings (["electric"], ...). */
function typeEffectivenessMultiplier(moveType, defenderTypes) {
  const chart = TYPE_EFFECTIVENESS[moveType];

  if (!chart) return 1;

  return (defenderTypes || []).reduce(function (mult, defType) {
    const factor = chart[defType];

    return typeof factor === "number" ? mult * factor : mult;
  }, 1);
}

module.exports = {
  LEGENDARY_DAMAGE_TAKEN_MULT,
  LEGENDARY_DAMAGE_DEALT_MULT,
  isLegendaryPokemon,
  typeEffectivenessMultiplier,
};
