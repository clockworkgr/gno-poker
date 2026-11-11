// Parsing of vm/qeval and MsgCall result strings, e.g. `("{\"id\":1}" string)` or `(7 uint64)`.

export interface GnoValue {
  /** Raw value text as printed by gno; for strings, the decoded Go string. */
  value: string;
  type: string;
}

/** Decodes a Go double-quoted string literal as produced by strconv.Quote. */
export function unquoteGo(lit: string): string {
  if (lit.length < 2 || lit[0] !== '"' || lit[lit.length - 1] !== '"') throw new Error("not a Go string literal");
  const body = lit.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const pushRune = (cp: number) => {
    for (const b of enc.encode(String.fromCodePoint(cp))) bytes.push(b);
  };
  for (let i = 0; i < body.length; ) {
    const ch = body[i]!;
    if (ch !== "\\") {
      const cp = body.codePointAt(i)!;
      pushRune(cp);
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    const e = body[i + 1];
    i += 2;
    switch (e) {
      case "a": bytes.push(7); break;
      case "b": bytes.push(8); break;
      case "f": bytes.push(12); break;
      case "n": bytes.push(10); break;
      case "r": bytes.push(13); break;
      case "t": bytes.push(9); break;
      case "v": bytes.push(11); break;
      case "\\": bytes.push(92); break;
      case '"': bytes.push(34); break;
      case "'": bytes.push(39); break;
      case "x": bytes.push(hexAt(body, i, 2)); i += 2; break;
      case "u": pushRune(hexAt(body, i, 4)); i += 4; break;
      case "U": pushRune(hexAt(body, i, 8)); i += 8; break;
      default:
        if (e !== undefined && e >= "0" && e <= "7") {
          const oct = body.slice(i - 1, i + 2);
          if (!/^[0-7]{3}$/.test(oct)) throw new Error("bad octal escape");
          bytes.push(parseInt(oct, 8));
          i += 2;
          break;
        }
        throw new Error(`bad escape \\${e ?? ""}`);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function hexAt(s: string, i: number, n: number): number {
  const h = s.slice(i, i + n);
  if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) throw new Error("bad hex escape");
  return parseInt(h, 16);
}

/** Splits a qeval/MsgCall result into its values, one per line. */
export function parseGnoResults(raw: string): GnoValue[] {
  const out: GnoValue[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("(") || !t.endsWith(")")) throw new Error(`unexpected gno result: ${t.slice(0, 80)}`);
    const inner = t.slice(1, -1);
    const sp = inner.lastIndexOf(" ");
    if (sp < 0) throw new Error(`unexpected gno result: ${t.slice(0, 80)}`);
    const valueText = inner.slice(0, sp);
    const type = inner.slice(sp + 1);
    let value = valueText;
    if (type === "string") value = valueText.startsWith('"') ? unquoteGo(valueText) : valueText;
    out.push({ value, type });
  }
  return out;
}

function single(raw: string, type: string): string {
  const vs = parseGnoResults(raw);
  if (vs.length !== 1 || vs[0]!.type !== type) throw new Error(`expected one ${type} result, got: ${raw.slice(0, 120)}`);
  return vs[0]!.value;
}

export function parseGnoString(raw: string): string {
  return single(raw, "string");
}
export function parseGnoBool(raw: string): boolean {
  const v = single(raw, "bool");
  if (v !== "true" && v !== "false") throw new Error(`bad bool ${v}`);
  return v === "true";
}
export function parseGnoUint(raw: string, type = "uint64"): bigint {
  return BigInt(single(raw, type));
}
