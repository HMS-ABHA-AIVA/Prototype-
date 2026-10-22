import "../env.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";

/**
 * Test harness for the hospital modules (/api/v1), ported with the AIVA OSHealth tests. Each test file starts the real
 * application in this process on a free port and works in a throwaway hospital of its own (created in the database and
 * removed at the end), so test files never see each other's data, and every test is also a check that hospitals stay apart.
 *
 * Runs only against a LOCAL database: the hospital tests write a lot, and must never touch a hosted (real) database.
 */
const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) && process.env.ALLOW_REMOTE_TEST_DB !== "true") {
  throw new Error("The hospital tests run only against a local PostgreSQL (DATABASE_URL on localhost). Set ALLOW_REMOTE_TEST_DB=true to override.");
}

export interface Reply {
  status: number;
  body: any;
}

export interface TestApi {
  /** e.g. http://127.0.0.1:53211 */
  url: string;
  facilityId: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  get(path: string): Promise<Reply>;
  post(path: string, body?: unknown): Promise<Reply>;
  /** A client signed in as someone with the given role (created on first use, with their own password chosen). */
  as(role: string): Promise<TestApi>;
  /** The staff id of the person this client is signed in as. */
  staffId: string;
  /** The e-mail address this client signs in with. */
  email: string;
  /** Runs SQL against this test hospital's data (use :fid for its facility id). */
  sql<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
  /** A second, separate hospital on the same installation (for isolation tests). */
  otherHospital(): Promise<TestApi>;
  /** The running application: its address and the hospital modules' context (database, AI settings, OTP service ...). */
  api: { url: string; ctx: HospitalContext };
  /** The sign-in token (also accepted as "Authorization: Bearer"). */
  token: string;
  /** Runs work inside this test hospital's scope (so hospital SQL and services see its data). */
  inHospital<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type HospitalContext = import("../../src/hospital/context.js").HospitalContext;

export const strongPassword = () => `Qa${randomBytes(6).toString("hex")}9Zx`;

let server: { server: Server; url: string; app: typeof import("../../src/app.js"); env: string } | null = null;

// No AI service unless a test sets one up (its own fake server): a key in the developer's environment must never be used.
const TEST_SETTINGS = {
  NODE_ENV: "test", RATE_LIMIT_ENABLED: "false", LOG_LEVEL: "silent", DRUG_ONLINE_LOOKUP: "false", FILE_STORE: "memory",
  ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", AI_PROVIDER: "", AI_MODEL: "", AI_API_URL: "", AI_PAID_TIER: "",
};
delete process.env.AI_REASONING_EFFORT;
// Set up once when the application starts; a test file that needs other values for these must be its own file.
const STARTUP_SETTINGS = ["NODE_ENV", "RATE_LIMIT_ENABLED", "FILE_STORE", "FILE_STORE_DIR", "SMS_PROVIDER", "PLATFORM_ADMIN_USERNAME", "PLATFORM_ADMIN_PASSWORD"];
const processEnv = { ...process.env };

/**
 * Starts the application once per test file. `env` is applied before it loads. A later call with other settings applies them
 * in place: the AI and drug-lookup settings are read on every request, so suites in one file can each have their own.
 */
async function startServer(env: Record<string, string>) {
  if (server) {
    if (JSON.stringify(env) !== server.env) {
      const before = JSON.parse(server.env) as Record<string, string>;
      const changed = STARTUP_SETTINGS.filter((key) => before[key] !== env[key]);
      if (changed.length) throw new Error(`startTestApi: ${changed.join(", ")} cannot change within one test file`);
      const { loadHospitalEnv } = await import("../../src/hospital/config.js");
      const live = server.app.hospital.ctx.env as unknown as Record<string, unknown>;
      for (const key of Object.keys(live)) delete live[key]; // settings that are now unset must go too
      Object.assign(live, loadHospitalEnv({ ...processEnv, ...TEST_SETTINGS, ...env }));
      server.env = JSON.stringify(env);
    }
    return server;
  }
  Object.assign(process.env, { ...TEST_SETTINGS, ...env });
  const app = await import("../../src/app.js");
  const listening: Server = await new Promise((resolve) => {
    const s = app.default.listen(0, "127.0.0.1", () => resolve(s));
  });
  server = { server: listening, url: `http://127.0.0.1:${(listening.address() as AddressInfo).port}`, app, env: JSON.stringify(env) };
  return server;
}

async function raw(base: string, cookie: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(method !== "GET" && method !== "HEAD" ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? (method !== "GET" && method !== "HEAD" ? "{}" : null) : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const set = response.headers.getSetCookie?.() ?? [];
  const access = set.map((c) => c.split(";")[0]!).find((c) => c.startsWith("accessToken="));
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, access: access && access !== "accessToken=" ? access : undefined };
}

/** Signs someone in by e-mail and password (choosing a new password if one is due) and returns their bearer token. */
export async function tokenFor(t: TestApi, email: string, password: string): Promise<string> {
  return (await signIn(t.api.url, email, password)).cookie.slice("accessToken=".length);
}

/** Signs in through the real login route; when a new password is due, chooses one. Returns the cookie and the staff id. */
async function signIn(base: string, email: string, password: string) {
  const login = await raw(base, null, "POST", "/api/user/admin/login", { email, password });
  if (login.status !== 200 || !login.access) throw new Error(`could not sign in as ${email}: ${JSON.stringify(login.body)}`);
  let cookie = login.access;
  if (login.body.data.mustChangePassword) {
    const changed = await raw(base, cookie, "POST", "/api/v1/auth/change-password", { currentPassword: password, newPassword: strongPassword() });
    if (changed.status !== 200 || !changed.access) throw new Error(`could not choose a new password for ${email}: ${JSON.stringify(changed.body)}`);
    cookie = changed.access;
  }
  return { cookie, staffId: login.body.data.staffId as string, email };
}

export const ADMIN_PASSWORD = "Admin-pass-2468x";

/** A throwaway hospital with an administrator who can sign in. */
async function createHospital(app: typeof import("../../src/app.js")) {
  const { prisma } = await import("../../src/config/db.js");
  const bcrypt = (await import("bcrypt")).default;
  const tag = randomBytes(4).toString("hex");
  const facility = await prisma.facility.create({
    data: { name: `Test Hospital ${tag}`, hfrId: `TEST${tag.toUpperCase()}`, email: `owner-${tag}@example.test`, passwordHash: await bcrypt.hash(strongPassword(), 4) },
  });
  const adminEmail = `admin-${tag}@example.test`;
  const user = await prisma.user.create({
    data: { name: "Test Admin", email: adminEmail, passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 4), facilityId: facility.id, role: "admin" },
  });
  await prisma.staff.create({ data: { facilityId: facility.id, userId: user.id, name: "Test Admin", role: "admin", department: "Administration" } });
  void app;
  return { facilityId: facility.id, adminEmail, tag };
}

/**
 * A signed-in administrator of a new throwaway hospital. (The first argument is the ABDM configuration in the OSHealth tests;
 * the merged application's ABDM module is configured per facility and not used by these tests, so it is ignored.)
 */
export async function startTestApi(_abdmConfig?: unknown, env: Record<string, string> = {}): Promise<TestApi> {
  const { url: base, app } = await startServer(env);
  const hospitals: string[] = [];

  async function hospitalClient(): Promise<TestApi> {
    const h = await createHospital(app);
    hospitals.push(h.facilityId);
    const admin = await signIn(base, h.adminEmail, ADMIN_PASSWORD);
    const signedIn = new Map<string, TestApi>();

    const clientFor = (session: { cookie: string; staffId: string; email: string }): TestApi => {
      const call: TestApi["call"] = async (method, path, body, headers) => {
        const reply = await raw(base, session.cookie, method, path, body, headers);
        if (reply.access) session.cookie = reply.access; // a password change hands out a new session
        return { status: reply.status, body: reply.body };
      };
      const client: TestApi = {
        url: base,
        facilityId: h.facilityId,
        staffId: session.staffId,
        email: session.email,
        call,
        get: (path) => call("GET", path),
        post: (path, body) => call("POST", path, body ?? {}),
        as: (role) => as(role),
        sql: (text, params = []) => app.hospital.ctx.db.inFacility(h.facilityId, () => app.hospital.ctx.db.query(text, params)) as Promise<any[]>,
        otherHospital: () => hospitalClient(),
        api: { url: base, ctx: app.hospital.ctx },
        get token() {
          return session.cookie.slice("accessToken=".length);
        },
        inHospital: (work) => app.hospital.ctx.db.inFacility(h.facilityId, work),
        close,
      };
      return client;
    };

    const adminClient = clientFor(admin);
    async function as(role: string): Promise<TestApi> {
      if (role === "admin") return adminClient;
      const existing = signedIn.get(role);
      if (existing) return existing;
      const staff = (await adminClient.post("/api/v1/staff", { name: `Test ${role.replace("_", " ")}`, role, department: "Testing" })).body;
      const email = `${role.replace("_", "-")}-${h.tag}@example.test`;
      const password = strongPassword();
      const response = await adminClient.call("PUT", `/api/v1/staff/${staff.id}/login`, { email, password });
      if (response.status !== 200) throw new Error(`could not create a ${role} login: ${JSON.stringify(response.body)}`);
      const client = clientFor(await signIn(base, email, password));
      signedIn.set(role, client);
      return client;
    }
    return adminClient;
  }

  async function close() {
    const { removeQaHospital } = await import("../helpers.js");
    for (const id of hospitals.splice(0)) await removeQaHospital(id);
  }

  return hospitalClient();
}

/** Stops the server and the database connections (call once, at the end of the test file). */
export async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve) => {
    s.server.close(() => resolve());
    s.server.closeAllConnections();
  });
  await s.app.hospital.close();
  const { prisma } = await import("../../src/config/db.js");
  await prisma.$disconnect();
}

/** Creates a doctor and a few beds, returning their ids (most clinical tests need them). */
export async function seedBasics(t: TestApi) {
  const doctor = (await t.post("/api/v1/staff", { name: "Dr. Test", role: "doctor", department: "General Medicine", hprId: "HPR-1001" })).body;
  const bedA = (await t.post("/api/v1/beds", { ward: "Ward A", bedNo: "A-01" })).body;
  const bedB = (await t.post("/api/v1/beds", { ward: "Ward A", bedNo: "A-02" })).body;
  return { doctorId: doctor.id as string, bedA: bedA.id as string, bedB: bedB.id as string };
}

export async function newPatient(t: TestApi, overrides: Record<string, unknown> = {}) {
  const response = await t.post("/api/v1/patients", { name: "Ramesh Gupta", age: 54, gender: "M", phone: "9876500001", ...overrides });
  if (response.status !== 201) throw new Error(`could not register a patient: ${JSON.stringify(response.body)}`);
  return response.body as { id: string; mrn: string; name: string; age: number; abhaStatus: string };
}

/**
 * An OPD visit the way it now reaches the queue: registered, then its consultation fee collected at OPD billing (which issues the
 * token). Returns what POST /encounters/opd returned, but with the visit as it is after payment ('waiting', with a token).
 */
export async function checkInOpdPaid(t: TestApi, input: Record<string, unknown>, paymentMode = "cash") {
  const created = await t.post("/api/v1/encounters/opd", input);
  if (created.status !== 201) return created;
  const awaiting = (await t.get("/api/v1/opd-billing")).body as { billId: string; encounterId: string }[];
  const fee = awaiting.find((a) => a.encounterId === created.body.id);
  if (!fee) throw new Error("the new OPD visit is not waiting at OPD billing");
  const paid = await t.post(`/api/v1/opd-billing/${fee.billId}/collect`, { paymentMode });
  if (paid.status !== 200) throw new Error(`could not collect the fee: ${JSON.stringify(paid.body)}`);
  return { status: created.status, body: paid.body.encounter };
}
