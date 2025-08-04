import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged
} from "firebase/auth";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  doc
} from "firebase/firestore";
import {
  getStorage,
  ref,
  deleteObject
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
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
      <p><strong>RAG:</strong> ${data.rag ? "사용" : "미사용"}</p>
      <p><strong>RAG 파일:</strong> ${data.ragFileName ?? "없음"}</p>
      <p><strong>few-shot:</strong> ${data.useFewShot ? "사용" : "미사용"}</p>
      <p><strong>예시:</strong> ${(data.examples || []).join(", ") || "없음"}</p>
      <p><strong>self-consistency:</strong> ${data.selfConsistency ? "사용" : "미사용"}</p>
      <div class="card-buttons">
        <button class="edit-btn">수정</button>
        <button class="delete-btn">삭제</button>
      </div>
    `;

    // ✅ 수정 버튼 클릭 시 localStorage 저장 후 페이지 이동
    const editBtn = card.querySelector(".edit-btn");
    editBtn.addEventListener("click", () => {
      const chatbotData = {
        id: docSnap.id,
        name: data.name,
        subject: data.subject,
        description: data.description,
        rag: data.rag,
        ragFileName: data.ragFileName ?? "",
        ragFileUrl: data.ragFileUrl ?? "",
        ragFilePath: data.ragFilePath ?? "",
        useFewShot: data.useFewShot ?? false,
        examples: data.examples ?? [],
        selfConsistency: data.selfConsistency ?? false
      };
      localStorage.setItem("editChatbot", JSON.stringify(chatbotData));
      window.location.href = "CreateChatbot.html";
    });

    const deleteBtn = card.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", async () => {
      const confirmDelete = confirm("정말 삭제하시겠습니까?");
      if (!confirmDelete) return;

      try {
        if (data.ragFilePath) {
          const fileRef = ref(storage, data.ragFilePath);
          await deleteObject(fileRef);
        }
        await deleteDoc(doc(db, "chatbots", docSnap.id));
        alert("삭제 완료");
        card.remove();
      } catch (err) {
        alert("삭제 실패: " + err.message);
      }
    });

    listContainer.appendChild(card);
  });
});
