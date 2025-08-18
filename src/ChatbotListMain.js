// [src/ChatbotListMain.js] — 목록/수정/삭제 최소 버전 + 구/신 스키마 동시 조회

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore, collection, query, where, getDocs, deleteDoc, doc
} from "firebase/firestore";
import {
  getStorage, ref as sRef, deleteObject, getDownloadURL
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const listContainer = document.getElementById("chatbotList");

/* ===== helpers ===== */
function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function toast(text, ms = 1400) {
  const t = document.createElement("div");
  t.textContent = text;
  Object.assign(t.style, {
    position: "fixed", right: "20px", bottom: "20px",
    background: "#003478", color: "#fff", padding: "10px 14px",
    borderRadius: "10px", boxShadow: "0 8px 20px rgba(0,0,0,.15)",
    zIndex: 9999, fontSize: "14px"
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function normalizeRagFiles(data) {
  if (Array.isArray(data.ragFiles) && data.ragFiles.length) {
    return data.ragFiles.map((m, i) => ({
      name: m?.name || `파일 ${i + 1}.pdf`,
      path: m?.path || "",
      url:  m?.url  || ""
    }));
  }
  if (data.ragFileName || data.ragFileUrl || data.ragFilePath) {
    return [{
      name: data.ragFileName || "document.pdf",
      url:  data.ragFileUrl  || "",
      path: data.ragFilePath || ""
    }];
  }
  return [];
}

/* ===== 메인 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    alert("로그인이 필요합니다.");
    window.location.href = "AfterLogIn.html";
    return;
  }

  try {
    const colRef = collection(db, "chatbots");

    // ✅ 신/구 스키마 동시 지원 (ownerUid 또는 uid)
    const [snapOwner, snapLegacy] = await Promise.all([
      getDocs(query(colRef, where("ownerUid", "==", user.uid))),
      getDocs(query(colRef, where("uid", "==", user.uid)))
    ]);

    const seen = new Set();
    const docs = [];
    [snapOwner, snapLegacy].forEach(snap => {
      snap.forEach(d => {
        if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }
      });
    });

    if (docs.length === 0) {
      listContainer.innerHTML = "<p>요청한 챗봇이 없습니다.</p>";
      return;
    }

    listContainer.innerHTML = "";
    docs.forEach((docSnap) => renderCard(docSnap));

  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `
      <p>목록을 불러오는 중 오류가 발생했습니다.<br/>
      ${escapeHtml(err.message || String(err))}</p>`;
  }
});

function renderCard(docSnap) {
  const data = docSnap.data();
  const card = document.createElement("div");
  card.className = "chatbot-card";

  const name = data.name ?? "(이름 없음)";
  const subject = data.subject ?? "(교과 없음)";
  const description = data.description ?? "";
  const modelDisplay =
    (data.model && String(data.model)) ||
    (data.customModelValue && String(data.customModelValue)) ||
    (data.modelSelectValue && String(data.modelSelectValue)) ||
    "(미지정)";

  const ragList = normalizeRagFiles(data);
  const ragFilesHtml = ragList.length
    ? ragList.map((m, i) => {
        const label = `${i + 1}. ${escapeHtml(m.name || `파일 ${i + 1}`)}`;
        const link = m.url ? `<a class="rag-url" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${label}</a>` 
                           : `<a class="rag-path" href="#" data-path="${escapeHtml(m.path || "")}">${label}</a>`;
        return `<div>${link}</div>`;
      }).join("")
    : "없음";

  card.innerHTML = `
    <h3>${escapeHtml(name)}</h3>
    <p><strong>교과:</strong> ${escapeHtml(subject)}</p>
    <p><strong>모델:</strong> ${escapeHtml(modelDisplay)}</p>
    <p><strong>설명:</strong></p>
    <div style="white-space:pre-wrap;">${escapeHtml(description)}</div>
    <p><strong>RAG 파일:</strong><br>${ragFilesHtml}</p>
    <div class="card-buttons">
      <button class="edit-btn">수정</button>
      <button class="delete-btn">삭제</button>
    </div>
  `;

  // 수정
  card.querySelector(".edit-btn").addEventListener("click", () => {
    window.location.href = `CreateChatbot.html?id=${encodeURIComponent(docSnap.id)}`;
  });

  // 삭제 (Storage 파일도 같이 정리 — 실패해도 목록 삭제는 진행)
  card.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    try {
      const all = normalizeRagFiles(data);
      for (const m of all) {
        if (!m?.path) continue;
        try { await deleteObject(sRef(storage, m.path)); } catch (e) {
          console.warn("Storage 파일 삭제 스킵/실패:", e?.message);
        }
      }
      await deleteDoc(doc(db, "chatbots", docSnap.id));
      toast("🗑️ 삭제 완료");
      card.remove();
    } catch (err) {
      alert("삭제 실패: " + (err?.message || err));
    }
  });

  // Storage 경로만 있는 링크 클릭 시에만 URL 생성 시도
  card.addEventListener("click", async (e) => {
    const a = e.target.closest("a.rag-path");
    if (!a) return;
    e.preventDefault();
    const path = a.dataset.path || "";
    if (!path) return;
    try {
      const url = await getDownloadURL(sRef(storage, path));
      window.open(url, "_blank", "noopener");
    } catch (err) {
      alert("링크 열기 실패: " + (err?.message || err));
    }
  });

  listContainer.appendChild(card);
}
