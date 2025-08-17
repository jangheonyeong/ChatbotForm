// 학생 시작 페이지: 닉네임 확인/저장 후 지정한 Assistants 챗봇으로 이동
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
  const cleaned = nick.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  if (!cleaned) throw new Error("닉네임을 입력해주세요.");
  localStorage.setItem(NICK_KEY, cleaned);
  ensureGuestId();
  return cleaned;
}

// asst_ 로 시작하는 OpenAI Assistants ID 형태만 허용
function isValidAssistantId(id) {
  return /^asst_[A-Za-z0-9]+$/.test(id.trim());
}

// 학생용 챗봇 페이지로 이동 (필요 시 파일명만 교체하세요)
function gotoAssistant(asstId) {
  const target = `StudentChat.html?assistant=${encodeURIComponent(asstId)}`;
  window.location.href = target;
}

// 닉네임 입력칸 잠금/표시 상태 반영
function lockNicknameUI(name) {
  nicknameEl.value = name;
  nicknameEl.readOnly = true;
  nicknameEl.classList.add("readonly");
  saveBtn.disabled = true;
  nickStatusEl.textContent = `이 닉네임으로 고정됨`;
}

function unlockNicknameUI() {
  nicknameEl.readOnly = false;
  nicknameEl.classList.remove("readonly");
  saveBtn.disabled = false;
  nickStatusEl.textContent = "";
}

function init() {
  // ✅ 닉네임이 있으면 잠그고, 없으면 입력 받기
  const existing = loadNickname();
  if (existing) {
    lockNicknameUI(existing);
  } else {
    unlockNicknameUI();
  }

  nicknameEl.addEventListener("input", () => {
    if (nicknameEl.value.length > MAX_LEN) {
      nicknameEl.value = nicknameEl.value.slice(0, MAX_LEN);
    }
  });

  // 닉네임 저장(첫 저장 이후 자동 잠금)
  saveBtn.addEventListener("click", () => {
    try {
      if (loadNickname()) {
        // 이미 고정됨
        alert("이미 저장된 닉네임은 변경할 수 없습니다. (초기화로 재설정 가능)");
        return;
      }
      const saved = saveNickname(nicknameEl.value);
      lockNicknameUI(saved);
      alert(`닉네임이 저장되었습니다: ${saved}`);
    } catch (e) {
      alert(e.message || e);
    }
  });

  // 이 챗봇으로 시작: Assistants ID 검증 → (닉네임 미설정이면 저장) → 이동
  startBtn.addEventListener("click", () => {
    try {
      const asstId = (assistantIdEl.value || "").trim();
      if (!isValidAssistantId(asstId)) {
        alert("올바른 Assistants ID를 입력하세요. (예: asst_로 시작)");
        assistantIdEl.focus();
        return;
      }

      // 닉네임이 아직 없다면 지금 저장하고 잠금
      if (!loadNickname()) {
        const saved = saveNickname(nicknameEl.value);
        lockNicknameUI(saved);
      }

      gotoAssistant(asstId);
    } catch (e) {
      alert(e.message || e);
    }
  });

  // 닉네임 초기화 (잠금 해제)
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(NICK_KEY);
    localStorage.removeItem(ID_KEY);
    // 초기 상태로 새로고침
    location.reload();
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
