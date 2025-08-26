// 저장 키
const NICK_KEY = "guestNickname";
const ID_KEY   = "guestId";
const ASST_KEY = "studentAssistantId"; // (있으면 같이 전달)
const CODE_KEY = "classCode";
const MAX_LEN  = 20;

const $ = (s) => document.querySelector(s);

// 상단 닉네임 표시/수정
const nickBadge    = $("#nickBadge");
const editNickBtn  = $("#editNickBtn");

// 교사 코드
const classCodeInput = $("#classCodeInput");

// 시작 버튼
const startBtn = $("#startBtn");

// 닉네임 오버레이
const nickOverlay    = $("#nickOverlay");
const nickModalInput = $("#nickModalInput");
const nickModalSave  = $("#nickModalSave");

/* ---------- 유틸 ---------- */
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
  return nick ? nick.slice(0, MAX_LEN) : "";
}
function saveNickname(nick) {
  const cleaned = (nick || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  if (!cleaned) throw new Error("닉네임을 입력해주세요.");
  localStorage.setItem(NICK_KEY, cleaned);
  ensureGuestId();
  return cleaned;
}
function refreshNickUI() {
  const saved = loadNickname();
  nickBadge.textContent = saved ? saved : "닉네임 설정 필요";
}
function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}
function normalizeCode(code) {
  return (code || "").trim().toUpperCase();
}
// 영문 대/소문자, 숫자, 하이픈 4~24자 (선호 형식에 맞춰 조정 가능)
function isValidClassCode(code) {
  return /^[A-Z0-9-]{4,24}$/.test(code);
}
function isValidAssistantId(id) {
  return /^asst_[A-Za-z0-9]+$/.test((id || "").trim());
}

/* 이동: code는 필수, assistant는 있으면 함께 */
function gotoChatWith(code, maybeAsst) {
  const params = new URLSearchParams();
  params.set("code", code);
  if (maybeAsst && isValidAssistantId(maybeAsst)) {
    params.set("assistant", maybeAsst);
  }
  window.location.href = `StudentChat.html?${params.toString()}`;
}

/* ---------- 초기화 ---------- */
function init() {
  // assistant: URL → localStorage (UI에 노출하지 않음)
  const fromUrl = getQueryParam("assistant");
  const savedAsst = localStorage.getItem(ASST_KEY) || "";
  if (fromUrl && isValidAssistantId(fromUrl)) {
    localStorage.setItem(ASST_KEY, fromUrl);
  } else if (savedAsst) {
    // 그대로 보존
  }

  // 코드 프리필
  const savedCode = localStorage.getItem(CODE_KEY) || "";
  if (savedCode) classCodeInput.value = savedCode;

  // 닉네임 상태/오버레이
  const existing = loadNickname();
  refreshNickUI();
  if (!existing) openNickOverlay();

  // 코드 입력창에서 Enter → 바로 시작
  classCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startBtn.click();
    }
  });

  // 시작 버튼: 닉네임 확인 → 코드 검증/저장 → 이동
  startBtn.addEventListener("click", () => {
    try {
      const nick = loadNickname();
      if (!nick) { openNickOverlay(); return; }

      const normalized = normalizeCode(classCodeInput.value);
      if (!isValidClassCode(normalized)) {
        alert("교사 코드를 확인해주세요.");
        classCodeInput.focus();
        return;
      }
      localStorage.setItem(CODE_KEY, normalized);

      const asst = localStorage.getItem(ASST_KEY) || getQueryParam("assistant") || "";
      gotoChatWith(normalized, asst);
    } catch (e) {
      alert(e.message || e);
    }
  });

  // 상단 닉네임 수정
  editNickBtn.addEventListener("click", openNickOverlay);

  // 오버레이 저장
  nickModalSave.addEventListener("click", () => {
    try {
      saveNickname(nickModalInput.value);
      refreshNickUI();
      closeNickOverlay();
    } catch (e) {
      alert(e.message || e);
      nickModalInput.focus();
    }
  });
  nickModalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nickModalSave.click();
    }
  });
}

/* ---------- 오버레이 ---------- */
function openNickOverlay() {
  nickModalInput.value = loadNickname() || "";
  nickOverlay.classList.add("open");
  nickOverlay.setAttribute("aria-hidden", "false");
  setTimeout(() => nickModalInput.focus(), 0);
}
function closeNickOverlay() {
  nickOverlay.classList.remove("open");
  nickOverlay.setAttribute("aria-hidden", "true");
}

init();
