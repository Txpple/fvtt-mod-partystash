# Open Roll 5e: Party Stash

A Foundry VTT module for the dnd5e system that makes a Group actor's inventory a working party
stash. Stock drag-and-drop between sheets *copies* an item, so stocking the stash left a duplicate
behind; coin could not move at all without the system's currency manager; and a stack could only
move whole. Party Stash moves items in and out of the stash, moves coin through a small dialog,
splits stacks, hands items between members, and posts a receipt for every transfer.

## How it works

- **A drag between the stash and a member moves the item.** The source is deleted only after the
  copy has landed. Every other drag (character to character, looting an NPC, compendium drops) keeps
  the stock copy behaviour, and Ctrl-drag still copies anywhere.
- **Coin moves through Deposit and Withdraw buttons** on the group's currency row. For players the
  purse fields are read-only, so the dialog is the one way coin moves; GMs keep the editable row.
- **Stacks split.** A move asks how many; the rest stays put.
- **Three buttons on inventory rows:** Take on the group sheet, Stash and Give on member character
  sheets. Give hands an item straight to another party member, with no GM involved.
- **Every transfer posts a receipt** to chat: who moved what, in or out of the stash. Receipts go
  to the whole table or to the transfer's participants and the DMs.
- **The destination is credited before the source is debited**, everywhere. A failure leaves a
  duplicate, never a loss, and the receipt shows it.

Its companion is [Open Roll 5e: Loot Shelf](https://github.com/Txpple/fvtt-mod-lootshelf): Party
Stash owns the shared party inventory, Loot Shelf owns loot on the ground and goods for sale.
Neither needs the other.

## Installation

Paste the manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/Txpple/fvtt-mod-partystash/releases/latest/download/module.json
```

Requires Foundry VTT v13 or v14 and the dnd5e system 5.x or 6.x (verified on dnd5e 6.0.6 /
Foundry 14.369). No other dependencies.

## Moving items

Dragging a physical item between a Group actor and one of its own members moves it, in both
directions, including a drop on a member's row inside the group sheet. The move needs the dragging
user to own both actors. With only one side owned the drop is blocked and a warning explains why: a
copy would land and the source delete would be refused, stranding a duplicate.

dnd5e's own modifiers still apply: **Ctrl-drag** (or Alt) forces a copy, **Shift-drag** forces a
move for any drag the system allows. Only the default for the stash case is changed; the system's
own drop pipeline does the work, so consumable stacks merge and containers move with their
contents.

## Coin

The group's currency row gets **Deposit** and **Withdraw** buttons. The dialog has one box per
denomination, each capped at what the source can afford, and an **Everything** button. If you own
more than one member, a picker chooses whose purse is involved.

Coin the source holds loose moves as itself: two platinum arrive as two platinum. Coin it does not
hold loose is made as change from the rest of the purse, the dialog says so before it happens, and
the receipt records it. Only the source purse is re-composed; the destination receives exactly the
denominations typed.

## Take, Stash and Give

Every move asks first. A stack asks **how many** (a drag defaults to the whole stack, a button to
one); a single item or a container asks a plain confirmation, so a misclick never moves loot
silently. Containers move whole, with their contents.

- **Take**, on every row of the group inventory, moves the item to a member you own, with a picker
  when you own more than one.
- **Stash**, on every row of a member's character sheet, moves the item into the group's inventory.
  The button only appears on characters that belong to a group.
- **Give**, beside Stash, hands the item to another party member. The list offers the members whose
  player is online (with a party picker above it if you belong to more than one group). If nobody
  else is online, a notice says so.

Give needs no GM. A player cannot write onto a partymate's sheet, so the item passes through the
stash marked for the recipient's player, and that player's client moves it onto their character and
clears the stash row. One receipt: *"Ann gave 2 × Antitoxin to Bob."* If the other player's client
never answers, the item comes back to you after a few seconds with an error asking you to try again;
nothing is left waiting in the stash, and whichever client clears the stash row owns the gift, so
nothing is ever doubled. A member you own yourself receives the item directly. NPC members are not
offered.

The buttons sit at the far right of the row, past the system's controls, and stay visible as the
sheet narrows; the system's own columns give way first. The group sheet drops the per-row equip
toggle: nobody wields a sword out of the party's bag.

## Receipts

Every change to a group actor's loot posts a line to chat, under the alias *Party Stash*: the
module's own moves, forced drags, GM stocking from the sidebar, macros and coin changes alike. One
gesture reads as one receipt: a container with its contents is one line, the two halves of a move
pair up (*"Bob stashed 3 × Rations in The Party"*), a deposit names the member and the amount
(*"Gren deposited 12 gp into The Party"*). Hand edits and GM adjustments read as adjustments.

**Receipt Settings** picks who reads them, and Loot Shelf offers the same choice:

- **Broadcast to the server** (default): posted to the chat log for the whole table.
- **Participants and the DMs**: whispered to the player on the other end of the transfer and to the
  DMs. Assistant DMs count as DMs.

## Settings

*Game Settings → Configure Settings → Open Roll 5e: Party Stash.* Everything is on by default.

| Setting | What it does |
| --- | --- |
| Move items between party and members | Off restores stock copy-on-drop everywhere, and the split prompt with it. |
| Post transfer receipts | Off means no ledger at all. |
| Receipts | Broadcast, or participants and the DMs. |
| Deposit / withdraw coin window | Off restores the stock currency row for everyone. |
| Take button on the group inventory | Off removes the Take column. |
| Stash button on member character sheets | Off removes the Stash button. |
| Give button on member character sheets | Off removes the Give button. With both on, Stash and Give share one column. |

## Repository layout

```
module.json                      the Foundry manifest
scripts/partystash.js            the module, one file: drags, coin, stacks, give, receipts
styles/partystash.css            the buttons, the dialogs and the column widths
templates/                       the Take column and the Stash/Give column
tools/
  verify-partystash.mjs          the live suite: drags, buttons, a two-client Give
  verify-partystash-coin.mjs     the live suite for the coin dialog and its receipts
  shot-partystash-coin.mjs       screenshots of the coin dialog
  audit-partystash-coin-cleanup.mjs, clean-stale-ownership.mjs
                                 housekeeping for the sandbox after a crashed run
prototypes/                      clickable mock-ups ruled on before a feature is built
BACKLOG.md                       what is asked for and not built yet
```

## Development

There is no build step: the module is one plain ES module loaded from `scripts/`.

- The live suites run against the local sandbox with `FOUNDRY_HOST=local node
  tools/verify-partystash.mjs` and `… verify-partystash-coin.mjs`. They create and clean up their
  own fixture items and temp users, and use the house MCP repo (`fvtt-mcp-dnd5e`, a `file:` dev
  dependency beside this one); run `npm install` once.
- Releases: bump `version` and the `download` URL in `module.json` together, tag `vX.Y.Z`, and
  publish a zip of `module.json`, `README.md`, `LICENSE`, `scripts/`, `styles/` and `templates/`
  with the manifest as a GitHub release.

<!-- openroll5e:family -->
## Part of Open Roll 5e

Party Stash is one of the Open Roll 5e modules for Foundry VTT, a suite built for one D&D 5e table and
shared. Each module installs and works on its own and none needs another; together they cover the
table from the fog of war to the loot. The other modules:

- [Open Roll 5e: Autoexplore](https://github.com/Txpple/fvtt-mod-autoexplore): lets a scene start fully explored, so the whole map shows through the fog of war while tokens still need line of sight.
- [Open Roll 5e: Battle Flow](https://github.com/Txpple/fvtt-mod-battleflow): combat automation for dnd5e 2024 rules: a hit rolls and applies its own damage, saves resolve themselves, reactions hold, and concentration is tracked. Every rule that touches a fight in the 2024 core books, Heroes of Faerûn, Arcana Unleashed and Ravenloft: The Horrors Within.
- [Open Roll 5e: Combat Plus](https://github.com/Txpple/fvtt-mod-combatplus): automates the chores of running a fight: combat music, an initiative gate, an out-of-turn movement block, defeated marking at 0 HP and turn alerts.
- [Open Roll 5e: Errata](https://github.com/Txpple/fvtt-mod-errata5e): corrects, in memory, bugs in the premium D&D 2024 books, the dnd5e system and Foundry itself, each fix held until the vendor ships its own.
- [Open Roll 5e: FX Studio](https://github.com/Txpple/fvtt-mod-fxstudio): visual and sound effects for dnd5e, played from what actually happened at the table, with about a thousand stock FX and a window for authoring your own.
- [Open Roll 5e: Loot Shelf](https://github.com/Txpple/fvtt-mod-lootshelf): loot chests and merchant shelves that players can take from, buy from and sell to without owning them, with a receipt for every trade.
- [Open Roll 5e: Open Server](https://github.com/Txpple/fvtt-mod-openserver): for hosted worlds: clears the startup pause so players can play before the GM arrives, and gives any user a landing scene of their own.
- [Open Roll 5e: Soundscape](https://github.com/Txpple/fvtt-mod-soundscape): background sound for scenes: random one-shots with silence between them, seamless crossfaded loops, day and night gating, and quiet during combat.

Three MCP servers for [Claude Code](https://claude.com/claude-code) complete the suite:

- [fvtt-mcp-dnd5e](https://github.com/Txpple/fvtt-mcp-dnd5e): builds D&D 5e content in a live Foundry world from Claude Code: a stat block becomes a complete NPC, a map image a walled and lit scene, an adventure its journals, tables and handouts.
- [fvtt-mcp-imagegen](https://github.com/Txpple/fvtt-mcp-imagegen): makes the art with Google's Gemini image models: icons, tokens, props, portraits and illustrations, token redresses and restyles, battlemap and overland-map repaints, and the illustrated session records, all grounded in what the world already shows.
- [fvtt-mcp-sessionscribe](https://github.com/Txpple/fvtt-mcp-sessionscribe): turns a session's Discord recording and Foundry chat log into its record. Its end-to-end `session-scribe` skill drives the server from the Craig link to a speaker-labelled transcript, a fully illustrated player recap, combat statistics, GM notes and a party snapshot.

Issues are welcome on every repo in the family; pull requests are not accepted, since each is one
author's design for one table, shared because it might suit yours. How they fit together is mapped in [fvtt-suite-openroll5e](https://github.com/Txpple/fvtt-suite-openroll5e).
<!-- /openroll5e:family -->

## License

MIT. See [LICENSE](LICENSE).
