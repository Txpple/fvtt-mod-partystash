// Post-test audit for the fvtt-mod-partystash v1.3 work: prove nobody lost (or gained) coin,
// and that the throwaway test users and ownership grants are gone.
//
// The EXPECTED values below are the purses read live at the very start of the session, by
// fvtt-mcp-dnd5e/docs/history/spikes/spike-group-currency-dom2.mjs, BEFORE anything wrote to the world. They are the
// ground truth the verify/screenshot runs must have returned everyone to — checked here
// independently rather than by trusting those scripts' own restore step.
//
// Read-only. Run: node tools/audit-partystash-coin-cleanup.mjs
import { Foundry, foundryConfig, loadEnv } from 'fvtt-mcp-dnd5e/client';

const env = loadEnv();

// Captured 2026-08-12 by spike-group-currency-dom2.mjs, pre-write.
const EXPECTED = {
  'The Party': { pp: 0, gp: 79, ep: 0, sp: 0, cp: 0 },
  'Gren Greenmantle': { pp: 0, gp: 0, ep: 0, sp: 9, cp: 9 },
  'Jetten Elisedil': { pp: 0, gp: 3, ep: 0, sp: 5, cp: 0 },
  'Morgash the Gravemaker': { pp: 0, gp: 17, ep: 0, sp: 4, cp: 0 },
  'Thomas A. Invictus': { pp: 0, gp: 30, ep: 0, sp: 4, cp: 4 },
};

const f = new Foundry(foundryConfig(env));

let fails = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

try {
  await f.connect();
  const live = await f.evaluate(names => {
    const out = { purses: {}, testUsers: [], strayItems: [], strayOwnership: [] };
    for (const name of names) {
      const actor = game.actors.getName(name);
      out.purses[name] = actor ? { ...actor.system.currency } : null;
    }
    out.testUsers = game.users.filter(u => /^ZZ-PSTASH/i.test(u.name)).map(u => u.name);
    for (const actor of game.actors) {
      const stale = actor.items.filter(i => /^ZZ-PSTASH/i.test(i.name));
      if (stale.length) out.strayItems.push(`${actor.name}: ${stale.map(i => i.name).join(', ')}`);
      // Ownership entries pointing at users that no longer exist.
      for (const id of Object.keys(actor.ownership ?? {})) {
        if (id === 'default') continue;
        if (!game.users.get(id)) out.strayOwnership.push(`${actor.name} -> ${id}`);
      }
    }
    return out;
  }, Object.keys(EXPECTED));

  console.log('# purses (expected = pre-session live values)');
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = live.purses[name];
    const same = JSON.stringify(got) === JSON.stringify(want);
    const fmt = c =>
      c
        ? Object.entries(c)
            .filter(([, v]) => v)
            .map(([k, v]) => `${v}${k}`)
            .join(' ') || 'empty'
        : 'MISSING';
    assert(same, `${name}: ${fmt(got)}${same ? '' : `  (expected ${fmt(want)})`}`);
  }

  console.log('# test residue');
  assert(
    live.testUsers.length === 0,
    `no ZZ-PSTASH users left (${live.testUsers.join(', ') || 'none'})`
  );
  assert(
    live.strayItems.length === 0,
    `no ZZ-PSTASH items left (${live.strayItems.join(' | ') || 'none'})`
  );
  assert(
    live.strayOwnership.length === 0,
    `no ownership entries for deleted users (${live.strayOwnership.join(' | ') || 'none'})`
  );
} catch (e) {
  console.error('[audit] ERROR:', e?.message || e);
  fails++;
} finally {
  await f.dispose();
  console.log(fails === 0 ? '\nVERDICT: CLEAN' : `\nVERDICT: ${fails} PROBLEM(S)`);
  process.exit(fails === 0 ? 0 : 1);
}
