// Firebase 관련 초기화 생략 (기존 코드 유지)

// ✅ DOM 요소
const input = document.getElementById("userMessage");
const chatWindow = document.getElementById("chatWindow");

// ✅ toggle event
document.getElementById("fewShotToggle").addEventListener("change", (e) => {
  document.getElementById("fewShotContainer").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("ragToggle").addEventListener("change", (e) => {
  document.getElementById("ragUpload").classList.toggle("hidden", !e.target.checked);
});

// ✅ 예시 추가
document.getElementById("addExample").addEventListener("click", () => {
  const block = document.createElement("div");
  block.className = "example-block";

  const textarea = document.createElement("textarea");
  textarea.className = "example-input";
  textarea.placeholder = "예시를 입력하세요 (Shift+Enter 줄바꿈)";
  textarea.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) e.preventDefault();
  });

  const delBtn = document.createElement("button");
  delBtn.textContent = "✕";
  delBtn.type = "button";
  delBtn.className = "delete-example";
  delBtn.addEventListener("click", () => block.remove());

  block.appendChild(textarea);
  block.appendChild(delBtn);
  document.getElementById("fewShotContainer").insertBefore(block, document.getElementById("addExample"));
});

// ✅ Enter 전송
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("sendMessage").click();
  }
});

// ✅ 전송 버튼 클릭 시
document.getElementById("sendMessage").addEventListener("click", async () => {
  const msg = input.value.trim();
  if (!msg) return;

  appendMessage("user", msg);
  input.value = "";

  const systemPrompt = document.getElementById("description").value.trim();
  const fewShotExamples = Array.from(document.querySelectorAll(".example-input"))
    .map(el => el.value.trim()).filter(Boolean);

  const useFewShot = document.getElementById("fewShotToggle").checked;
  const useSelfConsistency = document.getElementById("selfConsistency").checked;
  const useRag = document.getElementById("ragToggle").checked;
  const ragFile = document.getElementById("ragFile").files[0];

  // ✅ 메시지 구성
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // ✅ few-shot 적용
  if (useFewShot && fewShotExamples.length) {
    for (const ex of fewShotExamples) {
      messages.push({ role: "user", content: ex });
      messages.push({ role: "assistant", content: "(예시 응답)" });
    }
  }

  // ✅ RAG 적용 - 단순히 '사용자가 PDF를 업로드했고 RAG를 체크한 경우'를 메시지에 안내 (실제 검색은 백엔드 필요)
  if (useRag && ragFile) {
    messages.push({
      role: "system",
      content: `다음 질문에 답할 때 사용자는 '${ragFile.name}' 파일을 참조하길 원합니다. 이 파일은 사용자의 추가 학습 자료입니다.`
    });
  }

  // ✅ 사용자 질문
  messages.push({ role: "user", content: msg });

  try {
    const results = [];

    const repeat = useSelfConsistency ? 3 : 1; // ✅ self-consistency 적용
    for (let i = 0; i < repeat; i++) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ` // 🔑 실제 키로 대체
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages
        })
      });

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content ?? "응답 오류";
      results.push(reply);
    }

    // ✅ self-consistency: 가장 많이 등장한 응답 선택
    const finalReply = useSelfConsistency ? getMostCommon(results) : results[0];

    await typeMessage("bot", finalReply);
  } catch (err) {
    appendMessage("bot", "오류 발생: " + err.message);
  }
});

// ✅ 말풍선 출력 함수
function appendMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  msg.textContent = content;
  chatWindow.appendChild(msg);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// ✅ 타이핑 애니메이션
async function typeMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;
  chatWindow.appendChild(msg);

  for (let i = 0; i < text.length; i++) {
    msg.textContent += text[i];
    await new Promise(res => setTimeout(res, 15));
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }
}

// ✅ self-consistency 결과 계산 함수
function getMostCommon(arr) {
  const counts = {};
  arr.forEach(str => {
    counts[str] = (counts[str] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
