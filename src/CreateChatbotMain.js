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

// PDF.js 설정
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

async function extractTextFromPDF(file) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = async function () {
      try {
        const typedarray = new Uint8Array(this.result);
        const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(item => item.str).join(" ") + "\n";
        }
        resolve(text);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("userMessage");
  const chatWindow = document.getElementById("chatWindow");
  const imageInput = document.getElementById("imageInput");
  const ragToggle = document.getElementById("ragToggle");
  const fewShotToggle = document.getElementById("fewShotToggle");

  ragToggle.addEventListener("change", () => {
    document.getElementById("ragUpload").classList.toggle("hidden", !ragToggle.checked);
  });

  fewShotToggle.addEventListener("change", () => {
    document.getElementById("fewShotContainer").classList.toggle("hidden", !fewShotToggle.checked);
  });

  document.getElementById("sendMessage").addEventListener("click", () =>
    onSendMessage(input, chatWindow, imageInput)
  );

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendMessage(input, chatWindow, imageInput);
    }
  });

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

  const saved = localStorage.getItem("editChatbot");
  if (saved) {
    const data = JSON.parse(saved);
    document.getElementById("chatbotId").value = data.id;
    document.getElementById("subject").value = data.subject;
    document.getElementById("name").value = data.name;
    document.getElementById("description").value = data.description;

    if (data.rag) {
      ragToggle.checked = true;
      document.getElementById("ragUpload").classList.remove("hidden");
      const link = document.createElement("a");
      link.href = data.ragFileUrl;
      link.target = "_blank";
      link.innerText = data.ragFileName;
      document.getElementById("ragFileLink").appendChild(link);
    }

    if (data.useFewShot) {
      fewShotToggle.checked = true;
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

  document.getElementById("chatbotForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const subject = document.getElementById("subject").value.trim();
    const name = document.getElementById("name").value.trim();
    const description = document.getElementById("description").value.trim();
    const rag = ragToggle.checked;
    const fewShot = fewShotToggle.checked;
    const selfConsistency = document.getElementById("selfConsistency").checked;
    const examples = Array.from(document.querySelectorAll(".example-input"))
      .map(el => el.value.trim())
      .filter(Boolean);
    const ragFile = document.getElementById("ragFile").files[0];

    onAuthStateChanged(getAuth(), async (user) => {
      if (!user) {
        alert("로그인이 필요합니다.");
        window.location.href = "LogIn.html";
        return;
      }

      const storage = getStorage();
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

      const db = getFirestore();
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

async function onSendMessage(input, chatWindow, imageInput) {
  const msg = input.value.trim();
  const imageFile = imageInput.files[0];
  if (!msg && !imageFile) return;

  appendMessage("user", msg || "[이미지 첨부됨]");
  input.value = "";
  imageInput.value = "";

  const messages = [];

  const description = document.getElementById("description").value.trim();
  if (description) {
    messages.push({ role: "system", content: description });
  }

  const ragFile = document.getElementById("ragFile").files[0];
  if (document.getElementById("ragToggle").checked && ragFile) {
    try {
      const text = await extractTextFromPDF(ragFile);
      messages.push({
        role: "system",
        content: `첨부된 PDF의 주요 내용:\n\n${text.slice(0, 3000)}`
      });
    } catch (err) {
      console.error("PDF 읽기 실패:", err);
    }
  }

  if (document.getElementById("fewShotToggle").checked) {
    const examples = Array.from(document.querySelectorAll(".example-input"))
      .map(el => el.value.trim())
      .filter(Boolean);
    examples.forEach((ex) => {
      messages.push({ role: "user", content: ex });
      messages.push({ role: "assistant", content: "(예시 응답)" });
    });
  }

  messages.push({ role: "user", content: msg });

  const selfConsistency = document.getElementById("selfConsistency").checked;
  const botMessageEl = appendMessage("bot", "생각 중...");

  try {
    const results = selfConsistency
      ? await Promise.all([
          sendToOpenAI(messages),
          sendToOpenAI(messages),
          sendToOpenAI(messages)
        ])
      : [await sendToOpenAI(messages)];

    const freq = {};
    results.forEach(reply => (freq[reply] = (freq[reply] || 0) + 1));
    const final = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];

    const html = marked.parse(final);
    botMessageEl.innerHTML = "";
    animateTypingWithMath(botMessageEl, html);
  } catch (err) {
    botMessageEl.textContent = "❌ 오류: " + err.message;
  }
}

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
  return data.choices?.[0]?.message?.content ?? "응답 오류";
}

function appendMessage(role, content) {
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;
  div.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

function animateTypingWithMath(el, html, delay = 10) {
  let i = 0;
  let temp = "";
  const interval = setInterval(() => {
    temp += html[i];
    el.innerHTML = temp;
    MathJax.typesetPromise([el]);
    i++;
    if (i >= html.length) clearInterval(interval);
  }, delay);
}
