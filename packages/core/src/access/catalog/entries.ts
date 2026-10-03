import type { CatalogEntry } from './types.js';

/**
 * The entries.
 *
 * Deliberately a short list of applications whose SAML configuration is
 * documented, stable and widely used — not a long one. Every entry is a claim
 * that Syntra knows how to configure that vendor, and a claim nobody has
 * checked against the vendor's own page is a claim that will be wrong within a
 * release. Where a service provider publishes SP metadata, the import route is
 * better than an entry here and the console offers it first.
 *
 * Each entry carries `docsUrl` for exactly that reason: the vendor's page is
 * authoritative and this file is a convenience.
 *
 * `launchUrl` ON A SAML ENTRY IS WHERE THE PORTAL TILE GOES. An application
 * made from the catalog has IdP-initiated sign-in off, so the tile opens this
 * address and the application is expected to start SP-initiated SSO from it
 * (see the launch route in apps/api/src/routes/portal.ts). It should
 * therefore be the page that sends an AuthnRequest, not a home page with a
 * password form on it. Snipe-IT's is set to its SSO start page, checked
 * live. The others are left as they were: Slack's workspace URL and Google's
 * `mail.google.com/a/<domain>` already hand a SAML-enforced user to the IdP,
 * Salesforce's My Domain and Zoom's vanity URL depend on how the org's login
 * page is configured, and Nextcloud's `user_saml` start route is not on the
 * vendor's documentation page — so an administrator whose tile lands on a
 * login form sets the SSO start page on the application rather than this
 * file guessing one. Later entries set `launchUrl` only where the vendor's page
 * names a sign-on URL or the account's own address, and leave it out otherwise.
 *
 * WHERE A VENDOR LETS THE ADMINISTRATOR NAME THE ATTRIBUTES (Sentry, Jenkins,
 * Box, Rocket.Chat), the entry ships one set of names and a comment saying
 * where to enter them on the vendor's side. The vendor's URLs are still taken
 * from its page; only the attribute names are this file's choice.
 */

const EMAIL_NAMEID = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const PERSISTENT_NAMEID = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const URI = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';

export const CATALOG_ENTRIES: CatalogEntry[] = [
  {
    key: 'slack',
    name: 'Slack',
    category: 'collaboration',
    description: 'Team messaging. One entry per Slack workspace.',
    docsUrl: 'https://slack.com/help/articles/205168057-Custom-SAML-single-sign-on',
    launchUrl: 'https://{{workspace}}.slack.com',
    variables: [
      {
        key: 'workspace',
        label: 'Workspace subdomain',
        example: 'acme',
        hint: 'The part before .slack.com',
      },
    ],
    saml: {
      spEntityId: 'https://slack.com',
      acsUrls: ['https://{{workspace}}.slack.com/sso/saml'],
      nameIdFormat: PERSISTENT_NAMEID,
      claims: [
        { claimName: 'User.Email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'first_name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'last_name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'zoom',
    name: 'Zoom',
    category: 'collaboration',
    description: 'Meetings and phone. One entry per Zoom account.',
    docsUrl: 'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065239',
    launchUrl: 'https://{{subdomain}}.zoom.us',
    variables: [
      { key: 'subdomain', label: 'Vanity subdomain', example: 'acme' },
    ],
    saml: {
      spEntityId: 'https://{{subdomain}}.zoom.us',
      acsUrls: ['https://{{subdomain}}.zoom.us/saml/SSO'],
      nameIdFormat: EMAIL_NAMEID,
      sloUrl: 'https://{{subdomain}}.zoom.us/saml/SingleLogout',
      claims: [
        { claimName: 'Email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'First Name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'Last Name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'miro',
    name: 'Miro',
    category: 'collaboration',
    description: 'Online whiteboard. One entry per Miro Enterprise account.',
    docsUrl:
      'https://help.miro.com/hc/en-us/articles/21899027429778-Miro-metadata-for-Single-sign-on-configuration',
    variables: [],
    saml: {
      // Constant, like Slack's. With more than one identity provider on the
      // account Miro switches to https://miro.com/<org_id>/<saml_settings_id>
      // and a matching ACS URL; register that case by hand.
      spEntityId: 'https://miro.com',
      acsUrls: ['https://miro.com/sso/saml'],
      nameIdFormat: EMAIL_NAMEID,
      claims: [
        {
          claimName: 'FirstName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'LastName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
        {
          claimName: 'DisplayName',
          nameFormat: BASIC,
          sourceKind: 'user',
          sourceField: 'displayName',
        },
      ],
    },
  },
  {
    key: 'figma',
    name: 'Figma',
    category: 'collaboration',
    description: 'Interface design. One entry per Figma organization.',
    docsUrl:
      'https://help.figma.com/hc/en-us/articles/360040047774-Set-up-a-custom-SAML-configuration',
    variables: [
      {
        key: 'tenantId',
        label: 'Tenant ID',
        example: '123456789123456789',
        hint: 'From Admin → Settings → SAML SSO in Figma',
      },
    ],
    saml: {
      spEntityId: 'https://www.figma.com/saml/{{tenantId}}',
      acsUrls: ['https://www.figma.com/saml/{{tenantId}}/consume'],
      nameIdFormat: EMAIL_NAMEID,
      claims: [],
    },
  },
  {
    key: 'lucid',
    name: 'Lucid',
    category: 'collaboration',
    description: 'Lucidchart and Lucidspark diagrams. One entry per Lucid Enterprise account.',
    docsUrl: 'https://help.lucid.co/hc/en-us/articles/360049898191-SAML-overview',
    // Lucid's documented sign-on URL, which starts SP-initiated sign-in.
    launchUrl: 'https://lucid.app/saml/sso/{{domain}}',
    variables: [
      {
        key: 'domain',
        label: 'SAML domain',
        example: 'acme.example',
        hint: 'The domain entered on the SAML tile in Lucid',
      },
    ],
    saml: {
      // Constant whatever the account, and not a URL.
      spEntityId: 'lucidchart.com',
      acsUrls: ['https://lucid.app/saml/sso/{{domain}}'],
      nameIdFormat: EMAIL_NAMEID,
      claims: [
        { claimName: 'user.email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'user.firstname',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'user.lastname',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'rocket-chat',
    name: 'Rocket.Chat',
    category: 'collaboration',
    description: 'Self-hosted team chat, through its SAML settings (a premium feature).',
    docsUrl: 'https://docs.rocket.chat/docs/saml-configuration',
    launchUrl: 'https://{{host}}',
    variables: [
      { key: 'host', label: 'Rocket.Chat hostname', example: 'chat.acme.example' },
      {
        key: 'provider',
        label: 'Custom Provider',
        example: 'syntra',
        hint: 'The Custom Provider name in Rocket.Chat → Settings → SAML',
      },
    ],
    saml: {
      // The Custom Issuer, set by convention to the metadata URL. Rocket.Chat
      // serves its SP metadata there, so importing it is the better route.
      spEntityId: 'https://{{host}}/_saml/metadata/{{provider}}',
      acsUrls: ['https://{{host}}/_saml/validate/{{provider}}'],
      nameIdFormat: EMAIL_NAMEID,
      // The names in the example User Data Field Map on the docs page. Paste
      // that map into Rocket.Chat, or change these to match yours.
      claims: [
        { claimName: 'mail', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'firstName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'lastName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
        { claimName: 'uid', nameFormat: BASIC, sourceKind: 'user', sourceField: 'login' },
      ],
    },
  },
  {
    key: 'google-workspace',
    name: 'Google Workspace',
    category: 'productivity',
    description: 'Mail, Drive and Docs, with Syntra as the sign-in for the domain.',
    docsUrl: 'https://support.google.com/a/answer/6087519',
    launchUrl: 'https://mail.google.com/a/{{domain}}',
    variables: [
      { key: 'domain', label: 'Primary domain', example: 'acme.example' },
    ],
    saml: {
      spEntityId: 'google.com/a/{{domain}}',
      acsUrls: ['https://www.google.com/a/{{domain}}/acs'],
      // Google matches the assertion to an account by primary email, and
      // rejects anything else outright.
      nameIdFormat: EMAIL_NAMEID,
      claims: [],
    },
  },
  {
    key: 'salesforce',
    name: 'Salesforce',
    category: 'productivity',
    description: 'CRM. One entry per Salesforce org.',
    docsUrl:
      'https://help.salesforce.com/s/articleView?id=sf.sso_saml_setting_up.htm&type=5',
    launchUrl: 'https://{{myDomain}}.my.salesforce.com',
    variables: [
      {
        key: 'myDomain',
        label: 'My Domain name',
        example: 'acme',
        hint: 'From Setup → My Domain',
      },
    ],
    saml: {
      spEntityId: 'https://saml.salesforce.com',
      acsUrls: ['https://{{myDomain}}.my.salesforce.com'],
      nameIdFormat: EMAIL_NAMEID,
      claims: [],
    },
  },
  {
    key: 'nextcloud',
    name: 'Nextcloud',
    category: 'productivity',
    description: 'Self-hosted files and collaboration, through the SSO & SAML app.',
    docsUrl:
      'https://docs.nextcloud.com/server/latest/admin_manual/configuration_server/sso_configuration.html',
    launchUrl: 'https://{{host}}',
    variables: [
      { key: 'host', label: 'Nextcloud hostname', example: 'cloud.acme.example' },
    ],
    saml: {
      spEntityId: 'https://{{host}}/apps/user_saml/saml/metadata',
      acsUrls: ['https://{{host}}/apps/user_saml/saml/acs'],
      nameIdFormat: EMAIL_NAMEID,
      sloUrl: 'https://{{host}}/apps/user_saml/saml/sls',
      claims: [
        { claimName: 'email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'displayName',
          nameFormat: BASIC,
          sourceKind: 'user',
          sourceField: 'displayName',
        },
      ],
    },
  },
  {
    key: 'box',
    name: 'Box',
    category: 'productivity',
    description: 'Cloud file storage and sharing. One entry per Box enterprise.',
    docsUrl:
      'https://docs.box.com/en/box-admin-tools/box-security/setting-up-single-sign-on-sso-for-your-organization',
    // The company-branded subdomain is where Box documents SSO sign-in
    // starting: Continue there forwards to the IdP.
    launchUrl: 'https://{{subdomain}}.box.com',
    variables: [
      {
        key: 'subdomain',
        label: 'Box subdomain',
        example: 'acme',
        hint: 'The part before .box.com',
      },
    ],
    saml: {
      // Constant whatever the enterprise, and not a URL.
      spEntityId: 'box.net',
      acsUrls: ['https://sso.services.box.net/sp/ACS.saml2'],
      nameIdFormat: EMAIL_NAMEID,
      // Box asks for the email, first-name and last-name attribute names
      // when SSO is set up; these are the names its page gives as the
      // example. The names are used only when Box creates an account.
      claims: [
        { claimName: 'email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'firstName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'lastName',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'snipe-it',
    name: 'Snipe-IT',
    category: 'itsm',
    description: 'Asset management. Self-hosted, with SAML enabled in its settings.',
    docsUrl: 'https://snipe-it.readme.io/docs/saml',
    // Snipe-IT's SP-initiated start page, not its home page. A catalog SAML
    // application is created with IdP-initiated sign-in OFF, so the portal
    // tile opens `launchUrl` and relies on the application to send an
    // AuthnRequest back. /login/saml does exactly that — verified live: it
    // answers 302 to Syntra's /saml/sso with a SAMLRequest — whereas the bare
    // host shows Snipe-IT's own login form and leaves the user to find the
    // SSO button.
    launchUrl: 'https://{{host}}/login/saml',
    variables: [
      { key: 'host', label: 'Snipe-IT hostname', example: 'assets.acme.example' },
    ],
    saml: {
      // The entity ID Snipe-IT publishes in its own metadata is its bare base
      // URL, not the metadata URL. Checked against a live instance's
      // /saml/metadata: `entityID="https://<host>"`. A mismatch here is a
      // refused AuthnRequest on every sign-in, so importing the SP's metadata
      // remains the better route where it is reachable.
      spEntityId: 'https://{{host}}',
      acsUrls: ['https://{{host}}/saml/acs'],
      nameIdFormat: EMAIL_NAMEID,
      sloUrl: 'https://{{host}}/saml/sls',
      // Snipe-IT's metadata publishes /saml/sls as HTTP-Redirect only.
      sloBinding: 'HTTP-Redirect',
      claims: [
        { claimName: 'username', nameFormat: BASIC, sourceKind: 'user', sourceField: 'login' },
        { claimName: 'email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'firstname',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'lastname',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'grafana',
    name: 'Grafana',
    category: 'engineering',
    description: 'Dashboards, through its generic OAuth provider.',
    docsUrl:
      'https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/generic-oauth/',
    launchUrl: 'https://{{host}}',
    variables: [
      { key: 'host', label: 'Grafana hostname', example: 'grafana.acme.example' },
    ],
    oidc: {
      redirectUris: ['https://{{host}}/login/generic_oauth'],
      scopes: ['openid', 'profile', 'email'],
      claims: [],
    },
  },
  {
    key: 'gitlab',
    name: 'GitLab',
    category: 'engineering',
    description: 'Self-managed GitLab, through its OpenID Connect omniauth provider.',
    docsUrl: 'https://docs.gitlab.com/ee/administration/auth/oidc.html',
    launchUrl: 'https://{{host}}',
    variables: [
      { key: 'host', label: 'GitLab hostname', example: 'git.acme.example' },
    ],
    oidc: {
      redirectUris: ['https://{{host}}/users/auth/openid_connect/callback'],
      scopes: ['openid', 'profile', 'email'],
      claims: [],
    },
  },
  {
    key: 'pagerduty',
    name: 'PagerDuty',
    category: 'engineering',
    description: 'On-call scheduling and incident response. One entry per PagerDuty account.',
    docsUrl: 'https://support.pagerduty.com/main/docs/sso',
    launchUrl: 'https://{{subdomain}}.pagerduty.com',
    variables: [
      {
        key: 'subdomain',
        label: 'Account subdomain',
        example: 'acme',
        hint: 'The part before .pagerduty.com',
      },
    ],
    saml: {
      // No trailing slash on either: PagerDuty answers 400 to one.
      spEntityId: 'https://{{subdomain}}.pagerduty.com',
      acsUrls: ['https://{{subdomain}}.pagerduty.com/sso/saml/consume'],
      nameIdFormat: EMAIL_NAMEID,
      // Used only when PagerDuty auto-provisions the account.
      claims: [
        {
          claimName: 'Name',
          nameFormat: BASIC,
          sourceKind: 'user',
          sourceField: 'displayName',
        },
      ],
    },
  },
  {
    key: 'sentry',
    name: 'Sentry',
    category: 'engineering',
    description: 'Error and performance monitoring on sentry.io. One entry per Sentry organization.',
    docsUrl: 'https://docs.sentry.io/organization/authentication/sso/saml2/',
    variables: [
      {
        key: 'org',
        label: 'Organization slug',
        example: 'acme',
        hint: 'From Settings → General Settings in Sentry',
      },
    ],
    saml: {
      // Sentry's entity ID is its metadata URL, trailing slash included.
      spEntityId: 'https://sentry.io/saml/metadata/{{org}}/',
      acsUrls: ['https://sentry.io/saml/acs/{{org}}/'],
      nameIdFormat: EMAIL_NAMEID,
      // Sentry asks which attribute carries each value under Map IdP
      // Attributes. Enter these names there. The user ID must never change.
      claims: [
        { claimName: 'user_id', nameFormat: BASIC, sourceKind: 'user', sourceField: 'login' },
        { claimName: 'email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'first_name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'givenName',
        },
        {
          claimName: 'last_name',
          nameFormat: BASIC,
          sourceKind: 'person',
          sourceField: 'familyName',
        },
      ],
    },
  },
  {
    key: 'jenkins',
    name: 'Jenkins',
    category: 'engineering',
    description: 'Self-hosted CI server, through the SAML plugin.',
    docsUrl: 'https://github.com/jenkinsci/saml-plugin/blob/main/doc/CONFIGURE.md',
    variables: [
      { key: 'host', label: 'Jenkins hostname', example: 'ci.acme.example' },
    ],
    saml: {
      // The plugin's default entity ID is the finishLogin URL, unless its
      // SP Entity ID field overrides it. Its metadata at
      // https://<host>/securityRealm/metadata shows the value in use. The
      // plugin signs AuthnRequests only once its signing option is on.
      spEntityId: 'https://{{host}}/securityRealm/finishLogin',
      acsUrls: ['https://{{host}}/securityRealm/finishLogin'],
      nameIdFormat: EMAIL_NAMEID,
      // Enter these names in the plugin's Username, Email, Display Name and
      // Group Attribute fields.
      claims: [
        { claimName: 'username', nameFormat: BASIC, sourceKind: 'user', sourceField: 'login' },
        { claimName: 'email', nameFormat: BASIC, sourceKind: 'user', sourceField: 'email' },
        {
          claimName: 'displayName',
          nameFormat: BASIC,
          sourceKind: 'user',
          sourceField: 'displayName',
        },
        { claimName: 'groups', nameFormat: BASIC, sourceKind: 'groups', multiValued: true },
      ],
    },
  },
  {
    key: 'aws-iam-identity-center',
    name: 'AWS IAM Identity Center',
    category: 'security',
    description:
      'Sign-in to AWS accounts. The entity ID and ACS URL come from the Identity Center console.',
    docsUrl:
      'https://docs.aws.amazon.com/singlesignon/latest/userguide/idp-managed-idp.html',
    variables: [
      {
        key: 'acsUrl',
        label: 'ACS URL',
        example: 'https://eu-west-1.signin.aws.amazon.com/platform/saml/acs/0000-0000',
        hint: 'Copied from Identity Center → Settings → Identity source',
      },
      {
        key: 'entityId',
        label: 'Issuer URL',
        example: 'https://eu-west-1.signin.aws.amazon.com/platform/saml/d-0000000000',
      },
    ],
    saml: {
      // Both values are generated per Identity Center instance, so there is
      // nothing to prefill: this entry earns its place by naming the two
      // fields, where to find them, and the NameID format AWS requires --
      // which is the part people get wrong.
      spEntityId: '{{entityId}}',
      acsUrls: ['{{acsUrl}}'],
      nameIdFormat: PERSISTENT_NAMEID,
      claims: [
        {
          claimName: 'https://aws.amazon.com/SAML/Attributes/AccessControl:Email',
          nameFormat: URI,
          sourceKind: 'user',
          sourceField: 'email',
        },
      ],
    },
  },
];
