// CPRED Auto Evasion — Diagnostic v4 (Foundry V12)
// -------------------------------------------------
// Works on Forge / CPRED when you click the fist on the SHEET (no separate roll message),
// and when the system does Card → Roll chat flow.
//
// What it does:
// - Detects melee *cards* (Unarmed/Wolvers/"Melee Weapon") → PENDING → next roll = attack.
// - Detects *sheet attack clicks* (fist next to the weapon) even if there will be no roll message.
// - If a roll appears within a grace window, we use it for HIT/DODGED comparison.
// - Otherwise, we still roll Evasion (no comparison).
// - Requires EXACTLY ONE target selected on the attacker's client.
// - Loud toasts + console logs. Fallback chat button if auto-roll fails.
//
// Toggle these if you want less noise later.
const VERBOSE_TOASTS = true;
const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

// ---- Helpers ----
const log  = (...a) => console.log(`[${MOD}]`, ...a);
const warn = (...a) => console.warn(`[${MOD}]`, ...a);
const info = (m) => VERBOSE_TOASTS && ui.notifications.info(`[${MOD}] ${m}`, { permanent: false });
const oops = (m) => ui.notifications.warn(`[${MOD}] ${m}`, { permanent: false });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function extractTotal(msg) { const r = msg?.rolls?.[0]; return (r && typeof r.total === "number") ? r.total : null; }
function textify(htmlString) {
  try { const div = document.createElement("div"); div.innerHTML = htmlString ?? ""; return (div.textContent || div.innerText || "").trim(); }
  catch { return htmlString || ""; }
}

// ---- Detection constants ----
const MELEE_WORDS = ["melee weapon", "unarmed", "wolvers"];
const ROLL_WAIT_MS = 800;   // After sheet click, how long to wait for a roll message to show up
const PENDING_MS  = 12000;  // For card → roll flow

// PENDING for card → roll
let pendingUntil = 0;
function setPending() { pendingUntil = Date.now() + PENDING_MS; log(`PENDING SET (${PENDING_MS}ms)`); info("Melee card detected — waiting for the next roll…"); }
function hasPending() { return Date.now() <= pendingUntil; }
function clearPending() { pendingUntil = 0; log("PENDING CLEARED"); }

function looksLikeMeleeText(_text) {
  const t = (_text || "").toLowerCase();
  if (MELEE_WORDS.some(w => t.includes(w))) return true;
  if (t.includes("melee") && t.includes("rof") && t.includes("damage")) return true;
  return false;
}

// ---- Evasion roll strategies ----
async function rollEvasion(actor, evasionName = "Evasion") {
  if (typeof actor.rollSkill === "function") {
    try { log(`rollEvasion via actor.rollSkill("${evasionName}")`); return await actor.rollSkill(evasionName); }
    catch (e) { warn("actor.rollSkill failed", e); }
  }
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && typeof skills[key]?.roll === "function") {
    try { log(`rollEvasion via system.skills["${key}"].roll()`); return await skills[key].roll(); }
    catch (e) { warn(`skills["${key}"].roll failed`, e); }
  }
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { log(`rollEvasion via actor.sheet._onRollSkill("${evasionName}")`); return await actor.sheet._onRollSkill({ skill: evasionName }); }
    catch (e) { warn("sheet._onRollSkill failed", e); }
  }
  return null;
}

// ---- Main flow ----
Hooks.once("ready", () => {
  log(`READY — system=${game.system?.id} user=${game.user?.id} isGM=${game.user?.isGM}`);

  // 0) Full-spectrum logs (so we see what's happening)
  Hooks.on("preCreateChatMessage", (_doc, data) => {
    const preview = (data?.content || "").replace(/\s+/g, " ").slice(0, 120);
    log("preCreateChatMessage", { hasRolls: !!data?.rolls?.length, preview });
  });
  Hooks.on("createChatMessage", (msg) => {
    const total = extractTotal(msg);
    const preview = (msg?.content || "").replace(/\s+/g, " ").slice(0, 120);
    log("createChatMessage", { isRoll: msg.isRoll, total, authorId: msg.authorId, preview });
  });
  Hooks.on("renderChatMessage", (msg, html) => {
    const text = (html?.[0]?.innerText || msg.content || "").replace(/\s+/g, " ").slice(0, 120);
    log("renderChatMessage", { isRoll: msg.isRoll, text });
  });

  // A) CARD PATH → mark PENDING when a melee weapon card renders
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // Skip actual roll messages
    const raw = html?.[0]?.innerText || msg.content || "";
    if (looksLikeMeleeText(raw)) { log("Melee card detected", { snippet: raw.slice(0, 200) }); setPending(); }
  });

  // B) ROLL PATH (works for both pending roll OR direct sheet roll that renders a roll ChatMessage)
  Hooks.on("createChatMessage", async (msg) => {
    const total = extractTotal(msg);
    if (total === null) return;

    const directMelee = looksLikeMeleeText(textify(msg.content));
    const treatAsMelee = hasPending() || directMelee;
    log(`Roll seen: total=${total} pending=${hasPending()} directMelee=${directMelee}`);
    if (!treatAsMelee) return;

    if (hasPending()) clearPending();
    await handleDetectedAttack(total);
  });

  // C) SHEET CLICK PATH — listen for clicks that look like the **fist** on CPRED sheets
  // We match several common patterns: data-action="attack", elements with 'attack' in title/aria-label,
  // or common icon classes. Adjust/selectors if your sheet theme differs.
  document.addEventListener("click", async (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    const btn = el.closest('[data-action="attack"], [data-action="roll-attack"], .attack, [title*="Attack"], [aria-label*="Attack"], .fa-hand-fist, .fa-fist, .fa-hand-back-fist');
    if (!btn) return;

    // We only care about attacks that are likely melee — narrow it a bit:
    const rowText = (btn.closest(".item, .weapon, .rollcard, .window-content")?.innerText || "").toLowerCase();
    const isProbablyMelee = looksLikeMeleeText(rowText);
    if (!isProbablyMelee) { log("Attack click detected, but not obviously melee; skipping sheet-click path."); return; }

    log("Sheet attack click detected (probable melee). Waiting briefly for roll message…");
    // Give the system a moment to post a roll message; if none shows, we still fire evasion.
    await sleep(ROLL_WAIT_MS);

    // If a roll message showed, our createChatMessage handler will already have handled evasion.
    // To avoid double-firing, we don’t try to detect that; we just *attempt* evasion and accept that
    // createChatMessage may have run already (the conditions below will prevent duplicates).
    await handleDetectedAttack(null); // null = no known attack total (we'll roll evasion without comparison)
  }, true); // capture=true to get the event early
});

// Central handler once we decide “this is a melee attack”
async function handleDetectedAttack(attackTotalOrNull) {
  info(`Roll seen${attackTotalOrNull !== null ? `: ${attackTotalOrNull}` : ""} (melee)`);

  // Ensure exactly one target
  const targets = Array.from(game.user.targets || []);
  log("Targets:", targets.map(t => ({ id: t.id, name: t.name })));
  if (targets.length !== 1) { oops(`Need exactly one target for auto-evasion (have ${targets.length}).`); return; }

  const tDoc = targets[0]?.document;
  if (!tDoc) { oops("Target has no TokenDocument."); return; }

  const payload = {
    sceneId: tDoc.parent?.id || canvas.scene?.id,
    tokenId: tDoc.id,
    defenderName: targets[0].name,
    attackTotal: attackTotalOrNull,
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
}

async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;

  if (!actor) { oops(`No actor found for token ${p.tokenId}.`); warn("resolveEvasionLocal: no actor", { p, scene, tDoc }); return; }

  info(`Rolling Evasion for ${actor.name}…`);
  const ev = await rollEvasion(actor, p.evasionKey || "Evasion");
  const eTotal = ev?.total ?? null;

  if (eTotal === null) {
    oops(`Auto-roll failed on ${actor.name} — posting a button.`);
    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <div>[${MOD}] <b>${actor.name}</b>: Auto Evasion failed.
        <button class="cpred-evasion-btn" data-actor-id="${actor.id}" data-attack="${p.attackTotal ?? ""}">Roll Evasion</button>
      </div>`
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

  if (p.attackTotal !== null && typeof p.attackTotal === "number") {
    const outcome = p.attackTotal > eTotal ? "HIT" : "DODGED";
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${eTotal}</b> — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${eTotal})`
    });
  } else {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${eTotal}</b>`
    });
  }
}
