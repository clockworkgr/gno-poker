package poker

import (
	"strings"
	"testing"

	"gno.land/p/demo/poker/cards"
)

func threeHanded(cur realm, t *testing.T, prefix string) (uint64, []*player) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	ps := []*player{newPlayer(prefix+"-a", true), newPlayer(prefix+"-b", false), newPlayer(prefix+"-c", false)}
	join(cross(cur), t, tid, ps[0], 1000, 0)
	join(cross(cur), t, tid, ps[1], 1001, 0)
	join(cross(cur), t, tid, ps[2], 1500, 0)
	return tid, ps
}

// playOut finishes betting and dealing by checking down.
func (g *game) playOut(cur realm) {
	for {
		ph := g.phase()
		switch {
		case strings.HasPrefix(ph, "deal_"):
			g.deal(cross(cur))
		case ph == "preflop" || ph == "flop" || ph == "turn" || ph == "river":
			g.checkAround(cross(cur))
		default:
			return
		}
	}
}

func TestWrongCardKeyConvictedAtReveal(cur realm, t *testing.T) {
	tid, ps := threeHanded(cross(cur), t, "wk")
	g := newGame(cross(cur), t, tid, ps, "wk")
	start := g.startStacks()
	g.shuffleAndRekey(cross(cur))
	g.share(cross(cur), 0)
	// Player 1 publishes a wrong key for position 0.
	pos := g.owed("deal_hole", 1)
	keys := g.keysHex(1, pos)
	keys = strings.Repeat("ab", 32) + keys[64:]
	doShare(cross(cur), t, g.ps[1].actor(), tid, g.handNo, keys, "")
	g.share(cross(cur), 2)
	g.playOut(cross(cur))
	g.reveal(cross(cur), 0)
	g.reveal(cross(cur), 1)
	g.expectPhase("done")
	r := g.hand().Result
	if len(r.Convicted) != 1 || r.Convicted[0] != 1 {
		t.Fatalf("convicted %v", r.Convicted)
	}
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{1}))
}

func TestLastShufflerCheatConvicted(cur realm, t *testing.T) {
	tid, ps := threeHanded(cross(cur), t, "ls")
	g := newGame(cross(cur), t, tid, ps, "ls")
	start := g.startStacks()
	g.submitShuffle(cross(cur), 0, nil)
	g.submitShuffle(cross(cur), 1, nil)
	// The last shuffler applies an extra permutation on top of its seed's.
	g.submitShuffle(cross(cur), 2, func(d [][]byte) [][]byte {
		d[0], d[5] = d[5], d[0]
		d[7], d[9] = d[9], d[7]
		return d
	})
	for j := 0; j < 3; j++ {
		g.submitRekey(cross(cur), j, nil)
	}
	g.playOut(cross(cur))
	g.revealAll(cross(cur))
	g.expectPhase("challenge")
	kind, accused, index := g.findCheat()
	if kind != "shuffle" || accused != 2 || index != 0 {
		t.Fatalf("findCheat: %s %d %d", kind, accused, index)
	}
	// An invalid proof aborts and changes nothing.
	in, inP, out, outP := g.challengeArgs(kind, accused, index)
	bad := inP[:10] + "0" + inP[11:]
	if bad == inP {
		bad = inP[:10] + "1" + inP[11:]
	}
	doChallenge(cross(cur), t, g.ps[0].actor(), tid, g.handNo, accused, kind, index, in, bad, out, outP, 0, "invalid input proof")
	doChallenge(cross(cur), t, g.ps[0].actor(), tid, g.handNo, accused, kind, index+1, in, inP, out, outP, 0, "invalid")
	doChallenge(cross(cur), t, g.ps[2].actor(), tid, g.handNo, accused, kind, index, in, inP, out, outP, 0, "cannot challenge yourself")
	doChallenge(cross(cur), t, g.ps[0].actor(), tid, g.handNo, accused, kind, index, in, inP, out, outP, 99, "must equal the challenge bond")
	g.challenge(cross(cur), 0, kind, accused, index, 0, "")
	g.expectPhase("done")
	r := g.hand().Result
	if len(r.Convicted) != 1 || r.Convicted[0] != 2 || len(r.Challenges) != 1 || !r.Challenges[0].Guilty {
		t.Fatal("last shuffler must be convicted")
	}
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{2}))
}

func TestBadRekeyConvicted(cur realm, t *testing.T) {
	tid, ps := threeHanded(cross(cur), t, "br")
	g := newGame(cross(cur), t, tid, ps, "br")
	start := g.startStacks()
	for j := 0; j < 3; j++ {
		g.submitShuffle(cross(cur), j, nil)
	}
	g.submitRekey(cross(cur), 0, nil)
	// Player 1 uses the key of position 6 on position 5.
	seed := g.seeds[1]
	g.submitRekey(cross(cur), 1, func(d [][]byte) [][]byte {
		prev := g.passes[3]
		d[5] = pow(pow(prev[5], invExp(cards.ShuffleKey(seed))), cards.CardKey(seed, 6))
		return d
	})
	g.submitRekey(cross(cur), 2, nil)
	g.playOut(cross(cur))
	g.revealAll(cross(cur))
	kind, accused, index := g.findCheat()
	if kind != "rekey" || accused != 1 || index != 5 {
		t.Fatalf("findCheat: %s %d %d", kind, accused, index)
	}
	// Attached bond is returned to the challenger on conviction.
	challenger := g.ps[2].actor()
	bal := balanceOf(challenger)
	g.challenge(cross(cur), 2, kind, accused, index, 100, "")
	if balanceOf(challenger)-bal != 100 {
		t.Fatal("attached bond not returned")
	}
	eqStacks(t, g.stacks(), expectedPenalty(start, []int{1}))
}

func TestFalseChallengeLosesBond(cur realm, t *testing.T) {
	tid, ps := threeHanded(cross(cur), t, "fc")
	g := newGame(cross(cur), t, tid, ps, "fc")
	g.playToShowdown(cross(cur))
	g.revealAll(cross(cur))
	if kind, _, _ := g.findCheat(); kind != "" {
		t.Fatal("honest hand has no cheat")
	}
	before := g.stacks()
	// Bond from the table stack.
	g.challenge(cross(cur), 0, "shuffle", 1, 3, 0, "")
	// Attached bond, on the first player's shuffle against the canonical deck.
	g.challenge(cross(cur), 1, "shuffle", 0, 17, 100, "")
	// Rekey of the first rekeyer, input is the last shuffle pass.
	g.challenge(cross(cur), 2, "rekey", 0, 9, 0, "")
	g.expectPhase("challenge")
	want := []int64{before[0] - 100 + 100 + 100, before[1] + 100, before[2] - 100}
	eqStacks(t, g.stacks(), want)
	r := g.hand().Result
	if len(r.Challenges) != 3 || r.Challenges[0].Guilty || r.Challenges[1].Guilty || r.Challenges[2].Guilty {
		t.Fatal("challenges must be recorded as not guilty")
	}
	credits := r.Credits
	g.acceptAll(cross(cur))
	for j := range want {
		want[j] += credits[j]
	}
	eqStacks(t, g.stacks(), want)
	// The window is closed now.
	g.challenge(cross(cur), 0, "shuffle", 1, 3, 0, "hand is over")
}

func TestStaleHandAndTurnChecks(cur realm, t *testing.T) {
	resetState()
	tid := doCreateTable(cross(cur), t, 3)
	a, b, c := newPlayer("st-a", true), newPlayer("st-b", false), newPlayer("st-c", false)
	join(cross(cur), t, tid, a, 1000, 0)
	join(cross(cur), t, tid, b, 1000, 0)
	g := newGame(cross(cur), t, tid, []*player{a, b}, "st1")
	join(cross(cur), t, tid, c, 1000, 0)
	commit := g.commit(1)
	deck := deckB64(shufflePass(tCanon, g.seeds[1]))
	doShuffle(cross(cur), t, g.ps[1].actor(), tid, g.handNo, commit, deck, "not this player's turn")
	doShuffle(cross(cur), t, c.owner, tid, g.handNo, commit, deck, "caller is not in this hand")
	doShuffle(cross(cur), t, anyone, tid, g.handNo, commit, deck, "caller is not seated")
	doShuffle(cross(cur), t, g.ps[0].actor(), tid, g.handNo+1, commit, deck, "stale")
	doShuffle(cross(cur), t, g.ps[0].actor(), tid, g.handNo, "AB", deck, "commit")
	// Malformed decks.
	dup := shufflePass(tCanon, g.seeds[0])
	dup[3] = dup[4]
	doShuffle(cross(cur), t, g.ps[0].actor(), tid, g.handNo, g.commit(0), deckB64(dup), "duplicate deck element")
	doShuffle(cross(cur), t, g.ps[0].actor(), tid, g.handNo, g.commit(0), deckB64(dup[:51]), "13312 bytes")
	g.shuffleAndRekey(cross(cur))
	doAct(cross(cur), t, g.ps[0].actor(), tid, g.handNo, "check", 0, "not in a betting phase")
	g.deal(cross(cur))
	doShare(cross(cur), t, g.ps[0].actor(), tid, g.handNo, "", "not in a deal phase")
	doAct(cross(cur), t, g.ps[1].actor(), tid, g.handNo, "check", 0, "not this player's turn")
	doReveal(cross(cur), t, g.ps[0].actor(), tid, g.handNo, cards.EncodeHex(g.seeds[0]), "not in reveal phase")
	g.playOut(cross(cur))
	// A seed that does not match the commitment is refused.
	doReveal(cross(cur), t, g.ps[0].actor(), tid, g.handNo, cards.EncodeHex(g.seeds[1]), "does not match commitment")
	g.revealAll(cross(cur))
	g.acceptAll(cross(cur))
	old := g.handNo

	g2 := newGame(cross(cur), t, tid, []*player{a, b, c}, "st2")
	if g2.n() != 3 {
		t.Fatal("late joiner plays the next hand")
	}
	doShuffle(cross(cur), t, g2.ps[0].actor(), tid, old, g2.commit(0), deckB64(shufflePass(tCanon, g2.seeds[0])), "stale")
	doAccept(cross(cur), t, g2.ps[0].actor(), tid, old, "stale")
	doReveal(cross(cur), t, g2.ps[0].actor(), tid, old, cards.EncodeHex(g.seeds[0]), "stale")
	// GetDeck is empty until the new hand's first pass.
	if GetDeck(tid) != "" {
		t.Fatal("deck of the previous hand must not be served")
	}
	g2.submitShuffle(cross(cur), 0, nil)
	if GetDeck(tid) != deckB64(g2.passes[0]) {
		t.Fatal("GetDeck")
	}
}
