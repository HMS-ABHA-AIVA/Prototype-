import { createServer } from "http";
import { generateKeyPairSync, randomUUID } from "crypto";
import jwt from "jsonwebtoken";

// LOCAL TESTING ONLY. A fake ABDM gateway plus a fake "patient's app", so Scan & Share can be exercised end to end
// without ABDM, a phone or a tunnel:
//
//   1. Start this:   npx tsx scripts/local_gateway.ts <facility HFR id>
//   2. Start the backend pointed at it (same terminal session as the next two lines):
//        $env:SANDBOX_SESSION_URL = 'http://localhost:5999/sessions'
//        $env:SANDBOX_GATEWAY_URL = 'http://localhost:5999'
//        npm run dev
//      (the facility needs SANDBOX credentials saved; any values work, they are only sent to this fake gateway)
//   3. Open the staff app > Shared profiles, then "scan" by opening in a browser:
//        http://localhost:5999/simulate?name=Asha+Rao&counter=OPD1
//      Optional query parameters: gender (M/F/O), dob (YYYY-MM-DD), phone, abhaNumber, abhaAddress.
//   4. http://localhost:5999/replies shows the token replies the backend sent to the gateway.
//
// While the backend points here, real ABHA calls do not work: restart it normally when finished.
const hfrId = process.argv[2];
if (!hfrId) {
  console.error("Usage: npx tsx scripts/local_gateway.ts <facility HFR id>");
  process.exit(1);
}

const PORT = 5999;
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:5000";

// The key pair ABDM would sign callbacks with; the backend fetches the public half from /gateway/v3/certs.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-test-key", alg: "RS256", use: "sig" };

const replies: unknown[] = [];

const send = (res: import("http").ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
};

const simulateShare = async (q: URLSearchParams) => {
  const name = q.get("name") ?? "Test Patient";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
  const dob = (q.get("dob") ?? "1990-05-17").split("-");
  const requestId = randomUUID();
  const body = {
    intent: "PROFILE_SHARE",
    metaData: { hipId: hfrId, context: q.get("counter") ?? "OPD1", hprId: null, latitude: "12.97", longitude: "77.71" },
    profile: {
      patient: {
        abhaNumber: q.get("abhaNumber") ?? null,
        abhaAddress: q.get("abhaAddress") ?? `${slug}@sbx`,
        name,
        gender: q.get("gender") ?? "M",
        dayOfBirth: String(Number(dob[2] ?? 1)),
        monthOfBirth: String(Number(dob[1] ?? 1)),
        yearOfBirth: dob[0] ?? "1990",
        address: { line: "12 Test Street", district: "Bengaluru", state: "Karnataka", pincode: "560001" },
        phoneNumber: q.get("phone") ?? "9000000000",
      },
    },
  };
  const token = jwt.sign({ iss: "local-test-gateway" }, privateKey, { algorithm: "RS256", keyid: "local-test-key", expiresIn: 300 });
  const res = await fetch(`${BACKEND}/api/v3/hip/patient/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-HIP-ID": hfrId, "REQUEST-ID": requestId, TIMESTAMP: new Date().toISOString() },
    body: JSON.stringify(body),
  });
  return { requestId, backendAnswered: res.status, body: await res.json().catch(() => null) };
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", async () => {
    try {
      if (url.pathname.endsWith("/sessions")) return send(res, 200, { accessToken: "local-test-token", expiresIn: 1200, refreshToken: "r", refreshExpiresIn: 1800, tokenType: "bearer" });
      if (url.pathname.endsWith("/gateway/v3/certs")) return send(res, 200, { keys: [jwk] });
      if (url.pathname.endsWith("/patient-share/v3/on-share")) {
        const reply = JSON.parse(data || "{}");
        replies.push({ at: new Date().toISOString(), hipId: req.headers["x-hip-id"], ...reply });
        console.log("on-share reply received:", JSON.stringify(reply));
        return send(res, 202, {});
      }
      if (url.pathname === "/simulate") return send(res, 200, await simulateShare(url.searchParams));
      if (url.pathname === "/replies") return send(res, 200, replies);
      send(res, 404, { message: "Fake ABDM gateway: try /simulate?name=Asha+Rao&counter=OPD1 or /replies" });
    } catch (error) {
      send(res, 500, { message: error instanceof Error ? error.message : String(error) });
    }
  });
}).listen(PORT, () => console.log(`Fake ABDM gateway on http://localhost:${PORT}  (facility ${hfrId}, backend ${BACKEND})`));
