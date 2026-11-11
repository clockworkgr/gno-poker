package poker

import (
	"strings"
	"testing"

	"gno.land/p/demo/poker/cards"
	"gno.land/p/demo/poker/holdem"
)

func TestHeadsUpShowdown(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 6)
	alice := newPlayer("hu-alice", true)
	bob := newPlayer("hu-bob", false)
	join(cross(cur), t, tid, alice, 1000, 0)
	join(cross(cur), t, tid, bob, 1000, 0)

	g := newGame(cross(cur), t, tid, []*player{alice, bob}, "hu")
	h := g.hand()
	// Heads-up: the button is the small blind and hand index 0.
	if h.Players[0].Seat != tables[tid-1].Button {
		t.Fatal("button must be hand index 0 heads-up")
	}
	if h.Bet.Players[0].Contributed != 10 || h.Bet.Players[1].Contributed != 20 {
		t.Fatal("blinds not posted")
	}
	g.shuffleAndRekey(cross(cur))
	if len(h.Roots) != 4 {
		t.Fatalf("roots %d", len(h.Roots))
	}
	// The stored deck is the last pass and every root matches the passes.
	if GetDeck(tid) != deckB64(g.passes[3]) {
		t.Fatal("GetDeck is not the latest pass")
	}
	for s, d := range g.passes {
		if h.Roots[s] != cards.EncodeHex(cards.MerkleRoot(joinDeck(d))) {
			t.Fatalf("root %d mismatch", s)
		}
	}
	g.deal(cross(cur))
	g.expectPhase("preflop")
	if h.turnIndex() != 0 {
		t.Fatal("heads-up: button acts first preflop")
	}
	g.act(cross(cur), 0, "raise", 60)
	g.act(cross(cur), 1, "call", 0)
	g.expectPhase("deal_flop")
	g.deal(cross(cur))
	g.expectPhase("flop")
	if h.turnIndex() != 1 {
		t.Fatal("heads-up: big blind acts first postflop")
	}
	g.act(cross(cur), 1, "check", 0)
	g.act(cross(cur), 0, "raise", 100)
	g.act(cross(cur), 1, "call", 0)
	g.deal(cross(cur))
	g.checkAround(cross(cur))
	g.deal(cross(cur))
	g.checkAround(cross(cur))
	g.revealAll(cross(cur))
	g.expectPhase("challenge")

	// Cards opened off-chain with the published keys match the realm's
	// seed-derived cards.
	for _, pos := range []int{0, 3, 4, 8} {
		if c := g.card(pos); c != h.Cards[pos] {
			t.Fatalf("position %d: decrypted %d, realm %d", pos, c, h.Cards[pos])
		}
	}
	board := h.Cards[4:9]
	s0 := holdem.Evaluate(append([]int{h.Cards[0], h.Cards[1]}, board...))
	s1 := holdem.Evaluate(append([]int{h.Cards[2], h.Cards[3]}, board...))
	a0, a1 := int64(0), int64(0)
	switch {
	case s0 > s1:
		a0 = 320
	case s1 > s0:
		a1 = 320
	default:
		a0, a1 = 160, 160
	}
	if h.Result.Credits[0] != a0 || h.Result.Credits[1] != a1 {
		t.Fatalf("credits %v, want %d %d", h.Result.Credits, a0, a1)
	}
	js := GetTable(tid)
	if !strings.Contains(js, "\"phase\":\"challenge\"") || !strings.Contains(js, "\"deckSeq\":4") {
		t.Fatalf("GetTable: %s", js)
	}
	g.acceptAll(cross(cur))
	p0 := g.ps[0]
	p1 := g.ps[1]
	if stackOf(tid, p0) != 840+a0 || stackOf(tid, p1) != 840+a1 {
		t.Fatalf("stacks %d %d", stackOf(tid, p0), stackOf(tid, p1))
	}
	if !strings.Contains(Render(""), "| [") || !strings.Contains(Render(itoa(int(tid))), "Board:") {
		t.Fatal("render")
	}
	println(GetTable(tid))
}

// Regression: GetTable exposes whether a player may still raise, so clients do
// not offer a raise after a short all-in that did not reopen the betting.
func TestCanRaiseAfterShortAllIn(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	a := newPlayer("cr-a", false)
	b := newPlayer("cr-b", false)
	c := newPlayer("cr-c", false)
	join(cross(cur), t, tid, a, 2000, 0)
	join(cross(cur), t, tid, b, 400, 0)
	join(cross(cur), t, tid, c, 2000, 0)
	g := newGame(cross(cur), t, tid, []*player{a, b, c}, "cr")
	if g.ps[0] != b || g.ps[2] != a {
		t.Fatal("unexpected hand order")
	}
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.expectPhase("preflop")
	if !strings.Contains(GetTable(tid), "\"canRaise\":true") {
		t.Fatal("first actor must be able to raise")
	}
	g.act(cross(cur), 2, "raise", 300) // button opens to 300 (min raise 280)
	g.act(cross(cur), 0, "raise", 400) // small blind short all-in (+100)
	g.act(cross(cur), 1, "call", 0)
	js := GetTable(tid)
	// The button faces only a short all-in: it may call or fold, not raise.
	js = js[strings.Index(js, "\"hand\":"):]
	marker := "\"seat\":0,\"owner\":\"" + a.owner.String() + "\""
	i := strings.Index(js, marker)
	if i < 0 {
		t.Fatalf("button player not found: %s", js)
	}
	rest := js[i:]
	if !strings.Contains(rest[:strings.Index(rest, "}")], "\"canRaise\":false") {
		t.Fatalf("button must not be able to raise: %s", rest)
	}
	doAct(cross(cur), t, a.actor(), tid, g.handNo, "raise", 1000, "betting is not reopened")
}
