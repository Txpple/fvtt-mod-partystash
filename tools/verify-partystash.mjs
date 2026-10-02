// E2E verification for fvtt-mod-partystash (Party Stash — move semantics for the group inventory).
//
// Drives REAL synthetic drag-and-drop through the sheets' own bound listeners (dragstart on the
// source item row -> dragover -> drop on the target sheet), so the module's wrapped
// _defaultDropBehavior, dnd5e's DragDrop5e payload/dropEffect caching, and the full
// _onDropItem -> _onDropCreateItems pipeline (create on target, delete source) all execute
// exactly as they do for a human drag. Asserts:
//
//   A. PC -> PC control drag  : stock COPY (scope guard — module must not touch it)
//   B. member -> group        : MOVE (created on group, source deleted)
//   C. group -> member        : MOVE back
//   D. member -> group + Ctrl : forced COPY (dnd5e dragCopy modifier still wins)
//   E. half-owned drag        : BLOCKED on a player client, with a warning
//   F. member -> group, 1 of 3: SPLIT (v1.6 quantity prompt answered with 1)
//   G. Take button            : 1 of the group's stack to the member (v1.6)
//   H. Stash button           : a single item from the member to the group (v1.6)
//   I. Give button            : a hand-off through the stash between two PLAYER clients, the
//                               stall that takes the gift back, and "nobody online" (v1.7)
//
// B, C and F wait on the v1.6 prompt that every owned member↔group move asks first; the probe
// answers it (whole stack unless it asks for a split). Before this harness knew about it, B and
// C timed out and read as "no item created on the group" — the prompt, not a broken drop.
//
// Also handles first-run plumbing: if the module isn't registered yet (fresh WebDAV upload),
// game.shutDown() -> reconnect (setup rescans Data/modules, bridge auto-relaunches), and if it
// isn't enabled, flips core.moduleConfiguration and reconnects so the esmodule loads.
//
// Creates + cleans a ZZ-PSTASH fixture item on the first two character members of the group.
// Run: node tools/verify-partystash.mjs   (FOUNDRY_HOST=local for the sandbox; build fvtt-mcp-dnd5e first if its dist is stale)
import { Foundry, foundryConfig, loadEnv } from 'fvtt-mcp-dnd5e/client';

const env = loadEnv();

const MODULE_ID = 'fvtt-mod-partystash';
const TAG = 'ZZ-PSTASH Probe Torch';
const GROUP_ID = 'm2iibo7g0b1YFFjQ'; // "The Party" (re-derived below if missing)

const mkFoundry = () => new Foundry(foundryConfig(env));

let fails = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * One synthetic drag probe, fully inside the page. Single-arg evaluate (bridge rule).
 * `split` answers v1.6's quantity prompt with that many instead of the whole stack.
 */
const PROBE = async ({ sourceId, itemId, targetId, ctrl, tag, split }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // An earlier probe that failed hands on no item id; without this guard the row search below
  // matches the first draggable row that isn't an item and the probe reports on the wrong drag.
  if (!itemId) return { error: 'no item id — an earlier probe failed' };
  try {
    const source = game.actors.get(sourceId);
    const target = game.actors.get(targetId);
    if (!source || !target) return { error: 'actor missing' };
    const sSheet = source.sheet;
    const tSheet = target.sheet;
    await sSheet.render({ force: true });
    await tSheet.render({ force: true });
    await sleep(1200);

    // Source row: core DragDrop.bind stamps draggable=true on drag-selector matches, so the
    // dragstart listener lives on exactly these elements.
    let row = null;
    for (const el of sSheet.element.querySelectorAll('[draggable="true"]')) {
      if (el.closest('[data-item-id]')?.dataset.itemId === itemId) {
        row = el;
        break;
      }
    }
    if (!row) return { error: `no draggable row for ${itemId} on ${source.name}` };

    const dt = new DataTransfer();
    const mk = type =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        ctrlKey: !!ctrl,
      });

    row.dispatchEvent(mk('dragstart'));
    await sleep(300); // _handleDragStart caches the payload in a microtask
    out.payloadCached = !!CONFIG.ux.DragDrop.getPayload?.(null);

    // Find a listening drop element on the target sheet — dragover is side-effect-free and
    // stamps the static dropEffect when a bound listener fires.
    const candidates = [];
    const push = (label, el) => {
      if (el) candidates.push([label, el]);
    };
    push('dnd5e-inventory', tSheet.element.querySelector('dnd5e-inventory'));
    push('.tab[data-tab=inventory]', tSheet.element.querySelector('.tab[data-tab="inventory"]'));
    push('.window-content', tSheet.element.querySelector('.window-content'));
    push('sheet root', tSheet.element);

    let dropEl = null;
    for (const [label, el] of candidates) {
      CONFIG.ux.DragDrop.dropEffect = null;
      el.dispatchEvent(mk('dragover'));
      await sleep(150);
      if (CONFIG.ux.DragDrop.dropEffect !== null) {
        dropEl = el;
        out.dropTarget = label;
        break;
      }
    }
    if (!dropEl) return { ...out, error: `no listening drop element on ${target.name}` };
    out.dropEffect = CONFIG.ux.DragDrop.dropEffect;
    out.notifications = [
      ...document.querySelectorAll('#notifications .notification, .notification'),
    ].map(n => n.textContent.trim().slice(0, 120));

    const beforeTgt = new Set(target.items.map(i => i.id));
    dropEl.dispatchEvent(mk('drop'));

    // Since v1.6 an owned member↔group MOVE asks before it lands ("Stash/Take how many?" for a
    // stack, a plain confirmation otherwise) and the drop waits on the answer. Answer the way a
    // player pressing Enter would — the whole stack — unless the probe asks for a split. Forced
    // copies and blocked drags never prompt, so `prompt` stays unset for them.
    let created = null;
    let answered = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !created) {
      await sleep(300);
      const dlg = !answered && document.querySelector('.partystash-dialog');
      if (dlg) {
        answered = true;
        out.prompt = dlg.querySelector('.window-title')?.textContent?.trim() ?? '?';
        const qty = dlg.querySelector('input[name="qty"]');
        if (qty && split) qty.value = String(split);
        dlg.querySelector('button[data-action="go"]')?.click();
      }
      created = target.items.find(i => !beforeTgt.has(i.id) && i.name === tag) ?? null;
    }
    await sleep(800); // let a trailing source delete land
    row.dispatchEvent(mk('dragend')); // clear DragDrop5e statics
    await sleep(150);

    out.createdOnTarget = !!created;
    out.createdId = created?.id ?? null;
    out.createdQty = created?.system?.quantity ?? null;
    out.sourceRetained = source.items.some(i => i.id === itemId);
    out.sourceQty = source.items.get(itemId)?.system?.quantity ?? null;
    await sSheet.close();
    await tSheet.close();
    return out;
  } catch (err) {
    return { ...out, error: String(err?.stack || err) };
  }
};

/**
 * Press a row's Take or Stash button (v1.6) and answer its prompt: pick `partnerId` in the
 * destination picker when there is one, and ask for `qty` when the stack prompts for it.
 * Single-arg evaluate (bridge rule).
 */
const BUTTON_PROBE = async ({ actorId, itemId, button, partnerId, qty, settle = 2000 }) => {
  const out = { notifications: [] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Toasts live a few seconds; a result that lands late (a Give's take-back fires ~6s after
  // the press) would be missed by one read, so the probe keeps sampling for `settle` ms.
  const notes = new Set();
  const sample = () => {
    for (const n of document.querySelectorAll('#notifications .notification, .notification')) {
      notes.add(n.textContent.trim().slice(0, 140));
    }
  };
  if (!itemId) return { error: 'no item id — an earlier probe failed' };
  try {
    const sheet = game.actors.get(actorId).sheet;
    await sheet.render({ force: true });
    await sleep(1200);
    const btn = sheet.element.querySelector(`[data-item-id="${itemId}"] button.${button}`);
    out.buttonPresent = !!btn;
    if (!btn) {
      await sheet.close();
      return out;
    }
    btn.click();
    let dlg = null;
    for (let i = 0; i < 20 && !dlg; i++) {
      await sleep(150);
      sample();
      dlg = document.querySelector('.partystash-dialog');
    }
    out.prompt = dlg?.querySelector('.window-title')?.textContent?.trim() ?? null;
    if (dlg) {
      const select = dlg.querySelector('select[name="partner"]');
      if (select && partnerId) select.value = partnerId;
      const input = dlg.querySelector('input[name="qty"]');
      if (input && qty) input.value = String(qty);
      dlg.querySelector('button[data-action="go"]')?.click();
    }
    const until = Date.now() + settle;
    while (Date.now() < until) {
      await sleep(250);
      sample();
    }
    out.notifications = [...notes];
    await sheet.close();
    return out;
  } catch (err) {
    return { ...out, error: String(err?.stack || err) };
  }
};

/** Every fixture stack on the given actors: { actorId: [{ id, qty }] }. */
const STACKS = ({ ids, tag }) =>
  Object.fromEntries(
    ids.map(id => [
      id,
      (game.actors.get(id)?.items ?? [])
        .filter(i => i.name === tag)
        .map(i => ({ id: i.id, qty: i.system.quantity })),
    ])
  );

let f = mkFoundry();
try {
  console.log('[pstash] connecting…');
  await f.connect();

  // --- 0. module registered? ------------------------------------------------------------------
  // NOTE (learned live 2026-08-07): Foundry's package registry on this box is scanned at server
  // PROCESS start — a world shutDown+relaunch does NOT pick up files dropped into Data/modules.
  // Registration is fvtt-mcp-dnd5e's scripts/register-module.mjs's job (server-side installPackage via admin
  // /setup); this script only verifies behavior.
  let mod = await f.evaluate(id => {
    const m = game.modules.get(id);
    return m ? { present: true, active: m.active, version: m.version } : { present: false };
  }, MODULE_ID);
  console.log('# registration');
  assert(mod.present, `module registered (version ${mod.version ?? 'n/a'})`);
  if (!mod.present) {
    throw new Error(
      'module not in game.modules — run fvtt-mcp-dnd5e/scripts/register-module.mjs first ' +
        '(world relaunch alone cannot register a new module on this box)'
    );
  }

  // --- 1. enabled? ---------------------------------------------------------------------------
  if (!mod.active) {
    console.log('[pstash] enabling module in core.moduleConfiguration…');
    await f.evaluate(async id => {
      const cfg = foundry.utils.deepClone(game.settings.get('core', 'moduleConfiguration'));
      cfg[id] = true;
      await game.settings.set('core', 'moduleConfiguration', cfg);
    }, MODULE_ID);
    await f.dispose();
    await sleep(5000);
    f = mkFoundry();
    await f.connect(); // fresh page load serves the module esmodule
    mod = await f.evaluate(id => ({ active: !!game.modules.get(id)?.active }), MODULE_ID);
  }
  assert(mod.active, 'module active in the world');

  const wrap = await f.evaluate(() => {
    const p =
      globalThis.dnd5e?.applications?.actor?.BaseActorSheet?.prototype?._defaultDropBehavior;
    return { wrapped: !!p && /stashVerdict|isStashMove/.test(p.toString()) };
  }, null);
  assert(wrap.wrapped, 'BaseActorSheet#_defaultDropBehavior carries the Party Stash wrap');

  // --- 2. fixture ----------------------------------------------------------------------------
  const setup = await f.evaluate(
    async ({ groupId, tag }) => {
      const group =
        game.actors.get(groupId) ??
        game.actors.find(a => a.type === 'group' && a.name === 'The Party');
      if (!group) return { error: 'group actor not found' };
      const members = group.system.members.map(m => m.actor).filter(a => a?.type === 'character');
      if (members.length < 2) return { error: 'need two character members' };
      // stale probes from a previous crashed run
      for (const a of [group, ...members]) {
        const stale = a.items.filter(i => i.name === tag).map(i => i.id);
        if (stale.length) await a.deleteEmbeddedDocuments('Item', stale);
      }
      const [item] = await members[0].createEmbeddedDocuments('Item', [
        { name: tag, type: 'loot', system: { quantity: 3 } },
      ]);
      return {
        groupId: group.id,
        groupName: group.name,
        aId: members[0].id,
        aName: members[0].name,
        bId: members[1].id,
        bName: members[1].name,
        itemId: item.id,
      };
    },
    { groupId: GROUP_ID, tag: TAG }
  );
  if (setup.error) throw new Error(setup.error);
  console.log(
    `# fixture: "${TAG}" x3 on ${setup.aName}; group="${setup.groupName}", control PC=${setup.bName}`
  );

  // --- A. PC -> PC control: must stay a stock COPY -------------------------------------------
  console.log('# probe A — PC -> PC (scope guard, expect copy)');
  const A = await f.evaluate(PROBE, {
    sourceId: setup.aId,
    itemId: setup.itemId,
    targetId: setup.bId,
    ctrl: false,
    tag: TAG,
  });
  if (A.error) console.log('  probe error:', A.error);
  assert(A.payloadCached === true, `drag payload cached by DragDrop5e (harness sanity)`);
  assert(A.dropEffect === 'copy', `dropEffect is "copy" (got "${A.dropEffect}")`);
  assert(A.createdOnTarget === true, `copy created on ${setup.bName} (via ${A.dropTarget})`);
  assert(A.sourceRetained === true, `source retained on ${setup.aName} — PC↔PC unchanged`);
  if (A.createdId) {
    await f.evaluate(
      async ({ bId, cid }) => {
        await game.actors.get(bId)?.deleteEmbeddedDocuments('Item', [cid]);
      },
      { bId: setup.bId, cid: A.createdId }
    );
  }

  // --- B. member -> group: MOVE ---------------------------------------------------------------
  console.log('# probe B — member -> group (expect move)');
  const B = await f.evaluate(PROBE, {
    sourceId: setup.aId,
    itemId: setup.itemId,
    targetId: setup.groupId,
    ctrl: false,
    tag: TAG,
  });
  if (B.error) console.log('  probe error:', B.error);
  assert(B.dropEffect === 'move', `dropEffect is "move" (got "${B.dropEffect}")`);
  assert(B.prompt === 'Stash how many?', `quantity prompt asked first (got "${B.prompt}")`);
  assert(B.createdOnTarget === true, `item created on ${setup.groupName} (via ${B.dropTarget})`);
  assert(B.createdQty === 3, `quantity preserved (got ${B.createdQty})`);
  assert(B.sourceRetained === false, `source DELETED from ${setup.aName} — true move`);

  // --- C. group -> member: MOVE back ----------------------------------------------------------
  console.log('# probe C — group -> member (expect move)');
  const C = await f.evaluate(PROBE, {
    sourceId: setup.groupId,
    itemId: B.createdId,
    targetId: setup.aId,
    ctrl: false,
    tag: TAG,
  });
  if (C.error) console.log('  probe error:', C.error);
  assert(C.dropEffect === 'move', `dropEffect is "move" (got "${C.dropEffect}")`);
  assert(C.prompt === 'Take how many?', `quantity prompt asked first (got "${C.prompt}")`);
  assert(C.createdOnTarget === true, `item back on ${setup.aName} (via ${C.dropTarget})`);
  assert(C.sourceRetained === false, `source DELETED from ${setup.groupName} — true move`);

  // --- D. Ctrl-drag member -> group: forced COPY ----------------------------------------------
  console.log('# probe D — member -> group with Ctrl (expect forced copy)');
  const D = await f.evaluate(PROBE, {
    sourceId: setup.aId,
    itemId: C.createdId,
    targetId: setup.groupId,
    ctrl: true,
    tag: TAG,
  });
  if (D.error) console.log('  probe error:', D.error);
  assert(D.dropEffect === 'copy', `dropEffect is "copy" (got "${D.dropEffect}")`);
  assert(D.prompt === undefined, 'no prompt — a forced copy stays stock behavior');
  assert(D.createdOnTarget === true, `copy created on ${setup.groupName}`);
  assert(D.sourceRetained === true, `source retained on ${setup.aName} — Ctrl still copies`);

  // --- v1.6 stacks: split drag, Take button, Stash button -------------------------------------
  // State entering F: the member holds C's stack of 3, the group holds D's copy of 3.
  const stackIds = [setup.aId, setup.groupId];

  console.log('# probe F — member -> group, split 1 of 3 (expect split)');
  const F = await f.evaluate(PROBE, {
    sourceId: setup.aId,
    itemId: C.createdId,
    targetId: setup.groupId,
    ctrl: false,
    tag: TAG,
    split: 1,
  });
  if (F.error) console.log('  probe error:', F.error);
  assert(F.prompt === 'Stash how many?', `quantity prompt asked (got "${F.prompt}")`);
  assert(F.createdQty === 1, `1 landed on ${setup.groupName} (got ${F.createdQty})`);
  assert(F.sourceQty === 2, `2 stayed on ${setup.aName} (got ${F.sourceQty})`);

  console.log('# probe G — Take button on the group row, take 1 of 3');
  const beforeG = await f.evaluate(STACKS, { ids: stackIds, tag: TAG });
  const G = await f.evaluate(BUTTON_PROBE, {
    actorId: setup.groupId,
    itemId: D.createdId,
    button: 'partystash-take-button',
    partnerId: setup.aId,
    qty: 1,
  });
  if (G.error) console.log('  probe error:', G.error);
  const afterG = await f.evaluate(STACKS, { ids: stackIds, tag: TAG });
  const gNew = afterG[setup.aId].filter(s => !beforeG[setup.aId].some(b => b.id === s.id));
  assert(G.buttonPresent === true, 'Take column rendered on the group inventory row');
  assert(G.prompt === `Take from ${setup.groupName}`, `take prompt asked (got "${G.prompt}")`);
  assert(gNew.length === 1 && gNew[0].qty === 1, `1 taken to ${setup.aName}`);
  assert(
    afterG[setup.groupId].find(s => s.id === D.createdId)?.qty === 2,
    `the group's stack went 3 -> 2`
  );

  console.log('# probe H — Stash button on the member row, stash the single item');
  const H = await f.evaluate(BUTTON_PROBE, {
    actorId: setup.aId,
    itemId: gNew[0]?.id,
    button: 'partystash-stash-button',
    partnerId: setup.groupId,
  });
  if (H.error) console.log('  probe error:', H.error);
  const afterH = await f.evaluate(STACKS, { ids: stackIds, tag: TAG });
  const hNew = afterH[setup.groupId].filter(s => !afterG[setup.groupId].some(b => b.id === s.id));
  assert(H.buttonPresent === true, 'Stash column rendered on the member character sheet');
  assert(H.prompt === `Stash in ${setup.groupName}`, `stash confirmation asked (got "${H.prompt}")`);
  assert(!afterH[setup.aId].some(s => s.id === gNew[0]?.id), `item left ${setup.aName}`);
  assert(hNew.length === 1 && hNew[0].qty === 1, `item arrived in ${setup.groupName}`);

  // --- E. player context: half-owned drag must be BLOCKED (v1.1.0) ---------------------------
  // A temp PLAYER user with OBSERVER on a member drags that member's item into the stash
  // (owns the group via its default ownership, NOT the member) — expect drop behavior "none",
  // nothing created, source intact, warning shown. This is the live report from 2026-08-07:
  // stock dnd5e would copy into the stash and strand a dupe when the source delete is refused.
  console.log('# probe E — observer-owned source, player client (expect block)');
  const TEMP_USER = 'ZZ-PSTASH Player';
  const eSetup = await f.evaluate(
    async ({ tag, bId, groupId, userName }) => {
      const member = game.actors.get(bId);
      let user =
        game.users.find(u => u.name === userName) ??
        (await User.implementation.create({ name: userName, role: CONST.USER_ROLES.PLAYER }));
      await member.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER });
      const [item] = await member.createEmbeddedDocuments('Item', [
        { name: tag, type: 'loot', system: { quantity: 2 } },
      ]);
      // probe D legitimately left a Ctrl-copy on the group — count, don't assume empty
      const groupTagCount = game.actors.get(groupId).items.filter(i => i.name === tag).length;
      return { userId: user.id, itemId: item.id, groupTagCount };
    },
    { tag: TAG, bId: setup.bId, groupId: setup.groupId, userName: TEMP_USER }
  );

  const fp = new Foundry({ ...foundryConfig(env), user: TEMP_USER, password: '' });
  let E = { error: 'player bridge never connected' };
  try {
    await fp.connect();
    const who = await fp.evaluate(
      ({ bId }) => ({
        name: game.user.name,
        isGM: game.user.isGM,
        ownsMember: game.actors.get(bId)?.isOwner ?? null,
      }),
      { bId: setup.bId }
    );
    console.log(
      `  [player] joined as ${who.name} (GM=${who.isGM}, owns source member=${who.ownsMember})`
    );
    E = await fp.evaluate(PROBE, {
      sourceId: setup.bId,
      itemId: eSetup.itemId,
      targetId: setup.groupId,
      ctrl: false,
      tag: TAG,
    });
  } finally {
    await fp.dispose();
  }
  if (E.error) console.log('  probe error:', E.error);
  assert(E.dropEffect === 'none', `dropEffect is "none" (got "${E.dropEffect}")`);
  assert(E.createdOnTarget === false, 'nothing created on the group — no stranded dupe');
  assert(E.sourceRetained === true, `source intact on ${setup.bName}`);
  assert(
    (E.notifications ?? []).some(n => /Party Stash/i.test(n)),
    'warning toast shown to the player'
  );

  // GM-side confirmation + temp-user cleanup
  const eAfter = await f.evaluate(
    async ({ bId, groupId, userId, itemId, tag }) => {
      const member = game.actors.get(bId);
      const groupTagCount = game.actors.get(groupId).items.filter(i => i.name === tag).length;
      const onMember = member.items.some(i => i.id === itemId);
      await member.deleteEmbeddedDocuments(
        'Item',
        member.items.filter(i => i.name === tag).map(i => i.id)
      );
      // Revoke by rewriting the ownership object: `{"ownership.-=<id>": null}` silently no-ops
      // on this field, and past runs of this script each left an OBSERVER entry pointing at a
      // deleted user (found 2026-08-12, see scripts/clean-stale-ownership.mjs).
      const next = {};
      for (const [uid, level] of Object.entries(member.ownership ?? {})) {
        if (uid !== userId) next[uid] = level;
      }
      await member.update({ ownership: next }, { diff: false, recursive: false });
      const ownershipResidue = userId in (game.actors.get(bId)?.ownership ?? {});
      await game.users.get(userId)?.delete();
      return { groupTagCount, onMember, ownershipResidue };
    },
    {
      bId: setup.bId,
      groupId: setup.groupId,
      userId: eSetup.userId,
      itemId: eSetup.itemId,
      tag: TAG,
    }
  );
  assert(
    eAfter.groupTagCount === eSetup.groupTagCount,
    `GM view agrees: group inventory unchanged (${eAfter.groupTagCount} = ${eSetup.groupTagCount} fixture items)`
  );
  assert(eAfter.onMember === true, 'GM view agrees: member kept the item');
  assert(eAfter.ownershipResidue === false, 'temp player ownership fully revoked');

  // --- I. Give button: a hand-off through the stash, two PLAYER clients (v1.7) ---------------
  // A giver user owns member A, a taker user owns member B, neither owns the other — the real
  // table shape, where no client can write onto the recipient directly. The giver presses Give
  // on A's row: the item goes through the group marked for the taker's user, whose client
  // moves it onto B and deletes the stash row; one "gave" receipt. Then the stall: the taker's
  // client is made unable to credit (its actor's createEmbeddedDocuments throws), so the
  // giver's timeout takes the gift back with the error. Last, with the taker gone, Give has
  // nobody to offer and says so instead of opening a prompt.
  console.log('# probe I — Give button, hand-off through the stash (two player clients)');
  const GIVER = 'ZZ-PSTASH Giver';
  const TAKER = 'ZZ-PSTASH Player';
  const TAGGED = ({ aId, bId, groupId, tag }) => {
    const rows = id =>
      game.actors
        .get(id)
        .items.filter(i => i.name === tag)
        .map(i => ({
          id: i.id,
          qty: i.system.quantity,
          marked: !!i.getFlag('fvtt-mod-partystash', 'giveTo'),
        }));
    const receipts = game.messages.filter(m => /gave/.test(m.content) && m.content.includes(tag));
    return {
      a: rows(aId),
      b: rows(bId),
      group: rows(groupId),
      receipts: receipts.length,
      lastReceipt: receipts.at(-1)?.content ?? null,
    };
  };
  const iArgs = { aId: setup.aId, bId: setup.bId, groupId: setup.groupId, tag: TAG };
  const iSetup = await f.evaluate(
    async ({ aId, bId, groupId, tag, giver, taker }) => {
      const mk = async name =>
        game.users.find(u => u.name === name) ??
        (await User.implementation.create({ name, role: CONST.USER_ROLES.PLAYER }));
      const g = await mk(giver);
      const t = await mk(taker);
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      await game.actors.get(aId).update({ [`ownership.${g.id}`]: OWNER });
      await game.actors.get(bId).update({ [`ownership.${t.id}`]: OWNER });
      const group = game.actors.get(groupId);
      const grant = {};
      for (const u of [g, t]) {
        if (!group.testUserPermission(u, 'OWNER')) grant[`ownership.${u.id}`] = OWNER;
      }
      if (Object.keys(grant).length) await group.update(grant);
      for (const id of [aId, bId, groupId]) {
        const a = game.actors.get(id);
        const stale = a.items.filter(i => i.name === tag).map(i => i.id);
        if (stale.length) await a.deleteEmbeddedDocuments('Item', stale);
      }
      const [item] = await game.actors.get(aId).createEmbeddedDocuments('Item', [
        { name: tag, type: 'loot', system: { quantity: 3 } },
      ]);
      return {
        giverId: g.id,
        takerId: t.id,
        itemId: item.id,
        groupGranted: Object.keys(grant).map(k => k.split('.')[1]),
      };
    },
    { ...iArgs, giver: GIVER, taker: TAKER }
  );
  const iBefore = await f.evaluate(TAGGED, iArgs);

  const fg = new Foundry({ ...foundryConfig(env), user: GIVER, password: '' });
  const ft = new Foundry({ ...foundryConfig(env), user: TAKER, password: '' });
  let I1 = { error: 'giver bridge never connected' };
  let I2 = {};
  let I3 = {};
  let iAfter1 = {};
  let iAfter2 = {};
  try {
    await fg.connect();
    await ft.connect();
    // A fresh bridge page spends ~15s warming compendium indexes and drains no socket traffic
    // until it is done; after that it still applies a broadcast 1.5–4s late (measured
    // 2026-10-01). A live browser does this in milliseconds, so the waits below are the
    // harness's, not the module's.
    await sleep(16000);
    const who = await fg.evaluate(
      ({ aId, bId, takerId }) => ({
        ownsA: game.actors.get(aId)?.isOwner ?? null,
        ownsB: game.actors.get(bId)?.isOwner ?? null,
        takerActive: game.users.get(takerId)?.active ?? null,
      }),
      { aId: setup.aId, bId: setup.bId, takerId: iSetup.takerId }
    );
    console.log(
      `  [giver] owns A=${who.ownsA}, owns B=${who.ownsB}, taker online=${who.takerActive}`
    );

    // I1: give 2 of 3 — the taker's client finishes the move (its latency is the harness's)
    I1 = await fg.evaluate(BUTTON_PROBE, {
      actorId: setup.aId,
      itemId: iSetup.itemId,
      button: 'partystash-give-button',
      partnerId: setup.bId,
      qty: 2,
      settle: 6000,
    });
    await sleep(1000);
    iAfter1 = await f.evaluate(TAGGED, iArgs);

    // I2: the taker's client can't credit — the giver takes the gift back (GIVE_WAIT = 8s)
    await ft.evaluate(({ bId }) => {
      const b = game.actors.get(bId);
      b.createEmbeddedDocuments = async () => {
        throw new Error('probe: recipient client not answering');
      };
      return true;
    }, { bId: setup.bId });
    I2 = await fg.evaluate(BUTTON_PROBE, {
      actorId: setup.aId,
      itemId: iSetup.itemId,
      button: 'partystash-give-button',
      partnerId: setup.bId,
      settle: 11000,
    });
    await sleep(1000);
    iAfter2 = await f.evaluate(TAGGED, iArgs);

    // I3: nobody online — no prompt, a warning
    await ft.dispose();
    await sleep(3000);
    I3 = await fg.evaluate(BUTTON_PROBE, {
      actorId: setup.aId,
      itemId: iAfter2.a?.[0]?.id,
      button: 'partystash-give-button',
    });
  } finally {
    await fg.dispose().catch(() => {});
    await ft.dispose().catch(() => {});
  }
  if (I1.error) console.log('  probe error:', I1.error);
  assert(I1.buttonPresent === true, 'Give button rendered on the member row (player client)');
  assert(I1.prompt === `Give ${TAG}`, `give prompt asked (got "${I1.prompt}")`);
  assert(
    iAfter1.a?.length === 1 && iAfter1.a[0].qty === 1,
    `giver's stack went 3 -> 1 (got ${JSON.stringify(iAfter1.a)})`
  );
  assert(
    iAfter1.b?.length === 1 && iAfter1.b[0].qty === 2 && !iAfter1.b[0].marked,
    `2 arrived on ${setup.bName}, unmarked (got ${JSON.stringify(iAfter1.b)})`
  );
  assert(iAfter1.group?.length === 0, 'nothing left in the stash — the hand-off cleared its row');
  assert(
    iAfter1.receipts === iBefore.receipts + 1 && /gave 2 ×/.test(iAfter1.lastReceipt ?? ''),
    `exactly one "gave" receipt (${iBefore.receipts} -> ${iAfter1.receipts}): ${iAfter1.lastReceipt}`
  );
  assert(
    (I1.notifications ?? []).some(n => /Gave 2 ×/.test(n)),
    `giver told "Gave 2 × …" (${(I1.notifications ?? []).join(' | ')})`
  );

  if (I2.error) console.log('  probe error:', I2.error);
  assert(
    iAfter2.a?.length === 1 && iAfter2.a[0].qty === 1 && !iAfter2.a[0].marked,
    `the stalled gift came back to ${setup.aName} (got ${JSON.stringify(iAfter2.a)})`
  );
  assert(iAfter2.group?.length === 0, 'nothing left in the stash after the take-back');
  assert(
    iAfter2.b?.length === 1 && iAfter2.b[0].qty === 2,
    `${setup.bName} unchanged by the stall (got ${JSON.stringify(iAfter2.b)})`
  );
  assert(iAfter2.receipts === iAfter1.receipts, 'no receipt for a gift that came back');
  assert(
    (I2.notifications ?? []).some(n => /problem finding/.test(n)),
    `giver got the "problem finding …" error (${(I2.notifications ?? []).join(' | ')})`
  );

  if (I3.error) console.log('  probe error:', I3.error);
  assert(I3.prompt === null, `no prompt with nobody online (got "${I3.prompt}")`);
  assert(
    (I3.notifications ?? []).some(n => /no party members to give to/.test(n)),
    `giver told nobody is online (${(I3.notifications ?? []).join(' | ')})`
  );

  // temp users and grants out again
  const iClean = await f.evaluate(
    async ({ aId, bId, groupId, giverId, takerId, groupGranted }) => {
      const strip = async (actor, ids) => {
        const next = {};
        for (const [uid, level] of Object.entries(actor.ownership ?? {})) {
          if (!ids.includes(uid)) next[uid] = level;
        }
        await actor.update({ ownership: next }, { diff: false, recursive: false });
      };
      await strip(game.actors.get(aId), [giverId]);
      await strip(game.actors.get(bId), [takerId]);
      if (groupGranted.length) await strip(game.actors.get(groupId), groupGranted);
      for (const id of [giverId, takerId]) await game.users.get(id)?.delete();
      const residue = [aId, bId, groupId].some(id =>
        [giverId, takerId].some(u => u in (game.actors.get(id)?.ownership ?? {}))
      );
      return { residue, usersLeft: [giverId, takerId].filter(id => game.users.has(id)).length };
    },
    { ...iArgs, giverId: iSetup.giverId, takerId: iSetup.takerId, groupGranted: iSetup.groupGranted }
  );
  assert(iClean.residue === false && iClean.usersLeft === 0, 'temp giver/taker users and grants removed');

  // --- cleanup --------------------------------------------------------------------------------
  await f.evaluate(
    async ({ ids, tag }) => {
      for (const id of ids) {
        const a = game.actors.get(id);
        if (!a) continue;
        const doomed = a.items.filter(i => i.name === tag).map(i => i.id);
        if (doomed.length) await a.deleteEmbeddedDocuments('Item', doomed);
      }
    },
    { ids: [setup.aId, setup.bId, setup.groupId], tag: TAG }
  );
  console.log('# fixture cleaned up');
} catch (e) {
  console.error('[pstash] ERROR:', e?.message || e);
  fails++;
} finally {
  await f.dispose();
  console.log(
    fails === 0
      ? '\nVERDICT: BEHAVIOR-OK (all probes passed)'
      : `\nVERDICT: FAILED (${fails} failing assertion${fails === 1 ? '' : 's'})`
  );
  process.exit(fails === 0 ? 0 : 1);
}
