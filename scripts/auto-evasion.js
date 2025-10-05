// CPRED Auto Evasion (Melee) for Foundry V12
// Notes:
// - Attacker client detects melee attack chat message.
// - It looks at the attacker's current single target.
// - Sends a socket request to the GM to roll Evasion on that target's Actor.
// - Heuristic "is this a melee attack?" function is conservative and customizable.

// --- Settings (you can expose as world settings later if you want) ---
const MODULE_ID = "cpred-auto-evasion";
const SOCKET_NAMESPACE = `module.${MODULE_ID}`;

// If you know the exact skill key name in your build, put it here:
const EVASION_SKILL_KEY = "evasion"; // adjust if needed

// OPTIONAL: tighten these if you know your system flags structure for Cyberpunk RED Core
const MELEE_KEYWORDS = [
  "melee weapon",
  "brawling",
  "martial arts",
  "melee attack"
];

// --- Utility: find first active GM deterministically ---
function getPrimaryActiveGM() {
  const gms = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id));
  return gms[0] || null;
}

// --- Utility: robust evasion roller (handles different API shapes) ---
async function rollEvasionOnActor(actor) {
  // 1) Preferred: a system-provided method
  if (typeof actor.rollSkill === "function") {
    return actor.rollSkill(EVASION_SKILL_KEY);
  }

  // 2) System skill object with roll()
  const skillObj = foundry.utils.getProperty(actor, `system.skills.${EVASION_SKILL_KEY}`);
  if (skillObj?.roll) {
    return skillObj.roll();
  }

  // 3) Some sheets expose internal roll handlers
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    return actor.sheet._onRollSkill({ skill: EVASION_SKILL_KEY });
  }

  ui.notifications.error(`[${MODULE_ID}] Couldn't find a method to roll "${EVASION_SKILL_KEY}" on ${actor.name}. Edit rollEvasionOnActor().`);
  return null;
}

// --- Heuristic: decide if a ChatMessage is a melee attack from the CPRED system ---
function messageLooksLikeMeleeAttack(msg) {
  // 0) Fast bail-outs
  if (!msg?.content) return false;

  // 1) Try system flags if present
  const flags = msg.flags || {};
  // Common system flag guesses (adjust if your build differs)
  const cpredFlag = flags["cyberpunkredcore"] || flags["cyberpunk-red-core"] || flags["cpred"];
  if (cpredFlag) {
    // If your build exposes structured info, tighten this:
    // e.g., cpredFlag.rollType === "attack" && cpredFlag.weaponType === "melee"
    const rollType = (cpredFlag.rollType || "").toLowerCase();
    const skillName = (cpredFlag.skillName || "").toLowerCase();
    const weaponType = (cpredFlag.weaponType || "").toLowerCase();

    if (rollType === "attack" && (weaponType === "melee" || MELEE_KEYWORDS.some(k => skillName.includes(k)))) {
      return true;
    }
  }

  // 2) Fallback: keyword scan of rendered chat content
  const text = msg.content.toLowerCase();
  if (MELEE_KEYWORDS.some(k => text.includes(k))) {
    // Also sanity-check that it looks like an "attack"
    if (text.includes("attack") || text.includes("hits") || text.includes("to hit")) return true;
  }

  return false;
}

// --- Client-side hook: attacker detects their own melee attack, asks GM to roll evasion on the target ---
Hooks.once("ready", () => {
  // Socket: GM handler
  game.socket.on(SOCKET_NAMESPACE, async (payload) => {
    // Only one GM should handle the request
    if (!game.user.isGM) return;
    const primaryGM = getPrimaryActiveGM();
    if (!primaryGM || game.user.id !== primaryGM.id) return;

    try {
      const { sceneId, tokenId, attackerName } = payload || {};
      const scene = game.scenes.get(sceneId) || canvas.scene;
      if (!scene) return;

      // TokenDocument (not the placeable object)
      const tDoc = scene.tokens.get(tokenId);
      const actor = tDoc?.actor;
      if (!actor) return;

      const roll = await rollEvasionOnActor(actor);
      if (roll) {
        // Post a small follow-up message so players see it happened
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actor.name}</b> auto-rolls <i>Evasion</i> versus ${attackerName}'s melee attack.`,
        });
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] GM socket handler error:`, err);
    }
  });

  // Attacker-side: watch for melee attack messages created by THIS user
  Hooks.on("createChatMessage", async (msg) => {
    try {
      // Only react on the attacker's client (so we can read their targets)
      if (msg.user?.id !== game.user.id) return;
      // Only if it looks like a melee attack from CPRED
      if (!messageLooksLikeMeleeAttack(msg)) return;

      // Require exactly one target selected by the attacker
      const targets = Array.from(game.user.targets || []);
      if (targets.length !== 1) return;

      const targetToken = targets[0];           // PlaceableObject Token
      const tDoc = targetToken?.document;       // TokenDocument

      if (!tDoc) return;

      // Tell the GM to roll Evasion on that token
      const payload = {
        sceneId: tDoc.parent?.id || canvas.scene?.id,
        tokenId: tDoc.id,
        attackerName: msg.speaker?.alias || canvas.tokens.get(msg.speaker?.token)?.name || "Attacker"
      };
      game.socket.emit(SOCKET_NAMESPACE, payload);
    } catch (err) {
      console.error(`[${MODULE_ID}] createChatMessage handler error:`, err);
    }
  });

  console.log(`[${MODULE_ID}] Ready.`);
});
