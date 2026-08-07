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
 *   - the user owns both the source and the target actor.
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
      + "item instead of copying it, when you own both sides. Hold Ctrl while dropping to copy "
      + "anyway. Turn this off to restore the stock copy-on-drop behavior everywhere.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/**
 * Should this drag default to a move? Mirrors the scope rules in the header.
 * @param {ActorSheet} sheet   The sheet being dragged over.
 * @param {DragEvent} event    The dragover event.
 * @param {object} data        The drag payload ({type, uuid}).
 * @returns {boolean}
 */
function isStashMove(sheet, event, data) {
  if (data?.type !== "Item" || !data.uuid) return false;
  const item = fromUuidSync(data.uuid);
  const source = item?.parent;
  if (!(item instanceof Item) || !(source instanceof Actor)) return false;
  if (!item.system?.schema?.fields?.quantity) return false; // physical items only

  // The effective target: the sheet's inventory actor — except on a group sheet, where
  // dropping onto a member's row hands the item to that member (the sheet's own routing).
  let target = sheet.inventorySource;
  if (sheet.actor?.type === "group") {
    const rowUuid = event.target?.closest?.("[data-uuid]")?.dataset?.uuid;
    const rowDoc = rowUuid ? fromUuidSync(rowUuid) : null;
    if (rowDoc instanceof Actor) target = rowDoc;
  }
  if (!(target instanceof Actor) || target === source) return false;

  // Exactly one end is a group, and the other end is one of ITS members.
  const sourceIsGroup = source.type === "group";
  if (sourceIsGroup === (target.type === "group")) return false;
  const group = sourceIsGroup ? source : target;
  const member = sourceIsGroup ? target : source;
  if (!group.system?.members?.some?.(m => m.actor === member)) return false;

  // A move deletes from the source and creates on the target — the user needs both.
  return source.isOwner && target.isOwner;
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
      return isStashMove(this, event, data) ? "move" : fallback;
    } catch (err) {
      console.error(`${MODULE_ID} | drop-behavior check failed`, err);
      return fallback;
    }
  };
});
