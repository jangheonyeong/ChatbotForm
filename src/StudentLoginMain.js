// [src/StudentLoginMain.js] — uid별 닉네임 기기간 동기화(서버 우선 + 로컬 캐시)
// - 로그인 시 서버(student_profiles/{uid})에서 닉네임 로드 → 로컬 캐시(UID 스코프) 갱신
// - 닉네임 없으면 최초 1회만 모달 입력 → 서버/로컬 저장
// - 과거 공용 키 'student_nickname' → 최초 로그인 시 UID 스코프 키로 승격(하위 호환)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc,
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ===== 상수/키 ===== */
const MAX_NICK = 20;
const LEGACY_LS_NICK = "student_nickname";           // 과거 공용 키(하위 호환)
const LS_NICK_UID_PREFIX = "student_nickname_uid__";  // UID 스코프 키 prefix

/* ===== DOM ===== */
const $ = (s) => document.querySelector(s);
const nickBadge      = $("#nickBadge");
const editNickBtn    = $("#editNickBtn");
const codeInput      = $("#classCodeInput");
const startBtn       = $("#startBtn");
const joinForm       = $("#joinForm");           // ★ 추가: Form 참조

const nickOverlay    = $("#nickOverlay");
const nickModalInput = $("#nickModalInput");
const nickModalSave  = $("#nickModalSave");

/* ===== 유틸: UID 스코프 로컬 캐시 ===== */
const uidKey = (uid) => `${LS_NICK_UID_PREFIX}${uid}`;
function loadNickLocal(uid) {
  if (!uid) return "";
  return (localStorage.getItem(uidKey(uid)) || "").trim().slice(0, MAX_NICK);
}
function saveNickLocal(uid, nickname) {
  if (!uid || !nickname) return;
  localStorage.setItem(uidKey(uid), nickname);
}

/* ===== Firestore 접근 ===== */
async function fetchNickServer(uid) {
  try {
    const ref = doc(db, "student_profiles", uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return "";
    return (snap.data()?.nickname || "").trim().slice(0, MAX_NICK);
  } catch (e) {
    console.warn("fetchNickServer:", e?.message || e);
    return "";
  }
}
async function saveNickServer(uid, nickname) {
  try {
    await setDoc(
      doc(db, "student_profiles", uid),
      { nickname, updatedAt: Date.now() },
      { merge: true }
    );
  } catch (e) {
    console.warn("saveNickServer:", e?.message || e);
  }
}

/* ===== 닉네임 UI(디자인 변경 없음) ===== */
function refreshNickUI(nick) {
  if (nickBadge) nickBadge.textContent = nick || "닉네임 설정 필요";
}
function openNickOverlay(prefill = "") {
  if (!nickOverlay) return;
  if (nickModalInput) nickModalInput.value = prefill;
  nickOverlay.classList.add("open");
  nickOverlay.setAttribute("aria-hidden", "false");
  setTimeout(() => nickModalInput?.focus(), 0);
}
function closeNickOverlay() {
  if (!nickOverlay) return;
  nickOverlay.classList.remove("open");
  nickOverlay.setAttribute("aria-hidden", "true");
}

/** 모달 1회 수집 */
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
  // 브라우저 자동완성/대문자화 차단
  if (codeInput) {
    codeInput.value = "";
    codeInput.setAttribute("autocomplete", "off");
    codeInput.setAttribute("autocapitalize", "off");
    codeInput.setAttribute("autocorrect", "off");
    codeInput.setAttribute("inputmode", "numeric");
    codeInput.setAttribute("name", "one-time-code");

    // ★ Enter 키로 시작 가능
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();     // 기본 제출 방지
        onStart();              // 버튼 클릭과 동일 동작
      }
    });
  }

  // 상단 ✏️ → 닉네임 수정(서버/로컬 동시 반영)
  editNickBtn?.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (!u) { alert("로그인 후 이용해 주세요."); return; }
    const localNick = loadNickLocal(u.uid);
    const prefill = localNick || (await fetchNickServer(u.uid)) || "";
    openNickOverlay(prefill);
  });

  // 모달 저장 → 서버/로컬 동시 저장
  nickModalSave?.addEventListener("click", async () => {
    const u = auth.currentUser;
    const nick = (nickModalInput?.value || "").trim().slice(0, MAX_NICK);
    if (!nick) { alert("닉네임을 입력해 주세요."); nickModalInput?.focus(); return; }

    if (u) {
      saveNickLocal(u.uid, nick);
      await saveNickServer(u.uid, nick);
    }
    refreshNickUI(nick);
    closeNickOverlay();

    if (pendingResolve) {
      pendingResolve(nick);
      pendingResolve = null;
    }
  });

  // 시작 버튼 클릭 → 기존 로직 유지
  startBtn?.addEventListener("click", onStart);

  // ★ 폼 제출(Enter 등) 대비 — 중복 호출 방지 위해 여기서도 onStart만 호출
  joinForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    onStart();
  });
});

/* ===== 인증 상태 변화: 서버 → 로컬(UID 스코프) 동기화 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return;
  }

  // 0) 하위 호환: 과거 공용 키 → UID 스코프 승격
  const legacy = (localStorage.getItem(LEGACY_LS_NICK) || "").trim().slice(0, MAX_NICK);
  const localNick = loadNickLocal(user.uid);

  if (legacy && !localNick) {
    // 로컬 승격
    saveNickLocal(user.uid, legacy);
    refreshNickUI(legacy);
    // 서버에도 없으면 서버로 승격
    const serverNick = await fetchNickServer(user.uid);
    if (!serverNick) await saveNickServer(user.uid, legacy);
  }

  // 1) 서버에서 최신 닉네임 로드 → 로컬 반영
  const serverNick = await fetchNickServer(user.uid);
  if (serverNick) {
    saveNickLocal(user.uid, serverNick);
    refreshNickUI(serverNick);
    return;
  }

  // 2) 서버에 없으면 로컬 캐시라도 표시(없으면 "닉네임 설정 필요")
  const cached = loadNickLocal(user.uid);
  refreshNickUI(cached);
});

/* ===== 진행 플로우 ===== */
async function onStart() {
  const u = auth.currentUser;
  if (!u) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return;
  }

  // 1) 교사 코드 확인
  const code = normalizeCode(codeInput?.value || "");
  if (!isValidCode(code)) {
    alert("교사 코드를 확인해 주세요.");
    codeInput?.focus();
    return;
  }

  // 2) 닉네임 확보(없을 때만 1회 모달 → 저장은 모달 핸들러에서 수행)
  let nickname = loadNickLocal(u.uid) || (await fetchNickServer(u.uid));
  if (!nickname) {
    nickname = await askNicknameOnce("");
    // 저장은 모달 save 이벤트에서 이미 서버/로컬 동시 처리됨
  }

  // 3) access_codes에서 유효 코드 메타 조회(기존 로직 유지)
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
        const bt = b.createdAt?.toDate ? b.createdAt.toDate : 0;
        return bt - at;
      });

    meta = valid[0] || null;
  } catch (e) {
    console.warn("access_codes 조회 실패:", e?.message || e);
  }

  if (!meta) {
    alert("유효하지 않거나 만료된 코드입니다. 교사에게 새 코드를 요청해 주세요.");
    return;
  }

  // 4) StudentChat으로 라우팅(문서 ID 우선)
  const url = new URL("StudentChat.html", location.origin);
  if (meta.chatbotDocId) {
    url.searchParams.set("id", meta.chatbotDocId);
  } else if (meta.assistantId) {
    url.searchParams.set("assistant", meta.assistantId);
    url.searchParams.set("assistantId", meta.assistantId);
  }
  if (meta.teacherUid) url.searchParams.set("teacherUid", meta.teacherUid);

  // 혼선 방지용 캐시 제거(기존 유지)
  try {
    localStorage.removeItem("last_student_assistant");
    localStorage.removeItem("last_student_doc");
  } catch {}

  location.href = url.toString();
}
