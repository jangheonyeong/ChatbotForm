// [src/StudentChatMain.js] — 첨부 썸네일/라이트박스 + Markdown/수식 렌더링 + Firestore 롱폴링 안정화

import { initializeApp, getApps } from "firebase/app";
import {
  initializeFirestore, doc, getDoc,
  collection, addDoc, setDoc, serverTimestamp,
  getDocs, query, where
} from "firebase/firestore";
import {
  getAuth,
  onAuthStateChanged,
  updateCurrentUser,
} from "firebase/auth";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== 상수 ===== */
const CONV_COL = "student_conversations";
const MSGS_SUB = "messages";

/* ===== Firebase init ===== */
const studentApp =
  getApps().find(a => a.name === "student-app") ||
  initializeApp(firebaseConfig, "student-app");
const db = initializeFirestore(studentApp, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
});

const defaultApp =
  getApps().find(a => a.name === "[DEFAULT]") ||
  initializeApp(firebaseConfig);
const dbPrimary = initializeFirestore(defaultApp, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
});

const authStudent = getAuth(studentApp);
const authDefault = getAuth(defaultApp);

/* ===== DOM ===== */
const botTitle = document.getElementById("botTitle");
const subjectLabel = document.getElementById("subjectLabel");
const chatWindow = document.getElementById("chatWindow");
const composer = document.getElementById("composer");
const userMessageEl = document.getElementById("userMessage");
const sendBtn = document.getElementById("sendBtn");
const resetThreadBtn = document.getElementById("resetThreadBtn");

// 교사 전용 UI + 힌트 버튼
const issueCodeBtn = document.getElementById("issueCodeBtn");
const codePanel = document.getElementById("codePanel");
const codeText = document.getElementById("codeText");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const hintButtonsWrap = document.getElementById("hintButtons");
const hintBtn1 = document.getElementById("hintBtn1");
const hintBtn2 = document.getElementById("hintBtn2");
const hintBtn3 = document.getElementById("hintBtn3");

// 첨부 DOM
const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
const fileChips = document.getElementById("fileChips");

// 라이트박스
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightboxImg");
const lightboxClose = document.getElementById("lightboxClose");

/* ===== OpenAI ===== */
const OPENAI_BASE = "https://api.openai.com/v1";

// Vite(.env) → window.__ENV → localStorage
const OPENAI_API_KEY =
  ((typeof import.meta !== "undefined") && import.meta.env && import.meta.env.VITE_OPENAI_API_KEY) ||
  (window.__ENV && window.__ENV.OPENAI_API_KEY) ||
  localStorage.getItem("OPENAI_API_KEY") ||
  "";

function assertApiKey() {
  if (!OPENAI_API_KEY) {
    alert([
      "OpenAI API 키가 설정되어 있지 않습니다.",
      "설정 방법:",
      "1) 루트 .env: VITE_OPENAI_API_KEY=sk-... 저장 후 `npm run dev`",
      "2) 개발용: env.local.js에서 window.__ENV.OPENAI_API_KEY 지정",
      "3) 임시: localStorage.setItem('OPENAI_API_KEY','sk-...')",
    ].join("\n"));
    throw new Error("Missing OPENAI key");
  }
}

async function openaiFetch(path, { method = "GET", headers = {}, body } = {}) {
  assertApiKey();
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

/* ===== Assistants v2 helpers ===== */
const createThread = () => openaiFetch("/threads", { method: "POST", body: {} });

async function addMessageRich(threadId, text, uploaded = []) {
  const content = [];
  const trimmed = (text || "").trim();

  if (trimmed) content.push({ type: "text", text: trimmed });

  const attachments = [];
  for (const u of uploaded) {
    if ((u.mime || "").startsWith("image/")) {
      content.push({ type: "image_file", image_file: { file_id: u.id } });
    } else {
      attachments.push({ file_id: u.id, tools: [{ type: "file_search" }] });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "첨부 파일을 참고해 주세요." });

  return openaiFetch(`/threads/${threadId}/messages`, {
    method: "POST",
    body: { role: "user", content, ...(attachments.length ? { attachments } : {}) }
  });
}

const createRun = (threadId, assistantId) =>
  openaiFetch(`/threads/${threadId}/runs`, { method: "POST", body: { assistant_id: assistantId }});
const getRun = (threadId, runId) =>
  openaiFetch(`/threads/${threadId}/runs/${runId}`);
const listMessages = (threadId) =>
  openaiFetch(`/threads/${threadId}/messages?order=asc&limit=100`);

/* ===== Utils ===== */
function qsParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(str = "") {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function addMsgEl(role, html, {asHtml=false} = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = asHtml ? html : escapeHtml(html);
  wrap.appendChild(bubble);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}
function renderBubble(role, text) { addMsgEl(role, text); }

/* 타자 효과 */
async function renderTypewriter(role, fullText, speed = 16) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = "";
  wrap.appendChild(bubble);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  for (const ch of fullText) {
    bubble.textContent += ch;
    if (speed) await sleep(speed);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }
  return bubble;
}

/* 생각중… */
function renderTyping(show) {
  let el = document.getElementById("typing");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "typing";
      el.className = "msg assistant";
      el.innerHTML =
        `<div class="bubble"><span class="typing">
           <span class="dot"></span><span class="dot"></span><span class="dot"></span>
         </span></div>`;
      chatWindow.appendChild(el);
    }
  } else {
    if (el) el.remove();
  }
  chatWindow.scrollTop = chatWindow.scrollHeight;
}
function setSending(on) {
  sendBtn.disabled = on;
  userMessageEl.disabled = on;
  attachBtn.disabled = on;
}

/* ===== Student ID (닉네임 대신 사용) ===== */
const LAST_STUDENT_ID_KEY = "last_student_id";
function getCurrentStudentId() {
  return localStorage.getItem(LAST_STUDENT_ID_KEY) || "손님";
}

/* ===== Thread/Conversation ===== */
function threadKey(aid, studentId) { return `thread:${aid}:${studentId || "guest"}`; }
async function getOrCreateThread(aid, studentId) {
  const key = threadKey(aid, studentId);
  let tid = localStorage.getItem(key);
  if (tid) return tid;
  const t = await createThread();
  tid = t.id;
  localStorage.setItem(key, tid);
  return tid;
}
function resetThread(aid, studentId) { localStorage.removeItem(threadKey(aid, studentId)); }
function convKey(aid, studentId) { return `conv:${aid}:${studentId || "guest"}`; }

let assistantId = null;
let chatbotDocId = null;
let teacherUid = null;
let subjectStr = "";
let modelStr = "";
let conversationId = null;
let hint1 = "";
let hint2 = "";
let hint3 = "";

/* ===== Auth ===== */
function waitForAuthUser(auth, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(auth.currentUser || null);
    }, timeoutMs);
    const unsub = onAuthStateChanged(auth, (u) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(u || null);
    });
  });
}
async function ensureAuth() {
  let u = authDefault.currentUser;
  if (!u) u = await waitForAuthUser(authDefault, 8000);

  if (!u) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return null;
  }

  try { await updateCurrentUser(authStudent, u); }
  catch (e) { console.warn("[auth] updateCurrentUser(student-app) 실패:", e?.message || e); }
  return u;
}

/* ===== 🔎 역추적 보강: code/assistant/id → teacherUid/chatbotDocId 채우기 ===== */
async function hydrateFromCodeOrAssistant() {
  // 1) ?code=###### 로 들어온 경우
  const codeParam = qsParam("code");
  if (codeParam) {
    try {
      const qy = query(
        collection(dbPrimary, "access_codes"),
        where("code", "==", codeParam),
        where("active", "==", true)
      );
      const snap = await getDocs(qy);
      if (!snap.empty) {
        const ac = snap.docs[0].data() || {};
        assistantId  = ac.assistantId  || assistantId;
        chatbotDocId = ac.chatbotDocId || chatbotDocId;
        teacherUid   = ac.teacherUid   || teacherUid;
      }
    } catch (e) {
      console.warn("[hydrate] access_codes 조회 실패:", e?.message || e);
    }
  }

  // 2) assistantId만 있는 경우: chatbots에서 소유자 역추적
  if (!teacherUid && assistantId) {
    try {
      const qy = query(collection(dbPrimary, "chatbots"), where("assistantId", "==", assistantId));
      const ss = await getDocs(qy);
      if (!ss.empty) {
        const d = ss.docs[0].data() || {};
        teacherUid   = d.ownerUid || d.uid || teacherUid;
        chatbotDocId = chatbotDocId || ss.docs[0].id;
      }
    } catch (e) {
      console.warn("[hydrate] chatbots by assistantId 실패:", e?.message || e);
    }
  }

  // 3) chatbotDocId만 있는 경우
  if (!teacherUid && chatbotDocId) {
    try {
      const s = await getDoc(doc(dbPrimary, "chatbots", chatbotDocId));
      if (s.exists()) {
        const d = s.data() || {};
        teacherUid = d.ownerUid || d.uid || teacherUid;
      }
    } catch (e) {
      console.warn("[hydrate] chatbots by id 실패:", e?.message || e);
    }
  }
}

/* ===== 부모 대화 문서 보장 ===== */
async function ensureConversation() {
  const u = await ensureAuth();
  if (!u) return null;

  const studentId = getCurrentStudentId();
  const key = convKey(assistantId, studentId);
  let convId = localStorage.getItem(key);

  // 규칙 통과용 payload (모든 필드 string 타입 보장, createdBy는 빈 문자열이라도 null 금지)
  const buildPayload = () => ({
    assistantId: String(assistantId || ""),
    subject: String(subjectStr || ""),
    model: String(modelStr || ""),
    teacherUid: String(teacherUid || ""),
    chatbotDocId: String(chatbotDocId || ""),
    studentNickname: studentId,
    createdBy: String(authStudent.currentUser?.uid || authDefault.currentUser?.uid || ""),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 저장된 convId가 있으면 실존 확인
  if (convId) {
    try {
      const ref = doc(db, CONV_COL, convId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        try { await setDoc(ref, { updatedAt: serverTimestamp() }, { merge: true }); } catch {}
        conversationId = convId;
        return convId;
      }
    } catch {}
    // 실존하지 않으면 키 폐기
    try { localStorage.removeItem(key); } catch {}
    convId = null;
  }

  // teacherUid가 비어 있으면 저장 직전에 보강
  if (!teacherUid) { await hydrateFromCodeOrAssistant(); }

  // 새 부모 문서 생성
  const refNew = await addDoc(collection(db, CONV_COL), buildPayload());
  convId = refNew.id;
  try { localStorage.setItem(key, convId); } catch {}
  conversationId = convId;
  return convId;
}

async function logMessage(role, content) {
  await ensureAuth();
  if (!conversationId) await ensureConversation();
  try {
    await addDoc(collection(db, `${CONV_COL}/${conversationId}/${MSGS_SUB}`), {
      role, content, createdAt: serverTimestamp()
    });
    await setDoc(doc(db, CONV_COL, conversationId), { updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn("logMessage failed:", e?.message || e);
  }
}

/* ===== Chatbot 메타 ===== */
async function loadChatbotMeta() {
  chatbotDocId = qsParam("id");
  assistantId = qsParam("assistant") || qsParam("assistantId");

  const qName = qsParam("name");
  const qSubject = qsParam("subject");
  const qModel = qsParam("model");
  const qTeacherUid = qsParam("teacherUid");

  if (qName)    botTitle.textContent = qName;
  if (qSubject) subjectLabel.textContent = qSubject ? `교과: ${qSubject}` : "";
  if (qTeacherUid) teacherUid = qTeacherUid;

  subjectStr = qSubject || "";
  modelStr = qModel || "";

  if (chatbotDocId) {
    try {
      const snap = await getDoc(doc(dbPrimary, "chatbots", chatbotDocId));
      if (snap.exists()) {
        const data = snap.data() || {};
        assistantId = data.assistantId || assistantId;
        if (!qName && data.name) botTitle.textContent = data.name;
        if (!qSubject && data.subject) {
          subjectStr = data.subject;
          subjectLabel.textContent = `교과: ${data.subject}`;
        }
        if (!qModel && data.assistantModelSnapshot) modelStr = data.assistantModelSnapshot;
        if (!teacherUid && (data.ownerUid || data.uid)) teacherUid = data.ownerUid || data.uid;

        // 힌트 필드 로드
        hint1 = data.hint1 || "";
        hint2 = data.hint2 || "";
        hint3 = data.hint3 || "";
      }
    } catch (err) {
      console.warn("Firestore 읽기 실패(무시 가능):", err?.message || err);
    }
  }

  if (!assistantId) {
    const lastAid = localStorage.getItem("last_student_assistant");
    const lastDoc = localStorage.getItem("last_student_doc");
    if (lastAid) {
      assistantId = lastAid;
      if (lastDoc && !chatbotDocId) chatbotDocId = lastDoc;
    }
  }

  // ✅ 어떤 경로로 들어와도 teacherUid 최대한 채우기
  await hydrateFromCodeOrAssistant();

  if (!assistantId) {
    throw new Error("assistantId가 없습니다. URL에 ?assistant=asst_xxx 또는 ?code=###### 또는 ?id=<문서ID> 중 하나가 필요합니다.");
  }

  // 수학 과목인 경우에만 힌트 버튼 표시
  try {
    const subj = (subjectStr || "").trim();
    const hasAnyHint = !!(hint1 || hint2 || hint3);
    if (subj === "수학" && hasAnyHint && hintButtonsWrap) {
      hintButtonsWrap.style.display = "flex";
    } else if (hintButtonsWrap) {
      hintButtonsWrap.style.display = "none";
    }
  } catch {}
}

/* ===== 파일 첨부 ===== */
let pendingFiles = []; // File[]

function bytesToMB(n) { return (n / (1024 * 1024)).toFixed(1) + "MB"; }

function renderChips() {
  if (!fileChips) return;
  fileChips.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.title = `${f.type || "unknown"} • ${bytesToMB(f.size)}`;
    chip.innerHTML = `${escapeHtml(f.name)} <button type="button" class="chip-x" data-i="${i}">×</button>`;
    fileChips.appendChild(chip);
  });
  fileChips.querySelectorAll(".chip-x").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.getAttribute("data-i"));
      if (!Number.isNaN(idx)) {
        pendingFiles.splice(idx, 1);
        renderChips();
      }
    });
  });
}

attachBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", (e) => {
  const list = Array.from(e.target.files || []);
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { alert(`25MB 초과 파일 제외: ${f.name}`); continue; }
    pendingFiles.push(f);
  }
  fileInput.value = "";
  renderChips();
});

/* 드래그&드롭 */
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; composer.classList.add("dragging"); });
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth===0) composer.classList.remove("dragging"); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; composer.classList.remove("dragging");
  const list = Array.from(e.dataTransfer?.files || []);
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { alert(`25MB 초과 파일 제외: ${f.name}`); continue; }
    pendingFiles.push(f);
  }
  renderChips();
});

/* OpenAI Files 업로드 → [{id, mime}] */
async function uploadFilesForAssistants(files) {
  const out = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append("purpose", "assistants");
    fd.append("file", f, f.name);
    const j = await openaiFetch("/files", { method: "POST", body: fd });
    out.push({ id: j.id, mime: f.type || "" });
  }
  return out;
}

/* ===== 첨부 미리보기(버블 내) ===== */
function fileExt(name="") {
  const m = name.split(".");
  return m.length > 1 ? m.pop().toUpperCase() : "";
}
function createObjectLink(file) {
  const url = URL.createObjectURL(file);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
function renderUserWithAttachments(text, files=[]) {
  // 버블
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // 텍스트
  if (text && text.trim()) {
    const p = document.createElement("div");
    p.textContent = text;
    bubble.appendChild(p);
  }

  // 첨부 그리드
  if (files.length) {
    const grid = document.createElement("div");
    grid.className = "attachments";

    files.forEach(file => {
      const { url } = createObjectLink(file);

      if ((file.type || "").startsWith("image/")) {
        const item = document.createElement("div");
        item.className = "att image";
        item.innerHTML = `
          <a href="${url}" class="lightbox" data-src="${url}">
            <img src="${url}" alt="${escapeHtml(file.name)}" />
            <div class="caption">${escapeHtml(file.name)}</div>
          </a>`;
        grid.appendChild(item);
      } else {
        const item = document.createElement("div");
        item.className = "att file";
        item.innerHTML = `
          <a href="${url}" target="_blank" rel="noopener" download="${escapeHtml(file.name)}">
            <div class="row">
              <span class="icon">📄</span>
              <span class="meta">
                <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
                <span class="size">${fileExt(file.name)} · ${bytesToMB(file.size)}</span>
              </span>
            </div>
          </a>`;
        grid.appendChild(item);
      }
    });

    bubble.appendChild(grid);
  }

  wrap.appendChild(bubble);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* ===== 라이트박스 ===== */
function openLightbox(src, alt="첨부 이미지") {
  if (!src) return;
  lightboxImg.src = src;
  lightboxImg.alt = alt;
  lightbox.classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  lightbox.classList.remove("show");
  lightboxImg.removeAttribute("src");
  document.body.style.overflow = "";
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.lightbox");
  if (a) {
    e.preventDefault();
    openLightbox(a.getAttribute("data-src"), a.querySelector("img")?.alt || "");
  }
});
lightbox?.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
lightboxClose?.addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lightbox.classList.contains("show")) closeLightbox(); });

/* ===== Markdown/수식 렌더링 ===== */
function cleanCitations(raw="") {
  //  같은 특수 각주 제거
  return raw
    .replace(/【[^】]*?†[^】]*】/g, "")
    .replace(/【[^】]*?source[^】]*】/gi, "");
}
function mdToHtml(md="") {
  const safe = (window.DOMPurify?.sanitize ?? (x=>x));
  const parsed = window.marked?.parse ? window.marked.parse(md, { breaks:true, gfm:true }) : md;
  return safe(parsed);
}
async function renderAssistantMarkdownSmart(text) {
  const cleaned = cleanCitations(text || "");
  const bubble = await renderTypewriter("assistant", cleaned, 16);
  const html = `<div class="md">${mdToHtml(cleaned)}</div>`;
  bubble.innerHTML = html;
  try { await window.MathJax?.typesetPromise?.([bubble]); } catch {}
}

/* ===== 채팅 플로우 ===== */
async function sendMessageFlow(text) {
  const studentId = getCurrentStudentId();
  const threadId = await getOrCreateThread(assistantId, studentId);

  await ensureConversation();

  // 사용자 메시지 + 첨부 표시
  const filesSnapshot = pendingFiles.slice();
  let userShown = text;
  if (filesSnapshot.length > 0) {
    const names = filesSnapshot.map(f => f.name).join(", ");
    userShown = text ? `${text}\n\n(첨부: ${names})` : `(첨부: ${names})`;
  }
  await logMessage("user", userShown);
  renderUserWithAttachments(text, filesSnapshot);

  // 업로드 후 전송
  const uploaded = filesSnapshot.length ? await uploadFilesForAssistants(filesSnapshot) : [];
  pendingFiles = [];
  renderChips();

  await addMessageRich(threadId, text, uploaded);
  const run = await createRun(threadId, assistantId);

  let status = run.status;
  let last = 0;
  renderTyping(true);
  while (status === "queued" || status === "in_progress" || status === "cancelling") {
    await sleep(Math.min(500 + last * 300, 2500));
    last++;
    const r2 = await getRun(threadId, run.id);
    status = r2.status;
  }
  renderTyping(false);

  if (status !== "completed") {
    const msg = `처리 중 문제가 발생했습니다. (상태: ${status})`;
    renderBubble("assistant", msg);
    await logMessage("system", msg);
    return;
  }

  const msgs = await listMessages(threadId);
  const all = msgs.data || [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.role !== "assistant") continue;
    const txtPart = (m.content || []).find(p => p.type === "text");
    const textValue = txtPart?.text?.value || "(빈 응답)";
    await renderAssistantMarkdownSmart(textValue);
    await logMessage("assistant", cleanCitations(textValue));
    break;
  }
}

/* ===== 힌트 로그 기록 ===== */
async function logHintClick(hintKey, content) {
  try {
    await ensureConversation();
    if (!conversationId) return;
    await addDoc(collection(db, `${CONV_COL}/${conversationId}/hintlogs`), {
      hintKey,
      content,
      clickedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn("logHintClick failed:", e?.message || e);
  }
}

/* ===== 힌트 클릭 처리 ===== */
async function handleHintClick(hintKey) {
  let content = "";
  if (hintKey === "hint1") content = hint1;
  else if (hintKey === "hint2") content = hint2;
  else if (hintKey === "hint3") content = hint3;

  content = (content || "").trim();
  if (!content) return;

  try {
    // 힌트를 assistant 메시지로 표시
    await renderAssistantMarkdownSmart(content);
    await logMessage("assistant", cleanCitations(content));
    // 힌트 클릭 로그 저장
    await logHintClick(hintKey, content);
  } catch (e) {
    console.error("handleHintClick:", e?.message || e);
  }
}

/* ===== 권한/코드 발급 ===== */
const ADMIN_EMAIL_WHITELIST = ["wkdgjsdud@snu.ac.kr", "janghy0412@gmail.com"];
const WL = ADMIN_EMAIL_WHITELIST.map(e => e.trim().toLowerCase());

async function waitClaimsPropagation(user, maxMs = 15000) {
  if (!user) return null;
  const started = Date.now();
  let delay = 500;
  let lastClaims = null;
  while (Date.now() - started < maxMs) {
    try {
      await user.getIdToken(true);
      const r = await user.getIdTokenResult();
      lastClaims = r?.claims || null;
      if (lastClaims?.teacher === true || lastClaims?.admin === true) return lastClaims;
    } catch {}
    await sleep(delay);
    delay = Math.min(delay * 1.6, 2500);
  }
  return lastClaims;
}

async function isTeacherAuthorized(user) {
  if (!user) return false;
  const emailNorm = (user.email || "").trim().toLowerCase();
  if (emailNorm && WL.includes(emailNorm)) return true;
  try {
    const token = await user.getIdTokenResult();
    if (token?.claims?.teacher === true || token?.claims?.admin === true) return true; // ✅ admin 경로 수정
    if (user.uid && user.uid === (teacherUid || "")) return true;

    try {
      const tSnap = await getDoc(doc(dbPrimary, "teachers", user.uid));
      if (tSnap.exists()) {
        const t = tSnap.data() || {};
        const positive =
          t.enabled === true || t.approved === true || t.active === true ||
          t.isActive === true || t.role === "teacher" || t.role === "admin";
        if (positive) {
          const claims = await waitClaimsPropagation(user, 15000);
          if (claims?.teacher === true || claims?.admin === true) return true;
        }
      }
    } catch {}
  } catch {}
  return false;
}

function toggleTeacherUI(isTeacher) {
  if (isTeacher) {
    issueCodeBtn.style.display = "inline-block";
    let badge = document.getElementById("teacherBadge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "teacherBadge";
      badge.className = "badge teacher";
      badge.textContent = "교사 모드";
      document.querySelector(".subtitle")?.appendChild(badge);
    }
  } else {
    issueCodeBtn.style.display = "none";
    document.getElementById("teacherBadge")?.remove();
    codePanel.style.display = "none";
  }
}

function randomNumericCode(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}
async function isCodeUnique(code) {
  const qy = query(
    collection(dbPrimary, "access_codes"),
    where("code", "==", code),
    where("active", "==", true)
  );
  const snap = await getDocs(qy);
  return snap.empty;
}
async function createUniqueCode() {
  for (let i = 0; i < 10; i++) {
    const c = randomNumericCode(6);
    if (await isCodeUnique(c)) return c;
  }
  throw new Error("코드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.");
}

async function generateAccessCode() {
  const u = authDefault.currentUser;
  if (!u) { alert("코드 발급은 교사 전용입니다. 로그인해 주세요."); return; }

  await waitClaimsPropagation(u, 3000);
  const finalToken = await u.getIdTokenResult();

  const hasTeacher = finalToken?.claims?.teacher === true || finalToken?.claims?.admin === true;
  const emailNorm = (u.email || "").trim().toLowerCase();
  const emailWhitelisted = !!(emailNorm && WL.includes(emailNorm));
  const isOwner = (u.uid || "") === (teacherUid || "");

  if (!hasTeacher && !emailWhitelisted && !isOwner) {
    alert("코드 발급 권한이 없습니다. (교사 클레임/화이트리스트/소유자 중 하나 필요)");
    return;
  }

  const code = await createUniqueCode();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const payload = {
    code, active: true,
    assistantId: assistantId || "", chatbotDocId: chatbotDocId || "",
    teacherUid: u.uid, teacherEmail: u.email || "",
    createdAt: serverTimestamp(), expiresAt: expires
  };
  await addDoc(collection(dbPrimary, "access_codes"), payload);

  codeText.value = code;
  codePanel.style.display = "flex";
  try {
    await navigator.clipboard.writeText(code);
    renderBubble("assistant", `코드를 발급하고 클립보드에 복사했어요: ${code} (24시간 유효)`);
  } catch {
    renderBubble("assistant", `코드를 발급했어요: ${code} (복사 버튼을 눌러 복사하세요)`);
  }
}

/* ===== Auth 상태 반영 ===== */
onAuthStateChanged(authDefault, async (user) => {
  if (user) await waitClaimsPropagation(user, 15000);
  const ok = await isTeacherAuthorized(user);
  toggleTeacherUI(ok);
});

/* ===== Init ===== */
(async function init() {
  try {
    getCurrentStudentId();
    const u = await ensureAuth();
    if (!u) return;

    await loadChatbotMeta();
    renderBubble("assistant", "안녕하세요! 질문을 입력하고 필요하면 PDF/이미지를 📎로 첨부해 주세요.");
  } catch (err) {
    console.error(err);
    renderBubble("assistant", `초기화 오류: ${err?.message || err}`);
    setSending(true);
  }
})();

/* ===== 전송 ===== */
composer?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = userMessageEl.value.trim();
  if (!text && pendingFiles.length === 0) return;

  userMessageEl.value = "";
  setSending(true);
  try { await sendMessageFlow(text); }
  catch (err) { console.error(err); renderBubble("assistant", `오류: ${err?.message || err}`); }
  finally { setSending(false); }
});

/* Enter 전송 */
userMessageEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer?.requestSubmit();
  }
});

/* 리셋 */
resetThreadBtn?.addEventListener("click", () => {
  const studentId = getCurrentStudentId();
  resetThread(assistantId, studentId);
  renderBubble("assistant", "대화를 새로 시작합니다. (이전 맥락은 초기화됨)");
});

/* 버튼 바인딩 */
issueCodeBtn?.addEventListener("click", async () => {
  issueCodeBtn.disabled = true;
  try { await generateAccessCode(); }
  catch (e) { console.error(e); alert(e?.message || "코드 발급 중 오류가 발생했습니다."); }
  finally { issueCodeBtn.disabled = false; }
});
copyCodeBtn?.addEventListener("click", async () => {
  const v = codeText.value?.trim();
  if (!v) return;
  try { await navigator.clipboard.writeText(v); renderBubble("assistant", "코드를 클립보드에 복사했어요."); }
  catch { alert("복사에 실패했습니다. 수동으로 복사해 주세요."); }
});

// 힌트 버튼 클릭 바인딩
hintBtn1?.addEventListener("click", () => handleHintClick("hint1"));
hintBtn2?.addEventListener("click", () => handleHintClick("hint2"));
hintBtn3?.addEventListener("click", () => handleHintClick("hint3"));
