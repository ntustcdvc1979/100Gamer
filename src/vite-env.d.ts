/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 遊戲伺服器（Fly.io），例如 wss://ntustcdvc-100gamer.fly.dev。主線。 */
  readonly VITE_WS_URL?: string;
  /** Firebase 設定，一整行 JSON。備援。 */
  readonly VITE_FIREBASE_CONFIG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
