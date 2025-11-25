// [src/StudentLoginMain.js] — 챗봇 선택 및 대화 시작
// - 닉네임은 localStorage의 last_student_id 사용
// - 챗봇 목록에서 + 버튼 클릭 시 StudentChat.html로 이동

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc,
  collection, query, getDocs, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

/* ===== Firebase ===== */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ===== 상수 ===== */
const LAST_STUDENT_ID_KEY = "last_student_id";

/* ===== DOM ===== */
const $ = (s) => document.querySelector(s);
const chatbotsList   = $("#chatbotsList");
const userInfo       = $("#userInfo");

/* ===== 현재 선택된 챗봇 ===== */
let selectedChatbotId = null;
let expandedChatbotId = null; // 펼쳐진 챗봇 ID


/* ===== Chatbots 목록 조회 ===== */
async function loadChatbots() {
  try {
    const q = query(
      collection(db, "chatbots"),
      orderBy("name", "asc")
    );
    const snap = await getDocs(q);
    const chatbots = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data.name) {
        chatbots.push({ id: doc.id, name: data.name });
      }
    });
    renderChatbots(chatbots);
  } catch (e) {
    console.warn("loadChatbots:", e?.message || e);
    if (chatbotsList) {
      chatbotsList.innerHTML = '<div class="chatbot-item" style="color: var(--sidebar-text-muted);">챗봇 목록을 불러올 수 없습니다.</div>';
    }
  }
}

function renderChatbots(chatbots) {
  if (!chatbotsList) return;
  
  if (chatbots.length === 0) {
    chatbotsList.innerHTML = `
      <div class="chatbot-item-wrapper empty-card">
        <div class="chatbot-item">
          <span class="chatbot-item-name">등록된 챗봇이 없습니다.</span>
        </div>
      </div>
    `;
    return;
  }
  
  chatbotsList.innerHTML = chatbots.map(cb => {
    const isExpanded = expandedChatbotId === cb.id;
    return `
      <div class="chatbot-item-wrapper" data-chatbot-id="${cb.id}">
        <div class="chatbot-item ${selectedChatbotId === cb.id ? 'active' : ''}" data-chatbot-id="${cb.id}">
          <button class="chatbot-expand-btn ${isExpanded ? 'expanded' : ''}" data-chatbot-id="${cb.id}" title="대화 목록">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 9L2 5H10L6 9Z" fill="currentColor"/>
            </svg>
          </button>
          <span class="chatbot-item-name">${escapeHtml(cb.name)}</span>
          <button class="chatbot-item-btn" data-chatbot-id="${cb.id}" title="대화 시작">+</button>
        </div>
        <div class="chatbot-conversations ${isExpanded ? 'expanded' : ''}" data-chatbot-id="${cb.id}">
          <div class="conversations-loading">로딩 중...</div>
        </div>
      </div>
    `;
  }).join('');
  
  // 화살표 버튼 클릭 이벤트 바인딩
  chatbotsList.querySelectorAll('.chatbot-expand-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chatbotId = btn.getAttribute('data-chatbot-id');
      await toggleConversations(chatbotId);
    });
  });
  
  // + 버튼 클릭 이벤트 바인딩
  chatbotsList.querySelectorAll('.chatbot-item-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chatbotId = btn.getAttribute('data-chatbot-id');
      startChatWithChatbot(chatbotId);
    });
  });
  
  // 이미 펼쳐진 챗봇이 있으면 대화 목록 로드
  if (expandedChatbotId) {
    loadConversations(expandedChatbotId);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ===== 사용자 정보 표시 ===== */
function loadUserInfo() {
  try {
    const studentId = localStorage.getItem(LAST_STUDENT_ID_KEY);
    if (!userInfo) return;
    
    if (studentId) {
      const role = localStorage.getItem("user_role") || "student";
      userInfo.innerHTML = `
        <strong>${role === "student" ? "학생" : "교사"}</strong>
        <span>ID: ${escapeHtml(studentId)}</span>`;
    } else {
      userInfo.innerHTML = `
        <strong>학생</strong>
        <span>로그인 정보 없음</span>`;
    }
  } catch (e) {
    console.warn("loadUserInfo:", e?.message || e);
  }
}

/* ===== 대화 목록 토글 ===== */
async function toggleConversations(chatbotId) {
  if (expandedChatbotId === chatbotId) {
    // 닫기
    expandedChatbotId = null;
    const wrapper = chatbotsList?.querySelector(`[data-chatbot-id="${chatbotId}"]`);
    if (wrapper) {
      const expandBtn = wrapper.querySelector('.chatbot-expand-btn');
      const conversationsDiv = wrapper.querySelector('.chatbot-conversations');
      if (expandBtn) expandBtn.classList.remove('expanded');
      if (conversationsDiv) conversationsDiv.classList.remove('expanded');
    }
  } else {
    // 기존 펼쳐진 것 닫기
    if (expandedChatbotId) {
      const oldWrapper = chatbotsList?.querySelector(`[data-chatbot-id="${expandedChatbotId}"]`);
      if (oldWrapper) {
        const oldExpandBtn = oldWrapper.querySelector('.chatbot-expand-btn');
        const oldConversationsDiv = oldWrapper.querySelector('.chatbot-conversations');
        if (oldExpandBtn) oldExpandBtn.classList.remove('expanded');
        if (oldConversationsDiv) oldConversationsDiv.classList.remove('expanded');
      }
    }
    
    // 새로 펼치기
    expandedChatbotId = chatbotId;
    const wrapper = chatbotsList?.querySelector(`[data-chatbot-id="${chatbotId}"]`);
    if (wrapper) {
      const expandBtn = wrapper.querySelector('.chatbot-expand-btn');
      const conversationsDiv = wrapper.querySelector('.chatbot-conversations');
      if (expandBtn) expandBtn.classList.add('expanded');
      if (conversationsDiv) conversationsDiv.classList.add('expanded');
    }
    
    await loadConversations(chatbotId);
  }
}

/* ===== 대화 목록 로드 ===== */
async function loadConversations(chatbotId) {
  const wrapper = chatbotsList?.querySelector(`[data-chatbot-id="${chatbotId}"]`);
  const conversationsDiv = wrapper?.querySelector('.chatbot-conversations');
  if (!conversationsDiv) return;
  
  try {
    conversationsDiv.innerHTML = '<div class="conversations-loading">로딩 중...</div>';
    
    // 현재 사용자의 대화만 조회 (studentNickname = localStorage의 last_student_id)
    const currentStudentId = localStorage.getItem(LAST_STUDENT_ID_KEY) || "";
    if (!currentStudentId) {
      conversationsDiv.innerHTML = '<div class="conversations-empty">학생 ID를 찾을 수 없습니다.</div>';
      return;
    }

    const q = query(
      collection(db, "student_conversations"),
      where("chatbotDocId", "==", chatbotId),
      where("studentNickname", "==", currentStudentId),
      orderBy("createdAt", "desc")
    );
    
    const snap = await getDocs(q);
    const conversations = [];
    snap.forEach(doc => {
      const data = doc.data();
      conversations.push({
        id: doc.id,
        createdAt: data.createdAt,
        studentNickname: data.studentNickname || ""
      });
    });
    
    if (conversations.length === 0) {
      conversationsDiv.innerHTML = '<div class="conversations-empty">대화 내역이 없습니다.</div>';
      return;
    }
    
    conversationsDiv.innerHTML = conversations.map(conv => {
      const dateStr = formatDate(conv.createdAt);
      return `
        <div class="conversation-item" data-conv-id="${conv.id}" data-chatbot-id="${chatbotId}">
          <span class="conversation-date">${escapeHtml(dateStr)}</span>
        </div>
      `;
    }).join('');
    
    // 대화 항목 클릭 이벤트
    conversationsDiv.querySelectorAll('.conversation-item').forEach(item => {
      item.addEventListener('click', () => {
        const convId = item.getAttribute('data-conv-id');
        const cbId = item.getAttribute('data-chatbot-id');
        openConversation(cbId, convId);
      });
    });
    
  } catch (e) {
    console.error("loadConversations:", e?.message || e);
    conversationsDiv.innerHTML = '<div class="conversations-error">대화 목록을 불러올 수 없습니다.</div>';
  }
}

/* ===== 날짜 포맷팅 (년, 월, 일만) ===== */
function formatDate(timestamp) {
  if (!timestamp) return "날짜 없음";
  
  try {
    let date;
    if (timestamp.toDate) {
      date = timestamp.toDate();
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else {
      date = new Date(timestamp);
    }
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${year}년 ${month}월 ${day}일`;
  } catch (e) {
    return "날짜 없음";
  }
}

/* ===== 대화 열기 ===== */
async function openConversation(chatbotId, conversationId) {
  if (!chatbotId || !conversationId) return;
  
  try {
    // 챗봇 정보 가져오기
    const chatbotRef = doc(db, "chatbots", chatbotId);
    const chatbotSnap = await getDoc(chatbotRef);
    
    if (!chatbotSnap.exists()) {
      alert("챗봇을 찾을 수 없습니다.");
      return;
    }
    
    const chatbotData = chatbotSnap.data();
    
    // StudentChat.html로 이동 (conversationId 파라미터 추가)
    const url = new URL("StudentChat.html", location.origin);
    url.searchParams.set("id", chatbotId);
    url.searchParams.set("convId", conversationId);
    
    if (chatbotData.assistantId) {
      url.searchParams.set("assistant", chatbotData.assistantId);
      url.searchParams.set("assistantId", chatbotData.assistantId);
    }
    
    if (chatbotData.name) {
      url.searchParams.set("name", chatbotData.name);
    }
    
    if (chatbotData.subject) {
      url.searchParams.set("subject", chatbotData.subject);
    }
    
    if (chatbotData.assistantModelSnapshot) {
      url.searchParams.set("model", chatbotData.assistantModelSnapshot);
    }
    
    if (chatbotData.ownerUid || chatbotData.uid) {
      url.searchParams.set("teacherUid", chatbotData.ownerUid || chatbotData.uid);
    }
    
    location.href = url.toString();
  } catch (e) {
    console.error("openConversation:", e?.message || e);
    alert("대화를 열는 중 오류가 발생했습니다.");
  }
}

/* ===== 챗봇과 대화 시작 ===== */
async function startChatWithChatbot(chatbotId) {
  if (!chatbotId) return;
  
  try {
    // 챗봇 정보 가져오기
    const chatbotRef = doc(db, "chatbots", chatbotId);
    const chatbotSnap = await getDoc(chatbotRef);
    
    if (!chatbotSnap.exists()) {
      alert("챗봇을 찾을 수 없습니다.");
      return;
    }
    
    const chatbotData = chatbotSnap.data();
    
    // StudentChat.html로 이동
    const url = new URL("StudentChat.html", location.origin);
    url.searchParams.set("id", chatbotId);
    
    if (chatbotData.assistantId) {
      url.searchParams.set("assistant", chatbotData.assistantId);
      url.searchParams.set("assistantId", chatbotData.assistantId);
    }
    
    if (chatbotData.name) {
      url.searchParams.set("name", chatbotData.name);
    }
    
    if (chatbotData.subject) {
      url.searchParams.set("subject", chatbotData.subject);
    }
    
    if (chatbotData.assistantModelSnapshot) {
      url.searchParams.set("model", chatbotData.assistantModelSnapshot);
    }
    
    if (chatbotData.ownerUid || chatbotData.uid) {
      url.searchParams.set("teacherUid", chatbotData.ownerUid || chatbotData.uid);
    }
    
    // StudentChat.html로 이동
    location.href = url.toString();
  } catch (e) {
    console.error("startChatWithChatbot:", e?.message || e);
    alert("챗봇을 시작하는 중 오류가 발생했습니다.");
  }
}

/* ===== 인증 상태 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    const next = encodeURIComponent(location.href);
    location.replace(`index.html?next=${next}`);
    return;
  }

  // chatbots 목록 및 사용자 정보 로드
  loadChatbots();
  loadUserInfo();
});
