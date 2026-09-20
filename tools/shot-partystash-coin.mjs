// Screenshot the group sheet's currency row for fvtt-mod-partystash v1.3 — the coin window
// was specified visually (an annotated screenshot), so it gets checked visually.
//
// Captures, as the GM and again as a temporary PLAYER:
//   1. the whole group sheet on its inventory tab,
//   2. a tight crop of the currency row (where the buttons live),
//   3. the deposit dialog, open.
// Also reports the buttons' COMPUTED styles, so "the CSS loaded" is asserted rather than eyeballed.
//
// Run: node tools/shot-partystash-coin.mjs   -> writes into scratch/partystash-coin/
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Foundry, foundryConfig, loadEnv } from 'fvtt-mcp-dnd5e/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();

const OUT = join(__dirname, '..', 'scratch', 'partystash-coin');
mkdirSync(OUT, { recursive: true });
const TEMP_USER = 'ZZ-PSTASH Shot Player';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mkFoundry = (user, password) =>
  new Foundry(user ? { ...foundryConfig(env), user, password: password ?? '' } : foundryConfig(env));

/** Open the group sheet on the inventory tab; report geometry + computed button styles. */
const STAGE = async ({ groupId, openDialog }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const group = game.actors.get(groupId);
  const sheet = group.sheet;
  await sheet.render({ force: true });
  await sleep(2000);
  sheet.setPosition({ width: 820, height: 760, left: 60, top: 40 });
  await sleep(500);
  const root = sheet.element;
  const tab = root.querySelector('nav [data-tab="inventory"], .tabs [data-tab="inventory"]');
  if (tab) {
    tab.click();
    await sleep(900);
  }
  const rect = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };
  const section = root.querySelector('section.currency');
  const button = section?.querySelector('.partystash-coin-button');
  const cs = button ? getComputedStyle(button) : null;

  const out = {
    isGM: game.user.isGM,
    userName: game.user.name,
    sheetRect: rect(root),
    currencyRect: rect(section),
    styleLoaded: !!document.querySelector('link[href*="partystash"]'),
    fallbackUsed: !!document.querySelector('link[data-partystash-fallback]'),
    buttonStyle: cs
      ? {
          display: cs.display,
          border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
          textTransform: cs.textTransform,
          padding: cs.paddingTop + ' ' + cs.paddingLeft,
          borderRadius: cs.borderTopLeftRadius,
        }
      : null,
    // Proof the CSS rules actually applied rather than the browser default.
    styled: !!cs && cs.textTransform === 'uppercase' && cs.borderTopStyle === 'solid',
  };

  if (openDialog) {
    root.querySelector('.partystash-coin-button[data-direction="deposit"]')?.click();
    await sleep(1400);
    const dialog = document.querySelector('.partystash-dialog');
    if (dialog) dialog.style.left = '900px';
    out.dialogRect = rect(dialog);
    out.dialogText = dialog?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? null;
  }
  return out;
};

const CLOSE = async ({ groupId }) => {
  document.querySelector('.partystash-dialog button[data-action="cancel"]')?.click();
  await new Promise(r => setTimeout(r, 500));
  await game.actors.get(groupId)?.sheet?.close();
};

async function shoot(f, label, groupId) {
  const info = await f.evaluate(STAGE, { groupId, openDialog: false });
  console.log(`\n[${label}] user=${info.userName} GM=${info.isGM}`);
  console.log(`  stylesheet link: ${info.styleLoaded} (fallback: ${info.fallbackUsed})`);
  console.log(`  button computed: ${JSON.stringify(info.buttonStyle)}`);
  console.log(`  CSS actually applied: ${info.styled}`);

  const page = f.page ?? f._page ?? null;
  if (!page) {
    console.log('  [warn] no page handle on the bridge — skipping image capture');
    return info;
  }
  await page.screenshot({ path: join(OUT, `${label}-sheet.png`), clip: info.sheetRect });
  if (info.currencyRect) {
    const c = info.currencyRect;
    await page.screenshot({
      path: join(OUT, `${label}-currency-row.png`),
      clip: { x: c.x - 8, y: c.y - 8, width: c.width + 16, height: c.height + 16 },
    });
  }
  const withDialog = await f.evaluate(STAGE, { groupId, openDialog: true });
  if (withDialog.dialogRect) {
    const d = withDialog.dialogRect;
    await page.screenshot({
      path: join(OUT, `${label}-dialog.png`),
      clip: { x: d.x - 6, y: d.y - 6, width: d.width + 12, height: d.height + 12 },
    });
    console.log(`  dialog: ${withDialog.dialogText}`);
  }
  await f.evaluate(CLOSE, { groupId });
  return { ...info, dialogText: withDialog.dialogText };
}

let f = mkFoundry();
const report = {};
try {
  await f.connect();
  const groupId = await f.evaluate(() => {
    const g =
      game.actors.find(a => a.type === 'group' && a.name === 'The Party') ??
      game.actors.find(a => a.type === 'group');
    return g?.id ?? null;
  }, null);
  if (!groupId) throw new Error('no group actor');

  report.gm = await shoot(f, 'gm', groupId);

  // --- player view ---------------------------------------------------------------------------
  const setup = await f.evaluate(
    async ({ groupId, userName }) => {
      const user =
        game.users.find(u => u.name === userName) ??
        (await User.implementation.create({ name: userName, role: CONST.USER_ROLES.PLAYER }));
      const group = game.actors.get(groupId);
      const member = group.system.members.map(m => m.actor).find(a => a?.type === 'character');
      await group.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
      await member.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
      return { userId: user.id, memberId: member.id };
    },
    { groupId, userName: TEMP_USER }
  );

  const fp = mkFoundry(TEMP_USER, '');
  try {
    await fp.connect();
    report.player = await shoot(fp, 'player', groupId);
  } finally {
    await fp.dispose();
  }

  // Rewrite the ownership object rather than using `{"ownership.-=<id>": null}`, which silently
  // no-ops here and leaves an entry pointing at the deleted user (see clean-stale-ownership.mjs).
  const leftover = await f.evaluate(
    async ({ groupId, memberId, userId }) => {
      for (const id of [groupId, memberId]) {
        const actor = game.actors.get(id);
        if (!actor) continue;
        const next = {};
        for (const [uid, level] of Object.entries(actor.ownership ?? {})) {
          if (uid !== userId) next[uid] = level;
        }
        await actor.update({ ownership: next }, { diff: false, recursive: false });
      }
      await game.users.get(userId)?.delete();
      return [groupId, memberId].filter(id => userId in (game.actors.get(id)?.ownership ?? {}));
    },
    { groupId, memberId: setup.memberId, userId: setup.userId }
  );
  if (leftover.length)
    console.error(`  [warn] ownership residue left on ${leftover.length} actor(s)`);

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nImages + report written to ${OUT}`);
} catch (e) {
  console.error('[shot] ERROR:', e?.stack || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
