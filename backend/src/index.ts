// Load .env before any module (e.g. the encryption util) reads process.env at import time.
import "dotenv/config";
import app, { hospital } from "./app.js";
import { prisma } from "./config/db.js";
import { purgeExpiredShares } from "./integration/Abha/share/share.service.js";

const PORT = Number(process.env.PORT) || 5000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT} (0.0.0.0)`);
});

// First-run work of the hospital modules (the platform administrator named in the environment, if any).
hospital.start().catch((error: unknown) => console.error("Hospital module start-up failed", error instanceof Error ? error.message : error));

// Shared profiles are personal data: delete the unclaimed, expired ones even when no staff screen is open.
const purge = () => purgeExpiredShares().catch((error: unknown) => console.error("Purging expired shares failed", error instanceof Error ? error.message : error));
void purge();
setInterval(purge, 10 * 60 * 1000).unref();

// Hosting platforms stop the process with SIGTERM on deploys: finish requests, then close the database connections.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.allSettled([hospital.close(), prisma.$disconnect()]).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
