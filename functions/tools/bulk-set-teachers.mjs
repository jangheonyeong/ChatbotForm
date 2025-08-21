// scripts/bulk-set-teachers.mjs
// Use: npm run bulk:teachers -- ./teachers.csv
// Each line: "email" or "email,role" (role: teacher | admin)
// Option: CREATE_MISSING=true  -> create Auth user if not exists
// Requires: Node 18+, a service account key JSON

import admin from "firebase-admin";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ---------- locate service account & projectId ---------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const credPath = firstExisting([
  process.env.GOOGLE_APPLICATION_CREDENTIALS,                  // env first
  path.resolve(process.cwd(), "keys/firebase-admin.json"),     // /keys under repo root
  path.resolve(__dirname, "../keys/firebase-admin.json"),      // ../keys next to scripts
  path.resolve(process.cwd(), "firebase-admin.json")           // root fallback
]);

if (!credPath) {
  console.error(
    "Service account key not found.\n" +
    "- Set GOOGLE_APPLICATION_CREDENTIALS to an absolute path, or\n" +
    "- Place the file at keys/firebase-admin.json"
  );
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
} catch (e) {
  console.error("Cannot read service account JSON:", e.message);
  process.exit(1);
}

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  serviceAccount.project_id ||
  serviceAccount.projectId;

console.log("Using service key:", credPath);
if (projectId) console.log("Using projectId:", projectId);
else console.log("Warning: projectId could not be detected; continuing with defaults.");

// Initialize Admin SDK explicitly with the key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId
});

const db = admin.firestore();

/* ---------- argv & options ---------- */
const fileArg = process.argv[2];
if (!fileArg) {
  console.error("CSV path required. Example: npm run bulk:teachers -- ./teachers.csv");
  process.exit(1);
}
const CREATE_MISSING = String(process.env.CREATE_MISSING || "").toLowerCase() === "true";

/* ---------- parse helpers ---------- */
const lower = (s) => (s || "").trim().toLowerCase();

function parseLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const parts = raw.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
  const email = lower(parts[0] || "");
  const roleIn = lower(parts[1] || "teacher");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const role = roleIn === "admin" ? "admin" : "teacher";
  return { email, role };
}

/* ---------- user ensure / upsert ---------- */
async function ensureUser(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e?.errorInfo?.code === "auth/user-not-found" && CREATE_MISSING) {
      return await admin.auth().createUser({ email });
    }
    throw e;
  }
}

async function upsert(email, role) {
  const user = await ensureUser(email);

  // admin implies teacher
  const base = user.customClaims || {};
  const claims = role === "admin" ? { admin: true, teacher: true } : { teacher: true };
  await admin.auth().setCustomUserClaims(user.uid, { ...base, ...claims });

  await db.doc(`teachers/${user.uid}`).set(
    {
      email,
      role,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return { uid: user.uid, email, role };
}

/* ---------- main ---------- */
async function main() {
  const abs = path.resolve(process.cwd(), fileArg);
  const text = await fsp.readFile(abs, "utf8");
  const lines = text.split(/\r?\n/);

  const parsed = lines.map(parseLine).filter(Boolean);
  const dedup = Array.from(new Map(parsed.map((r) => [r.email, r])).values());

  console.log(`Targets: ${dedup.length}${CREATE_MISSING ? " (will create missing Auth users)" : ""}`);

  let ok = 0, skip = 0;
  for (const { email, role } of dedup) {
    try {
      const res = await upsert(email, role);
      console.log(`[OK] ${res.role.toUpperCase()} <- ${res.email} (uid=${res.uid})`);
      ok++;
    } catch (e) {
      console.warn(`[SKIP] ${email}: ${e.message}`);
      skip++;
    }
  }

  console.log(`Done: OK=${ok}, SKIP=${skip}`);
  console.log("Note: Custom claims take effect after the user re-logs in. The teachers document is effective immediately.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
