// The stash's coin arithmetic (scripts/partystash.js): change-making, the recorded change and
// the revert's give-back. partystash.js registers hooks at import, so a stub Hooks stands in.
let ps;

beforeAll(async () => {
  globalThis.Hooks = { on: () => {}, once: () => {} };
  ps = await import("../scripts/partystash.js");
});

afterAll(() => {
  delete globalThis.Hooks;
});

const purse = (pp = 0, gp = 0, ep = 0, sp = 0, cp = 0) => ({ pp, gp, ep, sp, cp });

describe("making change", () => {
  it("spends small coins first and returns change in gp, sp and cp", () => {
    expect(ps.planDeduction(purse(3, 0, 0, 15, 0), 1500)).toEqual(purse(1, 6, 0, 5, 0));
  });

  it("refuses what the purse cannot afford", () => {
    expect(ps.planDeduction(purse(0, 1), 101)).toBe(null);
  });
});

describe("the recorded change", () => {
  it("is signed per denomination, after minus before", () => {
    expect(ps.purseDelta(purse(3, 0, 0, 15), purse(1, 5))).toEqual(purse(-2, 5, 0, -15, 0));
  });

  it("reads missing coins as none", () => {
    expect(ps.purseDelta({}, { gp: 2 })).toEqual(purse(0, 2));
  });
});

describe("the revert's give-back", () => {
  it("undoes a deposit exactly when neither purse has moved since", () => {
    const member = purse(0, 20, 0, 4);
    const group = purse(1, 0);
    const moved = purse(0, 12, 0, 4);
    const memberAfter = purse(0, 8, 0, 0);
    const groupAfter = purse(1, 12, 0, 4);
    expect(ps.reverseDelta(groupAfter, ps.purseDelta(group, groupAfter))).toEqual(group);
    expect(ps.reverseDelta(memberAfter, ps.purseDelta(member, memberAfter))).toEqual(member);
    expect(ps.totalCopper(moved)).toBe(1240);
  });

  it("converts only what the purse no longer holds in kind", () => {
    expect(ps.reverseDelta(purse(1, 0), purse(0, 5))).toEqual(purse(0, 5));
  });

  it("refuses when the purse can no longer cover what it gained", () => {
    expect(ps.reverseDelta(purse(0, 2), purse(0, 5))).toBe(null);
  });

  it("returns a mixed adjustment's losses and takes back its gains", () => {
    expect(ps.reverseDelta(purse(0, 5, 0, 0), purse(0, 5, 0, -2))).toEqual(purse(0, 0, 0, 2));
  });
});

describe("the coin label", () => {
  it("names the coins as held", () => {
    expect(ps.formatCoins(purse(2, 12, 0, 0, 5))).toBe("2 pp 12 gp 5 cp");
    expect(ps.formatCoins(purse())).toBe("no coin");
  });
});
