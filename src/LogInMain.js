import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 페이지 로드시 localStorage에서 자동 로그인 상태 복원
window.addEventListener("DOMContentLoaded", () => {
  const savedAutoLogin = localStorage.getItem("autoLogin") === "true";
  document.getElementById("autoLogin").checked = savedAutoLogin;
});

// 로그인 폼 처리
const form = document.getElementById("loginForm");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const autoLogin = document.getElementById("autoLogin").checked;

  // localStorage에 자동 로그인 여부 저장
  localStorage.setItem("autoLogin", autoLogin);

  try {
    const persistence = autoLogin ? browserLocalPersistence : browserSessionPersistence;

    await setPersistence(auth, persistence);
    await signInWithEmailAndPassword(auth, email, password);
    alert("로그인 성공!");
    window.location.href = "AfterLogIn.html";
  } catch (error) {
    console.error(error);
    alert("로그인 실패: " + error.message);
  }
});

// Google 로그인 처리
document.getElementById("googleLogin").addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();

  // Google 로그인은 항상 로컬로 저장
  await setPersistence(auth, browserLocalPersistence);

  try {
    await signInWithPopup(auth, provider);
    alert("Google 로그인 성공!");
    window.location.href = "AfterLogIn.html";
  } catch (error) {
    console.error(error);
    alert("Google 로그인 실패: " + error.message);
  }
});
