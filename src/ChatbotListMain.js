// [src/ChatbotListMain.js] — 내 문서만 목록 + Assistant 생성/업데이트 + RAG 인덱싱
// ✅ 변경 핵심
// 1) 각 카드에 "CSV 내보내기" 버튼 추가(교과(subject) 기준 + 기간 필터)
// 2) 학생용 링크에 teacherUid와 assistantId 파라미터 포함(로깅 신뢰성 ↑)

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore, collection, query, where, getDocs, deleteDoc, doc, updateDoc, serverTimestamp, Timestamp
} from "firebase/firestore";
import { getStorage, ref as sRef, getBlob, getBytes, deleteObject, getDownloadURL } from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

/* ===== DOM ===== */
const listContainer = document.getElementById("chatbotList");

/* ===== OpenAI (assistants v2) ===== */
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || "";
const OPENAI_BASE = "https://api.openai.com/v1";

async function openaiFetch(path, { method = "GET", headers = {}, body, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const isForm = body instanceof FormData;
    const res = await fetch(`${OPENAI_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...headers
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(()=> "");
      throw new Error(`OpenAI ${res.status}: ${detail || res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

const createVectorStore = (name) =>
  openaiFetch("/vector_stores", { method: "POST", body: { name } });

const attachToVS = (vsId, fileId) =>
  openaiFetch(`/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });

async function waitIndexed(vsId, fileId, { timeoutMs = 600000, intervalMs = 3000 } = {}) { // 최대 10분
  const start = Date.now();
  while (true) {
    const info = await openaiFetch(`/vector_stores/${vsId}/files/${fileId}`);
    if (info.status === "completed") return info;
    if (info.status === "failed") throw new Error("파일 인덱싱 실패");
    if (Date.now() - start > timeoutMs) throw new Error("인덱싱 타임아웃");
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// VS에 붙어있는 파일 목록(파일명 얻으려면 /files/{id} 추가 조회)
async function listVSFilesWithNames(vsId) {
  const out = [];
  let after = null;
  while (true) {
    const qs = after ? `?after=${after}&limit=100` : `?limit=100`;
    const data = await openaiFetch(`/vector_stores/${vsId}/files${qs}`);
    const arr = Array.isArray(data?.data) ? data.data : [];
    for (const f of arr) {
      try {
        const meta = await openaiFetch(`/files/${f.id}`);
        out.push({ id: f.id, status: f.status, filename: meta?.filename || "" });
      } catch {
        out.push({ id: f.id, status: f.status, filename: "" });
      }
    }
    if (!data?.has_more) break;
    after = data.last_id || null;
    if (!after) break;
  }
  return out;
}

async function uploadFileToOpenAI(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", "assistants");
  return openaiFetch("/files", { method: "POST", body: form });
}

/* ===== helpers ===== */
function escapeHtml(str){return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function toast(text, ms=1400){
  const t=document.createElement("div"); t.textContent=text;
  Object.assign(t.style,{position:"fixed",right:"20px",bottom:"20px",background:"#003478",color:"#fff",
    padding:"10px 14px",borderRadius:"10px",boxShadow:"0 8px 20px rgba(0,0,0,.15)",zIndex:9999,fontSize:"14px"});
  document.body.appendChild(t); setTimeout(()=>t.remove(),ms);
}

function normalizeRagFiles(data){
  if (Array.isArray(data.ragFiles) && data.ragFiles.length){
    return data.ragFiles.map((m,i)=>({name:m?.name||`파일 ${i+1}.pdf`,path:m?.path||"",url:m?.url||""}));
  }
  if (data.ragFileName || data.ragFileUrl || data.ragFilePath){
    return [{name:data.ragFileName||"document.pdf",url:data.ragFileUrl||"",path:data.ragFilePath||""}];
  }
  return [];
}

/** Storage에서 PDF Blob 받기 (권한 내 경로만) */
async function downloadPdfBlob(meta) {
  let path = meta?.path || "";
  if (!path && meta?.url) {
    try {
      const u = new URL(meta.url);
      const idx = u.pathname.indexOf("/o/");
      if (idx !== -1) {
        const encodedPath = u.pathname.substring(idx + 3).split("/")[0];
        path = decodeURIComponent(encodedPath);
      }
    } catch {}
  }
  if (!path) throw new Error("파일 경로 누락");
  const refObj = sRef(storage, path);
  try {
    return await getBlob(refObj);
  } catch {
    const ab = await getBytes(refObj);
    return new Blob([ab], { type: "application/pdf" });
  }
}

function buildInstructions(desc, useRag, useFewShot, examples){
  const guard = `한국어로 답하세요. 먼저 요지를 3–6문장으로 제시하고, 불확실하면 근거를 표시하세요. 추측/환각 금지.`;
  const ragGuide = useRag ? `업로드 문서 근거를 우선 사용하세요. 문서와 무관하면 일반 지식으로 답하되 근거를 분리해 주세요.` : "";
  let few = "";
  if (useFewShot && Array.isArray(examples) && examples.length){
    const header = `[few-shot 예시] 아래 예시는 형식/톤 참고용이며, 그대로 복붙하지 말고 현재 질문에 맞게 변형하세요.`;
    const items = examples.map((ex,i)=>`- 예시 ${i+1}:\n${ex}`).join("\n\n");
    few = `${header}\n\n${items}`;
  }
  return [desc||"", guard, ragGuide, few].filter(Boolean).join("\n\n");
}

/** Assistant 생성/업데이트 (업서트) */
async function upsertAssistant({ existingAssistantId, model, name, instructions, vectorStoreId, chatbotDocId }) {
  const tools = vectorStoreId ? [{ type: "file_search" }] : [];
  const body = {
    model, name, instructions, tools,
    ...(vectorStoreId ? { tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } } } : {}),
    metadata: { chatbotDocId, source: "ChatbotList" }
  };
  if (existingAssistantId) {
    return openaiFetch(`/assistants/${existingAssistantId}`, { method: "POST", body });
  } else {
    return openaiFetch("/assistants", { method: "POST", body });
  }
}

/* ===== CSV Export (교과별) ===== */
function yyyymmdd(d){
  const z = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}

async function exportSubjectCSV({ subject, teacherUid, startDate, endDate }) {
  // conversations: where subject==, teacherUid==, createdAt in [start, end)
  const convQ = query(
    collection(db, "conversations"),
    where("subject", "==", subject),
    where("teacherUid", "==", teacherUid),
    where("createdAt", ">=", Timestamp.fromDate(startDate)),
    where("createdAt", "<", Timestamp.fromDate(endDate))
  );

  const convSnap = await getDocs(convQ);
  const rows = [];

  for (const conv of convSnap.docs) {
    const c = conv.data();
    // messages 하위 수집
    const msgsSnap = await getDocs(collection(db, `conversations/${conv.id}/messages`));
    msgsSnap.forEach(m => {
      const d = m.data();
      rows.push({
        conversationId: conv.id,
        subject: c.subject || "",
        assistantId: c.assistantId || "",
        teacherUid: c.teacherUid || "",
        studentNickname: c.studentNickname || "",
        createdAtConvKST: c.createdAt?.toDate?.()
          ? c.createdAt.toDate().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
          : "",
        role: d.role || "",
        content: String(d.content ?? "").replace(/\s+/g, " ").trim(),
        createdAtMsgKST: d.createdAt?.toDate?.()
          ? d.createdAt.toDate().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
          : ""
      });
    });
  }

  const headers = Object.keys(rows[0] || {
    conversationId:"",subject:"",assistantId:"",teacherUid:"",studentNickname:"",
    createdAtConvKST:"",role:"",content:"",createdAtMsgKST:""
  });

  const csv = [headers.join(",")]
    .concat(rows.map(r => headers.map(h => {
      const cell = String(r[h] ?? "");
      return `"${cell.replace(/"/g,'""')}"`;
    }).join(",")))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const fname = `export_${subject}_${yyyymmdd(startDate)}_${yyyymmdd(endDate)}.csv`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: fname });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("📄 CSV 내보내기 완료");
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
    // 내 문서만 (신/구/이메일 호환)
    const [snapOwner, snapLegacy, snapEmail] = await Promise.all([
      getDocs(query(colRef, where("ownerUid", "==", user.uid))),
      getDocs(query(colRef, where("uid", "==", user.uid))),
      getDocs(query(colRef, where("ownerEmail", "==", user.email || "")))
    ]);

    const seen = new Set();
    const docs = [];
    [snapOwner, snapLegacy, snapEmail].forEach(snap => {
      snap.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }});
    });

    listContainer.innerHTML = docs.length ? "" : "<p>요청한 챗봇이 없습니다.</p>";
    docs.forEach((docSnap) => renderCard(docSnap, user));

  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `
      <p>목록을 불러오는 중 오류가 발생했습니다.<br/>
      ${escapeHtml(err.message || String(err))}</p>`;
  }
});

function renderCard(docSnap, user){
  const data = docSnap.data();
  const card = document.createElement("div");
  card.className = "chatbot-card";

  const name = data.name ?? "(이름 없음)";
  const subject = data.subject ?? "(교과 없음)";
  const description = data.description ?? "";
  const useRag = (data.useRag ?? data.rag ?? false);
  const useFewShot = !!data.useFewShot;
  const examples = Array.isArray(data.examples) ? data.examples : [];
  const selfConsistency = !!data.selfConsistency;

  const modelDisplay =
    (data.model && String(data.model)) ||
    (data.customModelValue && String(data.customModelValue)) ||
    (data.modelSelectValue && String(data.modelSelectValue)) ||
    "gpt-4o-mini";

  const ragList = normalizeRagFiles(data);

  const ragFilesHtml = ragList.length
    ? ragList.map((m,i)=>{
        const label = `${i+1}. ${escapeHtml(m.name||`파일 ${i+1}`)}`;
        const link  = m.url
          ? `<a class="rag-url" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${label}</a>`
          : `<a class="rag-path" href="#" data-path="${escapeHtml(m.path||"")}">${label}</a>`;
        return `<div>${link}</div>`;
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
    <div style="white-space:pre-wrap;">${escapeHtml(description)}</div>

    <p><strong>RAG:</strong> ${useRag ? "사용" : "미사용"}</p>
    <p><strong>RAG 파일:</strong><br>${ragFilesHtml}</p>

    <p><strong>few-shot:</strong> ${useFewShot ? "사용" : "미사용"}</p>
    <p><strong>예시:</strong><br/>${examplesHtml}</p>

    <p><strong>self-consistency:</strong> ${selfConsistency ? "사용" : "미사용"}</p>

    <div class="card-buttons">
      <button class="create-btn">${data.assistantId ? "다시 생성/업데이트" : "생성"}</button>
      <button class="student-btn" ${data.assistantId ? "" : "disabled title='먼저 생성하세요'"}>학생용 링크</button>
      <button class="export-btn">CSV 내보내기</button>
      <button class="edit-btn">수정</button>
      <button class="delete-btn">삭제</button>
    </div>
  `;

  const createBtn  = card.querySelector(".create-btn");
  const studentBtn = card.querySelector(".student-btn");
  const exportBtn  = card.querySelector(".export-btn");

  // ✅ 학생용 링크: teacherUid/assistantId 동시 전달 (StudentChat이 메타를 바로 저장 가능)
  studentBtn.addEventListener("click", () => {
    if (!data.assistantId) return;
    const params = new URLSearchParams({
      // 호환성: 두 키 모두 전달
      assistant: data.assistantId,
      assistantId: data.assistantId,
      name: name || "학생용 챗봇",
      subject: subject || "",
      model: String(modelDisplay || ""),
      teacherUid: data.ownerUid || data.uid || user.uid || ""
    });
    window.open(`StudentChat.html?${params.toString()}`, "_blank", "noopener");
  });

  // ✅ 교과별 CSV 내보내기 (기간 필터 간단 프롬프트)
  exportBtn.addEventListener("click", async () => {
    try {
      if (!subject || subject === "(교과 없음)") {
        alert("교과 정보가 없어 CSV를 생성할 수 없습니다.");
        return;
      }
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 7);
      const startStr = prompt("시작 날짜(YYYY-MM-DD)", yyyymmdd(defaultStart));
      if (!startStr) return;
      const endStr = prompt("종료 날짜(YYYY-MM-DD, *해당 일자 제외 상한*)", yyyymmdd(new Date()));
      if (!endStr) return;

      // 로컬 타임 기준으로 하루 경계 정의(Asia/Seoul 고려는 서버/쿼리 단계에서 Timestamp로 고정)
      const startDate = new Date(`${startStr}T00:00:00`);
      const endDate = new Date(`${endStr}T00:00:00`);

      toast("CSV 생성 중…");
      await exportSubjectCSV({
        subject,
        teacherUid: data.ownerUid || data.uid || user.uid || "",
        startDate, endDate
      });
    } catch (e) {
      console.error(e);
      alert("CSV 생성 실패: " + (e?.message || e));
    }
  });

  createBtn.addEventListener("click", async () => {
    let watchdog;
    try {
      if (!OPENAI_API_KEY) { alert("OpenAI API 키가 없습니다."); return; }
      createBtn.disabled = true;
      createBtn.textContent = data.assistantId ? "업데이트 중…" : "생성 중…";
      watchdog = setTimeout(() => toast("⏱️ 응답이 지연됩니다. 네트워크 상태를 확인하세요."), 60000);

      const model = String(modelDisplay || "gpt-4o-mini");

      // 1) 기존 VS 재사용 (없으면 새로 생성)
      let vectorStoreId = data.vectorStoreId || null;
      if (useRag) {
        if (vectorStoreId) {
          toast("기존 Vector Store 재사용…");
        } else {
          toast("Vector Store 생성 중…");
          const vs = await createVectorStore(`vs_${Date.now()}_${docSnap.id}`);
          vectorStoreId = vs.id;
        }

        // 2) 기존 VS 파일 목록 조회(파일명 매칭)
        const existing = await listVSFilesWithNames(vectorStoreId);
        const byName = new Map();
        existing.forEach(f => { if (f.filename) byName.set(f.filename, f); });

        // 3) 필요한 파일만 업로드/첨부, 기존은 스킵(또는 상태 확인만)
        let newlyOk = 0;
        const pendingFiles = [];

        const ragList = normalizeRagFiles(data);
        for (let i = 0; i < ragList.length; i++) {
          const m = ragList[i];
          const filename = m?.name || `document_${i+1}.pdf`;

          if (byName.has(filename)) {
            const f = byName.get(filename);
            // 이미 붙어 있다 → 상태만 확인
            try {
              if (f.status !== "completed") {
                await waitIndexed(vectorStoreId, f.id, { timeoutMs: 600000, intervalMs: 3000 });
              }
              newlyOk++;
            } catch (e) {
              console.warn("기존 파일 인덱싱 지연:", filename, e?.message);
              pendingFiles.push({ name: filename, fileId: f.id });
            }
            continue;
          }

          // 새 파일만 업로드/첨부
          try {
            const blob = await downloadPdfBlob(m);
            const file = new File([blob], filename, { type: "application/pdf" });
            toast(`파일 업로드 중… (${i+1}/${ragList.length})`);
            const up = await uploadFileToOpenAI(file);
            await attachToVS(vectorStoreId, up.id);
            try {
              await waitIndexed(vectorStoreId, up.id, { timeoutMs: 600000, intervalMs: 3000 });
              newlyOk++;
            } catch (e) {
              console.warn("RAG 파일 인덱싱 지연:", filename, e?.message);
              pendingFiles.push({ name: filename, fileId: up.id });
            }
          } catch (e) {
            console.warn("RAG 업로드 실패:", filename, e?.message || e);
          }
        }

        if (pendingFiles.length) {
          toast(`ⓘ ${pendingFiles.length}개 파일 인덱싱이 지연 중입니다. 완료되면 자동 반영돼요.`, 2600);
        } else if (newlyOk === 0) {
          // 모든 시도가 실패 → RAG 없이 진행
          vectorStoreId = null;
          toast("⚠️ RAG 인덱싱 실패 → RAG 없이 업데이트", 2200);
        }

        // Firestore에 VSID 저장(재사용 또는 신규)
        await updateDoc(doc(db, "chatbots", docSnap.id), {
          vectorStoreId: vectorStoreId || null
        });
      }

      // ✅ RAG 안내 여부는 이번 클릭의 useRag로만 판단
      const instructions = buildInstructions(description, !!useRag, useFewShot, examples);

      // 4) Assistant 업서트
      const assistant = await upsertAssistant({
        existingAssistantId: data.assistantId || null,
        model, name, instructions,
        vectorStoreId: useRag ? vectorStoreId : null,
        chatbotDocId: docSnap.id
      });

      // 5) Firestore 메타 갱신
      await updateDoc(doc(db, "chatbots", docSnap.id), {
        assistantId: assistant.id,
        assistantModelSnapshot: model,
        assistantCreatedAt: data.assistantCreatedAt || serverTimestamp(),
        assistantUpdatedAt: serverTimestamp(),
        ownerUid: data.ownerUid || user.uid // 누락 시 보강
      });

      toast("✅ 완료!");
      createBtn.textContent = "다시 생성/업데이트";
      studentBtn.disabled = false;
      studentBtn.title = "";

      try {
        localStorage.setItem("last_student_assistant", assistant.id);
        localStorage.setItem("last_student_doc", docSnap.id);
      } catch {}
    } catch (e) {
      console.error(e);
      alert("생성/업데이트 실패: " + (e?.message || e));
      createBtn.textContent = data.assistantId ? "다시 생성/업데이트" : "생성";
    } finally {
      createBtn.disabled = false;
    }
  });

  card.querySelector(".edit-btn").addEventListener("click", () => {
    window.location.href = `CreateChatbot.html?id=${encodeURIComponent(docSnap.id)}`;
  });

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

  // Storage 경로만 있는 링크는 클릭 시 URL 발급
  card.addEventListener("click", async (e)=>{
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
