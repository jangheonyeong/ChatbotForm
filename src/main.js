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

// 예시 추가 버튼 클릭
addExampleButton.addEventListener('click', () => {
  exampleCount += 1;

  const exampleBlock = document.createElement('div');
  exampleBlock.classList.add('example-block');

  const label = document.createElement('label');
  label.textContent = `예시 ${exampleCount}`;

  const textarea = document.createElement('textarea');
  textarea.classList.add('few-shot-input');
  textarea.placeholder = '예시를 입력하세요';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.classList.add('delete-btn');
  deleteButton.textContent = '❌';
  deleteButton.addEventListener('click', () => {
    fewShotContainer.removeChild(exampleBlock);
    renumberExamples();
  });

  exampleBlock.appendChild(label);
  exampleBlock.appendChild(textarea);
  exampleBlock.appendChild(deleteButton);

  fewShotContainer.insertBefore(exampleBlock, addExampleButton);
});

// 예시 번호 재정렬
function renumberExamples() {
  const exampleBlocks = fewShotContainer.querySelectorAll('.example-block');
  exampleCount = exampleBlocks.length;
  exampleBlocks.forEach((block, index) => {
    const label = block.querySelector('label');
    label.textContent = `예시 ${index + 1}`;
  });
}
