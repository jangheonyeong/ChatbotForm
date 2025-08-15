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

  try {
    // ✅ ownerUid(신규 스키마) 우선, 없으면 uid(구 스키마)도 조회해서 병합
    const colRef = collection(db, "chatbots");
    const [snapOwner, snapUid] = await Promise.all([
      getDocs(query(colRef, where("ownerUid", "==", user.uid))),
      getDocs(query(colRef, where("uid", "==", user.uid)))
    ]);

    const seen = new Set();
    const docs = [];

    for (const snap of [snapOwner, snapUid]) {
      snap.forEach((d) => {
        if (!seen.has(d.id)) {
          seen.add(d.id);
          docs.push(d);
        }
      });
    }

    if (!docs.length) {
      listContainer.innerHTML = "<p>요청한 챗봇이 없습니다.</p>";
      return;
    }

    docs.forEach((docSnap) => {
      const data = docSnap.data();
      const card = document.createElement("div");
      card.className = "chatbot-card";

      // ✅ 필드 매핑(양쪽 스키마 호환)
      const name = data.name ?? "(이름 없음)";
      const subject = data.subject ?? "(교과 없음)";
      const description = data.description ?? "";
      const useRag = (data.useRag ?? data.rag ?? false);
      const ragFileName = data.ragFileName ?? "";     // (Storage 사용 안하면 빈 값)
      const useFewShot = data.useFewShot ?? false;
      const examples = Array.isArray(data.examples) ? data.examples : [];
      const selfConsistency = data.selfConsistency ?? false;

      card.innerHTML = `
        <h3>${escapeHtml(name)}</h3>
        <p><strong>교과:</strong> ${escapeHtml(subject)}</p>
        <p><strong>설명:</strong> ${escapeHtml(description)}</p>
        <p><strong>RAG:</strong> ${useRag ? "사용" : "미사용"}</p>
        <p><strong>RAG 파일:</strong> ${ragFileName ? escapeHtml(ragFileName) : "없음"}</p>
        <p><strong>few-shot:</strong> ${useFewShot ? "사용" : "미사용"}</p>
        <p><strong>예시:</strong> ${examples.length ? examples.map(escapeHtml).join(", ") : "없음"}</p>
        <p><strong>self-consistency:</strong> ${selfConsistency ? "사용" : "미사용"}</p>
        <div class="card-buttons">
          <button class="edit-btn">수정</button>
          <button class="delete-btn">삭제</button>
        </div>
      `;

      // ✅ 수정 버튼: 기존 로직 유지 (localStorage에 담아 CreateChatbot로 이동)
      const editBtn = card.querySelector(".edit-btn");
      editBtn.addEventListener("click", () => {
        const chatbotData = {
          id: docSnap.id,
          name,
          subject,
          description,
          rag: useRag,
          ragFileName: ragFileName,
          ragFileUrl: data.ragFileUrl ?? "",
          ragFilePath: data.ragFilePath ?? "",
          useFewShot,
          examples,
          selfConsistency
        };
        localStorage.setItem("editChatbot", JSON.stringify(chatbotData));
        window.location.href = "CreateChatbot.html";
      });

      // ✅ 삭제 버튼: Storage 경로가 있을 때만 삭제 시도 (없으면 Firestore만 삭제)
      const deleteBtn = card.querySelector(".delete-btn");
      deleteBtn.addEventListener("click", async () => {
        const confirmDelete = confirm("정말 삭제하시겠습니까?");
        if (!confirmDelete) return;

        try {
          if (data.ragFilePath) {
            try {
              const fileRef = ref(storage, data.ragFilePath);
              await deleteObject(fileRef);
            } catch (e) {
              // Storage 파일이 없을 수도 있으니 조용히 계속 진행
              console.warn("Storage 파일 삭제 스킵/실패:", e?.message);
            }
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
  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `<p>목록을 불러오는 중 오류가 발생했습니다.<br/>${escapeHtml(err.message || String(err))}</p>`;
  }
});

// 간단한 XSS 방지용 이스케이프
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
