const ragToggle = document.getElementById('ragToggle');
const ragUpload = document.getElementById('ragUpload');

const fewShotToggle = document.getElementById('fewShotToggle');
const fewShotContainer = document.getElementById('fewShotContainer');
const addExampleButton = document.getElementById('addExample');

let exampleCount = 1;

// RAG toggle
ragToggle.addEventListener('change', () => {
  ragUpload.classList.toggle('hidden', !ragToggle.checked);
});

// Few-shot toggle
fewShotToggle.addEventListener('change', () => {
  fewShotContainer.classList.toggle('hidden', !fewShotToggle.checked);
});

// 예시 추가
addExampleButton.addEventListener('click', () => {
  exampleCount++;

  const exampleBlock = document.createElement("div");
  exampleBlock.className = "example-block";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = `예시 ${exampleCount}`;
  input.className = "example-input";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.textContent = "삭제";
  deleteBtn.className = "delete-example";
  deleteBtn.addEventListener("click", () => {
    exampleBlock.remove();
  });

  exampleBlock.appendChild(input);
  exampleBlock.appendChild(deleteBtn);

  fewShotContainer.insertBefore(exampleBlock, addExampleButton);
});
