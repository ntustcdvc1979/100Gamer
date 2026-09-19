/* ============================================================
   Firebase Realtime Database 實作

   注意這支是用動態 import 載進來的，所以 firebase SDK 會被切成
   獨立的 chunk，不會拖慢 play 頁面的第一次載入 —— 100 人同時走行動網路
   連進來的時候，那幾十 KB 是有感的。

   非對稱扇出在這裡落實：
     stage  訂閱 state + players + inputs（全域）
     play   只訂閱 state，寫自己的 players/$uid 與 inputs/$uid
   ============================================================ */

import type { Database, DatabaseReference } from "firebase/database";
import type { Input, Player, RoomState } from "./schema";
import type { RoomTransport, Unsubscribe } from "./transport";

export interface FirebaseOptions {
  apiKey: string;
  authDomain?: string;
  databaseURL: string;
  projectId?: string;
  appId?: string;
}

export async function createFirebaseTransport(
  room: string,
  options: FirebaseOptions,
): Promise<RoomTransport> {
  const [appMod, authMod, dbMod] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/database"),
  ]);

  const app = appMod.initializeApp(options);

  // 匿名登入。uid 直接當玩家 id 用，安全規則靠 $uid === auth.uid
  // 擋住「改別人的資料」，比自己產一組 id 穩得多。
  const auth = authMod.getAuth(app);
  const cred = await authMod.signInAnonymously(auth);
  const uid = cred.user.uid;

  const db: Database = dbMod.getDatabase(app);
  const {
    ref,
    set,
    update,
    remove,
    onValue,
    runTransaction,
    onDisconnect,
    serverTimestamp,
  } = dbMod;

  const root = `rooms/${room}`;
  const at = (sub: string): DatabaseReference => ref(db, `${root}/${sub}`);

  const transport = {
    kind: "firebase" as const,
    uid,
    connected: false,

    onConnection(cb: (ok: boolean) => void): Unsubscribe {
      return onValue(ref(db, ".info/connected"), (snap) => {
        transport.connected = snap.val() === true;
        cb(transport.connected);
      });
    },

    onState(cb: (state: RoomState | null) => void): Unsubscribe {
      return onValue(at("state"), (snap) => cb((snap.val() as RoomState | null) ?? null));
    },

    async setState(state: RoomState): Promise<void> {
      await set(at("state"), state);
    },

    async claimHost(): Promise<boolean> {
      // 第一個開的 stage 佔位。規則裡 state 只有 host 寫得動，
      // 所以百人場不會有人拿手機把流程改掉。
      const result = await runTransaction(at("host"), (current: string | null) => {
        if (current === null || current === uid) return uid;
        return undefined; // 已經有別人佔了，放棄
      });
      return result.committed && result.snapshot.val() === uid;
    },

    onPlayers(cb: (players: Record<string, Player>) => void): Unsubscribe {
      return onValue(at("players"), (snap) =>
        cb((snap.val() as Record<string, Player> | null) ?? {}),
      );
    },

    async savePlayer(patch: Partial<Player>): Promise<void> {
      const mine = at(`players/${uid}`);
      // 離線就從名單消失。orientation 那版 import 了 onDisconnect 但沒用到，
      // 100 人的場合一定要用，不然名單會塞滿早就離開的人。
      await onDisconnect(mine).remove();
      await onDisconnect(at(`inputs/${uid}`)).remove();
      await update(mine, patch);
    },

    onInputs(cb: (inputs: Record<string, Input>) => void): Unsubscribe {
      return onValue(at("inputs"), (snap) =>
        cb((snap.val() as Record<string, Input> | null) ?? {}),
      );
    },

    async sendInput(input: Input): Promise<void> {
      // 覆蓋而不是 push()。搖桿只有最新的值有意義，
      // 用 push() 會在活動中途把資料庫塞成幾十萬筆垃圾。
      await set(at(`inputs/${uid}`), input);
    },

    async takeSeat(): Promise<number> {
      const result = await runTransaction(at("seat"), (current: number | null) => (current ?? 0) + 1);
      const next = (result.snapshot.val() as number | null) ?? 1;
      return next - 1;
    },

    async clearRoom(): Promise<void> {
      await remove(ref(db, root));
    },
  };

  // 沒用到但留著給之後的關卡：伺服器時間，量延遲時比本機時鐘可信。
  void serverTimestamp;

  return transport;
}
