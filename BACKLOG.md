# Backlog

Party Stash's to-do list: features asked for and not built yet, in rough priority order.
Each item has three parts: the ask, what the code does today, and the questions to settle
before building. An item leaves this file when it ships. After that, its record is the
release commit.

## 1 · A Give button on member character sheets

**Asked 2026-09-30 (the user):** a Give button next to the Stash button. Its dialog
transfers the item to another existing party member. Filed as
[#1](https://github.com/Txpple/fvtt-mod-partystash/issues/1) on 2026-10-01, with a clickable
prototype at [prototypes/give-button.html](prototypes/give-button.html): the layouts, the
prompt, the no-recipient case and the stall, each a toggle.

**The problem.** A player owns their own character, not their partymates'. The server
refuses `createEmbeddedDocuments` on an actor you don't own, so a player can't write the
item onto the recipient directly. Every Party Stash write runs on the acting client, with no
GM in the loop. That's deliberate: `shouldPostReceipt` records how electing the GM was tried
on 2026-08-12 and lost receipts whenever the GM was absent.

**Decided 2026-09-30 (the user): Give goes through the stash, not the GM.** The table already
gives without a GM: the giver presses Stash and the recipient presses Take. Each half writes
only to actors the acting player owns, their own character and the group. Give turns that
into one gesture, and the recipient's client does the second half by itself.

**How it works.**

1. **The list.** Give on an inventory row opens `buttonPrompt`, with the picker labelled
   "To". It lists the characters in the giver's groups whose player is **online** and also
   owns the group, since their client will take the item out of it. Each entry shows the
   character and the player: "Bob (Sam)". A stack also gets the quantity prompt.
2. **The giver's half.** The giver's client puts the chosen quantity in the group as **its
   own row, never merged** into an existing stack. It marks the row with a flag,
   `flags.fvtt-mod-partystash.giveTo = { actor, user, from }`. Then it reduces or deletes
   the giver's stack: credit before debit, as in `moveStack`.
3. **The recipient's half.** The flag names a player, so only that player's client acts.
   It sees the marked row arrive, moves it onto the named character through `moveStack`
   (merging into their stack there), and deletes the stash row. A GM who also owns the
   character never acts on it, so nothing is taken twice.
4. **One receipt.** The stash receipt hooks skip marked rows, both on the way in and on the
   way out. The recipient's client posts a single line when the move finishes, "Ann gave
   2 × Antitoxin to Bob", under the usual Receipt Settings. In the participants mode, that
   means the giver, the recipient's player and the DMs.

If the giver owns the recipient (a GM, or a player with two characters in the party), the
move happens directly on the giver's client, with no hand-off.

**When a hand-off stalls, the gift goes back (the user, 2026-09-30).** This is rare,
because the list only offers online players. It can still happen: the recipient logs off
between the click and the move, or their client is still running an older script. The
giver's client waits a few seconds for the stash row to go. If it's still there, the giver's
client moves it back to the giver and shows an error: "Party Stash: problem finding Sam to
give Bob the Antitoxin. It's back with Ann. Try again." Nothing waits in the stash, so there
is no login check and no warning on Take.

**The guard: deleting the stash row decides who gets the item.** A slow client can
finish the move just as the giver's timeout reverts it. Sam logged in twice gives two
clients acting on the same row. Either way, two copies get added. The rule:
- Everyone who moves a marked row does it in the usual order: add to the destination, then
  delete the stash row.
- Only one delete can succeed.
- A client whose delete fails, or who finds the row already gone, has lost. It undoes its
  own add: it deletes the row it created, or lowers the stack it merged into by the same
  amount.

At every moment at least one copy exists, and it ends with exactly one. Because an add can
be undone by lowering the stack, merging into Bob's existing stack stays allowed. At build
time, check what Foundry 14 does when a client deletes an embedded document that's already
gone (a thrown error or an empty result), since the loser's check reads it.

If the giver's client closes before its timeout fires and the recipient never acts, the row
is left orphaned in the stash. The giver's client then reverts rows marked `from` its player
on its next login. It's the one leftover case, and a corner of a corner.

**Still open:**

- **NPC recipients.** A hireling or a mount has no player, so the hand-off can't reach it.
  Should NPCs appear only for a giver who owns them, or not at all?
- **Width.** Stash is an 84px column on the busiest sheet in the game, and a second column
  would double that. Options: one column holding both buttons, or Give in the row's context
  menu instead.
- **Which group.** When the giver and recipient share more than one group, the hand-off needs
  a rule. Proposed: use a group both players own, and the first one if several qualify.
- **Containers.** A container moves with its contents, and the contents carry the container's
  id, not the mark. The receipt hooks must skip items inside a marked container too, or giving
  a backpack posts a line for everything in it.
- **Setting.** Give gets its own toggle ("Give button on member character sheets"),
  mirroring `stash`.
- **Docs and harness.** The header comment in `scripts/partystash.js`, the README and the
  module.json description all say PC↔PC transfers keep stock behavior. Each needs a line
  about Give. Drags don't change: PC↔PC drags stay stock copies, and Give is a button
  gesture only. `tools/verify-partystash.mjs` needs a probe I, with two player clients live
  at once (giver and recipient), plus a stalled hand-off that reverts to the giver and
  a race between the recipient and the revert that ends with exactly one copy.

**Considered and not taken:**
- **A GM relay** (a socket, or Foundry 13's `CONFIG.queries` / `User#query`). It brings
  back the GM dependency the module dropped on 2026-08-12.
- **Owned recipients only.** At a table where each player owns one character, the list would
  be empty for players.
