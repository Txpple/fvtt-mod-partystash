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

/** One synthetic drag probe, fully inside the page. Single-arg evaluate (bridge rule). */
const PROBE = async ({ sourceId, itemId, targetId, ctrl, tag }) => {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
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

    let created = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !created) {
      await sleep(300);
      created = target.items.find(i => !beforeTgt.has(i.id) && i.name === tag) ?? null;
    }
    await sleep(800); // let a trailing source delete land
    row.dispatchEvent(mk('dragend')); // clear DragDrop5e statics
    await sleep(150);

    out.createdOnTarget = !!created;
    out.createdId = created?.id ?? null;
    out.createdQty = created?.system?.quantity ?? null;
    out.sourceRetained = source.items.some(i => i.id === itemId);
    await sSheet.close();
    await tSheet.close();
    return out;
  } catch (err) {
    return { ...out, error: String(err?.stack || err) };
  }
};

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
  assert(D.createdOnTarget === true, `copy created on ${setup.groupName}`);
  assert(D.sourceRetained === true, `source retained on ${setup.aName} — Ctrl still copies`);

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
