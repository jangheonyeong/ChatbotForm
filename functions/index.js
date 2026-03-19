// functions/index.js
// 가입 시 자동 승인(Gen1) + 사전 승인 문서 변경 시 즉시 동기화(Gen2)
// + 챗봇 미리보기용 callable functions (RAG 준비 / 채팅 응답)

import * as functions from 'firebase-functions/v1';                    // Gen1(Auth onCreate)
import { onDocumentWritten } from 'firebase-functions/v2/firestore';  // Gen2(Firestore trigger)
import { onCall, HttpsError } from 'firebase-functions/v2/https';     // Gen2(Callable)
import { defineSecret } from 'firebase-functions/params';             // Secret Manager

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (getApps().length === 0) initializeApp();
const db = getFirestore();
const auth = getAuth();

// ==============================
// 공통 설정
// ==============================
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const OPENAI_BASE = 'https://api.openai.com/v1';

function getOpenAIKeyOrThrow() {
  const raw = String(OPENAI_API_KEY.value() || "");
  const apiKey = raw.trim();

  console.log("[OPENAI_API_KEY check]", {
    prefix: apiKey.slice(0, 7),   // 예: sk-proj
    suffix: apiKey.slice(-4),
    len: apiKey.length,
    hasQuote: apiKey.includes('"') || apiKey.includes("'"),
    hasEnvPrefix: apiKey.includes("OPENAI_API_KEY=")
  });

  if (!apiKey) {
    throw new HttpsError("internal", "OPENAI_API_KEY secret이 비어 있습니다.");
  }

  if (!apiKey.startsWith("sk-")) {
    throw new HttpsError(
      "internal",
      "OPENAI_API_KEY 형식이 올바르지 않습니다. raw key만 넣었는지 확인하세요."
    );
  }

  return apiKey;
}
// ==============================
// OpenAI 공통 헬퍼
// ==============================
async function openaiFetch(path, apiKey, { method = 'GET', headers = {}, body } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;

  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }

    console.error("[openaiFetch fail]", {
      method,
      path,
      status: res.status,
      detail
    });

    throw new Error(`OpenAI API ${method} ${path} failed: ${res.status} ${detail}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  return request.auth.uid;
}

function isReasoningModelId(modelId) {
  const m = String(modelId || '').toLowerCase();
  return m.startsWith('o'); // 예: o3, o1-mini
}

function parseFewShot(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const qaMatch = text.match(/^\s*(?:Q|질문)\s*:\s*([\s\S]+?)\n\s*(?:A|답|답변)\s*:\s*([\s\S]+)$/i);
  if (qaMatch) {
    return {
      user: qaMatch[1].trim(),
      assistant: qaMatch[2].trim()
    };
  }

  const SEPS = ['→', '->', '=>', '⇒', '||', '|', '—', ':'];
  for (const s of SEPS) {
    const idx = text.indexOf(s);
    if (idx !== -1) {
      const left = text.slice(0, idx).trim();
      const right = text.slice(idx + s.length).trim();
      if (left) return { user: left, assistant: right };
    }
  }

  const parts = text.split(/\n\s*\n/);
  if (parts.length >= 2) {
    return { user: parts[0].trim(), assistant: parts.slice(1).join('\n').trim() };
  }

  return { user: text, assistant: '' };
}

function isUsefulFewShot(ex) {
  const u = String(ex?.user || '').trim();
  const a = String(ex?.assistant || '').trim();
  if (!u) return false;
  if (a && a.length < 8) return false;
  return true;
}

function normalizeFewShots(fewShots) {
  if (!Array.isArray(fewShots)) return [];
  return fewShots
    .map((x) => {
      if (typeof x === 'string') return parseFewShot(x);
      if (x && typeof x === 'object') {
        return {
          user: String(x.user || '').trim(),
          assistant: String(x.assistant || '').trim()
        };
      }
      return null;
    })
    .filter(Boolean)
    .filter(isUsefulFewShot);
}

function buildInputString({ systemPrompt, fewShots, userMessage }) {
  let s = '';

  if (String(systemPrompt || '').trim()) {
    s += `System:\n${String(systemPrompt).trim()}\n\n`;
  }

  if (Array.isArray(fewShots) && fewShots.length) {
    s += 'Examples:\n';
    fewShots.forEach(({ user, assistant }) => {
      if (user) s += `User: ${user}\n`;
      if (assistant) s += `Assistant: ${assistant}\n`;
      s += '\n';
    });
  }

  s += `User: ${String(userMessage || '').trim()}\nAssistant:`;
  return s;
}

function extractAssistantText(resp) {
  if (resp?.output_text && String(resp.output_text).trim()) {
    return String(resp.output_text).trim();
  }

  const parts = [];
  if (Array.isArray(resp?.output)) {
    for (const o of resp.output) {
      const content = Array.isArray(o?.content) ? o.content : [];
      for (const c of content) {
        if (c?.type === 'output_text' && c?.text?.value) {
          parts.push(String(c.text.value));
        } else if (typeof c?.text === 'string') {
          parts.push(c.text);
        }
      }

      if (!parts.length && Array.isArray(o?.suggested_replies) && o.suggested_replies.length) {
        const t = o.suggested_replies[0]?.text;
        if (t) parts.push(String(t));
      }
    }
  }

  return parts.join('\n').trim();
}

function guessFilenameFromUrl(url) {
  try {
    const u = new URL(url);

    // Firebase Storage download URL 형식 대응
    // .../o/chatbots%2Fuid%2Ffile.pdf?alt=media&token=...
    const maybeObjectPath = u.pathname.split('/o/')[1];
    if (maybeObjectPath) {
      const decoded = decodeURIComponent(maybeObjectPath);
      return decoded.split('/').pop() || `file_${Date.now()}.pdf`;
    }

    return decodeURIComponent(u.pathname.split('/').pop() || `file_${Date.now()}.pdf`);
  } catch {
    return `file_${Date.now()}.pdf`;
  }
}

async function fetchRemoteFile(fileMeta) {
  const url = typeof fileMeta === 'string' ? fileMeta : String(fileMeta?.url || '').trim();
  const explicitName =
    typeof fileMeta === 'object' && fileMeta?.name ? String(fileMeta.name).trim() : '';
  const filename = explicitName || guessFilenameFromUrl(url);

  if (!url) {
    throw new Error('파일 URL이 비어 있습니다.');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`파일 다운로드 실패: ${res.status} ${url}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'application/pdf';

  return {
    filename,
    contentType,
    blob: new Blob([arrayBuffer], { type: contentType })
  };
}

async function createVectorStore(apiKey) {
  const data = await openaiFetch('/vector_stores', apiKey, {
    method: 'POST',
    body: {
      name: `preview_vs_${Date.now()}`,
      expires_after: { anchor: 'last_active_at', days: 7 }
    }
  });
  return data.id;
}

async function uploadFileToOpenAI(apiKey, { filename, contentType, blob }) {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('purpose', 'user_data');

  return openaiFetch('/files', apiKey, {
    method: 'POST',
    body: form,
    headers: {
      // multipart/form-data boundary는 fetch가 자동 처리
    }
  });
}

async function attachFileToVectorStore(apiKey, vectorStoreId, fileId) {
  return openaiFetch(`/vector_stores/${vectorStoreId}/files`, apiKey, {
    method: 'POST',
    body: { file_id: fileId }
  });
}

async function waitVectorStoreFileReady(apiKey, vectorStoreId, fileId, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const start = Date.now();

  while (true) {
    const info = await openaiFetch(`/vector_stores/${vectorStoreId}/files/${fileId}`, apiKey, {
      method: 'GET'
    });

    if (info?.status === 'completed') return info;
    if (info?.status === 'failed') {
      throw new Error(`벡터 인덱싱 실패: ${fileId}`);
    }
    if (info?.status === 'cancelled') {
      throw new Error(`벡터 인덱싱 취소됨: ${fileId}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`벡터 인덱싱 타임아웃: ${fileId}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ==============================
// A) 가입 시 자동 승인 — 기존 유지 (Gen1)
// ==============================
export const grantRoleOnSignup = functions
  .region('us-central1')
  .auth.user()
  .onCreate(async (user) => {
    try {
      const email = (user.email || '').toLowerCase();
      if (!email) return null;

      const snap = await db.doc(`preapproved_teachers/${email}`).get();
      if (!snap.exists) return null;

      const data = snap.data() || {};
      const role = String(data.role || 'teacher').toLowerCase();
      const claims = role === 'admin'
        ? { admin: true, teacher: true }
        : { teacher: true };

      await db.doc(`teachers/${user.uid}`).set({
        email,
        role: role === 'admin' ? 'admin' : 'teacher',
        active: true,
        approvedBy: data.approvedBy || null,
        approvedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await auth.setCustomUserClaims(user.uid, claims);
      console.log(`[grantRoleOnSignup] set claims for ${email}`, claims);
      return null;
    } catch (err) {
      console.error('[grantRoleOnSignup] ERROR', err);
      return null;
    }
  });

// ==============================
// B) 사전 승인 문서 생성/수정 시 즉시 동기화 — 기존 유지 (Gen2)
// ==============================
export const syncTeacherOnPreapproval = onDocumentWritten(
  { document: 'preapproved_teachers/{email}', region: 'asia-northeast3' },
  async (event) => {
    try {
      const after = event.data?.after;
      if (!after?.exists) {
        return;
      }

      const email = String(event.params.email || '').toLowerCase();
      if (!email) return;

      const data = after.data() || {};

      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(email);
      } catch (e) {
        const code = e?.code || e?.errorInfo?.code;
        if (code === 'auth/user-not-found') {
          console.log(`[syncTeacherOnPreapproval] ${email}: user not found yet`);
          return;
        }
        throw e;
      }

      const role = String(data.role || 'teacher').toLowerCase();
      const current = userRecord.customClaims || {};
      const newClaims = { ...current, teacher: true };

      if (role === 'admin') newClaims.admin = true;
      else if ('admin' in newClaims) delete newClaims.admin;

      await auth.setCustomUserClaims(userRecord.uid, newClaims);
      await db.doc(`teachers/${userRecord.uid}`).set({
        email,
        role: role === 'admin' ? 'admin' : 'teacher',
        active: true,
        approvedBy: data.approvedBy || null,
        approvedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`[syncTeacherOnPreapproval] synced claims for ${email}`, newClaims);
    } catch (err) {
      console.error('[syncTeacherOnPreapproval] ERROR', err);
    }
  }
);

// ==============================
// C) RAG 미리보기 준비용 callable
// request.data = {
//   files: [{ url, name? }, ...]  또는 ["https://...", ...]
// }
// return = {
//   ok: true,
//   vectorStoreId,
//   uploadedCount,
//   fileIds
// }
// ==============================
export const prepareRagPreview = onCall(
  {
    region: 'asia-northeast3',
    timeoutSeconds: 540,
    memory: '1GiB',
    secrets: [OPENAI_API_KEY]
  },
  async (request) => {
    requireAuth(request);

    const apiKey = getOpenAIKeyOrThrow();
    const files = Array.isArray(request.data?.files) ? request.data.files : [];

    if (!files.length) {
      throw new HttpsError('invalid-argument', 'files 배열이 비어 있습니다.');
    }
    if (files.length > 10) {
      throw new HttpsError('invalid-argument', '한 번에 최대 10개 파일만 처리할 수 있습니다.');
    }

    try {
      const vectorStoreId = await createVectorStore(apiKey);
      const fileIds = [];

      for (const fileMeta of files) {
        const remote = await fetchRemoteFile(fileMeta);
        const uploaded = await uploadFileToOpenAI(apiKey, remote);
        const fileId = uploaded?.id;

        if (!fileId) {
          throw new Error(`OpenAI 파일 업로드 응답에 id가 없습니다. (${remote.filename})`);
        }

        await attachFileToVectorStore(apiKey, vectorStoreId, fileId);
        await waitVectorStoreFileReady(apiKey, vectorStoreId, fileId);

        fileIds.push(fileId);
      }

      return {
        ok: true,
        vectorStoreId,
        uploadedCount: fileIds.length,
        fileIds
      };
    } catch (err) {
      console.error('[prepareRagPreview] ERROR', err);
      throw new HttpsError(
        'internal',
        err?.message || 'RAG 미리보기 준비 중 오류가 발생했습니다.'
      );
    }
  }
);

// ==============================
// D) 챗봇 미리보기 응답용 callable
// request.data = {
//   model,
//   systemPrompt,
//   fewShots,
//   userMessage,
//   vectorStoreId,
//   temperature
// }
// return = { ok: true, text, raw? }
// ==============================
export const previewChat = onCall(
  {
    region: 'asia-northeast3',
    timeoutSeconds: 540,
    memory: '1GiB',
    secrets: [OPENAI_API_KEY]
  },
  async (request) => {
    requireAuth(request);

    const apiKey = getOpenAIKeyOrThrow();

    const model = String(request.data?.model || 'gpt-4o-mini').trim();
    const systemPrompt = String(request.data?.systemPrompt || '');
    const userMessage = String(request.data?.userMessage || '').trim();
    const vectorStoreId = String(request.data?.vectorStoreId || '').trim();
    const temperatureRaw = Number(request.data?.temperature ?? 0.7);
    const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : 0.7;
    const fewShots = normalizeFewShots(request.data?.fewShots);

    if (!userMessage) {
      throw new HttpsError('invalid-argument', 'userMessage가 비어 있습니다.');
    }

    const genericGuard = `
한국어로 답하세요. 질문을 되묻는 안내 멘트만 하지 말고, 먼저 핵심 답을 3–6문장으로 제시하세요.
금지 문구: "무엇을 도와드릴까요", "어떤 도움이 필요하신가요", "어떤 점이 궁금하신가요" 등.`.trim();

    const ragGuide = vectorStoreId
      ? `
업로드된 파일이 도움이 될 때만 file_search를 사용하세요. 질문이 파일과 무관하면 일반 지식으로도 충분히 답하세요.`
          .trim()
      : '';

    const mergedSystem = [systemPrompt, genericGuard, ragGuide]
      .filter(Boolean)
      .join('\n\n');

    const input = buildInputString({
      systemPrompt: mergedSystem,
      fewShots,
      userMessage
    });

    const body = {
      model,
      input
    };

    if (vectorStoreId) {
      body.tools = [
        {
          type: 'file_search',
          vector_store_ids: [vectorStoreId]
        }
      ];
    }

    // o-시리즈는 temperature를 보내지 않도록 기존 프론트 규칙 유지
    if (!isReasoningModelId(model)) {
      body.temperature = temperature;
    }

    try {
      const resp = await openaiFetch('/responses', apiKey, {
        method: 'POST',
        body
      });

      const text = extractAssistantText(resp) || '[빈 응답]';

      return {
        ok: true,
        text
      };
    } catch (err) {
      console.error('[previewChat] ERROR', err);
      throw new HttpsError(
        'internal',
        err?.message || '미리보기 응답 생성 중 오류가 발생했습니다.'
      );
    }
  }
);