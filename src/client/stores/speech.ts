import { create } from 'zustand';

/** What the Read aloud player is doing for one reply. */
export type SpeechPhase = 'loading' | 'playing';

interface SpeechState {
  /** The reply being read, if any. Only one plays at a time. */
  key: string | null;
  phase: SpeechPhase | null;
  /** The last failure, by reply. */
  errors: Record<string, string>;
}

export const useSpeechStore = create<SpeechState>(() => ({ key: null, phase: null, errors: {} }));

/** Spoken audio by reply and model, kept for the session so replaying doesn't pay again. */
const clips = new Map<string, string>();
let audio: HTMLAudioElement | null = null;
let pending: AbortController | null = null;

export function stopSpeaking(): void {
  pending?.abort();
  pending = null;
  audio?.pause();
  audio = null;
  useSpeechStore.setState({ key: null, phase: null });
}

async function fetchSpeech(text: string, signal: AbortSignal): Promise<string> {
  const response = await fetch('/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    let message = `Reading aloud failed (${response.status})`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  return URL.createObjectURL(await response.blob());
}

/** Reads `text` aloud, or stops if this reply is the one already being read. */
export async function toggleSpeaking(key: string, text: string): Promise<void> {
  const wasThis = useSpeechStore.getState().key === key;
  stopSpeaking();
  if (wasThis) return;

  const { [key]: _old, ...errors } = useSpeechStore.getState().errors;
  useSpeechStore.setState({ key, phase: 'loading', errors });
  const controller = new AbortController();
  pending = controller;
  try {
    let url = clips.get(key);
    if (!url) {
      url = await fetchSpeech(text, controller.signal);
      clips.set(key, url);
    }
    if (controller.signal.aborted) return;
    pending = null;
    const player = new Audio(url);
    audio = player;
    player.addEventListener('ended', () => {
      if (audio === player) stopSpeaking();
    });
    await player.play();
    if (audio === player) useSpeechStore.setState({ phase: 'playing' });
  } catch (error) {
    if (controller.signal.aborted) return;
    stopSpeaking();
    const message = error instanceof Error ? error.message : String(error);
    useSpeechStore.setState((state) => ({ errors: { ...state.errors, [key]: message } }));
  }
}
