import {
  credentialPickupRevealResponse,
  credentialPickupStatusResponse,
  credentialPickupTokenParam,
} from '@syntra/contracts';
import { describePublicRoutes } from '../openapi/describe.js';

/** The OpenAPI description of the routes in `credential-pickup.ts`. */
export const credentialPickupOpenApi = describePublicRoutes('Credential pickup', {
  'GET /api/credential-pickup/:token': {
    summary: 'Read the state of a one-time sign-in link',
    description:
      'What the pickup page renders before anybody presses anything: `ready`, `used`, `expired` or `revoked`, with the system and username. Never the password, and free of side effects -- mail scanners fetch every link in a message, and this must not spend it. `404 credential-link-unknown` for a token that matches nothing. Answers carry `Cache-Control: no-store`.',
    params: credentialPickupTokenParam,
    response: credentialPickupStatusResponse,
  },
  'POST /api/credential-pickup/:token/reveal': {
    summary: 'Reveal the password behind a one-time sign-in link, once',
    description:
      'Marks the link used and returns the username and password, exactly once: two concurrent calls produce one password and one refusal. Every refusal -- used, expired, revoked, unknown -- is the same `410 credential-link-unusable`. Answers carry `Cache-Control: no-store`.',
    params: credentialPickupTokenParam,
    response: credentialPickupRevealResponse,
  },
});
