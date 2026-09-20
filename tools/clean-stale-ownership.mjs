// Remove actor ownership entries that point at users who no longer exist.
//
// Test harnesses in this repo (verify-partystash.mjs, verify-partystash-coin.mjs,
// shot-partystash-coin.mjs) create a throwaway PLAYER user, grant it ownership of an actor,
// probe, then revoke and delete the user. The revoke used `{"ownership.-=<id>": null}`, which
// did NOT take — the audit found one stale id per run still sitting on the actors. This
// script cleans them up by rewriting the whole ownership object without the dead keys, which
// does work.
//
// SAFETY: an entry is removed ONLY when `game.users.get(id)` returns nothing — i.e. the user
// is genuinely gone. Real players, and the `default` key, are never touched. Runs a dry pass
// first and prints exactly what it would change; pass --apply to actually write.
//
// Run: node tools/clean-stale-ownership.mjs [--apply]
import { Foundry, foundryConfig, loadEnv } from 'fvtt-mcp-dnd5e/client';

const env = loadEnv();

const APPLY = process.argv.includes('--apply');

const f = new Foundry(foundryConfig(env));

try {
  await f.connect();
  const result = await f.evaluate(async apply => {
    const out = { plan: [], applied: [], errors: [] };
    for (const actor of game.actors) {
      const ownership = actor.ownership ?? {};
      const dead = Object.keys(ownership).filter(id => id !== 'default' && !game.users.get(id));
      if (!dead.length) continue;
      out.plan.push({
        actor: actor.name,
        removing: dead.map(id => `${id}=${ownership[id]}`),
        keeping: Object.keys(ownership).filter(id => id === 'default' || game.users.get(id)).length,
      });
      if (!apply) continue;
      try {
        // Rewrite the whole object rather than using the `-=` delete syntax, which silently
        // no-ops on the ownership field here.
        const next = {};
        for (const [id, level] of Object.entries(ownership)) {
          if (id === 'default' || game.users.get(id)) next[id] = level;
        }
        await actor.update({ ownership: next }, { diff: false, recursive: false });
        const after = Object.keys(game.actors.get(actor.id).ownership ?? {}).filter(
          id => id !== 'default' && !game.users.get(id)
        );
        out.applied.push({ actor: actor.name, removed: dead.length, stillStale: after.length });
      } catch (err) {
        out.errors.push(`${actor.name}: ${err.message}`);
      }
    }
    return out;
  }, APPLY);

  if (!result.plan.length) {
    console.log('No stale ownership entries found — nothing to do.');
  } else {
    console.log(
      `${APPLY ? 'APPLYING' : 'DRY RUN'} — ${result.plan.length} actor(s) with dead ownership entries:`
    );
    for (const p of result.plan) {
      console.log(
        `  ${p.actor}: removing ${p.removing.length} (${p.removing.join(', ')}); keeping ${p.keeping}`
      );
    }
  }
  for (const a of result.applied) {
    console.log(
      `  ${a.stillStale === 0 ? 'OK  ' : 'FAIL'} ${a.actor}: removed ${a.removed}, ` +
        `${a.stillStale} still stale`
    );
  }
  for (const e of result.errors) console.error(`  ERROR ${e}`);
  if (!APPLY && result.plan.length) console.log('\nRe-run with --apply to write these changes.');
} catch (e) {
  console.error('[clean] ERROR:', e?.message || e);
  process.exitCode = 1;
} finally {
  await f.dispose();
}
