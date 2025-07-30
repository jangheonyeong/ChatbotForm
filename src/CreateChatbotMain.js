const input = document.getElementById("userMessage");
const chatWindow = document.getElementById("chatWindow");
const imageInput = document.getElementById("imageInput");

// ✅ RAG toggle
document.getElementById("ragToggle").addEventListener("change", () => {
  document.getElementById("ragUpload").classList.toggle("hidden", !ragToggle.checked);
});

// ✅ few-shot toggle
document.getElementById("fewShotToggle").addEventListener("change", () => {
  document.getElementById("fewShotContainer").classList.toggle("hidden", !fewShotToggle.checked);
});

// ✅ 예시 추가 버튼
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
  document.getElementById("fewShotContainer").appendChild(block);
});

// ✅ 전송 버튼 클릭 시 처리
document.getElementById("sendMessage").addEventListener("click", async () => {
  const msg = input.value.trim();
  const imageFile = imageInput.files[0];
  if (!msg && !imageFile) return;

  appendMessage("user", msg || "[이미지 첨부됨]");
  input.value = "";
  imageInput.value = "";

  const messages = [];

  // ✅ system prompt
  const systemPrompt = document.getElementById("description").value.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // ✅ few-shot
  const useFewShot = document.getElementById("fewShotToggle").checked;
  const fewShotExamples = Array.from(document.querySelectorAll(".example-input"))
    .map(el => el.value.trim())
    .filter(Boolean);

  if (useFewShot && fewShotExamples.length > 0) {
    fewShotExamples.forEach(example => {
      messages.push({ role: "user", content: example });
      messages.push({ role: "assistant", content: "(예시 응답)" });
    });
  }

  // ✅ RAG
  const useRag = document.getElementById("ragToggle").checked;
  const ragFile = document.getElementById("ragFile").files[0];
  if (useRag && ragFile) {
    messages.push({
      role: "system",
      content: `이 사용자는 '${ragFile.name}'이라는 참고 파일을 기반으로 질문하고자 합니다.`
    });
  }

  // ✅ user message (텍스트 + 이미지 멀티모달 처리)
  if (imageFile) {
    const base64 = await toBase64(imageFile);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: msg },
        { type: "image_url", image_url: { url: base64 } }
      ]
    });
  } else {
    messages.push({ role: "user", content: msg });
  }

  try {
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
    const reply = data.choices?.[0]?.message?.content ?? "❗ 응답 오류";
    appendMessage("bot", reply);
  } catch (err) {
    appendMessage("bot", "❌ 오류 발생: " + err.message);
  }
});

// ✅ 메시지 출력
function appendMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.textContent = content;
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// ✅ 이미지 -> base64 변환
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ✅ Enter 키로 전송
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("sendMessage").click();
  }
});
