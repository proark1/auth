// Out-of-band CLI for provisioning a service client.
// Usage:
//   npx tsx src/scripts/createClient.ts \
//     --name="HR Service" \
//     --scopes="hr:read,hr:write" \
//     --audience="hr-service" \
//     --web-base-url="https://hr.yourco.com" \
//     --from-address="noreply@hr.yourco.com" \
//     --verify-subject="Verify your HR account" \
//     --reset-subject="Reset your HR password"
// Or after build:
//   node dist/scripts/createClient.js --name="HR Service" ...
//
// On success prints CLIENT_ID and CLIENT_SECRET. The secret is shown only here
// — copy it into the consumer service's secret store immediately.
//
// --audience is the `aud` value the auth-service stamps on access tokens for
// users registered through this client. Each consumer should validate against
// its own audience to prevent cross-tenant token reuse. Falls back to the
// global JWT_AUDIENCE if omitted.
// --web-base-url is the public origin used when building links in outgoing
// emails (verify-email, password reset). Required: silently falling back to
// the auth-service's own WEB_BASE_URL ships verification links for the wrong
// domain to end users and is almost never what an integrator wants.

import { createServiceClient } from '../domain/services.js';
import { prisma } from '../infra/db.js';

interface Args {
  name: string;
  scopes: string[];
  webBaseUrl: string;
  fromAddress?: string;
  verifyEmailSubject?: string;
  passwordResetSubject?: string;
  audience?: string;
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
    } else if (arg.startsWith('--audience=')) {
      args.audience = arg.slice('--audience='.length);
    } else if (arg.startsWith('--web-base-url=')) {
      args.webBaseUrl = arg.slice('--web-base-url='.length);
    }
  }
  if (!args.name) {
    throw new Error('--name is required, e.g. --name="HR Service"');
  }
  if (!args.webBaseUrl) {
    throw new Error(
      '--web-base-url is required, e.g. --web-base-url="https://www.ourteammanagement.com" — ' +
        'this is the origin used to build verify-email and password-reset links sent to ' +
        "this client's users.",
    );
  }
  try {
    new URL(args.webBaseUrl);
  } catch {
    throw new Error(`--web-base-url must be a valid absolute URL, got: ${args.webBaseUrl}`);
  }
  return {
    name: args.name,
    scopes: args.scopes ?? [],
    webBaseUrl: args.webBaseUrl,
    ...(args.fromAddress ? { fromAddress: args.fromAddress } : {}),
    ...(args.verifyEmailSubject ? { verifyEmailSubject: args.verifyEmailSubject } : {}),
    ...(args.passwordResetSubject ? { passwordResetSubject: args.passwordResetSubject } : {}),
    ...(args.audience ? { audience: args.audience } : {}),
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
        audience: created.audience,
        web_base_url: created.webBaseUrl,
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
