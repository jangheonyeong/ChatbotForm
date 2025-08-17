import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// 교사용 이메일 화이트리스트(임시)
const adminEmails = ["wkdgjsdud@snu.ac.kr"];

/* ---------- 학생: 닉네임만으로 시작 ---------- */
const studentBtn = document.getElementById("studentStartBtn");
studentBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  const nick = (document.getElementById("nickname")?.value || "").trim();
  if (!nick) {
    alert("닉네임을 입력해주세요.");
    return;
  }

  // 익명 식별자/닉네임 저장
  const keyId = "guestId";
  const keyNick = "guestNickname";
  let guestId = localStorage.getItem(keyId);
  if (!guestId) {
    const rand = crypto.getRandomValues(new Uint32Array(2));
    guestId = `g_${Date.now().toString(36)}_${rand[0].toString(36)}${rand[1].toString(36)}`;
    localStorage.setItem(keyId, guestId);
  }
  localStorage.setItem(keyNick, nick);

  // ✅ 학생 시작 페이지로 이동 (기존 StudentBotList → StudentLogin으로 변경)
  window.location.href = "StudentLogin.html";
});

/* ---------- 교사: Google 로그인 ---------- */
const teacherBtn = document.getElementById("googleLoginBtn");
teacherBtn?.addEventListener("click", () => {
  signInWithPopup(auth, provider)
    .then((result) => {
      const email = result.user?.email || "";
      if (adminEmails.includes(email)) {
        window.location.href = "Admin.html";
      } else {
        window.location.href = "AfterLogIn.html";
      }
    })
    .catch((error) => {
      console.error("로그인 실패:", error);
      alert("로그인에 실패했습니다: " + error.message);
    });
});
