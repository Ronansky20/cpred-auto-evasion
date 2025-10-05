// cpred-auto-evasion — DIAGNOSTIC BUILD (Foundry V12)
// Purpose: prove the hooks fire on your table, *and* show toasts so you don't need the console.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

let localPendingUntil = 0;
const PENDING_MS = 8000;

function setPending() {
  localPendingUntil = Date.now() + PENDING_MS;
  console.log(`[${MOD}] PENDING SET (${PENDING_MS}ms)`);
  ui.notifications.info(`[${MOD}] Melee card detected — waiting for the next roll…`, { permanent: false });
}
function hasPending() {
  return Date.now() <= localPendingUntil;
}
function clearPending() {
  localPendingUntil = 0;
  console.log(`[${MOD}] PENDING CLEARED`);
}

async function rollEvasion(actor, evasionName = "Evasion") {
  if (typeof actor.rollSkill === "function") {
    try { return await actor.rollSkill(evasionName); } catch (e) { /* fall through */ }
  }
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try { return await skills[key].roll(); } catch (e) { /* fall through */ }
  }
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { return await actor.sheet._onRollSkill({ skill: evasionName }); } catch (e) { /* fall through */ }
  }
  ui.notifications.error(`[${MOD}] Couldn't roll "${evasionName}" on ${actor.name}.`);
  return null;
}

// Catch fatal errors early so they don't silently kill our hooks.
window.addEventListener("error", (e) => {
  console.error(`[${MOD}] window error:`, e.error || e.message || e);
});

Hooks.once("ready", () => {
  try {
    console.log(`[${MOD}] READY. system=${game.system?.id} active=${game.modules.get(MOD)?.active}`);
    ui.notifications.info(`[${MOD}] Diagnostic build loaded.`, { permanent: false });

    // 0) Ultra-wide logging so we know messages are passing through at all
    Hooks.on("preCreateChatMessage", (doc, data) => {
      console.log(`[${MOD}] preCreateChatMessage`, { type: data?.type, hasRolls: !!data?.rolls?.length, flags: data?.flags });
    });

    Hooks.on("createChatMessage", async (msg) => {
      const total = msg?.rolls?.[0]?.total;
      console.log(`[${MOD}] createChatMessage → total=${total} authorId=${msg.authorId} isRoll=${msg.isRoll}`);
      if (typeof total === "number") {
        ui.notifications.info(`[${MOD}] Roll seen: ${total}${hasPending() ? " (pending melee)" : ""}`, { permanent: false });
      }

      // If we are pending and this has a numeric total, treat it as the melee attack.
      if (hasPending() && typeof total === "number") {
        clearPending();

        const targets = Array.from(game.user.targets || []);
        if (targets.length !== 1) {
          ui.notifications.warn(`[${MOD}] Roll seen but need exactly one target (have ${targets.length}).`, { permanent: false });
          return;
        }

        const tDoc = targets[0]?.document;
        if (!tDoc) return;

        console.log(`[${MOD}] Triggering GM evasion for ${targets[0].name} (attack=${total})`);
        game.socket.emit(SOCKET, {
          sceneId: tDoc.parent?.id || canvas.scene?.id,
          tokenId: tDoc.id,
          defenderName: targets[0].name,
          attackTotal: total,
          evasionKey: "Evasion"
        });
      }
    });

    // 1) Mark local pending when a melee **weapon card** renders (Unarmed/Wolvers/etc.)
    Hooks.on("renderChatMessage", (msg, html) => {
      // If this message already has a roll, it's not a pure card.
      if (msg?.rolls?.length) return;

      const text = (html?.[0]?.innerText || msg.content || "").toLowerCase();

      // Very explicit CPRED card tells:
      const looksMeleeCard =
        text.includes("melee weapon") ||
        (text.includes("rof") && text.includes("damage") && text.includes("hands") && text.includes("melee"));

      if (looksMeleeCard) {
        console.log(`[${MOD}] melee weapon card detected`, { snippet: text.slice(0, 120) });
        setPending();
      }
    });

    // 2) GM handler for evasion
    game.socket.on(SOCKET, async (p) => {
      if (!game.user.isGM) return;

      const scene = game.scenes.get(p.sceneId) || canvas.scene;
      const tDoc = scene?.tokens.get(p.tokenId);
      const actor = tDoc?.actor;
      if (!actor) return;

      ui.notifications.info(`[${MOD}] GM rolling Evasion for ${p.defenderName}…`, { permanent: false });

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

  } catch (err) {
    console.error(`[${MOD}] ready-hook error`, err);
  }
});
