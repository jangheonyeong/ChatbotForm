// 학생 시작 페이지: 닉네임 입력/저장 후 지정한 Assistants 챗봇으로 이동
const NICK_KEY = "guestNickname";
const ID_KEY = "guestId";
const MAX_LEN = 20;

const $ = (s) => document.querySelector(s);
const nicknameEl = $("#nickname");
const assistantIdEl = $("#assistantId");
const saveBtn = $("#saveBtn");
const startBtn = $("#startBtn");
const resetBtn = $("#resetBtn");
const nickStatusEl = $("#nickStatus");

// 간단 랜덤 guestId 생성
function ensureGuestId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    const r = crypto.getRandomValues(new Uint32Array(2));
    id = `g_${Date.now().toString(36)}_${r[0].toString(36)}${r[1].toString(36)}`;
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

function loadNickname() {
  const nick = (localStorage.getItem(NICK_KEY) || "").trim();
  if (!nick) return "";
  return nick.slice(0, MAX_LEN);
}

function saveNickname(nick) {
  const cleaned = (nick || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  if (!cleaned) throw new Error("닉네임을 입력해주세요.");
  localStorage.setItem(NICK_KEY, cleaned);
  ensureGuestId();
  return cleaned;
}

// asst_ 로 시작하는 OpenAI Assistants ID 형태만 허용
function isValidAssistantId(id) {
  return /^asst_[A-Za-z0-9]+$/.test((id || "").trim());
}

// 학생용 챗봇 페이지로 이동 (필요 시 파일명만 교체하세요)
function gotoAssistant(asstId) {
  const target = `StudentChat.html?assistant=${encodeURIComponent(asstId)}`;
  window.location.href = target;
}

// 상태 라벨 업데이트
function updateNickStatus() {
  const saved = loadNickname();
  if (saved) {
    nickStatusEl.textContent = `저장됨: ${saved}`;
  } else {
    nickStatusEl.textContent = "";
  }
}

function init() {
  // 기존 저장값을 입력칸에 프리필(편집 가능)
  const existing = loadNickname();
  if (existing) nicknameEl.value = existing;
  updateNickStatus();

  // 길이 제한
  nicknameEl.addEventListener("input", () => {
    if (nicknameEl.value.length > MAX_LEN) {
      nicknameEl.value = nicknameEl.value.slice(0, MAX_LEN);
    }
  });

  // 닉네임 저장(항상 덮어쓰기 가능)
  saveBtn.addEventListener("click", () => {
    try {
      const saved = saveNickname(nicknameEl.value);
      nicknameEl.value = saved; // 정규화된 값 반영
      updateNickStatus();
      alert(`닉네임이 저장되었습니다: ${saved}`);
    } catch (e) {
      alert(e.message || e);
    }
  });

  // 이 챗봇으로 시작: 닉네임 확인 → 저장 → Assistants로 이동
  startBtn.addEventListener("click", () => {
    try {
      const asstId = (assistantIdEl.value || "").trim();
      if (!isValidAssistantId(asstId)) {
        alert("올바른 Assistants ID를 입력하세요. (예: asst_로 시작)");
        assistantIdEl.focus();
        return;
      }
      const nickInput = (nicknameEl.value || "").trim();
      if (!nickInput) {
        alert("닉네임을 입력한 뒤 시작하세요.");
        nicknameEl.focus();
        return;
      }
      // 저장하고 이동
      const saved = saveNickname(nickInput);
      nicknameEl.value = saved;
      updateNickStatus();
      gotoAssistant(asstId);
    } catch (e) {
      alert(e.message || e);
    }
  });

  // 닉네임 초기화
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(NICK_KEY);
    localStorage.removeItem(ID_KEY);
    nicknameEl.value = "";
    updateNickStatus();
    nicknameEl.focus();
  });

  // Enter로 바로 시작 (Assistant ID가 채워져 있어야 함)
  nicknameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startBtn.click();
    }
  });
  assistantIdEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startBtn.click();
    }
  });
}

init();
