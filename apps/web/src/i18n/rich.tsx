import { Fragment, type ReactNode } from 'react';

/**
 * Puts elements into a translated sentence: a link, a `<code>`, a name in
 * bold. `t` leaves a placeholder it was given no value for untouched, so
 *
 *   fill(t('console.restore.from', {}), { backup: <code>{name}</code> })
 *
 * keeps the translation's word order and the element both. Building the
 * sentence from fragments around the element would pin English word order.
 */
export function fill(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return name !== undefined && name in parts ? (
      <Fragment key={index}>{parts[name]}</Fragment>
    ) : (
      piece
    );
  });
}
