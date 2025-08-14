// ─────────────────────────────────────────────────────────────
// OpenAI Responses + File Search (Vector Store)
// RAG 체크 시에만 RAG 사용 / 체크 해제 시에는 즉시 대화 가능
// ─────────────────────────────────────────────────────────────

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const OPENAI_BASE = "https://api.openai.com/v1";

let vectorStoreId = null;
let isRagReady = false;
let selectedFiles = [];

// 업로드/재첨부 상태(중복 인덱싱 방지용: 이전 답변에서 이미 넣어두신 부분 유지 시 사용)
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

// ★ FEW-SHOT 파서 (강화) — 다양한 구분자 / Q:A 형식 지원
function parseFewShot(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  // Q:/A: 패턴
  const qaMatch = text.match(/^\s*(?:Q|질문)\s*:\s*([\s\S]+?)\n\s*(?:A|답|답변)\s*:\s*([\s\S]+)$/i);
  if (qaMatch) return { user: qaMatch[1].trim(), assistant: qaMatch[2].trim() };

  // 다양한 구분자
  const SEPS = ["→", "->", "=>", "⇒", "||", "|", "—", ":"];
  for (const s of SEPS) {
    const idx = text.indexOf(s);
    if (idx !== -1) {
      const left = text.slice(0, idx).trim();
      const right = text.slice(idx + s.length).trim();
      if (left) return { user: left, assistant: right };
    }
  }

  // 빈 줄(두 줄바꿈)로 분리
  const parts = text.split(/\n\s*\n/);
  if (parts.length >= 2) return { user: parts[0].trim(), assistant: parts.slice(1).join("\n").trim() };

  // 한 줄만 있으면 사용자 예시만
  return { user: text, assistant: "" };
}

// ★ 짧은/무의미한 few-shot 자동 필터
function isUsefulFewShot(ex) {
  const u = (ex?.user || "").trim();
  const a = (ex?.assistant || "").trim();
  if (!u) return false;
  // '좋아', '네', '확인' 같은 1~2단어 짧은 답변은 제외 (8자 미만은 스킵)
  if (a && a.length < 8) return false;
  return true;
}

// 문자열 프롬프트 빌더 (instructions X, input 하나에 합침)
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

// [Chat] Responses + (옵션) file_search  — RAG '되던' 문법 그대로
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
  // ❗️일반 답변을 강제하는 가드레일(금지 문구 & 답변 형식)
  const genericGuard = `
한국어로 답하세요. 질문을 되묻는 안내 멘트만 하지 말고, 먼저 핵심 답을 3–6문장으로 제시하세요.
금지 문구: "무엇을 도와드릴까요", "어떤 도움이 필요하신가요", "어떤 점이 궁금하신가요" 등.
질문이 막연하면, 가능한 가정 하에 일반적인 답을 제시한 뒤 "원하면 다음 중 무엇을 도와줄까요?" 형태로 2–3개의 구체적 선택지를 제안하세요.`.trim();

  // RAG 켠 상태에서도 “파일 얘기만” 강요하지 않게 가이드
  const ragGuide = vsId ? `
업로드된 파일이 도움이 될 때만 file_search를 사용하세요. 질문이 파일과 무관하면 일반 지식으로도 충분히 답하세요.
"It seems you've uploaded some files..." 류의 멘트는 하지 마세요.`.trim() : "";

  const mergedSystem = [systemPrompt || "", genericGuard, ragGuide].filter(Boolean).join("\n\n");

  const input = buildInputString({
    systemPrompt: mergedSystem,
    fewShots,
    userMessage
  });

  // ✅ RAG 문법 고정 (변경 금지)
  const tools = vsId ? [{ type: "file_search", vector_store_ids: [vsId] }] : undefined;

  const runOnce = async (useVsId) => {
    const resp = await openaiFetch("/responses", {
      method: "POST",
      body: {
        model,
        input,
        ...(useVsId ? { tools } : {}),
        temperature
      }
    });
    return extractAssistantText(resp);
  };

  // 1차: RAG 시도
  let text = await runOnce(!!vsId);

  // 2차: 여전히 비어있거나 지나치게 짧으면 비RAG로 폴백
  if ((!text || text.length < 5) && vsId) {
    text = await runOnce(false);
  }

  return text || "[빈 응답]";
}

// 응답 파서 보강 (v2/구형 포맷 모두 대응 + suggested_replies 활용)
function extractAssistantText(resp) {
  if (resp?.output_text && resp.output_text.trim()) return resp.output_text.trim();

  let parts = [];

  if (Array.isArray(resp?.output)) {
    for (const o of resp.output) {
      const content = o?.content || [];
      for (const c of content) {
        // v2 포맷: { type:"output_text", text:{ value:"..." } }
        if (c?.type === "output_text" && c?.text?.value) parts.push(String(c.text.value));
        // 구형 포맷: { text:"..." }
        else if (typeof c?.text === "string") parts.push(c.text);
      }
      // 본문이 전혀 없고 suggested_replies만 있을 때 첫 개라도 사용
      if (!parts.length && Array.isArray(o?.suggested_replies) && o.suggested_replies.length) {
        const t = o.suggested_replies[0]?.text;
        if (t) parts.push(t);
      }
    }
  }

  return parts.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("userMessage");
  const sendBtn = document.getElementById("sendMessage");

  // 기본: RAG 꺼짐 상태 → 바로 대화 가능
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
      sendBtn.disabled = true;
    } else {
      ragUpload.classList.add("hidden");
      selectedFiles = [];
      isRagReady = attachedFileIds.size > 0;
      ragStatusEl.classList.remove("ready", "busy", "error");
      ragStatusEl.querySelector(".text").textContent = "RAG 꺼짐";
      sendBtn.disabled = false;
    }
  });

  // 파일 선택(여러 개)
  const ragFile = document.getElementById("ragFile");
  ragFile.addEventListener("change", (e) => {
    selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length) isRagReady = false;
    if (ragToggle.checked) {
      setRagStatus("busy", `선택된 파일 ${selectedFiles.length}개 (테스트하기로 준비)`);
      sendBtn.disabled = true;
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

  // 저장(임시 저장)
  document.getElementById("chatbotForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = collectFormData();
    localStorage.setItem("create_chatbot_draft", JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    showToast("✅ 임시 저장 완료");
  });

  try { restoreDraftFromStorage(); } catch {}

  // 테스트하기
  document.getElementById("testButton").addEventListener("click", async () => {
    try {
      if (!ragToggle.checked) {
        appendMessage("bot", "ℹ️ RAG가 꺼져 있어 인덱싱이 필요 없습니다. 바로 질문을 보내세요.");
        return;
      }
      if (!selectedFiles.length && attachedFileIds.size > 0) {
        isRagReady = true;
        setRagStatus("ready", `RAG 준비 완료 (파일 ${attachedFileIds.size}개)`);
        sendBtn.disabled = false;
        appendMessage("bot", "✅ 이미 업로드·인덱싱된 파일이 있어 바로 사용할 수 있습니다.");
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
        const fp = makeFingerprint(file);
        if (uploadedByFingerprint.has(fp)) {
          const fileId = uploadedByFingerprint.get(fp);
          if (attachedFileIds.has(fileId)) {
            appendMessage("bot", `♻️ 이미 준비된 파일: ${file.name} (업로드/인덱싱 생략)`);
            continue;
          }
          appendMessage("bot", `🔗 재연결: ${file.name}`);
          await attachToVS(vsId, fileId);
          await waitIndexed(vsId, fileId);
          attachedFileIds.add(fileId);
          appendMessage("bot", `✅ 인덱싱 완료: ${file.name}`);
          continue;
        }
        appendMessage("bot", `📚 업로드: ${file.name}`);
        const up = await uploadFileToOpenAI(file);
        uploadedByFingerprint.set(fp, up.id);
        await attachToVS(vsId, up.id);
        await waitIndexed(vsId, up.id);
        attachedFileIds.add(up.id);
        appendMessage("bot", `✅ 인덱싱 완료: ${file.name}`);
      }

      isRagReady = attachedFileIds.size > 0;
      if (isRagReady) {
        setRagStatus("ready", `RAG 준비 완료 (파일 ${attachedFileIds.size}개)`);
        sendBtn.disabled = false;
        appendMessage("bot", "🎉 준비 완료! 질문을 보내면 업로드한 문서로 답합니다.");
      } else {
        setRagStatus("error", "파일 준비 실패");
      }
    } catch (err) {
      isRagReady = false;
      setRagStatus("error", "오류 발생");
      appendMessage("bot", "❌ RAG 준비 실패: " + err.message);
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

  // few-shot 수집(짧은/무의미한 예시는 제외)
  const useFewShot = document.getElementById("fewShotToggle").checked;
  const fewShots = [];
  if (useFewShot) {
    document.querySelectorAll(".example-input").forEach(t => {
      const parsed = parseFewShot(t.value || "");
      if (parsed && isUsefulFewShot(parsed)) fewShots.push(parsed);
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
      vsId: (useRag && isRagReady) ? vectorStoreId : null,
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

// 출력 유틸 및 도우미들(생략 없음)
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

function collectFormData() {
  const subject = document.getElementById("subject").value.trim();
  const name = document.getElementById("name").value.trim();
  const description = document.getElementById("description").value.trim();
  const useRag = document.getElementById("ragToggle").checked;
  const useFewShot = document.getElementById("fewShotToggle").checked;
  const selfConsistency = document.getElementById("selfConsistency").checked;

  const examples = [];
  if (useFewShot) {
    document.querySelectorAll(".example-input").forEach(t => {
      const val = (t.value || "").trim();
      if (val) examples.push(val);
    });
  }
  return { subject, name, description, useRag, useFewShot, selfConsistency, examples };
}
function restoreDraftFromStorage() {
  const raw = localStorage.getItem("create_chatbot_draft");
  if (!raw) return;
  const data = JSON.parse(raw);
  document.getElementById("subject").value = data.subject || "";
  document.getElementById("name").value = data.name || "";
  document.getElementById("description").value = data.description || "";
  document.getElementById("ragToggle").checked = !!data.useRag;
  document.getElementById("ragUpload").classList.toggle("hidden", !data.useRag);
  document.getElementById("fewShotToggle").checked = !!data.useFewShot;
  document.getElementById("fewShotContainer").classList.toggle("hidden", !data.useFewShot);
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
