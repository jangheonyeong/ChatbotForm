// functions/tools/bulk-set-teachers.mjs
// Usage:
//   node tools/bulk-set-teachers.mjs preapproved.csv preapprove
//   node tools/bulk-set-teachers.mjs preapproved.csv apply-now
//
// 설명
// - preapprove : preapproved_teachers/{email} 문서 upsert 만 수행
// - apply-now  : 위 + 이미 가입된 계정에는 즉시 customClaims/teachers 컬렉션 반영
//
// 특징
// - 서비스계정 JSON을 코드에서 직접 읽어 cert(...)로 초기화 → 환경변수 필요 없음
// - keys/firebase-admin.json 경로가 없으면 친절한 오류 메시지

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/* ===== 실행 인자 ===== */
const [, , csvPath = 'preapproved.csv', mode = 'preapprove'] = process.argv;
// mode: 'preapprove' | 'apply-now'

/* ===== 서비스계정 JSON 경로 해석 =====
   현재 파일(=tools/bulk-set-teachers.mjs) 기준으로 ../keys/firebase-admin.json */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceKeyPath = path.resolve(__dirname, '../keys/firebase-admin.json');

/* ===== 서비스계정 로드 & Firebase Admin 초기화 ===== */
let serviceAccount;
try {
  const raw = readFileSync(serviceKeyPath, 'utf8');
  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error(
    '[init] 서비스계정 키 파일을 읽을 수 없습니다.\n' +
      `- 기대 경로: ${serviceKeyPath}\n` +
      '- 해결: functions/keys/firebase-admin.json 을 해당 경로에 두세요.\n' +
      '  (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성)'
  );
  process.exit(1);
}

if (!serviceAccount.project_id) {
  console.error('[init] 서비스계정 JSON에 project_id가 없습니다. 올바른 키인지 확인하세요.');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    // projectId를 명시적으로 지정하여 ADC/환경변수 의존 제거
    projectId: serviceAccount.project_id,
    // 필요시 아래 옵션들도 명시 가능
    // storageBucket: `${serviceAccount.project_id}.appspot.com`,
    // databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
  });
}

const db = getFirestore();
const auth = getAuth();

/* ===== CSV 파서 =====
   header: email,role,approvedBy
   role 기본값: teacher
   - 첫 줄(헤더)은 자동으로 무시
   - BOM 제거 및 공백/빈줄 제거
*/
function parseCSV(text) {
  // UTF-8 BOM 제거
  const cleaned = text.replace(/^\uFEFF/, '').trim();

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // 첫 줄이 헤더면 건너뛰기 (느슨한 매칭: email, role, approvedBy 포함 여부 확인)
  const first = lines[0].toLowerCase().replace(/\s+/g, '');
  const hasHeader =
    first.includes('email') &&
    first.includes('role') &&
    first.includes('approvedby');

  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => {
      const [emailRaw, roleRaw, byRaw] = line.split(',').map((s) => (s || '').trim());
      return {
        email: (emailRaw || '').toLowerCase(),
        role: (roleRaw || 'teacher').toLowerCase(),
        approvedBy: byRaw || null,
      };
    })
    .filter((r) => r.email);
}

/* ===== 메인 실행 ===== */
(async () => {
  // CSV 로드
  let csvText;
  try {
    csvText = readFileSync(path.resolve(process.cwd(), csvPath), 'utf8');
  } catch (e) {
    console.error(
      `[bulk] CSV 파일을 읽지 못했습니다: ${csvPath}\n- 현재 작업 디렉토리: ${process.cwd()}`
    );
    process.exit(1);
  }

  const rows = parseCSV(csvText);
  console.log(`[bulk] rows: ${rows.length}, mode: ${mode}`);

  for (const { email, role, approvedBy } of rows) {
    // 1) 사전 승인 문서 upsert
    await db.doc(`preapproved_teachers/${email}`).set(
      {
        role: role === 'admin' ? 'admin' : 'teacher',
        approvedBy: approvedBy || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`[bulk] preapproved: ${email} -> ${role}`);

    if (mode === 'apply-now') {
      try {
        const user = await auth.getUserByEmail(email);

        // 기존 커스텀클레임 유지 + 필요한 권한만 추가 병합
        const baseClaims = user.customClaims || {};
        const newClaims =
          role === 'admin' ? { admin: true, teacher: true } : { teacher: true };
        await auth.setCustomUserClaims(user.uid, { ...baseClaims, ...newClaims });

        await db.doc(`teachers/${user.uid}`).set(
          {
            email,
            role: role === 'admin' ? 'admin' : 'teacher',
            active: true,
            approvedBy: approvedBy || null,
            approvedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        console.log(`[bulk] applied: ${email}`);
      } catch (e) {
        if (e?.code === 'auth/user-not-found') {
          console.log(
            `[bulk] ${email}: 아직 가입하지 않음 (가입 시 onCreate 트리거/관리 플로우에서 자동 반영)`
          );
        } else {
          console.error(`[bulk] ${email}: error`, e);
        }
      }
    }
  }

  console.log('[bulk] done');
  process.exit(0);
})().catch((e) => {
  console.error('[bulk] fatal error', e);
  process.exit(1);
});
