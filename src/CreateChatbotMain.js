// ✅ import 및 초기화
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getStorage, ref, uploadBytes } from "firebase/storage";
import { firebaseConfig } from "../firebaseConfig.js";
import { createClient } from "@supabase/supabase-js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.js?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const storage = getStorage(app);

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ✅ PDF 텍스트 추출
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

// ✅ 초기화 및 이벤트 바인딩
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

  // few-shot 관련 UI 처리
  const fewShotToggle = document.getElementById("fewShotToggle");
  const fewShotContainer = document.getElementById("fewShotContainer");
  fewShotToggle.addEventListener("change", () => {
    fewShotContainer.classList.toggle("hidden", !fewShotToggle.checked);
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
});

// ✅ 메시지 처리
async function onSendMessage(input, chatWindow) {
  const msg = input.value.trim();
  if (!msg) return;

  appendMessage("user", msg);
  input.value = "";

  const messages = [];
  const systemPrompt = document.getElementById("description").value.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // ✅ few-shot 예시 추가
  const useFewShot = document.getElementById("fewShotToggle").checked;
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

  const useRag = document.getElementById("ragToggle").checked;
  const ragFileInput = document.getElementById("ragFile");
  const ragFile = ragFileInput?.files?.[0];

  const loadingEl = appendMessage("bot", "⏳ RAG 처리 중...");

  const user = auth.currentUser;
  if (!user) {
    alert("로그인이 필요합니다.");
    return;
  }

  if (useRag && ragFile) {
    try {
      const tempPath = `rag-temp/${user.uid}/${Date.now()}_${ragFile.name}`;
      const fileRef = ref(storage, tempPath);
      await uploadBytes(fileRef, ragFile);

      const pdfText = await extractTextFromPDFBlob(ragFile);
      const chunks = chunkText(pdfText);
      const embeddings = await Promise.all(chunks.map(chunk => getEmbedding(chunk)));

      await supabase.from("documents").insert(
        chunks.map((chunk, i) => ({
          user_id: user.uid,
          file_name: ragFile.name,
          chunk_text: chunk,
          embedding: embeddings[i]
        }))
      );
    } catch (err) {
      loadingEl.remove();
      appendMessage("bot", "❌ PDF 처리 오류: " + err.message);
      return;
    }
  }

  // ✅ RAG 벡터 검색
  let ragContext = "";
  if (useRag) {
    try {
      const questionEmbedding = await getEmbedding(msg);
      const { data: similarChunks, error } = await supabase.rpc("match_documents", {
        query_embedding_input: questionEmbedding,
        match_count: 5
      });

      if (error) {
        console.error("벡터 검색 오류:", error.message);
      } else {
        ragContext = similarChunks.map((c, i) => `자료[${i + 1}]: ${c.chunk_text}`).join("\n");
        messages.push({
          role: "system",
          content: `다음은 업로드한 문서에서 검색된 관련 정보입니다:\n\n${ragContext}`
        });
      }
    } catch (err) {
      console.error("벡터 검색 중 예외:", err.message);
    }
  }

  loadingEl.remove();
  messages.push({ role: "user", content: msg });
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

// ✅ 출력 유틸
function appendMessage(role, content = "") {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.innerHTML = content;
  const chatWindow = document.getElementById("chatWindow");
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return msg;
}

function animateTypingWithMath(element, html, delay = 30) {
  const words = html.split(/(\s+)/);
  let i = 0;
  element.innerHTML = "";
  const interval = setInterval(() => {
    if (i >= words.length) {
      clearInterval(interval);
      return;
    }
    element.innerHTML += words[i];
    MathJax.typesetPromise([element]);
    i++;
    const chatWindow = document.getElementById("chatWindow");
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, delay);
}
