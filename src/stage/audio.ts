/* ============================================================
   投影幕的聲音：音效＋背景音樂

   只有投影幕出聲，手機不出聲。一百支手機同時「啵」一下只會變成噪音，
   而且每支手機的音量、延遲都不一樣 —— 現場的聲音一律從場地喇叭出來。

   全部用 Web Audio 當場合成，沒有任何音檔：
     - 不用擔心音樂版權；
     - 現場自架、沒有外網也有聲音；
     - 音效可以跟遊戲事件精準對齊（拔起來的那一幀就「啵」）。

   ⚠️ 瀏覽器規定：頁面要先被使用者「碰過一次」才可以出聲。
   投影幕那台只要在開場時按一下 F（全螢幕）或點一下畫面就解鎖了。
   沒解鎖之前畫面左下角會有提示，見 stage/main.ts。
   ============================================================ */

export type Sfx =
  | "pop"      // 拔出一根蘿蔔
  | "join"     // 大廳有人加入
  | "tick"     // 最後五秒
  | "start"    // 開始（哨音）
  | "reveal"   // 公布答案（鼓聲＋登登）
  | "cheer"    // 歡呼
  | "end"      // 時間到
  | "fanfare"  // 頒獎
  | "ding";    // 一般提示音

export type BgmStyle = "lobby" | "play" | "award";

export interface StageAudio {
  /** 瀏覽器放行了沒。還沒的話畫面上要提示「點一下開啟聲音」。 */
  readonly unlocked: boolean;
  /** 從使用者的點擊／按鍵裡呼叫。 */
  unlock(): void;
  sfx(name: Sfx): void;
  /** null = 停掉音樂 */
  setBgm(style: BgmStyle | null): void;
  setEnabled(bgm: boolean, sfx: boolean): void;
}

/** MIDI 音高 → 頻率 */
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/* ------------------------------------------------------------
   背景音樂的譜

   每一首是四小節、每小節八個八分音符。-1 = 休止。
   和弦走 I–V–vi–IV（C–G–Am–F），最普遍、也最「開心」的進行。
   曲子是為這個活動寫的，不是任何現成的歌。
   ------------------------------------------------------------ */
interface Song {
  bpm: number;
  melody: number[][];
  roots: number[];
  /** 每小節的和弦是不是小調（vi 級要用小三和弦） */
  minor: boolean[];
  /** 鼓的密度：calm 只有輕輕的 hi-hat，drive 加大鼓和拍手 */
  drums: "calm" | "drive" | "march";
}

const SONGS: Record<BgmStyle, Song> = {
  // 大廳：輕快、不吵，大家在掃 QR 選隊的時候放
  lobby: {
    bpm: 112,
    melody: [
      [76, 79, 81, 79, 76, 74, 72, -1],
      [74, 76, 79, 76, 74, -1, 71, -1],
      [72, 76, 81, 79, 76, -1, 72, 76],
      [77, 81, 84, 81, 79, -1, 76, 74],
    ],
    roots: [48, 43, 45, 41],
    minor: [false, false, true, false],
    drums: "calm",
  },
  // 遊戲中：快、有推進感
  play: {
    bpm: 136,
    melody: [
      [84, -1, 84, 79, 81, -1, 79, 76],
      [83, -1, 83, 79, 81, 83, 79, -1],
      [81, -1, 81, 76, 79, -1, 76, 72],
      [77, 79, 81, 84, 83, -1, 79, -1],
    ],
    roots: [48, 43, 45, 41],
    minor: [false, false, true, false],
    drums: "drive",
  },
  // 頒獎：C–F–G–C，像進行曲
  award: {
    bpm: 100,
    melody: [
      [72, 76, 79, 84, -1, 84, 83, 84],
      [81, -1, 77, 81, 84, -1, 81, 77],
      [79, -1, 83, 86, 84, -1, 83, 79],
      [84, -1, -1, -1, 79, -1, 72, -1],
    ],
    roots: [48, 41, 43, 48],
    minor: [false, false, false, false],
    drums: "march",
  },
};

export function createStageAudio(): StageAudio {
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  // 沒有 Web Audio 的環境（極舊的瀏覽器）就安靜地什麼都不做
  if (!AC) {
    return { unlocked: false, unlock() {}, sfx() {}, setBgm() {}, setEnabled() {} };
  }

  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const bgmBus = ctx.createGain();
  bgmBus.gain.value = 0.16;
  bgmBus.connect(master);
  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.55;
  sfxBus.connect(master);

  let bgmOn = true;
  let sfxOn = true;

  /* ---------- 基本樂器 ---------- */

  function tone(
    freq: number, at: number, dur: number,
    type: OscillatorType, vol: number, out: AudioNode,
    glideTo?: number,
  ): void {
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(vol, at + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(gn).connect(out);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  let noiseBuf: AudioBuffer | null = null;
  /** 兩秒的白噪音，所有雜音類的聲音（鼓、拍手、歡呼）共用。 */
  function getNoise(): AudioBuffer {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function noise(
    at: number, dur: number, vol: number, out: AudioNode,
    filter: BiquadFilterType, freq: number, q = 1,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(vol, at + 0.005);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(gn).connect(out);
    src.start(at, Math.random() * 1.5);
    src.stop(at + dur + 0.02);
  }

  function kick(at: number, out: AudioNode): void {
    tone(150, at, 0.14, "sine", 0.9, out, 40);
  }

  /* ---------- 音效 ---------- */

  /** 同一種音效太密就吞掉 —— 一百個人同時拔蘿蔔會變成機關槍。 */
  const lastAt: Partial<Record<Sfx, number>> = {};
  const MIN_GAP: Partial<Record<Sfx, number>> = { pop: 0.07, join: 0.12, tick: 0.3 };

  function playSfx(name: Sfx): void {
    const now = ctx.currentTime;
    const gap = MIN_GAP[name] ?? 0;
    if (gap && now - (lastAt[name] ?? -1) < gap) return;
    lastAt[name] = now;
    const o = sfxBus;

    switch (name) {
      case "pop":
        // 「啵」：往上滑的短音加一點點雜音
        tone(280, now, 0.12, "sine", 0.7, o, 950);
        noise(now, 0.03, 0.25, o, "highpass", 3000);
        break;
      case "join":
        tone(660, now, 0.08, "triangle", 0.4, o);
        tone(990, now + 0.07, 0.1, "triangle", 0.4, o);
        break;
      case "tick":
        tone(1000, now, 0.06, "square", 0.18, o);
        break;
      case "start":
        // 哨音：嗶、嗶、嗶——
        for (const [dt, len] of [[0, 0.12], [0.2, 0.12], [0.4, 0.5]] as const) {
          const osc = ctx.createOscillator();
          const lfo = ctx.createOscillator();
          const lfoGain = ctx.createGain();
          const gn = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = 2100;
          lfo.frequency.value = 28;
          lfoGain.gain.value = 60;
          lfo.connect(lfoGain).connect(osc.frequency);
          gn.gain.setValueAtTime(0.0001, now + dt);
          gn.gain.exponentialRampToValueAtTime(0.35, now + dt + 0.01);
          gn.gain.setValueAtTime(0.35, now + dt + len - 0.03);
          gn.gain.exponentialRampToValueAtTime(0.0001, now + dt + len);
          osc.connect(gn).connect(o);
          osc.start(now + dt);
          lfo.start(now + dt);
          osc.stop(now + dt + len + 0.02);
          lfo.stop(now + dt + len + 0.02);
        }
        break;
      case "reveal": {
        // 小鼓滾奏 0.9 秒，越來越大聲，然後「登登！」
        for (let i = 0; i < 22; i++) {
          noise(now + i * 0.04, 0.05, 0.08 + i * 0.012, o, "bandpass", 1800, 0.8);
        }
        const hit = now + 0.95;
        kick(hit, o);
        noise(hit, 0.4, 0.4, o, "highpass", 5000);
        for (const m of [72, 76, 79, 84]) tone(hz(m), hit, 0.9, "square", 0.09, o);
        break;
      }
      case "cheer": {
        // 群眾歡呼：一團帶通雜音當「人聲」，上面疊一些往上飄的「喔～」和拍手
        const body = ctx.createBufferSource();
        body.buffer = getNoise();
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 1100;
        bp.Q.value = 0.6;
        const gn = ctx.createGain();
        gn.gain.setValueAtTime(0.0001, now);
        gn.gain.exponentialRampToValueAtTime(0.5, now + 0.25);
        gn.gain.setValueAtTime(0.5, now + 1.2);
        gn.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
        body.connect(bp).connect(gn).connect(o);
        body.start(now);
        body.stop(now + 2.7);
        for (let i = 0; i < 9; i++) {
          const st = now + Math.random() * 0.6;
          const f0 = 300 + Math.random() * 250;
          tone(f0, st, 0.7 + Math.random() * 0.6, "sawtooth", 0.025, o, f0 * 1.8);
        }
        for (let i = 0; i < 40; i++) {
          noise(now + Math.random() * 2, 0.04, 0.12, o, "bandpass", 1500 + Math.random() * 1500, 1.5);
        }
        break;
      }
      case "end":
        // 時間到：往下的兩個音
        tone(hz(76), now, 0.25, "square", 0.14, o);
        tone(hz(69), now + 0.25, 0.55, "square", 0.14, o);
        break;
      case "fanfare":
        for (const [i, m] of [72, 76, 79, 84].entries()) {
          tone(hz(m), now + i * 0.13, 0.25, "sawtooth", 0.08, o);
        }
        for (const m of [72, 76, 79, 84]) tone(hz(m), now + 0.55, 1.4, "sawtooth", 0.06, o);
        kick(now + 0.55, o);
        break;
      case "ding":
        tone(1320, now, 0.7, "sine", 0.3, o);
        tone(2640, now, 0.4, "sine", 0.12, o);
        break;
    }
  }

  /* ---------- 背景音樂的排程 ----------
     標準的 look-ahead 排程：每 25ms 醒來一次，把接下來 0.15 秒內
     要響的音符先排進 AudioContext 的時間軸。音符的時間是 AudioContext
     管的，所以就算 JS 偶爾卡一下，節拍也不會歪。 */
  let style: BgmStyle | null = null;
  let step = 0;
  let nextAt = 0;

  function scheduleStep(song: Song, s: number, at: number): void {
    const o = bgmBus;
    const bar = Math.floor(s / 8) % 4;
    const pos = s % 8;
    const beat = 60 / song.bpm;

    const m = song.melody[bar]?.[pos] ?? -1;
    if (m > 0) tone(hz(m), at, beat * 0.45, "square", 0.22, o);

    const root = song.roots[bar] ?? 48;
    // 低音：每拍一下
    if (pos % 2 === 0) tone(hz(root - 12 + (pos === 4 ? 7 : 0)), at, beat * 0.45, "triangle", 0.5, o);
    // 和弦：小節頭一個長音
    if (pos === 0) {
      const minor = song.minor[bar] ?? false;
      for (const iv of [0, minor ? 3 : 4, 7]) tone(hz(root + 12 + iv), at, beat * 3.8, "triangle", 0.12, o);
    }

    // 鼓
    if (song.drums === "calm") {
      if (pos % 2 === 1) noise(at, 0.03, 0.12, o, "highpass", 7000);
    } else if (song.drums === "drive") {
      if (pos % 4 === 0) kick(at, o);
      if (pos % 4 === 2) noise(at, 0.09, 0.35, o, "bandpass", 1500, 0.7);
      noise(at, 0.025, 0.1, o, "highpass", 8000);
    } else {
      if (pos % 2 === 0) kick(at, o);
      if (pos === 3 || pos === 7) noise(at, 0.12, 0.3, o, "bandpass", 1200, 0.7);
    }
  }

  setInterval(() => {
    if (!style || !bgmOn || ctx.state !== "running") return;
    const song = SONGS[style];
    const eighth = 60 / song.bpm / 2;
    if (nextAt < ctx.currentTime) nextAt = ctx.currentTime + 0.05;
    while (nextAt < ctx.currentTime + 0.15) {
      scheduleStep(song, step, nextAt);
      step = (step + 1) % 32;
      nextAt += eighth;
    }
  }, 25);

  return {
    get unlocked() {
      return ctx.state === "running";
    },
    unlock() {
      if (ctx.state !== "running") void ctx.resume();
    },
    sfx(name) {
      if (!sfxOn || ctx.state !== "running") return;
      playSfx(name);
    },
    setBgm(next) {
      if (next === style) return;
      style = next;
      step = 0;
      nextAt = 0;
    },
    setEnabled(bgm, sfx) {
      bgmOn = bgm;
      sfxOn = sfx;
      // 關掉的時候淡出，不要一刀切掉聽起來像壞掉
      bgmBus.gain.setTargetAtTime(bgm ? 0.16 : 0, ctx.currentTime, 0.15);
    },
  };
}
