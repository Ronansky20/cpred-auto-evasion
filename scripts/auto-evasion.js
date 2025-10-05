// CPRED Auto Evasion (Melee) — Production (Foundry V12)
// - Supports both sheet fist clicks (no chat roll message) and card→roll flows.
// - Requires exactly one target selected by the attacker.
// - Rolls Evasion locally if user is GM; otherwise asks GM via socket.
// - If CPRED API doesn't return a Roll, it clicks the Evasion control on the defender's sheet.
// - If still no numeric total, posts a single “Roll Evasion” chat button.

const MOD = "cpred-auto-evasion";
const SOCKET = `module.${MOD}`;

const MELEE_WORDS = ["melee weapon", "unarmed", "wolvers"]; // add more names if needed
const PENDING_MS = 12000;        // for card→roll flow
const SHEET_ROLL_WAIT_MS = 4000; // wait after triggering evasion for chat roll

let pendingUntil = 0;

function setPending() { pendingUntil = Date.now() + PENDING_MS; }
function hasPending()  { return Date.now() <= pendingUntil; }
function clearPending(){ pendingUntil = 0; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
function extractTotal(msg) {
  const r = msg?.rolls?.[0];
  return (r && typeof r.total === "number") ? r.total : null;
}

// Capture the next chat message with a numeric total from this actor
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

// Try CPRED API roll helpers first
async function tryAPIEvasionRoll(actor, evasionName = "Evasion") {
  if (typeof actor.rollSkill === "function") {
    try { await actor.rollSkill(evasionName); return true; } catch {}
  }
  const skills = foundry.utils.getProperty(actor, "system.skills") || {};
  const key = Object.keys(skills).find(k => {
    const nm = (skills[k]?.label || skills[k]?.name || k).toString().toLowerCase();
    return nm === evasionName.toLowerCase();
  });
  if (key && typeof skills[key]?.roll === "function") {
    try { await skills[key].roll(); return true; } catch {}
  }
  if (actor.sheet && typeof actor.sheet._onRollSkill === "function") {
    try { await actor.sheet._onRollSkill({ skill: evasionName }); return true; } catch {}
  }
  return false;
}

// Click the Evasion control on the defender's sheet (DOM path)
async function clickSheetEvasion(actor) {
  if (!actor.sheet.rendered) {
    await actor.sheet.render(true, { focus: false });
    await sleep(50);
  }
  const el = actor.sheet.element;
  if (!el || el.length === 0) return false;

  const rows = el.find("*").filter((i, n) => /evasion/i.test(n.textContent || ""));
  if (!rows.length) return false;

  let clicked = false;
  rows.each((i, node) => {
    if (clicked) return;
    const row = $(node).closest(".skill, .list-row, tr, .flexrow, .item, .rollable, .cpred-skill, .cpred-row, .grid");
    const button = row.find('[data-action="roll-skill"], [data-action="roll"], [data-action*="roll"], button, .rollable, .roll, .fa-dice, .fa-hand-fist, .fa-hand-back-fist').first();
    if (button && button.length) {
      button.trigger("click");
      setTimeout(() => button.trigger("click"), 80); // some sheets need a second click
      clicked = true;
    }
  });
  return clicked;
}

Hooks.once("ready", () => {
  // CARD PATH — mark pending for melee weapon cards
  Hooks.on("renderChatMessage", (msg, html) => {
    if (msg?.rolls?.length) return;
    const raw = html?.[0]?.innerText || msg.content || "";
    if (looksLikeMeleeText(raw)) setPending();
  });

  // ROLL PATH — handle card→roll or direct sheet roll messages
  Hooks.on("createChatMessage", async (msg) => {
    const total = extractTotal(msg);
    if (total === null) return;

    const isDirectMelee = looksLikeMeleeText(textify(msg.content));
    if (!hasPending() && !isDirectMelee) return;
    if (hasPending()) clearPending();

    await handleDetectedAttack(total);
  });

  // SHEET CLICK PATH — when the fist is clicked on the sheet and there may be no roll message
  document.addEventListener("click", async (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    const btn = el.closest('[data-action="attack"], [data-action="roll-attack"], .attack, [title*="Attack"], [aria-label*="Attack"], .fa-hand-fist, .fa-hand-back-fist');
    if (!btn) return;

    const rowText = (btn.closest(".item, .weapon, .rollcard, .window-content, .sheet")?.innerText || "");
    if (!looksLikeMeleeText(rowText)) return;

    // Give the system a moment: if a roll message appears, the roll path will handle it.
    setTimeout(() => { handleDetectedAttack(null); }, 250);
  }, true);

  // GM socket (multiplayer tables)
  game.socket.on(SOCKET, async (p) => {
    if (!game.user.isGM) return;
    await resolveEvasionLocal(p);
  });
});

// Central handler once we’ve decided “this is a melee attack”
async function handleDetectedAttack(attackTotalOrNull) {
  const targets = Array.from(game.user.targets || []);
  if (targets.length !== 1) return;

  const tDoc = targets[0]?.document;
  if (!tDoc) return;

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
  }
}

// Resolve Evasion locally (GM) with capture & sheet-click fallback
async function resolveEvasionLocal(p) {
  const scene = game.scenes.get(p.sceneId) || canvas.scene;
  const tDoc = scene?.tokens.get(p.tokenId);
  const actor = tDoc?.actor;
  if (!actor) return;

  // 1) Try API methods and capture the resulting chat total
  let total = null;
  const cap1 = captureNextTotalForActor(actor, SHEET_ROLL_WAIT_MS);
  const apiTriggered = await tryAPIEvasionRoll(actor, p.evasionKey || "Evasion");
  total = await cap1;

  // 2) If no total, try clicking the sheet Evasion control and capture again
  if (!apiTriggered || total === null) {
    const cap2 = captureNextTotalForActor(actor, SHEET_ROLL_WAIT_MS);
    const clicked = await clickSheetEvasion(actor);
    total = await cap2;
    // clicked flag intentionally unused beyond attempting the click
  }

  if (total !== null) {
    // Post a single clean summary message with comparison if we had the attack total
    let content = `<b>${p.defenderName || actor.name}</b> rolls <i>${p.evasionKey || "Evasion"}</i>: <b>${total}</b>`;
    if (typeof p.attackTotal === "number") {
      const outcome = p.attackTotal > total ? "HIT" : "DODGED";
      content += ` — <b>${outcome}</b> (Attack ${p.attackTotal} vs Evasion ${total})`;
    }
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
    return;
  }

  // 3) Final fallback: post a single button to let you trigger it manually
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

      // Try API + capture again
      let t = null;
      const cap = captureNextTotalForActor(a, SHEET_ROLL_WAIT_MS);
      const trig = await tryAPIEvasionRoll(a, p.evasionKey || "Evasion");
      t = await cap;

      if (t === null) {
        const cap2 = captureNextTotalForActor(a, SHEET_ROLL_WAIT_MS);
        const clicked = await clickSheetEvasion(a);
        t = await cap2;
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
