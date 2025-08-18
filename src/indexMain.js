import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 항상 계정 선택 창을 띄우도록 설정
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

// 교사용 이메일 화이트리스트(예시)
const adminEmails = ["wkdgjsdud@snu.ac.kr"];

// 버튼
const studentBtn = document.getElementById("studentStartBtn");
const teacherBtn = document.getElementById("googleLoginBtn");

// Safari/iOS에선 팝업 대신 리다이렉트 사용
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const useRedirect = isSafari || isIOS;

// 리다이렉트 흐름 구분용 키
const FLOW_KEY = "login_flow"; // 'student' | 'teacher'

// 공통 에러 토스트
function showLoginError(err) {
  console.error("로그인 실패:", err);
  alert("로그인에 실패했습니다: " + (err?.message || err));
}

// ── 학생: 항상 계정 선택 → 로그인 성공 시 StudentLogin.html로 이동
async function startAsStudent() {
  try {
    if (useRedirect) {
      sessionStorage.setItem(FLOW_KEY, "student");
      await signInWithRedirect(auth, provider);
      return; // 리다이렉트로 나감
    } else {
      await signInWithPopup(auth, provider); // 이미 로그인돼 있어도 계정 선택창 노출
      window.location.href = "StudentLogin.html";
    }
  } catch (err) {
    showLoginError(err);
  }
}

// ── 교사: 항상 계정 선택 → 권한에 따라 분기
async function startAsTeacher() {
  try {
    if (useRedirect) {
      sessionStorage.setItem(FLOW_KEY, "teacher");
      await signInWithRedirect(auth, provider);
      return;
    } else {
      const res = await signInWithPopup(auth, provider);
      const email = res.user?.email || "";
      if (adminEmails.includes(email)) {
        window.location.href = "Admin.html";
      } else {
        window.location.href = "AfterLogIn.html";
      }
    }
  } catch (err) {
    showLoginError(err);
  }
}

// ── 리다이렉트 복귀 처리 (Safari/iOS 등)
getRedirectResult(auth)
  .then((res) => {
    if (!res?.user) return; // 리다이렉트가 아니면 무시
    const flow = sessionStorage.getItem(FLOW_KEY);
    sessionStorage.removeItem(FLOW_KEY);

    if (flow === "student") {
      window.location.href = "StudentLogin.html";
    } else if (flow === "teacher") {
      const email = res.user?.email || "";
      if (adminEmails.includes(email)) {
        window.location.href = "Admin.html";
      } else {
        window.location.href = "AfterLogIn.html";
      }
    }
  })
  .catch(showLoginError);

// ── 버튼 핸들러
studentBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  startAsStudent();
});
teacherBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  startAsTeacher();
});

// (선택) 이미 로그인된 상태면 버튼 텍스트만 친절히 변경
onAuthStateChanged(auth, (user) => {
  if (user) {
    if (studentBtn) studentBtn.textContent = "학생으로 계속";
    if (teacherBtn) teacherBtn.textContent = "교사로 계속";
  } else {
    if (studentBtn) studentBtn.textContent = "학생으로 시작";
    if (teacherBtn) teacherBtn.textContent = "Google로 로그인";
  }
});
