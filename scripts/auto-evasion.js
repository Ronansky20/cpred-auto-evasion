// CPRED Auto Evasion — weapon-card aware, local pending (Foundry V12)
const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

// Local (per client) pending marker. We set it when *this client* sees a melee weapon card.
// That means every client will set it, but only the attacker should have exactly one target,
// so only they will proceed.
let localPendingUntil = 0;
const PENDING_MS = 8000; // widen if your table clicks slowly

function setLocalPending() {
  localPendingUntil = Date.now() + PENDING_MS;
  console.log(`[${MOD}] local pending melee set for ${PENDING_MS}ms`);
}
function hasLocalPending() {
  return Date.now() <= localPendingUntil;
}
function clearLocalPending() {
  localPendingUntil = 0;
}

async function rollEvasion(actor, evasionName = "Evasion") {
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionName); } catch (e) {}
  }
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try { return await skills[key].roll(); } catch (e) {}
  }
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionName }); } catch (e) {}
  }
  ui.notifications.error(`[${MOD}] Couldn't roll "${evasionName}" on ${actor.name}.`);
  return null;
}

Hooks.once("ready", () => {
  console.log(`[${MOD}] ready. system=${game.system?.id}, user=${game.user?.id}`);

  // 1) When ANY melee-weapon card renders, mark LOCAL pending.
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // not a card; it already has a roll
    // Use innerText to catch CPRED's templating; html.text() can be empty sometimes.
    const text = (html?.[0]?.innerText || msg.content || "").toLowerCase();
    const looksMeleeCard =
      text.includes("melee weapon") || // shown on cards like Unarmed/Wolvers/etc.
      (text.includes("rof") && text.includes("damage") && text.includes("hands") && text.includes("melee")); // fallback heuristic

    if (looksMeleeCard) {
      console.log(`[${MOD}] saw melee weapon card → setting local pending`);
      setLocalPending();
    }
  });

  // 2) When a message with a *real roll* appears, and we're locally pending, treat as melee attack.
  Hooks.on("createChatMessage", async (msg) => {
    // CPRED (and some modules) don't always set msg.isRoll reliably; detect by presence of a Roll with numeric total
    const r = msg?.rolls?.[0];
    const total = (r && typeof r.total === "number") ? r.total : null;
    if (total === null) {
      // console.log(`[${MOD}] createChatMessage: no numeric roll total; ignoring`);
      return;
    }

    const pending = hasLocalPending();
    console.log(`[${MOD}] roll seen total=${total}, localPending=${pending}, authorId=${msg.authorId}`);

    if (!pending) return;             // we only care about the roll that immediately follows a melee card on this client
    clearLocalPending();              // consume it so we don't double-trigger

    // Require exactly ONE target on THIS client (so only the attacker fires)
    const targets = Array.from(game.user.targets || []);
    if (targets.length !== 1) {
      console.log(`[${MOD}] roll seen but targets.length=${targets.length}; not proceeding`);
      return;
    }

    const tDoc = targets[0]?.document;
    if (!tDoc) return;

    console.log(`[${MOD}] melee attack detected. attack=${total} → requesting GM evasion for ${targets[0].name}`);

    game.socket.emit(SOCKET, {
      sceneId: tDoc.parent?.id || canvas.scene?.id,
      tokenId: tDoc.id,
      defenderName: targets[0].name,
      attackTotal: total,
      evasionKey: "Evasion"
    });
  });

  // 3) GM: roll Evasion and post opposed result.
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;

    const scene = game.scenes.get(p.sceneId) || canvas.scene;
    const tDoc = scene?.tokens.get(p.tokenId);
    const actor = tDoc?.actor;
    if (!actor) return;

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
  });
});
