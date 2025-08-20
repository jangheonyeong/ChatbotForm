// [src/StudentChatMain.js] — 학생 전용 Assistants v2 채팅 페이지
// 변경점 요약
// 1) 익명 인증 추가 → Firestore 쓰기 전에 request.auth 확보
// 2) 학생 대화 저장: student_conversations/{convId} + messages/{msgId}
// 3) URL 파라미터 assistant ↔ assistantId 둘 다 지원
// 4) 교과/모델/교사UID/챗봇문서ID 메타를 대화에 중복 저장
// 5) ★ 세컨더리 Firebase App('student-app') 사용 → 교사 세션과 분리

import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore, doc, getDoc,
  collection, addDoc, setDoc, serverTimestamp
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== 상수 (컬렉션 경로) ===== */
// 규칙을 student_conversations에 맞춰 배포했다면 그대로 사용.
// 기존 "conversations"를 쓰고 있다면 아래 한 줄만 "conversations"로 바꾸세요.
const CONV_COL = "student_conversations";
const MSGS_SUB = "messages";

/* ===== Firebase init (세션 분리: 세컨더리 앱) ===== */
// 기본 앱(교사용)과 분리된 이름 있는 앱을 사용해 Auth 세션 충돌을 방지합니다.
const app =
  getApps().find(a => a.name === "student-app") ||
  initializeApp(firebaseConfig, "student-app");
const db = getFirestore(app);
const auth = getAuth(app);

// 익명 인증: Firestore 쓰기 전에 꼭 불러 request.auth를 채움
async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  try {
    const cred = await signInAnonymously(auth);
    return cred.user;
  } catch (e) {
    console.error("Anonymous auth failed:", e);
    alert("익명 인증에 실패했습니다. Firebase 콘솔에서 Anonymous 로그인 제공업체를 활성화해 주세요.");
    throw e;
  }
}

/* ===== DOM ===== */
const botTitle = document.getElementById("botTitle");
const subjectLabel = document.getElementById("subjectLabel");
const modelLabel = document.getElementById("modelLabel");
const chatWindow = document.getElementById("chatWindow");
const composer = document.getElementById("composer");
const userMessageEl = document.getElementById("userMessage");
const sendBtn = document.getElementById("sendBtn");
const nickInput = document.getElementById("nicknameInput");
const saveNickBtn = document.getElementById("saveNickBtn");
const resetThreadBtn = document.getElementById("resetThreadBtn");

/* ===== OpenAI (Assistants v2) ===== */
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
  openaiFetch(`/threads/${threadId}/messages`, {
    method: "POST",
    body: { role: "user", content }
  });
const createRun = (threadId, assistantId) =>
  openaiFetch(`/threads/${threadId}/runs`, {
    method: "POST",
    body: { assistant_id: assistantId }
  });
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

/* ===== Nickname (localStorage) ===== */
const NICK_KEY = "student_nickname";
function loadNick() {
  const n = localStorage.getItem(NICK_KEY) || "";
  nickInput.value = n;
  return n;
}
function saveNick(n) {
  const v = (n || "").trim().slice(0, 20);
  localStorage.setItem(NICK_KEY, v);
  nickInput.value = v;
}
saveNickBtn.addEventListener("click", () => {
  saveNick(nickInput.value);
  renderBubble("assistant", `닉네임을 "${nickInput.value || "손님"}"로 저장했어요.`);
});

/* ===== Thread persistence (OpenAI) ===== */
function threadKey(aid, nickname) {
  return `thread:${aid}:${nickname || "guest"}`;
}
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

/* ===== Conversation persistence (Firestore) ===== */
function convKey(aid, nickname) {
  return `conv:${aid}:${nickname || "guest"}`;
}

let assistantId = null;
let chatbotDocId = null;
let teacherUid = null;
let subjectStr = "";
let modelStr = "";
let conversationId = null;

async function ensureConversation() {
  await ensureAuth(); // ← 인증 보장

  const nickname = nickInput.value.trim() || "손님";
  const key = convKey(assistantId, nickname);
  let convId = localStorage.getItem(key);

  if (!convId) {
    // 새 대화 생성
    const convRef = await addDoc(collection(db, CONV_COL), {
      assistantId,
      subject: subjectStr || "",
      model: modelStr || "",
      teacherUid: teacherUid || "",     // 없으면 빈 문자열
      chatbotDocId: chatbotDocId || "", // 없으면 빈 문자열
      studentNickname: nickname,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    convId = convRef.id;
    localStorage.setItem(key, convId);
  } else {
    // 최종 활동 시각만 갱신
    try {
      await setDoc(doc(db, CONV_COL, convId), { updatedAt: serverTimestamp() }, { merge: true });
    } catch {}
  }

  conversationId = convId;
  return convId;
}

async function logMessage(role, content) {
  await ensureAuth(); // ← 인증 보장
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

/* ===== Page boot: load chatbot meta → prepare UI ===== */
async function loadChatbotMeta() {
  // 파라미터 호환: ?assistant=... 또는 ?assistantId=...
  chatbotDocId = qsParam("id");
  assistantId = qsParam("assistant") || qsParam("assistantId");

  // 쿼리 메타로 헤더 채우기
  const qName = qsParam("name");
  const qSubject = qsParam("subject");
  const qModel = qsParam("model");
  const qTeacherUid = qsParam("teacherUid");

  if (qName)    botTitle.textContent = qName;
  if (qSubject) subjectLabel.textContent = qSubject ? `교과: ${qSubject}` : "";
  if (qModel)   modelLabel.textContent = qModel ? `모델: ${qModel}` : "";
  if (qTeacherUid) teacherUid = qTeacherUid;

  subjectStr = qSubject || "";
  modelStr = qModel || "";

  // Firestore 문서가 있을 때만 보강 (학생은 권한 없을 수 있으니 try/catch)
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
        if (!qModel && data.assistantModelSnapshot) {
          modelStr = data.assistantModelSnapshot;
          modelLabel.textContent = `모델: ${data.assistantModelSnapshot}`;
        }
        if (!teacherUid && (data.ownerUid || data.uid)) {
          teacherUid = data.ownerUid || data.uid;
        }
      }
    } catch (err) {
      console.warn("Firestore 읽기 실패(무시 가능):", err?.message || err);
    }
  }

  // 마지막 기록 복구(옵션)
  if (!assistantId) {
    const lastAid = localStorage.getItem("last_student_assistant");
    const lastDoc = localStorage.getItem("last_student_doc");
    if (lastAid) {
      assistantId = lastAid;
      if (lastDoc && !chatbotDocId) chatbotDocId = lastDoc;
    }
  }

  if (!assistantId) {
    throw new Error("assistantId가 없습니다. ChatbotList의 '학생용 링크'로 열거나, URL에 ?assistant=asst_xxx 를 포함해 주세요.");
  }
}

/* ===== Chat flow ===== */
async function sendMessageFlow(text) {
  const nickname = nickInput.value.trim() || "손님";
  const threadId = await getOrCreateThread(assistantId, nickname);

  // 로깅: 사용자 메시지 저장
  await ensureConversation();
  await logMessage("user", text);

  // 1) 사용자 메시지 추가(Assistants)
  await addMessage(threadId, text);

  // 2) Run 생성
  const run = await createRun(threadId, assistantId);

  // 3) 상태 폴링
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

  // 4) 가장 최근 assistant 응답 표시 + 로깅
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

/* ===== Event wiring ===== */
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

// Shift+Enter 줄바꿈, Enter 제출 막기
userMessageEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// 새로 시작(새 thread)
resetThreadBtn.addEventListener("click", async () => {
  if (!assistantId) return;
  const nickname = nickInput.value.trim() || "손님";
  const ok = confirm("대화를 처음부터 다시 시작할까요?");
  if (!ok) return;
  resetThread(assistantId, nickname);
  chatWindow.innerHTML = "";
  renderBubble("assistant", "새 대화를 시작했어요. 무엇이든 물어보세요!");
  // 기존 conversation은 유지(학습용). 완전히 새로 만들고 싶으면 아래 주석 해제:
  // localStorage.removeItem(convKey(assistantId, nickname));
  // conversationId = null;
});

/* ===== Init ===== */
(async function init() {
  try {
    loadNick();
    await ensureAuth();         // ★ 익명 인증 먼저 확보(세컨더리 앱)
    await loadChatbotMeta();
    renderBubble("assistant", "안녕하세요! 질문을 입력하면 도와드릴게요. (첨부 자료가 있다면 우선적으로 근거를 사용합니다.)");
  } catch (err) {
    console.error(err);
    renderBubble("assistant", `초기화 오류: ${err?.message || err}`);
    setSending(true);
  }
})();
