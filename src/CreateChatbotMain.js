// ─────────────────────────────────────────────────────────────
// Firebase + OpenAI Responses + File Search (Vector Store)
// 저장 버튼 → Firestore 저장/수정
// + 저장된 PDF/미저장(선택만 한) PDF 모두 목록 노출 & 개별 삭제
// + 미저장 PDF도 클릭(Blob URL)으로 미리보기
// + 저장 직후 중복 렌더링 방지(선택본 초기화 + 파일명 기준 중복 숨김)
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore, collection, addDoc, updateDoc, getDoc, doc, serverTimestamp
} from "firebase/firestore";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";

// ===== marked 전역 옵션: 줄바꿈/표/리스트 등 GFM 스타일 활성화 =====
if (window.marked) {
  window.marked.setOptions({
    gfm: true,
    breaks: true,         // 단일 개행을 <br>로 반영
    headerIds: false,
    mangle: false,
    smartypants: true
  });
}

const appFB = initializeApp(firebaseConfig);
const auth = getAuth(appFB);
const db = getFirestore(appFB);
const storage = getStorage(appFB);
let currentUser = null;
onAuthStateChanged(auth, (u) => { currentUser = u || null; });

// ===== OpenAI =====
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const OPENAI_BASE = "https://api.openai.com/v1";

let vectorStoreId = null;
let isRagReady = false;

// 사용자가 방금 선택(미저장)한 파일들
let selectedFiles = [];
// 미저장 파일용 Blob URL 관리
let selectedFileObjectUrls = [];

// 편집 모드에서 불러온 "저장된" 파일들 (Firestore 보관본)
let savedRagFiles = []; // [{name,url,path}]

// 업로드/재첨부 상태(중복 인덱싱 방지)
const uploadedByFingerprint = new Map();
const attachedFileIds = new Set();
const makeFingerprint = (file) => `${file.name}:${file.size}:${file.lastModified}`;

// 공통 fetch
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
    throw new Error(`HTTP ${res.status} ${detail}`);
  }
  return res.json();
}

// 상태 뱃지
function setRagStatus(state, text) {
  const el = document.getElementById("ragStatus");
  el.classList.remove("ready", "busy", "error");
  if (state) el.classList.add(state);
  el.querySelector(".text").textContent = text;
}

// [RAG] Vector Store
async function ensureVectorStore() {
  if (vectorStoreId) return vectorStoreId;
  const data = await openaiFetch("/vector_stores", {
    method: "POST",
    body: { name: `vs_${Date.now()}`, expires_after: { anchor: "last_active_at", days: 7 } }
  });
  vectorStoreId = data.id;
  return vectorStoreId;
}
async function uploadFileToOpenAI(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", "assistants");
  return openaiFetch("/files", { method: "POST", body: form });
}
async function attachToVS(vsId, fileId) {
  return openaiFetch(`/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });
}
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

// FEW-SHOT
function parseFewShot(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  const qaMatch = text.match(/^\s*(?:Q|질문)\s*:\s*([\s\S]+?)\n\s*(?:A|답|답변)\s*:\s*([\s\S]+)$/i);
  if (qaMatch) return { user: qaMatch[1].trim(), assistant: qaMatch[2].trim() };

  const SEPS = ["→", "->", "=>", "⇒", "||", "|", "—", ":"];
  for (const s of SEPS) {
    const idx = text.indexOf(s);
    if (idx !== -1) {
      const left = text.slice(0, idx).trim();
      const right = text.slice(idx + s.length).trim();
      if (left) return { user: left, assistant: right };
    }
  }
  const parts = text.split(/\n\s*\n/);
  if (parts.length >= 2) return { user: parts[0].trim(), assistant: parts.slice(1).join("\n").trim() };
  return { user: text, assistant: "" };
}
function isUsefulFewShot(ex) {
  const u = (ex?.user || "").trim();
  const a = (ex?.assistant || "").trim();
  if (!u) return false;
  if (a && a.length < 8) return false;
  return true;
}
function buildInputString({ systemPrompt, fewShots, userMessage }) {
  let s = "";
  if (systemPrompt?.trim()) s += `System:\n${systemPrompt.trim()}\n\n`;
  if (Array.isArray(fewShots) && fewShots.length) {
    s += "Examples:\n";
    fewShots.forEach(({ user, assistant }) => {
      if (user) s += `User: ${user}\n`;
      if (assistant) s += `Assistant: ${assistant}\n`;
      s += "\n";
    });
  }
  s += `User: ${userMessage}\nAssistant:`;
  return s;
}

// Chat
async function askWithFileSearch({
  model = "gpt-4o-mini",
  systemPrompt,
  fewShots = [],
  userMessage,
  vsId,
  selfConsistency = false,
  samples = 3,
  temperature = 0.7
}) {
  const genericGuard = `
한국어로 답하세요. 질문을 되묻는 안내 멘트만 하지 말고, 먼저 핵심 답을 3–6문장으로 제시하세요.
금지 문구: "무엇을 도와드릴까요", "어떤 도움이 필요하신가요", "어떤 점이 궁금하신가요" 등.`.trim();

  const ragGuide = vsId ? `
업로드된 파일이 도움이 될 때만 file_search를 사용하세요. 질문이 파일과 무관하면 일반 지식으로도 충분히 답하세요.`.trim() : "";

  const mergedSystem = [systemPrompt || "", genericGuard, ragGuide].filter(Boolean).join("\n\n");
  const input = buildInputString({ systemPrompt: mergedSystem, fewShots, userMessage });

  const tools = vsId ? [{ type: "file_search", vector_store_ids: [vsId] }] : undefined;

  const resp = await openaiFetch("/responses", {
    method: "POST",
    body: { model, input, ...(tools ? { tools } : {}), temperature }
  });
  return extractAssistantText(resp) || "[빈 응답]";
}
function extractAssistantText(resp) {
  if (resp?.output_text && resp.output_text.trim()) return resp.output_text.trim();
  let parts = [];
  if (Array.isArray(resp?.output)) {
    for (const o of resp.output) {
      const content = o?.content || [];
      for (const c of content) {
        if (c?.type === "output_text" && c?.text?.value) parts.push(String(c.text.value));
        else if (typeof c?.text === "string") parts.push(c.text);
      }
      if (!parts.length && Array.isArray(o?.suggested_replies) && o.suggested_replies.length) {
        const t = o.suggested_replies[0]?.text;
        if (t) parts.push(t);
      }
    }
  }
  return parts.join("\n").trim();
}

// ---------- Markdown & Math helpers ----------
function sanitizeHTML(html) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // 위험 태그 제거
    doc.querySelectorAll("script, style, iframe, object, embed").forEach(el => el.remove());

    // 위험 속성 제거
    const all = doc.querySelectorAll("*");
    all.forEach(el => {
      [...el.attributes].forEach(attr => {
        const n = attr.name.toLowerCase();
        const v = String(attr.value || "");
        if (n.startsWith("on")) el.removeAttribute(attr.name);
        if ((n === "href" || n === "src") && /^javascript:/i.test(v)) el.removeAttribute(attr.name);
      });
    });
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
function renderMarkdown(mdText) {
  const raw = String(mdText || "");
  const html = (window.marked ? window.marked.parse(raw) : raw);
  return sanitizeHTML(html);
}
function enhanceLinks(container) {
  container.querySelectorAll("a[href]").forEach(a => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * 안전한 "타이핑" 느낌: HTML을 노드 단위로 순차적으로 붙인다.
 * - 마크다운 파싱 후 구조를 보존하므로 수식/코드/리스트가 깨지지 않음
 * - 완료 후 MathJax 렌더링
 */
function animateTypingWithMath(element, html, opts = {}) {
  const nodeDelay = opts.nodeDelay ?? 24;
  const blockDelay = opts.blockDelay ?? 140;

  const tmp = document.createElement("div");
  tmp.innerHTML = html; // 이미 sanitize 됨

  element.innerHTML = "";
  const chatWindow = document.getElementById("chatWindow");

  const step = () => {
    const node = tmp.firstChild;
    if (!node) {
      try {
        enhanceLinks(element);
        if (window.MathJax?.typesetPromise) {
          window.MathJax.typesetPromise([element]);
        }
      } catch {}
      return;
    }
    element.appendChild(node);

    // 블록 요소는 조금 더 느리게
    const isBlock = node.nodeType === Node.ELEMENT_NODE &&
      /^(P|PRE|UL|OL|BLOCKQUOTE|TABLE|DIV)$/i.test(node.nodeName);

    // 스크롤 고정
    chatWindow.scrollTop = chatWindow.scrollHeight;

    setTimeout(step, isBlock ? blockDelay : nodeDelay);
  };

  step();
}

// Firestore 저장/로드
async function saveChatbotToFirestore(payload) {
  const idField = document.getElementById("chatbotId");
  const existingId = (idField.value || "").trim();

  if (existingId) {
    await updateDoc(doc(db, "chatbots", existingId), {
      ...payload,
      updatedAt: serverTimestamp(),
      ownerUid: currentUser?.uid || null,
      ownerEmail: currentUser?.email || null
    });
    return existingId;
  } else {
    const ref = await addDoc(collection(db, "chatbots"), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ownerUid: currentUser?.uid || null,
      ownerEmail: currentUser?.email || null
    });
    idField.value = ref.id;
    const url = new URL(location.href);
    url.searchParams.set("id", ref.id);
    history.replaceState(null, "", url.toString());
    return ref.id;
  }
}
async function loadChatbotFromFirestore(id) {
  const snap = await getDoc(doc(db, "chatbots", id));
  if (!snap.exists()) throw new Error("해당 챗봇 문서가 없습니다.");
  return snap.data();
}

// 유틸
function escapeHtml(str){return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function guessFilenameFromUrl(url,fallback="document.pdf"){
  try{const c=url.split("?")[0];const last=c.substring(c.lastIndexOf("/")+1)||fallback;return decodeURIComponent(last);}catch{return fallback;}
}
async function fetchFileAsBlob(url){const r=await fetch(url);if(!r.ok)throw new Error(`파일 다운로드 실패: ${r.status}`);return await r.blob();}

// dedupe helpers
const fileKey = (m)=> String(m?.path || m?.url || m?.name || "").toLowerCase();
const nameKey = (f)=> String(f?.name || "").toLowerCase();
function dedupeMetas(metas){
  const seen = new Set();
  const out = [];
  for (const m of metas){
    const k = fileKey(m);
    if (k && !seen.has(k)){ seen.add(k); out.push(m); }
  }
  return out;
}

// ── Blob URL 관리 ──
function clearSelectedFileObjectUrls(){
  selectedFileObjectUrls.forEach(u => { try{ URL.revokeObjectURL(u); }catch{} });
  selectedFileObjectUrls = [];
}

// ====== 파일 목록 렌더링(저장된 + 미저장) & 삭제 ======
function renderFileLists() {
  const wrap = document.getElementById("ragFileLink");
  wrap.innerHTML = "";

  // 저장된 파일들
  (savedRagFiles || []).forEach((f, idx) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.style.margin = "4px 0";

    const a = document.createElement("a");
    a.href = f.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "rag-link";
    a.textContent = f.name || `파일 ${idx+1}`;
    row.appendChild(a);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "삭제";
    Object.assign(del.style, { padding:"4px 8px", border:"none", borderRadius:"6px", background:"#ef4444", color:"#fff", cursor:"pointer" });
    del.addEventListener("click", () => deleteSavedFileAt(idx));
    row.appendChild(del);

    wrap.appendChild(row);
  });

  // 🔧 저장본과 "파일명 기준"으로 중복되는 선택본은 숨김
  const savedNames = new Set((savedRagFiles || []).map(m => String(m?.name || "").toLowerCase()));

  // 미저장(방금 선택한) 파일들
  clearSelectedFileObjectUrls();
  (selectedFiles || []).forEach((f, idx) => {
    if (savedNames.has(nameKey(f))) return; // ← 중복 숨김
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.style.margin = "4px 0";

    const blobUrl = URL.createObjectURL(f);
    selectedFileObjectUrls.push(blobUrl);

    const a = document.createElement("a");
    a.href = blobUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = f.name;
    row.appendChild(a);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "삭제";
    Object.assign(del.style, { padding:"4px 8px", border:"none", borderRadius:"6px", background:"#ef4444", color:"#fff", cursor:"pointer" });
    del.addEventListener("click", () => removeSelectedFileAt(idx));
    row.appendChild(del);

    wrap.appendChild(row);
  });
}

async function deleteSavedFileAt(idx) {
  const id = (document.getElementById("chatbotId").value || "").trim();
  if (!savedRagFiles[idx]) return;
  const file = savedRagFiles[idx];

  if (!confirm(`'${file.name}' 파일을 삭제할까요?`)) return;
  try {
    if (file.path) {
      try { await deleteObject(storageRef(storage, file.path)); }
      catch (e) { console.warn("Storage 파일 삭제 실패/스킵:", e?.message); }
    }

    // Firestore 및 로컬 상태 갱신
    savedRagFiles = savedRagFiles.filter((_, i) => i !== idx);

    const legacyName = savedRagFiles.length ? savedRagFiles.map(f => f.name).join(", ") : "";
    const legacyUrl  = savedRagFiles[0]?.url  || "";
    const legacyPath = savedRagFiles[0]?.path || "";

    if (id) {
      await updateDoc(doc(db, "chatbots", id), {
        ragFiles: savedRagFiles,
        ragFileName: legacyName,
        ragFileUrl: legacyUrl,
        ragFilePath: legacyPath,
        updatedAt: serverTimestamp()
      });
    }

    renderFileLists();
    setRagStatus(null, selectedFiles.length ? `선택된 파일 ${selectedFiles.length}개 (테스트하기로 준비)` : "RAG 준비 전");
    showToast("🗑️ 파일을 삭제했습니다.");
  } catch (err) {
    console.error(err);
    showToast("❌ 파일 삭제 실패: " + err.message, 2200);
  }
}

// 미저장 파일 배열에서 하나 제거 (input.files도 동기화)
function removeSelectedFileAt(idx) {
  const input = document.getElementById("ragFile");
  const dt = new DataTransfer();
  selectedFiles.forEach((f, i) => { if (i !== idx) dt.items.add(f); });
  if (input) input.files = dt.files;
  selectedFiles = Array.from(dt.files);

  renderFileLists();
  setRagStatus(null, selectedFiles.length ? `선택된 파일 ${selectedFiles.length}개 (테스트하기로 준비)` : "RAG 준비 전");
}

// 편집모드 채우기 (+ 저장된 PDF들을 가능한 한 File로 복구)
async function populateFormFromDoc(data) {
  document.getElementById("subject").value = data.subject || "";
  document.getElementById("name").value = data.name || "";
  document.getElementById("description").value = data.description || "";

  if (data.modelSelectValue) document.getElementById("modelSelect").value = data.modelSelectValue;
  if (data.customModelValue) document.getElementById("customModelId").value = data.customModelValue;

  document.getElementById("ragToggle").checked = !!data.useRag;
  document.getElementById("ragUpload").classList.toggle("hidden", !data.useRag);
  document.getElementById("fewShotToggle").checked = !!data.useFewShot;
  document.getElementById("fewShotContainer").classList.toggle("hidden", !data.useFewShot);
  document.getElementById("selfConsistency").checked = !!data.selfConsistency;

  // 예시
  const examplesArea = document.getElementById("examplesArea");
  examplesArea.innerHTML = "";
  if (Array.isArray(data.examples) && data.examples.length) {
    data.examples.forEach(v => {
      const block = document.createElement("div");
      block.className = "example-block";
      const textarea = document.createElement("textarea");
      textarea.className = "example-input";
      textarea.value = v;
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.type = "button";
      delBtn.className = "delete-example";
      delBtn.addEventListener("click", () => block.remove());
      block.appendChild(textarea);
      block.appendChild(delBtn);
      examplesArea.appendChild(block);
    });
  } else {
    const block = document.createElement("div");
    block.className = "example-block";
    const textarea = document.createElement("textarea");
    textarea.className = "example-input";
    textarea.placeholder = "예) 피타고라스 정리 알려줘 → 직각삼각형에서...";
    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());
    block.appendChild(textarea);
    block.appendChild(delBtn);
    examplesArea.appendChild(block);
  }

  // 저장된 파일 메타 (배열 우선, 없으면 단일 필드 호환)
  savedRagFiles = Array.isArray(data.ragFiles) && data.ragFiles.length
    ? data.ragFiles
    : ((data.ragFileUrl || data.ragFileName) ? [{
        name: data.ragFileName || guessFilenameFromUrl(data.ragFileUrl),
        url:  data.ragFileUrl  || "",
        path: data.ragFilePath || ""
      }] : []);

  renderFileLists();

  // 테스트 편의용: 가능한 파일은 File로 복구
  selectedFiles = [];
  for (const f of savedRagFiles) {
    if (!f.url) continue;
    try {
      const blob = await fetchFileAsBlob(f.url);
      const file = new File([blob], f.name, { type: blob.type || "application/pdf" });
      selectedFiles.push(file);
    } catch (e) {
      console.warn("저장된 파일 로드 실패:", f.name, e?.message);
    }
  }
  if (savedRagFiles.length) {
    setRagStatus("busy", `선택된 파일 ${selectedFiles.length || savedRagFiles.length}개 (테스트하기로 준비)`);
    document.getElementById("sendMessage").disabled = true;
  }
}

function getSelectedModelId() {
  const sel = document.getElementById("modelSelect").value;
  if (sel === "custom") {
    const custom = (document.getElementById("customModelId").value || "").trim();
    if (!custom) {
      showToast("ℹ️ 커스텀 모델이 비어 있어 기본값(gpt-4o-mini)으로 진행합니다.");
      return "gpt-4o-mini";
    }
    return custom;
  }
  return sel || "gpt-4o-mini";
}

// 초기화
function resetAllUI() {
  const form = document.getElementById("chatbotForm");
  if (form) form.reset();

  const idField = document.getElementById("chatbotId");
  if (idField) idField.value = "";

  document.getElementById("ragUpload")?.classList.add("hidden");
  document.getElementById("fewShotContainer")?.classList.add("hidden");

  const examplesArea = document.getElementById("examplesArea");
  if (examplesArea) {
    examplesArea.innerHTML = "";
    const block = document.createElement("div");
    block.className = "example-block";
    const textarea = document.createElement("textarea");
    textarea.className = "example-input";
    textarea.placeholder = "예) 피타고라스 정리 알려줘 → 직각삼각형에서...";
    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());
    block.appendChild(textarea);
    block.appendChild(delBtn);
    examplesArea.appendChild(block);
  }

  const ragStatusEl = document.getElementById("ragStatus");
  if (ragStatusEl) {
    ragStatusEl.classList.remove("ready", "busy", "error");
    ragStatusEl.querySelector(".text").textContent = "RAG 준비 전";
  }

  const chatWindow = document.getElementById("chatWindow");
  if (chatWindow) chatWindow.innerHTML = "";
  const sendBtn = document.getElementById("sendMessage");
  if (sendBtn) sendBtn.disabled = false;

  clearSelectedFileObjectUrls();
  selectedFiles = [];
  uploadedByFingerprint.clear();
  attachedFileIds.clear();
  vectorStoreId = null;
  isRagReady = false;
  savedRagFiles = [];
}

// Firestore 문서 채우기
async function hydrateFromFirestoreIfNeeded() {
  const params = new URLSearchParams(location.search);
  const urlId = params.get("id");
  if (urlId) {
    document.getElementById("chatbotId").value = urlId;
    const data = await loadChatbotFromFirestore(urlId);
    await populateFormFromDoc(data);
    showToast("✏️ 편집 모드로 불러왔습니다.");
  }
}

// Storage 업로드(저장용)
function safeName(name) { return String(name).replace(/[^\w.\-가-힣 ]+/g, "_"); }
async function uploadRagFilesToStorage(files) {
  const uid = currentUser?.uid || "anon";
  const ts = Date.now();
  const metas = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const path = `chatbots/${uid}/rag/${ts}_${i}_${safeName(f.name)}`;
    const ref = storageRef(storage, path);
    await uploadBytes(ref, f);
    const url = await getDownloadURL(ref);
    metas.push({ name: f.name, path, url });
  }
  return metas;
}

// UI 초기화 + 이벤트
window.addEventListener("DOMContentLoaded", async () => {
  resetAllUI();

  const params = new URLSearchParams(location.search);
  const allowRestore = params.get("restore") === "1";
  if (allowRestore) restoreDraftFromStorage();
  else localStorage.removeItem("create_chatbot_draft");

  await hydrateFromFirestoreIfNeeded();

  const input = document.getElementById("userMessage");
  const sendBtn = document.getElementById("sendMessage");
  sendBtn.disabled = false;

  sendBtn.addEventListener("click", () => onSendMessage(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSendMessage(input); }
  });

  const ragToggle = document.getElementById("ragToggle");
  const ragUpload = document.getElementById("ragUpload");
  const ragStatusEl = document.getElementById("ragStatus");

  const modelSelect = document.getElementById("modelSelect");
  const customModelId = document.getElementById("customModelId");
  const syncCustomVisibility = () => {
    const isCustom = modelSelect.value === "custom";
    customModelId.classList.toggle("hidden", !isCustom);
  };
  modelSelect.addEventListener("change", syncCustomVisibility);
  syncCustomVisibility();

  // RAG 토글
  ragToggle.addEventListener("change", () => {
    if (ragToggle.checked) {
      ragUpload.classList.remove("hidden");
      setRagStatus("busy", "RAG 사용: 파일 선택 후 ‘테스트하기’로 준비");
      sendBtn.disabled = true;
    } else {
      ragUpload.classList.add("hidden");
      selectedFiles = [];
      clearSelectedFileObjectUrls();
      isRagReady = attachedFileIds.size > 0;
      ragStatusEl.classList.remove("ready", "busy", "error");
      ragStatusEl.querySelector(".text").textContent = "RAG 꺼짐";
      sendBtn.disabled = false;
    }
    renderFileLists();
  });

  // 파일 선택(미저장)
  const ragFile = document.getElementById("ragFile");
  ragFile.addEventListener("change", (e) => {
    selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length) isRagReady = false;
    if (ragToggle.checked) {
      setRagStatus("busy", `선택된 파일 ${selectedFiles.length}개 (테스트하기로 준비)`);
      sendBtn.disabled = true;
    }
    renderFileLists(); // 미저장 파일도 즉시 링크/삭제 노출(중복은 숨김)
  });

  // few-shot 토글/추가
  const fewShotToggle = document.getElementById("fewShotToggle");
  const fewShotContainer = document.getElementById("fewShotContainer");
  fewShotToggle.addEventListener("change", () => {
    fewShotContainer.classList.toggle("hidden", !fewShotToggle.checked);
  });
  document.getElementById("addExample").addEventListener("click", () => {
    const block = document.createElement("div");
    block.className = "example-block";
    const textarea = document.createElement("textarea");
    textarea.className = "example-input";
    textarea.placeholder = "예) 질문 예시 → 모델 답변 예시  (Q:..., A:... 형식도 가능)";
    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());
    block.appendChild(textarea);
    block.appendChild(delBtn);
    document.getElementById("examplesArea").appendChild(block);
  });

  // 저장하기
  document.getElementById("chatbotForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = collectFormData();
    try {
      const ragOn = document.getElementById("ragToggle").checked;
      const picked = Array.from((document.getElementById("ragFile")?.files) || []);
      let metas = [];
      if (ragOn && picked.length) {
        showToast("PDF 업로드 중…");
        metas = await uploadRagFilesToStorage(picked);
      }

      // 기존 저장본 + 신규 업로드본 병합 + 중복 제거
      const combined = dedupeMetas([...(savedRagFiles || []), ...metas]);
      payload.ragFiles = combined;
      payload.ragFileName = combined.length ? combined.map(m => m.name).join(", ") : "";
      payload.ragFileUrl  = combined[0]?.url  || "";
      payload.ragFilePath = combined[0]?.path || "";

      const id = await saveChatbotToFirestore(payload);

      // ✅ 저장 후 선택본/파일 입력/Blob URL 초기화 → 중복 렌더링 방지
      clearSelectedFileObjectUrls();
      selectedFiles = [];
      const fileInput = document.getElementById("ragFile");
      if (fileInput) fileInput.value = "";

      // 메모리/UI 동기화(저장본만 렌더)
      savedRagFiles = combined;
      renderFileLists();

      localStorage.setItem("create_chatbot_draft", JSON.stringify({ ...payload, savedAt: new Date().toISOString(), id }));
      showToast("✅ 저장 완료");
    } catch (err) {
      console.error(err);
      showToast("❌ 저장 실패: " + err.message, 2200);
    }
  });

  // 테스트하기
  document.getElementById("testButton").addEventListener("click", async () => {
    try {
      const ragOn = document.getElementById("ragToggle").checked;
      const sendBtnLocal = document.getElementById("sendMessage");

      if (!ragOn) {
        appendMessage("bot", "<div class='prose'>ℹ️ <strong>RAG</strong>가 꺼져 있어 인덱싱이 필요 없습니다. 바로 질문을 보내세요.</div>");
        return;
      }
      if (!selectedFiles.length && attachedFileIds.size > 0) {
        isRagReady = true;
        setRagStatus("ready", `RAG 준비 완료 (파일 ${attachedFileIds.size}개)`);
        sendBtnLocal.disabled = false;
        appendMessage("bot", "<div class='prose'>✅ 이미 업로드·인덱싱된 파일이 있어 바로 사용할 수 있습니다.</div>");
        return;
      }
      if (!selectedFiles.length) {
        setRagStatus("error", "PDF를 먼저 선택하세요.");
        appendMessage("bot", "<div class='prose'>⚠️ PDF를 먼저 선택해주세요.</div>");
        return;
      }

      setRagStatus("busy", "Vector Store 생성 중…");
      const vsId = await ensureVectorStore();

      for (const file of selectedFiles) {
        const fp = makeFingerprint(file);
        if (uploadedByFingerprint.has(fp)) {
          const fileId = uploadedByFingerprint.get(fp);
          if (attachedFileIds.has(fileId)) {
            appendMessage("bot", `<div class='prose'>♻️ 이미 준비된 파일: <code>${escapeHtml(file.name)}</code> (업로드/인덱싱 생략)</div>`);
            continue;
          }
          appendMessage("bot", `<div class='prose'>🔗 재연결: <code>${escapeHtml(file.name)}</code></div>`);
          await attachToVS(vsId, fileId);
          await waitIndexed(vsId, fileId);
          attachedFileIds.add(fileId);
          appendMessage("bot", `<div class='prose'>✅ 인덱싱 완료: <code>${escapeHtml(file.name)}</code></div>`);
          continue;
        }
        appendMessage("bot", `<div class='prose'>📚 업로드: <code>${escapeHtml(file.name)}</code></div>`);
        const up = await uploadFileToOpenAI(file);
        uploadedByFingerprint.set(fp, up.id);
        await attachToVS(vsId, up.id);
        await waitIndexed(vsId, up.id);
        attachedFileIds.add(up.id);
        appendMessage("bot", `<div class='prose'>✅ 인덱싱 완료: <code>${escapeHtml(file.name)}</code></div>`);
      }

      isRagReady = attachedFileIds.size > 0;
      if (isRagReady) {
        setRagStatus("ready", `RAG 준비 완료 (파일 ${attachedFileIds.size}개)`);
        document.getElementById("sendMessage").disabled = false;
        appendMessage("bot", "<div class='prose'>🎉 준비 완료! 질문을 보내면 업로드한 문서로 답합니다.</div>");
      } else {
        setRagStatus("error", "파일 준비 실패");
      }
    } catch (err) {
      isRagReady = false;
      setRagStatus("error", "오류 발생");
      appendMessage("bot", `<div class='prose'>❌ RAG 준비 실패: ${escapeHtml(err.message)}</div>`);
      if (document.getElementById("ragToggle").checked) {
        document.getElementById("sendMessage").disabled = true;
      }
    }
  });

  // 뒤로가기(bfcache) 복귀 초기화
  window.addEventListener("pageshow", async (ev) => {
    if (ev.persisted) {
      resetAllUI();
      localStorage.removeItem("create_chatbot_draft");
      await hydrateFromFirestoreIfNeeded();
    }
  });
});

// 메시지 전송/출력/폼 수집 — 기존 문법 유지
async function onSendMessage(inputEl) {
  const msg = inputEl.value.trim();
  if (!msg) return;

  appendMessage("user", escapeHtml(msg));
  inputEl.value = "";

  const useRag = document.getElementById("ragToggle").checked;
  if (useRag && !isRagReady) {
    appendMessage("bot", "<div class='prose'>⚠️ RAG 모드에선 인덱싱이 끝나야 합니다. ‘테스트하기’를 눌러 준비를 완료하세요.</div>");
    return;
  }

  const useFewShot = document.getElementById("fewShotToggle").checked;
  const fewShots = [];
  if (useFewShot) {
    document.querySelectorAll(".example-input").forEach(t => {
      const parsed = parseFewShot(t.value || "");
      if (parsed && isUsefulFewShot(parsed)) fewShots.push(parsed);
    });
  }

  const modelId = getSelectedModelId();
  const selfConsistency = document.getElementById("selfConsistency").checked;
  const systemPrompt = document.getElementById("description").value.trim();
  const thinking = appendMessage("bot", "<div class='prose'>💬 <em>답변 생성 중...</em></div>");

  try {
    const text = await askWithFileSearch({
      model: modelId,
      systemPrompt,
      fewShots,
      userMessage: msg,
      vsId: (useRag && isRagReady) ? vectorStoreId : null,
      selfConsistency,
      samples: 3,
      temperature: 0.7
    });

    const html = `<div class="prose">${renderMarkdown(text)}</div>`;
    thinking.innerHTML = "";
    animateTypingWithMath(thinking, html);
  } catch (err) {
    thinking.innerHTML = `<div class='prose'>❌ 응답 실패: ${escapeHtml(err.message)}</div>`;
  }
}
function appendMessage(role, content = "") {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}

// (이전 방식 교체) — 안전 노드 단위 애니메이션을 사용하므로 구현을 여기서 유지
// function animateTypingWithMath(element, html, delay = 18) { ... }  ← 대체됨

function collectFormData() {
  const subject = document.getElementById("subject").value.trim();
  const name = document.getElementById("name").value.trim();
  const description = document.getElementById("description").value.trim();
  const useRag = document.getElementById("ragToggle").checked;
  const useFewShot = document.getElementById("fewShotToggle").checked;
  const selfConsistency = document.getElementById("selfConsistency").checked;
  const model = getSelectedModelId();
  const modelSelectValue = document.getElementById("modelSelect").value;
  const customModelValue = document.getElementById("customModelId").value;

  const examples = [];
  if (useFewShot) {
    document.querySelectorAll(".example-input").forEach(t => {
      const val = (t.value || "").trim();
      if (val) examples.push(val);
    });
  }
  return {
    subject, name, description,
    useRag, useFewShot, selfConsistency,
    examples,
    model, modelSelectValue, customModelValue
  };
}
function restoreDraftFromStorage() {
  const raw = localStorage.getItem("create_chatbot_draft");
  if (!raw) return;
  const data = JSON.parse(raw);

  if (data.id && !new URLSearchParams(location.search).get("id")) {
    document.getElementById("chatbotId").value = data.id;
  }

  document.getElementById("subject").value = data.subject || "";
  document.getElementById("name").value = data.name || "";
  document.getElementById("description").value = data.description || "";
  document.getElementById("ragToggle").checked = !!data.useRag;
  document.getElementById("ragUpload").classList.toggle("hidden", !data.useRag);
  document.getElementById("fewShotToggle").checked = !!data.useFewShot;
  document.getElementById("fewShotContainer").classList.toggle("hidden", !data.useFewShot);

  if (data.modelSelectValue) document.getElementById("modelSelect").value = data.modelSelectValue;
  if (data.customModelValue) document.getElementById("customModelId").value = data.customModelValue;

  const examplesArea = document.getElementById("examplesArea");
  examplesArea.innerHTML = "";
  if (Array.isArray(data.examples) && data.examples.length) {
    data.examples.forEach(v => {
      const block = document.createElement("div");
      block.className = "example-block";
      const textarea = document.createElement("textarea");
      textarea.className = "example-input";
      textarea.value = v;
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.type = "button";
      delBtn.className = "delete-example";
      delBtn.addEventListener("click", () => block.remove());
      block.appendChild(textarea);
      block.appendChild(delBtn);
      examplesArea.appendChild(block);
    });
  } else {
    const block = document.createElement("div");
    block.className = "example-block";
    const textarea = document.createElement("textarea");
    textarea.className = "example-input";
    textarea.placeholder = "예) 피타고라스 정리 알려줘 → 직각삼각형에서...";
    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());
    block.appendChild(textarea);
    block.appendChild(delBtn);
    examplesArea.appendChild(block);
  }
}
function showToast(text, ms = 1400) {
  const toast = document.createElement("div");
  toast.textContent = text;
  Object.assign(toast.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    background: "#003478",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: "10px",
    boxShadow: "0 8px 20px rgba(0,0,0,.15)",
    zIndex: 9999,
    fontSize: "14px"
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), ms);
}
