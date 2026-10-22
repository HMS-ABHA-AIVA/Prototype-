import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { AppError, badRequest } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";

/**
 * Text messages and one-time codes (OTP) of the hospital modules (patient app sign-in, reminders ...). The product sends them
 * through an SmsProvider; until the hospital's SMS service is chosen the provider is the SIMULATOR, which writes the message to
 * the outbox table instead of sending it. Switching to a real service means adding a provider class and setting SMS_PROVIDER.
 * (ABHA OTPs are sent by ABDM itself, not by this module.)
 *
 * In simulator mode the code is always 123456, so flows can be tried by hand and tested without reading a phone.
 */
export interface SmsProvider {
  readonly name: string;
  /** Sends one message. Throws if it could not be sent. */
  send(db: Queryable, message: { to: string; body: string; purpose: string }): Promise<void>;
}

export class SimulatedSms implements SmsProvider {
  readonly name = "simulator";
  async send(db: Queryable, m: { to: string; body: string; purpose: string }) {
    await db.execute('INSERT INTO "SmsOutbox" ("facilityId", "toPhone", body, purpose, provider) VALUES (:fid, $1, $2, $3, $4)', [m.to, m.body, m.purpose, this.name]);
  }
}

export function createSmsProvider(name: string): SmsProvider {
  if (name === "simulator") return new SimulatedSms();
  throw new Error(`SMS_PROVIDER=${name} is not available: only "simulator" is built in. Add the provider in src/hospital/modules/messaging.`);
}

const SIMULATOR_CODE = "123456";
const CODE_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = 5;

const hashCode = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

/** Indian mobile numbers: 10 digits starting 6-9, with or without +91 / 0 in front. Returns the 10 digits. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) throw badRequest("Enter a valid 10-digit mobile number");
  return digits;
}

export class OtpService {
  constructor(private readonly sms: SmsProvider) {}

  /** Sends a code to the number. Returns the challenge to verify against (never the code itself). */
  async issue(db: Queryable, input: { phone: string; purpose: string }): Promise<{ challengeId: string; expiresInSeconds: number }> {
    const phone = normalizePhone(input.phone);
    const recent = await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM "OtpChallenge" WHERE "facilityId" = :fid AND phone = $1 AND purpose = $2 AND "createdAt" > now() - interval '1 hour'`,
      [phone, input.purpose],
    );
    if ((recent?.n ?? 0) >= MAX_PER_HOUR) throw new AppError(429, "RATE_LIMITED", "Too many codes were requested for this number. Please try again later.");

    const code = this.sms.name === "simulator" ? SIMULATOR_CODE : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO "OtpChallenge" ("facilityId", phone, purpose, "codeHash", "expiresAt") VALUES (:fid, $1, $2, 'pending', now() + make_interval(mins => $3)) RETURNING id`,
      [phone, input.purpose, CODE_MINUTES],
    );
    await db.execute('UPDATE "OtpChallenge" SET "codeHash" = $2 WHERE "facilityId" = :fid AND id = $1', [row!.id, hashCode(row!.id, code)]);
    await this.sms.send(db, { to: phone, body: `${code} is your verification code. It is valid for ${CODE_MINUTES} minutes. Do not share it.`, purpose: input.purpose });
    return { challengeId: row!.id, expiresInSeconds: CODE_MINUTES * 60 };
  }

  /** True when the code is right. A wrong code counts against the challenge, which stops accepting any code after a few tries. */
  async verify(db: Queryable, challengeId: string, code: string): Promise<{ phone: string; purpose: string }> {
    const challenge = await db.queryOne<{ id: string; phone: string; purpose: string; codeHash: string; expired: boolean; attempts: number; consumed: boolean }>(
      `SELECT id, phone, purpose, "codeHash", ("expiresAt" < now()) AS expired, attempts, consumed FROM "OtpChallenge" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`,
      [challengeId],
    );
    const invalid = new AppError(400, "OTP_INVALID", "That code is not correct or has expired. Ask for a new one.");
    if (!challenge || challenge.consumed || challenge.expired || challenge.attempts >= MAX_ATTEMPTS) throw invalid;

    const given = Buffer.from(hashCode(challenge.id, code.trim()));
    const expected = Buffer.from(challenge.codeHash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      await db.execute('UPDATE "OtpChallenge" SET attempts = attempts + 1 WHERE "facilityId" = :fid AND id = $1', [challengeId]);
      throw invalid;
    }
    await db.execute('UPDATE "OtpChallenge" SET consumed = true WHERE "facilityId" = :fid AND id = $1', [challengeId]);
    return { phone: challenge.phone, purpose: challenge.purpose };
  }
}

/** /api/v1/messages: for administrators, to see what the simulator "sent" (and later, the delivery log of a real provider). */
export function messagingRouter({ db, sms }: HospitalContext): Router {
  const router = Router();
  router.use(requireRole("admin"));

  router.get("/outbox", async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json({
      provider: sms.name,
      messages: await db.query(
        `SELECT id, "toPhone", body, purpose, provider, status, "createdAt" FROM "SmsOutbox" WHERE "facilityId" = :fid ORDER BY "createdAt" DESC LIMIT $1`,
        [limit],
      ),
    });
  });

  return router;
}
