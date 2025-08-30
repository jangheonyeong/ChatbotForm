// [src/ChatbotListMain.js] — 내 문서만 목록 + Assistant 생성/업데이트 + RAG 인덱싱 + 🗓️ 날짜 선택 모달
// ✅ 변경 핵심
// - 학생용 링크에 항상 ?id=<문서ID> 포함 (StudentChat이 최신 assistantId로 덮어쓰게)
// - 업서트 성공 후 data.assistantId 를 최신 assistant.id 로 갱신 (클릭 즉시 반영)
// - UI 라벨 "CSV 내보내기" → "대화 출력", 버튼 스타일은 CSS에서 개선
// - 대화 출력: student_conversations 기반으로 기간 내 메시지까지 포함해 추출 (KST 자정~자정 포함)
// - 🗓️ NEW: "대화 출력" 클릭 시 달력 모달에서 날짜를 선택(종료일 포함)

import { initializeApp, getApps } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore, collection, query, where, getDocs, deleteDoc, doc, updateDoc, serverTimestamp, Timestamp, orderBy
} from "firebase/firestore";
import { getStorage, ref as sRef, getBlob, getBytes, deleteObject, getDownloadURL } from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app = getApps()[0] || initializeApp(firebaseConfig); // ✅ 이미 초기화돼 있으면 재사용
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

/* ===== CSV Export (student_conversations 기반) ===== */
function yyyymmdd(d){
  const z = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}

// KST 자정~자정(포함) 범위를 UTC 시간으로 변환
function kstDayRangeInclusive(startY, startM, startD, endY, endM, endD) {
  const startUtc = new Date(Date.UTC(startY, startM - 1, startD, 15, 0, 0, 0));     // KST 00:00
  const endUtc   = new Date(Date.UTC(endY,   endM   - 1, endD, 14, 59, 59, 999));  // KST 23:59:59.999
  return { startUtc, endUtc };
}

function tsToKSTString(ts) {
  if (!ts) return "";
  const date = ts?.toDate?.() ? ts.toDate() : (ts instanceof Date ? ts : null);
  if (!date) return "";
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const z = n => String(n).padStart(2,"0");
  return `${kst.getFullYear()}-${z(kst.getMonth()+1)}-${z(kst.getDate())} ${z(kst.getHours())}:${z(kst.getMinutes())}:${z(kst.getSeconds())}`;
}

function toCSV(rows) {
  const header = [
    "conversationId","subject","assistantId","teacherUid","studentNickname",
    "createdAtConvKST","role","content","createdAtMsgKST"
  ];
  const esc = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      esc(r.conversationId), esc(r.subject), esc(r.assistantId), esc(r.teacherUid),
      esc(r.studentNickname), esc(r.createdAtConvKST), esc(r.role),
      esc(r.content), esc(r.createdAtMsgKST)
    ].join(","));
  }
  return lines.join("\r\n");
}

async function exportSubjectCSV_fromStudentConversations({
  subject, teacherUid, startStr, endStr
}) {
  // 1) 날짜 파싱 → KST 종일 범위(포함) → UTC
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const { startUtc, endUtc } = kstDayRangeInclusive(sy, sm, sd, ey, em, ed);

  // 2) 대화 목록 (교사+교과) 조회 — createdAt 범위는 메시지에서 필터링
  const convQ = query(
    collection(db, "student_conversations"),
    where("teacherUid", "==", teacherUid),
    where("subject", "==", subject)
  );
  const convSnap = await getDocs(convQ);

  const rows = [];

  // 3) 각 대화의 messages 하위컬렉션을 기간 필터 + 시간순 정렬로 조회
  for (const convDoc of convSnap.docs) {
    const conv = convDoc.data();
    const convId = convDoc.id;

    const msgsQ = query(
      collection(db, "student_conversations", convId, "messages"),
      where("createdAt", ">=", Timestamp.fromDate(startUtc)),
      where("createdAt", "<=", Timestamp.fromDate(endUtc)),
      orderBy("createdAt", "asc")
    );
    const msgsSnap = await getDocs(msgsQ);

    msgsSnap.forEach(m => {
      const d = m.data();
      rows.push({
        conversationId: convId,
        subject: conv.subject || "",
        assistantId: conv.assistantId || "",
        teacherUid: conv.teacherUid || "",
        studentNickname: conv.studentNickname || "",
        createdAtConvKST: tsToKSTString(conv.createdAt),
        role: d.role || "",
        content: String(d.content ?? "").replace(/\s+/g, " ").trim(),
        createdAtMsgKST: tsToKSTString(d.createdAt)
      });
    });
  }

  // 4) CSV 다운로드
  const csv = toCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const fname = `export_${subject}_${startStr}_${endStr}.csv`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: fname });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  if (rows.length === 0) {
    console.warn("[대화 출력] 선택한 조건에서 메시지가 0건입니다. (규칙/필터/기간 확인)");
  }
}

/* =========================
   🗓️ 날짜 선택 모달 (달력 UI)
   ========================= */
function openDateRangeModal({ startStr, endStr }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="대화 출력 기간 선택">
        <h3>대화 출력 기간 선택</h3>
        <p class="note">KST(한국 표준시) 기준 • 종료일 포함 • 자정~자정</p>

        <div class="date-grid">
          <label>
            시작일
            <input type="date" id="startDate">
          </label>
          <label>
            종료일
            <input type="date" id="endDate">
          </label>
        </div>

        <div class="error" id="dateError"></div>

        <div class="buttons">
          <button class="btn" id="cancelBtn">취소</button>
          <button class="btn btn-primary" id="okBtn">CSV 내보내기</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const startEl = overlay.querySelector("#startDate");
    const endEl   = overlay.querySelector("#endDate");
    const errEl   = overlay.querySelector("#dateError");
    const cancel  = overlay.querySelector("#cancelBtn");
    const ok      = overlay.querySelector("#okBtn");

    // 기본값
    startEl.value = startStr;
    endEl.value = endStr;

    // 포커스
    setTimeout(() => startEl.focus(), 0);

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    function validate() {
      const s = startEl.value;
      const e = endEl.value;
      if (!s || !e) {
        errEl.textContent = "시작일과 종료일을 모두 선택하세요.";
        return false;
      }
      const sd = new Date(`${s}T00:00:00`);
      const ed = new Date(`${e}T00:00:00`);
      if (sd.getTime() > ed.getTime()) {
        errEl.textContent = "시작일이 종료일보다 늦을 수 없습니다.";
        return false;
      }
      errEl.textContent = "";
      return true;
    }

    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => {
      if (!validate()) return;
      close({ startStr: startEl.value, endStr: endEl.value });
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter") ok.click();
    });
  });
}

/* ===== 메인 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    alert("로그인이 필요합니다.");
    const next = encodeURIComponent(location.href);                // ✅ 로그인 후 복귀
    window.location.href = `AfterLogIn.html?next=${next}`;
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

    <button class="export-btn" aria-label="대화 출력">대화 출력</button>

    <div class="card-buttons">
      <button class="create-btn">${data.assistantId ? "다시 생성/업데이트" : "생성"}</button>
      <button class="student-btn" ${data.assistantId ? "" : "disabled title='먼저 생성하세요'"}>학생용 링크</button>
      <button class="edit-btn">수정</button>
      <button class="delete-btn">삭제</button>
    </div>
  `;

  const createBtn  = card.querySelector(".create-btn");
  const studentBtn = card.querySelector(".student-btn");
  const exportBtn  = card.querySelector(".export-btn");

  // ✅ 학생용 링크: 문서 ID를 반드시 포함 + 호환을 위해 assistant 파라미터도 유지
  studentBtn.addEventListener("click", () => {
    const url = new URL("StudentChat.html", location.origin);
    url.searchParams.set("id", docSnap.id); // ★ 최신 assistantId를 보장하기 위한 핵심
    if (data.assistantId) {
      url.searchParams.set("assistant", data.assistantId);   // 호환용(기존 유지)
      url.searchParams.set("assistantId", data.assistantId); // 호환용(기존 유지)
    }
    url.searchParams.set("name", name || "학생용 챗봇");
    url.searchParams.set("subject", subject || "");
    url.searchParams.set("model", String(modelDisplay || ""));
    url.searchParams.set("teacherUid", data.ownerUid || data.uid || user.uid || "");
    window.open(url.toString(), "_blank", "noopener");
  });

  // 🗓️ 교과별 CSV 내보내기 (달력 모달, '종료일 포함')
  exportBtn.addEventListener("click", async () => {
    try {
      if (!subject || subject === "(교과 없음)") {
        alert("교과 정보가 없어 대화를 출력할 수 없습니다.");
        return;
      }
      // 기본 기간: 최근 7일 ~ 오늘 (KST 로컬 환경 가정)
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 7);
      const defaultEnd = new Date();

      const picked = await openDateRangeModal({
        startStr: yyyymmdd(defaultStart),
        endStr: yyyymmdd(defaultEnd)
      });
      if (!picked) return;

      toast("대화 출력 준비 중…");
      await exportSubjectCSV_fromStudentConversations({
        subject,
        teacherUid: data.ownerUid || data.uid || user.uid || "",
        startStr: picked.startStr,
        endStr: picked.endStr
      });
      toast("📄 대화 출력(CSV) 완료");
    } catch (e) {
      console.error(e);
      alert("대화 출력 실패: " + (e?.message || e));
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
          vectorStoreId = null;
          toast("⚠️ RAG 인덱싱 실패 → RAG 없이 업데이트", 2200);
        }

        await updateDoc(doc(db, "chatbots", docSnap.id), {
          vectorStoreId: vectorStoreId || null
        });
      }

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

      // ✅ 로컬 카드 상태도 즉시 갱신 (바로 이어서 '학생용 링크' 눌러도 새 ID 사용)
      data.assistantId = assistant.id;

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
      // eslint-disable-next-line no-unused-expressions
      watchdog && clearTimeout(watchdog);
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
