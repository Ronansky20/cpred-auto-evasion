// CPRED Auto Evasion — weapon-aware (Foundry v12)
const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

// Per-user short-lived markers that a melee weapon card was just posted
const pendingMelee = new Map(); // authorId -> timestamp(ms)
const PENDING_WINDOW_MS = 6000; // how long we consider the next roll to be that melee attack

function markPendingMelee(authorId) {
  pendingMelee.set(authorId, Date.now());
}
function consumePendingMelee(authorId) {
  const t = pendingMelee.get(authorId);
  if (!t) return false;
  const ok = Date.now() - t <= PENDING_WINDOW_MS;
  pendingMelee.delete(authorId);
  return ok;
}

async function rollEvasion(actor, evasionName = "Evasion") {
  // Preferred: system helper
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionName); } catch (e) {}
  }
  // Fallback: find a skill entry named/labelled "Evasion"
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try { return await skills[key].roll(); } catch (e) {}
  }
  // Last resort: some sheets expose an internal handler
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionName }); } catch (e) {}
  }
  ui.notifications.error(`[${MOD}] Couldn't roll "${evasionName}" on ${actor.name}.`);
  return null;
}

Hooks.once("ready", () => {
  console.log(`[${MOD}] ready. system=${game.system?.id}`);

  // 1) When a non-roll melee weapon **card** renders, mark the author as "pending melee"
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg.isRoll) return; // cards only
    const authorId = msg.authorId ?? msg.user; // v12 uses authorId
    // Look for "Melee Weapon" on the card (Unarmed/Wolvers/etc. show this)
    const text = (html?.text?.() || msg.content || "").toLowerCase();
    if (text.includes("melee weapon")) {
      markPendingMelee(authorId);
      // console.debug(`[${MOD}] marked pending melee for author ${authorId}`);
    }
  });

  // 2) When a **roll** message happens, if that author had a recent melee card, treat it as the melee attack
  Hooks.on("createChatMessage", async (msg) => {
    if (!msg.isRoll) return;
    const roll = msg.rolls?.[0];
    if (!roll || typeof roll.total !== "number") return;

    const authorId = msg.authorId ?? msg.user;
    // Only proceed if a melee weapon card just preceded this roll for the same author
    if (!consumePendingMelee(authorId)) return;

    // Require exactly one target on that attacker's client
    const targets = Array.from(game.user.targets || []);
    if (targets.length !== 1) return;

    const tDoc = targets[0]?.document;
    if (!tDoc) return;

    // Ask GM to roll Evasion and post opposed result
    game.socket.emit(SOCKET, {
      sceneId: tDoc.parent?.id || canvas.scene?.id,
      tokenId: tDoc.id,
      defenderName: targets[0].name,
      attackTotal: roll.total,
      evasionKey: "Evasion"
    });
  });

  // 3) GM handles Evasion roll and result message
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;

    const scene = game.scenes.get(p.sceneId) || canvas.scene;
    const tDoc = scene?.tokens.get(p.tokenId);
    const actor = tDoc?.actor;
    if (!actor) return;

    const evRoll = await rollEvasion(actor, p.evasionKey || "Evasion");
    const eTotal = evRoll?.total ?? null;

    let content = `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>`;
    if (typeof eTotal === "number") content += `: <b>${eTotal}</b>`;
    if (typeof p.attackTotal === "number" && typeof eTotal === "number") {
      const outcome = p.attackTotal > eTotal ? "HIT" : "DODGED";
      content += ` — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${eTotal})`;
    }

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    });
  });
});
