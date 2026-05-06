// Out-of-band CLI for granting / revoking the admin role.
// Usage:
//   npx tsx src/scripts/grantAdmin.ts --email=you@example.com
//   npx tsx src/scripts/grantAdmin.ts --email=you@example.com --revoke
// After build:
//   node dist/scripts/grantAdmin.js --email=you@example.com
//
// Bootstrap path: there's no /v1/admin/* endpoint to grant the very first
// admin (you'd need to be one to call it), so this script flips User.roles
// directly. Subsequent admins are granted via PATCH /v1/admin/users/:id.

import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';

interface Args {
  email: string;
  revoke: boolean;
}

const ADMIN_ROLE = 'admin';

function parseArgs(argv: string[]): Args {
  let email: string | undefined;
  let revoke = false;
  for (const arg of argv) {
    if (arg.startsWith('--email=')) email = arg.slice('--email='.length).toLowerCase().trim();
    else if (arg === '--revoke') revoke = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      // eslint-disable-next-line no-console
      console.error(`unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!email) {
    // eslint-disable-next-line no-console
    console.error('--email=<address> is required');
    printHelp();
    process.exit(2);
  }
  return { email, revoke };
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  grant-admin --email=<address>            Add the 'admin' role to a user.
  grant-admin --email=<address> --revoke   Remove the 'admin' role.

Notes:
  - The user must exist; the script does not create accounts.
  - Existing access tokens still pass requireAdmin until they expire
    (≤ 15 minutes) or until you revoke the user's sessions.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const user = await prisma.user.findUnique({ where: { email: args.email } });
  if (!user) {
    // eslint-disable-next-line no-console
    console.error(`no user with email ${args.email}`);
    process.exit(1);
  }

  const has = user.roles.includes(ADMIN_ROLE);
  if (args.revoke) {
    if (!has) {
      // eslint-disable-next-line no-console
      console.log(`${args.email} does not have the admin role; nothing to do`);
      return;
    }
    const next = user.roles.filter((r) => r !== ADMIN_ROLE);
    await prisma.user.update({ where: { id: user.id }, data: { roles: next } });
    await audit({
      event: 'admin.role.revoked',
      userId: user.id,
      metadata: { actor: 'cli:grant-admin', role: ADMIN_ROLE },
    });
    // eslint-disable-next-line no-console
    console.log(`removed admin role from ${args.email}`);
  } else {
    if (has) {
      // eslint-disable-next-line no-console
      console.log(`${args.email} already has the admin role; nothing to do`);
      return;
    }
    const next = [...user.roles, ADMIN_ROLE];
    await prisma.user.update({ where: { id: user.id }, data: { roles: next } });
    await audit({
      event: 'admin.role.granted',
      userId: user.id,
      metadata: { actor: 'cli:grant-admin', role: ADMIN_ROLE },
    });
    // eslint-disable-next-line no-console
    console.log(`granted admin role to ${args.email}`);
    // eslint-disable-next-line no-console
    console.log(
      'note: any existing access tokens remain admin-capable until they expire ' +
        '(<= 15 min) or sessions are revoked. fresh logins immediately reflect the new role.',
    );
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
