/**
 * Development seed. Creates one tenant with an owner, a few groups and org
 * units, and three people chosen to exercise the cases a flattened identity
 * model gets wrong: concurrent contracts, an ended contract, and no contract
 * at all.
 *
 * Refuses to run without SEED_ADMIN_PASSWORD so it can never quietly create a
 * known-password account in an environment that is not a developer's laptop.
 */
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import {
  ALL_PERMISSIONS,
  addRule,
  assignApplication,
  assignRole,
  createApplication,
  createContract,
  createGroup,
  createOrgUnit,
  createPerson,
  createRole,
  createUser,
  addMember,
  linkUserToPerson,
  setPassword,
} from '@syntra/core';

const adminPassword = process.env.SEED_ADMIN_PASSWORD;
const userPassword = process.env.SEED_USER_PASSWORD ?? adminPassword;

if (!adminPassword || adminPassword.length < 12) {
  console.error(
    'SEED_ADMIN_PASSWORD must be set and at least 12 characters. Refusing to seed.',
  );
  process.exit(1);
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const tenant = await prisma.tenant.upsert({
  where: { slug: 'acme' },
  create: {
    name: 'Acme Care',
    slug: 'acme',
    primaryDomain: 'acme.localhost',
  },
  update: {},
});

await withTenant(tenant.id, async (tx) => {
  const existing = await tx.user.findFirst({ where: { login: 'admin' } });
  if (existing) {
    console.log(`Tenant ${tenant.slug} is already seeded. Nothing to do.`);
    return;
  }

  const headOffice = await createOrgUnit(tx, 'Head Office');
  const care = await createOrgUnit(tx, 'Care', headOffice.id);
  await createOrgUnit(tx, 'Learning', headOffice.id);

  const owner = await createUser(tx, {
    login: 'admin',
    email: 'admin@acme.localhost',
    displayName: 'Ada Okonkwo',
    orgUnitId: headOffice.id,
  });
  await setPassword(tx, owner.id, adminPassword);

  const ownerRole = await createRole(tx, 'Owner', ALL_PERMISSIONS, {
    builtIn: true,
    description: 'Full administrative access to this tenant.',
  });
  await assignRole(tx, owner.id, ownerRole.id);

  const nurse = await createUser(tx, {
    login: 'jdoe',
    email: 'jo.doe@acme.localhost',
    displayName: 'Jo Doe',
    orgUnitId: care.id,
  });
  await setPassword(tx, nurse.id, userPassword!);

  const leaver = await createUser(tx, {
    login: 'sroe',
    email: 'sam.roe@acme.localhost',
    displayName: 'Sam Roe',
    orgUnitId: care.id,
  });
  await tx.user.update({
    where: { id: leaver.id },
    data: { status: 'inactive', statusReason: 'Left the organization' },
  });

  await createUser(tx, {
    login: 'svc-backup',
    email: 'ops@acme.localhost',
    displayName: 'Backup service',
  });

  const nurses = await createGroup(tx, 'Nurses', 'Clinical staff on the wards');
  await createGroup(tx, 'All staff', 'Everyone with a Syntra account');
  await addMember(tx, nurses.id, nurse.id);

  // Holds two concurrent contracts: the case a flattened User cannot express.
  const jo = await createPerson(tx, {
    givenName: 'Jo',
    familyName: 'Doe',
    businessEmail: 'jo.doe@acme.localhost',
    externalId: 'E1001',
  });
  await createContract(tx, jo.id, {
    sequence: 1,
    isPrimary: true,
    startDate: day('2024-03-01'),
    jobTitle: 'Staff Nurse',
    department: 'Care',
    employer: 'Acme Care',
  });
  await createContract(tx, jo.id, {
    sequence: 2,
    startDate: day('2026-01-15'),
    jobTitle: 'Clinical Trainer',
    department: 'Learning',
    employer: 'Acme Care',
    fte: 0.2,
  });
  await linkUserToPerson(tx, nurse.id, jo.id);

  // Contract has ended: still on record, no longer active.
  const sam = await createPerson(tx, {
    givenName: 'Sam',
    familyName: 'Roe',
    businessEmail: 'sam.roe@acme.localhost',
    externalId: 'E1002',
  });
  await createContract(tx, sam.id, {
    sequence: 1,
    isPrimary: true,
    startDate: day('2022-09-01'),
    endDate: day('2026-05-31'),
    jobTitle: 'Healthcare Assistant',
    department: 'Care',
  });
  await linkUserToPerson(tx, leaver.id, sam.id);

  // Known to the organization, starts next month, cannot sign in yet.
  const rin = await createPerson(tx, {
    givenName: 'Rin',
    familyName: 'Fujimoto',
    businessEmail: 'rin.fujimoto@acme.localhost',
    externalId: 'E1003',
  });
  await createContract(tx, rin.id, {
    sequence: 1,
    isPrimary: true,
    startDate: day('2026-10-01'),
    jobTitle: 'Ward Manager',
    department: 'Care',
  });

  // Three tiles, so the portal has something in it on a fresh install and the
  // three assignment kinds are each exercised by the seed rather than only by
  // tests.
  const wiki = await createApplication(tx, {
    name: 'Staff handbook',
    slug: 'handbook',
    description: 'Policies, rotas and induction material.',
    launchUrl: 'https://example.com/handbook',
  });
  const rota = await createApplication(tx, {
    name: 'Rota planner',
    slug: 'rota',
    description: 'Shift patterns for the coming month.',
    launchUrl: 'https://example.com/rota',
  });
  const finance = await createApplication(tx, {
    name: 'Expenses',
    slug: 'expenses',
    description: 'Submit and approve claims.',
    launchUrl: 'https://example.com/expenses',
  });

  await assignApplication(tx, wiki.id, { type: 'orgUnit', id: headOffice.id });
  await assignApplication(tx, rota.id, { type: 'group', id: nurses.id });
  await assignApplication(tx, finance.id, { type: 'user', id: owner.id });

  // One rule, shipped disabled. Nobody is locked out by it — a user with no
  // factor is offered enrolment rather than refused — but a fresh install
  // should not push a developer through enrolment on their first sign-in
  // before they have seen anything. Turning it on is one click in the console.
  //
  // Named for what it actually matches, and matching somebody. It used to read
  // "Finance, offsite, needs a second factor" while carrying neither an address
  // condition nor anybody in Finance — the seeded departments are Care and
  // Learning — so a developer who enabled it to watch MFA work saw nothing
  // happen and concluded the policy engine was broken. Jo Doe's second contract
  // is in Learning, which is the case worth demonstrating anyway: a rule about
  // one of a person's jobs matches them even when it is not their primary one.
  //
  // There is no address condition because "offsite" cannot be written as one.
  // `ipRanges` lists where a rule applies, so the office-network version of
  // this is two ordered rules — an `allow` naming the office range, then this
  // one — which is a thing to demonstrate in the console, not to ship enabled
  // in a seed.
  await addRule(tx, {
    name: 'Learning staff need a second factor',
    outcome: 'require_mfa',
    enabled: false,
    contractField: 'department',
    contractValues: ['Learning'],
  });

  console.log(`Seeded tenant ${tenant.slug} (${tenant.primaryDomain}).`);
  console.log('  admin / SEED_ADMIN_PASSWORD  — full administrative access');
  console.log('  jdoe  / SEED_USER_PASSWORD   — ordinary portal user');
});

await prisma.$disconnect();
