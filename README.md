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

## Moving coin

Items move by dragging; coin can't be dragged. So the group sheet's currency row gets two
buttons — **Deposit** and **Withdraw** — and for players the purse fields themselves become
**read-only**, along with the system's own currency-manager button, so the dialog is the one
way coin moves in or out of the stash. GMs keep the stock editable row and the system button.

The dialog is five boxes, one per denomination, each **capped at what the source is actually
holding** — so an unaffordable transfer can't even be typed. An **Everything** button fills
all five, which is the whole gesture after a fight. If you own more than one member, a picker
chooses whose purse the coin comes from (or goes to).

Coin moves **denomination by denomination**: two platinum leaving the stash arrive as two
platinum, never twenty gold. Nobody's purse gets silently re-minted. The destination is
credited before the source is debited, so a failure duplicates coin rather than destroying it
— and the receipt shows it either way.

## Transfer receipts

Every loot transfer in or out of a Group actor is posted to the **chat log for the whole
table** — a shared record of who moved what through the party stash, which is what settles
"who took the healing potion?" without anyone having to remember. (Loot Shelf's audit lines
work the same way, so shop, chest and stash traffic read as one running account.)
Receipts hook the document layer rather than the drag gesture, so everything is on the
record: the module's own moves, forced Shift/Ctrl drags, GM stocking from the sidebar or
a compendium, macros, and coin changes on the group sheet (as signed per-denomination
deltas — coin is never re-denominated).

One gesture reads as one receipt: a container arriving with its contents is a single
line, and the two halves of a move pair up so the line names the member involved
(*"Bob stashed 3 × Rations in Party Stash"*). When the counterparty isn't part of the
gesture — a Ctrl-drag copy, sidebar stocking — the line is named after the acting user
instead. Consumable stack merges show up as the quantity they added, not as a new item.

One gesture reads as one receipt, and a deposit or withdrawal names the member and the
direction (*"Gren Greenmantle deposited 12 gp into The Party"*) rather than a signed delta —
hand edits and GM adjustments still read as adjustments, because that is what they are.

Three world settings (**Game Settings → Configure Settings → Party Stash**) turn the move
semantics, the receipts, and the coin window off independently.

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
