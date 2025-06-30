import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 인증 상태 확인: 로그인된 사용자만 접근 가능
onAuthStateChanged(auth, (user) => {
  if (!user) {
    alert("로그인이 필요합니다.");
    window.location.href = "LogIn.html";
  }
});

document.getElementById("createChatbotBtn").addEventListener("click", () => {
  window.location.href = "CreateChatbot.html"; // 이후 구현 예정
});

document.getElementById("viewListBtn").addEventListener("click", () => {
  window.location.href = "ChatbotList.html"; // 이후 구현 예정
});
