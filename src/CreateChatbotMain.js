import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "../firebaseConfig.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);

const ragToggle = document.getElementById('ragToggle');
const ragUpload = document.getElementById('ragUpload');
const fewShotToggle = document.getElementById('fewShotToggle');
const fewShotContainer = document.getElementById('fewShotContainer');
const addExampleButton = document.getElementById('addExample');
const chatbotForm = document.getElementById('chatbotForm');

// 예시 추가 기능
let exampleCount = 1;
addExampleButton.addEventListener('click', () => {
  exampleCount++;
  const block = document.createElement("div");
  block.className = "example-block";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = `예시 ${exampleCount}`;
  input.className = "example-input";

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✕";
  del.className = "delete-example";
  del.addEventListener("click", () => block.remove());

  block.appendChild(input);
  block.appendChild(del);
  fewShotContainer.insertBefore(block, addExampleButton);
});

ragToggle.addEventListener('change', () => {
  ragUpload.classList.toggle('hidden', !ragToggle.checked);
});

fewShotToggle.addEventListener('change', () => {
  fewShotContainer.classList.toggle('hidden', !fewShotToggle.checked);
});

chatbotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const subject = document.getElementById("subject").value.trim();
  const name = document.getElementById("name").value.trim();
  const description = document.getElementById("description").value.trim();
  const rag = ragToggle.checked;
  const selfConsistency = document.getElementById("selfConsistency").checked;
  const useFewShot = fewShotToggle.checked;
  const examples = Array.from(document.querySelectorAll(".example-input"))
    .map(el => el.value.trim()).filter(val => val !== "");
  const ragFile = document.getElementById("ragFile").files[0];

  onAuthStateChanged(auth, async (user) => {
    if (!user) return alert("로그인 후 사용 가능합니다.");

    let ragFileUrl = null;
    let ragFileName = null;
    if (rag && ragFile) {
      const fileRef = ref(storage, `rag_files/${user.uid}/${Date.now()}_${ragFile.name}`);
      await uploadBytes(fileRef, ragFile);
      ragFileUrl = await getDownloadURL(fileRef);
      ragFileName = ragFile.name;
    }

    try {
      await addDoc(collection(db, "chatbots"), {
        uid: user.uid,
        subject,
        name,
        description,
        rag,
        ragFileUrl,
        ragFileName,
        selfConsistency,
        useFewShot,
        examples,
        createdAt: serverTimestamp(),
      });
      alert("챗봇 요청이 완료되었습니다.");
      window.location.href = "ChatbotList.html";
    } catch (err) {
      console.error("요청 실패:", err);
      alert("저장 실패: " + err.message);
    }
  });
});

// 실시간 챗봇 테스트
document.getElementById("sendMessage").addEventListener("click", async () => {
  const userMsg = document.getElementById("userMessage").value.trim();
  if (!userMsg) return;

  const chatWindow = document.getElementById("chatWindow");
  chatWindow.innerHTML += `<p><strong>나:</strong> ${userMsg}</p>`;

  const systemPrompt = document.getElementById("description").value;
  const fewShotExamples = Array.from(document.querySelectorAll(".example-input"))
    .map(ex => ex.value.trim()).filter(val => val !== "");

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (fewShotToggle.checked) {
    for (const ex of fewShotExamples) {
      messages.push({ role: "user", content: ex });
      messages.push({ role: "assistant", content: "(예시 응답)" });
    }
  }
  messages.push({ role: "user", content: userMsg });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer YOUR_OPENAI_API_KEY` // 🔑 API 키 삽입 필요
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages
      })
    });

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content ?? "응답 오류";
    chatWindow.innerHTML += `<p><strong>챗봇:</strong> ${reply}</p>`;
    document.getElementById("userMessage").value = "";
    chatWindow.scrollTop = chatWindow.scrollHeight;
  } catch (err) {
    console.error(err);
    chatWindow.innerHTML += `<p style="color:red;">오류 발생</p>`;
  }
});
