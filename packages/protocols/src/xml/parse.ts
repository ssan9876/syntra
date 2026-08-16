import { DOMParser } from '@xmldom/xmldom';
import { select } from 'xpath';

/**
 * `@xmldom/xmldom` reports an unresolved entity reference (internal or
 * external) as an `error`-level diagnostic and then continues, leaving the
 * reference as literal text in the tree — it never expands it. That is the
 * desired behaviour (see the module doc below) and must not make `parseXml`
 * throw. Every other `error`-level diagnostic (trailing garbage after the
 * root element, an unterminated attribute, and the like) denotes a document
 * that is not well formed and must still be rejected. `fatalError`-level
 * diagnostics abort the parse and throw synchronously from `parseFromString`
 * before `onError` even returns, so they never reach this filter.
 */
const ENTITY_DIAGNOSTIC = /entity/i;

/**
 * The only XML parser in this codebase.
 *
 * `@xmldom/xmldom` resolves no entities at all — neither an internal general
 * entity nor an external one. That was verified empirically at version 0.9.11
 * against a billion-laughs payload and a `SYSTEM "file:///etc/passwd"`
 * payload; both come back as the literal reference text. Spec section 7 asks
 * for entity expansion disabled, and here it is disabled by the parser's
 * construction rather than by a flag someone can flip. `xml.test.ts` pins
 * that as a regression test so a swap to a parser that *does* expand entities
 * fails loudly rather than quietly reintroducing XXE.
 *
 * A parse error throws. The default xmldom behaviour is to report the error
 * and hand back a partial document, which is how a truncated or malformed
 * assertion becomes a Response with no Status and an empty Subject that some
 * downstream check reads as "no failure recorded".
 */
export function parseXml(xml: string): Document {
  if (xml.trim() === '') throw new Error('empty XML document');

  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' && ENTITY_DIAGNOSTIC.test(message)) return;
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  }).parseFromString(xml, 'text/xml');

  if (errors.length > 0) {
    throw new Error(`malformed XML: ${errors.join('; ')}`);
  }
  if (!doc.documentElement) throw new Error('XML document has no root element');
  return doc as unknown as Document;
}

/** An XPath select narrowed to elements, so a caller cannot get a string back. */
export function selectElements(node: Node, xpath: string): Element[] {
  const result = select(xpath, node as never);
  if (!Array.isArray(result)) throw new Error(`xpath did not select nodes: ${xpath}`);
  return result.filter(
    (n): n is Element => typeof n === 'object' && n !== null && 'nodeType' in n && (n as Node).nodeType === 1,
  ) as unknown as Element[];
}
