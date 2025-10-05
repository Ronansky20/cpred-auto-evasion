// CPRED Auto Evasion (Melee) — Foundry VTT v12
// Cyberpunk RED Core–aware implementation with opposed roll resolution.
//
// Works with both: Skill-based melee (Melee Weapon / Brawling / Martial Arts)
// and Weapon-based melee attacks (item attack buttons).
//
// HOW IT WORKS
// - Attacker’s client watches ChatMessages created by THEM.
// - If the message is a CPRED melee attack, we grab the attack total from msg.rolls[0].total.
// - We require exactly one target (defender) selected by the attacker.
// - We send a socket request to the primary active GM to roll Evasion on that target.
// - GM rolls Evasion, compares totals, and posts a result line.
//
// NOTES
// - Settings let you choose how to detect “melee”: by skill names, weapon type “melee”, or both.
// - If your CPRED build exposes helpful flags on ChatMessages, we read them first.
// - Fallbacks: We parse CPRED-style chat content safely, but avoid guessing.

// ------------------ CONFIG ------------------
const MODULE_ID = "cpred-auto-evasion";
const SOCKET = `module.${MODULE_ID}`;

const DEFAULT_SETTINGS = {
  // How to determine a “melee” attack in CPRED:
  // "skills"   -> treat Melee Weapon / Brawling / Martial Arts skill tests as melee
  // "weapons"  -> treat weapon attacks flagged as melee as melee
  // "both"     -> either of the above
  detectionMode: "both",

  // The CPRED skill slugs/titles that count as melee “attack” skills.
  // Titles in sheets are typically capitalized, but we match case-insensitively.
  meleeSkillNames: ["Melee Weapon", "Brawling", "Martial Arts"],

  // Evasion skill key/title. CPRED Core exposes an Evasion skill; we try common roll APIs below.
  evasionKey: "Evasion"
};

// ------------------ SETTINGS ------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "detectionMode", {
    name: "Melee Detection Mode",
    hint: "How should the module decide that an attack is melee?",
    scope: "world",
    config: true,
    type: String,
    choices: {
      skills: "Skills only (Melee Weapon/Brawling/Martial Arts)",
      weapons: "Weapons only (weapon flagged as melee)",
      both: "Both (skills or weapons)"
    },
    default: DEFAULT_SETTINGS.detectionMode
  });

  game.settings.register(MODULE_ID, "meleeSkillNames", {
    name: "Melee Skill Names",
    hint: "Comma-separated list of CPRED skill names that count as melee attacks.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SETTINGS.meleeSkillNames.join(", ")
  });

  game.settings.register(MODULE_ID, "evasionKey", {
    name: "Evasion Skill Name",
    hint: "The exact skill name as CPRED displays it (usually 'Evasion').",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SETTINGS.evasionKey
  });
});

// ------------------ HELPERS ------------------
function getCfg() {
  const detectionMode = game.settings.get(MODULE_ID, "detectionMode");
  const meleeSkillNames = game.settings
    .get(MODULE_ID, "meleeSkillNames")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const evasionKey = game.settings.get(MODULE_ID, "evasionKey");
  return { detectionMode, meleeSkillNames, evasionKey };
}

function primaryActiveGM() {
  const gms = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id));
  return gms[0] || null;
}

async function rollEvasion(actor, evasionKey) {
  // Preferred: CPRED actor.rollSkill("Evasion") or by title/slug
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionKey); } catch (e) { /* fall through */ }
  }

  // Fallback (CPRED often exposes system.skills keyed by lowercase or id; try to locate by name):
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  // Try case-insensitive match on keys and .label/.name
  const key = Object.keys(skills).find(k => {
    const entry = skills[k];
    const label = (entry?.label || entry?.name || k || "").toString().toLowerCase();
    return label === evasionKey.toLowerCase();
  });

  const entry = key ? skills[key] : null;
  if (entry?.roll) {
    try { return await entry.roll(); } catch (e) { /* fall through */ }
  }

  // Some sheets offer an internal handler:
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionKey }); } catch (e) { /* fall through */ }
  }

  ui.notifications.error(`[${MODULE_ID}] Could not roll "${evasionKey}" on ${actor.name}. Adjust the setting or extend rollEvasion().`);
  return null;
}

function isCPRED() {
  return game.system?.id === "cyberpunk-red-core";
}

// Extract a numeric total from a Foundry v12 ChatMessage roll
function extractAttackTotal(msg) {
  // v12 ChatMessage has an array of Roll objects in msg.rolls
  const r = msg.rolls?.[0];
  if (!r) return null;
  // Many systems use standard Roll; total should be numeric
  return typeof r.total === "number" ? r.total : null;
}

// Try to read CPRED-flavored flags to identify attack + melee
function lookLikeCPREDMeleeByFlags(msg, cfg) {
  const flags = msg.flags || {};
  const f = flags["cyberpunk-red-core"] || flags["cyberpunkredcore"] || flags["cpred"] || null;
  if (!f) return null; // unknown

  const mode = cfg.detectionMode;

  // Common shapes (adjust easily if CPRED changes):
  // - f.rollType: "attack" | "skill" | ...
  // - f.weaponType or f.category: "melee" | "ranged"
  // - f.skillName: "Melee Weapon" / "Brawling" / "Martial Arts"
  const rollType = (f.rollType || "").toLowerCase();
  const weaponType = (f.weaponType || f.category || "").toLowerCase();
  const skillName = (f.skillName || "").toLowerCase();

  const isAttack = rollType === "attack" || rollType === "skill"; // CPRED prints both as actionable rolls
  if (!isAttack) return false;

  const skillIsMelee = cfg.meleeSkillNames.some(s => skillName === s.toLowerCase());
  const weaponIsMelee = weaponType === "melee";

  if (mode === "skills") return skillIsMelee;
  if (mode === "weapons") return weaponIsMelee;
  return skillIsMelee || weaponIsMelee;
}

// Fallback parsing for CPRED chat content if flags aren’t present.
// We keep this narrow and CPRED-flavored (no generic “includes attack” stuff).
function lookLikeCPREDMeleeByContent(msg, cfg) {
  const txt = (msg.content || "").toLowerCase();

  // Skill-based: “Skill Check: Melee Weapon/Brawling/Martial Arts” (exact words CPRED uses)
  const skillHit = cfg.meleeSkillNames.some(s => txt.includes(s.toLowerCase()));

  // Weapon-based: CPRED weapon attacks often indicate weapon category/type. Match “melee” explicitly.
  const weaponHit = /\bmelee\b/.test(txt) && /\battack\b|\bto hit\b|\btest\b/.test(txt);

  const mode = cfg.detectionMode;
  if (mode === "skills") return skillHit;
  if (mode === "weapons") return weaponHit;
  return skillHit || weaponHit;
}

function messageIsMeleeAttackCPRED(msg, cfg) {
  // must be CPRED system
  if (game.system?.id !== "cyberpunk-red-core") return false;

  // must contain a roll result (item cards won't)
  const r = msg.rolls?.[0];
  if (!r || typeof r.total !== "number") return false;

  // Try CPRED flags first (if present)
  const flags = msg.flags || {};
  const f = flags["cyberpunk-red-core"] || flags["cyberpunkredcore"] || flags["cpred"] || null;
  if (f) {
    const rollType = (f.rollType || "").toLowerCase();
    const weaponType = (f.weaponType || f.category || "").toLowerCase();
    const skillName = (f.skillName || "").toLowerCase();
    const skillHit = cfg.meleeSkillNames.some(s => s.toLowerCase() === skillName);
    const weaponHit = weaponType === "melee";
    if (cfg.detectionMode === "skills") return rollType && skillHit;
    if (cfg.detectionMode === "weapons") return rollType && weaponHit;
    return rollType && (skillHit || weaponHit);
  }

  // Fallback: parse CPRED-style chat content
  const txt = (msg.content || "").toLowerCase();
  const skillHit = cfg.meleeSkillNames.some(s => txt.includes(s.toLowerCase()));
  const weaponHit = /\bmelee\b/.test(txt);
  if (cfg.detectionMode === "skills") return skillHit;
  if (cfg.detectionMode === "weapons") return weaponHit;
  return skillHit || weaponHit;
}

// ------------------ SOCKET & HOOKS ------------------
Hooks.once("ready", () => {
  // GM socket handler: perform evasion and post result
  game.socket.on(SOCKET, async (payload) => {
    if (!game.user.isGM) return;

    // Only the primary active GM should handle to avoid double rolls
    const primary = primaryActiveGM();
    if (!primary || game.user.id !== primary.id) return;

    const { sceneId, tokenId, attackerName, defenderName, attackTotal, evasionKey } = payload || {};
    try {
      const scene = game.scenes.get(sceneId) || canvas.scene;
      if (!scene) return;
      const tDoc = scene.tokens.get(tokenId);
      const actor = tDoc?.actor;
      if (!actor) return;

      // Roll Evasion
      const evasionRoll = await rollEvasion(actor, evasionKey);
      const evasionTotal = evasionRoll?.total ?? evasionRoll?.dice?.total ?? null;

      // Build a sensible result line even if we failed to extract a number
      let content = `<b>${defenderName || actor.name}</b> rolls <i>${evasionKey}</i>`;
      if (typeof evasionTotal === "number") {
        content += `: <b>${evasionTotal}</b>`;
      } else {
        content += `.`;
      }

      if (typeof attackTotal === "number" && typeof evasionTotal === "number") {
        const outcome = attackTotal > evasionTotal ? "HIT" : "DODGED";
        content += ` &nbsp;—&nbsp; <b>${outcome}</b> (Attack ${attackTotal} vs Evasion ${evasionTotal}).`;
      } else if (typeof attackTotal === "number") {
        content += ` &nbsp;—&nbsp; (Attack ${attackTotal} vs Evasion ?).`;
      }

      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor })
      });
    } catch (err) {
      console.error(`[${MODULE_ID}] GM socket error`, err);
    }
  });

  // Attacker-side: watch for *our* newly created messages and react if CPRED melee
  Hooks.on("createChatMessage", async (msg) => {
    try {
      // Only the user who created the message should react (so we can read their targets)
      if (msg.authorId !== game.user.id) return;

      const cfg = getCfg();
      if (!messageIsMeleeAttackCPRED(msg, cfg)) return;

      // Require exactly one targeted defender
      const targets = Array.from(game.user.targets || []);
      if (targets.length !== 1) return;

      const target = targets[0];
      const tDoc = target?.document;
      if (!tDoc) return;

      const attackTotal = extractAttackTotal(msg);
      const attackerName =
        msg.speaker?.alias ||
        canvas.tokens.get(msg.speaker?.token)?.name ||
        game.user.name ||
        "Attacker";

      const defenderName = target.name;

      game.socket.emit(SOCKET, {
        sceneId: tDoc.parent?.id || canvas.scene?.id,
        tokenId: tDoc.id,
        attackerName,
        defenderName,
        attackTotal,
        evasionKey: getCfg().evasionKey
      });
    } catch (err) {
      console.error(`[${MODULE_ID}] attacker hook error`, err);
    }
  });

  console.log(`[${MODULE_ID}] Ready — CPRED-aware melee auto-evasion active.`);
});
