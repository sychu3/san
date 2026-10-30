/**
 * 以 Web Audio API 合成短音效，不引入任何外部音檔，因此不需要放寬 CSP。
 * 預設不播放；只有在使用者開啟設定且瀏覽器允許時才會建立 AudioContext。
 */
export type SoundName = 'click' | 'play' | 'damage' | 'death' | 'win';

let context: AudioContext | null = null;

type AudioContextCtor = new () => AudioContext;

function getAudioContext(): AudioContext | null {
  if (context) return context;
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor })
    .AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!ctor) return null;
  try {
    context = new ctor();
  } catch {
    context = null;
  }
  return context;
}

interface ToneSpec {
  frequency: number;
  duration: number;
  type: OscillatorType;
  gain: number;
  slideTo?: number;
}

const TONES: Record<SoundName, ToneSpec> = {
  click: { frequency: 640, duration: 0.05, type: 'triangle', gain: 0.06 },
  play: { frequency: 480, duration: 0.09, type: 'triangle', gain: 0.08 },
  damage: { frequency: 180, duration: 0.14, type: 'square', gain: 0.09, slideTo: 90 },
  death: { frequency: 130, duration: 0.28, type: 'sawtooth', gain: 0.09, slideTo: 60 },
  win: { frequency: 660, duration: 0.3, type: 'triangle', gain: 0.1, slideTo: 990 },
};

export function playSound(name: SoundName, enabled: boolean): void {
  if (!enabled) return;
  const audio = getAudioContext();
  if (!audio) return;
  try {
    const spec = TONES[name];
    const now = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(spec.frequency, now);
    if (spec.slideTo) oscillator.frequency.linearRampToValueAtTime(spec.slideTo, now + spec.duration);
    gain.gain.setValueAtTime(spec.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + spec.duration);
  } catch {
    // 音效非必要功能；任何失敗都忽略。
  }
}

/** 測試用：清掉快取的 AudioContext。 */
export function resetAudioForTests(): void {
  context = null;
}
