// 명령어 예시:
//   node tools/provision-students.mjs --class math1 --count 30
//   node tools/provision-students.mjs --class korean1 --count 1 --start 1 --force-needs-nick
//
// 규칙: 이메일  <classId>-<studentId>@<domain>
//       비밀번호 기본 = <classId>-<studentId> (옵션으로 오버라이드 가능)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ===== 옵션 파싱 ===== */
const argv = process.argv.slice(2);
const opt = {
  classId: null,
  count: null,
  start: 1,
  pad: 2,
  domain: 'class.local',
  password: null,
  csv: null,
  resetExist: false,
  forceNeedsNick: false,             // ★ 추가: 기존 계정 포함 닉네임 재설정 요구
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--class') opt.classId = argv[++i];
  else if (a === '--count') opt.count = parseInt(argv[++i] || '0', 10);
  else if (a === '--start') opt.start = parseInt(argv[++i] || '1', 10);
  else if (a === '--pad') opt.pad = parseInt(argv[++i] || '2', 10);
  else if (a === '--domain') opt.domain = argv[++i];
  else if (a === '--password') opt.password = argv[++i];
  else if (a === '--from-csv') opt.csv = argv[++i];
  else if (a === '--reset-exist') opt.resetExist = true;
  else if (a === '--force-needs-nick') opt.forceNeedsNick = true;   // ★ 추가
}
if (!opt.classId) { console.error('[ERROR] --class <학급코드>는 필수입니다.'); process.exit(1); }
if (!opt.count && !opt.csv) { console.error('[ERROR] --count 또는 --from-csv 중 하나는 필수입니다.'); process.exit(1); }

/* ===== Admin 초기화 (keys/firebase-admin.json 탐색) ===== */
const candidates = [
  path.resolve(__dirname, '../..', 'keys/firebase-admin.json'),
  path.resolve(__dirname, '../',  'keys/firebase-admin.json'),
  path.resolve(process.cwd(), 'keys/firebase-admin.json'),
];
let keyPath = null;
for (const p of candidates) { if (fs.existsSync(p)) { keyPath = p; break; } }
if (!keyPath) { console.error('[ERROR] 서비스 계정 키를 찾을 수 없습니다.\n' + candidates.join('\n')); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const auth = getAuth();
const db   = getFirestore();

/* ===== 대상 목록 만들기 ===== */
function zeroPad(n, w) { return String(n).padStart(w, '0'); }
let targets = [];
if (opt.csv) {
  const raw = fs.readFileSync(path.resolve(opt.csv), 'utf8').trim();
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim());
    if (i === 0 && (parts[0] || '').toLowerCase().includes('student')) continue;
    const [studentId, displayName = '학생'] = parts;
    targets.push({ studentId, displayName });
  }
} else {
  for (let i = 0; i < opt.count; i++) {
    const no = opt.start + i;
    targets.push({ studentId: zeroPad(no, opt.pad), displayName: `학생${zeroPad(no, opt.pad)}` });
  }
}

/* ===== 출력 CSV ===== */
const outDir = path.resolve(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
const outCsv = path.join(outDir, `provisioned_${opt.classId}_${stamp}.csv`);
fs.writeFileSync(outCsv, 'email,password,uid,displayName\n');

/* ===== 생성 루프 ===== */
console.log(`[bulk] class=${opt.classId}, size=${targets.length}, domain=${opt.domain}`);
for (const t of targets) {
  const localPart = `${opt.classId}-${t.studentId}`;     // ex) math1-01
  const email     = `${localPart}@${opt.domain}`;        // ex) math1-01@class.local
  let password    = (opt.password != null) ? opt.password : localPart;

  let user = null;
  try {
    user = await auth.createUser({
      email, password, displayName: t.displayName, emailVerified: false, disabled: false,
    });
    await auth.setCustomUserClaims(user.uid, { role: 'student', classId: opt.classId });

    // ★ 닉네임은 비워두고, 최초 로그인에서 설정하도록 플래그 저장
    await db.doc(`student_profiles/${user.uid}`).set({
      nickname: '',                         // ← 빈 값
      nicknameNeedsSetup: true,             // ← 최초 로그인 시 모달
      provisionedDisplayName: t.displayName,// 교사용 명부용(선택)
      classId: opt.classId,
      studentId: t.studentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, { merge: true });

    console.log(`[new] ${email} -> ${user.uid}`);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      user = await auth.getUserByEmail(email);
      if (opt.resetExist) {
        await auth.updateUser(user.uid, { password });
        console.log(`[exist/reset] ${email} -> ${user.uid}`);
      } else {
        password = '';
        console.log(`[exist] ${email} -> ${user.uid} (password unchanged)`);
      }

      // 커스텀 클레임 보정
      const claims = user.customClaims || {};
      if (claims.role !== 'student' || claims.classId !== opt.classId) {
        await auth.setCustomUserClaims(user.uid, { ...claims, role: 'student', classId: opt.classId });
      }

      // ★ 기존 프로필을 읽어 닉 없음이면 플래그 세팅, 옵션으로 강제 가능
      const ref  = db.doc(`student_profiles/${user.uid}`);
      const snap = await ref.get();
      const hasNick = snap.exists && !!(snap.data().nickname || '').trim();

      await ref.set({
        classId: opt.classId,
        studentId: t.studentId,
        updatedAt: Date.now(),
        ...(opt.forceNeedsNick ? { nicknameNeedsSetup: true } : {}),
        ...(!hasNick ? { nickname: '', nicknameNeedsSetup: true } : {}),
        ...(snap.exists ? {} : { provisionedDisplayName: t.displayName }),
      }, { merge: true });
    } else {
      console.error(`[error] ${email}:`, e);
      continue;
    }
  }

  fs.appendFileSync(outCsv, `${email},${password},${user.uid},${JSON.stringify(t.displayName)}\n`);
}
console.log('[bulk] done →', outCsv);
