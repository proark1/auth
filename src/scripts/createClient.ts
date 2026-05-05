// Out-of-band CLI for provisioning a service client.
// Usage:
//   npx tsx src/scripts/createClient.ts \
//     --name="HR Service" \
//     --scopes="hr:read,hr:write" \
//     --from-address="noreply@hr.yourco.com" \
//     --verify-subject="Verify your HR account" \
//     --reset-subject="Reset your HR password"
// Or after build:
//   node dist/scripts/createClient.js --name="HR Service" ...
//
// On success prints CLIENT_ID and CLIENT_SECRET. The secret is shown only here
// — copy it into the consumer service's secret store immediately.
//
// Branding flags are optional; any omitted flag falls back to the global
// EMAIL_SERVICE_FROM / hardcoded subject when this client proxies a register
// or password-forgot call.

import { createServiceClient } from '../domain/services.js';
import { prisma } from '../infra/db.js';

interface Args {
  name: string;
  scopes: string[];
  fromAddress?: string;
  verifyEmailSubject?: string;
  passwordResetSubject?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & { scopes?: string[] } = {};
  for (const arg of argv) {
    if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else if (arg.startsWith('--scopes=')) {
      args.scopes = arg
        .slice('--scopes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--from-address=')) {
      args.fromAddress = arg.slice('--from-address='.length);
    } else if (arg.startsWith('--verify-subject=')) {
      args.verifyEmailSubject = arg.slice('--verify-subject='.length);
    } else if (arg.startsWith('--reset-subject=')) {
      args.passwordResetSubject = arg.slice('--reset-subject='.length);
    }
  }
  if (!args.name) {
    throw new Error('--name is required, e.g. --name="HR Service"');
  }
  return {
    name: args.name,
    scopes: args.scopes ?? [],
    ...(args.fromAddress ? { fromAddress: args.fromAddress } : {}),
    ...(args.verifyEmailSubject ? { verifyEmailSubject: args.verifyEmailSubject } : {}),
    ...(args.passwordResetSubject ? { passwordResetSubject: args.passwordResetSubject } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const created = await createServiceClient(args);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        client_id: created.clientId,
        client_secret: created.clientSecret,
        name: created.name,
        scopes: created.scopes,
        from_address: created.fromAddress,
        verify_email_subject: created.verifyEmailSubject,
        password_reset_subject: created.passwordResetSubject,
        warning: 'Store client_secret now — it is not retrievable later.',
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
