import { NavLink } from 'react-router-dom';

/**
 * How somebody reaches the rest of the portal.
 *
 * There was no way. `Portal.tsx` rendered tiles and nothing else, and the
 * catalog, a person's own requests, the access they hold, their approvals,
 * the resources they manage and their access reviews were all reachable only
 * by typing the URL. Six surfaces, built and tested, that nobody could find —
 * which is a worse look than any amount of styling, because a product whose
 * features cannot be reached reads as unfinished.
 *
 * A SLIM ROW, not a sidebar and not a demand for attention. The portal's
 * reader is a nurse on a shared ward PC who opens it, taps the tile for the
 * rostering system and leaves; PRODUCT.md is explicit that they see it for
 * four seconds a day and should never have to think about it. So the tiles
 * keep the page and this sits above them at the weight of a caption — there
 * when it is wanted, silent when it is not.
 *
 * Everything is shown to everybody rather than filtered by whether they have
 * anything waiting. Hiding "Approvals" from a manager until they have an
 * approval means they never learn the portal can do it, and each of these
 * screens already explains itself when empty.
 */
const ITEMS = [
  { to: '/', label: 'Applications', end: true },
  { to: '/catalog', label: 'Request access', end: false },
  { to: '/requests', label: 'My requests', end: false },
  { to: '/access', label: 'My access', end: false },
  { to: '/approvals', label: 'Approvals', end: false },
  { to: '/managed', label: 'Managed by me', end: false },
  { to: '/govern/reviews', label: 'Reviews', end: false },
];

export function PortalNav() {
  return (
    <nav
      aria-label="Portal"
      className="border-b border-border-subtle bg-surface-2"
    >
      <ul className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto overflow-y-hidden px-6">
        {ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  'inline-block whitespace-nowrap px-3 py-2.5 text-sm font-medium',
                  'transition-colors duration-150 ease-out-quart',
                  // The current page is marked with a rule under it rather
                  // than a filled pill: this bar sits directly on the content
                  // and a row of pills would read as seven buttons.
                  '-mb-px border-b-2',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted hover:text-ink',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
