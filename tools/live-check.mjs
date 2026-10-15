// The live check of the kit's receipt and its revert, on a real world (the local sandbox).
//
//   FOUNDRY_HOST=local node tools/live-check.mjs
//
// Joins as the suite identity (FOUNDRY_SUITE_USER in the MCP repo's .env), refuses to run beside
// another GM client, and then:
//   A. a member stashing two of a stack (the create on the group and the stack's decrement, the
//      writes Party Stash's own moves make) posts one receipt line whose flag carries the move;
//   B. the revert, asked as the Revert button asks it (api.revertReceipt), puts the two back on the
//      member and takes them out of the stash, posting no line of its own;
//   C. a GM's change to the stash's purse posts an adjustment line, and its revert puts the purse back.
// Every fixture (the member, the stash, the chat lines) is removed in `finally`.
import { connectFoundry } from "fvtt-mcp-dnd5e/client";

const PROBE = "ZZ-4g Live";
let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fails++;
};

const { f, dispose } = await connectFoundry({ host: "local", identity: "suite", tag: "live-check", watchdogMs: 300_000 });

/** In the page: who else is a GM here, and whether this client is Party Stash's elect. */
const PREFLIGHT = async () => {
  const api = game.modules.get("fvtt-mod-partystash")?.api;
  const others = game.users.filter(u => u.active && u.isGM && !u.isSelf).map(u => u.name);
  const until = Date.now() + 10_000;
  while (api && !api.isElect() && Date.now() < until) await new Promise(r => setTimeout(r, 200));
  return {
    active: !!game.modules.get("fvtt-mod-partystash")?.active,
    hasKit: typeof api?.revertReceipt === "function",
    elect: !!api?.isElect?.(),
    receipts: game.settings.get("fvtt-mod-partystash", "receipts"),
    others
  };
};

/** In the page: the member and the stash. */
const FIXTURE = async ({ probe }) => {
  const member = await Actor.implementation.create({
    name: `${probe} Member`, type: "character", system: { currency: { pp: 0, gp: 5, ep: 0, sp: 0, cp: 0 } },
    items: [{ name: `${probe} Lantern`, type: "loot", system: { quantity: 3 } }]
  });
  const stash = await Actor.implementation.create({ name: `${probe} Stash`, type: "group" });
  await stash.system.addMember(member);
  return { member: member.uuid, stash: stash.uuid, ids: [member.id, stash.id] };
};

/** In the page: the scenario, each step's facts for the asserts. */
const SCENARIO = async ({ probe, fx }) => {
  const PS = "fvtt-mod-partystash";
  const api = game.modules.get(PS).api;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const member = await fromUuid(fx.member);
  const stash = await fromUuid(fx.stash);
  const lantern = a => a.items.find(i => i.name === `${probe} Lantern`);
  const qty = a => Math.floor(lantern(a)?.system?.quantity ?? 0);
  const gp = a => Math.floor(a.system.currency?.gp ?? 0);
  const state = m => m?.flags?.[PS]?.receipt?.state?.l0?.state ?? null;
  const waitState = async (id, want) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const s = state(game.messages.get(id));
      if (s === want || s === "refused") return s;
      await sleep(200);
    }
    return state(game.messages.get(id));
  };
  const linesSince = start => game.messages.contents
    .filter(m => !start.has(m.id) && m.speaker?.alias === "Party Stash" && (m.content ?? "").includes(probe));
  const facts = (m, start) => {
    const flag = m?.flags?.[PS]?.receipt;
    return {
      id: m?.id ?? null,
      lines: linesSince(start).length,
      text: (m?.content ?? "").replace(/<[^>]+>/g, ""),
      version: flag?.v ?? null,
      flagLines: flag?.lines?.length ?? 0,
      moves: flag?.lines?.[0]?.moves ?? [],
      revertible: !!flag?.lines?.[0]?.revertible
    };
  };
  const out = { memberUuid: member.uuid, stashUuid: stash.uuid };

  // A. Two of the stack go into the stash: credit the stash, then shrink the member's stack.
  let start = new Set(game.messages.keys());
  const data = lantern(member).toObject();
  delete data._id;
  data.system.quantity = 2;
  const [row] = await stash.createEmbeddedDocuments("Item", [data]);
  await lantern(member).update({ "system.quantity": 1 });
  await sleep(1500); // past the 500 ms receipt batch
  const stashed = linesSince(start).at(-1);
  out.a = { ...facts(stashed, start), rowId: row.id, memberQty: qty(member), stashQty: qty(stash) };

  // B. The revert, as the button asks it.
  start = new Set(game.messages.keys());
  out.b = { asked: stashed ? await api.revertReceipt(stashed.id, 0) : false };
  out.b.state = stashed ? await waitState(stashed.id, "done") : null;
  out.b.why = stashed?.flags?.[PS]?.receipt?.state?.l0?.why ?? null;
  await sleep(1500);
  Object.assign(out.b, {
    memberQty: qty(member), stashQty: qty(stash),
    newLines: game.messages.contents.filter(m => !start.has(m.id)).length,
    again: stashed ? await api.revertReceipt(stashed.id, 0) : null
  });

  // C. A GM's change to the stash's purse, and its revert.
  start = new Set(game.messages.keys());
  await stash.update({ "system.currency.gp": 7 });
  await sleep(1500);
  const adjusted = linesSince(start).at(-1);
  out.c = { ...facts(adjusted, start), stashGp: gp(stash) };
  start = new Set(game.messages.keys());
  if (adjusted) await api.revertReceipt(adjusted.id, 0);
  out.c.state = adjusted ? await waitState(adjusted.id, "done") : null;
  await sleep(1500);
  Object.assign(out.c, {
    stashGpAfterRevert: gp(stash), memberGp: gp(member),
    linesAfterRevert: game.messages.contents.filter(m => !start.has(m.id)).length
  });
  return out;
};

/** In the page: everything the check made. */
const TEARDOWN = async ({ probe, ids }) => {
  const messages = game.messages.contents.filter(m => (m.content ?? "").includes(probe)).map(m => m.id);
  if (messages.length) await ChatMessage.implementation.deleteDocuments(messages);
  const actors = [...new Set([...(ids ?? []), ...game.actors.filter(a => a.name?.startsWith(probe)).map(a => a.id)])]
    .filter(id => game.actors.has(id));
  if (actors.length) await Actor.implementation.deleteDocuments(actors);
  return { messages: messages.length, actors: actors.length };
};

let fx = null;
try {
  console.log("# preflight");
  const pre = await f.evaluate(PREFLIGHT, null);
  check(pre.active && pre.hasKit, "Party Stash is active and carries the kit (api.revertReceipt)");
  check(pre.others.length === 0, `no other GM client is connected (${pre.others.join(", ") || "none"})`);
  check(pre.elect, "this client is Party Stash's elect, in its leading window");
  check(pre.receipts === true, "transfer receipts are on");
  if (fails) throw new Error("preflight failed; nothing was made");

  await f.evaluate(TEARDOWN, { probe: PROBE, ids: [] }); // a crashed run's leavings
  fx = await f.evaluate(FIXTURE, { probe: PROBE });
  const r = await f.evaluate(SCENARIO, { probe: PROBE, fx });

  console.log("# A — a stash posts one line carrying its move");
  console.log(`  [receipt] ${r.a.text}`);
  check(r.a.lines === 1, `one Party Stash line (got ${r.a.lines})`);
  check(/Member stashed 2 × ZZ-4g Live Lantern in ZZ-4g Live Stash\./.test(r.a.text), "the line names the member, the goods and the stash");
  check(r.a.version === 1 && r.a.flagLines === 1 && r.a.revertible, "the flag is version 1, one revertible line");
  const move = r.a.moves[0];
  check(move?.kind === "item" && move.from === r.memberUuid && move.to === r.stashUuid && move.qty === 2 && move.item === r.a.rowId,
    "the move: 2 from the member to the stash, as the stash's new row");
  check(r.a.memberQty === 1 && r.a.stashQty === 2, `the stash landed (member ${r.a.memberQty}, stash ${r.a.stashQty})`);

  console.log("# B — the revert puts it back, once");
  check(r.b.asked === true, "the ask was written");
  check(r.b.state === "done", `the elect reverted the line (${r.b.state}${r.b.why ? `: ${r.b.why}` : ""})`);
  check(r.b.memberQty === 3 && r.b.stashQty === 0, `as before the stash (member ${r.b.memberQty}, stash ${r.b.stashQty})`);
  check(r.b.newLines === 0, `the revert posted no line of its own (got ${r.b.newLines})`);
  check(r.b.again === false, "a reverted line cannot be asked again");

  console.log("# C — an adjustment of the purse, and its revert");
  console.log(`  [receipt] ${r.c.text}`);
  check(r.c.lines === 1 && /added coin to ZZ-4g Live Stash: \+7 gp\./.test(r.c.text), "one adjustment line, +7 gp");
  check(r.c.moves[0]?.kind === "coin" && r.c.moves[0]?.actor === r.stashUuid && r.c.moves[0]?.delta?.gp === 7, "the coin leg: the stash's purse, +7 gp");
  check(r.c.state === "done" && r.c.stashGpAfterRevert === 0, `the purse is back (state ${r.c.state}, ${r.c.stashGpAfterRevert} gp)`);
  check(r.c.memberGp === 5, "the member's purse never moved");
  check(r.c.linesAfterRevert === 0, `the revert posted no line of its own (got ${r.c.linesAfterRevert})`);
} catch (err) {
  fails++;
  console.error(`  FAIL  ${err.message}`);
} finally {
  try {
    const gone = await f.evaluate(TEARDOWN, { probe: PROBE, ids: fx?.ids ?? [] });
    console.log(`# teardown: ${gone.actors} actors, ${gone.messages} chat lines removed`);
  } catch (err) {
    fails++;
    console.error(`  FAIL  teardown: ${err.message}`);
  }
  await dispose();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
