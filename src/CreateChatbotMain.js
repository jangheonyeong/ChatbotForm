// ─────────────────────────────────────────────────────────────
// OpenAI Responses + File Search (Vector Store)
// RAG 체크 시에만 RAG 사용 / 체크 해제 시에는 즉시 대화 가능
// ─────────────────────────────────────────────────────────────

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const OPENAI_BASE = "https://api.openai.com/v1";

let vectorStoreId = null;
let isRagReady = false;
let selectedFiles = [];

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

// [RAG] Vector Store 생성
async function ensureVectorStore() {
  if (vectorStoreId) return vectorStoreId;
  const data = await openaiFetch("/vector_stores", {
    method: "POST",
    body: { name: `vs_${Date.now()}`, expires_after: { anchor: "last_active_at", days: 7 } }
  });
  vectorStoreId = data.id;
  return vectorStoreId;
}

// [RAG] 파일 업로드/연결/인덱싱
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

// 문자열 프롬프트 빌더
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

// [Chat] Responses + (옵션) file_search
async function askWithFileSearch({
  model = "gpt-4o-mini",
  systemPrompt,
  fewShots = [],
  userMessage,
  vsId, // null이면 툴 미사용
  selfConsistency = false,
  samples = 3,
  temperature = 0.7
}) {
  const input = buildInputString({ systemPrompt, fewShots, userMessage });
  const tools = vsId ? [{ type: "file_search", vector_store_ids: [vsId] }] : undefined;

  const runOnce = async () => {
    const resp = await openaiFetch("/responses", {
      method: "POST",
      body: { model, input, ...(tools ? { tools } : {}), temperature }
    });
    if (typeof resp.output_text === "string" && resp.output_text.length > 0) return resp.output_text;
    if (Array.isArray(resp.output)) {
      const text = resp.output.map(o => Array.isArray(o.content) ? o.content.map(c => c?.text || "").join("") : "").join("");
      return text || "[빈 응답]";
    }
    return "[빈 응답]";
  };

  if (!selfConsistency) return await runOnce();
  const results = await Promise.all(Array.from({ length: samples }, runOnce));
  const votes = results.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
  return results.sort((a, b) => (votes[b] || 0) - (votes[a] || 0))[0];
}

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("userMessage");
  const sendBtn = document.getElementById("sendMessage");

  // ✅ 기본: RAG 꺼짐 상태 → 바로 대화 가능
  sendBtn.disabled = false;

  sendBtn.addEventListener("click", () => onSendMessage(input));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSendMessage(input); }
  });

  const ragToggle = document.getElementById("ragToggle");
  const ragUpload = document.getElementById("ragUpload");
  const ragStatusEl = document.getElementById("ragStatus");

  // RAG 토글
  ragToggle.addEventListener("change", () => {
    if (ragToggle.checked) {
      ragUpload.classList.remove("hidden");
      setRagStatus("busy", "RAG 사용: 파일 선택 후 ‘테스트하기’로 준비");
      // RAG 모드에선 인덱싱 전까지 대화 비활성화
      sendBtn.disabled = true;
    } else {
      ragUpload.classList.add("hidden");
      // 상태/선택 초기화
      selectedFiles = [];
      isRagReady = false;
      ragStatusEl.classList.remove("ready", "busy", "error");
      ragStatusEl.querySelector(".text").textContent = "RAG 꺼짐";
      // ✅ 비 RAG 모드 → 대화 가능
      sendBtn.disabled = false;
    }
  });

  // 파일 선택(여러 개)
  const ragFile = document.getElementById("ragFile");
  ragFile.addEventListener("change", (e) => {
    selectedFiles = Array.from(e.target.files || []);
    isRagReady = false;
    if (ragToggle.checked) {
      setRagStatus("busy", `선택된 파일 ${selectedFiles.length}개 (테스트하기로 준비)`);
      sendBtn.disabled = true; // RAG 켠 상태에서만 제한
    }
  });

  // few-shot 토글/추가 버튼
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
    textarea.placeholder = "예) 질문 예시 → 모델 답변 예시";
    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());
    block.appendChild(textarea);
    block.appendChild(delBtn);
    document.getElementById("examplesArea").appendChild(block);
  });

  // 저장(데모)
  document.getElementById("chatbotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    alert("데모: 저장 로직은 생략되어 있습니다.");
  });

  // 테스트하기
  document.getElementById("testButton").addEventListener("click", async () => {
    try {
      // ✅ RAG OFF면 테스트 필요 없음
      if (!ragToggle.checked) {
        appendMessage("bot", "ℹ️ RAG가 꺼져 있어 인덱싱이 필요 없습니다. 바로 질문을 보내세요.");
        return;
      }
      if (!selectedFiles.length) {
        setRagStatus("error", "PDF를 먼저 선택하세요.");
        appendMessage("bot", "⚠️ PDF를 먼저 선택해주세요.");
        return;
      }

      setRagStatus("busy", "Vector Store 생성 중…");
      const vsId = await ensureVectorStore();

      for (const file of selectedFiles) {
        appendMessage("bot", `📚 업로드: ${file.name}`);
        const up = await uploadFileToOpenAI(file);
        await attachToVS(vsId, up.id);
        appendMessage("bot", `⏳ 인덱싱 중: ${file.name}`);
        await waitIndexed(vsId, up.id);
        appendMessage("bot", `✅ 인덱싱 완료: ${file.name}`);
      }

      isRagReady = true;
      setRagStatus("ready", `RAG 준비 완료 (파일 ${selectedFiles.length}개)`);
      // ✅ RAG 준비 완료 → 대화 가능
      sendBtn.disabled = false;
      appendMessage("bot", "🎉 준비 완료! 질문을 보내면 업로드한 문서로 답합니다.");
    } catch (err) {
      isRagReady = false;
      setRagStatus("error", "오류 발생");
      appendMessage("bot", "❌ RAG 준비 실패: " + err.message);
      // RAG 모드의 실패 시에만 제한. 토글을 끄면 다시 대화 가능.
      if (ragToggle.checked) document.getElementById("sendMessage").disabled = true;
    }
  });
});

// 메시지 전송
async function onSendMessage(inputEl) {
  const msg = inputEl.value.trim();
  if (!msg) return;

  appendMessage("user", msg);
  inputEl.value = "";

  const useRag = document.getElementById("ragToggle").checked;
  if (useRag && !isRagReady) {
    appendMessage("bot", "⚠️ RAG 모드에선 인덱싱이 끝나야 합니다. ‘테스트하기’를 눌러 준비를 완료하세요.");
    return;
  }

  const useFewShot = document.getElementById("fewShotToggle").checked;
  const fewShots = [];
  if (useFewShot) {
    document.querySelectorAll(".example-input").forEach(t => {
      const raw = t.value.trim();
      if (raw.includes("→")) {
        const [u, a] = raw.split("→").map(s => s.trim());
        if (u) fewShots.push({ user: u, assistant: a || "" });
      }
    });
  }

  const selfConsistency = document.getElementById("selfConsistency").checked;
  const systemPrompt = document.getElementById("description").value.trim();
  const thinking = appendMessage("bot", "💬 답변 생성 중...");

  try {
    const text = await askWithFileSearch({
      model: "gpt-4o-mini",
      systemPrompt,
      fewShots,
      userMessage: msg,
      vsId: (useRag && isRagReady) ? vectorStoreId : null, // ✅ RAG OFF면 null
      selfConsistency,
      samples: 3,
      temperature: 0.7
    });

    const html = marked.parse(text);
    thinking.innerHTML = "";
    animateTypingWithMath(thinking, html);
  } catch (err) {
    thinking.innerHTML = "❌ 응답 실패: " + err.message;
  }
}

// 출력 유틸
function appendMessage(role, content = "") {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}
function animateTypingWithMath(element, html, delay = 18) {
  const tokens = html.split(/(\s+)/);
  let i = 0;
  element.innerHTML = "";
  const iv = setInterval(() => {
    if (i >= tokens.length) {
      clearInterval(iv);
      MathJax.typesetPromise([element]);
      return;
    }
    element.innerHTML += tokens[i];
    i++;
    const chatWindow = document.getElementById("chatWindow");
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, delay);
}
