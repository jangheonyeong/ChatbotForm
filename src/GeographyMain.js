import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { firebaseConfig } from "../firebaseConfig.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const listContainer = document.getElementById("geographyList");

async function loadGeographyChatbots() {
  const chatbotRef = collection(db, "chatbots");
  const q = query(chatbotRef, where("subject", "==", "지리"));
  const querySnapshot = await getDocs(q);

  if (querySnapshot.empty) {
    listContainer.innerHTML = "<p>요청된 챗봇이 없습니다.</p>";
    return;
  }

  querySnapshot.forEach((doc) => {
    const data = doc.data();

    const name = data.name ?? "이름 없음";
    const description = data.description ?? "설명 없음";
    const ragUsed = data.rag ? "사용" : "미사용";
    const ragFileName = data.ragFileName ?? "없음";
    const ragFileUrl = data.ragFileUrl ?? null;
    const fewShotUsed = data.useFewShot ? "사용" : "미사용";
    const selfConsistencyUsed = data.selfConsistency ? "사용" : "미사용";
    const createdAt = data.createdAt?.toDate().toLocaleString("ko-KR") ?? "없음";

    let examplesHtml = "<li>없음</li>";
    const examples = data.examples;

    if (Array.isArray(examples) && examples.length > 0) {
      if (typeof examples[0] === "string") {
        examplesHtml = examples
          .map((text, i) => `<li>${i + 1}. ${text}</li>`)
          .join("");
      } else if (
        typeof examples[0] === "object" &&
        examples[0] !== null &&
        "input" in examples[0] &&
        "output" in examples[0]
      ) {
        examplesHtml = examples
          .map((ex, i) => `<li>${i + 1}. ${ex.input} → ${ex.output}</li>`)
          .join("");
      }
    } else if (examples && typeof examples === "object") {
      const pairs = Object.entries(examples);
      if (pairs.length > 0) {
        examplesHtml = pairs
          .map(([input, output], i) => `<li>${i + 1}. ${input} → ${output}</li>`)
          .join("");
      }
    }

    const ragFileHtml = ragFileUrl
      ? `<a href="${ragFileUrl}" target="_blank" rel="noopener noreferrer">${ragFileName}</a>`
      : ragFileName;

    const div = document.createElement("div");
    div.className = "chatbot-item";
    div.innerHTML = `
      <p><strong>이름:</strong> ${name}</p>
      <p><strong>설명:</strong> ${description}</p>
      <p><strong>RAG 사용:</strong> ${ragUsed}</p>
      <p><strong>RAG 파일:</strong> ${ragFileHtml}</p>
      <p><strong>few-shot 사용:</strong> ${fewShotUsed}</p>
      <p><strong>예시:</strong></p>
      <ul>${examplesHtml}</ul>
      <p><strong>Self-consistency:</strong> ${selfConsistencyUsed}</p>
      <p><strong>요청일시:</strong> ${createdAt}</p>
    `;
    listContainer.appendChild(div);
  });
}

loadGeographyChatbots();
