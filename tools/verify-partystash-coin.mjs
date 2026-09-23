// E2E verification for fvtt-mod-partystash v1.3 — the deposit/withdraw coin window.
//
// Drives the REAL affordance: renders the group sheet, clicks the injected Deposit/Withdraw
// buttons, fills the dialog's denomination boxes and clicks its submit button, so the render
// hook, the dialog's render callback, the clamping and `moveCoin` all execute exactly as they
// do for a player. Asserts:
//
//   A. injection      : both buttons on the group sheet's currency row (GM view)
//   B. GM escape hatch: GM keeps editable purse fields AND the system's currency button
//   C. deposit        : member -> stash, DENOMINATION-PRESERVING (2 pp arrives as 2 pp)
//   D. caps           : each box is capped at what the source's purse can AFFORD (v1.5)
//   E. withdraw       : stash -> member, denomination-preserving
//   F. receipt        : the whisper names the member and the direction
//   G. player view    : purse fields read-only, system currency button GONE, buttons present
//
// Purses are snapshotted and restored, including on failure. Run: node tools/verify-partystash-coin.mjs
import { Foundry, foundryConfig, loadEnv } from 'fvtt-mcp-dnd5e/client';

const env = loadEnv();

const MODULE_ID = 'fvtt-mod-partystash';
const TEMP_USER = 'ZZ-PSTASH Coin Player';

const mkFoundry = (user, password) =>
  new Foundry(user ? { ...foundryConfig(env), user, password: password ?? '' } : foundryConfig(env));

let fails = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Open the group sheet on its inventory tab and describe the injected coin row. */
const INSPECT = async ({ groupId }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const group = game.actors.get(groupId);
  const sheet = group.sheet;
  await sheet.render({ force: true });
  await sleep(1800);
  const root = sheet.element;
  const tab = root.querySelector('nav [data-tab="inventory"], .tabs [data-tab="inventory"]');
  if (tab) {
    tab.click();
    await sleep(900);
  }
  const section = root.querySelector('section.currency');
  const out = {
    isGM: game.user.isGM,
    userName: game.user.name,
    hasSection: !!section,
    coinWrap: !!section?.querySelector('.partystash-coin'),
    buttons: [...(section?.querySelectorAll('.partystash-coin-button') ?? [])].map(b => ({
      dir: b.dataset.direction,
      text: b.textContent.trim(),
    })),
    nativeCurrencyButton: !!section?.querySelector('[data-action="currency"]'),
    purseInputs: [...(section?.querySelectorAll('input[name^="system.currency"]') ?? [])].map(
      i => ({
        name: i.name,
        readOnly: i.readOnly,
        locked: i.classList.contains('partystash-locked'),
      })
    ),
    // Did the manifest-declared stylesheet actually load? (process-boot lag check)
    styleSheetLoaded: [...document.styleSheets].some(s => (s.href ?? '').includes('partystash')),
    styleLinkPresent: !!document.querySelector('link[href*="partystash"]'),
  };
  await sheet.close();
  return out;
};

/**
 * Click a coin button, fill the dialog, submit. Returns what the dialog offered (maxes) and
 * the purses either side of the move, so the caller can assert on both the UI and the effect.
 */
const MOVE = async ({ groupId, partnerId, dir, amounts }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { dir };
  try {
    const group = game.actors.get(groupId);
    const partner = game.actors.get(partnerId);
    const sheet = group.sheet;
    await sheet.render({ force: true });
    await sleep(1600);
    const root = sheet.element;
    const tab = root.querySelector('nav [data-tab="inventory"], .tabs [data-tab="inventory"]');
    if (tab) {
      tab.click();
      await sleep(800);
    }
    const button = root.querySelector(`.partystash-coin-button[data-direction="${dir}"]`);
    if (!button) return { ...out, error: `no ${dir} button` };

    out.groupBefore = { ...group.system.currency };
    out.partnerBefore = { ...partner.system.currency };
    // Watermark the chat log so we count only THIS transfer's receipts.
    const mark = Date.now();
    // How many live sessions share this user id — two would double every receipt, since each
    // client posts for its own gestures.
    out.sameUserSessions = game.users.filter(u => u.active && u.id === game.user.id).length;

    button.click();
    // Wait for the dialog to exist and its render callback to have run.
    let dialog = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !dialog) {
      await sleep(200);
      dialog = document.querySelector('.partystash-dialog');
    }
    if (!dialog) return { ...out, error: 'dialog never appeared' };
    await sleep(500);
    const form = dialog.querySelector('form') ?? dialog;

    // What the dialog is offering: the per-denomination caps and the availability line.
    out.maxes = {};
    out.disabled = {};
    for (const d of ['pp', 'gp', 'ep', 'sp', 'cp']) {
      const input = form.elements[d];
      out.maxes[d] = input ? Number(input.max) : null;
      out.disabled[d] = input ? !!input.disabled : null;
    }
    out.availText = form.querySelector('.partystash-avail')?.textContent ?? null;
    out.allNote = form.querySelector('.partystash-all-note')?.textContent ?? null;
    out.hasPartnerSelect = !!form.querySelector('select[name="partner"]');

    // Pick the partner if the dialog offered a choice.
    const select = form.elements.partner;
    if (select && select.tagName === 'SELECT') {
      select.value = partnerId;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      out.maxesAfterPartner = {};
      for (const d of ['pp', 'gp', 'ep', 'sp', 'cp']) {
        out.maxesAfterPartner[d] = form.elements[d] ? Number(form.elements[d].max) : null;
      }
    }

    // Fill the boxes. Deliberately includes an OVER-CAP value when the caller passes one, to
    // prove the change-listener clamps it.
    for (const [d, v] of Object.entries(amounts)) {
      const input = form.elements[d];
      if (!input) continue;
      input.value = String(v);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(300);
    out.valuesAfterClamp = {};
    for (const d of ['pp', 'gp', 'ep', 'sp', 'cp']) {
      out.valuesAfterClamp[d] = form.elements[d] ? Number(form.elements[d].value) : null;
    }

    const submit = dialog.querySelector('button[data-action="go"]');
    if (!submit) return { ...out, error: 'no submit button' };
    submit.click();

    // Wait for both updates to land.
    const after = Date.now() + 10000;
    while (Date.now() < after) {
      await sleep(300);
      if (!document.querySelector('.partystash-dialog')) break;
    }
    await sleep(1500);

    out.groupAfter = { ...game.actors.get(groupId).system.currency };
    out.partnerAfter = { ...game.actors.get(partnerId).system.currency };
    out.notifications = [
      ...document.querySelectorAll('#notifications .notification, .notification'),
    ].map(n => n.textContent.trim().slice(0, 160));
    // Every Party Stash receipt posted since the click — content, and who can see it.
    const mine = [...game.messages].filter(
      m => m.timestamp >= mark && m.speaker?.alias === 'Party Stash'
    );
    out.receipts = mine.map(m => m.content);
    out.receiptCount = mine.length;
    out.receiptWhispers = mine.map(m => (m.whisper ?? []).length);
    // Split public (current code) from whispered (a stale session still running a pre-1.3
    // script — leaked Playwright pages from earlier runs, not the module under test).
    const open = mine.filter(m => (m.whisper ?? []).length === 0);
    out.publicReceipts = open.map(m => m.content);
    out.publicReceiptCount = open.length;
    out.legacyWhisperCount = mine.length - open.length;
    out.receiptAuthors = open.map(m => game.users.get(m.author?.id ?? m.author)?.name ?? '?');

    await game.actors.get(groupId).sheet.close();
    return out;
  } catch (err) {
    return { ...out, error: String(err?.stack || err) };
  }
};

let f = mkFoundry();
let snapshot = null;
try {
  console.log('[coin] connecting…');
  await f.connect();

  // --- 0. module state -------------------------------------------------------------------------
  const mod = await f.evaluate(id => {
    const m = game.modules.get(id);
    return {
      present: !!m,
      active: !!m?.active,
      version: m?.version,
      hookInstalled: (Hooks.events?.renderGroupActorSheet ?? []).length,
      coinSetting: (() => {
        try {
          return game.settings.get(id, 'coin');
        } catch {
          return 'unregistered';
        }
      })(),
    };
  }, MODULE_ID);
  console.log('# module');
  console.log(`  vended version: ${mod.version} (1.2.0 here is the known process-boot lag)`);
  assert(mod.active, 'module active');
  assert(mod.coinSetting === true, `"coin" setting registered and on (got ${mod.coinSetting})`);

  // --- fixture: known purses -------------------------------------------------------------------
  const setup = await f.evaluate(async () => {
    const group =
      game.actors.find(a => a.type === 'group' && a.name === 'The Party') ??
      game.actors.find(a => a.type === 'group');
    if (!group) return { error: 'no group actor' };
    const members = group.system.members.map(m => m.actor).filter(a => a?.type === 'character');
    if (!members.length) return { error: 'no character members' };
    const partner = members[0];
    const snap = {
      groupId: group.id,
      groupName: group.name,
      partnerId: partner.id,
      partnerName: partner.name,
      group: { ...group.system.currency },
      partner: { ...partner.system.currency },
      memberCount: members.length,
    };
    // Deliberately lopsided and platinum-bearing: platinum is how we prove no re-denomination.
    await partner.update({ 'system.currency': { pp: 2, gp: 5, ep: 0, sp: 3, cp: 7 } });
    await group.update({ 'system.currency': { pp: 0, gp: 40, ep: 0, sp: 0, cp: 0 } });
    return snap;
  }, null);
  if (setup.error) throw new Error(setup.error);
  snapshot = setup;
  console.log(
    `# fixture: ${setup.partnerName} = 2pp 5gp 3sp 7cp; ${setup.groupName} = 40gp ` +
      `(${setup.memberCount} members)`
  );

  // --- A/B. GM view ----------------------------------------------------------------------------
  console.log('# A/B — injection + GM escape hatch');
  const gmView = await f.evaluate(INSPECT, { groupId: setup.groupId });
  assert(gmView.coinWrap, 'coin button row injected into section.currency');
  assert(
    gmView.buttons.length === 2 &&
      gmView.buttons.some(b => b.dir === 'deposit') &&
      gmView.buttons.some(b => b.dir === 'withdraw'),
    `both buttons present (${gmView.buttons.map(b => b.text).join(', ') || 'none'})`
  );
  assert(
    gmView.purseInputs.length === 5 && gmView.purseInputs.every(i => !i.readOnly),
    'GM purse fields stay editable'
  );
  assert(gmView.nativeCurrencyButton, "GM keeps dnd5e's own currency-manager button");
  console.log(
    `  [note] manifest stylesheet loaded: ${gmView.styleSheetLoaded} ` +
      `(link tag: ${gmView.styleLinkPresent})`
  );

  // --- C/D. deposit ----------------------------------------------------------------------------
  console.log('# C/D — deposit (denomination-preserving, capped)');
  const dep = await f.evaluate(MOVE, {
    groupId: setup.groupId,
    partnerId: setup.partnerId,
    dir: 'deposit',
    // gp is deliberately over budget: once 2 pp is spoken for, the purse affords only 5 gp more
    amounts: { pp: 2, gp: 99, sp: 0, cp: 0 },
  });
  if (dep.error) console.log('  probe error:', dep.error);
  // Since v1.5 each box is capped by what the purse's total VALUE affords (2537 cp here), not by
  // the loose coins held — asking for coin the member doesn't hold loose makes change.
  assert(
    eq(dep.maxes, { pp: 2, gp: 25, ep: 50, sp: 253, cp: 2537 }),
    `boxes capped at what the member's purse affords (got ${JSON.stringify(dep.maxes)})`
  );
  assert(
    dep.disabled?.ep === false,
    'electrum stays open though the member holds none — change can be made'
  );
  assert(
    dep.valuesAfterClamp?.gp === 5,
    `over-cap entry clamped to 5 (got ${dep.valuesAfterClamp?.gp})`
  );
  assert(
    eq(dep.groupAfter, { pp: 2, gp: 45, ep: 0, sp: 0, cp: 0 }),
    `stash gained 2 pp + 5 gp AS PLATINUM AND GOLD (got ${JSON.stringify(dep.groupAfter)})`
  );
  assert(
    eq(dep.partnerAfter, { pp: 0, gp: 0, ep: 0, sp: 3, cp: 7 }),
    `member debited exactly (got ${JSON.stringify(dep.partnerAfter)})`
  );

  // --- F. receipt ------------------------------------------------------------------------------
  console.log('# F — receipt');
  if (dep.legacyWhisperCount) {
    console.log(
      `  [note] ${dep.legacyWhisperCount} whispered receipt(s) also appeared — stale browser ` +
        'sessions still running a pre-1.3 script, not the module under test'
    );
  }
  const depositReceipt = (dep.publicReceipts ?? []).find(r => /deposited/i.test(r));
  assert(!!depositReceipt, 'a deposit receipt was posted');
  // One transfer, one line, visible to the table. A shared options object used to leak the
  // group's before-image into the member's update and post a second, nonsensical
  // "X deposited … into X"; multiple sessions per user used to post one copy each.
  assert(
    dep.publicReceiptCount === 1,
    `exactly one PUBLIC receipt per transfer (got ${dep.publicReceiptCount}): ` +
      `${(dep.publicReceipts ?? []).map(r => r.replace(/<[^>]+>/g, '')).join(' | ')}`
  );
  assert(
    !(dep.publicReceipts ?? []).some(r => {
      const t = r.replace(/<[^>]+>/g, '');
      return /deposited .* into/.test(t) && !/into The Party/.test(t);
    }),
    'no receipt claims a member deposited into themselves'
  );
  assert(
    !!depositReceipt && depositReceipt.includes(setup.partnerName),
    `receipt names the member (${depositReceipt?.replace(/<[^>]+>/g, '') ?? 'none'})`
  );
  assert(
    !!depositReceipt && /2 pp/.test(depositReceipt),
    'receipt reports the coins as moved, not re-denominated'
  );

  // --- E. withdraw -----------------------------------------------------------------------------
  console.log('# E — withdraw');
  const wd = await f.evaluate(MOVE, {
    groupId: setup.groupId,
    partnerId: setup.partnerId,
    dir: 'withdraw',
    amounts: { pp: 1, gp: 10, sp: 0, cp: 0 },
  });
  if (wd.error) console.log('  probe error:', wd.error);
  assert(
    eq(wd.maxes, { pp: 6, gp: 65, ep: 130, sp: 650, cp: 6500 }), // 2 pp 45 gp = 6500 cp
    `withdraw boxes capped at what the STASH purse affords (got ${JSON.stringify(wd.maxes)})`
  );
  assert(
    eq(wd.groupAfter, { pp: 1, gp: 35, ep: 0, sp: 0, cp: 0 }),
    `stash debited 1 pp + 10 gp (got ${JSON.stringify(wd.groupAfter)})`
  );
  assert(
    eq(wd.partnerAfter, { pp: 1, gp: 10, ep: 0, sp: 3, cp: 7 }),
    `member credited in the same coins (got ${JSON.stringify(wd.partnerAfter)})`
  );
  const wdReceipt = (wd.publicReceipts ?? []).find(r => /withdrew/i.test(r));
  assert(
    !!wdReceipt,
    `a withdraw receipt was posted (${wdReceipt?.replace(/<[^>]+>/g, '') ?? 'none'})`
  );
  assert(
    wd.publicReceiptCount === 1,
    `exactly one public withdraw receipt (got ${wd.publicReceiptCount})`
  );
  assert(
    setup.memberCount > 1 ? wd.hasPartnerSelect : true,
    'a multi-member group offers a partner picker'
  );

  // --- G. player view --------------------------------------------------------------------------
  console.log('# G — player view (read-only purse, no system currency button)');
  const pSetup = await f.evaluate(
    async ({ groupId, partnerId, userName }) => {
      const user =
        game.users.find(u => u.name === userName) ??
        (await User.implementation.create({ name: userName, role: CONST.USER_ROLES.PLAYER }));
      const group = game.actors.get(groupId);
      const partner = game.actors.get(partnerId);
      await group.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
      await partner.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
      return { userId: user.id };
    },
    { groupId: setup.groupId, partnerId: setup.partnerId, userName: TEMP_USER }
  );

  const fp = mkFoundry(TEMP_USER, '');
  let playerView = { error: 'player bridge never connected' };
  let playerMove = null;
  try {
    await fp.connect();
    playerView = await fp.evaluate(INSPECT, { groupId: setup.groupId });
    // Give the player something to deposit, then have them do it through the real dialog.
    await f.evaluate(
      async ({ partnerId }) => {
        await game.actors.get(partnerId).update({
          'system.currency': { pp: 0, gp: 6, ep: 0, sp: 0, cp: 0 },
        });
      },
      { partnerId: setup.partnerId }
    );
    await sleep(1200);
    playerMove = await fp.evaluate(MOVE, {
      groupId: setup.groupId,
      partnerId: setup.partnerId,
      dir: 'deposit',
      amounts: { pp: 0, gp: 6, sp: 0, cp: 0 },
    });
    if (playerMove && !playerMove.error) {
      const before = playerMove.groupBefore ?? {};
      playerMove.expectedGroupAfter = {
        pp: before.pp ?? 0,
        gp: (before.gp ?? 0) + 6,
        ep: before.ep ?? 0,
        sp: before.sp ?? 0,
        cp: before.cp ?? 0,
      };
    }
  } catch (err) {
    playerView = { error: String(err?.message || err) };
  } finally {
    await fp.dispose();
  }
  if (playerView.error) console.log('  probe error:', playerView.error);
  assert(playerView.isGM === false, `joined as a player (${playerView.userName})`);
  if (playerMove && !playerMove.error) {
    // H. A PLAYER moves the coin end to end through the real dialog: the transfer lands with
    // no GM proxy, and their own client posts exactly one public receipt authored by them.
    // This is the case that killed the GM-elect experiment (see shouldPostReceipt) — worth a
    // standing probe, because a rule that logs nothing when the GM is away looks fine until
    // the one session where it isn't.
    console.log('# H — player-initiated transfer, logged publicly under the player');
    assert(
      eq(playerMove.groupAfter, playerMove.expectedGroupAfter),
      `player's deposit landed (${JSON.stringify(playerMove.groupAfter)})`
    );
    assert(
      playerMove.publicReceiptCount === 1,
      `exactly one public receipt for the player's transfer (got ` +
        `${playerMove.publicReceiptCount}): ${(playerMove.publicReceipts ?? [])
          .map(r => r.replace(/<[^>]+>/g, ''))
          .join(' | ')}`
    );
    assert(
      (playerMove.receiptAuthors ?? []).includes(TEMP_USER),
      `receipt is authored by the acting player (got ${JSON.stringify(playerMove.receiptAuthors)})`
    );
  } else if (playerMove?.error) {
    console.log('  probe error (player move):', playerMove.error);
    fails++;
  }
  assert(playerView.coinWrap === true, 'player sees the Deposit/Withdraw buttons');
  assert(
    playerView.purseInputs?.length === 5 && playerView.purseInputs.every(i => i.readOnly),
    'player purse fields are READ-ONLY'
  );
  assert(
    playerView.nativeCurrencyButton === false,
    "dnd5e's currency-manager button is removed for players"
  );

  // Revoke by REWRITING the ownership object. `{"ownership.-=<id>": null}` silently no-ops on
  // this field — six runs of this script each left an OWNER entry pointing at a deleted user
  // before that was caught (see tools/clean-stale-ownership.mjs).
  const leftover = await f.evaluate(
    async ({ groupId, partnerId, userId }) => {
      for (const id of [groupId, partnerId]) {
        const actor = game.actors.get(id);
        if (!actor) continue;
        const next = {};
        for (const [uid, level] of Object.entries(actor.ownership ?? {})) {
          if (uid !== userId) next[uid] = level;
        }
        await actor.update({ ownership: next }, { diff: false, recursive: false });
      }
      await game.users.get(userId)?.delete();
      return [groupId, partnerId].filter(id => userId in (game.actors.get(id)?.ownership ?? {}));
    },
    { groupId: setup.groupId, partnerId: setup.partnerId, userId: pSetup.userId }
  );
  assert(leftover.length === 0, 'temp player ownership fully revoked (no residue left behind)');
} catch (e) {
  console.error('[coin] ERROR:', e?.message || e);
  fails++;
} finally {
  if (snapshot) {
    try {
      await f.evaluate(async ({ groupId, partnerId, group, partner }) => {
        await game.actors.get(groupId)?.update({ 'system.currency': group });
        await game.actors.get(partnerId)?.update({ 'system.currency': partner });
      }, snapshot);
      console.log('# purses restored to their pre-test values');
    } catch (err) {
      console.error('[coin] WARNING: purse restore failed —', err?.message || err);
    }
  }
  await f.dispose();
  console.log(
    fails === 0
      ? '\nVERDICT: BEHAVIOR-OK (all probes passed)'
      : `\nVERDICT: FAILED (${fails} failing assertion${fails === 1 ? '' : 's'})`
  );
  process.exit(fails === 0 ? 0 : 1);
}
