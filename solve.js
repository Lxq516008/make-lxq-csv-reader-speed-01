// Fast drop-in for csv-reader 1.0.0: returns exactly its answer {columns, rows, errors}
// for an input {text, header}, but reads the text with indexOf/regex jumps and
// slice() instead of one character at a time.
//
// Semantics (mirroring the reference): a U+FEFF at the very start is dropped; a
// record ends at LF or CRLF; a line left with no characters is no record; outside
// quotes a CR not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next quote that is not doubled ("" inside is one quote, each
// CRLF or lone CR inside is one LF); what follows its closing quote up to the next
// comma or line break is appended as it stands (quote_junk, when the field ends);
// a quote that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote); a quote inside an unquoted field is a
// literal character; fields stay strings, never trimmed or converted; columns is
// the first record when header is true, else null; rows are the records after it,
// each padded with "" (short_row, with fields: its field count) or cut (long_row,
// with extra: the cut fields) to the first record's width; each error is
// {code, line, row} in the order met, line the 1-based line its record starts on
// (counting every LF, CRLF and lone CR inside quotes), row its record's index in
// rows (null for the header).
//
// Speed shape: records with no quote and no stray CR take a fast path (one
// indexOf for the line end, one bounded regex check, one native split(',')).
// Other records are read field by field, with the unquoted scan inlined in the
// record loop (two indexOf calls, one slice, no per-field call or allocation)
// and a regex scanner only for quoted fields and stray CRs. Field results travel
// in shared locals, never in a fresh array. Pure: no clock, no randomness,
// nothing kept from one call to the next.

const RE_QUOTE_OR_CR = /["\r]/g; // record check: any quote or CR before the line end
const RE_UNQ_END = /[,\r\n]/g; // unquoted field with a stray CR: next comma, CR or LF
const RE_Q_END = /["\r\n]/g; // quoted field: next quote, CR or LF

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value and how it ended (COMMA, BREAK or END).
  let fVal = '';
  let fEnded = END;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break, the same scan the record loop
  // inlines, as a function for the quoted field's junk and unterminated paths. Sets fVal/fEnded.
  function readUnquoted(init) {
    const c = text.indexOf(',', pos);
    const l = text.indexOf('\n', pos);
    let end;
    let ended;
    if (c !== -1 && (l === -1 || c < l)) {
      end = c;
      ended = COMMA;
    } else if (l !== -1) {
      end = l;
      ended = BREAK;
    } else {
      end = n;
      ended = END;
    }
    const seg = text.slice(pos, end);
    const r = seg.indexOf('\r');
    if (r === -1) {
      if (ended === COMMA) pos = end + 1;
      else if (ended === BREAK) {
        pos = end + 1;
        line += 1;
      } else {
        pos = n;
      }
      fVal = init === '' ? seg : init + seg;
      fEnded = ended;
      return;
    }
    if (ended === BREAK && r === seg.length - 1) {
      // CRLF: the CR belongs to the line break.
      pos = end + 1;
      line += 1;
      const v = seg.slice(0, -1);
      fVal = init === '' ? v : init + v;
      fEnded = BREAK;
      return;
    }
    // A stray CR sits inside: the regex scanner below drops it (stray_cr).
    readUnquotedSlow(init);
  }

  // The same scan, driven by a regex, for fields that hold a stray CR. Sets fVal/fEnded.
  function readUnquotedSlow(init) {
    let start = pos;
    let acc = init;
    let dirty = init !== '';
    RE_UNQ_END.lastIndex = pos;
    let m;
    while ((m = RE_UNQ_END.exec(text)) !== null) {
      const i = m.index;
      const ch = m[0];
      if (ch === ',') {
        pos = i + 1;
        fVal = dirty ? acc + text.slice(start, i) : text.slice(start, i);
        fEnded = COMMA;
        return;
      }
      if (ch === '\n') {
        pos = i + 1;
        line += 1;
        fVal = dirty ? acc + text.slice(start, i) : text.slice(start, i);
        fEnded = BREAK;
        return;
      }
      // '\r': CRLF ends the record; a lone CR is dropped (stray_cr).
      if (text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        fVal = dirty ? acc + text.slice(start, i) : text.slice(start, i);
        fEnded = BREAK;
        return;
      }
      error('stray_cr');
      if (!dirty) {
        acc = text.slice(start, i);
        dirty = true;
      } else {
        acc += text.slice(start, i);
      }
      start = i + 1;
    }
    pos = n;
    fVal = dirty ? acc + text.slice(start, n) : text.slice(start, n);
    fEnded = END;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    let acc = '';
    let dirty = false;
    RE_Q_END.lastIndex = pos;
    let m;
    while ((m = RE_Q_END.exec(text)) !== null) {
      const i = m.index;
      const ch = m[0];
      if (ch === '"') {
        if (text.charCodeAt(i + 1) === 34) {
          // Doubled quote: one literal quote.
          if (!dirty) {
            acc = text.slice(start, i) + '"';
            dirty = true;
          } else {
            acc += text.slice(start, i) + '"';
          }
          start = i + 2;
          RE_Q_END.lastIndex = i + 2;
          continue;
        }
        // Closing quote.
        const value = dirty ? acc + text.slice(start, i) : text.slice(start, i);
        pos = i + 1;
        if (pos >= n) {
          fVal = value;
          fEnded = END;
          return;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          fVal = value;
          fEnded = COMMA;
          return;
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          fVal = value;
          fEnded = BREAK;
          return;
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fVal = value;
          fEnded = BREAK;
          return;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or line break.
        readUnquoted(value);
        if (fVal.length > value.length) error('quote_junk');
        return;
      }
      if (ch === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        if (!dirty) {
          acc = text.slice(start, i) + '\n';
          dirty = true;
        } else {
          acc += text.slice(start, i) + '\n';
        }
        line += 1;
        start = text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
        RE_Q_END.lastIndex = start;
        continue;
      }
      // '\n' inside quotes: one LF, and the line count moves on.
      if (!dirty) {
        acc = text.slice(start, i) + '\n';
        dirty = true;
      } else {
        acc += text.slice(start, i) + '\n';
      }
      line += 1;
      start = i + 1;
    }
    // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
    pos = open + 1;
    line = openLine;
    error('unterminated_quote');
    readUnquoted('"');
  }

  // Closes a record's fields: header, padding/cutting to the first record's width, rows.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record holds no quote and no stray CR. Its line ends at the next LF (or the end of the
    // text); a CR may only sit right before that LF (CRLF). Then the record is one native split(',').
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      RE_QUOTE_OR_CR.lastIndex = pos;
      const q = RE_QUOTE_OR_CR.exec(text);
      if (!q || q.index >= nl) {
        finishRecord(text.slice(pos, nl).split(','));
        pos = nl + 1;
        line += 1;
        continue;
      }
      if (q[0] === '\r' && q.index === nl - 1) {
        finishRecord(text.slice(pos, nl - 1).split(','));
        pos = nl + 1;
        line += 1;
        continue;
      }
    } else {
      RE_QUOTE_OR_CR.lastIndex = pos;
      const q = RE_QUOTE_OR_CR.exec(text);
      if (!q) {
        finishRecord(text.slice(pos, n).split(','));
        pos = n;
        continue;
      }
    }

    // Slow path: the record holds a quote or a stray CR; read it field by field.
    const fields = [];
    let quoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
        fields.push(fVal);
        ended = fEnded;
      } else {
        quoted = false;
        // Unquoted field, inlined: the next comma and the next LF are found with indexOf; the slice
        // between pos and the nearer of the two is the field unless it holds a CR.
        const c = text.indexOf(',', pos);
        const l = text.indexOf('\n', pos);
        let end;
        let e;
        if (c !== -1 && (l === -1 || c < l)) {
          end = c;
          e = COMMA;
        } else if (l !== -1) {
          end = l;
          e = BREAK;
        } else {
          end = n;
          e = END;
        }
        const seg = text.slice(pos, end);
        const r = seg.indexOf('\r');
        if (r === -1) {
          fields.push(seg);
          if (e === COMMA) pos = end + 1;
          else if (e === BREAK) {
            pos = end + 1;
            line += 1;
          } else {
            pos = n;
          }
          ended = e;
        } else if (e === BREAK && r === seg.length - 1) {
          // CRLF: the CR belongs to the line break.
          fields.push(seg.slice(0, -1));
          pos = end + 1;
          line += 1;
          ended = BREAK;
        } else {
          // A stray CR sits inside: the regex scanner drops it (stray_cr).
          readUnquotedSlow('');
          fields.push(fVal);
          ended = fEnded;
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
