import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import JSON5 from 'json5';

export const DEFAULT_OPENCLAW_AGENT_ID = 'main';

function nonEmptyString(value = '') {
  return String(value || '').trim();
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeOpenClawAgentID(value) {
  return nonEmptyString(value).toLowerCase();
}

export function parseOpenClawConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON5.parse(raw);
  }
}

export function expandOpenClawPath(value, home = homedir()) {
  const path = nonEmptyString(value);
  if (!path) return '';
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? path : path;
}

function addAgentRecord(records, candidate) {
  const id = nonEmptyString(candidate.id);
  const normalizedID = normalizeOpenClawAgentID(id);
  if (!normalizedID) return;

  const aliases = new Set(
    (candidate.aliases || [])
      .map(nonEmptyString)
      .filter((alias) => alias && normalizeOpenClawAgentID(alias) !== normalizedID),
  );
  const existing = records.get(normalizedID);
  if (existing) {
    for (const alias of aliases) existing.aliases.add(alias);
    existing.workspace = nonEmptyString(candidate.workspace) || existing.workspace;
    existing.agentDir = nonEmptyString(candidate.agentDir) || existing.agentDir;
    existing.isDefault ||= candidate.isDefault === true;
    existing.sources.add(candidate.source);
    return;
  }

  records.set(normalizedID, {
    id,
    normalizedID,
    aliases,
    workspace: nonEmptyString(candidate.workspace),
    agentDir: nonEmptyString(candidate.agentDir),
    isDefault: candidate.isDefault === true,
    sources: new Set([candidate.source]),
  });
}

function addListAgents(records, list) {
  if (!Array.isArray(list)) return false;
  for (const value of list) {
    const entry = objectValue(value);
    const id = nonEmptyString(entry.id || entry.name);
    addAgentRecord(records, {
      id,
      aliases: [entry.name],
      workspace: entry.workspace,
      agentDir: entry.agentDir,
      isDefault: entry.default === true,
      source: 'agents.list',
    });
  }
  return true;
}

function addKeyedAgents(records, entries, source) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
  for (const [key, value] of Object.entries(entries)) {
    const entry = objectValue(value);
    const id = nonEmptyString(entry.id || key);
    addAgentRecord(records, {
      id,
      aliases: [key, entry.name],
      workspace: entry.workspace,
      agentDir: entry.agentDir,
      isDefault: entry.default === true,
      source,
    });
  }
  return true;
}

function legacyAgentContainer(parsed) {
  if (parsed?.agent) return parsed.agent;
  if (parsed?.profiles) return parsed.profiles;

  const agents = objectValue(parsed?.agents);
  const hasModernContainer = Object.hasOwn(agents, 'defaults')
    || Object.hasOwn(agents, 'entries')
    || Object.hasOwn(agents, 'list');
  return hasModernContainer ? null : agents;
}

export function configuredOpenClawAgents(parsed, options = {}) {
  const home = options.home || homedir();
  const records = new Map();
  const agents = objectValue(parsed?.agents);
  const hasList = addListAgents(records, agents.list);
  const hasEntries = addKeyedAgents(records, agents.entries, 'agents.entries');

  if (!hasList && !hasEntries) {
    const legacy = legacyAgentContainer(parsed);
    if (Array.isArray(legacy)) {
      addListAgents(records, legacy);
    } else {
      addKeyedAgents(records, legacy, 'legacy-map');
    }
  }

  if (records.size === 0) {
    const implicitAgentID = nonEmptyString(options.implicitAgentID) || DEFAULT_OPENCLAW_AGENT_ID;
    addAgentRecord(records, {
      id: implicitAgentID,
      workspace: agents.defaults?.workspace,
      isDefault: true,
      source: implicitAgentID === DEFAULT_OPENCLAW_AGENT_ID
        ? 'implicit-main'
        : 'selected-default-workspace',
    });
  }

  const configured = [...records.values()];
  const defaultAgent = configured.find((agent) => agent.isDefault) || configured[0];
  const defaultsWorkspace = nonEmptyString(agents.defaults?.workspace);
  const defaultWorkspace = expandOpenClawPath(defaultsWorkspace, home);

  const normalized = configured.map((agent) => {
    let workspace = expandOpenClawPath(agent.workspace, home);
    if (!workspace && defaultWorkspace) {
      workspace = agent.normalizedID === defaultAgent.normalizedID
        ? defaultWorkspace
        : join(defaultWorkspace, agent.id);
    }
    return {
      id: agent.id,
      normalizedID: agent.normalizedID,
      aliases: [...agent.aliases],
      workspace,
      agentDir: expandOpenClawPath(agent.agentDir, home),
      isDefault: agent.normalizedID === defaultAgent.normalizedID,
      sources: [...agent.sources],
    };
  });

  return {
    agents: normalized,
    ids: normalized.map((agent) => agent.id),
    aliases: normalized.flatMap((agent) => agent.aliases),
    defaultAgentID: defaultAgent.id,
    sources: [...new Set(normalized.flatMap((agent) => agent.sources))],
  };
}

export function resolveConfiguredOpenClawAgent(parsed, selectedAgentID, options = {}) {
  const catalog = configuredOpenClawAgents(parsed, {
    ...options,
    implicitAgentID: selectedAgentID,
  });
  const selected = normalizeOpenClawAgentID(selectedAgentID || catalog.defaultAgentID);
  const agent = catalog.agents.find((candidate) => (
    candidate.normalizedID === selected
    || candidate.aliases.some((alias) => normalizeOpenClawAgentID(alias) === selected)
  ));
  return { catalog, agent: agent || null };
}

export function configuredOpenClawAgentDirectories(parsed, options = {}) {
  return configuredOpenClawAgents(parsed, options).agents
    .map((agent) => agent.agentDir)
    .filter(Boolean);
}
