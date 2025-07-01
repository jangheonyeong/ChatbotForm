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
  updateDoc,
  doc,
  deleteDoc,
  serverTimestamp
} from "firebase/firestore";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  getMetadata
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

    const createdAt = data.createdAt?.toDate().toLocaleString("ko-KR") || "날짜 없음";
    const fewShotText = data.examples?.length > 0 ? data.examples.join(", ") : "없음";

    card.innerHTML = `
      <h3 contenteditable="false">${data.name}</h3>
      <p><strong>교과:</strong> <span contenteditable="false">${data.subject}</span></p>
      <p><strong>설명:</strong><br/><textarea class="editable" readonly>${data.description}</textarea></p>
      <label class="checkbox-row"><strong>RAG:</strong> <input type="checkbox" class="rag-check styled" disabled ${data.rag ? "checked" : ""} /></label>
      <div class="rag-controls ${data.rag ? "" : "hidden"}">
        <p><strong>RAG 파일:</strong> ${data.ragFileUrl ? `<a href="${data.ragFileUrl}" class="rag-link" target="_blank" onclick="event.stopPropagation();">${data.ragFileName}</a>` : "없음"}</p>
        <input type="file" class="rag-file hidden" accept=".pdf" />
        <button class="delete-rag hidden">RAG 파일 삭제</button>
      </div>

      <label class="checkbox-row"><strong>few-shot 사용:</strong> <input type="checkbox" class="few-check styled" disabled ${data.useFewShot ? "checked" : ""} /></label>
      <div class="few-controls ${data.useFewShot ? "" : "hidden"}">
        <p><strong>few-shot 예시:</strong> <span class="few-text">${fewShotText}</span></p>
        <div class="few-container hidden">
          ${(data.examples || []).map(e => `<input type="text" class="few-input readonly" value="${e}" readonly />`).join("<br/>")}
          <button class="add-few hidden">+ 예시 추가</button>
        </div>
      </div>

      <label class="checkbox-row"><strong>self-consistency:</strong> <input type="checkbox" class="self-check styled" disabled ${data.selfConsistency ? "checked" : ""} /></label>
      <p class="timestamp"><strong>요청 일시:</strong> <span class="created-at">${createdAt}</span></p>

      <div class="card-buttons">
        <button class="edit-btn">수정</button>
        <button class="save-btn hidden">저장</button>
        <button class="delete-btn">삭제</button>
      </div>
    `;

    const titleEl = card.querySelector("h3");
    const subjectEl = card.querySelector("p span");
    const descTextarea = card.querySelector("textarea.editable");
    const editBtn = card.querySelector(".edit-btn");
    const saveBtn = card.querySelector(".save-btn");
    const deleteBtn = card.querySelector(".delete-btn");

    const ragCheckbox = card.querySelector(".rag-check");
    const ragControls = card.querySelector(".rag-controls");
    const ragFileInput = card.querySelector(".rag-file");
    const ragDeleteBtn = card.querySelector(".delete-rag");

    const fewCheckbox = card.querySelector(".few-check");
    const fewControls = card.querySelector(".few-controls");
    const fewSpan = card.querySelector(".few-text");
    const fewContainer = card.querySelector(".few-container");
    const addFewBtn = card.querySelector(".add-few");

    const selfCheckbox = card.querySelector(".self-check");
    const createdAtSpan = card.querySelector(".created-at");

    editBtn.addEventListener("click", () => {
      titleEl.contentEditable = "true";
      subjectEl.contentEditable = "true";
      descTextarea.readOnly = false;

      ragCheckbox.disabled = false;
      ragFileInput.classList.remove("hidden");
      ragDeleteBtn.classList.remove("hidden");

      fewCheckbox.disabled = false;
      fewSpan.classList.add("hidden");
      fewContainer.classList.remove("hidden");
      addFewBtn.classList.remove("hidden");

      selfCheckbox.disabled = false;
      editBtn.classList.add("hidden");
      saveBtn.classList.remove("hidden");

      fewContainer.querySelectorAll(".few-input").forEach(el => {
        el.readOnly = false;
        el.classList.remove("readonly");
      });
    });

    ragCheckbox.addEventListener("change", () => {
      ragControls.classList.toggle("hidden", !ragCheckbox.checked);
    });

    fewCheckbox.addEventListener("change", () => {
      fewControls.classList.toggle("hidden", !fewCheckbox.checked);
    });

    addFewBtn.addEventListener("click", () => {
      const newInput = document.createElement("input");
      newInput.type = "text";
      newInput.className = "few-input";
      fewContainer.insertBefore(newInput, addFewBtn);
      fewContainer.insertBefore(document.createElement("br"), addFewBtn);
    });

    saveBtn.addEventListener("click", async () => {
      try {
        const newName = titleEl.textContent.trim();
        const newSubject = subjectEl.textContent.trim();
        const newDesc = descTextarea.value.trim();
        const newRag = ragCheckbox.checked;
        const newSelf = selfCheckbox.checked;
        const newFewUsed = fewCheckbox.checked;
        const fewInputs = [...fewContainer.querySelectorAll(".few-input")];
        const newFew = fewInputs.map(el => el.value.trim()).filter(Boolean);

        let updateObj = {
          name: newName,
          subject: newSubject,
          description: newDesc,
          rag: newRag,
          selfConsistency: newSelf,
          useFewShot: newFewUsed,
          examples: newFew,
          createdAt: serverTimestamp(),
        };

        if (ragFileInput.files.length > 0) {
          if (data.ragFilePath) {
            try {
              const oldRef = ref(storage, data.ragFilePath);
              await deleteObject(oldRef);
            } catch (e) {
              console.warn("기존 파일 삭제 실패 (무시):", e.message);
            }
          }

          const file = ragFileInput.files[0];
          const path = `rag-files/${user.uid}/${docSnap.id}/${file.name}`;
          const fileRef = ref(storage, path);
          await uploadBytes(fileRef, file);
          const url = await getDownloadURL(fileRef);
          updateObj.ragFileName = file.name;
          updateObj.ragFileUrl = url;
          updateObj.ragFilePath = path;
        }

        await updateDoc(doc(db, "chatbots", docSnap.id), updateObj);
        alert("수정 완료!");
        window.location.reload();
      } catch (err) {
        console.error("수정 실패:", err);
        alert("수정 실패: " + err.message);
      }
    });

    ragDeleteBtn.addEventListener("click", async () => {
      if (!data.ragFileName || !data.ragFilePath) return;
      const confirmDelete = confirm("RAG 파일을 삭제하시겠습니까?");
      if (!confirmDelete) return;

      const fileRef = ref(storage, data.ragFilePath);

      try {
        await getMetadata(fileRef);
        await deleteObject(fileRef);
      } catch (err) {
        if (err.code !== "storage/object-not-found") {
          alert("삭제 실패: " + err.message);
          return;
        }
      }

      await updateDoc(doc(db, "chatbots", docSnap.id), {
        ragFileName: "",
        ragFileUrl: "",
        ragFilePath: ""
      });

      alert("파일 정보 삭제 완료");
      window.location.reload();
    });

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
