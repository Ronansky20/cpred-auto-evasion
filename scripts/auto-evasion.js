// CPRED Auto Evasion (Melee) — Foundry VTT v12
// - Detects melee WEAPON cards (Unarmed, Wolvers, etc.).
// - Treats the very next dice roll as the attack roll (within a short window).
// - Requires the attacker to have EXACTLY ONE target selected.
// - Rolls Evasion on the defender (locally if user is GM; otherwise via socket).
//
// Notes:
// * No reliance on system flags; works with CPRED weapon cards.
// * v12-safe (uses authorId, msg.isRoll fallback via numeric total).
// * Minimal logs; uncomment console lines if you want extra visibility.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

// ---- Pending (local) ----
let pendingUntil = 0;
const PENDING_MS = 8000; // window between seeing melee card and the roll

function setPending() {
  pendingUntil = Date.now() + PENDING_MS;
  // console.log(`[${MOD}] pending set (${PENDING_MS}ms)`);
}
function hasPending() {
  return Date.now() <= pendingUntil;
}
function clearPending() {
  pendingUntil = 0;
  // console.log(`[${MOD}] pending cleared`);
}

// ---- Evasion roller (works with typical CPRED methods/outlines) ----
async function rollEvasion(actor, evasionName = "Evasion") {
  // Preferred: system helper
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionName); } catch (e) { /* fall through */ }
  }

  // Fallback: find a skill entry labelled "Evasion"
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try { return await skills[key].roll(); } catch (e) { /* fall through */ }
  }

  // Last resort: some sheets expose internal handler
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionName }); } catch (e) { /* fall through */ }
  }

  ui.notifications.error(`[${MOD}] Couldn't roll "${evasionName}" on ${actor.name}.`);
  return null;
}

Hooks.once("ready", () => {
  // console.log(`[${MOD}] ready. system=${game.system?.id}`);

  // 1) Weapon card detector: mark local pending when a melee weapon card renders
  Hooks.on("renderChatMessage", (msg, html) => {
    // Skip if this message already contains a roll (we only want the card step)
    if (msg?.rolls?.length) return;

    const text = (html?.[0]?.innerText || msg.content || "").toLowerCase();

    // Broad CPRED melee card cues:
    // - Cards usually include "Melee Weapon"
    // - Unarmed/Wolvers names
    // - Or a set of melee stats on the card text
    const looksMeleeCard =
      text.includes("melee weapon") ||
      text.includes("unarmed") ||
      text.includes("wolvers") ||
      (text.includes("rof") && text.includes("damage") && text.includes("hands") && text.includes("melee"));

    if (looksMeleeCard) {
      setPending();
      // ui.notifications.info(`[${MOD}] Melee card detected — waiting for the next roll…`);
    }
  });

  // 2) When any roll message appears, if we’re pending, treat it as the melee attack
  Hooks.on("createChatMessage", async (msg) => {
    // Some modules/cards don't set msg.isRoll reliably; detect by numeric total
    const roll = msg?.rolls?.[0];
    const total = (roll && typeof roll.total === "number") ? roll.total : null;
    if (total === null) return;

    if (!hasPending()) return;       // only the roll immediately after the melee card
    clearPending();

    // Attacker must have exactly one target selected on their client
    const targets = Array.from(game.user.targets || []);
    if (targets.length !== 1) {
      ui.notifications.warn(`[${MOD}] Need exactly one target selected for auto-evasion.`);
      return;
    }

    const tDoc = targets[0]?.document;
    if (!tDoc) return;

    const sceneId = tDoc.parent?.id || canvas.scene?.id;
    const tokenId = tDoc.id;
    const defenderName = targets[0].name;
    const attackTotal = total;
    const evasionKey = "Evasion";

    // Solo GM? Do it locally. Otherwise notify GM via socket.
    if (game.user.isGM) {
      await resolveEvasionLocal({ sceneId, tokenId, defenderName, attackTotal, evasionKey });
    } else {
      game.socket.emit(SOCKET, { sceneId, tokenId, defenderName, attackTotal, evasionKey });
    }
  });

  // 3) GM handler (multiplayer tables)
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;
    await resolveEvasionLocal(p);
  });
});

// ---- Shared resolver used by both local GM path and socket GM path ----
async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;
  if (!actor) {
    ui.notifications.warn(`[${MOD}] No actor found for token ${p.tokenId}.`);
    return;
  }

  const ev = await rollEvasion(actor, p.evasionKey || "Evasion");
  const eTotal = ev?.total ?? null;

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
}
