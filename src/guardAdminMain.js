// src/guardAdminMain.js
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";
import { isAdmin } from "./rolesMain.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

onAuthStateChanged(auth, (user) => {
  const email = user?.email || "";
  if (!user || !isAdmin(email)) {
    alert("관리자 페이지 접근 권한이 없습니다.");
    window.location.replace("index.html");
  }
});
