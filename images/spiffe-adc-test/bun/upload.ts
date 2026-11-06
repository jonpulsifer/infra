// Writes one object with @google-cloud/storage and Application Default
// Credentials, on Bun as the lab's apps run. Nothing here names a credential:
// the library reads GOOGLE_APPLICATION_CREDENTIALS and runs the executable the
// document names for its subject token.
import { Storage } from "@google-cloud/storage";

const bucket = process.env.BUCKET!;
const node = process.env.NODE_NAME!;
const storage = new Storage({ projectId: process.env.GCP_PROJECT });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const name = `uploads/${stamp}-${node}-bun.txt`;
// One request: the grant allows object create and nothing else.
await storage.bucket(bucket).file(name).save(
  `Uploaded by Bun @google-cloud/storage from ${node} through spiffe-adc with no key file and no sidecar.\n`,
  { resumable: false, contentType: "text/plain" },
);
console.log(`Uploaded gs://${bucket}/${name}`);
