import { randomBytes } from 'node:crypto';
import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { issueServiceToken } from '../crypto/signing.js';
import { AppError } from '../middleware/errors.js';

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- create (admin / out-of-band) ----------

export interface CreateClientInput {
  name: string;
  scopes?: string[];
}

export interface CreatedClient {
  id: string;
  clientId: string;
  clientSecret: string; // plaintext, returned once
  name: string;
  scopes: string[];
}

export async function createServiceClient(input: CreateClientInput): Promise<CreatedClient> {
  // client_id: human-pickable prefix + 12 random base32 chars.
  const clientId = `svc_${randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
  // client_secret: 32 bytes base64url, shown once, hashed at rest.
  const clientSecret = randomBytes(32).toString('base64url');

  const row = await prisma.serviceClient.create({
    data: {
      clientId,
      clientSecretHash: await hashPassword(clientSecret),
      name: input.name,
      scopes: input.scopes ?? [],
    },
  });

  await audit({ event: 'service.client.created', metadata: { clientId, name: input.name } });

  return {
    id: row.id,
    clientId,
    clientSecret,
    name: row.name,
    scopes: row.scopes,
  };
}

// ---------- token (client_credentials grant) ----------

export interface ClientCredentialsInput {
  clientId: string;
  clientSecret: string;
  requestedScopes?: string[]; // optional narrowing — must be subset of allowed
}

export async function issueClientCredentialsToken(
  input: ClientCredentialsInput,
  ctx: RequestCtx = {},
): Promise<{ accessToken: string; expiresIn: number; scopes: string[] }> {
  const generic = new AppError(401, 'invalid_client', 'invalid client credentials');

  const client = await prisma.serviceClient.findUnique({ where: { clientId: input.clientId } });
  if (!client || client.disabled) {
    await audit({
      event: 'service.token.fail.unknown_client',
      metadata: { clientId: input.clientId },
      ...ctx,
    });
    throw generic;
  }

  const ok = await verifyPassword(client.clientSecretHash, input.clientSecret);
  if (!ok) {
    await audit({
      event: 'service.token.fail.bad_secret',
      metadata: { clientId: input.clientId },
      ...ctx,
    });
    throw generic;
  }

  // If the caller asked for a subset of scopes, honor it. Otherwise grant all
  // scopes the client is configured for.
  let scopes = client.scopes;
  if (input.requestedScopes && input.requestedScopes.length > 0) {
    const allowed = new Set(client.scopes);
    const filtered = input.requestedScopes.filter((s) => allowed.has(s));
    if (filtered.length === 0) {
      throw new AppError(403, 'invalid_scope', 'no requested scopes are allowed for this client');
    }
    scopes = filtered;
  }

  const { token, expiresIn } = await issueServiceToken({
    clientId: client.clientId,
    scopes,
  });

  await prisma.serviceClient.update({
    where: { id: client.id },
    data: { lastUsedAt: new Date() },
  });

  await audit({
    event: 'service.token.issued',
    metadata: { clientId: client.clientId, scopes },
    ...ctx,
  });

  return { accessToken: token, expiresIn, scopes };
}
