// [src/StudentLoginMain.js] — 로컬 저장 없음(Server-only). 닉네임은 Firestore만 사용.
// - nickname 없거나 nicknameNeedsSetup=true → 자동 모달
// - 저장 시 { nickname, nicknameNeedsSetup:false, updatedAt } 만 서버에 기록
// - 레거시 localStorage 키 사용/승격 전부 제거

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc,
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ===== 상수 ===== */
const MAX_NICK = 20;

/* ===== DOM ===== */
const $ = (s) => document.querySelector(s);
const nickBadge      = $("#nickBadge");
const editNickBtn    = $("#editNickBtn");
const codeInput      = $("#classCodeInput");
const startBtn       = $("#startBtn");
const joinForm       = $("#joinForm");

const nickOverlay    = $("#nickOverlay");
const nickModalInput = $("#nickModalInput");
const nickModalSave  = $("#nickModalSave");

/* ===== Firestore ===== */
async function fetchProfile(uid) {
  try {
    const ref = doc(db, "student_profiles", uid);
    const snap = await getDoc(ref);
    return snap.exists() ? (snap.data() || {}) : {};
  } catch (e) {
    console.warn("fetchProfile:", e?.message || e);
    return {};
  }
}
async function saveNickServer(uid, nickname) {
  try {
    await setDoc(
      doc(db, "student_profiles", uid),
      { nickname, nicknameNeedsSetup: false, updatedAt: Date.now() },
      { merge: true }
    );
  } catch (e) {
    console.warn("saveNickServer:", e?.message || e);
  }
}

/* ===== UI ===== */
function refreshNickUI(nick) {
  if (nickBadge) nickBadge.textContent = (nick || "").trim() || "닉네임 설정 필요";
}
function openNickOverlay(prefill = "") {
  if (!nickOverlay) return;
  if (nickModalInput) nickModalInput.value = (prefill || "").slice(0, MAX_NICK);
  nickOverlay.classList.add("open");
  nickOverlay.setAttribute("aria-hidden", "false");
  setTimeout(() => nickModalInput?.focus(), 0);
}
function closeNickOverlay() {
  if (!nickOverlay) return;
  nickOverlay.classList.remove("open");
  nickOverlay.setAttribute("aria-hidden", "true");
}

/* ===== 1회 모달 ===== */
let pendingResolve = null;
function askNicknameOnce(prefill = "") {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    openNickOverlay(prefill);
  });
}

/* ===== 코드 포맷/검증 ===== */
function normalizeCode(code) {
  return (code || "").trim().toUpperCase();
}
function isValidCode(code) {
  return /^(\d{6}|[A-Z0-9-]{4,24})$/.test(code || "");
}

/* ===== 초기 세팅 ===== */
document.addEventListener("DOMContentLoaded", () => {
  if (codeInput) {
    codeInput.value = "";
    codeInput.setAttribute("autocomplete", "off");
    codeInput.setAttribute("autocapitalize", "off");
    codeInput.setAttribute("autocorrect", "off");
    codeInput.setAttribute("inputmode", "numeric");
    codeInput.setAttribute("name", "one-time-code");
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); onStart(); }
    });
  }

  editNickBtn?.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (!u) { alert("로그인 후 이용해 주세요."); return; }
    const prof    = await fetchProfile(u.uid);
    const prefill = prof.nickname || prof.provisionedDisplayName || "";
    openNickOverlay(prefill);
  });

  nickModalSave?.addEventListener("click", async () => {
    const u = auth.currentUser;
    const nick = (nickModalInput?.value || "").trim().slice(0, MAX_NICK);
    if (!nick) { alert("닉네임을 입력해 주세요."); nickModalInput?.focus(); return; }
    if (u) await saveNickServer(u.uid, nick);
    refreshNickUI(nick);
    closeNickOverlay();
    if (pendingResolve) { pendingResolve(nick); pendingResolve = null; }
  });

  startBtn?.addEventListener("click", onStart);
  joinForm?.addEventListener("submit", (e) => { e.preventDefault(); onStart(); });
});

/* ===== 인증 상태 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return;
  }

  // 서버에서만 닉네임 사용 (로컬 캐시 없음)
  const prof       = await fetchProfile(user.uid);
  const serverNick = (prof.nickname || "").trim().slice(0, MAX_NICK);
  refreshNickUI(serverNick);

  // 닉네임이 없거나 플래그가 켜져 있으면 자동 모달
  if (!serverNick || prof.nicknameNeedsSetup) {
    const prefill = serverNick || prof.provisionedDisplayName || "";
    openNickOverlay(prefill);
  }
});

/* ===== 시작 플로우 ===== */
async function onStart() {
  const u = auth.currentUser;
  if (!u) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return;
  }

  // 1) 코드 검증
  const code = normalizeCode(codeInput?.value || "");
  if (!isValidCode(code)) {
    alert("교사 코드를 확인해 주세요.");
    codeInput?.focus();
    return;
  }

  // 2) 닉네임 확인(없거나 플래그 true면 강제 수집)
  const prof       = await fetchProfile(u.uid);
  let nickname     = (prof.nickname || "").trim().slice(0, MAX_NICK);
  const mustAsk    = !nickname || prof.nicknameNeedsSetup;

  if (mustAsk) {
    const prefill = nickname || prof.provisionedDisplayName || "";
    nickname = await askNicknameOnce(prefill);
    // 저장은 모달 save에서 Firestore에 이미 반영됨
  }

  // 3) access_codes 조회
  let meta = null;
  try {
    const q = query(
      collection(db, "access_codes"),
      where("code", "==", code),
      where("active", "==", true)
    );
    const snap = await getDocs(q);
    const now = new Date();
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    const valid = items
      .filter(it => {
        const exp = it.expiresAt?.toDate ? it.expiresAt.toDate() : (it.expiresAt ? new Date(it.expiresAt) : null);
        return !exp || exp > now;
      })
      .sort((a,b) => {
        const at = a.createdAt?.toDate ? a.createdAt.toDate() : 0;
        const bt = b.createdAt?.toDate ? b.createdAt.toDate() : 0;
        return bt - at;
      });
    meta = valid[0] || null;
  } catch (e) {
    console.warn("access_codes 조회 실패:", e?.message || e);
  }

  if (!meta) { alert("유효하지 않거나 만료된 코드입니다. 교사에게 새 코드를 요청해 주세요."); return; }

  // 4) 라우팅
  const url = new URL("StudentChat.html", location.origin);
  if (meta.chatbotDocId) {
    url.searchParams.set("id", meta.chatbotDocId);
  } else if (meta.assistantId) {
    url.searchParams.set("assistant", meta.assistantId);
    url.searchParams.set("assistantId", meta.assistantId);
  }
  if (meta.teacherUid) url.searchParams.set("teacherUid", meta.teacherUid);
  try {
    localStorage.removeItem("last_student_assistant"); // 남아있다면 청소만
    localStorage.removeItem("last_student_doc");
  } catch {}
  location.href = url.toString();
}
