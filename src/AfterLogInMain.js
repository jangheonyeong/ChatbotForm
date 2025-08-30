// [AfterLogInMain.js]

// Firebase SDK (ESM)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  getIdTokenResult,
  signOut,
  getRedirectResult,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

/* ======================
   Firebase 초기화
====================== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ======================
   유틸
====================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isApprovedTeacher() {
  const user = auth.currentUser;
  if (!user) return false;

  // 1) 새 토큰 강제 발급 → 커스텀클레임 즉시 반영
  const idt = await getIdTokenResult(user, true);
  const byClaim = idt.claims?.teacher === true || idt.claims?.admin === true;
  if (byClaim) return true;

  // 2) 폴백: 본인 teachers 문서(active:true) 확인
  try {
    const tdoc = await getDoc(doc(db, "teachers", user.uid));
    return tdoc.exists() && tdoc.data()?.active === true;
  } catch {
    return false;
  }
}

/* ======================
   메인 흐름
   - 초기 Auth 복원 완료까지 대기(auth.authStateReady)
   - redirect 로그인 결과 회수(getRedirectResult)
   - 승인 확인(최대 3회 재시도로 함수/동기화 지연 흡수)
====================== */
(async function main() {
  try {
    // 0) 초기 인증 상태가 준비될 때까지 대기 (중요!)
    await auth.authStateReady();

    // 1) 리다이렉트 로그인 폴백을 사용한 적이 있다면 결과 회수
    try { await getRedirectResult(auth); } catch {}

    // 2) 미로그인 → 로그인 페이지로
    if (!auth.currentUser) {
      alert("로그인이 필요합니다.");
      window.location.href = "LogIn.html";
      return;
    }

    // 3) 승인 체크 (함수/클레임 전파 지연을 고려해 소규모 재시도)
    let ok = false;
    for (let i = 0; i < 3; i++) {
      ok = await isApprovedTeacher();
      if (ok) break;
      // onCreate/동기화 함수가 막 썼을 가능성 → 짧게 대기 후 재시도
      await sleep(600);
    }

    if (!ok) {
      alert("승인된 교사 계정이 아닙니다.");
      try { await signOut(auth); } catch {}
      window.location.href = "LogIn.html";
      return;
    }

    // 4) 승인 통과 시에만 버튼 이벤트 바인딩
    const createBtn = document.getElementById("createChatbotBtn");
    const listBtn = document.getElementById("viewListBtn");

    if (createBtn) {
      createBtn.addEventListener("click", () => {
        window.location.href = "CreateChatbot.html";
      });
    }
    if (listBtn) {
      listBtn.addEventListener("click", () => {
        window.location.href = "ChatbotList.html";
      });
    }
  } catch (e) {
    console.error("[AfterLogIn] fatal:", e);
    alert("접속 중 오류가 발생했습니다. 다시 시도해주세요.");
    try { await signOut(auth); } catch {}
    window.location.href = "LogIn.html";
  }
})();
