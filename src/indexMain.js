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

// 관리자 이메일
const adminEmail = "wkdgjsdud@snu.ac.kr";

document.getElementById("googleLoginBtn").addEventListener("click", () => {
  signInWithPopup(auth, provider)
    .then((result) => {
      const user = result.user;
      const email = user.email;

      if (email === adminEmail) {
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
