import { generateKeyPair, exportJWK, importJWK, SignJWT, jwtVerify, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';
import type { SigningKey } from '@prisma/client';
import { prisma } from '../infra/db.js';
import { encrypt, decrypt } from './encryption.js';
import { env } from '../infra/env.js';
import { accessClaimsSchema, mfaClaimsSchema, type AccessClaims, type MfaClaims } from './claims.js';

const ALG = 'EdDSA';
const CRV = 'Ed25519';

// ---------- key lifecycle ----------

export async function generateAndStoreSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { crv: CRV, extractable: true });

  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  const kid = randomUUID();
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';

  return prisma.signingKey.create({
    data: {
      kid,
      alg: ALG,
      publicJwk: publicJwk as object,
      privateEnc: encrypt(JSON.stringify(privateJwk)),
      status: 'ACTIVE',
    },
  });
}

async function getActiveKey(): Promise<SigningKey> {
  const k = await prisma.signingKey.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  if (k) return k;
  return generateAndStoreSigningKey();
}

export async function rotateSigningKey(): Promise<SigningKey> {
  const fresh = await generateAndStoreSigningKey();
  // demote previous ACTIVE keys to RETIRING — still in JWKS for verification
  await prisma.signingKey.updateMany({
    where: { status: 'ACTIVE', id: { not: fresh.id } },
    data: { status: 'RETIRING' },
  });
  return fresh;
}

// JWKS includes ACTIVE + RETIRING keys so in-flight tokens still verify.
export async function jwks(): Promise<{ keys: JWK[] }> {
  const rows = await prisma.signingKey.findMany({
    where: { status: { in: ['ACTIVE', 'RETIRING'] } },
  });
  return { keys: rows.map((r) => r.publicJwk as unknown as JWK) };
}

// ---------- sign / verify ----------

export interface IssueAccessInput {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  roles?: string[];
  orgId?: string;
}

export async function issueAccessToken(input: IssueAccessInput): Promise<string> {
  const e = env();
  const key = await getActiveKey();
  const privateJwk = JSON.parse(decrypt(key.privateEnc).toString('utf8'));
  const privateKey = await importJWK(privateJwk, ALG);

  const jwt = new SignJWT({
    typ: 'access',
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.emailVerified !== undefined ? { email_verified: input.emailVerified } : {}),
    roles: input.roles ?? [],
    ...(input.orgId !== undefined ? { org_id: input.orgId } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuer(e.JWT_ISSUER)
    .setAudience(e.JWT_AUDIENCE)
    .setSubject(input.sub)
    .setIssuedAt()
    .setExpirationTime(`${e.ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID());

  return jwt.sign(privateKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const payload = await verifyAnyToken(token);
  return accessClaimsSchema.parse(payload);
}

// ---------- MFA challenge token ----------

const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export async function issueMfaChallenge(userId: string): Promise<string> {
  const e = env();
  const key = await getActiveKey();
  const privateJwk = JSON.parse(decrypt(key.privateEnc).toString('utf8'));
  const privateKey = await importJWK(privateJwk, ALG);

  return new SignJWT({ typ: 'mfa' })
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuer(e.JWT_ISSUER)
    .setAudience(e.JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(privateKey);
}

export async function verifyMfaChallenge(token: string): Promise<MfaClaims> {
  const payload = await verifyAnyToken(token);
  return mfaClaimsSchema.parse(payload);
}

// ---------- shared verifier ----------

async function verifyAnyToken(token: string): Promise<unknown> {
  const e = env();
  const { keys } = await jwks();
  const { payload } = await jwtVerify(
    token,
    async (header) => {
      const jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) throw new Error('unknown signing key');
      return importJWK(jwk, ALG);
    },
    { issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE },
  );
  return payload;
}
