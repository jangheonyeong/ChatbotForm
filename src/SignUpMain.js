import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 이메일/비밀번호 회원가입
document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    alert("회원가입 성공! 로그인 페이지로 이동합니다.");
    window.location.href = "LogIn.html";
  } catch (error) {
    console.error(error);
    alert("회원가입 실패: " + error.message);
  }
});
