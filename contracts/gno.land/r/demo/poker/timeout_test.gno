package poker

import (
	"testing"
)

func TestBettingTimeoutAndDealStall(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 2)
	a := newPlayer("t-a", true)
	b := newPlayer("t-b", false)
	join(cross(cur), t, tid, a, 1000, 0)
	join(cross(cur), t, tid, b, 1000, 0)

	// Facing the big blind the small blind cannot check: auto-fold.
	g := newGame(cross(cur), t, tid, []*player{a, b}, "bt1")
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	doTimeout(cross(cur), t, anyone, tid, "deadline not reached")
	testing.SkipHeights(11)
	doTimeout(cross(cur), t, anyone, tid, "")
	if !g.hand().Bet.Players[0].Folded {
		t.Fatal("small blind should be folded")
	}
	g.expectPhase("reveal")
	g.revealAll(cross(cur))
	g.acceptAll(cross(cur))
	eqStacks(t, g.stacks(), []int64{990, 1010})

	// Big blind option: auto-check, then a key-share stall.
	g = newGame(cross(cur), t, tid, []*player{a, b}, "bt2")
	start := g.startStacks()
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.act(cross(cur), 0, "call", 0)
	testing.SkipHeights(11)
	doTimeout(cross(cur), t, anyone, tid, "")
	g.expectPhase("deal_flop")
	g.share(cross(cur), 0)
	testing.SkipHeights(11)
	ownerBal := balanceOf(g.ps[1].owner)
	doTimeout(cross(cur), t, anyone, tid, "")
	g.expectPhase("done")
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{1}))
	if balanceOf(g.ps[1].owner) != ownerBal {
		t.Fatal("staller must not be paid")
	}
	r := g.hand().Result
	if !r.Aborted || len(r.Stallers) != 1 || r.Stallers[0] != 1 {
		t.Fatal("result must record the staller")
	}
}

func TestShuffleStall(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	ps := []*player{newPlayer("ss-a", false), newPlayer("ss-b", false), newPlayer("ss-c", false)}
	join(cross(cur), t, tid, ps[0], 1000, 0)
	join(cross(cur), t, tid, ps[1], 1001, 0)
	join(cross(cur), t, tid, ps[2], 1000, 0)
	g := newGame(cross(cur), t, tid, ps, "ss")
	start := g.startStacks()
	g.submitShuffle(cross(cur), 0, nil)
	testing.SkipHeights(10)
	doTimeout(cross(cur), t, anyone, tid, "deadline not reached")
	testing.SkipHeights(1)
	doTimeout(cross(cur), t, anyone, tid, "")
	// 1001 split two ways: the odd chip goes to the lowest hand index.
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{1}))
}

func TestRekeyStall(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 2)
	a, b := newPlayer("rs-a", false), newPlayer("rs-b", false)
	join(cross(cur), t, tid, a, 700, 0)
	join(cross(cur), t, tid, b, 900, 0)
	g := newGame(cross(cur), t, tid, []*player{a, b}, "rs")
	start := g.startStacks()
	g.submitShuffle(cross(cur), 0, nil)
	g.submitShuffle(cross(cur), 1, nil)
	g.submitRekey(cross(cur), 0, nil)
	testing.SkipHeights(11)
	doTimeout(cross(cur), t, anyone, tid, "")
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{1}))
}

func TestRevealStallByFoldedPlayer(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	ps := []*player{newPlayer("rv-a", false), newPlayer("rv-b", false), newPlayer("rv-c", false)}
	for _, p := range ps {
		join(cross(cur), t, tid, p, 1000, 0)
	}
	g := newGame(cross(cur), t, tid, ps, "rv")
	start := g.startStacks()
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.act(cross(cur), 2, "fold", 0)
	g.checkAround(cross(cur))
	// The folded player still owes flop keys.
	g.share(cross(cur), 0)
	g.share(cross(cur), 1)
	if len(g.hand().Owing) != 3 || !g.hand().Owing[2] {
		t.Fatal("folded player must owe keys")
	}
	g.share(cross(cur), 2)
	for g.phase() != "reveal" {
		if g.phase() == "deal_turn" || g.phase() == "deal_river" {
			g.deal(cross(cur))
		} else {
			g.checkAround(cross(cur))
		}
	}
	g.reveal(cross(cur), 0)
	g.reveal(cross(cur), 1)
	testing.SkipHeights(11)
	doTimeout(cross(cur), t, anyone, tid, "")
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{2}))
}

func TestEveryoneStallsKeepsStacks(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 2)
	a, b := newPlayer("es-a", false), newPlayer("es-b", false)
	join(cross(cur), t, tid, a, 700, 0)
	join(cross(cur), t, tid, b, 900, 0)
	g := newGame(cross(cur), t, tid, []*player{a, b}, "es")
	g.shuffleAndRekey(cross(cur))
	aBal, bBal := balanceOf(a.owner), balanceOf(b.owner)
	testing.SkipHeights(11)
	doTimeout(cross(cur), t, anyone, tid, "")
	// With nobody left to receive a penalty, stallers are refunded and removed.
	if balanceOf(a.owner)-aBal != 700 || balanceOf(b.owner)-bBal != 900 {
		t.Fatal("stallers must get their stacks back when nobody else is in the hand")
	}
	if stackOf(tid, a) != -1 || stackOf(tid, b) != -1 {
		t.Fatal("stallers removed")
	}
}
