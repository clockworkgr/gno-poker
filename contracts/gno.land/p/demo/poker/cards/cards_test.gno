package cards

import (
	"bytes"
	"crypto/modexp"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
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

func isOne(x []byte) bool {
	for i := 0; i < len(x)-1; i++ {
		if x[i] != 0 {
			return false
		}
	}
	return x[len(x)-1] == 1
}

func millerRabin(n []byte, bases []byte) bool {
	nm1 := subOne(n)
	d := nm1
	s := 0
	for d[len(d)-1]&1 == 0 {
		d = shr1(d)
		s++
	}
	for _, a := range bases {
		x := modexp.ModExp([]byte{a}, d, n)
		if isOne(x) || bytes.Equal(x, nm1) {
			continue
		}
		ok := false
		for r := 1; r < s; r++ {
			x = modexp.ModExp(x, []byte{2}, n)
			if bytes.Equal(x, nm1) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func TestPrimes(t *testing.T) {
	p := P()
	if len(p) != CardLen {
		t.Fatalf("P length %d", len(p))
	}
	bases := []byte{2, 3, 5, 7, 11, 13, 17}
	if !millerRabin(p, bases) {
		t.Fatal("P failed Miller-Rabin")
	}
	q := shr1(subOne(p))
	if !millerRabin(q, bases) {
		t.Fatal("Q failed Miller-Rabin")
	}
	// A composite must fail.
	comp := subOne(subOne(p))
	if millerRabin(comp, bases) {
		t.Fatal("P-2 passed Miller-Rabin")
	}
}

func canonicalDeck() []byte {
	p := P()
	deck := make([]byte, 0, DeckLen)
	for c := 0; c < DeckSize; c++ {
		deck = append(deck, modexp.ModExp(CardPreimage(c), []byte{2}, p)...)
	}
	return deck
}

func TestCanonRoot(t *testing.T) {
	deck := canonicalDeck()
	root := MerkleRoot(deck)
	println("CANON_ROOT", EncodeHex(root))
	println("m_0 ", EncodeHex(deck[:CardLen]))
	println("m_51", EncodeHex(deck[51*CardLen:]))
	if EncodeHex(root) != CanonRootHex {
		t.Fatalf("canon root mismatch: got %s", EncodeHex(root))
	}
	_, root2, err := ParseDeck(EncodeDeck(deck))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(root, root2) {
		t.Fatal("ParseDeck root differs")
	}
}

func checkPerm(t *testing.T, perm []int) {
	seen := make([]bool, DeckSize)
	if len(perm) != DeckSize {
		t.Fatalf("perm length %d", len(perm))
	}
	for _, v := range perm {
		if v < 0 || v >= DeckSize || seen[v] {
			t.Fatalf("not a permutation: %v", perm)
		}
		seen[v] = true
	}
}

func permString(perm []int) string {
	parts := make([]string, len(perm))
	for i, v := range perm {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, ",")
}

func TestVectors(t *testing.T) {
	seedA := bytes.Repeat([]byte{1}, 32)
	seedB := make([]byte, 32)
	for i := range seedB {
		seedB[i] = byte(i)
	}
	for _, seed := range [][]byte{seedA, seedB} {
		perm := Permutation(seed)
		checkPerm(t, perm)
		if permString(Permutation(seed)) != permString(perm) {
			t.Fatal("permutation not stable")
		}
		e := ShuffleKey(seed)
		k0 := CardKey(seed, 0)
		if e[0]&0x80 == 0 || e[31]&1 == 0 || k0[0]&0x80 == 0 || k0[31]&1 == 0 {
			t.Fatal("bit tweaks missing")
		}
		println("seed     ", EncodeHex(seed))
		println("commit   ", EncodeHex(Commit(seed)))
		println("shufkey  ", EncodeHex(e))
		println("cardkey0 ", EncodeHex(k0))
		println("perm     ", permString(perm))
	}
	if permString(Permutation(seedA)) == permString(Permutation(seedB)) {
		t.Fatal("different seeds gave the same permutation")
	}
}

func TestMerkleProofs(t *testing.T) {
	deck := canonicalDeck()
	root := MerkleRoot(deck)
	for _, i := range []int{0, 1, 31, 32, 50, 51} {
		el := deck[i*CardLen : (i+1)*CardLen]
		proof := MerkleProof(deck, i)
		if !VerifyProof(root, el, i, proof) {
			t.Fatalf("proof %d failed", i)
		}
		if VerifyProof(root, el, (i+1)%DeckSize, proof) {
			t.Fatalf("proof %d verified at wrong index", i)
		}
		bad := make([]byte, len(proof))
		copy(bad, proof)
		bad[100] ^= 1
		if VerifyProof(root, el, i, bad) {
			t.Fatalf("tampered proof %d verified", i)
		}
		badEl := make([]byte, CardLen)
		copy(badEl, el)
		badEl[200] ^= 1
		if VerifyProof(root, badEl, i, proof) {
			t.Fatalf("tampered element %d verified", i)
		}
	}
}

func TestParseDeckRejects(t *testing.T) {
	deck := canonicalDeck()
	if _, _, err := ParseDeck(EncodeDeck(deck[:DeckLen-CardLen])); err == nil {
		t.Fatal("short deck accepted")
	}
	dup := make([]byte, DeckLen)
	copy(dup, deck)
	copy(dup[CardLen:2*CardLen], deck[:CardLen])
	if _, _, err := ParseDeck(EncodeDeck(dup)); err == nil || err.Error() != "duplicate deck element" {
		t.Fatalf("duplicate accepted: %v", err)
	}
	one := make([]byte, DeckLen)
	copy(one, deck)
	for i := 0; i < CardLen; i++ {
		one[5*CardLen+i] = 0
	}
	one[6*CardLen-1] = 1
	if _, _, err := ParseDeck(EncodeDeck(one)); err == nil {
		t.Fatal("element 1 accepted")
	}
	big := make([]byte, DeckLen)
	copy(big, deck)
	copy(big[7*CardLen:8*CardLen], P())
	if _, _, err := ParseDeck(EncodeDeck(big)); err == nil {
		t.Fatal("element P accepted")
	}
	if _, _, err := ParseDeck("!!!"); err == nil {
		t.Fatal("bad base64 accepted")
	}
}

func TestOfficialCards(t *testing.T) {
	a := Permutation(bytes.Repeat([]byte{1}, 32))
	b := Permutation(bytes.Repeat([]byte{2}, 32))
	cards := OfficialCards([][]int{a, b})
	checkPerm(t, cards)
	for i := 0; i < DeckSize; i++ {
		if cards[i] != a[b[i]] {
			t.Fatal("official card mismatch")
		}
	}
	if CardString(51) != "As" || CardString(0) != "2c" || CardString(22) != "Jd" {
		t.Fatal("card string")
	}
}

func TestBase64(t *testing.T) {
	data := []byte("any carnal pleasure.\x00\xff\x10")
	for n := 0; n <= len(data); n++ {
		enc := base64.StdEncoding.EncodeToString(data[:n])
		got, err := DecodeBase64(enc)
		if err != nil || !bytes.Equal(got, data[:n]) {
			t.Fatalf("decode %q: %v", enc, err)
		}
	}
	for _, bad := range []string{"QQ", "QQ=", "QR==", "QUF=", "Q$==", "QUJD\n", "====", "QUJ!"} {
		if _, err := DecodeBase64(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
