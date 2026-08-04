import type { VoiceClawDesktopAPI } from '../../shared/contracts';

declare global {
  interface Window {
    voiceclaw?: VoiceClawDesktopAPI;
  }
}

export {};
