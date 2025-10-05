// CPRED Auto Evasion (Diagnostic Build) — Foundry VTT v12
// -------------------------------------------------------
// Adds loud notifications and console logs so you can confirm every step.
// Works solo GM or multiplayer. Detects melee weapon cards (Unarmed/Wolvers/etc.),
// then treats the next roll as the attack and rolls Evasion on the target.
//
// Steps you'll see via toasts:
// - "Melee card detected" when a card like Unarmed or Wolvers appears.
// - "Roll seen..." when dice roll is posted.
// - "Rolling Evasion..." when the system triggers the defense roll.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

// --- Pending timer: "I saw a melee card, next roll is melee attack" ---
let pendingUntil = 0;
const PENDING_MS = 8000;

function setPending() {
  pendingUntil = Date.now() + PENDING_MS;
  console.log(`[${MOD}] PENDING SET (${PENDING_MS}ms)`);
  ui.notifications.info(`[${MOD}] Melee card detected — waiting for the next roll...`, { permanent: false });
}
function hasPending() { return Date.now() <= pendingUntil; }
function clearPending() {
  pendingUntil = 0;
  console.log(`[${MOD}] PENDING CLEARED`);
}

// --- Evasion roller ---
async function rollEvasion(actor, evasionName = "Evasion") {
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionName); } catch (e) { console.warn(`[${MOD}] actor.rollSkill failed`, e); }
  }
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try { return await skills[key].roll(); } catch (e) { console.warn(`[${MOD}] skill.roll failed`, e); }
  }
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionName }); } catch (e) { console.warn(`[${MOD}] sheet._onRollSkill failed`, e); }
  }
  ui.notifications.error(`[${MOD}] Couldn't roll "${evasionName}" on ${actor.name}.`);
  return null;
}

// --- Main hooks ---
Hooks.once("ready", () => {
  console.log(`[${MOD}] READY — system=${game.system?.id} user=${game.user?.id}`);

  // Detect melee weapon cards (Unarmed, Wolvers, etc.)
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // skip if it's already a roll

    const text = (html?.[0]?.innerText || msg.content || "").toLowerCase();
    const looksMeleeCard =
      text.includes("melee weapon") ||
      text.includes("unarmed") ||
      text.includes("wolvers") ||
      (text.includes("rof") && text.includes("damage") && text.includes("hands") && text.includes("melee"));

    if (looksMeleeCard) {
      console.log(`[${MOD}] melee weapon/unarmed card detected`, { snippet: text.slice(0, 120) });
      setPending();
    }
  });

  // Detect roll following melee card
  Hooks.on("createChatMessage", async (msg) => {
    const roll = msg?.rolls?.[0];
    const total = (roll && typeof roll.total === "number") ? roll.total : null;
    if (total === null) return;

    console.log(`[${MOD}] createChatMessage total=${total}, pending=${hasPending()}`);
    if (!hasPending()) return;

    clearPending();
    ui.notifications.info(`[${MOD}] Roll seen: ${total} (pending melee)`, { permanent: false });

    const targets = Array.from(game.user.targets || []);
    if (targets.length !== 1) {
      ui.notifications.warn(`[${MOD}] Need exactly one target selected for auto-evasion. (Have ${targets.length})`, { permanent: false });
      return;
    }

    const tDoc = targets[0]?.document;
    if (!tDoc) return;

    const sceneId = tDoc.parent?.id || canvas.scene?.id;
    const tokenId = tDoc.id;
    const defenderName = targets[0].name;
    const attackTotal = total;
    const evasionKey = "Evasion";

    console.log(`[${MOD}] melee attack detected → ${defenderName} (attack=${attackTotal})`);
    if (game.user.isGM) {
      await resolveEvasionLocal({ sceneId, tokenId, defenderName, attackTotal, evasionKey });
    } else {
      game.socket.emit(SOCKET, { sceneId, tokenId, defenderName, attackTotal, evasionKey });
      ui.notifications.info(`[${MOD}] Sent attack to GM for auto-evasion...`, { permanent: false });
    }
  });

  // GM handler for multiplayer tables
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;
    console.log(`[${MOD}] GM socket received`, p);
    ui.notifications.info(`[${MOD}] GM rolling Evasion for ${p.defenderName}...`, { permanent: false });
    await resolveEvasionLocal(p);
  });
});

// --- Shared resolution logic ---
async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;
  if (!actor) {
    ui.notifications.warn(`[${MOD}] No actor found for token ${p.tokenId}.`, { permanent: false });
    return;
  }

  const ev = await rollEvasion(actor, p.evasionKey || "Evasion");
  const eTotal = ev?.total ?? null;

  ui.notifications.info(`[${MOD}] Evasion roll: ${eTotal ?? "?"} (${actor.name})`, { permanent: false });

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
