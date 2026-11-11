import { describe, expect, it } from "vitest";
import { compareHands, evaluateHand, parseCard } from "../src/index.ts";

const ev = (s: string) => evaluateHand(s.split(" ").map(parseCard));

describe("hand evaluation", () => {
  it("categories", () => {
    expect(ev("As Ks Qs Js Ts 2c 3d").name).toBe("Straight flush");
    expect(ev("As Ks Qs Js Ts 2c 3d").description).toBe("Royal flush");
    expect(ev("9c 9d 9h 9s 2c 3d 4h").name).toBe("Four of a kind");
    expect(ev("9c 9d 9h 2s 2c 3d 4h").name).toBe("Full house");
    expect(ev("2h 7h 9h Jh Kh 2c 3d").name).toBe("Flush");
    expect(ev("5c 6d 7h 8s 9c Kd 2h").name).toBe("Straight");
    expect(ev("Ac 2d 3h 4s 5c Kd 9h").description).toBe("Straight, Five high");
    expect(ev("9c 9d 9h 2s 3c 5d Kh").name).toBe("Three of a kind");
    expect(ev("9c 9d 2h 2s 3c 5d Kh").name).toBe("Two pair");
    expect(ev("9c 9d 2h 4s 6c Jd Kh").name).toBe("One pair");
    expect(ev("9c 7d 2h 4s 6c Jd Kh").name).toBe("High card");
  });

  it("orders hands and kickers", () => {
    const order = [
      "9c 7d 2h 4s 6c Jd Kh",
      "9c 7d 2h 4s 6c Jd Ah",
      "2c 2d 3h 4s 6c Jd Kh",
      "Ac Ad 3h 4s 6c Jd Kh",
      "Ac Ad Kh Ks 6c Jd 2h",
      "2c 2d 2h 4s 6c Jd Kh",
      "Ac 2d 3h 4s 5c Kd 9h",
      "6c 2d 3h 4s 5c Kd 9h",
      "2h 7h 9h Jh Kh 2c 3d",
      "2c 2d 2h 3s 3c Jd Kh",
      "2c 2d 2h 2s 3c Jd Kh",
      "Ah 2h 3h 4h 5h Kd 9c",
      "As Ks Qs Js Ts 2c 3d",
    ].map(ev);
    for (let i = 1; i < order.length; i++) expect(compareHands(order[i]!, order[i - 1]!)).toBeGreaterThan(0);
  });

  it("ties and best-five selection", () => {
    const a = ev("Ac Kd 2h 2s 7c 8d 9h");
    const b = ev("Ad Kc 2c 2d 7h 8s 9c");
    expect(compareHands(a, b)).toBe(0);
    // Board plays: both use the board straight.
    expect(compareHands(ev("2c 3d 5h 6s 7c 8d 9h"), ev("2d 4c 5h 6s 7c 8d 9h"))).toBe(0);
    expect(ev("2c 3d 5h 6s 7c 8d 9h").cards.length).toBe(5);
    expect(() => evaluateHand([0, 1, 2, 3])).toThrow();
    expect(() => evaluateHand([0, 0, 2, 3, 4])).toThrow();
  });
});
