// The family logger (scripts/kit/log.js). Part of the Open Roll 5e kit's tests: the suite's
// templates/kit/tests/ is the source and tools/kit-sync.mjs keeps every copy identical.
import { createLogger, prefixOf, titleOf } from "../../scripts/kit/log.js";

const modules = titles => ({ get: id => (titles[id] ? { title: titles[id] } : undefined) });

const fakeConsole = () => {
  const lines = [];
  const sink = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    sink[level] = (...args) => lines.push([level, ...args]);
  }
  return { sink, lines };
};

describe("the prefix", () => {
  it("is the module's title from its manifest", () => {
    expect(prefixOf("fvtt-mod-x", modules({ "fvtt-mod-x": "Open Roll 5e: X" }))).toBe(
      "Open Roll 5e: X |"
    );
  });

  it("is the id while the module is not known", () => {
    expect(titleOf("fvtt-mod-x", modules({}))).toBe("fvtt-mod-x");
    expect(titleOf("fvtt-mod-x", undefined)).toBe("fvtt-mod-x");
    expect(
      titleOf("fvtt-mod-x", {
        get: () => {
          throw new Error("no");
        }
      })
    ).toBe("fvtt-mod-x");
  });
});

describe("the levels", () => {
  it("send info, warn and error to the console under the prefix", () => {
    const { sink, lines } = fakeConsole();
    const log = createLogger("fvtt-mod-x", {
      sink,
      modules: () => modules({ "fvtt-mod-x": "X" }),
      debugFlags: () => ({})
    });
    const err = new Error("boom");
    log.info("ready");
    log.warn("moved", 3);
    log.error("failed", err);
    expect(lines).toEqual([
      ["info", "X |", "ready"],
      ["warn", "X |", "moved", 3],
      ["error", "X |", "failed", err]
    ]);
  });

  it("print debug only while the switch is on", () => {
    const { sink, lines } = fakeConsole();
    const flags = {};
    const log = createLogger("fvtt-mod-x", {
      sink,
      modules: () => undefined,
      debugFlags: () => flags
    });
    log.debug("hidden");
    flags["fvtt-mod-x"] = true;
    log.debug("shown");
    flags["fvtt-mod-x"] = false;
    log.setDebug(true);
    log.debug("forced");
    log.setDebug(false);
    log.debug("hidden again");
    expect(lines).toEqual([
      ["debug", "fvtt-mod-x |", "shown"],
      ["debug", "fvtt-mod-x |", "forced"]
    ]);
  });

  it("never throw for a broken console", () => {
    const log = createLogger("fvtt-mod-x", {
      sink: {
        warn: () => {
          throw new Error("no console");
        }
      },
      modules: () => undefined,
      debugFlags: () => ({})
    });
    expect(() => log.warn("x")).not.toThrow();
    expect(() => log.info("x")).not.toThrow();
  });
});
