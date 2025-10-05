// CPRED Auto Evasion — Diagnostic v3 (Foundry V12)
// Handles BOTH flows:
//  A) Card → Roll (pending window)
//  B) Direct Sheet Roll (no card) — detect melee from roll content
//
// Loud logs + toasts so you can see every step.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

let pendingUntil = 0;
const PENDING_MS = 12000;
const MELEE_WORDS = ["melee weapon", "unarmed", "wolvers"]; // add more names here if needed

const log  = (...a) => console.log(`[${MOD}]`, ...a);
const warn = (...a) => console.warn(`[${MOD}]`, ...a);
const info = (m) => ui.notifications.info(`[${MOD}] ${m}`, { permanent: false });
const oops = (m) => ui.notifications.warn(`[${MOD}] ${m}`, { permanent: false });

function setPending() { pendingUntil = Date.now() + PENDING_MS; log(`PENDING SET (${PENDING_MS}ms)`); info("Melee card detected — waiting for the next roll…"); }
function hasPending() { return Date.now() <= pendingUntil; }
function clearPending() { pendingUntil = 0; log("PENDING CLEARED"); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function textify(htmlString) {
  try {
    const div = document.createElement("div");
    div.innerHTML = htmlString ?? "";
    return (div.textContent || div.innerText || "").trim();
  } catch { return htmlString || ""; }
}

function looksLikeMeleeText(rawText) {
  if (!rawText) return false;
  const t = rawText.toLowerCase();
  if (MELEE_WORDS.some(w => t.includes(w))) return true;
  // common CPRED card/roll cues
  if (t.includes("melee") && t.includes("rof") && t.includes("damage")) return true;
  return false;
}

function extractTotal(msg) {
  const r = msg?.rolls?.[0];
  return (r && typeof r.total === "number") ? r.total : null;
}

async function rollEvasion(actor, evasionName = "Evasion") {
  // A) system helper
  if (typeof actor.rollSkill === "function") {
    try { log(`rollEvasion via actor.rollSkill("${evasionName}")`); return await actor.rollSkill(evasionName); }
    catch (e) { warn("actor.rollSkill failed", e); }
  }
  // B) system.skills[*].roll
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && typeof skills[key]?.roll === "function") {
    try { log(`rollEvasion via system.skills["${key}"].roll()`); return await skills[key].roll(); }
    catch (e) { warn(`skills["${key}"].roll failed`, e); }
  }
  // C) sheet handler
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { log(`rollEvasion via actor.sheet._onRollSkill("${evasionName}")`); return await actor.sheet._onRollSkill({ skill: evasionName }); }
    catch (e) { warn("sheet._onRollSkill failed", e); }
  }
  return null;
}

Hooks.once("ready", () => {
  log(`READY — system=${game.system?.id} user=${game.user?.id} isGM=${game.user?.isGM}`);

  // DIAG: log all chat stages
  Hooks.on("preCreateChatMessage", (_doc, data) => {
    const preview = (data?.content || "").replace(/\s+/g, " ").slice(0, 160);
    log("preCreateChatMessage:", { hasRolls: !!data?.rolls?.length, preview });
  });
  Hooks.on("createChatMessage", (msg) => {
    const total = extractTotal(msg);
    const preview = (msg?.content || "").replace(/\s+/g, " ").slice(0, 160);
    log("createChatMessage:", { isRoll: msg.isRoll, total, authorId: msg.authorId, preview });
  });
  Hooks.on("renderChatMessage", (msg, html) => {
    const text = (html?.[0]?.innerText || msg.content || "").replace(/\s+/g, " ").slice(0, 160);
    log("renderChatMessage:", { isRoll: msg.isRoll, text });
  });

  // A) CARD PATH — mark pending when a melee weapon card renders
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // cards only
    const text = (html?.[0]?.innerText || msg.content || "");
    if (looksLikeMeleeText(text)) {
      log("Melee card detected", { snippet: text.slice(0, 200) });
      setPending();
    }
  });

  // B) ROLL PATH — either (pending && any roll) OR (direct sheet roll that looks melee)
  Hooks.on("createChatMessage", async (msg) => {
    const total = extractTotal(msg);
    if (total === null) return; // ignore non-rolls

    const rollText = textify(msg.content);
    const directMelee = looksLikeMeleeText(rollText); // sheet rolls often include weapon name/type in roll HTML

    const shouldTreatAsMelee = hasPending() || directMelee;
    log(`Roll seen: total=${total} pending=${hasPending()} directMelee=${directMelee}`);

    if (!shouldTreatAsMelee) return;
    if (hasPending()) clearPending();

    info(`Roll seen: ${total} (${directMelee ? "direct melee roll" : "pending melee"})`);

    // small delay to let targeting settle
    await sleep(50);

    const targets = Array.from(game.user.targets || []);
    log("Targets:", targets.map(t => ({ id: t.id, name: t.name })));
    if (targets.length !== 1) {
      oops(`Need exactly one target selected for auto-evasion (have ${targets.length}).`);
      return;
    }

    const tDoc = targets[0]?.document;
    if (!tDoc) { oops("Target has no TokenDocument."); return; }

    const payload = {
      sceneId: tDoc.parent?.id || canvas.scene?.id,
      tokenId: tDoc.id,
      defenderName: targets[0].name,
      attackTotal: total,
      evasionKey: "Evasion"
    };

    if (game.user.isGM) {
      log(`Solo GM: resolving evasion locally for ${payload.defenderName}`);
      await resolveEvasionLocal(payload);
    } else {
      log(`Multiplayer: emitting socket to GM`);
      game.socket.emit(SOCKET, payload);
      info("Sent attack to GM for auto-evasion…");
    }
  });

  // GM path (multiplayer tables)
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;
    log("GM socket received", p);
    info(`GM rolling Evasion for ${p.defenderName}…`);
    await resolveEvasionLocal(p);
  });
});

async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;

  if (!actor) {
    oops(`No actor found for token ${p.tokenId}.`);
    warn("resolveEvasionLocal: no actor", { p, scene, tDoc });
    return;
  }

  info(`Rolling Evasion for ${actor.name}…`);
  const ev = await rollEvasion(actor, p.evasionKey || "Evasion");
  const eTotal = ev?.total ?? null;

  if (eTotal === null) {
    oops(`Auto-roll failed on ${actor.name} — posting a button.`);
    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div>[${MOD}] <b>${actor.name}</b>: Auto Evasion failed.
        <button class="cpred-evasion-btn" data-actor-id="${actor.id}" data-attack="${p.attackTotal ?? ""}">
          Roll Evasion
        </button></div>`
    });

    Hooks.once("renderChatMessage", (_m, html) => {
      html.find(".cpred-evasion-btn").on("click", async (ev) => {
        const aId = ev.currentTarget.dataset.actorId;
        const atk = Number(ev.currentTarget.dataset.attack) || null;
        const a = game.actors.get(aId);
        if (!a) return;
        const r = await rollEvasion(a, p.evasionKey || "Evasion");
        const t = r?.total ?? "?";
        let content = `<b>${a.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${t}</b>`;
        if (typeof atk === "number" && typeof t === "number") {
          content += ` — <b>${atk > t ? "HIT" : "DODGED"}</b> (Attack ${atk} vs Evasion ${t})`;
        }
        ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: a }), content });
      });
    });

    return;
  }

  info(`Evasion = ${eTotal} (${actor.name})`);
  let content = `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${eTotal}</b>`;
  if (typeof p.attackTotal === "number") {
    const outcome = p.attackTotal > eTotal ? "HIT" : "DODGED";
    content += ` — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${eTotal})`;
  }
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
}
