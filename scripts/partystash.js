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
 * admin escape hatch. v1.5 teaches the dialog to make change: asking for coin the source
 * doesn't hold loose converts the rest of its purse to cover it, Loot Shelf's
 * `planDeduction` manners. See the coin section below.
 *
 * v1.6 does the same favor for stacks that v1.3 did for coin. dnd5e's drop pipeline moves
 * the WHOLE item document — quantity is not a concept anywhere in it — so "take one
 * Antitoxin from the stash's stack of four" was not a gesture the sheet had, and a player
 * hunting for one found the context menu's Duplicate instead (the "(Copy)(Copy)" incident,
 * 2026-08-25). Now a member↔group move of a stacked item asks "how many?", the group
 * inventory grows a per-row TAKE button — Loot Shelf's shelf-Buy gesture pointed the other
 * way — and member character sheets grow the mirror-image STASH button, gated on actually
 * belonging to a group. See the stacks section below.
 *
 * v1.7 adds GIVE beside Stash: hand an item straight to another party member. A player can't
 * write onto a partymate's sheet, and this module never leans on a GM being online, so the
 * gift takes the road the table already used by hand — into the stash marked for the
 * recipient's player, whose client moves it on and deletes the stash row. One receipt, no GM;
 * a hand-off nobody finishes comes back to the giver. PC↔PC DRAGS are unchanged (still a
 * stock copy): Give is a button gesture only. See the give section below.
 *
 * Implemented as a wrap of BaseActorSheet#_defaultDropBehavior — the single seam where
 * dnd5e decides a drag's default behavior (same wrap style as fvtt-mod-autoexplore's
 * FogManager wraps). Verified against dnd5e 5.3.3 on Foundry v14: the group sheet
 * refuses non-physical items BEFORE the move-delete runs, and the source item is only
 * deleted after Item5e.createDocuments has resolved on the target, so a failed or
 * refused drop never destroys the original. Verified live again on dnd5e 6.0.3 and 6.0.5 /
 * Foundry 14.368 on 2026-09-23 (tools/verify-partystash*.mjs, every probe passing): the
 * 6.0.3 -> 6.0.5 diff leaves every seam this file wraps or queries unchanged —
 * _defaultDropBehavior, both _onDropItem overrides, event._behavior, inventorySource,
 * _configureInventorySections, and the currency-row and item-control markup. v1.7's Give
 * verified the same way on 2026-10-01 (probe I: two player clients, the stall, nobody online).
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

  game.settings.register(MODULE_ID, "take", {
    name: "Take button on the group inventory",
    hint: "Put a Take button on every item row of a group actor's inventory: press it to "
      + "move the item to a member you own, with a quantity prompt when the stack is bigger "
      + "than one. Turn this off to remove the column.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "stash", {
    name: "Stash button on member character sheets",
    hint: "The same button pointed the other way: every inventory row on a character sheet "
      + "gets a Stash button when that character belongs to a group, moving the item into "
      + "the group's inventory with the same quantity prompt. Characters in no group keep "
      + "the stock row. Turn this off to remove the column.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "give", {
    name: "Give button on member character sheets",
    hint: "Beside Stash: every inventory row on a character sheet gets a Give button when "
      + "that character belongs to a group. Press it to hand the item to another member "
      + "whose player is online. The item passes through the group's inventory and the other "
      + "player's client finishes the move, so no GM is needed; if their client never answers, "
      + "the item comes back. Turn this off to remove the button.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/** Recently-warned blocked drags, keyed "itemUuid->targetUuid" -> timestamp. */
const warned = new Map();

/**
 * The effective target of a drop: the sheet's inventory actor — except on a group sheet,
 * where dropping onto a member's row hands the item to that member (the sheet's own
 * routing). Shared by the verdict below and the v1.6 split prompt.
 */
function dropTarget(sheet, event) {
  let target = sheet.inventorySource;
  if (sheet.actor?.type === "group") {
    const rowUuid = event.target?.closest?.("[data-uuid]")?.dataset?.uuid;
    const rowDoc = rowUuid ? fromUuidSync(rowUuid) : null;
    if (rowDoc instanceof Actor) target = rowDoc;
  }
  return target;
}

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

  const target = dropTarget(sheet, event);
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

  // v1.6 — the split prompt sits at _onDropItem, where a move drop becomes concrete. TWO
  // wraps with one shared guard: the group sheet's override routes a drop on a member's
  // row PAST its parent implementation (straight to the member sheet's
  // _onDropCreateItems), so wrapping the base class alone would miss exactly the drop the
  // group sheet invented for handing things out. The event is marked on first sight so
  // the group wrap delegating to the (also wrapped) base method asks only once.
  const Group = globalThis.dnd5e?.applications?.actor?.GroupActorSheet;
  for (const Cls of new Set([Base, Group].filter(Boolean))) {
    const origDrop = Cls.prototype._onDropItem;
    if (!origDrop) continue;
    Cls.prototype._onDropItem = async function (event, item) {
      try {
        if (await maybeSplitMove(this, event, item)) return;
      } catch (err) {
        console.error(`${MODULE_ID} | split check failed — the drop falls through whole`, err);
      }
      return origDrop.call(this, event, item);
    };
  }

  // v1.6 — the Take and Stash columns (see the stacks section). Appended to the sheets'
  // own section columns so the system's grid machinery lays them out. Order 1100 puts
  // them past the system's controls column (order 1000) — the FURTHEST RIGHT cell, the
  // owner's call on 2026-08-26. The matching width rules in partystash.css are REQUIRED —
  // a column id without CSS collapses to zero width (Loot Shelf handoff, landmine #2).
  const injectColumn = (Cls, setting, id, template, gate) => {
    if (!Cls) return;
    const origSections = Cls.prototype._configureInventorySections;
    Cls.prototype._configureInventorySections = async function (sections) {
      await origSections?.call(this, sections);
      try {
        if (!game.settings.get(MODULE_ID, setting)) return;
        if (gate && !gate(this)) return;
        const column = { id, width: 84, order: 1100, priority: 100, label: "", template };
        for (const s of sections) if (Array.isArray(s.columns)) s.columns = [...s.columns, column];
      } catch (err) {
        console.error(`${MODULE_ID} | adding the ${id} column failed`, err);
      }
    };
  };
  injectColumn(Group, "take", "partystashTake",
    `modules/${MODULE_ID}/templates/take-column.hbs`);

  // The character sheet's column: Stash, Give (v1.7), or both in ONE cell — layout B, the
  // owner's call on 2026-10-01, so the busiest sheet in the game pays 160px for the pair
  // rather than 168px for two columns. dnd5e renders the column partial with the column
  // object as its context, so the booleans set here are what stash-column.hbs reads; the id
  // picks the width rule in partystash.css. Membership-gated like before: a loner's inventory
  // keeps its stock row.
  const Character = globalThis.dnd5e?.applications?.actor?.CharacterActorSheet;
  if (Character) {
    const origSections = Character.prototype._configureInventorySections;
    Character.prototype._configureInventorySections = async function (sections) {
      await origSections?.call(this, sections);
      try {
        const stash = game.settings.get(MODULE_ID, "stash");
        const give = game.settings.get(MODULE_ID, "give");
        if (!(stash || give) || !isGroupMember(this.actor)) return;
        const id = stash && give ? "partystashPair" : stash ? "partystashStash" : "partystashGive";
        const column = {
          id, width: stash && give ? 160 : 84, order: 1100, priority: 100, label: "",
          template: `modules/${MODULE_ID}/templates/stash-column.hbs`, stash, give
        };
        for (const s of sections) if (Array.isArray(s.columns)) s.columns = [...s.columns, column];
      } catch (err) {
        console.error(`${MODULE_ID} | adding the character-sheet column failed`, err);
      }
    };
  }

  // Column templates render as preloaded Handlebars partials — without this the cell
  // comes up empty, not errored.
  const load = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  load([
    `modules/${MODULE_ID}/templates/take-column.hbs`,
    `modules/${MODULE_ID}/templates/stash-column.hbs`
  ]).catch(err => console.error(`${MODULE_ID} | preloading the column templates failed`, err));
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
 * per-denomination deltas. A deposit/withdraw through the coin dialog instead names the
 * member and the coins they moved — and says so when the dialog converted coin to make
 * change (the one sanctioned re-denomination; see the coin section).
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
    if (isHandOff(item)) return; // a gift passing through — its own receipt, see the give section
    recordReceipt(item, "gain", Math.max(1, Math.floor(item.system.quantity ?? 1)), false, userId);
  } catch (err) {
    console.error(`${MODULE_ID} | receipt create-hook failed`, err);
  }
});

Hooks.on("deleteItem", (item, options, userId) => {
  try {
    if (!shouldPostReceipt(userId) || !receiptsEnabled()) return;
    if (!item.system?.schema?.fields?.quantity) return;
    if (isHandOff(item)) {
      quiet.delete(item.id);
      return;
    }
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
          : `withdrew <strong>${moved}</strong> from <strong>${actor.name}</strong>.`)
        + (transfer.converted ? " <em>Coin was converted to make change.</em>" : "")],
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
    divider("take", "Take, Stash & Give Buttons");

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
 * COIN MANNERS, borrowed from fvtt-mod-lootshelf (`takeCurrencyFromContainer`): coin the
 * source actually holds moves DENOMINATION BY DENOMINATION. Two platinum leaving the stash
 * arrive as two platinum, not twenty gold, and a purse is never re-composed just to satisfy
 * a transfer it could have paid literally.
 *
 * Through v1.4 that rule was absolute: each box was capped at the loose coins the source
 * held, full stop. It met reality on 2026-08-26 — a player wanted 15 gp out of a stash
 * holding 3 pp 15 sp, found the GP box greyed out, and had to do the exchange arithmetic by
 * hand. So since v1.5 the dialog MAKES CHANGE: each box is capped by what the purse's total
 * VALUE can afford, coins held loose still move as themselves first, and only the shortfall
 * is minted for the destination and paid for out of the rest of the source's purse via
 * `planDeduction` — Loot Shelf's change-making, ported verbatim so the two modules convert
 * coin identically (small denominations spent first in exact multiples, then the smallest
 * coin that covers the remainder is broken, change returned to the SOURCE in gp/sp/cp).
 * The destination always receives exactly the denominations typed; only the source's purse
 * is ever re-composed, that being the price of asking for coin it doesn't hold loose. The
 * dialog says so before it happens, and the receipt records that change was made.
 * Affordability still cannot be mis-typed: the five boxes share the purse's total value as
 * one budget, and the box being edited is clamped live to what the others leave affordable.
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
/** DENOMS smallest-first — the spend order when making change. */
const ASCENDING = [...DENOMS].reverse();

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
 * Plan paying `cost` copper out of a currency object, or null if it can't be afforded.
 * Loot Shelf's `planDeduction`, ported verbatim (same name, same behavior) so the two
 * modules make change identically: small denominations are spent first (exact multiples
 * only), then the smallest remaining coin that covers what's left is broken, with the
 * change returned in gp/sp/cp. The result is the complete post-payment currency object.
 */
function planDeduction(currency, cost) {
  const c = coins(currency);
  cost = Math.max(0, Math.floor(cost));
  if (totalCopper(c) < cost) return null;
  let remaining = cost;
  for (const coin of ASCENDING) {
    const spend = Math.min(c[coin], Math.floor(remaining / RATES[coin]));
    c[coin] -= spend;
    remaining -= spend * RATES[coin];
  }
  if (remaining > 0) {
    // After the exact pass every held coin is worth more than the remainder, and the
    // affordability check guarantees one exists — break the smallest and take change.
    const coin = ASCENDING.find(k => c[k] > 0 && RATES[k] >= remaining);
    c[coin] -= 1;
    const change = RATES[coin] - remaining;
    c.gp += Math.floor(change / 100);
    c.sp += Math.floor((change % 100) / 10);
    c.cp += change % 10;
  }
  return c;
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
 * Move coin between two actors, crediting before debiting. Coins the source holds loose
 * move as themselves, never re-minted; a shortfall in a requested denomination is minted
 * for the destination and paid for out of the rest of the source's purse via
 * `planDeduction`, the change landing back in the source. The destination thus receives
 * exactly the denominations asked for, and only the source's purse is ever re-composed.
 * Amounts are clamped to what the source can AFFORD (not merely what it holds), so a stale
 * dialog (someone else spent the purse while it sat open) moves what is left rather than
 * minting value from nothing.
 * @returns {{moved: object, converted: boolean}|null} The coins the destination received
 *   and whether any were made by converting the source's coin — or null for a no-op.
 */
async function moveCoin(from, to, amounts, receipt) {
  let fromPurse = coins(from.system?.currency);
  const toPurse = coins(to.system?.currency);
  const moved = {};
  // First pass: what the source holds loose moves literally.
  for (const d of DENOMS) {
    moved[d] = Math.min(fromPurse[d], Math.max(0, Math.floor(Number(amounts?.[d]) || 0)));
    fromPurse[d] -= moved[d];
  }
  // Second pass: shortfalls are made by converting the rest of the purse. Change from a
  // broken coin returns to the purse in gp/sp/cp, so a later denomination's shortfall may
  // be paid partly out of an earlier one's change — value is conserved throughout.
  let converted = false;
  for (const d of DENOMS) {
    const short = Math.max(0, Math.floor(Number(amounts?.[d]) || 0)) - moved[d];
    const mint = Math.min(short, Math.floor(totalCopper(fromPurse) / RATES[d]));
    if (mint <= 0) continue;
    const paid = planDeduction(fromPurse, mint * RATES[d]);
    if (!paid) continue; // affordability was just checked — but never mint on a miss
    fromPurse = paid;
    moved[d] += mint;
    converted = true;
  }
  if (totalCopper(moved) <= 0) return null;
  for (const d of DENOMS) toPurse[d] += moved[d];
  // The receipt rides on whichever update touches the GROUP actor — that is the one the
  // currency receipt hook watches — so tag both and let the hook read whichever fires.
  //
  // A FRESH context object per update, never one shared between them: Foundry hands the very
  // object through to the pre-update hook, which writes the before-image into it, so a shared
  // object arrives at the second update already carrying the FIRST actor's currency snapshot.
  // That produced a bogus second receipt reading "Gren deposited 2 pp 5 gp into Gren" — caught
  // in the v1.3 ledger review.
  const context = () => ({ [MODULE_ID]: { transfer: { ...receipt, amounts: moved, converted } } });
  await to.update({ "system.currency": toPurse }, context());
  await from.update({ "system.currency": fromPurse }, context());
  return { moved, converted };
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
  // A box's cap is what the purse's total VALUE affords in that denomination — not the loose
  // coins held. The difference is what `moveCoin` makes by converting (see the header).
  const cap = (purse, d) => Math.floor(totalCopper(purse) / RATES[d]);
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
    + `<input type="number" name="${d}" value="0" min="0" max="${cap(purseOf(initial), d)}" step="1">`
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
    + `<p class="partystash-convert hint" hidden></p>`
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
        const convertEl = form.querySelector(".partystash-convert");
        const allBtn = form.querySelector(".partystash-all");
        const allNote = form.querySelector(".partystash-all-note");

        const currentPartner = () => partners.find(p => p.id === select?.value) ?? partners[0];
        const sourcePurse = () => purseOf(sourceFor(currentPartner()));
        const holder = () => (deposit ? currentPartner().name : group.name);

        // The five boxes share one budget — the purse's total value. Clamp each so the
        // running total stays affordable, visiting the box being edited LAST so a fresh
        // keystroke yields to what was already typed instead of silently rewriting it.
        const fitBudget = edited => {
          const purse = sourcePurse();
          let left = totalCopper(purse);
          const order = [...DENOMS.filter(d => d !== edited), ...(edited ? [edited] : [])];
          for (const d of order) {
            const input = form.elements[d];
            if (!input) continue;
            const want = Math.max(0, Math.floor(input.valueAsNumber || 0));
            const allowed = Math.min(want, Math.floor(left / RATES[d]));
            if (allowed !== (input.valueAsNumber || 0)) input.value = String(allowed);
            left -= allowed * RATES[d];
          }
        };

        // Say that change will be made BEFORE it happens — the one moment the dialog
        // re-composes a purse should never be a surprise found in the receipt.
        const convertNote = () => {
          if (!convertEl) return;
          const purse = sourcePurse();
          const minted = DENOMS.filter(d => (form.elements[d]?.valueAsNumber || 0) > purse[d]);
          convertEl.hidden = !minted.length;
          convertEl.textContent = minted.length
            ? `${holder()} doesn't hold that much loose ${minted.join(" or ")} — other coin `
              + "will be converted to make change."
            : "";
        };

        const sync = () => {
          const purse = sourcePurse();
          for (const d of DENOMS) {
            const input = form.elements[d];
            if (!input) continue;
            const most = cap(purse, d);
            input.max = String(most);
            // A denomination the purse can't afford ONE coin of is dimmed rather than
            // dropped, so the row always reads as the same five in the sheet's order.
            input.disabled = most <= 0;
            if ((input.valueAsNumber || 0) > most) input.value = String(most);
          }
          fitBudget(null);
          if (avail) avail.textContent = `${holder()} has ${formatCoins(purse)}.`;
          if (allNote) allNote.textContent = formatCoins(purse);
          if (allBtn) allBtn.disabled = totalCopper(purse) <= 0;
          convertNote();
        };

        select?.addEventListener("change", sync);
        allBtn?.addEventListener("click", () => {
          const purse = sourcePurse();
          for (const d of DENOMS) if (form.elements[d]) form.elements[d].value = String(purse[d]);
          convertNote(); // everything-as-held is literal by construction — the note hides
        });
        for (const d of DENOMS) {
          form.elements[d]?.addEventListener("change", () => {
            fitBudget(d);
            convertNote();
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
    const outcome = await moveCoin(from, to, result.amounts,
      { member: partner.name, memberUuid: partner.uuid, dir });
    if (!outcome) return void ui.notifications.warn("Party Stash: no coin was selected to move.");
    ui.notifications.info((deposit
      ? `Deposited ${formatCoins(outcome.moved)} into ${group.name}.`
      : `Withdrew ${formatCoins(outcome.moved)} from ${group.name} for ${partner.name}.`)
      + (outcome.converted ? " Coin was converted to make change." : ""));
  } catch (err) {
    console.error(`${MODULE_ID} | moving coin failed`, err);
    ui.notifications.error(`Party Stash: that coin transfer failed (${err.message}).`);
  }
}

/* -------------------------------------------------- */
/*  Stacks — split moves & the Take column            */
/* -------------------------------------------------- */

/**
 * dnd5e's drop pipeline moves the whole item document; quantity is not a concept anywhere
 * in it. The group sheet's context menu offers no split either — its Duplicate mints a
 * "{name} (Copy)" clone, which is exactly what a player reaching for one Antitoxin out of
 * four found on 2026-08-25 (three times). dnd5e 6.0 added a Split Stack entry, but the
 * inventory element returns before its owned-item options on a GROUP actor, so it only
 * appears on member sheets — and it splits in place on one actor, never across the stash.
 * Two affordances fix that, per the owner's call on 2026-08-26:
 *
 * SPLIT PROMPT — every owned member↔group MOVE drop asks first (no modifier key). A
 * stacked item asks "how many?", defaulting to the WHOLE stack, so the old gesture is
 * still drag-and-Enter; choosing fewer performs a split instead of the stock move, and
 * choosing everything falls through to the untouched stock pipeline. A single item or a
 * container asks a plain yes/no instead (extended from the buttons to drags by the owner,
 * 2026-08-26) — yes falls through to the stock move, no drops nothing. Only the module's
 * own move verdict prompts; forced Ctrl-copies stay silent stock behavior.
 *
 * TAKE COLUMN — every row of the group inventory gets a Take button, Loot Shelf's
 * shelf-Buy gesture pointed the other way: press it, get a quantity prompt only when the
 * stack is bigger than one (defaulting to 1 — the button gesture is "grab some", where
 * the drag gesture is "move this stack" and defaults to all, both matching the vendor's
 * manners). Destination rules are the coin dialog's: the members you own, assigned
 * character first, a picker only when there is a real choice. Containers move whole,
 * cargo and all. Both button columns sit PAST the system's controls column — the
 * furthest-right cell, the owner's call on 2026-08-26 — and the group sheet hides the
 * rows' equip toggle (partystash.css): nobody wields a sword out of the party's bag.
 *
 * STASH COLUMN — the same button on member CHARACTER sheets, pointed back: every
 * inventory row grows a Stash button that moves the item into the group's inventory,
 * same quantity prompt, destination picker only for a character in several groups. The
 * column is membership-gated — a character in no group keeps the stock rows, so the
 * busiest sheet in the game only pays the width when the button can do something.
 *
 * The split itself follows the family ordering — CREDIT BEFORE DEBIT: the chosen amount
 * lands on the target first (merging into an existing stack the way dnd5e's own drop path
 * stacks consumables), then the source stack is reduced, or deleted when all of it went.
 * A failure between the two duplicates items, never destroys them. Receipts need no new
 * wiring: the quantity-delta and create/delete hooks already pair the two halves into
 * "Bob took 1 × Antitoxin from The Party".
 */

/** An item's stack size — physical items default to 1, never less. */
function stackCount(item) {
  return Math.max(1, Math.floor(Number(item?.system?.quantity) || 1));
}

/**
 * "<strong>The Party</strong> inventory" or "the <strong>Wardens</strong> inventory" —
 * the article joins only when the name doesn't already open with one, so any actor name
 * slots into the dialogs' questions without a possessive or a stutter ("the The Party").
 */
function inventoryLabel(name) {
  const bold = `<strong>${Handlebars.escapeExpression(name)}</strong> inventory`;
  return /^the\s/i.test(name ?? "") ? bold : `the ${bold}`;
}

/**
 * Move `n` of `item` to `target`, credit before debit. Containers ignore `n` and move
 * whole with their contents (the stock createWithContents path).
 */
async function moveStack(item, target, n) {
  const max = stackCount(item);
  n = Math.min(max, Math.max(1, Math.floor(Number(n) || 1)));

  if (item.type === "container") {
    const Item5e = item.constructor;
    const toCreate = await Item5e.createWithContents([item]);
    await Item5e.createDocuments(toCreate, { parent: target, keepId: true });
    await item.delete({ deleteContents: true });
    return max;
  }

  await creditStack(item, target, n);

  if (n >= max) await item.delete();
  else await item.update({ "system.quantity": max - n });
  return n;
}

/**
 * The data a non-container item carries to another actor: a fresh copy of `n`, loose,
 * unequipped and unattuned, and without the hand-off mark (a gift arriving on its recipient
 * is just an item again).
 */
function carriedData(item, n) {
  const data = item.toObject();
  delete data._id;
  delete data.folder;
  data.sort = 0;
  const sys = data.system ?? {};
  if ("attuned" in sys) sys.attuned = false;
  if ("equipped" in sys) sys.equipped = false;
  if ("container" in sys) sys.container = null;
  sys.quantity = n;
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
  return data;
}

/**
 * The credit half of a non-container move: `n` of `item` land on `target`. Returns an
 * `undo` that takes exactly that credit back again — what the hand-off's guard calls when
 * this client turns out not to be the one that got the stash row (see claimRow).
 */
async function creditStack(item, target, n) {
  const data = carriedData(item, n);

  // Merge into an existing stack the way dnd5e's own _onDropStackConsumables does
  // (consumables with a compendium source, same name, loose in the inventory), so a taken
  // Antitoxin lands ON the member's stack instead of opening a second row. Any failure
  // here degrades to a plain create — a duplicate row, never a lost item.
  let similar = null;
  try {
    const sourceId = data._stats?.compendiumSource ?? data.flags?.core?.sourceId;
    if (data.type === "consumable" && sourceId) {
      similar = target.sourcedItems?.get(sourceId, { legacy: false })
        ?.filter(i => (i.system.container === null) && (i.name === data.name))?.first() ?? null;
    }
  } catch {
    similar = null;
  }
  if (similar) {
    await similar.update({ "system.quantity": stackCount(similar) + n });
    return async () => similar.update({ "system.quantity": Math.max(0, stackCount(similar) - n) });
  }
  const [created] = await target.createEmbeddedDocuments("Item", [data]);
  return async () => created?.delete();
}

/**
 * Should this drop become a split instead of a stock move? Runs inside the _onDropItem
 * wraps (see setup). Returns true when the drop was fully handled here — split performed,
 * or prompt cancelled — and false to fall through to the stock pipeline.
 */
async function maybeSplitMove(sheet, event, item) {
  if (event._partystashAsked) return false; // the group wrap delegates to the base wrap — ask once
  event._partystashAsked = true;
  if (!game.settings.get(MODULE_ID, "enabled")) return false;
  if (event._behavior !== "move") return false;
  if (!(item instanceof Item)) return false;
  if (stashVerdict(sheet, event, { type: "Item", uuid: item.uuid }) !== "move") return false;

  const target = dropTarget(sheet, event);
  const taking = item.parent?.type === "group";
  const max = stackCount(item);
  const container = item.type === "container";
  const askQty = !container && max > 1;
  const esc = Handlebars.escapeExpression;
  // Same voice as the button dialogs: a question naming both ends, the detail as its own
  // sentence.
  // "<Name> inventory" with a joining article as needed, never a possessive — see
  // inventoryLabel. Owner-picked phrasing, 2026-08-26.
  const question = (taking
    ? `Take <strong>${esc(item.name)}</strong> from ${inventoryLabel(item.parent.name)}?`
    : `Put <strong>${esc(item.name)}</strong> in ${inventoryLabel(target?.name ?? "party stash")}?`)
    + (askQty ? ` There are ${max}.` : container ? " It moves with its contents." : "");
  const verb = taking ? "Take" : "Stash";

  // A single item or a container has no quantity to ask about, but the drop still
  // confirms (owner's call, 2026-08-26 — same as the buttons): yes falls through to the
  // stock move, no swallows the drop.
  if (!askQty) {
    const ok = await foundry.applications.api.DialogV2.wait({
      classes: ["partystash-dialog"],
      window: { title: `${verb} ${item.name}`, icon: "fa-solid fa-hand-holding" },
      position: { width: 360 },
      content: `<p>${question}</p>`,
      buttons: [
        { action: "go", label: verb, icon: "fa-solid fa-hand-holding", default: true, callback: () => true },
        { action: "cancel", label: "Cancel" }
      ],
      rejectClose: false
    });
    return ok !== true; // confirmed — let the stock pipeline move it whole
  }

  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["partystash-dialog"],
    window: { title: taking ? "Take how many?" : "Stash how many?", icon: "fa-solid fa-hand-holding" },
    position: { width: 360 },
    content: `<p>${question}</p>`
      + `<div class="form-group"><label>Quantity</label><div class="form-fields">`
      + `<input type="number" name="qty" value="${max}" min="1" max="${max}" step="1" autofocus>`
      + `</div><p class="hint">Up to ${max}. The rest stays put.</p></div>`,
    buttons: [
      {
        action: "go", label: verb, icon: "fa-solid fa-hand-holding", default: true,
        callback: (ev, button) =>
          Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || max)))
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  });
  if (result == null || result === "cancel") return true; // cancelled — swallow the drop
  if (result >= max) return false;                        // whole stack — stock pipeline
  await moveStack(item, target, result);
  return true;
}

/**
 * The shared button dialog: an optional destination picker (only when there is a real
 * choice) and an optional quantity box (vendor manners — it only appears when the stack
 * is bigger than one, and defaults to 1). The dialog itself ALWAYS shows: for a stack it
 * is the quantity prompt, and for a single item or a container it is a plain
 * confirmation — the owner's call on 2026-08-26, so a misclick on a row button never
 * relocates loot silently. Returns { partner, qty } or null on cancel.
 */
async function buttonPrompt({ title, verb, icon, question, item, partners, partnerLabel }) {
  const max = stackCount(item);
  const container = item.type === "container";
  const askQty = !container && max > 1;

  const esc = Handlebars.escapeExpression;
  // The caller words the question ("Take X from Y?"); the stack or cargo detail rides
  // along as a second sentence so the line reads like a person asking, not a label.
  const detail = askQty ? ` There are ${max}.` : container ? " It moves with its contents." : "";
  const partnerField = partners.length > 1
    ? `<div class="form-group"><label>${partnerLabel}</label><div class="form-fields"><select name="partner">`
      + partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")
      + `</select></div></div>`
    : `<input type="hidden" name="partner" value="${partners[0].id}">`;
  const qtyField = askQty
    ? `<div class="form-group"><label>Quantity</label><div class="form-fields">`
      + `<input type="number" name="qty" value="1" min="1" max="${max}" step="1" autofocus>`
      + `</div><p class="hint">Up to ${max}.</p></div>`
    : "";
  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["partystash-dialog"],
    window: { title, icon },
    position: { width: 360 },
    content: `<p>${question}${detail}</p>` + partnerField + qtyField,
    buttons: [
      {
        action: "go", label: verb, icon, default: true,
        callback: (ev, button) => ({
          partnerId: button.form?.elements?.partner?.value,
          qty: Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || 1)))
        })
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  });
  if (!result || typeof result !== "object") return null;
  return {
    partner: partners.find(p => p.id === result.partnerId) ?? partners[0],
    qty: container ? max : (askQty ? result.qty : 1)
  };
}

/**
 * The Take button's click — the button-shaped withdrawal. Checks mirror the coin
 * dialog's: own the group, own at least one member.
 */
async function takeDialog(group, item) {
  const partners = coinPartners(group);
  if (!partners.length) {
    return void ui.notifications.warn(
      `Party Stash: you don't own any member of ${group.name}, so you can't take from it.`);
  }
  if (!group.isOwner) {
    return void ui.notifications.warn(
      `Party Stash: you don't own ${group.name}, so you can't take from it. Ask your GM.`);
  }
  const esc = Handlebars.escapeExpression;
  const picked = await buttonPrompt({
    title: `Take from ${group.name}`, verb: "Take", icon: "fa-solid fa-hand-holding",
    question: `Take <strong>${esc(item.name)}</strong> from ${inventoryLabel(group.name)}?`,
    item, partners, partnerLabel: "To"
  });
  if (!picked) return;
  try {
    const moved = await moveStack(item, picked.partner, picked.qty);
    ui.notifications.info(`Took ${moved} × ${item.name} from ${group.name} for ${picked.partner.name}.`);
  } catch (err) {
    console.error(`${MODULE_ID} | taking from the stash failed`, err);
    ui.notifications.error(`Party Stash: taking ${item.name} failed (${err.message}).`);
  }
}

/**
 * The Stash button's click — takeDialog pointed the other way. The destinations are the
 * GROUPS this character belongs to, which is almost always exactly one, so the picker
 * almost never appears. The column itself is membership-gated (see setup), so an empty
 * list here is a race, not a state to warn about.
 */
async function stashDialog(actor, item) {
  const groups = game.actors.filter(g =>
    g.type === "group" && g.system?.members?.some?.(m => m.actor === actor));
  if (!groups.length) return;
  if (!actor.isOwner) {
    return void ui.notifications.warn(
      `Party Stash: you don't own ${actor.name}, so you can't stash their things.`);
  }
  const owned = groups.filter(g => g.isOwner);
  if (!owned.length) {
    return void ui.notifications.warn(
      `Party Stash: you don't own ${groups[0].name}, so you can't stash in it. Ask your GM.`);
  }
  const esc = Handlebars.escapeExpression;
  const picked = await buttonPrompt({
    title: owned.length === 1 ? `Stash in ${owned[0].name}` : "Stash",
    verb: "Stash", icon: "fa-solid fa-box-open",
    question: owned.length === 1
      ? `Put <strong>${esc(item.name)}</strong> in ${inventoryLabel(owned[0].name)}?`
      : `Put <strong>${esc(item.name)}</strong> in the party inventory?`,
    item, partners: owned, partnerLabel: "In"
  });
  if (!picked) return;
  try {
    const moved = await moveStack(item, picked.partner, picked.qty);
    ui.notifications.info(`Stashed ${moved} × ${item.name} in ${picked.partner.name}.`);
  } catch (err) {
    console.error(`${MODULE_ID} | stashing failed`, err);
    ui.notifications.error(`Party Stash: stashing ${item.name} failed (${err.message}).`);
  }
}

/**
 * Wire a column's buttons after a sheet render. The buttons come fresh from the template
 * on every render, so listeners attach once per node (`data-wired`); the click is stopped
 * before the row's own click action (use/expand) sees it.
 */
function wireButtons(root, className, onClick, setting) {
  try {
    if (!game.settings.get(MODULE_ID, setting)) return;
    for (const button of root?.querySelectorAll(`button.${className}:not([data-wired])`) ?? []) {
      button.dataset.wired = "true";
      button.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const itemId = ev.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
        if (itemId) onClick(itemId);
      });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | wiring ${className} failed`, err);
  }
}

/** The Stash and Give buttons on a member's character sheet (the column is injected in setup). */
Hooks.on("renderCharacterActorSheet", (app, element) => {
  const actor = app.document;
  if (actor?.type !== "character") return;
  const root = element instanceof HTMLElement ? element : app.element;
  wireButtons(root, "partystash-stash-button", itemId => {
    const item = actor.items.get(itemId);
    if (item) stashDialog(actor, item);
  }, "stash");
  wireButtons(root, "partystash-give-button", itemId => {
    const item = actor.items.get(itemId);
    if (item) giveDialog(actor, item);
  }, "give");
});

/* -------------------------------------------------- */
/*  Give — a hand-off through the stash               */
/* -------------------------------------------------- */

/**
 * v1.7 — GIVE: hand an item straight to another party member, from the character sheet,
 * with no GM in the loop. Filed as issue #1; ruled 2026-09-30 and 2026-10-01 off
 * prototypes/give-button.html.
 *
 * A player owns their own character, not their partymates', and the server refuses a create
 * on an actor you don't own — so Ann's client cannot simply write the item onto Bob. Every
 * other write in this module runs on the acting client, and that is deliberate (see
 * shouldPostReceipt: electing the GM lost receipts whenever the GM was absent). So Give is
 * the table's own workaround made into one gesture. Players already give without a GM by
 * pressing Stash and having the other player press Take, each half writing only to actors
 * its presser owns. Give does the first half and the recipient's client does the second:
 *
 *   1. Ann's client puts the amount in the group as ITS OWN ROW, never merged, marked
 *      `flags.fvtt-mod-partystash.giveTo = { actor, user, from, fromUser, at }`, then
 *      reduces or deletes Ann's stack. Credit before debit, as everywhere here.
 *   2. The mark names a USER, so exactly one client acts on it: Sam's. It sees the row
 *      arrive (createItem fires on every client), moves it onto Bob through claimRow and
 *      deletes the stash row. A GM who also owns Bob never touches it.
 *   3. One receipt — "Ann gave 2 × Antitoxin to Bob" — posted by the client that finished the
 *      move. The stash's own in/out receipts skip marked rows (isHandOff), so a gift reads as
 *      a gift and not as a stash-in and a take-out.
 *
 * The recipient list only offers members whose player is online and owns the group, so a
 * stall is rare; when it happens anyway (Sam logged off between the press and the move, or
 * runs an older script), Ann's client waits GIVE_WAIT for the stash row to go, then takes it
 * back and says so (the user's rule, 2026-09-30: nothing waits in the stash). A recipient Ann
 * owns anyway — a GM, or a player with two characters in the party — gets the item directly.
 *
 * THE GUARD — deleting the stash row decides who gets the item. A slow Sam can finish just as
 * Ann's timeout reverts; Sam logged in twice has two clients acting on one row. Everyone who
 * moves a marked row credits first, then deletes the row; only one delete can succeed; a
 * client whose delete fails, or finds the row gone, has LOST and undoes its own credit. At
 * every moment at least one copy exists, and it ends with exactly one. Containers additionally
 * keep their ids on the way through (createWithContents), so a second credit of the same
 * container is refused by the server outright.
 */

/**
 * How long the giver waits for the recipient's client before taking the gift back. A live
 * browser applies a broadcast in milliseconds, but a laggy one (a tablet mid-render, the
 * harness's headless pages at 1.5–4s) must not lose the race it would otherwise have won
 * through the guard — so a few seconds more than it should ever need.
 */
const GIVE_WAIT = 8000;

/** Item ids this client created or deleted as part of a hand-off — not stash traffic. */
const quiet = new Set();

/**
 * Is this item a gift in transit — a marked stash row, something inside one, or an id this
 * client moved as part of a hand-off? The receipt hooks skip these.
 */
function isHandOff(item) {
  if (quiet.has(item.id)) return true;
  if (item.getFlag?.(MODULE_ID, "giveTo")) return true;
  const holder = item.system?.container ? item.parent?.items?.get(item.system.container) : null;
  return !!holder?.getFlag?.(MODULE_ID, "giveTo");
}

/** A container's cargo, all the way down, as ids. */
function cargoIds(item) {
  const out = [];
  for (const inner of item.system?.contents ?? []) {
    out.push(inner.id, ...cargoIds(inner));
  }
  return out;
}

/**
 * The online user whose client will finish a hand-off to `actor`: the one it is the assigned
 * character of, else any active player who owns both the member and the group. GMs don't
 * count unless the character is theirs — listing Bob while only the GM is online would make
 * the GM's client the finisher, the dependency this design exists to avoid.
 */
function finisherFor(actor, group) {
  const users = game.users.filter(u => u.active && u.id !== game.user.id
    && actor.testUserPermission(u, "OWNER") && group.testUserPermission(u, "OWNER"));
  return users.find(u => u.character === actor) ?? users.find(u => !u.isGM) ?? null;
}

/**
 * Who `actor` can give to, per group: every group the giver owns and belongs to, with the
 * character members that are either owned by the giver (a direct move) or have an online
 * finisher. NPC members (a hireling, a mount) have no player and are left out — the user's
 * call on 2026-10-01. Groups with nobody to give to are dropped.
 */
function giveOptions(actor) {
  const out = [];
  for (const group of game.actors) {
    if (group.type !== "group" || !group.isOwner) continue;
    if (!group.system?.members?.some?.(m => m.actor === actor)) continue;
    const to = [];
    for (const m of group.system.members) {
      const other = m.actor;
      if (!(other instanceof Actor) || other === actor || other.type !== "character") continue;
      if (other.isOwner) to.push({ actor: other, user: null });
      else {
        const user = finisherFor(other, group);
        if (user) to.push({ actor: other, user });
      }
    }
    if (to.length) out.push({ group, to });
  }
  return out;
}

/**
 * The Give button's click. The prompt is buttonPrompt's shape with one more field: when the
 * giver belongs to more than one group a "Party" picker sits ABOVE the "To" picker and the
 * recipients follow it; with one group the picker is not shown (the user, 2026-10-01). When
 * there is nobody to give to, a warning says so instead of an empty picker.
 */
async function giveDialog(actor, item) {
  if (!actor.isOwner) {
    return void ui.notifications.warn(
      `Party Stash: you don't own ${actor.name}, so you can't give their things away.`);
  }
  const esc = Handlebars.escapeExpression;
  const options = giveOptions(actor);
  if (!options.length) {
    // A dialog, not a toast — the same window every other Party Stash gesture opens (the
    // user's call, 2026-10-01), so "nobody to give to" reads as the answer to the press.
    const groups = game.actors.filter(g =>
      g.type === "group" && g.system?.members?.some?.(m => m.actor === actor));
    const where = groups.length === 1 ? `<strong>${esc(groups[0].name)}</strong>` : "the party";
    return void foundry.applications.api.DialogV2.wait({
      classes: ["partystash-dialog"],
      window: { title: `Give ${item.name}`, icon: "fa-solid fa-people-arrows" },
      position: { width: 360 },
      content: `<p>No party members to give <strong>${esc(item.name)}</strong> to: nobody else in `
        + `${where} is online right now.</p>`,
      buttons: [{ action: "ok", label: "OK", default: true }],
      rejectClose: false
    });
  }

  const max = stackCount(item);
  const container = item.type === "container";
  const askQty = !container && max > 1;
  const detail = askQty ? ` There are ${max}.` : container ? " It moves with its contents." : "";
  const label = c => c.user ? `${c.actor.name} (${c.user.name})` : c.actor.name;
  const only = options.length === 1 && options[0].to.length === 1 ? options[0].to[0] : null;
  const question = only
    ? `Give <strong>${esc(item.name)}</strong> to <strong>${esc(only.actor.name)}</strong>?${detail}`
    : `Give <strong>${esc(item.name)}</strong> to a party member?${detail}`;

  const groupField = options.length > 1
    ? `<div class="form-group"><label>Party</label><div class="form-fields"><select name="group">`
      + options.map(o => `<option value="${o.group.id}">${esc(o.group.name)}</option>`).join("")
      + `</select></div></div>`
    : `<input type="hidden" name="group" value="${options[0].group.id}">`;
  const toOptions = o => o.to.map(c => `<option value="${c.actor.id}">${esc(label(c))}</option>`).join("");
  const partnerField = only
    ? `<input type="hidden" name="partner" value="${only.actor.id}">`
    : `<div class="form-group"><label>To</label><div class="form-fields"><select name="partner">`
      + toOptions(options[0]) + `</select></div></div>`;
  const qtyField = askQty
    ? `<div class="form-group"><label>Quantity</label><div class="form-fields">`
      + `<input type="number" name="qty" value="1" min="1" max="${max}" step="1" autofocus>`
      + `</div><p class="hint">Up to ${max}.</p></div>`
    : "";

  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["partystash-dialog"],
    window: { title: `Give ${item.name}`, icon: "fa-solid fa-people-arrows" },
    position: { width: 360 },
    content: `<p>${question}</p>` + groupField + partnerField + qtyField,
    buttons: [
      {
        action: "go", label: "Give", icon: "fa-solid fa-people-arrows", default: true,
        callback: (ev, button) => ({
          groupId: button.form?.elements?.group?.value,
          partnerId: button.form?.elements?.partner?.value,
          qty: Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || 1)))
        })
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false,
    // The recipients follow the party picker (see coinDialog for the render-callback shape).
    render: (event, dialog) => {
      try {
        const form = (dialog?.element ?? dialog).querySelector("form");
        const groupSelect = form?.elements?.group;
        const partnerSelect = form?.elements?.partner;
        if (!groupSelect || groupSelect.type !== "select-one" || !partnerSelect) return;
        groupSelect.addEventListener("change", () => {
          const o = options.find(x => x.group.id === groupSelect.value) ?? options[0];
          partnerSelect.innerHTML = toOptions(o);
        });
      } catch (err) {
        console.error(`${MODULE_ID} | wiring the give dialog failed`, err);
      }
    }
  });
  if (!result || typeof result !== "object") return;
  const option = options.find(o => o.group.id === result.groupId) ?? options[0];
  const choice = option.to.find(c => c.actor.id === result.partnerId) ?? option.to[0];
  const qty = container ? max : (askQty ? result.qty : 1);

  try {
    if (!choice.user) {
      // The giver owns the recipient: a plain move, no hand-off.
      const moved = await moveStack(item, choice.actor, qty);
      ui.notifications.info(`Gave ${moved} × ${item.name} to ${choice.actor.name}.`);
      postGiveReceipt(actor, choice.actor, item.name, moved, container);
      return;
    }
    await handOff(actor, item, option.group, choice, qty);
  } catch (err) {
    console.error(`${MODULE_ID} | giving failed`, err);
    ui.notifications.error(`Party Stash: giving ${item.name} failed (${err.message}).`);
  }
}

/** The one receipt a gift posts, by whichever client finished the move. */
function postGiveReceipt(from, to, name, amount, cargo) {
  if (!receiptsEnabled()) return;
  const label = `${amount} × <em>${name}</em>${cargo ? " (and its contents)" : ""}`;
  postReceipt([`<strong>${from?.name ?? "Someone"}</strong> gave ${label} to <strong>${to.name}</strong>.`],
    game.user.id, [from, to].filter(a => a instanceof Actor));
}

/**
 * The giver's half: the marked row goes into the group, the giver's stack comes down, and
 * then this client waits for the recipient's client to take the row away. If it is still
 * there after GIVE_WAIT, this client takes the gift back through the same guard — so a
 * recipient who finishes at the last moment still wins, and nothing is doubled.
 */
async function handOff(actor, item, group, { actor: to, user }, n) {
  const max = stackCount(item);
  n = Math.min(max, Math.max(1, Math.floor(Number(n) || 1)));
  const container = item.type === "container";
  const mark = { actor: to.id, user: user.id, from: actor.id, fromUser: game.user.id, at: Date.now() };
  const name = item.name;

  let row;
  if (container) {
    const Item5e = item.constructor;
    const toCreate = await Item5e.createWithContents([item]);
    foundry.utils.setProperty(toCreate[0], `flags.${MODULE_ID}.giveTo`, mark);
    for (const d of toCreate) if (d._id) quiet.add(d._id);
    const created = await Item5e.createDocuments(toCreate, { parent: group, keepId: true });
    row = created.find(i => i.getFlag(MODULE_ID, "giveTo")) ?? created[0];
    await item.delete({ deleteContents: true });
  } else {
    const data = carriedData(item, n);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.giveTo`, mark);
    [row] = await group.createEmbeddedDocuments("Item", [data]);
    quiet.add(row.id);
    if (n >= max) await item.delete();
    else await item.update({ "system.quantity": max - n });
  }

  const deadline = Date.now() + GIVE_WAIT;
  while (Date.now() < deadline && group.items.get(row.id)) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (!group.items.get(row.id)) {
    ui.notifications.info(`Gave ${container ? 1 : n} × ${name} to ${to.name}.`);
    return;
  }

  // Stalled. Take it back — unless the recipient gets there first after all.
  const live = group.items.get(row.id);
  const back = live ? await claimRow(live, actor) : 0;
  if (back) {
    ui.notifications.error(`Party Stash: problem finding ${user.name} to give ${to.name} the `
      + `${name}. It's back with ${actor.name}. Try again.`);
  } else {
    ui.notifications.info(`Gave ${container ? 1 : n} × ${name} to ${to.name}.`);
  }
}

/**
 * Move a marked stash row onto `dest` — the recipient's half, and the giver's revert. THE
 * GUARD lives here: credit first, then delete the row; the delete decides. A delete that
 * throws, or that deletes nothing (the row was already gone), means another client got
 * there first, and this client undoes its own credit. Returns how many moved, 0 when lost.
 */
async function claimRow(row, dest) {
  const group = row.parent;
  const n = stackCount(row);
  const container = row.type === "container";
  quiet.add(row.id);
  for (const id of cargoIds(row)) quiet.add(id);

  let undo;
  if (container) {
    const Item5e = row.constructor;
    const toCreate = await Item5e.createWithContents([row]);
    if (toCreate[0]?.flags?.[MODULE_ID]) delete toCreate[0].flags[MODULE_ID];
    // keepId: the container and its cargo arrive under their stash ids, so a second client
    // crediting the same gift is refused by the server before the guard even runs.
    const created = await Item5e.createDocuments(toCreate, { parent: dest, keepId: true });
    const ids = created.map(i => i.id);
    undo = async () => dest.deleteEmbeddedDocuments("Item", ids.filter(id => dest.items.has(id)));
  } else {
    undo = await creditStack(row, dest, n);
  }

  let won = false;
  try {
    const deleted = await row.delete({ deleteContents: true });
    won = !!deleted;
  } catch (err) {
    console.warn(`${MODULE_ID} | the deciding delete failed — another client has this gift`, err);
    won = false;
  }
  if (won) return n;
  try {
    await undo();
  } catch (err) {
    console.error(`${MODULE_ID} | undoing a lost claim failed — a duplicate may remain`, err);
  }
  return 0;
}

/** The recipient's half: claim a row marked for this user, then tell the table. */
async function finishGive(row, mark) {
  const to = game.actors.get(mark.actor);
  const from = game.actors.get(mark.from);
  if (!to?.isOwner) return; // can't finish; the giver's timeout takes it back
  const cargo = row.type === "container";
  const name = row.name;
  try {
    const moved = await claimRow(row, to);
    if (!moved) return;
    ui.notifications.info(`${from?.name ?? "Someone"} gave ${to.name} ${moved} × ${name}.`);
    postGiveReceipt(from, to, name, moved, cargo);
  } catch (err) {
    console.error(`${MODULE_ID} | finishing a gift failed`, err);
  }
}

/** The recipient's trigger: a marked row arriving in a group, addressed to this user. */
Hooks.on("createItem", (item, options, userId) => {
  try {
    const mark = item.getFlag?.(MODULE_ID, "giveTo");
    if (!mark || item.parent?.type !== "group" || mark.user !== game.user.id) return;
    if (!game.settings.get(MODULE_ID, "give")) return;
    void finishGive(item, mark);
  } catch (err) {
    console.error(`${MODULE_ID} | give trigger failed`, err);
  }
});

/**
 * Leftovers on login. The one way a marked row outlives a hand-off is the giver's client
 * closing before its timeout and the recipient never acting. The recipient's client claims
 * anything addressed to it; the giver's client takes back anything it sent that has sat past
 * GIVE_WAIT. Both go through the guard, so if both are here, exactly one wins.
 */
Hooks.once("ready", () => {
  try {
    if (!game.settings.get(MODULE_ID, "give")) return;
    for (const group of game.actors) {
      if (group.type !== "group") continue;
      for (const row of group.items) {
        const mark = row.getFlag(MODULE_ID, "giveTo");
        if (!mark) continue;
        if (mark.user === game.user.id) void finishGive(row, mark);
        else if (mark.fromUser === game.user.id && Date.now() - (mark.at ?? 0) > GIVE_WAIT) {
          const from = game.actors.get(mark.from);
          if (!from?.isOwner) continue;
          claimRow(row, from).then(back => {
            if (back) ui.notifications.warn(`Party Stash: ${row.name} came back to ${from.name} — `
              + `${game.users.get(mark.user)?.name ?? "the recipient"} never picked it up.`);
          }).catch(err => console.error(`${MODULE_ID} | taking back a stale gift failed`, err));
        }
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | the gift sweep failed`, err);
  }
});

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
  const group = app.document;
  if (group?.type !== "group") return;
  const root = element instanceof HTMLElement ? element : app.element;

  wireButtons(root, "partystash-take-button", itemId => {
    const item = group.items.get(itemId);
    if (item) takeDialog(group, item);
  }, "take");

  try {
    if (!game.settings.get(MODULE_ID, "coin")) return;
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
