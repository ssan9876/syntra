// Directly, not through the package index -- the same reason as
// `launchable-url.js`: the sign-in page would otherwise carry every schema.
import { isSupportUrl } from '@syntra/contracts/src/support-url.js';
import { useT } from '../i18n/LocaleProvider.js';
import { useBrand } from './BrandProvider.js';

/**
 * The attributes a support link needs, or null when there is nothing safe to
 * link to.
 *
 * The URL is checked AGAIN here although the API refused anything but https:
 * and mailto: on the way in. This renders on the unauthenticated sign-in page,
 * and a row can predate the check -- a restore, a seed script, a hand edit.
 * Trusting storage because a schema exists somewhere is the gap a stale
 * `javascript:` link walks through.
 *
 * An https destination opens in a new tab: somebody who cannot sign in should
 * not lose the sign-in page to find out why. `mailto:` is left alone -- a new
 * tab for a mail client is an empty tab.
 */
export function supportLinkProps(url: string | null | undefined) {
  const href = url?.trim();
  if (!href || !isSupportUrl(href)) return null;
  return href.startsWith('https:')
    ? { href, target: '_blank', rel: 'noopener noreferrer' }
    : { href };
}

/** The tenant's "Get help" link, or nothing when the tenant has not set one. */
export function SupportLink({ className = '' }: { className?: string }) {
  const t = useT();
  const brand = useBrand();
  const props = supportLinkProps(brand.supportUrl);
  if (!props) return null;
  return (
    <a {...props} className={`link ${className}`}>
      {brand.supportLabel?.trim() || t('common.get_help')}
    </a>
  );
}
