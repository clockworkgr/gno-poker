package holdem

import (
	"strings"
	"testing"
)

// parse turns "As Kd 2c" into card indices.
func parse(s string) []int {
	out := []int{}
	for _, f := range strings.Fields(s) {
		r := strings.IndexByte("23456789TJQKA", f[0])
		su := strings.IndexByte("cdhs", f[1])
		if r < 0 || su < 0 {
			panic("bad card " + f)
		}
		out = append(out, su*13+r)
	}
	return out
}

func score(s string) int { return Evaluate(parse(s)) }

func TestCategories(t *testing.T) {
	cases := []struct {
		hand string
		cat  int
	}{
		{"As Ks Qs Js Ts 2c 3d", StraightFlush},
		{"Ah 2h 3h 4h 5h Kc Kd", StraightFlush},
		{"9c 9d 9h 9s Ac 2d 3h", Quads},
		{"Kc Kd Kh 2s 2c 7d 8h", FullHouse},
		{"Kc Kd Kh 2s 2c 2d 8h", FullHouse},
		{"Ac 9c 7c 4c 2c Kd Kh", Flush},
		{"Ac 2d 3h 4s 5c Kd Qh", Straight},
		{"Tc Jd Qh Ks Ac 2d 3h", Straight},
		{"7c 7d 7h As Kc 2d 4h", Trips},
		{"7c 7d 5h 5s Kc Kd 4h", TwoPair},
		{"7c 7d 5h 9s Kc 2d 4h", OnePair},
		{"Ac 9d 7h 5s 3c 2d Th", HighCard},
	}
	for _, c := range cases {
		got := Category(score(c.hand))
		if got != c.cat {
			t.Errorf("%s: category %s, want %s", c.hand, categoryNames[got], categoryNames[c.cat])
		}
	}
}

func TestOrdering(t *testing.T) {
	// Each hand beats the next one.
	order := []string{
		"As Ks Qs Js Ts",
		"6h 2h 3h 4h 5h",
		"Ah 2h 3h 4h 5h", // steel wheel
		"Ac Ad Ah As Kc",
		"Ac Ad Ah As Qc",
		"Kc Kd Kh As Ac",
		"Kc Kd Kh Qs Qc",
		"Ac Kc Qc Jc 9c",
		"Ac Kc Qc Jc 8c",
		"Tc Jd Qh Ks Ac",
		"6c 2d 3h 4s 5c",
		"Ac 2d 3h 4s 5c", // wheel is the lowest straight
		"Qc Qd Qh Ac 2d",
		"Qc Qd Qh Kc 3d",
		"Ac Ad Kc Kd 2h",
		"Ac Ad Qc Qd Kh",
		"Ac Ad Qc Qd Jh",
		"Ac Ad Kc Qd Jh",
		"Ac Ad Kc Qd Th",
		"Kc Kd Ac Qd Jh",
		"Ac Kd Qc Jd 9h",
		"Ac Kd Qc Jd 8h",
		"7c 5d 4c 3d 2h",
	}
	for i := 0; i+1 < len(order); i++ {
		if score(order[i]) <= score(order[i+1]) {
			t.Errorf("%q should beat %q", order[i], order[i+1])
		}
	}
}

func TestKickersAndTies(t *testing.T) {
	// Board plays: tie.
	if score("Ac Kd Qh Js 9c 2d 3h") != score("Ac Kd Qh Js 9c 4d 5h") {
		t.Error("board-playing hands should tie")
	}
	// Kicker decides.
	if score("Ac Ad 9h 7s 4c Kd 2h") <= score("Ac Ad 9h 7s 4c Qd 2h") {
		t.Error("K kicker should win")
	}
	// Fifth kicker ignored beyond five cards.
	if score("Ac Ad Kh Qs Jc 3d 2h") != score("Ac Ad Kh Qs Jc 4d 2h") {
		t.Error("sixth card must not count")
	}
	// Three pairs: best two plus best kicker.
	if score("Ac Ad Kh Ks Qc Qd 2h") != score("Ac Ad Kh Ks Qc 3d 2h") {
		t.Error("third pair is a kicker")
	}
	// Flush beats straight on the same board.
	if score("9h Th Jh Qs Kh 2h 3c") <= score("9h Td Jh Qs Kh 2c 3c") {
		t.Error("flush should beat straight")
	}
	// Two trips make a full house with the higher trips.
	if score("Kc Kd Kh 2s 2c 2d 8h") >= score("Kc Kd Kh 3s 3c 4d 8h") {
		t.Error("KKK33 should beat KKK22")
	}
	// Six-card straight uses the top.
	if score("2c 3d 4h 5s 6c 7d Kh") <= score("2c 3d 4h 5s 6c Qd Kh") {
		t.Error("7-high straight beats 6-high")
	}
}

func sum(xs []int64) int64 {
	t := int64(0)
	for _, x := range xs {
		t += x
	}
	return t
}

func TestSidePots(t *testing.T) {
	// A all-in 100, B all-in 300, C and D 500 each, E folded after 200.
	contrib := []int64{100, 300, 500, 500, 200}
	folded := []bool{false, false, false, false, true}
	pots := BuildPots(contrib, folded)
	if len(pots) != 3 {
		t.Fatalf("pots: %v", pots)
	}
	// main: 5*100 = 500; side1: 4*200 (B,C,D 200 each + E 100) = 700; side2: 2*200 = 400
	want := []int64{500, 700, 400}
	for i, p := range pots {
		if p.Amount != want[i] {
			t.Fatalf("pot %d = %d, want %d", i, p.Amount, want[i])
		}
	}
	if len(pots[0].Eligible) != 4 || len(pots[1].Eligible) != 3 || len(pots[2].Eligible) != 2 {
		t.Fatalf("eligibility: %v", pots)
	}
	// A has the best hand, then B, then C and D tie.
	scores := []int{100, 90, 50, 50, 0}
	won := Distribute(pots, scores, OddChipOrder(5))
	if won[0] != 500 || won[1] != 700 || won[2] != 200 || won[3] != 200 || won[4] != 0 {
		t.Fatalf("won %v", won)
	}
	if sum(won) != sum(contrib) {
		t.Fatal("chips not conserved")
	}
}

func TestOddChips(t *testing.T) {
	contrib := []int64{101, 101, 101}
	folded := []bool{false, false, true}
	pots := BuildPots(contrib, folded)
	won := Distribute(pots, []int{7, 7, 0}, OddChipOrder(3))
	if won[0] != 152 || won[1] != 151 {
		t.Fatalf("won %v", won)
	}
	// Heads-up: first clockwise from the button (index 0) is index 1.
	won = Distribute([]Pot{{Amount: 5, Eligible: []int{0, 1}}}, []int{5, 5}, OddChipOrder(2))
	if won[0] != 2 || won[1] != 3 {
		t.Fatalf("heads-up odd chip: %v", won)
	}
}

func TestUncalledBetReturns(t *testing.T) {
	// A bets 500, B all-in for 50 calls, C folded after 20.
	contrib := []int64{500, 50, 20}
	pots := BuildPots(contrib, []bool{false, false, true})
	won := Distribute(pots, []int{1, 9, 0}, OddChipOrder(3))
	if won[1] != 120 || won[0] != 450 {
		t.Fatalf("won %v pots %v", won, pots)
	}
}

func mustAct(t *testing.T, b *Betting, i int, action string, amount int64) {
	if err := b.Act(i, action, amount); err != nil {
		t.Fatalf("player %d %s %d: %v", i, action, amount, err)
	}
}

func mustFail(t *testing.T, b *Betting, i int, action string, amount int64) {
	if err := b.Act(i, action, amount); err == nil {
		t.Fatalf("player %d %s %d should fail", i, action, amount)
	}
}

func TestHeadsUpOrder(t *testing.T) {
	b := NewBetting([]int64{1000, 1000}, 5, 10)
	if b.Turn != 0 {
		t.Fatalf("heads-up preflop: button acts first, got %d", b.Turn)
	}
	mustAct(t, b, 0, "call", 0)
	if b.Turn != 1 {
		t.Fatal("big blind has the option")
	}
	mustAct(t, b, 1, "check", 0)
	if !b.StreetComplete() || b.Closed() {
		t.Fatal("preflop should be complete and open")
	}
	b.NextStreet()
	if b.Turn != 1 {
		t.Fatalf("heads-up postflop: big blind acts first, got %d", b.Turn)
	}
	mustFail(t, b, 1, "raise", 5) // below the big blind
	mustAct(t, b, 1, "raise", 10)
	mustAct(t, b, 0, "raise", 30)
	mustFail(t, b, 1, "raise", 40) // min re-raise is to 50
	mustAct(t, b, 1, "raise", 50)
	mustAct(t, b, 0, "call", 0)
	if !b.StreetComplete() || b.Pot() != 120 {
		t.Fatalf("pot %d", b.Pot())
	}
}

func TestMultiwayOrderAndMinRaise(t *testing.T) {
	b := NewBetting([]int64{1000, 1000, 1000, 1000}, 5, 10)
	if b.Turn != 2 {
		t.Fatalf("UTG should act first, got %d", b.Turn)
	}
	mustFail(t, b, 3, "call", 0)
	mustFail(t, b, 2, "check", 0)
	mustFail(t, b, 2, "raise", 15)
	mustAct(t, b, 2, "raise", 30) // raise by 20
	mustFail(t, b, 3, "raise", 45)
	mustAct(t, b, 3, "raise", 50) // raise by 20
	mustAct(t, b, 0, "fold", 0)
	mustAct(t, b, 1, "call", 0)
	mustAct(t, b, 2, "call", 0)
	if !b.StreetComplete() {
		t.Fatal("street should be complete")
	}
	b.NextStreet()
	if b.Turn != 1 {
		t.Fatalf("first live player left of the button acts first, got %d", b.Turn)
	}
	mustAct(t, b, 1, "check", 0)
	mustAct(t, b, 2, "check", 0)
	mustAct(t, b, 3, "check", 0)
	if !b.StreetComplete() {
		t.Fatal("checked around")
	}
}

func TestShortAllInDoesNotReopen(t *testing.T) {
	// Stacks: 0:1000, 1:1000, 2:130 (short)
	b := NewBetting([]int64{1000, 1000, 130}, 5, 10)
	mustAct(t, b, 2, "call", 0)
	mustAct(t, b, 0, "call", 0)
	mustAct(t, b, 1, "check", 0)
	b.NextStreet()
	mustAct(t, b, 0, "raise", 100) // bet 100
	mustAct(t, b, 1, "call", 0)
	mustAct(t, b, 2, "raise", 120) // all-in, +20 is not a full raise
	if !b.Players[2].AllIn {
		t.Fatal("player 2 should be all-in")
	}
	if b.CanRaise(0) {
		t.Fatal("short all-in must not reopen betting for the bettor")
	}
	mustFail(t, b, 0, "raise", 300)
	mustAct(t, b, 0, "call", 0)
	if b.CanRaise(1) {
		t.Fatal("short all-in must not reopen betting for the caller")
	}
	mustAct(t, b, 1, "call", 0)
	if !b.StreetComplete() || b.Closed() {
		t.Fatal("street complete, two players still have chips")
	}
}

func TestCumulativeShortAllInsReopen(t *testing.T) {
	b := NewBetting([]int64{1000, 1000, 160, 210}, 5, 10)
	mustAct(t, b, 2, "call", 0)
	mustAct(t, b, 3, "call", 0)
	mustAct(t, b, 0, "call", 0)
	mustAct(t, b, 1, "check", 0)
	b.NextStreet()
	mustAct(t, b, 0, "raise", 100)
	mustAct(t, b, 1, "fold", 0)
	mustAct(t, b, 2, "raise", 150) // all-in +50
	mustAct(t, b, 3, "raise", 200) // all-in, +100 over player 0's bet in total
	if !b.CanRaise(0) {
		t.Fatal("two short all-ins adding to a full raise reopen the betting")
	}
	mustAct(t, b, 0, "call", 0)
	if !b.Closed() {
		t.Fatal("only one player with chips left: betting closed")
	}
}

func TestAllInRunout(t *testing.T) {
	b := NewBetting([]int64{500, 300}, 5, 10)
	mustAct(t, b, 0, "raise", 500)
	if !b.Players[0].AllIn {
		t.Fatal("all-in")
	}
	mustAct(t, b, 1, "call", 0)
	if !b.Players[1].AllIn || !b.Closed() {
		t.Fatal("both all-in, betting closed")
	}
	pots := BuildPots([]int64{b.Players[0].Contributed, b.Players[1].Contributed}, []bool{false, false})
	won := Distribute(pots, []int{1, 2}, OddChipOrder(2))
	if won[1] != 600 || won[0] != 200 {
		t.Fatalf("won %v", won)
	}
}

func TestEveryoneFolds(t *testing.T) {
	b := NewBetting([]int64{1000, 1000, 1000}, 5, 10)
	mustAct(t, b, 2, "fold", 0)
	mustAct(t, b, 0, "fold", 0)
	if b.Live() != 1 || !b.Closed() || b.Turn != -1 {
		t.Fatal("hand should be over")
	}
}

func TestBigBlindAllInByPosting(t *testing.T) {
	// The only player with chips behind has matched: no action needed.
	b := NewBetting([]int64{1000, 10}, 5, 10)
	if !b.Players[1].AllIn {
		t.Fatal("big blind all-in")
	}
	mustAct(t, b, 0, "call", 0)
	if !b.Closed() {
		t.Fatal("betting closed after the call")
	}
}
