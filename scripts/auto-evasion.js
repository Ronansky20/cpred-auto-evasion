// CPRED Auto Evasion — Diagnostic v5 (Foundry V12)
// -------------------------------------------------
// What’s new:
// - When auto-rolling Evasion, if CPRED APIs don’t return a Roll,
//   we OPEN THE DEFENDER’S SHEET and CLICK the Evasion button in the UI.
// - We then CAPTURE the next chat message from that actor that has a numeric total
//   and post a clean HIT/DODGED summary.
// - Full logs + toasts; works solo GM or with players.
//
// If this still fails, the logs will show exactly which step couldn’t find the Evasion control.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;
const VERBOSE_TOASTS = true;

const info = (m) => VERBOSE_TOASTS && ui.notifications.info(`[${MOD}] ${m}`, { permanent: false });
const warnN = (m) => ui.notifications.warn(`[${MOD}] ${m}`, { permanent: false });
const log  = (...a) => console.log(`[${MOD}]`, ...a);
const warn = (...a) => console.warn(`[${MOD}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MELEE_WORDS = ["melee weapon", "unarmed", "wolvers"];
const PENDING_MS = 12000;
const SHEET_ROLL_WAIT_MS = 4000; // wait for evasion chat after clicking sheet

let pendingUntil = 0;
function setPending() { pendingUntil = Date.now() + PENDING_MS; log(`PENDING SET (${PENDING_MS}ms)`); info("Melee card detected — waiting for the next roll…"); }
function hasPending() { return Date.now() <= pendingUntil; }
function clearPending() { pendingUntil = 0; log("PENDING CLEARED"); }

function textify(htmlString) {
  try { const div = document.createElement("div"); div.innerHTML = htmlString ?? ""; return (div.textContent || div.innerText || "").trim(); }
  catch { return htmlString || ""; }
}
function looksLikeMeleeText(txt) {
  const t = (txt || "").toLowerCase();
  if (MELEE_WORDS.some(w => t.includes(w))) return true;
  if (t.includes("melee") && t.includes("rof") && t.includes("damage")) return true;
  return false;
}
function extractTotal(msg) { const r = msg?.rolls?.[0]; return (r && typeof r.total === "number") ? r.total : null; }

// --- Capture the next chat message from a specific actor that contains a numeric total ---
function captureNextTotalForActor(actor, timeoutMs = 4000) {
  return new Promise(async (resolve) => {
    let resolved = false;
    const off = Hooks.on("createChatMessage", (msg) => {
      const sameActor =
        (msg.speaker?.actor === actor.id) ||
        (msg.speaker?.alias && msg.speaker.alias === actor.name);
      const total = extractTotal(msg);
      if (!sameActor || typeof total !== "number") return;
      if (!resolved) {
        resolved = true;
        Hooks.off("createChatMessage", off);
        resolve(total);
      }
    });
    const start = Date.now();
    while (!resolved && Date.now() - start < timeoutMs) await sleep(50);
    if (!resolved) {
      Hooks.off("createChatMessage", off);
      resolve(null);
    }
  });
}

// --- Try CPRED API roll helpers first (cheap path) ---
async function tryAPIEvasionRoll(actor, evasionName = "Evasion") {
  // A) actor.rollSkill
  if (typeof actor.rollSkill === "function") {
    try { log(`tryAPIEvasionRoll: actor.rollSkill("${evasionName}")`); await actor.rollSkill(evasionName); return true; }
    catch (e) { warn("actor.rollSkill failed", e); }
  }
  // B) system.skills[*].roll
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && typeof skills[key]?.roll === "function") {
    try { log(`tryAPIEvasionRoll: system.skills["${key}"].roll()`); await skills[key].roll(); return true; }
    catch (e) { warn(`skills["${key}"].roll failed`, e); }
  }
  // C) sheet handler
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { log(`tryAPIEvasionRoll: actor.sheet._onRollSkill("${evasionName}")`); await actor.sheet._onRollSkill({ skill: evasionName }); return true; }
    catch (e) { warn("sheet._onRollSkill failed", e); }
  }
  return false;
}

// --- Click the Evasion control on the defender's sheet (DOM path) ---
async function clickSheetEvasion(actor) {
  // Ensure sheet is rendered
  if (!actor.sheet.rendered) {
    log("Opening defender sheet to click Evasion…");
    await actor.sheet.render(true, { focus: false });
    // Allow a quick render tick
    await sleep(50);
  }

  const el = actor.sheet.element;
  if (!el || el.length === 0) { warn("Sheet element missing for actor", actor); return false; }

  // Common selectors to find the Evasion row/button on CPRED sheets
  // We search for a row containing "Evasion" then a button-like element on that row.
  const rows = el.find("*").filter((i, n) => /evasion/i.test(n.textContent || ""));
  if (!rows.length) {
    warn("Could not find any element containing 'Evasion' text on sheet.");
    return false;
  }

  // Try to find a clickable in the nearest row/container
  let clicked = false;
  rows.each((i, node) => {
    if (clicked) return;
    const row = $(node).closest(".skill, .list-row, tr, .flexrow, .item, .rollable, .cpred-skill, .cpred-row, .grid");
    const button = row.find('[data-action="roll-skill"], [data-action="roll"], [data-action*="roll"], button, .rollable, .roll, .fa-dice, .fa-hand-fist, .fa-hand-back-fist').first();
    if (button && button.length) {
      log("Clicking Evasion control on sheet…");
      // Click twice in case first opens options, second confirms
      button.trigger("click");
      // safety second click a moment later
      setTimeout(() => button.trigger("click"), 80);
      clicked = true;
    }
  });

  if (!clicked) warn("Found 'Evasion' row but no clickable control.");
  return clicked;
}

// --- MAIN HOOKS ---
Hooks.once("ready", () => {
  log(`READY — system=${game.system?.id} user=${game.user?.id} isGM=${game.user?.isGM}`);

  // Diagnostics
  Hooks.on("preCreateChatMessage", (_doc, data) => {
    const preview = (data?.content || "").replace(/\s+/g, " ").slice(0, 140);
    log("preCreateChatMessage", { hasRolls: !!data?.rolls?.length, preview });
  });
  Hooks.on("createChatMessage", (msg) => {
    const total = extractTotal(msg);
    const preview = (msg?.content || "").replace(/\s+/g, " ").slice(0, 140);
    log("createChatMessage", { isRoll: msg.isRoll, total, authorId: msg.authorId, preview });
  });
  Hooks.on("renderChatMessage", (msg, html) => {
    const text = (html?.[0]?.innerText || msg.content || "").replace(/\s+/g, " ").slice(0, 140);
    log("renderChatMessage", { isRoll: msg.isRoll, text });
  });

  // A) Mark PENDING on melee weapon cards (Unarmed/Wolvers/etc.)
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return; // not a pure card
    const raw = html?.[0]?.innerText || msg.content || "";
    if (looksLikeMeleeText(raw)) {
      log("Melee card detected", { snippet: raw.slice(0, 200) });
      setPending();
    }
  });

  // B) If a roll message appears and looks like melee (pending or direct melee text), handle it
  Hooks.on("createChatMessage", async (msg) => {
    const total = extractTotal(msg);
    if (total === null) return;

    const isDirectMelee = looksLikeMeleeText(textify(msg.content));
    const treatAsMelee = hasPending() || isDirectMelee;
    log(`Roll seen: total=${total} pending=${hasPending()} directMelee=${isDirectMelee}`);
    if (!treatAsMelee) return;
    if (hasPending()) clearPending();

    await handleDetectedAttack(total);
  });

  // C) Sheet Click path: fist/attack click on sheets (no roll message case)
  document.addEventListener("click", async (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    const btn = el.closest('[data-action="attack"], [data-action="roll-attack"], .attack, [title*="Attack"], [aria-label*="Attack"], .fa-hand-fist, .fa-hand-back-fist');
    if (!btn) return;

    // Heuristic: only treat as melee if row text whispers “melee”
    const rowText = (btn.closest(".item, .weapon, .rollcard, .window-content, .sheet")?.innerText || "").toLowerCase();
    if (!looksLikeMeleeText(rowText)) return;

    log("Sheet attack click detected (likely melee).");
    // small grace; if a roll is going to appear, let the ‘createChatMessage’ path handle it.
    setTimeout(() => handleDetectedAttack(null), 250);
  }, true);
});

// Central “we have a melee attack” handler
async function handleDetectedAttack(attackTotalOrNull) {
  info(`Melee attack detected${attackTotalOrNull !== null ? ` (roll ${attackTotalOrNull})` : ""}`);

  // Need exactly 1 target
  const targets = Array.from(game.user.targets || []);
  log("Targets:", targets.map(t => ({ id: t.id, name: t.name })));
  if (targets.length !== 1) { warnN(`Need exactly one target selected (have ${targets.length}).`); return; }

  const tDoc = targets[0]?.document;
  if (!tDoc) { warnN("Target has no TokenDocument."); return; }

  const payload = {
    sceneId: tDoc.parent?.id || canvas.scene?.id,
    tokenId: tDoc.id,
    defenderName: targets[0].name,
    attackTotal: attackTotalOrNull,
    evasionKey: "Evasion"
  };

  if (game.user.isGM) {
    await resolveEvasionLocal(payload);
  } else {
    game.socket.emit(SOCKET, payload);
    info("Sent to GM for auto-evasion…");
  }
}

// Resolve Evasion locally (GM) with robust capture & sheet-click fallback
async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;
  if (!actor) { warnN(`No actor for token ${p.tokenId}.`); return; }

  info(`Rolling Evasion for ${actor.name}…`);

  // 1) Try API methods; capture the resulting chat total.
  let total = null;
  const capPromise = captureNextTotalForActor(actor, SHEET_ROLL_WAIT_MS);
  const apiTriggered = await tryAPIEvasionRoll(actor, p.evasionKey || "Evasion");
  total = await capPromise;

  if (!apiTriggered || total === null) {
    log("API roll didn’t yield a readable total; trying sheet click…");
    // 2) Click the sheet Evasion control; capture again
    const cap2 = captureNextTotalForActor(actor, SHEET_ROLL_WAIT_MS);
    const clicked = await clickSheetEvasion(actor);
    total = await cap2;

    if (!clicked) log("Sheet click path: no clickable control found.");
  }

  if (total !== null) {
    info(`Evasion = ${total} (${actor.name})`);
    let content = `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${total}</b>`;
    if (typeof p.attackTotal === "number") {
      const outcome = p.attackTotal > total ? "HIT" : "DODGED";
      content += ` — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${total})`;
    }
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
    return;
  }

  // 3) Final fallback: post a button
  warnN(`Auto Evasion could not be read for ${actor.name}.`);
  const msg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div>[${MOD}] <b>${actor.name}</b>: Auto Evasion could not be read.
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

      // Try click path again in manual mode
      const cap = captureNextTotalForActor(a, SHEET_ROLL_WAIT_MS);
      const triggered = await tryAPIEvasionRoll(a, p.evasionKey || "Evasion");
      let t = await cap;

      if (t === null) {
        const cap2 = captureNextTotalForActor(a, SHEET_ROLL_WAIT_MS);
        const clicked = await clickSheetEvasion(a);
        t = await cap2;
        log("Manual button: apiTriggered=", triggered, "clicked=", clicked, "total=", t);
      }

      let content = `<b>${a.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${t ?? "?"}</b>`;
      if (typeof atk === "number" && typeof t === "number") {
        const outcome = atk > t ? "HIT" : "DODGED";
        content += ` — <b>${outcome}</b> (Attack ${atk} vs Evasion ${t})`;
      }
      ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: a }), content });
    });
  });
}
