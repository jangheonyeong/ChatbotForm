import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 로그인 폼 처리
const form = document.getElementById("loginForm");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const autoLogin = document.getElementById("autoLogin").checked;

  try {
    // 자동 로그인 여부에 따라 Persistence 설정
    await setPersistence(auth, autoLogin ? browserLocalPersistence : browserSessionPersistence);

    await signInWithEmailAndPassword(auth, email, password);
    alert("로그인 성공!");
    window.location.href = "AfterLogIn.html";
  } catch (error) {
    console.error(error);
    alert("로그인 실패: " + error.message);
  }
});
