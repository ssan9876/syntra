import { interactionPolicy } from 'oidc-provider';

const { Check, Prompt, base } = interactionPolicy;

/** Where the interaction route stamps its decision. */
export const SYNTRA_DECISION_KEY = 'syntraDecision';

/**
 * The prompt that makes spec section 7's chokepoint structural rather than
 * aspirational.
 *
 * `oidc-provider` keeps its own session cookie. Its built-in `login` prompt
 * returns `NO_NEED_TO_PROMPT` the moment `oidc.session.accountId` is set
 * (`lib/helpers/interaction_policy/prompts/login.js`), so without this the
 * *second* authorization request from any client — the same client, or a
 * different one — is answered straight out of that session and tokens are
 * issued without ever re-entering Syntra. Syntra's policy engine evaluates per
 * application, and a `require_mfa` rule scoped to one application would then
 * apply on the first launch of the day and never again.
 *
 * This check requests the prompt unless the *current* interaction was resolved
 * by Syntra's own interaction route, for this exact client. The route sets it
 * only after `authorize()` returned an allow, so:
 *
 *   every token oidc-provider issues  =>  an interaction was resolved
 *                                     =>  authorize() returned allow
 *
 * A test asserts the second authorization request still reaches the
 * interaction route. Deleting this prompt makes that test fail, which is the
 * only reason it is worth writing.
 */
export function syntraAuthorizePrompt() {
  return new Prompt(
    { name: 'syntra_authorize', requestable: false },
    (ctx) => ({ clientId: ctx.oidc.client?.clientId ?? null }),
    new Check(
      'syntra_decision_required',
      'Syntra must decide this authorization',
      (ctx) => {
        const decision = (ctx.oidc.result as Record<string, unknown> | undefined)?.[
          SYNTRA_DECISION_KEY
        ] as { clientId?: string } | undefined;
        if (decision && decision.clientId === ctx.oidc.client?.clientId) {
          return Check.NO_NEED_TO_PROMPT;
        }
        return Check.REQUEST_PROMPT;
      },
    ),
  );
}

/**
 * The interaction policy: Syntra's prompt first, then the stock login and
 * consent prompts.
 *
 * Ours goes first so the browser is sent to Syntra before oidc-provider has a
 * chance to decide the session is enough.
 */
export function syntraInteractionPolicy() {
  const policy = base();
  policy.add(syntraAuthorizePrompt(), 0);
  return policy;
}
