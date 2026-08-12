# Party Stash

True move semantics for the shared party stash in **dnd5e**. Stock drag-and-drop between
actor sheets *copies* an item, so stocking a Group actor's shared inventory from a member's
sheet leaves a duplicate behind. With this module, dragging an item between a Group actor
and one of its members **moves** it — the source item is deleted once the drop has landed —
in both directions:

- member's sheet → group sheet (stash an item),
- group sheet → member's sheet (hand an item out),
- group inventory → a member's row inside the group sheet (same as handing it out).

The move only applies when **all** of the following hold; every other drag keeps the stock
copy behavior:

- the item is a physical item dragged between a Group actor and **one of its own members**
  (PC↔PC gifting, NPC looting, sidebar/compendium drops are untouched),
- the dragging user **owns both sides**.

If only **one** side is owned — say a player drags a fellow member's gear into the stash from
that member's read-only sheet — the drop is **blocked** (no-drop cursor plus a warning)
rather than silently falling back to a copy: the server would refuse the source delete and a
duplicate would be stranded. When a duplicate is actually what you want, Ctrl-drag still
copies.

Under the hood this only changes dnd5e's *default* drop behavior for that one case — the
system's own move pipeline does the actual work. That buys the safe ordering (the source is
deleted only after the copy has actually been created), consumable stack merging, and
container contents coming along for the ride. It also means the standard dnd5e drag
modifiers still work everywhere:

- **Ctrl-drag** (or Alt-drag) — force a plain **copy**, even to/from the stash,
- **Shift-drag** — force a **move** for any drag dnd5e allows (e.g. looting an NPC).

## Transfer receipts

Every loot transfer in or out of a Group actor is recorded as a **chat whisper** to the
GMs and the acting player — an audit trail of who moved what through the party stash.
Receipts hook the document layer rather than the drag gesture, so everything is on the
record: the module's own moves, forced Shift/Ctrl drags, GM stocking from the sidebar or
a compendium, macros, and coin changes on the group sheet (as signed per-denomination
deltas — coin is never re-denominated).

One gesture reads as one receipt: a container arriving with its contents is a single
line, and the two halves of a move pair up so the line names the member involved
(*"Bob stashed 3 × Rations in Party Stash"*). When the counterparty isn't part of the
gesture — a Ctrl-drag copy, sidebar stocking — the line is named after the acting user
instead. Consumable stack merges show up as the quantity they added, not as a new item.

Two world settings (**Game Settings → Configure Settings → Party Stash**) turn the move
semantics and the receipts off independently.

## Compatibility

Requires the **dnd5e** system, 5.x or later (the module rides the drop-behavior seam the
system introduced in 5.0). Foundry v13+ (verified on v14 with dnd5e 5.3.3). If the seam
ever moves, the module logs an error and leaves drops at stock behavior — it fails open,
never destructive.

## Installation

Install via manifest URL:

```
https://github.com/Txpple/fvtt-mod-partystash/releases/latest/download/module.json
```

## License

MIT
