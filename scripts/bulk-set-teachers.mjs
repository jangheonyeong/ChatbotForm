// scripts/bulk-set-teachers.mjs
// 사용법:
//   npm run bulk:teachers -- ./teachers.csv
//   # 각 줄: "email" 또는 "email,role" (role: teacher | admin)
// 옵션:
//   CREATE_MISSING=true -> Auth에 없는 이메일도 계정 생성 후 권한 부여
// 필요:
//   - Node 18+
//   - 환경변수 GOOGLE_APPLICATION_CREDENTIALS=/절대경로/serviceAccount.json

import admin from "firebase-admin";
import fs from "node:fs";                 // sync 용 (projectId 감지)
import fsp from "node:fs/promises";       // 파일 읽기용
import path from "node:path";

/* ---------- 프로젝트 ID 자동 감지 ---------- */
function getProjectIdFromFirebaseConfigEnv() {
  try {
    const cfg = process.env.FIREBASE_CONFIG;
    if (!cfg) return undefined;
    const obj = JSON.parse(cfg);
    return obj.projectId || obj.project_id;
  } catch {
    return undefined;
  }
}

function resolveProjectId() {
  // 1) 일반적인 환경변수
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;

  // 2) FIREBASE_CONFIG(JSON 문자열)에 있는 경우
  const fromFirebaseConfig = getProjectIdFromFirebaseConfigEnv();
  if (fromFirebaseConfig) return fromFirebaseConfig;

  // 3) 서비스 키 JSON에서 추출
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(credPath, "utf8"));
      return json.project_id || json.projectId;
    } catch {}
  }
  return undefined;
}

const projectId = resolveProjectId();

// Admin SDK 초기화 (projectId 명시 주입)
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId
});

if (!projectId) {
  console.warn("⚠️ 프로젝트 ID를 자동으로 찾지 못했습니다. " +
               "필요시 GCLOUD_PROJECT 또는 GOOGLE_CLOUD_PROJECT 환경변수를 설정하세요.");
} else {
  console.log(`▶ Using projectId: ${projectId}`);
}

const db = admin.firestore();

/* ---------- 실행 파라미터/옵션 ---------- */
const fileArg = process.argv[2];
if (!fileArg) {
  console.error("파일 경로가 필요합니다. 예) npm run bulk:teachers -- ./teachers.csv");
  process.exit(1);
}
const CREATE_MISSING = String(process.env.CREATE_MISSING || "").toLowerCase() === "true";

const toLower = (s) => (s || "").trim().toLowerCase();

/* ---------- CSV 파싱 ---------- */
function parseLine(line) {
  const raw = line.trim();
  if (!raw) return null;
  const parts = raw.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
  const email = toLower(parts[0] || "");
  const role = (parts[1] || "teacher").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const normalizedRole = role === "admin" ? "admin" : "teacher";
  return { email, role: normalizedRole };
}

/* ---------- 사용자 조회/생성 ---------- */
async function ensureUser(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.errorInfo?.code === "auth/user-not-found" && CREATE_MISSING) {
      return await admin.auth().createUser({ email });
    }
    throw e;
  }
}

/* ---------- 권한 부여 & teachers 문서 upsert ---------- */
async function upsert(email, role) {
  const user = await ensureUser(email);

  // admin이면 teacher도 자동 포함
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

/* ---------- 메인 ---------- */
async function main() {
  const abs = path.resolve(process.cwd(), fileArg);
  const text = await fsp.readFile(abs, "utf8");
  const lines = text.split(/\r?\n/);

  const parsed = lines.map(parseLine).filter(Boolean);
  const dedup = Array.from(new Map(parsed.map((r) => [r.email, r])).values());

  console.log(`처리 대상: ${dedup.length}건${CREATE_MISSING ? " (미존재 계정 자동 생성)" : ""}\n`);

  let ok = 0, skip = 0;
  for (const { email, role } of dedup) {
    try {
      const res = await upsert(email, role);
      console.log(`[OK] ${res.role.toUpperCase()} ← ${res.email} (uid=${res.uid})`);
      ok++;
    } catch (e) {
      console.warn(`[SKIP] ${email}: ${e.message}`);
      skip++;
    }
  }

  console.log(`\n완료: OK=${ok}, SKIP=${skip}`);
  console.log("ℹ️ 커스텀 클레임은 재로그인 후 반영됩니다. teachers 문서는 즉시 반영됩니다.");
}

main().catch((e) => { console.error(e); process.exit(1); });
