// src/guardTeacherMain.js
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";
import { isTeacher, isAdmin } from "./rolesMain.js";

// 중복 초기화 방지
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

// 관리자도 교사용 페이지 접근 가능하게 하려면 isAdmin OR 조건 유지
onAuthStateChanged(auth, (user) => {
  const email = user?.email || "";
  if (!user || !(isTeacher(email) || isAdmin(email))) {
    alert("교사용 페이지 접근 권한이 없습니다.");
    // 뒤로가기 방지: replace
    window.location.replace("index.html");
  }
});
