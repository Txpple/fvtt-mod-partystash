/**
 * receipt.js — the family's chat receipt and its one-click revert. Part of the Open Roll 5e kit:
 * every module that holds it holds the same bytes, at scripts/kit/receipt.js; the source is the
 * suite's templates/kit/, and the suite's tools/kit-sync.mjs writes the copies and reports a
 * drifted one. Edit it there, never here.
 *
 *   import { createReceipts, html } from "./kit/receipt.js";
 *   const receipts = createReceipts("fvtt-mod-example", { elect, log, alias: "Example", revert });
 *   await receipts.post({
 *     lines: [{ html: html`<strong>${buyer.name}</strong> bought <em>${item.name}</em>.`, moves }],
 *     acting: user.id,          // whose gesture it was: the author, and a reader when whispered
 *     participants: [buyer]     // the actors whose owners read a whispered receipt
 *   });
 *
 * WHO READS IT is one policy, a world setting the module registers (key MODE_SETTING by default,
 * choices MODES): everyone (public); the DMs, the acting user and the participants' owners
 * (participants); or the DMs alone (gm). The DMs are every user with the Assistant GM role or
 * above. An unregistered setting reads as public: a public line beats a lost one.
 *
 * WHAT IT CARRIES. The message holds a flag under the module's own scope, RECEIPT_FLAG, versioned
 * (`v` is RECEIPT_VERSION): `lines`, one entry per line of the card, each with `moves` (the
 * module's own record of what changed hands, which this file never reads inside) and
 * `revertible`; then `asks` and `state`, each line's revert asks and outcome, keyed by line. A
 * reader that meets another version leaves the receipt alone.
 *
 * NO ECHO. Every document change a receipt describes, and every change a revert makes, is written
 * with `receipts.options()`, which carries ECHO_KEY. A listener that posts its own receipts from
 * document hooks skips a change whose options `echoes()`, so one move is one line however many
 * modules hear it. Each write gets its own copy (`{ ...options }`): Foundry keeps the operation
 * object it is handed and fills it in (its parent among the rest), so one object shared by two
 * writes carries the first write's parent into the second, which Foundry then refuses.
 *
 * THE REVERT. A GM sees a Revert button on each revertible line. Pressing it writes an ask onto
 * the message (any GM may update any message). The elect (elect.js) sees the ask, re-reads the
 * flag from the message, marks the line as running, and calls the module's
 * `revert(line, { message, index, options })`, which reverses the moves, makes every write under
 * a copy of `options`, checks everything before its first write, and returns `{ note }` or throws an Error
 * that says why not. The line then reads reverted, or shows the reason with the button back for
 * another try. One client performs every revert, so two GMs pressing at once revert once; an ask
 * made while no elect is ready waits on the message, and the next elect resumes it. A line left
 * running by an elect that went away is not run again: it says so, for a GM to check by hand.
 *
 * ESCAPING. `html` escapes every interpolated value (actor and item names are user text); `raw()`
 * marks a fragment that is already markup.
 */

export const RECEIPT_VERSION = 1;
export const RECEIPT_FLAG = "receipt";
/** The options key every family module's receipt writes carry, the same in every copy. */
export const ECHO_KEY = "openroll5eReceipt";
export const MODE_SETTING = "receiptVisibility";
/** How many of the newest messages a new elect looks through for a revert left asked. */
export const RESUME_DEPTH = 60;

/** The delivery policies, in the order a settings sheet lists them. */
export const MODES = Object.freeze([
  Object.freeze({
    value: "public",
    label: "Broadcast receipts to the server",
    note: "Every receipt is posted to the chat log for the whole table to read."
  }),
  Object.freeze({
    value: "participants",
    label: "Receipts to the participants and the DMs",
    note: "Whispered to the players on either side of the move and to the DMs. Assistant DMs count "
      + "as DMs here and see every receipt."
  }),
  Object.freeze({
    value: "gm",
    label: "Receipts to the DMs only",
    note: "Whispered to the DMs alone; players see no receipts. Assistant DMs count as DMs here."
  })
]);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text made safe to put in markup. null and undefined are empty. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ESCAPES[c]);
}

const RAW = Symbol("markup");

/** Mark a fragment as markup already, so `html` keeps it as it is. */
export function raw(markup) {
  return { [RAW]: String(markup ?? "") };
}

const piece = value => {
  if (value?.[RAW] !== undefined) return value[RAW];
  if (Array.isArray(value)) return value.map(piece).join("");
  return esc(value);
};

/** A tagged template: the literal text stays, every interpolated value is escaped (arrays joined). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i]) + strings[i + 1];
  return out;
}

const unique = ids => [...new Set(ids.filter(id => typeof id === "string" && id))];

/**
 * The whisper list for a receipt, or null for a public one.
 * @param {string} mode                 One of MODES' values; anything else is public.
 * @param {object} who
 * @param {string[]} [who.gms]          Every DM's user id.
 * @param {string|null} [who.acting]    The acting user's id.
 * @param {string[]} [who.owners]       The user ids owning a participant.
 */
export function whisperFor(mode, { gms = [], acting = null, owners = [] } = {}) {
  if (mode === "gm") return unique(gms);
  if (mode === "participants") return unique([...gms, acting, ...owners]);
  return null;
}

/** Document-write options that mark the change as one a receipt already tells. */
export function echoOptions(id, options = {}) {
  return { ...options, [ECHO_KEY]: id };
}

/** Is this change already told by a family module's receipt? */
export function echoes(options) {
  return typeof options?.[ECHO_KEY] === "string" && options[ECHO_KEY].length > 0;
}

/** The key a line's ask and state are stored under. */
export const lineKey = index => `l${index}`;

/** A receipt flag for these lines: `[{ moves, revertible }]`; a line without moves is not revertible. */
export function receiptFlag(lines = []) {
  return {
    v: RECEIPT_VERSION,
    lines: lines.map(line => {
      const moves = Array.isArray(line?.moves) ? line.moves : [];
      return { moves, revertible: (line?.revertible ?? true) !== false && moves.length > 0 };
    }),
    asks: {},
    state: {}
  };
}

/** The flag if this kit can read it, else null. */
export function readReceipt(flag) {
  return flag && flag.v === RECEIPT_VERSION && Array.isArray(flag.lines) ? flag : null;
}

/**
 * Where line `index` stands: "none" (no such line), "fixed" (not revertible), "open", "asked"
 * (an ask the elect has not taken), "running", "reverted", or "refused" (the last ask failed; it
 * may be asked again).
 */
export function lineState(flag, index) {
  const line = readReceipt(flag)?.lines?.[index];
  if (!line) return "none";
  if (!line.revertible) return "fixed";
  const state = flag.state?.[lineKey(index)];
  const ask = flag.asks?.[lineKey(index)];
  if (state?.state === "done") return "reverted";
  if (state?.state === "running") return "running";
  if (ask && Number(ask.n ?? 0) > Number(state?.n ?? 0)) return "asked";
  if (state?.state === "refused") return "refused";
  return "open";
}

/** The lines the elect has to revert now. */
export function pendingLines(flag) {
  const lines = readReceipt(flag)?.lines ?? [];
  return lines.map((_, i) => i).filter(i => lineState(flag, i) === "asked");
}

/** The number the next ask of line `index` carries: past every ask and outcome so far. */
export function nextAsk(flag, index) {
  const key = lineKey(index);
  return Math.max(Number(flag?.asks?.[key]?.n ?? 0), Number(flag?.state?.[key]?.n ?? 0)) + 1;
}

/** The card's markup: one paragraph per line, each tagged with its index. */
export function contentOf(id, lines = []) {
  const body = lines.map((line, i) =>
    `<p class="openroll5e-receipt-line" data-receipt-line="${i}">${line?.html ?? ""}</p>`).join("");
  return `<div class="openroll5e-receipt" data-receipt="${esc(id)}">${body}</div>`;
}

/**
 * The receipts of one module. Call it once, at import: it registers its hooks.
 * @param {string} id                   The module id: the flag scope and the setting's namespace.
 * @param {object} options
 * @param {object} options.elect        This module's elect (elect.js).
 * @param {object} [options.log]        This module's logger (log.js).
 * @param {string} [options.alias]      The speaker the card is posted as.
 * @param {string} [options.setting]    The world setting holding the delivery policy.
 * @param {Function} [options.revert]   `(line, { message, index, options }) => Promise<{ note }?>`
 */
export function createReceipts(id, { elect, log = null, alias = id, setting = MODE_SETTING, revert = null } = {}) {
  const game = () => globalThis.game;
  const flagPath = sub => `flags.${id}.${RECEIPT_FLAG}.${sub}`;
  const flagOf = message => readReceipt(message?.flags?.[id]?.[RECEIPT_FLAG]);
  const inflight = new Set();

  const mode = () => {
    try {
      return game().settings.get(id, setting);
    } catch {
      return "public";
    }
  };
  const users = () => game()?.users?.contents ?? [...(game()?.users ?? [])];
  const gmIds = () => users().filter(u => u.isGM).map(u => u.id);
  const ownerIds = actors => users()
    .filter(u => actors.some(a => typeof a?.testUserPermission === "function" && a.testUserPermission(u, "OWNER")))
    .map(u => u.id);

  /** Post a receipt; resolves with the message, or null when it could not be posted (logged). */
  async function post({ lines = [], acting = null, participants = [], author = acting, speaker = null } = {}) {
    try {
      const whisper = whisperFor(mode(), { gms: gmIds(), acting, owners: ownerIds(participants) });
      return await globalThis.ChatMessage.implementation.create({
        content: contentOf(id, lines),
        speaker: speaker ?? { alias },
        flags: { [id]: { [RECEIPT_FLAG]: receiptFlag(lines) } },
        ...(author ? { author } : {}),
        ...(whisper ? { whisper } : {})
      });
    } catch (err) {
      log?.error("a receipt could not be posted", err);
      return null;
    }
  }

  /** The Revert button's press: an ask written onto the message, for the elect to perform. */
  async function requestRevert(message, index) {
    if (!game()?.user?.isGM) throw new Error("only a GM can revert a receipt");
    const live = game().messages?.get?.(message?.id) ?? message;
    const flag = flagOf(live);
    const state = lineState(flag, index);
    if (state !== "open" && state !== "refused") return false;
    await live.update({ [flagPath(`asks.${lineKey(index)}`)]: { by: game().user.id, n: nextAsk(flag, index), at: Date.now() } });
    return true;
  }

  /** On the elect: revert one asked line, re-reading the flag first, and record how it went. */
  async function perform(message, index) {
    const key = `${message?.id}|${index}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      if (!elect?.isElect() || typeof revert !== "function") return;
      const live = game().messages?.get?.(message.id) ?? message;
      const flag = flagOf(live);
      if (lineState(flag, index) !== "asked") return;
      const n = Number(flag.asks[lineKey(index)].n);
      const by = game().user.id;
      const at = flagPath(`state.${lineKey(index)}`);
      await live.update({ [at]: { state: "running", by, n, at: Date.now() } });
      let outcome;
      try {
        const result = await revert(flag.lines[index], { message: live, index, options: echoOptions(id) });
        outcome = { state: "done", by, n, at: Date.now(), ...(result?.note ? { note: String(result.note) } : {}) };
      } catch (err) {
        log?.warn(`a revert did not go through: ${err?.message ?? err}`);
        outcome = { state: "refused", by, n, at: Date.now(), why: String(err?.message ?? err) };
      }
      await live.update({ [at]: outcome });
    } catch (err) {
      log?.error("a revert could not be recorded", err);
    } finally {
      inflight.delete(key);
    }
  }

  const drive = message => {
    try {
      if (!elect?.isElect()) return;
      const flag = flagOf(message);
      if (!flag) return;
      for (const index of pendingLines(flag)) void perform(message, index);
    } catch (err) {
      log?.error("a receipt could not be checked for a revert", err);
    }
  };

  const note = (text, style = {}) => {
    const span = document.createElement("span");
    span.className = "openroll5e-receipt-note";
    span.textContent = text;
    Object.assign(span.style, { fontStyle: "italic", opacity: "0.8", ...style });
    return span;
  };

  const button = (message, index) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "openroll5e-receipt-revert";
    el.textContent = "↩ Revert";
    el.dataset.tooltip = "Put things back as they were before this line";
    Object.assign(el.style, {
      display: "inline-block", width: "auto", margin: "0 0 0 0.4rem", padding: "0 0.4rem",
      fontSize: "inherit", lineHeight: "1.4"
    });
    el.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      el.disabled = true;
      requestRevert(message, index).catch(err => {
        el.disabled = false;
        log?.error("the revert could not be asked for", err);
        globalThis.ui?.notifications?.error(`${alias}: the revert could not be asked for (${err?.message ?? err}).`);
      });
    });
    return el;
  };

  function decorate(message, element) {
    const flag = flagOf(message);
    if (!flag || typeof element?.querySelector !== "function") return;
    const root = element.querySelector(`.openroll5e-receipt[data-receipt="${id}"]`);
    if (!root) return;
    const isGM = !!game()?.user?.isGM;
    for (const row of root.querySelectorAll("[data-receipt-line]")) {
      const index = Number(row.dataset.receiptLine);
      const state = lineState(flag, index);
      const outcome = flag.state?.[lineKey(index)];
      if (state === "reverted") {
        row.style.textDecoration = "line-through";
        const after = document.createElement("p");
        after.className = "openroll5e-receipt-after";
        after.append(note(outcome?.note ? `Reverted: ${outcome.note}` : "Reverted."));
        row.after(after);
        continue;
      }
      if (!isGM || state === "fixed" || state === "none") continue;
      if (state === "running") {
        const gone = game()?.users?.get?.(outcome?.by)?.active === false;
        row.append(note(gone ? " (the revert was interrupted: check the sheets by hand)" : " (reverting…)"));
        continue;
      }
      if (state === "asked") {
        row.append(note(" (reverting…)"));
        continue;
      }
      if (state === "refused") row.append(note(` (not reverted: ${outcome?.why ?? "unknown"})`));
      row.append(button(message, index));
    }
  }

  const hooks = globalThis.Hooks;
  hooks?.on?.("renderChatMessageHTML", (message, element) => {
    try {
      decorate(message, element);
    } catch (err) {
      log?.error("a receipt could not be drawn", err);
    }
  });
  hooks?.on?.("updateChatMessage", message => drive(message));
  elect?.onElected?.(() => {
    for (const message of (game()?.messages?.contents ?? []).slice(-RESUME_DEPTH)) drive(message);
  });

  return {
    id,
    post,
    requestRevert,
    perform,
    flagOf,
    lineState: (message, index) => lineState(flagOf(message), index),
    options: (options = {}) => echoOptions(id, options),
    echoes
  };
}
