const subjects = ["수학", "국어", "영어", "교육", "불어", "물리", "지리", "생물"];

const subjectNodesContainer = document.getElementById("subject-nodes");
const connectorLines = document.getElementById("connector-lines");

const centerX = 400;
const centerY = 400;
const radius = 270;

const nodeCenters = [];

subjects.forEach((subject, i) => {
  const angle = (2 * Math.PI * i) / subjects.length;
  const x = centerX + radius * Math.cos(angle);
  const y = centerY + radius * Math.sin(angle);

  const node = document.createElement("div");
  node.className = "subject-node";
  node.textContent = subject;
  node.style.left = `${x - 45}px`;
  node.style.top = `${y - 45}px`;

  node.addEventListener("click", () => {
    switch (subject) {
      case "수학":
        window.location.href = "Math.html";
        break;
      case "국어":
        window.location.href = "Korean.html";
        break;
      case "영어":
        window.location.href = "English.html";
        break;
      case "교육":
        window.location.href = "Education.html";
        break;
      case "불어":
        window.location.href = "French.html";
        break;
      case "물리":
        window.location.href = "Physics.html";
        break;
      case "지리":
        window.location.href = "Geography.html";
        break;
      case "생물":
        window.location.href = "Biology.html";
        break;
      default:
        window.location.href = `subject.html?subject=${encodeURIComponent(subject)}`;
    }
  });

  subjectNodesContainer.appendChild(node);
  nodeCenters.push({ x, y });
});

nodeCenters.forEach(({ x, y }) => {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", centerX);
  line.setAttribute("y1", centerY);
  line.setAttribute("x2", x);
  line.setAttribute("y2", y);
  line.setAttribute("stroke", "#aaa");
  line.setAttribute("stroke-width", "2");
  connectorLines.appendChild(line);
});
