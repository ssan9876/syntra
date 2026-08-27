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
    key: 'snipe-it',
    name: 'Snipe-IT',
    category: 'itsm',
    description: 'Asset management. Self-hosted, with SAML enabled in its settings.',
    docsUrl: 'https://snipe-it.readme.io/docs/saml',
    launchUrl: 'https://{{host}}',
    variables: [
      { key: 'host', label: 'Snipe-IT hostname', example: 'assets.acme.example' },
    ],
    saml: {
      spEntityId: 'https://{{host}}/saml/metadata',
      acsUrls: ['https://{{host}}/saml/acs'],
      nameIdFormat: EMAIL_NAMEID,
      sloUrl: 'https://{{host}}/saml/sls',
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
