import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const listContainer = document.getElementById("chatbotList");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    alert("로그인이 필요합니다.");
    window.location.href = "LogIn.html";
    return;
  }

  const q = query(collection(db, "chatbots"), where("uid", "==", user.uid));
  const querySnapshot = await getDocs(q);

  if (querySnapshot.empty) {
    listContainer.innerHTML = "<p>요청한 챗봇이 없습니다.</p>";
    return;
  }

  querySnapshot.forEach((docSnap) => {
    const data = docSnap.data();
    const card = document.createElement("div");
    card.className = "chatbot-card";

    card.innerHTML = `
      <h3>${data.name}</h3>
      <p><strong>교과:</strong> ${data.subject}</p>
      <p><strong>설명:</strong> ${data.description}</p>
      <p><strong>RAG:</strong> ${data.rag ? "✅" : "❌"}</p>
      <p><strong>Few-shot 예시 수:</strong> ${data.fewShots?.length || 0}</p>
      <p><strong>Self-consistency:</strong> ${data.selfConsistency ? "✅" : "❌"}</p>
      <div class="card-buttons">
        <button class="edit-btn" data-id="${docSnap.id}">수정</button>
        <button class="delete-btn" data-id="${docSnap.id}">삭제</button>
      </div>
    `;

    // 수정 버튼
    card.querySelector(".edit-btn").addEventListener("click", () => {
      localStorage.setItem("editChatbotId", docSnap.id);
      window.location.href = "CreateChatbot.html";
    });

    // 삭제 버튼
    card.querySelector(".delete-btn").addEventListener("click", async () => {
      const confirmDelete = confirm("정말 이 챗봇 요청을 삭제하시겠습니까?");
      if (confirmDelete) {
        try {
          await deleteDoc(doc(db, "chatbots", docSnap.id));
          alert("삭제되었습니다.");
          card.remove(); // 화면에서도 제거
        } catch (err) {
          console.error(err);
          alert("삭제 실패: " + err.message);
        }
      }
    });

    listContainer.appendChild(card);
  });
});
