// Which client acts (scripts/kit/elect.js). Part of the Open Roll 5e kit's tests: the suite's
// templates/kit/tests/ is the source and tools/kit-sync.mjs keeps every copy identical.
import {
  acting,
  createElect,
  decide,
  electOf,
  LEAD_FLAG,
  leads,
  newWindowId,
  ROLES
} from "../../scripts/kit/elect.js";

const gm = (id, extra = {}) => ({ id, role: ROLES.GAMEMASTER, active: true, ...extra });
const assistant = (id, extra = {}) => ({ id, role: ROLES.ASSISTANT, active: true, ...extra });
const player = (id, extra = {}) => ({ id, role: ROLES.PLAYER, active: true, ...extra });

describe("the elect is Foundry's designated active GM", () => {
  it("is a connected user with the Assistant GM role or above", () => {
    expect(electOf([player("a"), assistant("b", { active: false })])).toBe(null);
    expect(electOf([player("a"), assistant("b")]).id).toBe("b");
  });

  it("is the highest role, whatever the ids: an Assistant GM only with no Gamemaster on", () => {
    expect(electOf([assistant("0aaa"), gm("zzzz")]).id).toBe("zzzz");
    expect(electOf([assistant("0aaa"), gm("zzzz", { active: false })]).id).toBe("0aaa");
  });

  it("breaks a tie by the lower id in code-unit order: digits, then capitals, then lower case", () => {
    expect(electOf([gm("b"), gm("a")]).id).toBe("a");
    expect(electOf([gm("a"), gm("B")]).id).toBe("B");
    expect(electOf([gm("B"), gm("9")]).id).toBe("9");
    expect(electOf([assistant("x"), assistant("X"), assistant("x1")]).id).toBe("X");
  });

  it("is one user whatever order the clients list the users in", () => {
    const users = [assistant("m"), gm("q"), gm("C"), player("0"), gm("c")];
    const ids = new Set();
    for (let i = 0; i < users.length; i++) {
      ids.add(electOf([...users.slice(i), ...users.slice(0, i)]).id);
      ids.add(electOf([...users].reverse()).id);
    }
    expect([...ids]).toEqual(["C"]);
  });
});

describe("the leading window", () => {
  it("leads with no flag, or when the flag names it", () => {
    expect(leads(null, "w1")).toBe(true);
    expect(leads("w1", "w1")).toBe(true);
    expect(leads("w2", "w1")).toBe(false);
  });

  it("makes one account in two windows act once", () => {
    const base = { ready: true, electId: "u", selfId: "u", leadFlag: "w2" };
    expect(decide({ ...base, windowId: "w1" })).toBe(false);
    expect(decide({ ...base, windowId: "w2" })).toBe(true);
  });

  it("gives every window its own id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newWindowId()));
    expect(ids.size).toBe(50);
    expect(newWindowId(() => 0)).toBe("window");
  });
});

describe("the decision", () => {
  const base = { ready: true, electId: "u", selfId: "u", leadFlag: null, windowId: "w" };

  it("is yes for the elected user's leading window", () => {
    expect(decide(base)).toBe(true);
  });

  it("is never yes before ready", () => {
    expect(decide({ ...base, ready: false })).toBe(false);
    expect(acting({ ready: false, userId: "u", selfId: "u", leadFlag: null, windowId: "w" })).toBe(
      false
    );
  });

  it("is no for another user, or with no elect at all", () => {
    expect(decide({ ...base, selfId: "v" })).toBe(false);
    expect(decide({ ...base, electId: null })).toBe(false);
  });

  it("answers the acting client: that user's own leading window", () => {
    const at = { ready: true, selfId: "p", leadFlag: "w", windowId: "w" };
    expect(acting({ ...at, userId: "p" })).toBe(true);
    expect(acting({ ...at, userId: "q" })).toBe(false);
    expect(acting({ ...at, userId: "p", windowId: "other" })).toBe(false);
    expect(acting({ ...at, userId: null })).toBe(false);
  });
});

describe("createElect, against a fake Foundry", () => {
  let hooks;
  let saved;

  const fakeHooks = () => {
    const handlers = new Map();
    const add = (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    return {
      on: add,
      once: add,
      call: (name, ...args) => {
        for (const fn of handlers.get(name) ?? []) fn(...args);
      }
    };
  };

  const fakeGame = ({ selfId, activeGM }) => {
    const self = {
      id: selfId,
      isSelf: true,
      flags: {},
      async setFlag(scope, key, value) {
        await new Promise(resolve => setTimeout(resolve, 0)); // the server round trip
        this.flags[scope] = { ...(this.flags[scope] ?? {}), [key]: value };
        return this;
      },
      async unsetFlag(scope, key) {
        delete this.flags[scope]?.[key];
        return this;
      }
    };
    return { ready: false, user: self, users: { activeGM } };
  };

  beforeEach(() => {
    saved = { game: globalThis.game, Hooks: globalThis.Hooks };
    hooks = fakeHooks();
    globalThis.Hooks = hooks;
  });

  afterEach(() => {
    globalThis.game = saved.game;
    globalThis.Hooks = saved.Hooks;
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it("is not the elect before ready, and is once it has claimed the lead", async () => {
    globalThis.game = fakeGame({ selfId: "u", activeGM: { id: "u" } });
    globalThis.game.user.flags["fvtt-mod-x"] = { [LEAD_FLAG]: "a-window-closed-long-ago" };
    const elect = createElect("fvtt-mod-x");
    const runs = [];
    elect.onElected(() => runs.push("elected"));
    expect(elect.isElect()).toBe(false);
    globalThis.game.ready = true;
    hooks.call("ready");
    expect(elect.isElect()).toBe(false);
    await settle();
    expect(globalThis.game.user.flags["fvtt-mod-x"][LEAD_FLAG]).toBe(elect.windowId);
    expect(elect.isElect()).toBe(true);
    expect(runs).toEqual(["elected"]);
  });

  it("runs onElected on each move into the elect, never twice in a row", async () => {
    const game = fakeGame({ selfId: "u", activeGM: { id: "other" } });
    globalThis.game = game;
    const elect = createElect("fvtt-mod-x");
    const runs = [];
    elect.onElected(() => runs.push(game.users.activeGM.id));
    game.ready = true;
    hooks.call("ready");
    await settle();
    expect(runs).toEqual([]);
    game.users.activeGM = { id: "u" };
    hooks.call("userConnected", { id: "other" }, false);
    hooks.call("userConnected", { id: "someone" }, true);
    expect(runs).toEqual(["u"]);
    game.users.activeGM = { id: "boss" };
    hooks.call("userConnected", { id: "boss" }, true);
    game.users.activeGM = { id: "u" };
    hooks.call("userConnected", { id: "boss" }, false);
    expect(runs).toEqual(["u", "u"]);
  });

  it("stands down when another window of the same user takes the lead", async () => {
    const game = fakeGame({ selfId: "u", activeGM: { id: "u" } });
    globalThis.game = game;
    const elect = createElect("fvtt-mod-x");
    game.ready = true;
    hooks.call("ready");
    await settle();
    expect(elect.isElect()).toBe(true);
    game.user.flags["fvtt-mod-x"][LEAD_FLAG] = "the-other-window";
    hooks.call("updateUser", game.user, { flags: {} });
    expect(elect.isElect()).toBe(false);
    expect(elect.isActing("u")).toBe(false);
  });

  it("defers whenReady work until ready", () => {
    const game = fakeGame({ selfId: "u", activeGM: null });
    globalThis.game = game;
    const elect = createElect("fvtt-mod-x");
    const runs = [];
    elect.whenReady(() => runs.push("deferred"));
    expect(runs).toEqual([]);
    game.ready = true;
    hooks.call("ready");
    expect(runs).toEqual(["deferred"]);
    elect.whenReady(() => runs.push("now"));
    expect(runs).toEqual(["deferred", "now"]);
  });

  it("falls back to the designated-user rule where activeGM is missing", () => {
    const game = fakeGame({ selfId: "a", activeGM: undefined });
    game.users = { contents: [gm("b"), gm("a"), assistant("0")] };
    game.ready = true;
    globalThis.game = game;
    const elect = createElect("fvtt-mod-x");
    expect(elect.electUser().id).toBe("a");
    expect(elect.isElect()).toBe(true);
  });
});
