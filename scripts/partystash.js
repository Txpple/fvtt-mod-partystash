/**
 * Party Stash — true move semantics for the shared group inventory.
 *
 * Stock dnd5e drag-and-drop between actor sheets COPIES the item, so stocking a party
 * stash (a Group actor's inventory) from a member's sheet leaves a duplicate behind on
 * the source. dnd5e already ships a full "move" drop behavior — Shift-drag moves, and
 * the system then deletes the source only after the copy has actually been created,
 * merges consumable stacks, and carries container contents along — but the DEFAULT for
 * a cross-actor drag is "copy".
 *
 * This module flips that default to "move" for exactly one case: an item dragged
 * between a Group actor and one of its own members, when the dragging user owns BOTH
 * sides. Everything else — PC↔PC gifting, NPC looting, compendium/sidebar drops,
 * non-members — keeps the stock copy default. The system's own drop pipeline still
 * does all the work; because only the *default* is changed, the dnd5e drag modifiers
 * keep working: Ctrl-drag (or Alt-drag) still forces a copy when a duplicate is what
 * you want, Shift-drag still forces a move anywhere else.
 *
 * Scope rules (all must hold, checked live on every drag):
 *   - the dragged document is a physical Item embedded on a world Actor (spells,
 *     feats and the like are refused by the group sheet anyway — they stay "copy");
 *   - exactly one end of the drag is a group-type actor, and the other end is one of
 *     that group's members (drops onto a member row inside the group sheet count as
 *     drops onto that member, matching the sheet's own routing);
 *   - the user owns both the source and the target actor. When only ONE side is owned
 *     (e.g. dragging a fellow member's gear into the stash from their read-only sheet),
 *     the drop is BLOCKED ("none" + a warning) instead of falling back to the stock
 *     copy — the server would refuse the source delete and strand a duplicate. An
 *     intentional duplicate is still available via Ctrl-drag.
 *
 * v1.2 adds transfer receipts: every change to a group actor's loot — items in or out,
 * stack quantity changes, coin — is whispered to the GMs and the acting player as an
 * audit line (Loot Shelf's audit-line pattern, kept as a whisper here). Receipts ride
 * the document hooks rather than the drag pipeline, so GM stocking, forced Shift/Ctrl
 * drags and API calls are on the record too. See the receipts section below.
 *
 * Implemented as a wrap of BaseActorSheet#_defaultDropBehavior — the single seam where
 * dnd5e decides a drag's default behavior (same wrap style as fvtt-mod-autoexplore's
 * FogManager wraps). Verified against dnd5e 5.3.3 on Foundry v14: the group sheet
 * refuses non-physical items BEFORE the move-delete runs, and the source item is only
 * deleted after Item5e.createDocuments has resolved on the target, so a failed or
 * refused drop never destroys the original.
 */

const MODULE_ID = "fvtt-mod-partystash";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Move items between party and members",
    hint: "Dragging an item between a group actor's inventory and one of its members moves the "
      + "item instead of copying it, when you own both sides. If you own only one side, the drop "
      + "is blocked instead of leaving a duplicate behind. Hold Ctrl while dropping to copy "
      + "anyway. Turn this off to restore the stock copy-on-drop behavior everywhere.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "receipts", {
    name: "Whisper transfer receipts",
    hint: "Whisper a receipt to the GMs and the acting player whenever loot enters or leaves a "
      + "group actor's inventory or purse — an audit trail of who moved what through the party stash.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/** Recently-warned blocked drags, keyed "itemUuid->targetUuid" -> timestamp. */
const warned = new Map();

/**
 * Judge a drag against the stash scope rules in the header.
 * @param {ActorSheet} sheet   The sheet being dragged over.
 * @param {DragEvent} event    The dragover event.
 * @param {object} data        The drag payload ({type, uuid}).
 * @returns {"move"|"block"|null}  "move" when the drag is an owned member↔group stash
 *   transfer; "block" when it is a member↔group transfer the user can only half-perform
 *   (an unowned side would leave a duplicate behind); null when out of scope.
 */
function stashVerdict(sheet, event, data) {
  if (data?.type !== "Item" || !data.uuid) return null;
  const item = fromUuidSync(data.uuid);
  const source = item?.parent;
  if (!(item instanceof Item) || !(source instanceof Actor)) return null;
  if (!item.system?.schema?.fields?.quantity) return null; // physical items only

  // The effective target: the sheet's inventory actor — except on a group sheet, where
  // dropping onto a member's row hands the item to that member (the sheet's own routing).
  let target = sheet.inventorySource;
  if (sheet.actor?.type === "group") {
    const rowUuid = event.target?.closest?.("[data-uuid]")?.dataset?.uuid;
    const rowDoc = rowUuid ? fromUuidSync(rowUuid) : null;
    if (rowDoc instanceof Actor) target = rowDoc;
  }
  if (!(target instanceof Actor) || target === source) return null;

  // Exactly one end is a group, and the other end is one of ITS members.
  const sourceIsGroup = source.type === "group";
  if (sourceIsGroup === (target.type === "group")) return null;
  const group = sourceIsGroup ? source : target;
  const member = sourceIsGroup ? target : source;
  if (!group.system?.members?.some?.(m => m.actor === member)) return null;

  // A move deletes from the source and creates on the target — the user needs both. With
  // only one side owned the client could still COPY, but the server would refuse the source
  // delete and strand a duplicate (e.g. dragging an unowned member's gear into the stash).
  // Refuse the drop instead; an intentional duplicate is still one Ctrl-drag away.
  if (source.isOwner && target.isOwner) return "move";

  const key = `${data.uuid}->${target.uuid}`;
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) > 4000) {
    warned.set(key, now);
    for (const [k, t] of warned) if (now - t > 60000) warned.delete(k);
    const unowned = source.isOwner ? target : source;
    ui.notifications.warn(
      `Party Stash: you don't own ${unowned.name}, so this drag can't be a move and was `
      + "blocked to avoid leaving a duplicate behind. Hold Ctrl while dropping to copy on purpose."
    );
  }
  return "block";
}

Hooks.once("setup", () => {
  const Base = globalThis.dnd5e?.applications?.actor?.BaseActorSheet;
  const orig = Base?.prototype?._defaultDropBehavior;
  if (!orig) {
    console.error(`${MODULE_ID} | dnd5e BaseActorSheet#_defaultDropBehavior not found — `
      + "party-stash move semantics disabled (dnd5e 5.x required).");
    return;
  }

  Base.prototype._defaultDropBehavior = function (event, data) {
    const fallback = orig.call(this, event, data);
    if (fallback !== "copy") return fallback; // never touch same-sheet sorting ("move") etc.
    try {
      if (!game.settings.get(MODULE_ID, "enabled")) return fallback;
      const verdict = stashVerdict(this, event, data);
      if (verdict === "move") return "move";
      if (verdict === "block") return "none"; // no-drop cursor; the drop never lands
      return fallback;
    } catch (err) {
      console.error(`${MODULE_ID} | drop-behavior check failed`, err);
      return fallback;
    }
  };
});

/* -------------------------------------------------- */
/*  Transfer receipts                                 */
/* -------------------------------------------------- */

/**
 * Every change to a group actor's loot is whispered to the GMs and the acting player —
 * an audit trail of who moved what through the stash. The chat line itself is Loot
 * Shelf's audit pattern (speaker alias, actor names in bold), but whispered rather than
 * public: stash traffic is bookkeeping, not table news.
 *
 * Receipts ride the DOCUMENT hooks, not the drag pipeline, so every pathway is covered:
 * the module's own retargeted drags, forced Shift/Ctrl drags, sidebar and compendium
 * stocking by the GM, macros and API calls. Only the initiating client records (the
 * hooks fire on every client; userId says whose gesture it was), so exactly one receipt
 * is posted per transfer, authored by the user who made it.
 *
 * Events are buffered for a short window before posting so one gesture reads as one
 * receipt:
 *   - a container arriving or leaving with its contents is one line, not one per item —
 *     content events are recognized by their container id being part of the same batch
 *     (nested containers chain-suppress the same way);
 *   - dnd5e's move pipeline lands as a create on one end plus a delete on the other, a
 *     few ms apart. When the two halves pair up (same item name and amount, opposite
 *     directions, the other end a member of that group) the receipt names the member
 *     ("Bob stashed …"); when pairing misses — a Ctrl-drag copy, GM stocking from the
 *     sidebar, a late delete ack — the receipt still lands, named after the acting user
 *     ("Alice added …");
 *   - consumable stack merges surface as a quantity delta on the existing stack rather
 *     than a create (captured via preUpdate), and pair the same way. Manual quantity
 *     edits on a stash item come out as plain added/removed lines — a GM adjusting the
 *     stash is also worth a line in the ledger.
 *
 * Coin is loot too: currency changes on a group actor get their own receipt with signed
 * per-denomination deltas — no re-denomination, matching Loot Shelf's coin manners.
 */

const RECEIPT_WINDOW = 500;
const receipts = { events: [], timer: null };

function receiptsEnabled() {
  try {
    return game.settings.get(MODULE_ID, "receipts");
  } catch {
    return false;
  }
}

/** True when `actor` is a member of any group actor in the world. */
function isGroupMember(actor) {
  return game.actors.some(g =>
    g.type === "group" && g.system?.members?.some?.(m => m.actor === actor));
}

/**
 * Queue one side of a transfer for the next receipt flush. Group-actor events become
 * receipt lines; member events are context, consulted only to name the counterparty.
 * @param {Item} item            The item that changed hands (or changed quantity).
 * @param {"gain"|"loss"} dir    Whether the item's actor gained or lost the amount.
 * @param {number} amount        How many changed hands.
 * @param {boolean} fromStack    The event was a quantity delta on an existing stack,
 *                               not a create/delete — never a container with cargo.
 */
function recordReceipt(item, dir, amount, fromStack = false) {
  const actor = item.parent;
  if (!(actor instanceof Actor) || actor.pack) return;
  const isGroup = actor.type === "group";
  if (!isGroup && !isGroupMember(actor)) return;
  receipts.events.push({
    dir, amount, isGroup, actor, fromStack,
    name: item.name,
    id: item.id,
    containerId: item.system?.container ?? null,
    isContainer: item.type === "container",
    used: false
  });
  clearTimeout(receipts.timer);
  receipts.timer = setTimeout(flushReceipts, RECEIPT_WINDOW);
}

function flushReceipts() {
  receipts.timer = null;
  const events = receipts.events;
  receipts.events = [];
  try {
    const groupEvents = events.filter(e => e.isGroup);
    if (!groupEvents.length) return;
    const memberEvents = events.filter(e => !e.isGroup);

    // Containers that moved in this batch, per direction — anything created or deleted
    // INSIDE one of them is cargo, implied by the container's own line.
    const movedContainers = dir => new Set(
      groupEvents.filter(e => e.isContainer && !e.fromStack && e.dir === dir).map(e => e.id));
    const gained = movedContainers("gain");
    const lost = movedContainers("loss");

    const lines = [];
    for (const g of groupEvents) {
      if (g.containerId && !g.fromStack && (g.dir === "gain" ? gained : lost).has(g.containerId)) continue;
      const pair = memberEvents.find(m => !m.used && m.dir !== g.dir
        && m.name === g.name && m.amount === g.amount
        && g.actor.system?.members?.some?.(mm => mm.actor === m.actor));
      if (pair) pair.used = true;
      const cargo = g.isContainer && events.some(e => e !== g && e.containerId === g.id);
      const label = `${g.amount} × <em>${g.name}</em>${cargo ? " (and its contents)" : ""}`;
      const group = `<strong>${g.actor.name}</strong>`;
      if (g.dir === "gain") {
        lines.push(pair
          ? `<strong>${pair.actor.name}</strong> stashed ${label} in ${group}.`
          : `<strong>${game.user.name}</strong> added ${label} to ${group}.`);
      } else {
        lines.push(pair
          ? `<strong>${pair.actor.name}</strong> took ${label} from ${group}.`
          : `<strong>${game.user.name}</strong> removed ${label} from ${group}.`);
      }
    }
    if (lines.length) postReceipt(lines);
  } catch (err) {
    console.error(`${MODULE_ID} | building the transfer receipt failed`, err);
  }
}

/**
 * Whisper receipt lines to the GMs and the acting player. Created by the acting client,
 * so the message is authored by the right user without the proxy-side `author` juggling
 * Loot Shelf needs; the alias keeps it visibly a Party Stash ledger line.
 */
function postReceipt(lines) {
  const whisper = [...new Set([
    ...game.users.filter(u => u.isGM).map(u => u.id),
    game.user.id
  ])];
  ChatMessage.implementation.create({
    content: lines.join("<br>"),
    whisper,
    speaker: { alias: "Party Stash" }
  }).catch(err => console.error(`${MODULE_ID} | receipt message failed`, err));
}

Hooks.on("createItem", (item, options, userId) => {
  try {
    if (userId !== game.user.id || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return; // physical items only
    recordReceipt(item, "gain", Math.max(1, Math.floor(item.system.quantity ?? 1)));
  } catch (err) {
    console.error(`${MODULE_ID} | receipt create-hook failed`, err);
  }
});

Hooks.on("deleteItem", (item, options, userId) => {
  try {
    if (userId !== game.user.id || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return;
    recordReceipt(item, "loss", Math.max(1, Math.floor(item.system.quantity ?? 1)));
  } catch (err) {
    console.error(`${MODULE_ID} | receipt delete-hook failed`, err);
  }
});

// Quantity deltas need the before value, which only preUpdate can see; it rides across
// on `options` (preUpdate fires initiator-side only, and only that client posts).
Hooks.on("preUpdateItem", (item, changes, options, userId) => {
  try {
    if (changes.system?.quantity === undefined || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return;
    foundry.utils.setProperty(options, `${MODULE_ID}.quantity`, item.system.quantity);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt pre-update failed`, err);
  }
});

Hooks.on("updateItem", (item, changes, options, userId) => {
  try {
    if (userId !== game.user.id || !receiptsEnabled()) return;
    const before = foundry.utils.getProperty(options, `${MODULE_ID}.quantity`);
    if (before === undefined) return;
    const delta = Math.floor(item.system.quantity ?? 0) - Math.floor(before ?? 0);
    if (!delta) return;
    recordReceipt(item, delta > 0 ? "gain" : "loss", Math.abs(delta), true);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt update-hook failed`, err);
  }
});

Hooks.on("preUpdateActor", (actor, changes, options, userId) => {
  try {
    if (actor.type !== "group" || actor.pack) return;
    if (changes.system?.currency === undefined || !receiptsEnabled()) return;
    foundry.utils.setProperty(options, `${MODULE_ID}.currency`, { ...actor.system.currency });
  } catch (err) {
    console.error(`${MODULE_ID} | receipt currency pre-update failed`, err);
  }
});

Hooks.on("updateActor", (actor, changes, options, userId) => {
  try {
    if (userId !== game.user.id || !receiptsEnabled()) return;
    const before = foundry.utils.getProperty(options, `${MODULE_ID}.currency`);
    if (!before) return;
    const parts = [];
    let gains = 0, losses = 0;
    for (const coin of ["pp", "gp", "ep", "sp", "cp"]) {
      const delta = Math.floor(actor.system.currency?.[coin] ?? 0) - Math.floor(before[coin] ?? 0);
      if (!delta) continue;
      parts.push(`${delta > 0 ? "+" : ""}${delta} ${coin}`);
      if (delta > 0) gains++;
      else losses++;
    }
    if (!parts.length) return;
    const verb = losses === 0 ? "added coin to" : gains === 0 ? "took coin from" : "adjusted the coin in";
    postReceipt([`<strong>${game.user.name}</strong> ${verb} <strong>${actor.name}</strong>: ${parts.join(", ")}.`]);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt currency-hook failed`, err);
  }
});
