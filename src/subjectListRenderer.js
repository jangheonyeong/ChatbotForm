import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { firebaseConfig } from "../firebaseConfig.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function buildExamplesHtml(examples) {
  if (!examples) return "<li>없음</li>";

  if (Array.isArray(examples) && examples.length > 0) {
    if (typeof examples[0] === "string") {
      return examples
        .map((text, i) => `<li>${i + 1}. ${escapeHtml(text)}</li>`)
        .join("");
    }
    if (
      typeof examples[0] === "object" &&
      examples[0] !== null &&
      "input" in examples[0] &&
      "output" in examples[0]
    ) {
      return examples
        .map(
          (ex, i) =>
            `<li>${i + 1}. ${escapeHtml(ex.input)} → ${escapeHtml(
              ex.output
            )}</li>`
        )
        .join("");
    }
  }

  if (examples && typeof examples === "object") {
    const pairs = Object.entries(examples);
    if (pairs.length > 0) {
      return pairs
        .map(
          ([input, output], i) =>
            `<li>${i + 1}. ${escapeHtml(input)} → ${escapeHtml(output)}</li>`
        )
        .join("");
    }
  }

  return "<li>없음</li>";
}

function buildCardMarkup(data) {
  const name = data.name ?? "이름 없음";
  const description = data.description ?? "설명 없음";
  const ragUsed = data.rag ? "사용" : "미사용";
  const ragFileName = data.ragFileName ?? "없음";
  const ragFileUrl = data.ragFileUrl ?? null;
  const fewShotUsed = data.useFewShot ? "사용" : "미사용";
  const selfConsistencyUsed = data.selfConsistency ? "사용" : "미사용";
  const createdAt =
    data.createdAt?.toDate?.().toLocaleString("ko-KR") ?? "없음";

  const examplesHtml = buildExamplesHtml(data.examples);
  const ragFileHtml = ragFileUrl
    ? `<a href="${escapeHtml(
        ragFileUrl
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        ragFileName
      )}</a>`
    : escapeHtml(ragFileName);

  return `
    <p><strong>이름:</strong> ${escapeHtml(name)}</p>
    <p><strong>설명:</strong> ${escapeHtml(description)}</p>
    <p><strong>RAG 사용:</strong> ${ragUsed}</p>
    <p><strong>RAG 파일:</strong> ${ragFileHtml}</p>
    <p><strong>few-shot 사용:</strong> ${fewShotUsed}</p>
    <p><strong>예시:</strong></p>
    <ul>${examplesHtml}</ul>
    <p><strong>Self-consistency:</strong> ${selfConsistencyUsed}</p>
    <p><strong>요청일시:</strong> ${escapeHtml(createdAt)}</p>
  `;
}

export async function renderSubjectList({
  subject,
  containerId,
  emptyText = "요청된 챗봇이 없습니다."
}) {
  const listContainer = document.getElementById(containerId);
  if (!listContainer) {
    console.warn(`[SubjectList] 컨테이너(${containerId})를 찾을 수 없습니다.`);
    return;
  }

  listContainer.innerHTML = "<p>불러오는 중…</p>";

  try {
    const chatbotRef = collection(db, "chatbots");
    const q = query(chatbotRef, where("subject", "==", subject));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      listContainer.innerHTML = `<p>${emptyText}</p>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const div = document.createElement("div");
      div.className = "chatbot-item";
      div.innerHTML = buildCardMarkup(data);
      fragment.appendChild(div);
    });

    listContainer.innerHTML = "";
    listContainer.appendChild(fragment);
  } catch (error) {
    console.error(`[SubjectList] ${subject} 데이터 로드 실패`, error);
    listContainer.innerHTML = `
      <p>목록을 불러오는 중 오류가 발생했습니다.<br/>
      ${escapeHtml(error?.message || String(error))}</p>
    `;
  }
}

