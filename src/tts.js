// Read-aloud using the device's built-in German voice.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let token = 0;

function germanVoices() {
  if (!synth) return [];
  return synth.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang));
}

function pickVoice(preferred) {
  const voices = germanVoices();
  return (
    voices.find((v) => v.voiceURI === preferred) ||
    voices.find((v) => /^de[-_]DE$/i.test(v.lang) && v.localService) ||
    voices.find((v) => /^de[-_]DE$/i.test(v.lang)) ||
    voices[0] ||
    null
  );
}

export const tts = {
  supported: !!synth,
  voices: germanVoices,

  /** Notify when the voice list becomes available (it loads late on some devices). */
  onVoices(fn) {
    if (synth) synth.addEventListener('voiceschanged', fn);
  },

  stop() {
    token++;
    if (synth) synth.cancel();
  },

  /**
   * Speak the given pieces one after another. `onPiece(i)` fires as each one
   * starts and `onDone()` when the last has finished or speech was stopped.
   */
  speak(pieces, { rate = 0.85, voice = '', onPiece, onDone } = {}) {
    if (!synth) return;
    this.stop();
    const mine = ++token;
    const chosen = pickVoice(voice);
    const next = (i) => {
      if (mine !== token) return;
      if (i >= pieces.length) {
        onDone?.();
        return;
      }
      const u = new SpeechSynthesisUtterance(pieces[i]);
      u.lang = chosen?.lang || 'de-DE';
      if (chosen) u.voice = chosen;
      u.rate = rate;
      u.onend = () => next(i + 1);
      u.onerror = () => {
        if (mine === token) onDone?.();
      };
      onPiece?.(i);
      synth.speak(u);
    };
    next(0);
  },
};
