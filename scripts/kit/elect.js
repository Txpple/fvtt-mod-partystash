/**
 * elect.js — which client acts. Part of the Open Roll 5e kit: every module that holds it holds the
 * same bytes, at scripts/kit/elect.js; the source is the suite's templates/kit/, and the suite's
 * tools/kit-sync.mjs writes the copies and reports a drifted one. Edit it there, never here.
 *
 *   import { createElect } from "./kit/elect.js";
 *   const elect = createElect("fvtt-mod-example", { log });
 *   if (elect.isElect()) ...           the one GM client that makes a change every client heard
 *   if (elect.isActing(userId)) ...    the one client of `userId` that follows up that user's gesture
 *   elect.onElected(() => resume());   runs each time this client becomes the elect
 *   elect.whenReady(() => ...);        runs once the world is loaded and its buffered changes are in
 *
 * Every client hears a document hook, a socket message and a chat card, so a consequence driven
 * from one must be performed by exactly one client, or it lands once per client.
 *
 * THE ELECT is Foundry's designated active GM (`game.users.activeGM`): of the connected users with
 * the Assistant GM role or above, the one with the highest role, a tie going to the lower id in
 * plain code-unit order (digits, then capitals, then lower case). Clients that agree on who is
 * connected agree on that user, so the elect is one user across every client. A Gamemaster
 * outranks every Assistant GM whatever the ids: an Assistant GM is the elect only while no
 * Gamemaster is connected. In a default world an Assistant GM may make every write an elect needs
 * (actors, items, tokens, chat messages, combats, regions, its own and other users' flags); a world
 * that takes SETTINGS_MODIFY, FILES_UPLOAD or MACRO_SCRIPT from Assistants refuses those, so an
 * elect that writes a world setting catches the refusal and says what stopped.
 *
 * THE LEADING WINDOW. One user may have the game open in several windows, and each is a client
 * that sees itself as that user. The windows agree through a flag on the User, under this
 * module's own scope (LEAD_FLAG): the window loaded or focused last names itself there and leads,
 * and the others stand down. No flag: the window leads. Closing the leader clears the flag, so
 * whichever window is left leads; a window that lost the lead takes it back on focus. Both
 * answers below require the leading window, so one account in two windows acts once.
 *
 * NOT BEFORE READY. Until Foundry sets `game.ready` a client works from the world snapshot it
 * loaded, and an arriving client's snapshot can be older than a change a client already on has
 * just made; the changes after the snapshot are applied only as `ready` is set. So neither answer
 * is yes before `game.ready`, and work that a render or another early hook would start goes
 * through `whenReady`, which runs it once those changes are in.
 *
 * WHEN THE ELECT MOVES. A client already on hears an arrival before the arriving client has its
 * world, so the elect never runs on two clients at once; instead, when the elect moves to the
 * arriving client, there is a gap of about a second in which no client is the elect. Nothing in it
 * is lost if the module resumes in `onElected`, which runs once this client leads at ready, when
 * it takes the lead back on focus, and when the elect user changes to this one.
 */

/** The User flag, under each module's own scope, naming the window of that user that leads. */
export const LEAD_FLAG = "leadWindow";

/** Foundry's CONST.USER_ROLES values the rule reads. */
export const ROLES = Object.freeze({ PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 });

/**
 * Foundry's designated-user rule over plain users (`{ id, role, active }`): the connected user with
 * the Assistant GM role or above, highest role first, a tie to the lower id. Used where
 * `game.users.activeGM` is not available, and as the rule's statement for the tests.
 * @returns {object|null}
 */
export function electOf(users) {
  let elect = null;
  for (const user of users ?? []) {
    if (!user?.active || !(Number(user.role) >= ROLES.ASSISTANT)) continue;
    if (!elect || user.role > elect.role || (user.role === elect.role && user.id < elect.id)) elect = user;
  }
  return elect;
}

/** Does the window `windowId` lead, given the flag on its User? No flag: it does. */
export function leads(flag, windowId) {
  return !flag || flag === windowId;
}

/** Is this client the elect? Only once ready, only as the elected user, only in its leading window. */
export function decide({ ready, electId, selfId, leadFlag, windowId }) {
  return !!ready && !!electId && electId === selfId && leads(leadFlag, windowId);
}

/** Is this client the one that follows up `userId`'s own gesture? Only once ready, only its leading window. */
export function acting({ ready, userId, selfId, leadFlag, windowId }) {
  return !!ready && !!userId && userId === selfId && leads(leadFlag, windowId);
}

/** A fresh id for this window, unique enough among one user's open windows. */
export function newWindowId(random = Math.random) {
  return random().toString(36).slice(2, 14) || "window";
}

/**
 * The elect for one module. Call it once, at import: it registers its hooks.
 * @param {string} id                 The module id: the scope of the lead flag.
 * @param {object} [options]
 * @param {object} [options.log]      A kit logger (log.js), for what could not be done.
 */
export function createElect(id, { log = null } = {}) {
  const windowId = newWindowId();
  const callbacks = [];
  let elected = false;

  const game = () => globalThis.game;
  const leadFlag = () => game()?.user?.flags?.[id]?.[LEAD_FLAG] ?? null;
  const electUser = () => {
    const users = game()?.users;
    if (!users) return null;
    const designated = users.activeGM;
    if (designated !== undefined) return designated ?? null;
    return electOf(users.contents ?? [...users]);
  };

  const leadsWindow = () => leads(leadFlag(), windowId);
  const isElect = () => decide({
    ready: game()?.ready, electId: electUser()?.id ?? null, selfId: game()?.user?.id ?? null,
    leadFlag: leadFlag(), windowId
  });
  const isActing = userId => acting({
    ready: game()?.ready, userId, selfId: game()?.user?.id ?? null, leadFlag: leadFlag(), windowId
  });

  const run = fn => {
    try {
      const result = fn();
      if (typeof result?.catch === "function") result.catch(err => log?.error("a deferred step failed", err));
    } catch (err) {
      log?.error("a deferred step failed", err);
    }
  };

  // Fires the onElected callbacks on the transition into the elect, never twice in a row.
  const check = () => {
    let now = false;
    try {
      now = isElect();
    } catch {
      now = false;
    }
    if (now && !elected) {
      elected = true;
      for (const fn of [...callbacks]) run(fn);
    } else {
      elected = now;
    }
  };

  const claim = () => {
    try {
      const user = game()?.user;
      if (!game()?.ready || !user) return;
      if (leadFlag() === windowId) {
        check();
        return;
      }
      user.setFlag(id, LEAD_FLAG, windowId).then(check, err => log?.warn("this window could not take the lead", err));
    } catch (err) {
      log?.warn("this window could not take the lead", err);
    }
  };

  const release = () => {
    try {
      if (leadFlag() === windowId) game().user.unsetFlag(id, LEAD_FLAG).catch(() => {});
    } catch {
      // The page is closing; the flag is reclaimed on the next load or focus.
    }
  };

  const hooks = globalThis.Hooks;
  hooks?.once?.("ready", () => {
    check();
    claim();
    globalThis.window?.addEventListener?.("focus", claim);
    globalThis.document?.addEventListener?.("visibilitychange", () => {
      if (globalThis.document?.visibilityState === "visible") claim();
    });
    globalThis.window?.addEventListener?.("beforeunload", release);
  });
  hooks?.on?.("updateUser", user => {
    if (user?.isSelf) check();
  });
  hooks?.on?.("userConnected", () => check());

  return {
    id,
    windowId,
    isElect,
    isActing,
    leadsWindow,
    electUser,
    /** Run `fn` each time this client becomes the elect (and now, once, if it already is). */
    onElected(fn) {
      callbacks.push(fn);
      if (elected) run(fn);
    },
    /** Run `fn` once the world is ready and the changes buffered during its load are applied. */
    whenReady(fn) {
      if (game()?.ready) run(fn);
      else hooks?.once?.("ready", () => run(fn));
    }
  };
}
