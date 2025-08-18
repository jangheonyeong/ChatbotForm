// [src/StudentChatMain.js] — 학생 전용 Assistants v2 채팅 페이지
// Firestore 읽기 없이도 쿼리 파라미터(assistantId, name, subject, model)만으로 작동

import { initializeApp } from "firebase/app";
import {
  getFirestore, doc, getDoc
} from "firebase/firestore";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase init (읽기 전용) ===== */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

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

/* ===== Thread persistence ===== */
function threadKey(assistantId, nickname) {
  return `thread:${assistantId}:${nickname || "guest"}`;
}
async function getOrCreateThread(assistantId, nickname) {
  const key = threadKey(assistantId, nickname);
  let tid = localStorage.getItem(key);
  if (tid) return tid;
  const t = await createThread();
  tid = t.id;
  localStorage.setItem(key, tid);
  return tid;
}
function resetThread(assistantId, nickname) {
  const key = threadKey(assistantId, nickname);
  localStorage.removeItem(key);
}

/* ===== Page boot: load chatbot meta → prepare UI ===== */
let assistantId = null;
let chatbotDocId = null;

async function loadChatbotMeta() {
  // 두 방식 지원:
  // 1) ?assistantId=... (권장: Firestore 접근 없음)
  // 2) ?id=<chatbots 문서ID> (있는 경우에만 Firestore 읽기)
  chatbotDocId = qsParam("id");
  assistantId = qsParam("assistantId");

  // 🔹 쿼리 메타로 헤더 즉시 채우기 (Firestore 없이도 표시 가능)
  const qName = qsParam("name");
  const qSubject = qsParam("subject");
  const qModel = qsParam("model");
  if (qName)    botTitle.textContent = qName;
  if (qSubject) subjectLabel.textContent = qSubject ? `교과: ${qSubject}` : "";
  if (qModel)   modelLabel.textContent = qModel ? `모델: ${qModel}` : "";

  // 문서 ID가 있을 때만 Firestore 조회(비로그인 학생은 권한 없을 수 있음)
  if (chatbotDocId) {
    try {
      const snap = await getDoc(doc(db, "chatbots", chatbotDocId));
      if (snap.exists()) {
        const data = snap.data() || {};
        assistantId = data.assistantId || assistantId;
        // 쿼리 메타가 비어 있으면 Firestore 값으로 보강
        if (!qName && data.name) botTitle.textContent = data.name;
        if (!qSubject && data.subject) subjectLabel.textContent = `교과: ${data.subject}`;
        if (!qModel && data.assistantModelSnapshot) modelLabel.textContent = `모델: ${data.assistantModelSnapshot}`;
      }
    } catch (err) {
      // 권한 부족이어도 채팅 자체는 assistantId만으로 가능
      console.warn("Firestore 읽기 실패(무시 가능):", err?.message || err);
    }
  }

  // 마지막 생성값으로 복구 (옵션)
  if (!assistantId) {
    const lastAid = localStorage.getItem("last_student_assistant");
    const lastDoc = localStorage.getItem("last_student_doc");
    if (lastAid) {
      assistantId = lastAid;
      if (lastDoc && !chatbotDocId) chatbotDocId = lastDoc;
    }
  }

  if (!assistantId) {
    throw new Error("assistantId가 없습니다. ChatbotList의 '학생용 링크'로 열거나, URL에 ?assistantId=asst_xxx 를 포함해 주세요.");
  }
}

/* ===== Chat flow ===== */
async function sendMessageFlow(text) {
  const nickname = nickInput.value.trim() || "손님";
  const threadId = await getOrCreateThread(assistantId, nickname);

  // 1) 사용자 메시지 추가
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
    renderBubble("assistant", `처리 중 문제가 발생했습니다. (상태: ${status})`);
    return;
  }

  // 4) 메시지 목록에서 가장 최근 assistant 응답 표시
  const msgs = await listMessages(threadId);
  const all = msgs.data || [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.role !== "assistant") continue;
    const parts = m.content || [];
    const txtPart = parts.find(p => p.type === "text");
    const textValue = txtPart?.text?.value || "(빈 응답)";
    renderBubble("assistant", textValue);
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
    renderBubble("assistant", `❌ 오류: ${err?.message || err}`);
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
resetThreadBtn.addEventListener("click", () => {
  if (!assistantId) return;
  const nickname = nickInput.value.trim() || "손님";
  const ok = confirm("대화를 처음부터 다시 시작할까요?");
  if (!ok) return;
  resetThread(assistantId, nickname);
  chatWindow.innerHTML = "";
  renderBubble("assistant", "새 대화를 시작했어요. 무엇이든 물어보세요!");
});

/* ===== Init ===== */
(async function init() {
  try {
    loadNick();
    await loadChatbotMeta();
    renderBubble("assistant", "안녕하세요! 질문을 입력하면 도와드릴게요. (첨부 자료가 있다면 우선적으로 근거를 사용합니다.)");
  } catch (err) {
    console.error(err);
    renderBubble("assistant", `초기화 오류: ${err?.message || err}`);
    setSending(true);
  }
})();
