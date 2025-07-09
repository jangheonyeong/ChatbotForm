import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "../firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const subjectGrid = document.getElementById("subjectGrid");

const subjectOrder = ["수학", "국어", "영어", "교육", "불어", "물리", "지리", "생물"];

function formatDate(timestamp) {
  if (!timestamp || !timestamp.toDate) return "-";
  const date = timestamp.toDate();
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

async function loadChatbots() {
  try {
    const snapshot = await getDocs(collection(db, "chatbots"));
    if (snapshot.empty) {
      subjectGrid.innerHTML = "<p>등록된 챗봇이 없습니다.</p>";
      return;
    }

    // 1단계: 교과 → 2단계: 이름
    const grouped = {};
    snapshot.forEach(doc => {
      const data = doc.data();
      const subject = data.subject || "기타";
      const name = data.name || "미입력";

      if (!grouped[subject]) {
        grouped[subject] = {};
      }
      if (!grouped[subject][name]) {
        grouped[subject][name] = [];
      }
      grouped[subject][name].push(data);
    });

    subjectGrid.innerHTML = "";

    subjectOrder.forEach(subject => {
      const column = document.createElement("div");
      column.className = "subject-column";

      const title = document.createElement("h2");
      title.textContent = subject;
      column.appendChild(title);

      const subjectGroup = grouped[subject];
      if (subjectGroup) {
        for (const name in subjectGroup) {
          const chatbotGroup = document.createElement("div");
          chatbotGroup.className = "chatbot-group";

          const groupTitle = document.createElement("h3");
          groupTitle.textContent = `이름: ${name}`;
          chatbotGroup.appendChild(groupTitle);

          subjectGroup[name].forEach(data => {
            const item = document.createElement("div");
            item.className = "chatbot-item";

            const useRAG = toBool(data.rag);
            const useFewShot = toBool(data.useFewShot);
            const useSelfConsistency = toBool(data.selfConsistency);

            const ragFileLink = data.ragFileUrl
              ? `<a href="${data.ragFileUrl}" target="_blank">${data.ragFileName || "RAG 파일 보기"}</a>`
              : "없음";

            const examples = Array.isArray(data.examples) && data.examples.length > 0
              ? `<ul>${data.examples.map(ex => `<li>${ex}</li>`).join("")}</ul>`
              : "없음";

            item.innerHTML = `
              <strong>설명:</strong> ${data.description || "없음"}<br/>
              <strong>RAG:</strong> ${useRAG ? "✔ 사용" : "✘ 미사용"}<br/>
              <strong>RAG 파일:</strong> ${ragFileLink}<br/>
              <strong>few-shot:</strong> ${useFewShot ? "✔ 사용" : "✘ 미사용"}<br/>
              <strong>few-shot 예시:</strong> ${examples}<br/>
              <strong>self-consistency:</strong> ${useSelfConsistency ? "✔ 사용" : "✘ 미사용"}<br/>
              <strong>작성일:</strong> ${formatDate(data.createdAt)}<br/>
            `;
            chatbotGroup.appendChild(item);
          });

          column.appendChild(chatbotGroup);
        }
      } else {
        column.innerHTML += "<p>없음</p>";
      }

      subjectGrid.appendChild(column);
    });
  } catch (error) {
    subjectGrid.innerHTML = "<p>챗봇 목록을 불러오는 데 실패했습니다.</p>";
    console.error("Error fetching chatbots:", error);
  }
}

loadChatbots();
