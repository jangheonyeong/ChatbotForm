// src/rolesMain.js
// 한 곳에서만 이메일을 관리합니다.
export const TEACHER_EMAILS = [
  "janghy0412@gmail.com",   // 교사용 허용
  "wkdgjsdud@snu.ac.kr",
  "naro3445@gmail.com", 
  "qhtjs34@snu.ac.kr", 
  "leese0708@snu.ac.kr", 
  "jseok33@snu.ac.kr", 
  "escherr1@snu.ac.kr", 
  "gaegullll@gmail.com", 
  "whdusgml0806@gmail.com",
  "jsp4898@snu.ac.kr",
  "wkdgjsdud00@gmail.com", 
];

export const ADMIN_EMAILS = [
  "wkdgjsdud@snu.ac.kr",    // 관리자 허용
];

// 공통 유틸 및 판별 함수
const norm = (s) => (s || "").toLowerCase().trim();
export const isTeacher = (email) => TEACHER_EMAILS.map(norm).includes(norm(email));
export const isAdmin   = (email) => ADMIN_EMAILS.map(norm).includes(norm(email));
