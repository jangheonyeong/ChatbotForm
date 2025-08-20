// [src/StudentChatMain.js]

import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore, doc, getDoc,
  collection, addDoc, setDoc, serverTimestamp,
  getDocs, query, where
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== 상수 ===== */
const CONV_COL = "student_conversations";
const MSGS_SUB = "messages";

/* ===== Firebase init ===== */
// 학생 세션(익명) - 세컨더리 앱
const studentApp =
  getApps().find(a => a.name === "student-app") ||
  initializeApp(firebaseConfig, "student-app");
const db = getFirestore(studentApp);
const auth = getAuth(studentApp);

// 교사 세션(로그인) - 기본 앱
const defaultApp = getApps().find(a => a.name === "[DEFAULT]") || initializeApp(firebaseConfig);
const dbPrimary = getFirestore(defaultApp);
const teacherAuth = getAuth(defaultApp);

/* ===== DOM ===== */
const botTitle = document.getElementById("botTitle");
const subjectLabel = document.getElementById("subjectLabel");
const chatWindow = document.getElementById("chatWindow");
const composer = document.getElementById("composer");
const userMessageEl = document.getElementById("userMessage");
const sendBtn = document.getElementById("sendBtn");
const nickInput = document.getElementById("nicknameInput");
const resetThreadBtn = document.getElementById("resetThreadBtn");

// 교사 전용 UI
const issueCodeBtn = document.getElementById("issueCodeBtn");
const codePanel = document.getElementById("codePanel");
const codeText = document.getElementById("codeText");
const copyCodeBtn = document.getElementById("copyCodeBtn");

/* ===== OpenAI ===== */
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || "";
const OPENAI_BASE = "https://api.openai.com/v1";

function assertApiKey() {
  if (!OPENAI_API_KEY) {
    alert("OpenAI API 키가 설정되어 있지 않습니다. (.env의 VITE_OPENAI_API_KEY)");
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
const createThread = () => openaiFetch("/threads", { method: "POST", body: {} });
const addMessage = (threadId, content) =>
  openaiFetch(`/threads/${threadId}/messages`, { method: "POST", body: { role: "user", content }});
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
function renderBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}
function renderTyping(show) {
  let el = document.getElementById("typing");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "typing";
      el.className = "msg assistant";
      el.innerHTML = `<div class="bubble"><span class="typing">생각 중…</span></div>`;
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
}

/* ===== Nickname(읽기 전용) ===== */
const NICK_KEY = "student_nickname";
function loadNick() {
  const n = localStorage.getItem(NICK_KEY) || "";
  nickInput.value = n;
  return n;
}

/* ===== Thread/Conversation ===== */
function threadKey(aid, nickname) { return `thread:${aid}:${nickname || "guest"}`; }
async function getOrCreateThread(aid, nickname) {
  const key = threadKey(aid, nickname);
  let tid = localStorage.getItem(key);
  if (tid) return tid;
  const t = await createThread();
  tid = t.id;
  localStorage.setItem(key, tid);
  return tid;
}
function resetThread(aid, nickname) {
  const key = threadKey(aid, nickname);
  localStorage.removeItem(key);
}

function convKey(aid, nickname) { return `conv:${aid}:${nickname || "guest"}`; }

let assistantId = null;
let chatbotDocId = null;
let teacherUid = null;
let subjectStr = "";
let modelStr = ""; // UI 미표시
let conversationId = null;

async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

async function ensureConversation() {
  await ensureAuth();
  const nickname = nickInput.value.trim() || "손님";
  const key = convKey(assistantId, nickname);
  let convId = localStorage.getItem(key);

  if (!convId) {
    const convRef = await addDoc(collection(db, CONV_COL), {
      assistantId,
      subject: subjectStr || "",
      model: modelStr || "",
      teacherUid: teacherUid || "",
      chatbotDocId: chatbotDocId || "",
      studentNickname: nickname,
      createdBy: auth.currentUser?.uid || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    convId = convRef.id;
    localStorage.setItem(key, convId);
  } else {
    try { await setDoc(doc(db, CONV_COL, convId), { updatedAt: serverTimestamp() }, { merge: true }); } catch {}
  }
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

/* ===== Chatbot 메타 로드 ===== */
async function loadChatbotMeta() {
  chatbotDocId = qsParam("id");
  assistantId = qsParam("assistant") || qsParam("assistantId");

  const qName = qsParam("name");
  const qSubject = qsParam("subject");
  const qModel = qsParam("model"); // 저장만
  const qTeacherUid = qsParam("teacherUid");

  if (qName)    botTitle.textContent = qName;
  if (qSubject) subjectLabel.textContent = qSubject ? `교과: ${qSubject}` : "";
  if (qTeacherUid) teacherUid = qTeacherUid;

  subjectStr = qSubject || "";
  modelStr = qModel || "";

  if (chatbotDocId) {
    try {
      const snap = await getDoc(doc(db, "chatbots", chatbotDocId));
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
  if (!assistantId) throw new Error("assistantId가 없습니다. URL에 ?assistant=asst_xxx 를 포함해 주세요.");
}

/* ===== Assistants 채팅 플로우 ===== */
async function sendMessageFlow(text) {
  const nickname = nickInput.value.trim() || "손님";
  const threadId = await getOrCreateThread(assistantId, nickname);

  await ensureConversation();
  await logMessage("user", text);

  await addMessage(threadId, text);
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
    const parts = m.content || [];
    const txtPart = parts.find(p => p.type === "text");
    const textValue = txtPart?.text?.value || "(빈 응답)";
    renderBubble("assistant", textValue);
    await logMessage("assistant", textValue);
    break;
  }
}

/* ===== 이벤트 ===== */
composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = (userMessageEl.value || "").trim();
  if (!text) return;

  renderBubble("user", text);
  userMessageEl.value = "";
  setSending(true);
  try {
    await sendMessageFlow(text);
  } catch (err) {
    console.error(err);
    const msg = `❌ 오류: ${err?.message || err}`;
    renderBubble("assistant", msg);
    await logMessage("system", msg);
  } finally {
    setSending(false);
  }
});
userMessageEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});
resetThreadBtn.addEventListener("click", async () => {
  if (!assistantId) return;
  const nickname = nickInput.value.trim() || "손님";
  if (!confirm("대화를 처음부터 다시 시작할까요?")) return;
  resetThread(assistantId, nickname);
  chatWindow.innerHTML = "";
  renderBubble("assistant", "새 대화를 시작했어요. 무엇이든 물어보세요!");
});

/* ===== 교사 권한 체크 & 코드 발급 ===== */
// ✅ 이메일 화이트리스트에 janghy0412@gmail.com 추가
const ADMIN_EMAIL_WHITELIST = ["wkdgjsdud@snu.ac.kr", "janghy0412@gmail.com"];

// 승인 판정 로직을 관대하게(여러 필드 지원)
async function isTeacherAuthorized(user) {
  console.debug("[auth] teacherAuth.currentUser:", user?.email || null);
  if (!user) return false;

  if (user.email && ADMIN_EMAIL_WHITELIST.includes(user.email)) {
    console.debug("[auth] whitelist matched");
    return true;
  }

  // Custom Claims
  try {
    const token = await user.getIdTokenResult();
    console.debug("[auth] claims:", token?.claims);
    if (token?.claims?.teacher === true) return true;
    if (token?.claims?.admin === true) return true;
  } catch (e) {
    console.debug("[auth] getIdTokenResult error", e?.message);
  }

  // teachers/{uid} 문서
  try {
    const tSnap = await getDoc(doc(dbPrimary, "teachers", user.uid));
    if (tSnap.exists()) {
      const t = tSnap.data() || {};
      console.debug("[auth] teachers doc:", t);

      // 가능한 필드들을 모두 허용 방향으로 체크
      const positive =
        t.enabled === true ||
        t.approved === true ||
        t.active === true ||
        t.isActive === true ||
        t.role === "teacher" ||
        t.role === "admin";

      const explicitlyDisabled = t.enabled === false || t.disabled === true;

      if (positive) return true;
      if (explicitlyDisabled) return false;

      // 문서가 존재하고 명시적 비활성화가 아니면 승인으로 간주(버튼 표시 용도)
      return true;
    } else {
      console.debug("[auth] teachers doc not found");
    }
  } catch (e) {
    console.debug("[auth] read teachers doc error:", e?.message);
  }

  return false;
}

function toggleTeacherUI(isTeacher) {
  console.debug("[auth] toggleTeacherUI:", isTeacher);
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

// 6자리 숫자 코드
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
  const u = teacherAuth.currentUser;
  if (!u) { alert("교사 계정으로 로그인해 주세요."); return; }

  if (!(await isTeacherAuthorized(u))) {
    alert("코드 발급 권한이 없습니다.");
    return;
  }

  const code = await createUniqueCode();
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24시간

  await addDoc(collection(dbPrimary, "access_codes"), {
    code,
    active: true,
    assistantId: assistantId || "",
    chatbotDocId: chatbotDocId || "",
    teacherUid: teacherUid || u.uid,
    teacherEmail: u.email || "",
    createdAt: serverTimestamp(),
    expiresAt: expires
  });

  codeText.value = code;
  codePanel.style.display = "flex";
  try {
    await navigator.clipboard.writeText(code);
    renderBubble("assistant", `코드를 발급하고 클립보드에 복사했어요: ${code} (24시간 유효)`);
  } catch {
    renderBubble("assistant", `코드를 발급했어요: ${code} (복사 버튼을 눌러 복사하세요)`);
  }
}

// 로그인 상태 변화 감지
onAuthStateChanged(teacherAuth, async (user) => {
  console.debug("[auth] onAuthStateChanged user:", user?.email || null);
  const ok = await isTeacherAuthorized(user);
  toggleTeacherUI(ok);
});

// 버튼 동작
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

/* ===== Init ===== */
(async function init() {
  try {
    loadNick();
    await ensureAuth();
    await loadChatbotMeta();
    renderBubble("assistant", "안녕하세요! 질문을 입력하면 도와드릴게요. (첨부 자료가 있다면 우선적으로 근거를 사용합니다.)");
  } catch (err) {
    console.error(err);
    renderBubble("assistant", `초기화 오류: ${err?.message || err}`);
    setSending(true);
  }
})();
