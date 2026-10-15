/**
 * log.js — the family logger. Part of the Open Roll 5e kit: every module that holds it holds the
 * same bytes, at scripts/kit/log.js; the source is the suite's templates/kit/, and the suite's
 * tools/kit-sync.mjs writes the copies and reports a drifted one. Edit it there, never here.
 *
 *   import { createLogger } from "./kit/log.js";
 *   const log = createLogger("fvtt-mod-example");
 *   log.info("ready");  log.warn("a seam moved", err);  log.error("a write failed", err);
 *   log.debug("only while debugging", data);
 *
 * Every line opens with the module's title from its manifest (read when the line is written, so
 * a logger made at import time still names the module once Foundry has loaded it; the id stands
 * in before that), then " |". `debug` lines print only while the switch is on: set
 * `CONFIG.debug["<module id>"] = true` in the console, or call `log.setDebug(true)`.
 */

/** The module's title from `game.modules`, or the id when it is not known (yet). */
export function titleOf(id, modules = globalThis.game?.modules) {
  try {
    return modules?.get?.(id)?.title || id;
  } catch {
    return id;
  }
}

/** The text every line of this module's log opens with. */
export function prefixOf(id, modules) {
  return `${titleOf(id, modules)} |`;
}

/**
 * A logger for one module.
 * @param {string} id                         The module id.
 * @param {object} [options]
 * @param {Console} [options.sink]            Where lines go (the console; a fake in tests).
 * @param {() => object} [options.modules]    Where titles come from (`game.modules`).
 * @param {() => object} [options.debugFlags] Where the switch is read (`CONFIG.debug`).
 */
export function createLogger(id, {
  sink = globalThis.console,
  modules = () => globalThis.game?.modules,
  debugFlags = () => globalThis.CONFIG?.debug
} = {}) {
  let forced = false;
  const debugging = () => {
    if (forced) return true;
    try {
      return !!debugFlags()?.[id];
    } catch {
      return false;
    }
  };
  const write = (level, args) => {
    try {
      sink?.[level]?.(prefixOf(id, modules()), ...args);
    } catch {
      // A broken console is not a reason for the caller to fail.
    }
  };
  return {
    id,
    debugging,
    setDebug(on) {
      forced = !!on;
    },
    debug: (...args) => {
      if (debugging()) write("debug", args);
    },
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  };
}
