import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp
} from "firebase/firestore";
import {
  getAuth,
  onAuthStateChanged
} from "firebase/auth";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";
import * as pdfjsLib from "pdfjs-dist";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

// ✅ PDF 텍스트 추출 함수
async function extractTextFromPDF(file) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = async function () {
      const typedarray = new Uint8Array(this.result);
      const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(" ") + "\n";
      }
      resolve(text);
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ✅ 초기 실행
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("userMessage");
  const chatWindow = document.getElementById("chatWindow");
  const imageInput = document.getElementById("imageInput");

  document.getElementById("sendMessage").addEventListener("click", () =>
    onSendMessage(input, chatWindow, imageInput)
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendMessage(input, chatWindow, imageInput);
    }
  });

  // ✅ 수정 모드인 경우 채우기
  const saved = localStorage.getItem("editChatbot");
  if (saved) {
    const data = JSON.parse(saved);
    document.getElementById("chatbotId").value = data.id;
    document.getElementById("subject").value = data.subject;
    document.getElementById("name").value = data.name;
    document.getElementById("description").value = data.description;

    if (data.rag) {
      document.getElementById("ragToggle").checked = true;
      document.getElementById("ragUpload").classList.remove("hidden");
      const link = document.createElement("a");
      link.href = data.ragFileUrl;
      link.target = "_blank";
      link.innerText = data.ragFileName;
      document.getElementById("ragFileLink").appendChild(link);
    }

    if (data.useFewShot) {
      document.getElementById("fewShotToggle").checked = true;
      document.getElementById("fewShotContainer").classList.remove("hidden");
      const area = document.getElementById("examplesArea");
      data.examples.forEach((ex) => {
        const block = document.createElement("div");
        block.className = "example-block";
        const textarea = document.createElement("textarea");
        textarea.className = "example-input";
        textarea.value = ex;
        const delBtn = document.createElement("button");
        delBtn.textContent = "✕";
        delBtn.type = "button";
        delBtn.className = "delete-example";
        delBtn.addEventListener("click", () => block.remove());
        block.appendChild(textarea);
        block.appendChild(delBtn);
        area.appendChild(block);
      });
    }

    if (data.selfConsistency) {
      document.getElementById("selfConsistency").checked = true;
    }

    localStorage.removeItem("editChatbot");
  }

  // ✅ 옵션 토글
  document.getElementById("ragToggle").addEventListener("change", () => {
    document.getElementById("ragUpload").classList.toggle("hidden", !ragToggle.checked);
  });
  document.getElementById("fewShotToggle").addEventListener("change", () => {
    document.getElementById("fewShotContainer").classList.toggle("hidden", !fewShotToggle.checked);
  });

  // ✅ 예시 추가
  document.getElementById("addExample").addEventListener("click", () => {
    const block = document.createElement("div");
    block.className = "example-block";

    const textarea = document.createElement("textarea");
    textarea.className = "example-input";
    textarea.placeholder = "예시를 입력하세요.";

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.type = "button";
    delBtn.className = "delete-example";
    delBtn.addEventListener("click", () => block.remove());

    block.appendChild(textarea);
    block.appendChild(delBtn);
    document.getElementById("examplesArea").appendChild(block);
  });

  // ✅ 저장하기
  document.getElementById("chatbotForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const subject = document.getElementById("subject").value.trim();
    const name = document.getElementById("name").value.trim();
    const description = document.getElementById("description").value.trim();
    const rag = document.getElementById("ragToggle").checked;
    const fewShot = document.getElementById("fewShotToggle").checked;
    const selfConsistency = document.getElementById("selfConsistency").checked;
    const examples = Array.from(document.querySelectorAll(".example-input"))
      .map(el => el.value.trim())
      .filter(Boolean);
    const ragFile = document.getElementById("ragFile").files[0];

    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        alert("로그인이 필요합니다.");
        window.location.href = "LogIn.html";
        return;
      }

      let ragFileUrl = "", ragFileName = "", ragFilePath = "";
      if (rag && ragFile) {
        const filePath = `rag/${user.uid}/${Date.now()}_${ragFile.name}`;
        const fileRef = ref(storage, filePath);
        await uploadBytes(fileRef, ragFile);
        ragFileUrl = await getDownloadURL(fileRef);
        ragFileName = ragFile.name;
        ragFilePath = filePath;
      }

      const data = {
        uid: user.uid,
        subject,
        name,
        description,
        rag,
        ragFileUrl,
        ragFileName,
        ragFilePath,
        useFewShot: fewShot,
        examples,
        selfConsistency,
        createdAt: serverTimestamp()
      };

      const chatbotId = document.getElementById("chatbotId").value;

      try {
        if (chatbotId) {
          const docRef = doc(db, "chatbots", chatbotId);
          await updateDoc(docRef, data);
          alert("챗봇이 수정되었습니다.");
        } else {
          await addDoc(collection(db, "chatbots"), data);
          alert("챗봇이 저장되었습니다.");
        }
        window.location.href = "ChatbotList.html";
      } catch (err) {
        alert("저장 실패: " + err.message);
      }
    });
  });
});

// ✅ 실시간 챗봇 응답
async function onSendMessage(input, chatWindow, imageInput) {
  const msg = input.value.trim();
  const imageFile = imageInput.files[0];
  if (!msg && !imageFile) return;

  appendMessage("user", msg || "[이미지 첨부됨]");
  input.value = "";
  imageInput.value = "";

  const messages = [];

  const systemPrompt = document.getElementById("description").value.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const useRag = document.getElementById("ragToggle").checked;
  const ragFile = document.getElementById("ragFile").files[0];
  if (useRag && ragFile) {
    const pdfText = await extractTextFromPDF(ragFile);
    messages.push({
      role: "system",
      content: `다음은 참고 파일의 내용입니다. 이를 기반으로 질문에 답하세요:\n\n${pdfText.slice(0, 3000)}`
    });
  }

  const useFewShot = document.getElementById("fewShotToggle").checked;
  const fewShotExamples = Array.from(document.querySelectorAll(".example-input"))
    .map(el => el.value.trim())
    .filter(Boolean);
  if (useFewShot) {
    fewShotExamples.forEach((ex) => {
      messages.push({ role: "user", content: ex });
      messages.push({ role: "assistant", content: "(예시 응답)" });
    });
  }

  messages.push({ role: "user", content: msg });

  const useSelfConsistency = document.getElementById("selfConsistency").checked;
  const botMessageEl = appendMessage("bot", "생각 중...");

  try {
    const completions = useSelfConsistency
      ? await Promise.all([sendToOpenAI(messages), sendToOpenAI(messages), sendToOpenAI(messages)])
      : [await sendToOpenAI(messages)];

    const freq = {};
    completions.forEach((reply) => {
      freq[reply] = (freq[reply] || 0) + 1;
    });
    const finalReply = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];

    const html = marked.parse(finalReply);
    botMessageEl.innerHTML = "";
    animateTypingWithMath(botMessageEl, html);
  } catch (err) {
    appendMessage("bot", "❌ 오류 발생: " + err.message);
  }
}

// ✅ OpenAI 전송 함수
async function sendToOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "❗ 응답 오류";
}

// ✅ 메시지 추가 함수
function appendMessage(role, content = "") {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}

// ✅ 애니메이션 타이핑 + 수식 렌더링
function animateTypingWithMath(element, html, delay = 10) {
  let i = 0;
  let temp = "";
  const interval = setInterval(() => {
    temp += html[i];
    element.innerHTML = temp;
    MathJax.typesetPromise([element]);
    i++;
    if (i >= html.length) clearInterval(interval);
    const chatWindow = document.getElementById("chatWindow");
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, delay);
}
