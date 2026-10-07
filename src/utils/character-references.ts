// Reading view's text step (parse-entities in Obsidian 1.14.4's app.js) decodes these in plain text: `&` with an ASCII alphanumeric name, or `#` and digits, and an optional `;`.
const CHARACTER_REFERENCE = /&(?:#[xX][\dA-Fa-f]+|#\d+|[A-Za-z\d]+);?/g;

// A spec-following parser drops whitespace that opens a document, so `&#32;` alone would decode to nothing; a leading letter keeps it.
const PARSE_SENTINEL = 'x';

let referenceParser: DOMParser | undefined;

// The platform's HTML parser holds the same WHATWG named-reference table parse-entities ships, and decodes a lone reference in text the same way, legacy names without `;` included, so bundling the 2,000-entry table is unnecessary.
function decodeCharacterReference(reference: string): string {
  referenceParser ??= new DOMParser();
  const parsed = referenceParser.parseFromString(
    PARSE_SENTINEL + reference,
    'text/html'
  ).body.textContent;
  return parsed === null ? reference : parsed.slice(PARSE_SENTINEL.length);
}

// `wrapDecoded` receives only text a reference produced, so a caller can shield it from later passes, as Reading view shows it literally.
export function decodeCharacterReferences(
  text: string,
  wrapDecoded: (decoded: string) => string
): string {
  if (!text.includes('&')) return text;
  return text.replace(CHARACTER_REFERENCE, (reference) => {
    const decoded = decodeCharacterReference(reference);
    return decoded === reference ? reference : wrapDecoded(decoded);
  });
}
