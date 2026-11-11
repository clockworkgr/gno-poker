package poker

import (
	"chain"
	"chain/banker"
	"crypto/modexp"
	"crypto/sha256"
	"strconv"
	"strings"
	"testing"

	"gno.land/p/demo/poker/cards"
	"gno.land/p/demo/poker/holdem"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

// This file plays the client role: it derives keys from seeds, builds shuffle
// and rekey passes with crypto/modexp and drives the realm API.

var realmAddr = chain.PackageAddress("gno.land/r/demo/poker")

var (
	tP     = cards.P()
	tQ     = shr1(subOne(tP))
	tQm2   = subOne(subOne(tQ))
	tCanon = canonicalDeck()
)

func subOne(x []byte) []byte {
	out := make([]byte, len(x))
	copy(out, x)
	for i := len(out) - 1; i >= 0; i-- {
		if out[i] > 0 {
			out[i]--
			break
		}
		out[i] = 0xff
	}
	return out
}

func shr1(x []byte) []byte {
	out := make([]byte, len(x))
	var carry byte
	for i := 0; i < len(x); i++ {
		out[i] = (x[i] >> 1) | carry
		carry = (x[i] & 1) << 7
	}
	return out
}

func addBytes(a, b []byte) []byte {
	out := make([]byte, len(a))
	carry := 0
	for i := len(a) - 1; i >= 0; i-- {
		s := int(a[i]) + int(b[i]) + carry
		out[i] = byte(s)
		carry = s >> 8
	}
	if carry != 0 {
		panic("overflow")
	}
	return out
}

func pow(b, e []byte) []byte { return modexp.ModExp(b, e, tP) }

// invExp returns e^-1 mod (P-1) for odd e: the inverse mod the prime Q by
// Fermat, made odd by adding Q when needed (P-1 = 2Q).
func invExp(e []byte) []byte {
	d := modexp.ModExp(e, tQm2, tQ)
	if d[len(d)-1]&1 == 0 {
		d = addBytes(d, tQ)
	}
	return d
}

func canonicalDeck() [][]byte {
	out := make([][]byte, cards.DeckSize)
	for c := 0; c < cards.DeckSize; c++ {
		out[c] = pow(cards.CardPreimage(c), []byte{2})
	}
	return out
}

func joinDeck(d [][]byte) []byte {
	out := make([]byte, 0, cards.DeckLen)
	for _, el := range d {
		out = append(out, el...)
	}
	return out
}

func deckB64(d [][]byte) string { return cards.EncodeDeck(joinDeck(d)) }

func shufflePass(prev [][]byte, seed []byte) [][]byte {
	pi := cards.Permutation(seed)
	e := cards.ShuffleKey(seed)
	out := make([][]byte, cards.DeckSize)
	for i := range out {
		out[i] = pow(prev[pi[i]], e)
	}
	return out
}

func rekeyPass(prev [][]byte, seed []byte) [][]byte {
	d := invExp(cards.ShuffleKey(seed))
	out := make([][]byte, cards.DeckSize)
	for i := range out {
		out[i] = pow(pow(prev[i], d), cards.CardKey(seed, i))
	}
	return out
}

// player is a test participant.
type player struct {
	name  string
	owner address
	sess  address
}

func newPlayer(name string, withSession bool) *player {
	p := &player{name: name, owner: testutils.TestAddress(name)}
	if withSession {
		p.sess = testutils.TestAddress(name + "-session")
	}
	return p
}

// actor is the address that signs gameplay calls.
func (p *player) actor() address {
	if p.sess != "" {
		return p.sess
	}
	return p.owner
}

func ugnot(n int64) chain.Coins { return chain.Coins{chain.NewCoin("ugnot", n)} }

func balanceOf(addr address) int64 {
	return banker.NewReadonlyBanker().GetCoin(addr, "ugnot")
}

// checkInvariant asserts the realm holds exactly the escrowed ugnot.
func checkInvariant(t *testing.T) {
	t.Helper()
	bal := balanceOf(realmAddr)
	esc := totalEscrow()
	if bal != esc {
		t.Fatalf("money invariant broken: realm balance %d, escrow %d", bal, esc)
	}
}

// Call wrappers. Each is a crossing function so that testing.SetRealm applies
// to its own frame and the realm sees `who` as the direct user caller. An
// empty expect means the call must succeed; otherwise it must abort with a
// message containing expect. The money invariant is checked after every call.

// setSend sets the attached coins; testing.SetRealm must be called in the
// wrapper's own frame.
func setSend(send int64) {
	if send > 0 {
		testing.SetOriginSend(ugnot(send))
	} else {
		testing.SetOriginSend(nil)
	}
}

func run(t *testing.T, rlm realm, expect string, f func()) {
	t.Helper()
	if expect == "" {
		f()
	} else {
		uassert.AbortsContains(t, rlm, expect, f)
	}
	testing.SetOriginSend(nil)
	checkInvariant(t)
}

// fund simulates the transfer of attached coins to the realm for a call that
// is expected to succeed.
func fund(send int64, expect string) {
	if send > 0 && expect == "" {
		testing.IssueCoins(realmAddr, ugnot(send))
	}
}

func doCreateTable(cur realm, t *testing.T, maxPlayers int) uint64 {
	testing.SetRealm(testing.NewUserRealm(testutils.TestAddress("creator")))
	setSend(0)
	var id uint64
	run(t, cur, "", func() { id = CreateTable(cross(cur), 10, 20, 400, 4000, maxPlayers, 10, 5, 100) })
	return id
}

func doJoin(cur realm, t *testing.T, who address, tid uint64, session string, send, allowance int64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(send)
	fund(send, expect)
	run(t, cur, expect, func() { Join(cross(cur), tid, session, allowance) })
}

func doTopUp(cur realm, t *testing.T, who address, tid uint64, send int64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(send)
	fund(send, expect)
	run(t, cur, expect, func() { TopUp(cross(cur), tid) })
}

func doLeave(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { Leave(cross(cur), tid) })
}

func doSitOut(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { SitOut(cross(cur), tid) })
}

func doSitIn(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { SitIn(cross(cur), tid) })
}

func doStartHand(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { StartHand(cross(cur), tid) })
}

func doShuffle(cur realm, t *testing.T, who address, tid, hn uint64, commit, deck, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { SubmitShuffle(cross(cur), tid, hn, commit, deck) })
}

func doRekey(cur realm, t *testing.T, who address, tid, hn uint64, deck, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { SubmitRekey(cross(cur), tid, hn, deck) })
}

func doShare(cur realm, t *testing.T, who address, tid, hn uint64, keys, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { ShareKeys(cross(cur), tid, hn, keys) })
}

func doAct(cur realm, t *testing.T, who address, tid, hn uint64, action string, amount int64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { Act(cross(cur), tid, hn, action, amount) })
}

func doReveal(cur realm, t *testing.T, who address, tid, hn uint64, seed, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { RevealSeed(cross(cur), tid, hn, seed) })
}

func doAccept(cur realm, t *testing.T, who address, tid, hn uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { Accept(cross(cur), tid, hn) })
}

func doChallenge(cur realm, t *testing.T, who address, tid, hn uint64, accused int, kind string, index int, in, inProof, out, outProof string, send int64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(send)
	fund(send, expect)
	run(t, cur, expect, func() { Challenge(cross(cur), tid, hn, accused, kind, index, in, inProof, out, outProof) })
}

func doFinalize(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { Finalize(cross(cur), tid) })
}

func doTimeout(cur realm, t *testing.T, who address, tid uint64, expect string) {
	testing.SetRealm(testing.NewUserRealm(who))
	setSend(0)
	run(t, cur, expect, func() { Timeout(cross(cur), tid) })
}

var anyone = testutils.TestAddress("anyone")

func join(cur realm, t *testing.T, tid uint64, p *player, buyIn, allowance int64) {
	sess := ""
	if p.sess != "" {
		sess = p.sess.String()
	}
	doJoin(cross(cur), t, p.owner, tid, sess, buyIn+allowance, allowance, "")
}

func seedFor(name string, handNo uint64, salt string) []byte {
	h := sha256.Sum256([]byte("test-seed/" + name + "/" + salt + "/" + strconv.FormatUint(handNo, 10)))
	return h[:]
}

// game drives one hand from the clients' side.
type game struct {
	t      *testing.T
	tid    uint64
	handNo uint64
	byAddr map[address]*player
	ps     []*player // hand order
	seeds  [][]byte
	passes [][][]byte // every deck pass
}

func newGame(cur realm, t *testing.T, tid uint64, all []*player, salt string) *game {
	starter := all[0]
	for _, p := range all {
		if tables[tid-1].seatOf(p.owner) >= 0 {
			starter = p
			break
		}
	}
	doStartHand(cross(cur), t, starter.actor(), tid, "")
	tb := tables[tid-1]
	g := &game{t: t, tid: tid, handNo: tb.HandNo, byAddr: map[address]*player{}}
	for _, p := range all {
		g.byAddr[p.owner] = p
	}
	for _, hp := range tb.Hand.Players {
		p := g.byAddr[hp.Owner]
		if p == nil {
			t.Fatalf("unknown hand player %s", hp.Owner)
		}
		g.ps = append(g.ps, p)
		g.seeds = append(g.seeds, seedFor(p.name, g.handNo, salt))
	}
	return g
}

func (g *game) hand() *Hand  { return tables[g.tid-1].Hand }
func (g *game) n() int        { return len(g.ps) }
func (g *game) phase() string { return phaseNames[g.hand().Phase] }

func (g *game) expectPhase(want string) {
	g.t.Helper()
	if g.phase() != want {
		g.t.Fatalf("phase %s, want %s", g.phase(), want)
	}
}

func (g *game) lastDeck() [][]byte {
	if len(g.passes) == 0 {
		return tCanon
	}
	return g.passes[len(g.passes)-1]
}

func (g *game) commit(j int) string { return cards.EncodeHex(cards.Commit(g.seeds[j])) }

// submitShuffle has player j shuffle; tamper may alter the pass before sending.
func (g *game) submitShuffle(cur realm, j int, tamper func([][]byte) [][]byte) {
	d := shufflePass(g.lastDeck(), g.seeds[j])
	if tamper != nil {
		d = tamper(d)
	}
	doShuffle(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, g.commit(j), deckB64(d), "")
	g.passes = append(g.passes, d)
}

func (g *game) submitRekey(cur realm, j int, tamper func([][]byte) [][]byte) {
	d := rekeyPass(g.lastDeck(), g.seeds[j])
	if tamper != nil {
		d = tamper(d)
	}
	doRekey(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, deckB64(d), "")
	g.passes = append(g.passes, d)
}

func (g *game) shuffleAndRekey(cur realm) {
	for j := 0; j < g.n(); j++ {
		g.submitShuffle(cross(cur), j, nil)
	}
	g.expectPhase("rekey")
	for j := 0; j < g.n(); j++ {
		g.submitRekey(cross(cur), j, nil)
	}
	g.expectPhase("deal_hole")
}

// owed returns the positions player j owes in deal step `step`.
func (g *game) owed(step string, j int) []int {
	n := g.n()
	out := []int{}
	switch step {
	case "deal_hole":
		for i := 0; i < 2*n; i++ {
			if i != 2*j && i != 2*j+1 {
				out = append(out, i)
			}
		}
	case "deal_flop":
		out = []int{2 * n, 2*n + 1, 2*n + 2}
	case "deal_turn":
		out = []int{2*n + 3}
	case "deal_river":
		out = []int{2*n + 4}
	}
	return out
}

func (g *game) keysHex(j int, pos []int) string {
	var b strings.Builder
	for _, i := range pos {
		b.WriteString(cards.EncodeHex(cards.CardKey(g.seeds[j], i)))
	}
	return b.String()
}

func (g *game) share(cur realm, j int) {
	pos := g.owed(g.phase(), j)
	doShare(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, g.keysHex(j, pos), "")
}

// deal has every player share keys for the current deal step.
func (g *game) deal(cur realm) {
	step := g.phase()
	if !strings.HasPrefix(step, "deal_") {
		g.t.Fatalf("not a deal step: %s", step)
	}
	for j := 0; j < g.n(); j++ {
		g.share(cross(cur), j)
	}
}

func (g *game) act(cur realm, j int, action string, amount int64) {
	if g.hand().turnIndex() != j {
		g.t.Fatalf("turn is %d, not %d (phase %s)", g.hand().turnIndex(), j, g.phase())
	}
	doAct(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, action, amount, "")
}

// checkAround checks or calls for everyone until the street completes.
func (g *game) checkAround(cur realm) {
	street := g.phase()
	for g.phase() == street {
		j := g.hand().turnIndex()
		if g.hand().Bet.CanCheck(j) {
			g.act(cross(cur), j, "check", 0)
		} else {
			g.act(cross(cur), j, "call", 0)
		}
	}
}

func (g *game) reveal(cur realm, j int) {
	doReveal(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, cards.EncodeHex(g.seeds[j]), "")
}

func (g *game) revealAll(cur realm) {
	g.expectPhase("reveal")
	for j := 0; j < g.n(); j++ {
		g.reveal(cross(cur), j)
	}
}

func (g *game) acceptAll(cur realm) {
	g.expectPhase("challenge")
	for j := 0; j < g.n(); j++ {
		doAccept(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, "")
	}
	g.expectPhase("done")
}

// playToShowdown deals and checks every street.
func (g *game) playToShowdown(cur realm) {
	g.shuffleAndRekey(cross(cur))
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

// card decodes position pos off-chain by stripping every player's card key,
// the way a client opens a dealt card.
func (g *game) card(pos int) int {
	f := g.passes[2*g.n()-1][pos]
	for j := range g.ps {
		f = pow(f, invExp(cards.CardKey(g.seeds[j], pos)))
	}
	for c, m := range tCanon {
		if string(m) == string(f) {
			return c
		}
	}
	return -1
}

func stackOf(tid uint64, p *player) int64 {
	tb := tables[tid-1]
	i := tb.seatOf(p.owner)
	if i < 0 {
		return -1
	}
	return tb.Seats[i].Stack
}

// proof returns base64 element and hex proof for position i of pass s.
func (g *game) elemProof(s, i int) (string, string) {
	var d [][]byte
	if s < 0 {
		d = tCanon
	} else {
		d = g.passes[s]
	}
	raw := joinDeck(d)
	return cards.EncodeDeck(d[i]), cards.EncodeHex(cards.MerkleProof(raw, i))
}

// challengeArgs builds the elements and proofs for a challenge.
func (g *game) challengeArgs(kind string, accused, index int) (string, string, string, string) {
	n := g.n()
	var in, inP, out, outP string
	if kind == "shuffle" {
		pi := cards.Permutation(g.seeds[accused])
		in, inP = g.elemProof(accused-1, pi[index])
		out, outP = g.elemProof(accused, index)
	} else {
		in, inP = g.elemProof(n+accused-1, index)
		out, outP = g.elemProof(n+accused, index)
	}
	return in, inP, out, outP
}

// findCheat recomputes every pass from the revealed seeds, as clients do after
// the reveal, and returns the first mismatch.
func (g *game) findCheat() (string, int, int) {
	n := g.n()
	prev := tCanon
	for s, d := range g.passes {
		var want [][]byte
		kind, j := "shuffle", s
		if s < n {
			want = shufflePass(prev, g.seeds[j])
		} else {
			kind, j = "rekey", s-n
			want = rekeyPass(prev, g.seeds[j])
		}
		for i := range want {
			if string(want[i]) != string(d[i]) {
				return kind, j, i
			}
		}
		prev = d
	}
	return "", -1, -1
}

func (g *game) challenge(cur realm, j int, kind string, accused, index int, send int64, expect string) {
	in, inP, out, outP := g.challengeArgs(kind, accused, index)
	doChallenge(cross(cur), g.t, g.ps[j].actor(), g.tid, g.handNo, accused, kind, index, in, inP, out, outP, send, expect)
}

// stacks returns the seat stacks of the hand players in hand order.
func (g *game) stacks() []int64 {
	out := make([]int64, g.n())
	for j, p := range g.ps {
		out[j] = stackOf(g.tid, p)
	}
	return out
}

// startStacks returns each hand player's stack before blinds.
func (g *game) startStacks() []int64 {
	out := g.stacks()
	for j := range out {
		out[j] += g.hand().Bet.Players[j].Contributed
	}
	return out
}

// expectedPenalty returns the stacks after an abort that penalizes `bad`,
// given the stacks before the hand.
func expectedPenalty(start []int64, bad []int) []int64 {
	out := make([]int64, len(start))
	copy(out, start)
	isBad := map[int]bool{}
	for _, b := range bad {
		isBad[b] = true
	}
	rec := []int{}
	for j := range start {
		if !isBad[j] {
			rec = append(rec, j)
		}
	}
	for _, b := range bad {
		amt := out[b]
		out[b] = -1
		share := amt / int64(len(rec))
		for k, r := range rec {
			out[r] += share
			if k == 0 {
				out[r] += amt - share*int64(len(rec))
			}
		}
	}
	return out
}

func eqStacks(t *testing.T, got, want []int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("stacks %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("stacks %v, want %v", got, want)
		}
	}
}

// scoreOf evaluates hand player j's best hand from the realm's cards.
func (g *game) scoreOf(j int) int {
	h := g.hand()
	n := g.n()
	seven := []int{h.Cards[2*j], h.Cards[2*j+1]}
	seven = append(seven, h.Cards[2*n:2*n+5]...)
	return holdem.Evaluate(seven)
}

// resetState clears realm state between tests; the test banker starts every
// test with empty balances.
func resetState() {
	tables = nil
}
