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
 * stack quantity changes, coin — is posted to chat as an audit line (Loot Shelf's audit-line
 * pattern). Receipts ride the document hooks rather than the drag pipeline, so GM stocking,
 * forced Shift/Ctrl drags and API calls are on the record too. They were whispered to the GMs
 * and the acting player until v1.3 made them public, the same call Loot Shelf made: a stash
 * ledger only settles arguments if the whole table can read it. v1.4 turns that verdict into
 * a choice — Receipt Settings picks between broadcasting to the server (still the default) and
 * whispering to the transfer's participants and the DMs, the same two options Loot Shelf
 * offers, so one policy can cover both modules. See the receipts section below.
 *
 * v1.3 adds the coin window. Items move by drag; coin cannot be dragged, so moving gold in
 * and out of the stash meant the system's currency manager, which players could not find or
 * work out — it cost a live session. The group sheet's currency row now carries DEPOSIT and
 * WITHDRAW buttons opening a small dialog, and for players the purse fields themselves go
 * READ-ONLY (the system's own "Manage Currency" button is removed with them) so the dialog
 * is the one way coin moves. GMs keep the stock editable row and the system button as an
 * admin escape hatch. See the coin section below.
 *
 * Implemented as a wrap of BaseActorSheet#_defaultDropBehavior — the single seam where
 * dnd5e decides a drag's default behavior (same wrap style as fvtt-mod-autoexplore's
 * FogManager wraps). Verified against dnd5e 5.3.3 on Foundry v14: the group sheet
 * refuses non-physical items BEFORE the move-delete runs, and the source item is only
 * deleted after Item5e.createDocuments has resolved on the target, so a failed or
 * refused drop never destroys the original.
 */

const MODULE_ID = "fvtt-mod-partystash";

/**
 * The two receipt delivery policies, in the order the settings sheet reads them. The labels
 * double as the stored setting's `choices`; the notes are rendered under the radios.
 */
const RECEIPT_MODES = [
  {
    value: "public",
    label: "Broadcast receipts to the server",
    note: "Every receipt is posted to the chat log for the whole table to read."
  },
  {
    value: "participants",
    label: "Receipts to the transaction participants and the DMs",
    note: "Whispered to the player on the other end of the transfer — whoever stashed, took, "
      + "deposited or withdrew — and to the DMs. Assistant DMs count as DMs here and see "
      + "every receipt."
  }
];

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
    name: "Post transfer receipts",
    hint: "Post a receipt to the chat log whenever loot enters or leaves a group actor's "
      + "inventory or purse — a shared record of who moved what through the party stash.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "receiptVisibility", {
    name: "Receipts",
    hint: "Who reads the receipt when items or coin move through the party stash.",
    scope: "world",
    config: true,
    type: String,
    default: "public",
    choices: Object.fromEntries(RECEIPT_MODES.map(m => [m.value, m.label]))
  });

  game.settings.register(MODULE_ID, "coin", {
    name: "Deposit / withdraw coin window",
    hint: "Put Deposit and Withdraw buttons on a group actor's currency row, and make that "
      + "row read-only for players so coin moves through the dialog instead of by hand. GMs "
      + "keep the editable fields and the system's own currency manager either way. Turn "
      + "this off to restore the stock currency row for everyone.",
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

/**
 * Should THIS client post the receipt for a change made by `userId`? The acting client does.
 *
 * Document hooks fire on every connected client, so somebody must be elected or one transfer
 * is logged once per browser.
 *
 * Loot Shelf's kernel elects the GM (`game.users.activeGM`) and that was tried here first, on
 * 2026-08-12, because it is per-WORLD rather than per-user and so cannot double. It was WRONG
 * for this module and is deliberately not used: Loot Shelf already requires a GM for every
 * mutation — players cannot write to a merchant — whereas Party Stash's updates run entirely
 * on the acting client. Electing the GM therefore imports a dependency the module otherwise
 * does not have, and when the elected GM's client is absent or running a stale script, EVERY
 * receipt silently vanishes. That was observed live: transfers landed, the ledger stayed empty.
 *
 * A missing ledger is worse than a doubled line, so the acting client posts. The known cost is
 * that one user with two live sessions logs each of their own transfers twice; in normal play a
 * user has one session, and a duplicate is legible noise rather than lost history.
 */
function shouldPostReceipt(userId) {
  return userId === game.user.id;
}

/** The name to credit in a receipt line — the user whose gesture caused the change. */
function actingName(userId) {
  return game.users.get(userId)?.name ?? game.user.name;
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
function recordReceipt(item, dir, amount, fromStack = false, userId = game.user.id) {
  const actor = item.parent;
  if (!(actor instanceof Actor) || actor.pack) return;
  const isGroup = actor.type === "group";
  if (!isGroup && !isGroupMember(actor)) return;
  receipts.events.push({
    dir, amount, isGroup, actor, fromStack, userId,
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
    // The members this batch names — the personal end of each transfer, and so who (besides
    // the DMs) a whispered receipt is addressed to.
    const participants = new Set();
    for (const g of groupEvents) {
      if (g.containerId && !g.fromStack && (g.dir === "gain" ? gained : lost).has(g.containerId)) continue;
      const pair = memberEvents.find(m => !m.used && m.dir !== g.dir
        && m.name === g.name && m.amount === g.amount
        && g.actor.system?.members?.some?.(mm => mm.actor === m.actor));
      if (pair) {
        pair.used = true;
        participants.add(pair.actor);
      }
      const cargo = g.isContainer && events.some(e => e !== g && e.containerId === g.id);
      const label = `${g.amount} × <em>${g.name}</em>${cargo ? " (and its contents)" : ""}`;
      const group = `<strong>${g.actor.name}</strong>`;
      if (g.dir === "gain") {
        lines.push(pair
          ? `<strong>${pair.actor.name}</strong> stashed ${label} in ${group}.`
          : `<strong>${actingName(g.userId)}</strong> added ${label} to ${group}.`);
      } else {
        lines.push(pair
          ? `<strong>${pair.actor.name}</strong> took ${label} from ${group}.`
          : `<strong>${actingName(g.userId)}</strong> removed ${label} from ${group}.`);
      }
    }
    if (lines.length) postReceipt(lines, groupEvents[0]?.userId, [...participants]);
  } catch (err) {
    console.error(`${MODULE_ID} | building the transfer receipt failed`, err);
  }
}

/**
 * The whisper list for a receipt, or null to post it to the whole table.
 *
 * "The DMs" means every user with the ASSISTANT role or above — what `User#isGM` answers and
 * `getWhisperRecipients("GM")` resolves — so an assistant DM is on every receipt. The setting
 * note says so rather than leaving a co-DM to discover it by missing one.
 *
 * PARTICIPANTS are the MEMBER side of the transfer — whoever stashed, took, deposited or
 * withdrew — plus the acting user, who may be a GM moving things on a player's behalf. The
 * GROUP actor is deliberately never consulted for recipients even though it is the other end
 * of every transfer: at this table (and at any table where the v1.1 drags work at all) the
 * players own the group, so counting its owners would quietly turn every whisper back into a
 * broadcast and make the setting a no-op.
 *
 * @param {string} [userId]         The acting user.
 * @param {Actor[]} [participants]  The member-side actors in the transfer.
 * @returns {string[]|null}         User ids to whisper to, or null for a public message.
 */
function receiptWhisper(userId, participants = []) {
  let mode = "public";
  try {
    mode = game.settings.get(MODULE_ID, "receiptVisibility");
  } catch {
    return null; // not registered yet — a public line beats a lost one
  }
  if (mode !== "participants") return null;

  const ids = new Set(ChatMessage.implementation.getWhisperRecipients("GM").map(u => u.id));
  if (userId) ids.add(userId);
  for (const actor of participants) {
    if (!(actor instanceof Actor)) continue;
    for (const u of game.users) {
      if (!ids.has(u.id) && actor.testUserPermission(u, "OWNER")) ids.add(u.id);
    }
  }
  return [...ids];
}

/**
 * Post receipt lines.
 *
 * These were whispered to the GMs and the acting player through v1.2, which made every stash
 * transfer invisible to everyone else — and a SHARED ledger is the point: it is what settles
 * "who took the healing potion?" without anyone having to remember. Public by the owner's
 * call on 2026-08-12, matching what Loot Shelf's audit lines already do for shop and chest
 * traffic — the two modules' logs read as one running account of the party's stuff. Since
 * v1.4 that is the DEFAULT rather than the only option: the Receipt Settings can send the
 * line to the transfer's participants and the DMs instead, the same choice Loot Shelf offers,
 * so a table can set one policy across both modules.
 *
 * Created by the acting client, so the message is authored by the right user without the
 * proxy-side `author` juggling Loot Shelf needs; the alias keeps it visibly a Party Stash
 * ledger line rather than something a character said.
 *
 * @param {string[]} lines          The receipt lines, already formatted.
 * @param {string} [userId]         The acting user.
 * @param {Actor[]} [participants]  The member-side actors in the transfer.
 */
function postReceipt(lines, userId, participants = []) {
  const whisper = receiptWhisper(userId, participants);
  ChatMessage.implementation.create({
    content: lines.join("<br>"),
    ...(userId ? { author: userId } : {}),
    ...(whisper ? { whisper } : {}),
    speaker: { alias: "Party Stash" }
  }).catch(err => console.error(`${MODULE_ID} | receipt message failed`, err));
}

Hooks.on("createItem", (item, options, userId) => {
  try {
    if (!shouldPostReceipt(userId) || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return; // physical items only
    recordReceipt(item, "gain", Math.max(1, Math.floor(item.system.quantity ?? 1)), false, userId);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt create-hook failed`, err);
  }
});

Hooks.on("deleteItem", (item, options, userId) => {
  try {
    if (!shouldPostReceipt(userId) || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return;
    recordReceipt(item, "loss", Math.max(1, Math.floor(item.system.quantity ?? 1)), false, userId);
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
    if (!shouldPostReceipt(userId) || !receiptsEnabled()) return;
    const before = foundry.utils.getProperty(options, `${MODULE_ID}.quantity`);
    if (before === undefined) return;
    const delta = Math.floor(item.system.quantity ?? 0) - Math.floor(before ?? 0);
    if (!delta) return;
    recordReceipt(item, delta > 0 ? "gain" : "loss", Math.abs(delta), true, userId);
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
    if (!shouldPostReceipt(userId) || !receiptsEnabled()) return;
    // Only a group actor's purse is stash traffic. The before-image below is written by
    // preUpdateActor, which already checks this — but the check is repeated here so a stray
    // options object can never make a member's own purse post a stash receipt.
    if (actor.type !== "group" || actor.pack) return;
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

    // A deposit/withdraw knows both ends, so its receipt names the member and the direction
    // rather than the acting user and a signed delta. Everything else — a GM editing the row,
    // an award, an API call — still reads as an adjustment, which is what it is.
    const transfer = foundry.utils.getProperty(options, `${MODULE_ID}.transfer`);
    if (transfer?.member) {
      const moved = formatCoins(transfer.amounts);
      // The dialog rides the member's uuid across so a whispered receipt can reach its
      // owners; the NAME is what the line prints, and stays the thing it is rendered from.
      const member = transfer.memberUuid ? fromUuidSync(transfer.memberUuid) : null;
      postReceipt([`<strong>${transfer.member}</strong> `
        + (transfer.dir === "deposit"
          ? `deposited <strong>${moved}</strong> into <strong>${actor.name}</strong>.`
          : `withdrew <strong>${moved}</strong> from <strong>${actor.name}</strong>.`)],
        userId, member instanceof Actor ? [member] : []);
      return;
    }

    const verb = losses === 0 ? "added coin to" : gains === 0 ? "took coin from" : "adjusted the coin in";
    postReceipt([`<strong>${actingName(userId)}</strong> ${verb} `
      + `<strong>${actor.name}</strong>: ${parts.join(", ")}.`], userId);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt currency-hook failed`, err);
  }
});

/**
 * Settings-sheet polish: section headers, and the delivery choice as a labelled RADIO GROUP
 * instead of the dropdown a `choices` setting gets by default — two mutually exclusive
 * policies with a paragraph of consequence each is what radios are for, and a `<select>` has
 * nowhere to put the consequences. Same block, same wording, as Loot Shelf's: the two modules
 * are configured side by side and a table sets one policy across both.
 *
 * The registered `<select>` stays in the form as the real field, merely hidden. It is what
 * core reads on submit and what core's "Reset Defaults" writes to — that handler dispatches a
 * `change` event on `form[key]`, which would throw on the RadioNodeList that same-named radios
 * would make of it. The radios carry no submitting name of their own: they drive the select,
 * and follow it back when something else changes it. If this whole hook failed, the setting
 * would degrade to a plain working dropdown.
 *
 * Receipts off means there is nothing to deliver, so the choice greys out and follows the
 * toggle live (a disabled field is skipped by form submission, so it simply keeps its stored
 * value — the same greying rule fvtt-mod-combatplus uses for its dependent settings).
 */
Hooks.on("renderSettingsConfig", (app, element) => {
  try {
    const el = element instanceof HTMLElement ? element : element?.[0];
    const select = el?.querySelector(`select[name="${MODULE_ID}.receiptVisibility"]`);
    if (!select || select.dataset.partystashRadios) return;
    select.dataset.partystashRadios = "true";
    select.hidden = true;

    const field = key => el.querySelector(`[name="${MODULE_ID}.${key}"]`);
    const divider = (key, text) => {
      const group = field(key)?.closest(".form-group");
      if (!group || group.previousElementSibling?.classList?.contains("partystash-divider")) return;
      const header = document.createElement("h4");
      header.className = "divider partystash-divider";
      header.textContent = text;
      group.before(header);
    };
    divider("enabled", "Item Transfers");
    divider("receipts", "Receipt Settings");
    divider("coin", "Coin Window");

    const radios = document.createElement("div");
    radios.className = "partystash-receipt-modes";
    for (const mode of RECEIPT_MODES) {
      const label = document.createElement("label");
      label.className = "checkbox";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${MODULE_ID}.receiptVisibility.choice`; // unregistered: ignored on submit
      input.value = mode.value;
      input.checked = select.value === mode.value;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        select.value = mode.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      label.append(input, document.createTextNode(` ${mode.label}`));
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = mode.note;
      radios.append(label, note);
    }
    select.after(radios);

    // Follow the select rather than owning the state, so "Reset Defaults" — and any other
    // core path that rewrites the field — keeps the radios honest.
    select.addEventListener("change", () => {
      for (const input of radios.querySelectorAll("input")) input.checked = input.value === select.value;
    });

    const toggle = field("receipts");
    const sync = () => {
      const on = !!toggle?.checked;
      select.disabled = !on;
      for (const input of radios.querySelectorAll("input")) input.disabled = !on;
      const group = select.closest(".form-group");
      if (group) group.style.opacity = on ? "" : "0.4";
    };
    toggle?.addEventListener("change", sync);
    sync();
  } catch (err) {
    console.error(`${MODULE_ID} | rendering the Receipt Settings block failed — the choice `
      + "stays available as a dropdown", err);
  }
});

/* -------------------------------------------------- */
/*  Coin — deposit / withdraw                         */
/* -------------------------------------------------- */

/**
 * Items move by drag; coin can't be dragged. dnd5e's answer is the currency manager behind a
 * small coin glyph on the currency row, whose transfer tab awards coin to a list of
 * destinations — and at a live table nobody found it, or worked out what it did once they
 * had. So the stash grows its own affordance: two labelled buttons on the group's currency
 * row, and one dialog behind them.
 *
 * COIN MANNERS, borrowed intact from fvtt-mod-lootshelf (`takeCurrencyFromContainer`):
 * coin moves DENOMINATION BY DENOMINATION. Two platinum leaving the stash arrive as two
 * platinum, not twenty gold. That is why the dialog is five boxes rather than one "N gp"
 * field — a single field would have to break and re-mint somebody's coins to satisfy it, and
 * silently re-denominating a player's purse is exactly the rudeness Loot Shelf's
 * `planDeduction` is careful to avoid when making change. Five boxes also make the
 * affordability rule self-evident: each box is capped at the coins the source actually holds,
 * so an unaffordable transfer cannot be typed in the first place.
 *
 * ORDERING, the family convention (fail open, never destructive): the destination is credited
 * BEFORE the source is debited. A failure between the two duplicates coin, which a GM can see
 * in the receipt and fix; the other order would destroy it.
 *
 * PERMISSIONS: players own their own characters and, at this table, the group actor too —
 * that is what makes the v1.1 drags work — so both updates run client-side with no GM proxy.
 * Ownership of both ends is still checked before the dialog opens, and the buttons only offer
 * members the user actually owns. If group ownership is ever revoked, this is the seam where
 * Loot Shelf's GM-elect `gmRequest` would slot in.
 */

/** Copper value of one coin of each denomination. */
const RATES = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
/** Denomination order as the dnd5e currency row displays it. */
const DENOMS = ["pp", "gp", "ep", "sp", "cp"];

/** A sanitized copy of a currency object — non-negative integers, all five keys. */
function coins(currency) {
  const out = {};
  for (const d of DENOMS) out[d] = Math.max(0, Math.floor(Number(currency?.[d]) || 0));
  return out;
}

/** Total value of a currency object in copper — for "is there any coin at all" tests. */
function totalCopper(currency) {
  const c = coins(currency);
  return DENOMS.reduce((total, d) => total + c[d] * RATES[d], 0);
}

/**
 * Human label for a currency object, e.g. "2 pp 12 gp 5 cp". The coins AS HELD — deliberately
 * not Loot Shelf's `formatCopper`, which collapses a total into gp/sp/cp and would report a
 * purse of 2 pp as "20 gp".
 */
function formatCoins(currency) {
  const c = coins(currency);
  const parts = DENOMS.filter(d => c[d] > 0).map(d => `${c[d]} ${d}`);
  return parts.length ? parts.join(" ") : "no coin";
}

/**
 * The members of `group` this user may move coin for: everyone for a GM, otherwise only the
 * members they own. The user's assigned character sorts first so the common case — one player,
 * one PC — opens on the right answer.
 */
function coinPartners(group) {
  const members = (group.system?.members ?? [])
    .map(m => m.actor)
    .filter(a => a instanceof Actor && (game.user.isGM || a.isOwner));
  const mine = game.user.character;
  return members.sort((a, b) => (b === mine) - (a === mine));
}

/**
 * Move coin between two actors, denomination by denomination, crediting before debiting.
 * Amounts are clamped to what the source actually holds, so a stale dialog (someone else
 * spent the purse while it sat open) moves what is left rather than minting the difference.
 * @returns {object|null} The coins actually moved, or null if that came to nothing.
 */
async function moveCoin(from, to, amounts, receipt) {
  const fromPurse = coins(from.system?.currency);
  const toPurse = coins(to.system?.currency);
  const moving = {};
  for (const d of DENOMS) moving[d] = Math.min(fromPurse[d], Math.max(0, Math.floor(Number(amounts?.[d]) || 0)));
  if (totalCopper(moving) <= 0) return null;
  for (const d of DENOMS) {
    toPurse[d] += moving[d];
    fromPurse[d] -= moving[d];
  }
  // The receipt rides on whichever update touches the GROUP actor — that is the one the
  // currency receipt hook watches — so tag both and let the hook read whichever fires.
  //
  // A FRESH context object per update, never one shared between them: Foundry hands the very
  // object through to the pre-update hook, which writes the before-image into it, so a shared
  // object arrives at the second update already carrying the FIRST actor's currency snapshot.
  // That produced a bogus second receipt reading "Gren deposited 2 pp 5 gp into Gren" — caught
  // in the v1.3 ledger review.
  const context = () => ({ [MODULE_ID]: { transfer: { ...receipt, amounts: moving } } });
  await to.update({ "system.currency": toPurse }, context());
  await from.update({ "system.currency": fromPurse }, context());
  return moving;
}

/**
 * The deposit/withdraw dialog. One shape for both directions — only which end is the source
 * changes, and with it which purse caps the boxes.
 */
async function coinDialog(group, dir) {
  const deposit = dir === "deposit";
  const partners = coinPartners(group);
  if (!partners.length) {
    return void ui.notifications.warn(
      `Party Stash: you don't own any member of ${group.name}, so you can't move its coin.`);
  }
  if (!group.isOwner) {
    return void ui.notifications.warn(
      `Party Stash: you don't own ${group.name}, so you can't move its coin. Ask your GM.`);
  }

  const esc = Handlebars.escapeExpression;
  const purseOf = actor => coins(actor.system?.currency);
  const label = { pp: "Platinum", gp: "Gold", ep: "Electrum", sp: "Silver", cp: "Copper" };

  // The source caps the boxes: your own purse when depositing, the stash when withdrawing.
  const sourceFor = partner => (deposit ? partner : group);
  const initial = sourceFor(partners[0]);

  const options = partners.map(p =>
    `<option value="${p.id}" data-purse="${esc(JSON.stringify(purseOf(p)))}">${esc(p.name)}</option>`
  ).join("");
  const partnerField = partners.length > 1
    ? `<div class="form-group"><label>${deposit ? "From" : "To"}</label>`
      + `<div class="form-fields"><select name="partner">${options}</select></div></div>`
    : `<input type="hidden" name="partner" value="${partners[0].id}">`;

  // Each box is labelled with its abbreviation in plain text. dnd5e's coin glyphs were the
  // obvious first choice, but their art is scoped to the system's `dnd5e2` sheets: in a bare
  // dialog the boxes rendered as five anonymous fields, and opting the dialog into that class
  // to borrow the glyphs dragged the parchment theme along and left the text unreadable (both
  // caught in the v1.3 screenshot pass). GP/SP/CP needs no legend — "which box is gold" is
  // exactly the question this feature exists to stop players having to ask.
  const boxes = DENOMS.map(d =>
    `<label aria-label="${label[d]}" data-denom="${d}">`
    + `<span class="partystash-denom" data-tooltip="${label[d]}">${d}</span>`
    + `<input type="number" name="${d}" value="0" min="0" max="${purseOf(initial)[d]}" step="1">`
    + `</label>`
  ).join("");

  const content =
    `<p class="partystash-line">`
    + (deposit
      ? `Move coin into <strong>${esc(group.name)}</strong>, which holds `
        + `<strong>${formatCoins(purseOf(group))}</strong>.`
      : `Take coin out of <strong>${esc(group.name)}</strong>, which holds `
        + `<strong>${formatCoins(purseOf(group))}</strong>.`)
    + `</p>`
    + partnerField
    + `<div class="partystash-coins">${boxes}</div>`
    + `<p class="partystash-avail hint"></p>`
    + `<button type="button" class="partystash-all">Everything <em class="partystash-all-note"></em></button>`;

  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["partystash-dialog"],
    window: {
      title: deposit ? `Deposit coin — ${group.name}` : `Withdraw coin — ${group.name}`,
      icon: "fa-solid fa-coins"
    },
    position: { width: 400 },
    content,
    buttons: [
      {
        action: "go",
        label: deposit ? "Deposit" : "Withdraw",
        icon: "fa-solid fa-coins",
        default: true,
        callback: (ev, button) => {
          const form = button.form;
          const amounts = {};
          for (const d of DENOMS) amounts[d] = Math.max(0, Math.floor(form.elements[d]?.valueAsNumber || 0));
          return { partnerId: form.elements.partner?.value, amounts };
        }
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false,
    // Keep the boxes honest as the partner changes: re-cap each one against the new source
    // purse, and clamp anything already typed. The "Everything" shortcut is the whole reason
    // the old flow hurt — after a fight, dumping the loot in the stash is one gesture.
    //
    // DialogV2.wait hands its render callback (event, dialog) where `dialog` is the
    // APPLICATION INSTANCE, not an element (verified live on v14.364) — the markup is at
    // `dialog.element`, a <dialog> wrapping the form. Everything below is cosmetic guard-rails
    // regardless: `moveCoin` re-clamps against the live purse, so even if this whole callback
    // fails the transfer itself stays correct and merely loses its live caps.
    render: (event, dialog) => {
      try {
        const root = dialog?.element ?? dialog;
        const form = root.querySelector("form") ?? root;
        const select = form.elements.partner;
        const avail = form.querySelector(".partystash-avail");
        const allBtn = form.querySelector(".partystash-all");
        const allNote = form.querySelector(".partystash-all-note");

        const currentPartner = () => partners.find(p => p.id === select?.value) ?? partners[0];
        const sourcePurse = () => purseOf(sourceFor(currentPartner()));

        const sync = () => {
          const purse = sourcePurse();
          for (const d of DENOMS) {
            const input = form.elements[d];
            if (!input) continue;
            input.max = String(purse[d]);
            // A coin the source doesn't hold is dimmed rather than dropped, so the row always
            // reads as the same five denominations in the same order as the sheet.
            input.disabled = purse[d] <= 0;
            if ((input.valueAsNumber || 0) > purse[d]) input.value = String(purse[d]);
          }
          const holder = deposit ? currentPartner().name : group.name;
          if (avail) avail.textContent = `${holder} has ${formatCoins(purse)}.`;
          if (allNote) allNote.textContent = formatCoins(purse);
          if (allBtn) allBtn.disabled = totalCopper(purse) <= 0;
        };

        select?.addEventListener("change", sync);
        allBtn?.addEventListener("click", () => {
          const purse = sourcePurse();
          for (const d of DENOMS) if (form.elements[d]) form.elements[d].value = String(purse[d]);
        });
        for (const d of DENOMS) {
          form.elements[d]?.addEventListener("change", () => {
            const input = form.elements[d];
            const max = Number(input.max) || 0;
            if ((input.valueAsNumber || 0) > max) input.value = String(max);
            if ((input.valueAsNumber || 0) < 0) input.value = "0";
          });
        }
        sync();
      } catch (err) {
        console.error(`${MODULE_ID} | wiring the coin dialog failed — the boxes keep their `
          + "initial caps and the transfer is still clamped on submit", err);
      }
    }
  });

  if (!result || typeof result !== "object") return;
  const partner = partners.find(p => p.id === result.partnerId);
  if (!partner) return;
  const [from, to] = deposit ? [partner, group] : [group, partner];

  try {
    const moved = await moveCoin(from, to, result.amounts,
      { member: partner.name, memberUuid: partner.uuid, dir });
    if (!moved) return void ui.notifications.warn("Party Stash: no coin was selected to move.");
    ui.notifications.info(deposit
      ? `Deposited ${formatCoins(moved)} into ${group.name}.`
      : `Withdrew ${formatCoins(moved)} from ${group.name} for ${partner.name}.`);
  } catch (err) {
    console.error(`${MODULE_ID} | moving coin failed`, err);
    ui.notifications.error(`Party Stash: that coin transfer failed (${err.message}).`);
  }
}

/**
 * Make sure the module's stylesheet is actually in the cascade.
 *
 * `styles` in module.json is the real mechanism and covers any normal install. This is a
 * fallback for one specific situation: Foundry builds `game.modules` from a package scan done
 * at server PROCESS boot, so on a host where the module's files were hot-replaced under a
 * running server (how this module is deployed to its Molten box) a NEWLY ADDED `styles` entry
 * is invisible until that process next restarts — the code would update while its CSS did not.
 *
 * ⚠️ ASK THE CASCADE, NOT THE DOM. v1.3 tested for a `link[href*="fvtt-mod-partystash/styles/"]`
 * and injected one when it found none — which on Foundry v14 is ALWAYS, because core bundles
 * module CSS into its own layered stylesheets and never emits a per-module link tag. The
 * fallback therefore fired on every single load, fetching a second copy of a sheet that was
 * already applied, and the "self-nullifying" property it claimed never held (found live
 * 2026-08-12, after the process restart that should have made it stand down).
 *
 * So the probe measures the thing that actually matters: does a rule of ours reach an element?
 * `.partystash-css-probe` exists in the stylesheet for exactly this question — a detached-
 * looking, invisible div that our sheet gives `flex-direction: column`, which no bare div has.
 */
Hooks.once("ready", () => {
  try {
    const probe = document.createElement("div");
    probe.className = "partystash-css-probe";
    document.body.append(probe);
    const applied = getComputedStyle(probe).flexDirection === "column";
    probe.remove();
    if (applied) return;

    if (document.querySelector(`link[data-${MODULE_ID}-fallback]`)) return; // already injected
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `modules/${MODULE_ID}/styles/partystash.css`;
    link.setAttribute(`data-${MODULE_ID}-fallback`, "true");
    document.head.append(link);
    console.warn(`${MODULE_ID} | the manifest stylesheet is not in the cascade — loading it `
      + "directly. Expected only on a host whose package registry predates this version.");
  } catch (err) {
    console.error(`${MODULE_ID} | loading the stylesheet failed — the coin buttons will work `
      + "but look unstyled", err);
  }
});

/**
 * Dress the group sheet's currency row. Re-runs on every render because the sheet redraws the
 * whole inventory part on any currency or item change, taking injected nodes with it (verified
 * live on dnd5e 5.3.3 / v14) — so this is written to be idempotent and cheap rather than
 * clever about caching.
 */
Hooks.on("renderGroupActorSheet", (app, element) => {
  try {
    if (!game.settings.get(MODULE_ID, "coin")) return;
    const group = app.document;
    if (group?.type !== "group") return;
    const root = element instanceof HTMLElement ? element : app.element;
    const section = root?.querySelector("section.currency");
    if (!section || section.querySelector(".partystash-coin")) return;

    // Players never hand-edit the party purse: the fields go read-only and the system's own
    // currency-manager button goes with them, so the dialog is the single door. `readOnly`
    // rather than `disabled` keeps the values legible and copyable. A GM keeps the stock row.
    if (!game.user.isGM) {
      for (const input of section.querySelectorAll('input[name^="system.currency"]')) {
        input.readOnly = true;
        input.tabIndex = -1;
        input.classList.add("partystash-locked");
      }
      section.querySelector('[data-action="currency"]')?.remove();
    }

    const wrap = document.createElement("div");
    wrap.className = "partystash-coin";
    for (const [dir, text, icon] of [
      ["deposit", "Deposit", "fa-solid fa-arrow-down-to-bracket"],
      ["withdraw", "Withdraw", "fa-solid fa-arrow-up-from-bracket"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "partystash-coin-button always-interactive";
      button.dataset.direction = dir;
      button.innerHTML = `<i class="${icon}" inert></i><span>${text}</span>`;
      button.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        coinDialog(group, dir);
      });
      wrap.append(button);
    }
    section.append(wrap);
  } catch (err) {
    console.error(`${MODULE_ID} | dressing the group currency row failed`, err);
  }
});
