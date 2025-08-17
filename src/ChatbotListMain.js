import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore, collection, query, where, getDocs, deleteDoc, doc, updateDoc, serverTimestamp
} from "firebase/firestore";
import {
  getStorage, ref as sRef, getBlob, getBytes, deleteObject, getDownloadURL
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const listContainer = document.getElementById("chatbotList");

/* ===== OpenAI (assistants v2) ===== */
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || "";
const OPENAI_BASE = "https://api.openai.com/v1";

async function openaiFetch(path, { method = "GET", headers = {}, body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    throw new Error(`OpenAI ${res.status}: ${detail || res.statusText}`);
  }
  return res.json();
}

const createVectorStore = (name) =>
  openaiFetch("/vector_stores", { method: "POST", body: { name } });

const attachToVS = (vsId, fileId) =>
  openaiFetch(`/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });

async function waitIndexed(vsId, fileId, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (true) {
    const info = await openaiFetch(`/vector_stores/${vsId}/files/${fileId}`);
    if (info.status === "completed") return info;
    if (info.status === "failed") throw new Error("파일 인덱싱 실패");
    if (Date.now() - start > timeoutMs) throw new Error("인덱싱 타임아웃");
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

async function uploadFileToOpenAI(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", "assistants");
  return openaiFetch("/files", { method: "POST", body: form });
}

/* ===== helpers ===== */
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
/* few-shot 포함 */
function buildInstructions(desc, useRag, useFewShot, examples) {
  const guard = `한국어로 답하세요. 먼저 요지를 3–6문장으로 제시하세요. 추측/환각 금지.`;
  const ragGuide = useRag ? `업로드 문서 근거를 우선 사용하세요. 문서와 무관하면 일반 지식으로 답하세요.` : "";

  let few = "";
  if (useFewShot && Array.isArray(examples) && examples.length) {
    const header = `[few-shot 예시]
아래 예시는 답변의 형식/톤/구조를 보여주는 참고용입니다. 그대로 복사하지 말고 현재 질문에 맞게 변형하세요.`;
    const items = examples.map((ex, i) => `- 예시 ${i + 1}:\n${ex}`).join("\n\n");
    few = `${header}\n\n${items}`;
  }

  return [desc || "", guard, ragGuide, few].filter(Boolean).join("\n\n");
}
function renderMultiline(text) {
  return `<div style="white-space:pre-wrap;">${escapeHtml(text || "")}</div>`;
}
function setCreateState(btn, label, disabled = true) {
  btn.textContent = label;
  btn.disabled = disabled;
}

/** URL에서 버킷 상대경로 추출 */
function pathFromUrl(url) {
  try {
    const u = new URL(url);
    const idx = u.pathname.indexOf("/o/");
    if (idx === -1) return "";
    const enc = u.pathname.substring(idx + 3);
    const slash = enc.indexOf("/");
    const encodedPath = slash === -1 ? enc : enc.substring(0, slash);
    return decodeURIComponent(encodedPath);
  } catch {
    return "";
  }
}

/** gs:// 접두사를 버킷 상대경로로 정규화 */
function toBucketRelativePath(p) {
  if (!p) return "";
  return p.startsWith("gs://") ? p.replace(/^gs:\/\/[^/]+\//, "") : p;
}

/** Firestore 스키마(신/구)에서 RAG 파일 메타를 표준화하여 배열 반환 */
function normalizeRagFiles(data) {
  if (Array.isArray(data.ragFiles) && data.ragFiles.length) {
    return data.ragFiles.map((m, i) => ({
      name: m?.name || `파일 ${i + 1}.pdf`,
      path: m?.path || "",
      url:  m?.url  || ""
    }));
  }
  if (data.ragFileName) {
    const names = String(data.ragFileName).split(",").map(s => s.trim()).filter(Boolean);
    return names.map((n, i) => ({
      name: n,
      path: i === 0 ? (data.ragFilePath || "") : "",
      url:  i === 0 ? (data.ragFileUrl  || "") : ""
    }));
  }
  return [];
}

/** Storage SDK만 사용해서 Blob 획득 (CORS 회피) */
async function downloadPdfBlob(meta) {
  let path = toBucketRelativePath(meta?.path || "");
  if (!path && meta?.url) path = pathFromUrl(meta.url);
  if (!path) throw new Error("파일을 다운로드할 수 없습니다. (path 누락)");

  const refObj = sRef(storage, path);
  try {
    return await getBlob(refObj);
  } catch {
    const ab = await getBytes(refObj);
    return new Blob([ab], { type: "application/pdf" });
  }
}

/** Assistant 생성 또는 업데이트 (업서트) */
async function upsertAssistant({ existingAssistantId, model, name, instructions, vectorStoreId, chatbotDocId }) {
  const tools = vectorStoreId ? [{ type: "file_search" }] : [];
  const body = {
    model,
    name,
    instructions,
    tools,
    ...(vectorStoreId ? { tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } } } : {}),
    metadata: { chatbotDocId, source: "ChatbotList" }
  };

  if (existingAssistantId) {
    return openaiFetch(`/assistants/${existingAssistantId}`, { method: "POST", body });
  } else {
    return openaiFetch("/assistants", { method: "POST", body });
  }
}

/* ===== UI ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    alert("로그인이 필요합니다.");
    window.location.href = "LogIn.html";
    return;
  }

  try {
    const colRef = collection(db, "chatbots");
    const [snapOwner, snapUid] = await Promise.all([
      getDocs(query(colRef, where("ownerUid", "==", user.uid))),
      getDocs(query(colRef, where("uid", "==", user.uid)))
    ]);

    const seen = new Set();
    const docs = [];
    for (const snap of [snapOwner, snapUid]) {
      snap.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }});
    }

    listContainer.innerHTML = docs.length ? "" : "<p>요청한 챗봇이 없습니다.</p>";
    docs.forEach((docSnap) => {
      try { renderCard(docSnap); }
      catch (e) { console.error("카드 렌더 실패:", e); }
    });
  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `<p>목록을 불러오는 중 오류가 발생했습니다.<br/>${escapeHtml(err.message || String(err))}</p>`;
  }
});

function renderCard(docSnap) {
  const data = docSnap.data();
  const card = document.createElement("div");
  card.className = "chatbot-card";

  const name = data.name ?? "(이름 없음)";
  const subject = data.subject ?? "(교과 없음)";
  const description = data.description ?? "";
  const useRag = (data.useRag ?? data.rag ?? false);
  const useFewShot = data.useFewShot ?? false;
  const examples = Array.isArray(data.examples) ? data.examples : [];
  const selfConsistency = data.selfConsistency ?? false;

  const modelDisplay =
    (data.model && String(data.model)) ||
    (data.customModelValue && String(data.customModelValue)) ||
    (data.modelSelectValue && String(data.modelSelectValue)) ||
    "(미지정)";

  const ragList = normalizeRagFiles(data);

  const ragFilesHtml = ragList.length
    ? ragList.map((m, i) => {
        const label = `${i + 1}. ${escapeHtml(m.name || `파일 ${i + 1}`)}`;
        const path = toBucketRelativePath(m?.path || "") || pathFromUrl(m?.url || "");
        return path
          ? `<div><a class="rag-link" href="#" data-path="${escapeHtml(path)}">${label}</a></div>`
          : `<div>${label}</div>`;
      }).join("")
    : "없음";

  const examplesHtml = examples.length
    ? examples.map((e,i)=>`<div style="white-space:pre-wrap;">${i+1}. ${escapeHtml(e)}</div>`).join("")
    : "없음";

  card.innerHTML = `
    <h3>${escapeHtml(name)}</h3>
    <p><strong>교과:</strong> ${escapeHtml(subject)}</p>
    <p><strong>모델:</strong> ${escapeHtml(modelDisplay)}</p>
    <p><strong>설명:</strong></p>
    ${renderMultiline(description)}
    <p><strong>RAG:</strong> ${useRag ? "사용" : "미사용"}</p>
    <p><strong>RAG 파일:</strong><br>${ragFilesHtml}</p>
    <p><strong>few-shot:</strong> ${useFewShot ? "사용" : "미사용"}</p>
    <p><strong>예시:</strong></p>
    ${examplesHtml}
    <p><strong>self-consistency:</strong> ${selfConsistency ? "사용" : "미사용"}</p>
    <div class="card-buttons">
      <button class="create-btn">생성</button>
      <button class="edit-btn">수정</button>
      <button class="delete-btn">삭제</button>
    </div>
  `;

  const createBtn = card.querySelector(".create-btn");

  // 이미 assistantId가 있으면 기본 라벨 교체
  let currentAssistantId = data.assistantId ?? null;
  if (currentAssistantId) createBtn.textContent = "다시 생성/업데이트";

  createBtn.addEventListener("click", async () => {
    try {
      if (!OPENAI_API_KEY) {
        alert("OpenAI API 키가 설정되어 있지 않습니다. VITE_OPENAI_API_KEY를 설정하세요.");
        return;
      }
      setCreateState(createBtn, currentAssistantId ? "업데이트 중…" : "생성 중…", true);
      toast(currentAssistantId ? "Assistant 업데이트 준비…" : "Assistant 생성 준비…");

      const model =
        (data.model && String(data.model)) ||
        (data.customModelValue && String(data.customModelValue)) ||
        (data.modelSelectValue && String(data.modelSelectValue)) ||
        "gpt-4o-mini";

      let vectorStoreId = null;

      if (useRag && ragList.length) {
        toast("Vector Store 생성 중…");
        const vs = await createVectorStore(`vs_${Date.now()}_${docSnap.id}`);
        vectorStoreId = vs.id;

        let ok = 0;
        for (const m of ragList) {
          try {
            const blob = await downloadPdfBlob(m);
            const file = new File([blob], m.name || "document.pdf", { type: "application/pdf" });
            const up = await uploadFileToOpenAI(file);
            await attachToVS(vectorStoreId, up.id);
            await waitIndexed(vectorStoreId, up.id);
            ok++;
          } catch (e) {
            console.warn("RAG 파일 스킵:", m?.name, e?.message || e);
          }
        }
        if (ok === 0) {
          vectorStoreId = null;
          toast("⚠️ RAG 파일 인덱싱 실패로 RAG 없이 진행합니다.", 2000);
        }
      }

      const instructions = buildInstructions(description, !!vectorStoreId, useFewShot, examples);

      toast(currentAssistantId ? "Assistant 업데이트 중…" : "Assistant 생성 중…");
      const assistant = await upsertAssistant({
        existingAssistantId: currentAssistantId,
        model,
        name,
        instructions,
        vectorStoreId,
        chatbotDocId: docSnap.id
      });

      await updateDoc(doc(db, "chatbots", docSnap.id), {
        assistantId: assistant.id,
        vectorStoreId: vectorStoreId || null,
        assistantModelSnapshot: model,
        assistantCreatedAt: currentAssistantId ? (data.assistantCreatedAt || serverTimestamp()) : serverTimestamp(),
        assistantUpdatedAt: serverTimestamp()
      });

      // ✅ 성공 후에도 버튼을 다시 쓸 수 있게:
      currentAssistantId = assistant.id;               // 메모리에 반영
      setCreateState(createBtn, "다시 생성/업데이트", false); // 라벨/활성화
      toast(currentAssistantId ? "✅ 업데이트 완료!" : "✅ 생성 완료!");

    } catch (e) {
      console.error(e);
      alert("생성/업데이트 실패: " + (e?.message || e));
      setCreateState(createBtn, currentAssistantId ? "다시 생성/업데이트" : "생성", false);
    }
  });

  // 수정
  const editBtn = card.querySelector(".edit-btn");
  editBtn.addEventListener("click", () => {
    const payload = {
      id: docSnap.id,
      name: data.name ?? "",
      subject: data.subject ?? "",
      description: data.description ?? "",
      rag: data.useRag ?? data.rag ?? false,
      ragFileName: data.ragFileName ?? "",
      ragFileUrl: data.ragFileUrl ?? "",
      ragFilePath: data.ragFilePath ?? "",
      ragFiles: normalizeRagFiles(data),
      useFewShot: data.useFewShot ?? false,
      examples: Array.isArray(data.examples) ? data.examples : [],
      selfConsistency: data.selfConsistency ?? false
    };
    try { localStorage.setItem("editChatbot", JSON.stringify(payload)); } catch {}
    window.location.href = `CreateChatbot.html?id=${encodeURIComponent(docSnap.id)}`;
  });

  // 삭제
  const deleteBtn = card.querySelector(".delete-btn");
  deleteBtn.addEventListener("click", async () => {
    const confirmDelete = confirm("정말 삭제하시겠습니까?");
    if (!confirmDelete) return;

    try {
      const all = normalizeRagFiles(data);
      const legacy = data.ragFilePath ? [{ path: data.ragFilePath }] : [];
      for (const m of [...all, ...legacy]) {
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

  // RAG 링크: 안전 URL 생성 후 새 탭
  card.addEventListener("click", async (e) => {
    const a = e.target.closest("a.rag-link");
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
