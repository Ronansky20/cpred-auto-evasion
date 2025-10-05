// CPRED Auto Evasion — Diagnostic v2 (Foundry V12)
// Loud, step-by-step toasts and logs. Works solo GM or with players.
// Detects Unarmed/Wolvers/any melee weapon card → next roll = attack → auto-roll Evasion on the single target.
//
// New in v2:
// - Small delay before reading targets, to avoid race conditions.
// - Toast/log at every step (targets, tokenId, actor name).
// - Multiple evasion roll strategies + final fallback: chat button to roll Evasion manually.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rollEvasion(actor, evasionName = "Evasion") {
  // Strategy A: system helper
  if (typeof actor.rollSkill === "function") {
    try {
      console.log(`[${MOD}] rollEvasion via actor.rollSkill("${evasionName}")`);
      const r = await actor.rollSkill(evasionName);
      return r;
    } catch (e) { console.warn(`[${MOD}] actor.rollSkill failed`, e); }
  }
  // Strategy B: find labeled skill object with .roll()
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && skills[key]?.roll) {
    try {
      console.log(`[${MOD}] rollEvasion via system.skills["${key}"].roll()`);
      const r = await skills[key].roll();
      return r;
    } catch (e) { console.warn(`[${MOD}] skills["${key}"].roll failed`, e); }
  }
  // Strategy C: some sheets expose internal handler
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try {
      console.log(`[${MOD}] rollEvasion via actor.sheet._onRollSkill("${evasionName}")`);
      const r = await actor.sheet._onRollSkill({ skill: evasionName });
      return r;
    } catch (e) { console.warn(`[${MOD}] sheet._onRollSkill failed`, e); }
  }
  return null;
}

Hooks.once("ready", () => {
  console.log(`[${MOD}] READY — system=${game.system?.id} user=${game.user?.id} isGM=${game.user?.isGM}`);

  // 1) Mark pending when a melee weapon card renders (Unarmed/Wolvers/etc.)
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // skip actual roll messages
    const text = (html?.[0]?.innerText || msg.content || "").toLowerCase();

    const looksMeleeCard =
      text.includes("melee weapon") ||
      text.includes("unarmed") ||
      text.includes("wolvers") ||
      (text.includes("rof") && text.includes("damage") && text.includes("hands") && text.includes("melee"));

    if (looksMeleeCard) {
      console.log(`[${MOD}] Melee card detected`, { snippet: text.slice(0, 160) });
      setPending();
    }
  });

  // 2) When a roll appears and we're pending, treat it as the melee attack
  Hooks.on("createChatMessage", async (msg) => {
    const roll = msg?.rolls?.[0];
    const total = (roll && typeof roll.total === "number") ? roll.total : null;
    if (total === null) return;

    console.log(`[${MOD}] Roll seen → total=${total}, pending=${hasPending()}, authorId=${msg.authorId}`);
    if (!hasPending()) return;
    clearPending();

    ui.notifications.info(`[${MOD}] Roll seen: ${total} (pending melee)`, { permanent: false });

    // Wait one tick to ensure targeting state is committed
    await sleep(50);

    const targets = Array.from(game.user.targets || []);
    console.log(`[${MOD}] Targets length=${targets.length}`, targets.map(t => t.name));
    if (targets.length !== 1) {
      ui.notifications.warn(
        `[${MOD}] Need exactly one target selected for auto-evasion (have ${targets.length}).`,
        { permanent: false }
      );
      return;
    }

    const tDoc = targets[0]?.document;
    if (!tDoc) {
      ui.notifications.warn(`[${MOD}] Target has no TokenDocument — cannot resolve actor.`, { permanent: false });
      return;
    }
    console.log(`[${MOD}] Target tokenId=${tDoc.id} sceneId=${tDoc.parent?.id}`);

    const sceneId = tDoc.parent?.id || canvas.scene?.id;
    const tokenId = tDoc.id;
    const defenderName = targets[0].name;
    const attackTotal = total;
    const evasionKey = "Evasion";

    if (game.user.isGM) {
      console.log(`[${MOD}] Solo GM path: resolving evasion locally for ${defenderName}`);
      await resolveEvasionLocal({ sceneId, tokenId, defenderName, attackTotal, evasionKey });
    } else {
      console.log(`[${MOD}] Multiplayer path: sending socket to GM`);
      game.socket.emit(SOCKET, { sceneId, tokenId, defenderName, attackTotal, evasionKey });
      ui.notifications.info(`[${MOD}] Sent attack to GM for auto-evasion...`, { permanent: false });
    }
  });

  // 3) GM socket handler (multiplayer tables)
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;
    console.log(`[${MOD}] GM socket received`, p);
    ui.notifications.info(`[${MOD}] GM rolling Evasion for ${p.defenderName}...`, { permanent: false });
    await resolveEvasionLocal(p);
  });
});

// Shared resolver used by both local GM and socket GM
async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;

  if (!actor) {
    ui.notifications.warn(`[${MOD}] No actor found for token ${p.tokenId}.`, { permanent: false });
    console.warn(`[${MOD}] resolveEvasionLocal: no actor`, { p, scene, tDoc });
    return;
  }

  ui.notifications.info(`[${MOD}] Rolling Evasion for ${actor.name}...`, { permanent: false });

  const ev = await rollEvasion(actor, p.evasionKey || "Evasion");
  const eTotal = ev?.total ?? null;

  if (eTotal === null) {
    ui.notifications.warn(`[${MOD}] Could not auto-roll Evasion on ${actor.name} — posting a button instead.`, { permanent: false });

    // Post a fallback button so you can click to roll evasion manually
    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div>[${MOD}] <b>${actor.name}</b>: Auto-roll failed. 
        <button class="cpred-evasion-btn" data-actor-id="${actor.id}">Roll Evasion</button>
        ${typeof p.attackTotal === "number" ? `(Attack ${p.attackTotal})` : ""}</div>`
    });

    Hooks.once("renderChatMessage", (_m, html) => {
      html.find(".cpred-evasion-btn").on("click", async (ev) => {
        const aId = ev.currentTarget.dataset.actorId;
        const a = game.actors.get(aId);
        if (!a) return;
        const r = await rollEvasion(a, p.evasionKey || "Evasion");
        const t = r?.total ?? "?";
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: a }),
          content: `<b>${a.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${t}</b>${typeof p.attackTotal==="number" && typeof t==="number" ? ` — ${p.attackTotal > t ? "<b>HIT</b>" : "<b>DODGED</b>"} (Attack ${p.attackTotal} vs Evasion ${t})` : ""}`
        });
      });
    });

    return;
  }

  ui.notifications.info(`[${MOD}] Evasion roll = ${eTotal} (${actor.name})`, { permanent: false });

  let content = `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${eTotal}</b>`;
  if (typeof p.attackTotal === "number") {
    const outcome = p.attackTotal > eTotal ? "HIT" : "DODGED";
    content += ` — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${eTotal})`;
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}
