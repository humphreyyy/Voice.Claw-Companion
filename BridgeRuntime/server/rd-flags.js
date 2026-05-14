// Project-Intercom R&D clone feature flags.
// Defaults are deliberately OFF so this clone behaves like current Intercom
// unless an experiment is explicitly enabled in the clone environment.

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export const INTERCOM_RD_FLAGS = Object.freeze({
  enabled: envFlag('INTERCOM_RD_ENABLED', false),
  uiExperimentModes: envFlag('INTERCOM_RD_UI_EXPERIMENT_MODES', false),
  directRealtimeMcp: envFlag('INTERCOM_RD_DIRECT_REALTIME_MCP', false),
  responsesSidecarTool: envFlag('INTERCOM_RD_RESPONSES_SIDECAR_TOOL', false),
  localOpenClawMcp: envFlag('INTERCOM_RD_LOCAL_OPENCLAW_MCP', false),
  traceEvents: envFlag('INTERCOM_RD_TRACE_EVENTS', false),
});

export const INTERCOM_RD_ROUTE_MODES = Object.freeze([
  {
    id: 'openclaw-mcp',
    label: 'OpenClaw Bridge — direct Realtime MCP tools (R&D)',
    flag: 'directRealtimeMcp',
    patchPoint: 'server/index.js REALTIME_TOOLS + Realtime session.tools',
  },
  {
    id: 'openclaw-responses-sidecar',
    label: 'OpenClaw Bridge — Responses sidecar function tool (R&D)',
    flag: 'responsesSidecarTool',
    patchPoint: 'server/index.js handleRealtimeSidebandToolCall + server/dialogue.js sidecar adapter',
  },
  {
    id: 'openclaw-local-mcp',
    label: 'OpenClaw Bridge — local MCP adapter (R&D)',
    flag: 'localOpenClawMcp',
    patchPoint: 'server/index.js Realtime function tool -> official MCP stdio client -> local OpenClaw CLI status/config tools',
  },
]);

export function activeRdRouteModes() {
  if (!INTERCOM_RD_FLAGS.enabled || !INTERCOM_RD_FLAGS.uiExperimentModes) return [];
  return INTERCOM_RD_ROUTE_MODES.filter((mode) => INTERCOM_RD_FLAGS[mode.flag]);
}

export function rdRouteModeIds() {
  return activeRdRouteModes().map((mode) => mode.id);
}

export function describeRdFlags() {
  return {
    ...INTERCOM_RD_FLAGS,
    activeRouteModes: activeRdRouteModes(),
  };
}
