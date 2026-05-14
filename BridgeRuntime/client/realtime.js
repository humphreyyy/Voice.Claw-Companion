const statusText = document.querySelector('#bridgeStatus');
const chip = document.querySelector('#bridgeStateChip');
const detail = document.querySelector('#bridgeDetail');

async function refreshStatus() {
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    statusText.textContent = 'Ready';
    chip.textContent = 'Bridge Ready';
    chip.classList.add('ok');
    detail.textContent = `Listening on ${payload.bindHost}:${payload.port}. Pair your iPhone from the VoiceClaw Bridge app to use this private OpenClaw handoff.`;
  } catch (error) {
    statusText.textContent = 'Needs Attention';
    chip.textContent = 'Bridge Check Failed';
    chip.classList.remove('ok');
    detail.textContent = `The local bridge health check failed: ${error.message}`;
  }
}

refreshStatus();
setInterval(refreshStatus, 15_000);
