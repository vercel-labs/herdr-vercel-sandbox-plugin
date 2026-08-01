import { loadVerificationManifest, verifyRemoteSourceFreshness } from "../src/verification.mjs";

const result = await verifyRemoteSourceFreshness(loadVerificationManifest());
console.log(`Verified ${result.checkedSources} authoritative source document(s) against their recorded SHA-256.`);
