import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";
import { isTeacher, isAdmin } from "./rolesMain.js";

/* ===== Firebase ===== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

/* ===== 상수 ===== */
const CLASS_EMAIL_DOMAIN = "class.local";         // 내부용 도메인
const LAST_STUDENT_ID_KEY = "last_student_id";    // 최근 아이디 저장

/* ===== Google Provider(교사용) ===== */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

/* ===== DOM ===== */
const studentBtn = document.getElementById("studentStartBtn");
const teacherBtn = document.getElementById("googleLoginBtn");

// 학생 모달
const idOverlay   = document.getElementById("studentIdOverlay");
const idInput     = document.getElementById("studentIdInput");
const pwInput     = document.getElementById("studentPwInput");
const idOkBtn     = document.getElementById("studentIdConfirmBtn");
const idCancelBtn = document.getElementById("studentIdCancelBtn");

/* ===== 유틸 ===== */
function openIdOverlay() {
  if (pwInput) pwInput.value = "";
  idOverlay.hidden = false;
  idOverlay.setAttribute("aria-hidden", "false");
  setTimeout(() => idInput?.focus(), 0);
}
function closeIdOverlay() {
  idOverlay.hidden = true;
  idOverlay.setAttribute("aria-hidden", "true");
}
function validStudentLocalId(s) {
  // 하이픈 포함 형식(예: math1-01)
  return /^[A-Za-z0-9-]{2,32}-[A-Za-z0-9-]{1,16}$/.test((s || "").trim());
}
function showLoginError(err) {
  console.error("로그인 실패:", err);
  alert("로그인에 실패했습니다: " + (err?.message || err));
}

/* ───────── 학생: 모달 → 이메일/비번 로그인 → StudentLogin.html ───────── */
function startAsStudent() { openIdOverlay(); }

async function confirmStudentLogin() {
  const localId = (idInput?.value || "").trim();
  const pwd     = (pwInput?.value || "").trim();

  if (!validStudentLocalId(localId)) {
    alert("아이디 형식을 확인하세요. 예: math1-01");
    idInput?.focus(); return;
  }
  if (!pwd) {
    alert("비밀번호를 입력하세요.");
    pwInput?.focus(); return;
  }

  const email = `${localId}@${CLASS_EMAIL_DOMAIN}`;

  try {
    await signInWithEmailAndPassword(auth, email, pwd);
    localStorage.setItem(LAST_STUDENT_ID_KEY, localId);
    closeIdOverlay();
    // 로그인 성공 → 교사 코드 입력/닉네임 화면으로 이동
    location.href = "StudentLogin.html";
  } catch (err) {
    showLoginError(err);
  }
}

/* ───────── 교사: Google 로그인 + 권한 확인 ───────── */
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const useRedirect = isSafari || isIOS;
const FLOW_KEY = "login_flow"; // 'teacher'만 사용

async function startAsTeacher() {
  try {
    if (useRedirect) {
      sessionStorage.setItem(FLOW_KEY, "teacher");
      await signInWithRedirect(auth, provider);
      return;
    } else {
      const res = await signInWithPopup(auth, provider);
      const email = res.user?.email || "";
      if (!(isTeacher(email) || isAdmin(email))) {
        alert("승인된 교사 계정이 아닙니다.");
        await auth.signOut();
        return;
      }
      location.href = isAdmin(email) ? "Admin.html" : "AfterLogIn.html";
    }
  } catch (err) {
    showLoginError(err);
  }
}

/* ───────── 교사용 리다이렉트 복귀 ───────── */
getRedirectResult(auth)
  .then((res) => {
    if (!res?.user) return;
    const flow = sessionStorage.getItem(FLOW_KEY);
    sessionStorage.removeItem(FLOW_KEY);
    if (flow === "teacher") {
      const email = res.user?.email || "";
      if (!(isTeacher(email) || isAdmin(email))) {
        alert("승인된 교사 계정이 아닙니다.");
        auth.signOut();
        location.href = "index.html";
        return;
      }
      location.href = isAdmin(email) ? "Admin.html" : "AfterLogIn.html";
    }
  })
  .catch(showLoginError);

/* ───────── 이벤트 바인딩 ───────── */
studentBtn?.addEventListener("click", (e) => { e.preventDefault(); startAsStudent(); });
teacherBtn?.addEventListener("click", (e) => { e.preventDefault(); startAsTeacher(); });

idOkBtn?.addEventListener("click", () => { confirmStudentLogin(); });
idCancelBtn?.addEventListener("click", () => { closeIdOverlay(); });

[idInput, pwInput].forEach(el => {
  el?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmStudentLogin(); }
    else if (e.key === "Escape") { e.preventDefault(); closeIdOverlay(); }
  });
});

/* ───────── UX: 버튼 텍스트(선택) ───────── */
onAuthStateChanged(auth, (user) => {
  if (teacherBtn) teacherBtn.textContent = user ? "교사로 계속" : "Google로 로그인";
  // 학생 버튼 문구는 고정
});
