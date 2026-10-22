import "dotenv/config";
import { prisma } from "../src/config/db.js";
import { decrypt } from "../src/common/utils/encryption.js";
import { generateAbdmSessionToken } from "../src/common/client/facility.client.js";
import { getBridgeService, updateBridgeUrl } from "../src/common/client/gateway.client.js";

// Tells ABDM where to deliver callbacks (Scan & Share, later consent/data-flow) for a facility's client id:
//   npx tsx scripts/register_bridge.ts <facility HFR id> <SANDBOX|PRODUCTION> <public https URL of this backend>
// The URL is the backend's base (for example https://abc.trycloudflare.com): ABDM adds /api/v3/hip/patient/share itself.
//
// PATCH /gateway/v3/bridge/url replaces the URL for the WHOLE client id (last writer wins), and ABDM cannot read
// it back. Run this only for a client id that no other system is using, and again whenever the URL changes
// (for example a tunnel that restarted).
const [hfrId, environmentArg, url] = process.argv.slice(2);

async function main() {
  if (!hfrId || (environmentArg !== "SANDBOX" && environmentArg !== "PRODUCTION") || !url) {
    console.error("Usage: npx tsx scripts/register_bridge.ts <facility HFR id> <SANDBOX|PRODUCTION> <https://public-backend-url>");
    process.exit(1);
  }
  const environment = environmentArg;

  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    console.error("The bridge URL must be public HTTPS.");
    process.exit(1);
  }
  const bridgeUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  const facility = await prisma.facility.findUnique({ where: { hfrId }, include: { abdmData: { where: { environment } } } });
  const credentials = facility?.abdmData[0];
  if (!facility || !credentials) {
    console.error(`No facility with HFR id ${hfrId} and saved ${environment} ABDM credentials.`);
    process.exit(1);
  }

  const session = await generateAbdmSessionToken({ clientId: credentials.clientId, clientSecret: decrypt(credentials.clientSecret), environment });

  console.log(`Registering ${bridgeUrl} as the bridge URL for ${facility.name} (${environment})...`);
  const status = await updateBridgeUrl(session.accessToken, environment, bridgeUrl);
  console.log(`ABDM answered HTTP ${status}.`);

  try {
    const service = await getBridgeService(session.accessToken, environment, hfrId);
    console.log("Service registration for this HFR id:", JSON.stringify({ isHip: service.isHip, active: service.active }));
    if (service.isHip === false || service.active === false) {
      console.warn("The HFR id is not an active HIP on this bridge yet; ABDM will not route shares to it until it is registered.");
    }
  } catch (error) {
    console.warn("Could not read the service registration:", error instanceof Error ? error.message : error);
  }

  console.log("Next: scan a counter QR code and watch for PATIENT_SHARE_RECEIVED in the backend log.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
