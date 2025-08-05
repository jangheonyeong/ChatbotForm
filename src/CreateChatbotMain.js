// [CreateChatbotMain.js]

import { initializeApp } from "firebase/app";
import {
  getAuth
} from "firebase/auth";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp
} from "firebase/firestore";
import {
  getStorage,
  ref,
  uploadBytes
} from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";
import { createClient } from "@supabase/supabase-js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.js?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

async function extractTextFromPDFBlob(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  let text = "";
  const maxPages = Math.min(pdf.numPages, 10);
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    text += pageText + "\n";
  }
  return text;
}

function chunkText(text, maxTokens = 500) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxTokens) {
    chunks.push(words.slice(i, i + maxTokens).join(" "));
  }
  return chunks;
}

async function getEmbedding(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });
  const data = await res.json();
  return data.data[0].embedding;
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
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI 응답 실패: ${res.status} ${errorText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "응답 오류";
}

window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("userMessage");
  const chatWindow = document.getElementById("chatWindow");

  document.getElementById("sendMessage").addEventListener("click", () =>
    onSendMessage(input, chatWindow)
  );

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendMessage(input, chatWindow);
    }
  });

  document.getElementById("ragToggle").addEventListener("change", () => {
    document.getElementById("ragUpload").classList.toggle("hidden", !ragToggle.checked);
  });

  const fewShotToggle = document.getElementById("fewShotToggle");
  fewShotToggle.addEventListener("change", () => {
    document.getElementById("fewShotContainer").classList.toggle("hidden", !fewShotToggle.checked);
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

  const form = document.getElementById("chatbotForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const chatbotId = document.getElementById("chatbotId").value;
    const subject = document.getElementById("subject").value.trim();
    const name = document.getElementById("name").value.trim();
    const description = document.getElementById("description").value.trim();
    const rag = document.getElementById("ragToggle").checked;
    const fewShot = document.getElementById("fewShotToggle").checked;
    const selfConsistency = document.getElementById("selfConsistency").checked;

    const examples = [];
    if (fewShot) {
      const exampleInputs = document.querySelectorAll(".example-input");
      exampleInputs.forEach((el) => {
        if (el.value.trim()) {
          examples.push(el.value.trim());
        }
      });
    }

    const user = auth.currentUser;
    if (!user) {
      alert("로그인이 필요합니다.");
      return;
    }

    const data = {
      uid: user.uid,
      subject,
      name,
      description,
      rag,
      fewShot,
      selfConsistency,
      examples,
      createdAt: serverTimestamp(),
    };

    try {
      if (chatbotId) {
        const chatbotRef = doc(db, "chatbots", chatbotId);
        await updateDoc(chatbotRef, data);
      } else {
        await addDoc(collection(db, "chatbots"), data);
      }
      alert("✅ 저장이 완료되었습니다!");
    } catch (err) {
      alert("❌ 저장 실패: " + err.message);
    }
  });

  // ✅ edit 모드
  const saved = localStorage.getItem("editChatbot");
  if (saved) {
    const bot = JSON.parse(saved);
    document.getElementById("chatbotId").value = bot.id || "";
    document.getElementById("subject").value = bot.subject || "";
    document.getElementById("name").value = bot.name || "";
    document.getElementById("description").value = bot.description || "";
    document.getElementById("ragToggle").checked = bot.rag || false;
    document.getElementById("ragUpload").classList.toggle("hidden", !bot.rag);
    document.getElementById("fewShotToggle").checked = bot.useFewShot || false;
    document.getElementById("fewShotContainer").classList.toggle("hidden", !bot.useFewShot);
    document.getElementById("selfConsistency").checked = bot.selfConsistency || false;

    if (bot.ragFileName && bot.ragFileUrl) {
      const linkArea = document.getElementById("ragFileLink");
      linkArea.innerHTML = `<a href="${bot.ragFileUrl}" target="_blank">${bot.ragFileName}</a>`;
    }

    const examplesArea = document.getElementById("examplesArea");
    examplesArea.innerHTML = "";
    if (bot.examples && bot.examples.length > 0) {
      bot.examples.forEach((example) => {
        const block = document.createElement("div");
        block.className = "example-block";

        const textarea = document.createElement("textarea");
        textarea.className = "example-input";
        textarea.value = example;

        const delBtn = document.createElement("button");
        delBtn.textContent = "✕";
        delBtn.type = "button";
        delBtn.className = "delete-example";
        delBtn.addEventListener("click", () => block.remove());

        block.appendChild(textarea);
        block.appendChild(delBtn);
        examplesArea.appendChild(block);
      });
    }

    localStorage.removeItem("editChatbot");
  }
});

// ✅ 메시지 전송 로직
async function onSendMessage(input, chatWindow) {
  const msg = input.value.trim();
  if (!msg) return;
  appendMessage("user", msg);
  input.value = "";

  const user = auth.currentUser;
  if (!user) {
    alert("로그인이 필요합니다.");
    return;
  }

  const useRag = document.getElementById("ragToggle").checked;
  const ragFile = document.getElementById("ragFile")?.files?.[0];

  const useFewShot = document.getElementById("fewShotToggle").checked;

  let ragContext = "";
  if (useRag && ragFile) {
    const loadingEl = appendMessage("bot", "⏳ RAG 처리 중...");
    try {
      const tempPath = `rag-temp/${user.uid}/${Date.now()}_${ragFile.name}`;
      const fileRef = ref(storage, tempPath);
      await uploadBytes(fileRef, ragFile);

      const pdfText = await extractTextFromPDFBlob(ragFile);
      const chunks = chunkText(pdfText);
      const embeddings = await Promise.all(chunks.map(getEmbedding));

      await supabase.from("documents").insert(
        chunks.map((chunk, i) => ({
          user_id: user.uid,
          file_name: ragFile.name,
          chunk_text: chunk,
          embedding: embeddings[i]
        }))
      );

      const questionEmbedding = await getEmbedding(msg);
      const { data: similarChunks, error } = await supabase.rpc("match_documents", {
        query_embedding: questionEmbedding,
        match_count: 5
      });

      if (!error && similarChunks) {
        ragContext = similarChunks.map((c, i) => `자료[${i + 1}]: ${c.chunk_text}`).join("\n");
      }
    } catch (err) {
      appendMessage("bot", "❌ PDF 처리 오류: " + err.message);
      return;
    } finally {
      loadingEl.remove();
    }
  }

  // ✅ messages 구성
  const messages = [];

  const description = document.getElementById("description").value.trim();
  let systemContent = description || "";
  if (ragContext) {
    systemContent += `\n\n다음은 업로드한 문서에서 검색된 관련 정보입니다:\n${ragContext}`;
  }
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  if (useFewShot) {
    const examples = document.querySelectorAll(".example-input");
    examples.forEach((textarea) => {
      const exampleText = textarea.value.trim();
      if (exampleText.includes("→")) {
        const [userPart, botPart] = exampleText.split("→").map(s => s.trim());
        if (userPart && botPart) {
          messages.push({ role: "user", content: userPart });
          messages.push({ role: "assistant", content: botPart });
        }
      }
    });
  }

  messages.push({ role: "user", content: msg });

  console.log("📤 최종 messages:", messages);

  const botMessageEl = appendMessage("bot", "💬 답변 생성 중...");
  try {
    const reply = await sendToOpenAI(messages);
    const html = marked.parse(reply);
    botMessageEl.innerHTML = "";
    animateTypingWithMath(botMessageEl, html);
  } catch (err) {
    botMessageEl.innerHTML = "❌ 오류: " + err.message;
  }
}

function animateTypingWithMath(element, html, delay = 30) {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;
  const nodes = Array.from(tempDiv.childNodes);
  element.innerHTML = "";

  let i = 0;
  const interval = setInterval(() => {
    if (i >= nodes.length) {
      clearInterval(interval);
      MathJax.typesetPromise([element]);
      return;
    }
    element.appendChild(nodes[i].cloneNode(true));
    i++;
    const chatWindow = document.getElementById("chatWindow");
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, delay);
}

function appendMessage(role, content = "") {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}
