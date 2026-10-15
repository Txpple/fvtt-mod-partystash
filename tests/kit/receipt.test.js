// The family's chat receipt (scripts/kit/receipt.js). Part of the Open Roll 5e kit's tests: the
// suite's templates/kit/tests/ is the source and tools/kit-sync.mjs keeps every copy identical.
import {
  contentOf,
  createReceipts,
  ECHO_KEY,
  echoes,
  echoOptions,
  esc,
  html,
  lineKey,
  lineState,
  MODES,
  nextAsk,
  pendingLines,
  RECEIPT_FLAG,
  RECEIPT_VERSION,
  raw,
  readReceipt,
  receiptFlag,
  whisperFor
} from "../../scripts/kit/receipt.js";

describe("escaping", () => {
  it("escapes the five characters markup cares about", () => {
    expect(esc(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;"
    );
  });

  it("reads null and undefined as empty, and numbers as text", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(12)).toBe("12");
  });

  it("escapes every value in an html template and keeps the literal markup", () => {
    const name = "<script>alert(1)</script>";
    expect(html`<strong>${name}</strong> took ${3} × <em>${"Rope & Hook"}</em>.`).toBe(
      "<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong> took 3 × <em>Rope &amp; Hook</em>."
    );
  });

  it("keeps raw() fragments and joins arrays", () => {
    const inner = html`<em>${"A&B"}</em>`;
    expect(html`<p>${raw(inner)}</p>`).toBe("<p><em>A&amp;B</em></p>");
    expect(html`${["<a>", raw("<b>")]}`).toBe("&lt;a&gt;<b>");
  });
});

describe("who reads it", () => {
  const who = { gms: ["gm1", "gm2"], acting: "p1", owners: ["p1", "p2", "gm1"] };

  it("is everyone when public, or when the mode is unknown", () => {
    expect(whisperFor("public", who)).toBe(null);
    expect(whisperFor("nonsense", who)).toBe(null);
    expect(whisperFor(undefined, who)).toBe(null);
  });

  it("is the DMs, the acting user and the owners for participants, once each", () => {
    expect(whisperFor("participants", who)).toEqual(["gm1", "gm2", "p1", "p2"]);
  });

  it("is the DMs alone for gm", () => {
    expect(whisperFor("gm", who)).toEqual(["gm1", "gm2"]);
  });

  it("offers the three modes in order, each with a label and a note", () => {
    expect(MODES.map(m => m.value)).toEqual(["public", "participants", "gm"]);
    for (const m of MODES) {
      expect(m.label.length).toBeGreaterThan(10);
      expect(m.note.length).toBeGreaterThan(10);
    }
  });
});

describe("the echo marker", () => {
  it("is the same key in every module, carrying the module id", () => {
    expect(ECHO_KEY).toBe("openroll5eReceipt");
    expect(echoOptions("fvtt-mod-a", { render: false })).toEqual({
      render: false,
      openroll5eReceipt: "fvtt-mod-a"
    });
  });

  it("marks only a change some receipt tells", () => {
    expect(echoes(echoOptions("fvtt-mod-a"))).toBe(true);
    expect(echoes({})).toBe(false);
    expect(echoes(undefined)).toBe(false);
    expect(echoes({ [ECHO_KEY]: "" })).toBe(false);
  });
});

describe("the receipt's flag", () => {
  const moves = [{ kind: "item", from: "Actor.a", to: "Actor.b", qty: 2 }];

  it("is versioned and carries each line's moves", () => {
    const flag = receiptFlag([{ html: "x", moves }, { html: "y" }]);
    expect(flag).toEqual({
      v: RECEIPT_VERSION,
      lines: [
        { moves, revertible: true },
        { moves: [], revertible: false }
      ],
      asks: {},
      state: {}
    });
    expect(RECEIPT_FLAG).toBe("receipt");
  });

  it("lets a module mark a line with moves as not revertible", () => {
    expect(receiptFlag([{ moves, revertible: false }]).lines[0].revertible).toBe(false);
  });

  it("is left alone when it is another version", () => {
    expect(readReceipt({ v: RECEIPT_VERSION + 1, lines: [] })).toBe(null);
    expect(readReceipt({ v: RECEIPT_VERSION })).toBe(null);
    expect(readReceipt(null)).toBe(null);
    expect(lineState({ v: 99, lines: [{ moves, revertible: true }] }, 0)).toBe("none");
  });
});

describe("a line's revert", () => {
  const moves = [{ kind: "coin" }];
  const at = (asks = {}, state = {}) => ({
    ...receiptFlag([{ moves }, { moves: [] }]),
    asks,
    state
  });
  const k = lineKey(0);

  it("starts open, and fixed for a line that cannot be reverted", () => {
    expect(lineState(at(), 0)).toBe("open");
    expect(lineState(at(), 1)).toBe("fixed");
    expect(lineState(at(), 2)).toBe("none");
  });

  it("is asked once a GM asks, until the elect takes it", () => {
    const flag = at({ [k]: { by: "gm", n: 1 } });
    expect(lineState(flag, 0)).toBe("asked");
    expect(pendingLines(flag)).toEqual([0]);
  });

  it("runs, then reads reverted, and is never pending again", () => {
    expect(lineState(at({ [k]: { n: 1 } }, { [k]: { state: "running", n: 1 } }), 0)).toBe(
      "running"
    );
    const done = at({ [k]: { n: 1 } }, { [k]: { state: "done", n: 1 } });
    expect(lineState(done, 0)).toBe("reverted");
    expect(pendingLines(done)).toEqual([]);
  });

  it("can be asked again after a refusal, with a higher number", () => {
    const refused = at({ [k]: { n: 1 } }, { [k]: { state: "refused", n: 1, why: "gone" } });
    expect(lineState(refused, 0)).toBe("refused");
    expect(pendingLines(refused)).toEqual([]);
    expect(nextAsk(refused, 0)).toBe(2);
    const again = { ...refused, asks: { [k]: { n: 2 } } };
    expect(lineState(again, 0)).toBe("asked");
  });

  it("numbers the first ask 1", () => {
    expect(nextAsk(at(), 0)).toBe(1);
  });
});

describe("the card's markup", () => {
  it("is one paragraph per line, tagged with its index and the module", () => {
    expect(contentOf("fvtt-mod-a", [{ html: "<b>one</b>" }, { html: "two" }])).toBe(
      '<div class="openroll5e-receipt" data-receipt="fvtt-mod-a">' +
        '<p class="openroll5e-receipt-line" data-receipt-line="0"><b>one</b></p>' +
        '<p class="openroll5e-receipt-line" data-receipt-line="1">two</p></div>'
    );
  });
});

describe("createReceipts, against a fake Foundry", () => {
  let saved;
  let created;
  let messages;
  let handlers;

  const hooks = () => {
    handlers = new Map();
    const add = (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    return { on: add, once: add };
  };
  const call = async (name, ...args) => {
    for (const fn of handlers.get(name) ?? []) await fn(...args);
  };

  // A message whose update merges dotted flag paths, as Foundry does, and fires updateChatMessage.
  const message = data => {
    const m = {
      id: `m${messages.size + 1}`,
      ...data,
      async update(changes) {
        for (const [path, value] of Object.entries(changes)) {
          const keys = path.split(".");
          let at = m;
          for (const key of keys.slice(0, -1)) at = at[key] ??= {};
          at[keys.at(-1)] = value;
        }
        await call("updateChatMessage", m, changes);
        return m;
      }
    };
    messages.set(m.id, m);
    return m;
  };

  beforeEach(() => {
    saved = { game: globalThis.game, Hooks: globalThis.Hooks, ChatMessage: globalThis.ChatMessage };
    created = [];
    messages = new Map();
    globalThis.Hooks = hooks();
    globalThis.ChatMessage = {
      implementation: {
        create: async data => {
          created.push(data);
          return message(data);
        }
      }
    };
    const users = [
      { id: "gm", isGM: true },
      { id: "p1", isGM: false },
      { id: "p2", isGM: false }
    ];
    globalThis.game = {
      ready: true,
      user: { id: "gm", isGM: true },
      users: { contents: users, get: id => users.find(u => u.id === id) },
      messages: { get: id => messages.get(id), contents: [] },
      settings: { get: () => "participants" }
    };
  });

  afterEach(() => {
    globalThis.game = saved.game;
    globalThis.Hooks = saved.Hooks;
    globalThis.ChatMessage = saved.ChatMessage;
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };

  const owner = userId => ({ testUserPermission: u => u.id === userId });

  it("posts one card with the flag, the alias and the whisper the policy names", async () => {
    const receipts = createReceipts("fvtt-mod-a", { elect: { isElect: () => true }, alias: "A" });
    await receipts.post({
      lines: [{ html: html`<b>${"Bo"}</b> took one.`, moves: [{ q: 1 }] }],
      acting: "p1",
      participants: [owner("p2")]
    });
    expect(created).toHaveLength(1);
    const [data] = created;
    expect(data.speaker).toEqual({ alias: "A" });
    expect(data.author).toBe("p1");
    expect(data.whisper).toEqual(["gm", "p1", "p2"]);
    expect(data.flags["fvtt-mod-a"].receipt.lines[0]).toEqual({
      moves: [{ q: 1 }],
      revertible: true
    });
    expect(data.content).toContain("<b>Bo</b> took one.");
  });

  it("reverts an asked line once, on the elect, under the echo marker", async () => {
    const seen = [];
    const receipts = createReceipts("fvtt-mod-a", {
      elect: { isElect: () => true },
      revert: async (line, { options }) => {
        seen.push([line.moves, options]);
        return { note: "all back" };
      }
    });
    const m = await receipts.post({ lines: [{ html: "x", moves: [{ q: 1 }] }] });
    await receipts.requestRevert(m, 0);
    await settle();
    await receipts.perform(m, 0);
    expect(seen).toEqual([[[{ q: 1 }], { openroll5eReceipt: "fvtt-mod-a" }]]);
    expect(receipts.lineState(m, 0)).toBe("reverted");
    expect(m.flags["fvtt-mod-a"].receipt.state.l0.note).toBe("all back");
    expect(await receipts.requestRevert(m, 0)).toBe(false);
  });

  it("records a refusal with its reason, and lets the line be asked again", async () => {
    let tries = 0;
    const receipts = createReceipts("fvtt-mod-a", {
      elect: { isElect: () => true },
      revert: async () => {
        tries++;
        if (tries === 1) throw new Error("Bo no longer holds the rope");
      }
    });
    const m = await receipts.post({ lines: [{ html: "x", moves: [{ q: 1 }] }] });
    await receipts.requestRevert(m, 0);
    await settle();
    expect(receipts.lineState(m, 0)).toBe("refused");
    expect(m.flags["fvtt-mod-a"].receipt.state.l0.why).toBe("Bo no longer holds the rope");
    expect(await receipts.requestRevert(m, 0)).toBe(true);
    await settle();
    expect(receipts.lineState(m, 0)).toBe("reverted");
    expect(tries).toBe(2);
  });

  it("leaves an ask for the elect when this client is not it", async () => {
    let calls = 0;
    const receipts = createReceipts("fvtt-mod-a", {
      elect: { isElect: () => false },
      revert: async () => {
        calls++;
      }
    });
    const m = await receipts.post({ lines: [{ html: "x", moves: [{ q: 1 }] }] });
    await receipts.requestRevert(m, 0);
    await settle();
    expect(calls).toBe(0);
    expect(receipts.lineState(m, 0)).toBe("asked");
  });

  it("refuses a revert asked by a player", async () => {
    const receipts = createReceipts("fvtt-mod-a", { elect: { isElect: () => true } });
    const m = await receipts.post({ lines: [{ html: "x", moves: [{ q: 1 }] }] });
    globalThis.game.user = { id: "p1", isGM: false };
    await expect(receipts.requestRevert(m, 0)).rejects.toThrow("only a GM");
  });
});
