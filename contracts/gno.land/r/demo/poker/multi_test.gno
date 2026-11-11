package poker

import (
	"testing"
)

// bestOf returns the hand indices among cand with the best score.
func (g *game) bestOf(cand []int) []int {
	best := -1
	for _, j := range cand {
		if s := g.scoreOf(j); s > best {
			best = s
		}
	}
	out := []int{}
	for _, j := range cand {
		if g.scoreOf(j) == best {
			out = append(out, j)
		}
	}
	return out
}

// split divides amount among winners, odd chips to the first (hand indices
// ascending is clockwise from the button for 3+ players).
func split(won []int64, winners []int, amount int64) {
	share := amount / int64(len(winners))
	for _, w := range winners {
		won[w] += share
	}
	won[winners[0]] += amount - share*int64(len(winners))
}

func TestThreePlayersAndButtonRotation(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 4)
	a := newPlayer("m-a", false)
	b := newPlayer("m-b", true)
	c := newPlayer("m-c", false)
	d := newPlayer("m-d", false)
	for _, p := range []*player{a, b, c, d} {
		join(cross(cur), t, tid, p, 2000, 0)
	}
	doSitOut(cross(cur), t, d.owner, tid, "")

	g := newGame(cross(cur), t, tid, []*player{a, b, c, d}, "m1")
	tb := tables[tid-1]
	if tb.Button != 0 || g.n() != 3 {
		t.Fatalf("button %d, players %d", tb.Button, g.n())
	}
	// Order: small blind (seat 1), big blind (seat 2), button (seat 0).
	if g.ps[0] != b || g.ps[1] != c || g.ps[2] != a {
		t.Fatal("hand order must start with the small blind")
	}
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.expectPhase("preflop")
	// Under the gun is the button with three players.
	g.act(cross(cur), 2, "raise", 60)
	doAct(cross(cur), t, b.actor(), tid, g.handNo, "raise", 90, "raise below minimum")
	g.act(cross(cur), 0, "call", 0)
	g.act(cross(cur), 1, "raise", 140)
	g.act(cross(cur), 2, "fold", 0)
	g.act(cross(cur), 0, "call", 0)
	g.expectPhase("deal_flop")
	g.deal(cross(cur))
	if g.hand().turnIndex() != 0 {
		t.Fatal("small blind acts first postflop")
	}
	g.act(cross(cur), 0, "check", 0)
	g.act(cross(cur), 1, "raise", 100)
	g.act(cross(cur), 0, "call", 0)
	g.deal(cross(cur))
	g.checkAround(cross(cur))
	g.deal(cross(cur))
	g.checkAround(cross(cur))
	// The folded player still reveals.
	g.revealAll(cross(cur))
	g.expectPhase("challenge")
	won := make([]int64, 3)
	split(won, g.bestOf([]int{0, 1}), 60+240+240)
	h := g.hand()
	for j := range won {
		if h.Result.Credits[j] != won[j] {
			t.Fatalf("credits %v, want %v", h.Result.Credits, won)
		}
	}
	before := g.stacks()
	doFinalize(cross(cur), t, anyone, tid, "challenge window still open")
	testing.SkipHeights(6)
	doFinalize(cross(cur), t, anyone, tid, "")
	after := g.stacks()
	for j := range after {
		if after[j] != before[j]+won[j] {
			t.Fatalf("stacks %v -> %v, won %v", before, after, won)
		}
	}

	// Hand 2: d sits in, the button moves to seat 1, everyone folds to the
	// big blind and the remaining deals are skipped.
	doSitIn(cross(cur), t, d.owner, tid, "")
	g = newGame(cross(cur), t, tid, []*player{a, b, c, d}, "m2")
	if tb.Button != 1 || g.n() != 4 || g.ps[0] != c || g.ps[1] != d || g.ps[2] != a || g.ps[3] != b {
		t.Fatalf("button %d", tb.Button)
	}
	start := g.startStacks()
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.act(cross(cur), 2, "fold", 0)
	g.act(cross(cur), 3, "fold", 0)
	g.act(cross(cur), 0, "fold", 0)
	g.expectPhase("reveal")
	g.revealAll(cross(cur))
	testing.SkipHeights(6)
	// Timeout in the challenge window finalizes too.
	doTimeout(cross(cur), t, anyone, tid, "")
	g.expectPhase("done")
	want := []int64{start[0] - 10, start[1] + 10, start[2], start[3]}
	eqStacks(t, g.stacks(), want)
}

func TestAllInSidePots(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	p0 := newPlayer("s-0", false)
	p1 := newPlayer("s-1", false)
	p2 := newPlayer("s-2", false)
	join(cross(cur), t, tid, p0, 400, 0)
	join(cross(cur), t, tid, p1, 800, 0)
	join(cross(cur), t, tid, p2, 1200, 0)
	g := newGame(cross(cur), t, tid, []*player{p0, p1, p2}, "side")
	// Order: p1 (SB, 800), p2 (BB, 1200), p0 (button, 400).
	if g.ps[0] != p1 || g.ps[1] != p2 || g.ps[2] != p0 {
		t.Fatal("unexpected order")
	}
	g.shuffleAndRekey(cross(cur))
	g.deal(cross(cur))
	g.act(cross(cur), 2, "raise", 400)
	g.act(cross(cur), 0, "raise", 800)
	g.act(cross(cur), 1, "call", 0)
	// Betting closed: flop, turn and river deals are skipped.
	g.expectPhase("reveal")
	if g.hand().Bet.Players[1].Stack != 400 {
		t.Fatal("big blind keeps 400 behind")
	}
	g.revealAll(cross(cur))
	won := make([]int64, 3)
	split(won, g.bestOf([]int{0, 1, 2}), 1200)
	split(won, g.bestOf([]int{0, 1}), 800)
	for j := range won {
		if g.hand().Result.Credits[j] != won[j] {
			t.Fatalf("credits %v, want %v", g.hand().Result.Credits, won)
		}
	}
	g.acceptAll(cross(cur))
	eqStacks(t, g.stacks(), []int64{won[0], 400 + won[1], won[2]})
	// Busted players stay seated but are not dealt in.
	live := 0
	for _, st := range g.stacks() {
		if st >= 20 {
			live++
		}
	}
	if live >= 2 {
		g = newGame(cross(cur), t, tid, []*player{p0, p1, p2}, "side2")
		if g.n() != live {
			t.Fatalf("dealt %d players, %d have chips", g.n(), live)
		}
	}
}

func TestSeatManagement(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	a := newPlayer("j-a", true)
	b := newPlayer("j-b", false)
	c := newPlayer("j-c", false)
	d := newPlayer("j-d", false)

	doJoin(cross(cur), t, a.owner, tid, "", 300, 0, "buy-in must be between")
	doJoin(cross(cur), t, a.owner, tid, "", 5000, 0, "buy-in must be between")
	doJoin(cross(cur), t, a.owner, tid, "", 1000, 100, "gas allowance needs a session")
	doJoin(cross(cur), t, a.owner, tid, "notanaddress", 1000, 0, "invalid session address")

	// Gas allowance forwarding.
	before := balanceOf(a.sess)
	join(cross(cur), t, tid, a, 1000, 5000)
	if balanceOf(a.sess)-before != 5000 || stackOf(tid, a) != 1000 {
		t.Fatalf("allowance not forwarded: %d, stack %d", balanceOf(a.sess)-before, stackOf(tid, a))
	}
	doJoin(cross(cur), t, a.owner, tid, "", 1000, 0, "already seated")
	doJoin(cross(cur), t, b.owner, tid, a.sess.String(), 1000, 0, "session address already used")
	join(cross(cur), t, tid, b, 1000, 0)

	// The session key acts but cannot withdraw.
	doLeave(cross(cur), t, a.sess, tid, "only the seat owner can leave")
	doTopUp(cross(cur), t, a.sess, tid, 100, "only the seat owner can top up")
	doTopUp(cross(cur), t, a.owner, tid, 3001, "stack would exceed max buy-in")
	doTopUp(cross(cur), t, a.owner, tid, 500, "")
	if stackOf(tid, a) != 1500 {
		t.Fatal("top up")
	}
	doStartHand(cross(cur), t, c.owner, tid, "caller is not seated")

	g := newGame(cross(cur), t, tid, []*player{a, b}, "seat1")
	doStartHand(cross(cur), t, a.sess, tid, "a hand is in progress")
	doTopUp(cross(cur), t, a.owner, tid, 100, "cannot top up during a hand")
	// Joining during a hand waits for the next one.
	join(cross(cur), t, tid, c, 600, 0)
	ci := tables[tid-1].seatOf(c.owner)
	if !tables[tid-1].Seats[ci].Waiting {
		t.Fatal("late joiner must wait")
	}
	doJoin(cross(cur), t, d.owner, tid, "", 600, 0, "table is full")
	// Leaving during a hand is deferred.
	doLeave(cross(cur), t, b.owner, tid, "")
	if stackOf(tid, b) < 0 {
		t.Fatal("leaver must stay until the hand ends")
	}
	// The waiting player can leave at once.
	cBal := balanceOf(c.owner)
	doLeave(cross(cur), t, c.owner, tid, "")
	if balanceOf(c.owner)-cBal != 600 || stackOf(tid, c) != -1 {
		t.Fatal("waiting player not paid out")
	}
	g.playToShowdown(cross(cur))
	g.revealAll(cross(cur))
	bj := 0
	if g.ps[1] == b {
		bj = 1
	}
	credit := g.hand().Result.Credits[bj]
	bBal := balanceOf(b.owner)
	bStack := stackOf(tid, b)
	g.acceptAll(cross(cur))
	if stackOf(tid, b) != -1 || balanceOf(b.owner)-bBal != bStack+credit {
		t.Fatal("leaver not paid at the end of the hand")
	}
	// Only one player left.
	doStartHand(cross(cur), t, a.owner, tid, "need at least 2 active players")

	// A busted or sitting-out player does not count.
	join(cross(cur), t, tid, d, 400, 0)
	doSitOut(cross(cur), t, d.owner, tid, "")
	doStartHand(cross(cur), t, d.owner, tid, "need at least 2 active players")
	doSitIn(cross(cur), t, d.owner, tid, "")
	g = newGame(cross(cur), t, tid, []*player{a, d}, "seat2")
	if g.n() != 2 {
		t.Fatal("two players")
	}
}
