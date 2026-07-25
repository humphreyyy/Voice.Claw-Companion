export const PRODUCT_SURFACE_POLICY = Object.freeze({
  companionRealtimeVoiceVisible: false,
  powerhouseVisible: false,
  companionRealtimeVoiceBlocksReadiness: false,
  powerhouseBlocksReadiness: false,
});

export function accessItemIsVisible(item) {
  if (!item || typeof item !== 'object') return false;
  const id = String(item.id || '');
  if (['hf-runtime', 'hf-cache'].includes(id)) {
    return PRODUCT_SURFACE_POLICY.companionRealtimeVoiceVisible;
  }
  if (id === 'realtime-priority') {
    return PRODUCT_SURFACE_POLICY.companionRealtimeVoiceVisible
      || PRODUCT_SURFACE_POLICY.powerhouseVisible;
  }
  return true;
}

export function setupProductPolicy() {
  return {
    companionRealtimeVoiceVisible: PRODUCT_SURFACE_POLICY.companionRealtimeVoiceVisible,
    powerhouseVisible: PRODUCT_SURFACE_POLICY.powerhouseVisible,
    companionRealtimeVoiceBlocksReadiness: PRODUCT_SURFACE_POLICY.companionRealtimeVoiceBlocksReadiness,
    powerhouseBlocksReadiness: PRODUCT_SURFACE_POLICY.powerhouseBlocksReadiness,
  };
}
