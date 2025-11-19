// functions/index.js
// 가입 시 자동 승인(Gen1) + 사전 승인 문서 변경 시 즉시 동기화(Gen2)

import * as functions from 'firebase-functions/v1';                 // Gen1(Auth onCreate)
import { onDocumentWritten } from 'firebase-functions/v2/firestore'; // Gen2(Firestore trigger)

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (getApps().length === 0) initializeApp();
const db = getFirestore();
const auth = getAuth();

/** A) 가입 시 자동 승인 — 이미 구현된 흐름 (Gen1) */
export const grantRoleOnSignup = functions
  .region('us-central1') // Gen1은 기존대로 유지(원하면 다른 리전도 가능)
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

/** B) 사전 승인 문서 생성/수정 시 즉시 동기화 — 이미 가입한 계정도 커버 (Gen2) */
export const syncTeacherOnPreapproval = onDocumentWritten(
  { document: 'preapproved_teachers/{email}', region: 'asia-northeast3' }, // ★ Firestore와 동일 리전
  async (event) => {
    try {
      const after = event.data?.after;
      if (!after?.exists) {
        // (옵션) 삭제 시 권한 회수 로직을 원하면 여기서 구현 가능
        return;
      }

      const email = String(event.params.email || '').toLowerCase();
      if (!email) return;

      const data = after.data() || {};
      // 이미 가입된 유저가 있는지 확인
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(email);
      } catch (e) {
        const code = e?.code || e?.errorInfo?.code;
        if (code === 'auth/user-not-found') {
          console.log(`[syncTeacherOnPreapproval] ${email}: user not found yet`);
          return; // 가입 전 → 가입 시 onCreate가 처리
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
