import * as path from 'node:path';

export interface PathMapping {
  remotePrefix: string;
  localPrefix: string;
  source?: 'configured' | 'localWorkspaceFolder';
}

export interface BuildEffectivePathMappingsOptions {
  configuredMappings: readonly Partial<PathMapping>[];
  localWorkspaceFolder?: string;
  inferredLocalWorkspaceFolder?: string;
  remoteWorkspaceFolders: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface MappedPath {
  remotePath: string;
  localPath: string;
  mapping: PathMapping;
}

export function buildEffectivePathMappings(options: BuildEffectivePathMappingsOptions): PathMapping[] {
  const mappings = options.configuredMappings
    .filter((mapping): mapping is Pick<PathMapping, 'remotePrefix' | 'localPrefix'> => {
      return Boolean(mapping.remotePrefix?.trim() && mapping.localPrefix?.trim());
    })
    .map((mapping) => normalizeMapping(mapping, options.env, 'configured'));

  const localWorkspaceFolder = normalizeConfiguredLocalWorkspaceFolder(options.localWorkspaceFolder) || options.inferredLocalWorkspaceFolder?.trim();
  if (localWorkspaceFolder && options.remoteWorkspaceFolders.length === 1) {
    mappings.push(
      normalizeMapping(
        {
          remotePrefix: options.remoteWorkspaceFolders[0],
          localPrefix: localWorkspaceFolder
        },
        options.env,
        'localWorkspaceFolder'
      )
    );
  }

  return sortMappings(mappings);
}

export function inferDevcontainerHostPathFromAuthority(authority: string | undefined): string | undefined {
  if (!authority) {
    return undefined;
  }

  const decodedAuthority = decodeURIComponent(authority);
  const prefix = 'dev-container+';
  if (!decodedAuthority.startsWith(prefix)) {
    return undefined;
  }

  const hexPayload = decodedAuthority.slice(prefix.length);
  if (!/^[0-9a-fA-F]+$/.test(hexPayload) || hexPayload.length % 2 !== 0) {
    return undefined;
  }

  const payload = Buffer.from(hexPayload, 'hex').toString('utf8');
  try {
    const parsed = JSON.parse(payload) as {
      hostPath?: string;
      configFile?: {
        fsPath?: string;
        path?: string;
      };
    };

    return parsed.hostPath || inferHostPathFromConfigFile(parsed.configFile?.fsPath || parsed.configFile?.path);
  } catch {
    return payload.trim() || undefined;
  }
}

export function mapRemotePath(remotePath: string | undefined, mappings: readonly PathMapping[]): MappedPath | undefined {
  if (!remotePath) {
    return undefined;
  }

  const normalizedRemotePath = normalizeRemotePath(remotePath);
  const mapping = sortMappings(mappings).find((candidate) => {
    return isRemotePathInside(candidate.remotePrefix, normalizedRemotePath);
  });

  if (!mapping) {
    return undefined;
  }

  const relativePath = relativeRemotePath(mapping.remotePrefix, normalizedRemotePath);
  return {
    remotePath: normalizedRemotePath,
    localPath: relativePath ? path.join(mapping.localPrefix, ...relativePath.split('/')) : mapping.localPrefix,
    mapping
  };
}

export function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(remotePath.replaceAll('\\', '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function expandLocalPath(localPath: string, env: NodeJS.ProcessEnv): string {
  const expandedHome = localPath.startsWith('~/') ? path.join(env.HOME || '', localPath.slice(2)) : localPath;

  return path.resolve(
    expandedHome.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, bare, braced) => {
      return env[bare || braced] || '';
    })
  );
}

function normalizeMapping(
  mapping: Pick<PathMapping, 'remotePrefix' | 'localPrefix'>,
  env: NodeJS.ProcessEnv,
  source: PathMapping['source']
): PathMapping {
  return {
    remotePrefix: stripTrailingSlash(normalizeRemotePath(mapping.remotePrefix)),
    localPrefix: expandLocalPath(mapping.localPrefix, env),
    source
  };
}

function normalizeConfiguredLocalWorkspaceFolder(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '${localWorkspaceFolder}') {
    return undefined;
  }

  return trimmed;
}

function inferHostPathFromConfigFile(configFilePath: string | undefined): string | undefined {
  if (!configFilePath) {
    return undefined;
  }

  const normalized = configFilePath.replaceAll('\\', '/');
  const marker = '/.devcontainer/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return path.dirname(configFilePath);
  }

  return configFilePath.slice(0, markerIndex);
}

function sortMappings(mappings: readonly PathMapping[]): PathMapping[] {
  return [...mappings].sort((left, right) => right.remotePrefix.length - left.remotePrefix.length);
}

function isRemotePathInside(parentPath: string, childPath: string): boolean {
  const parent = stripTrailingSlash(normalizeRemotePath(parentPath));
  const child = stripTrailingSlash(normalizeRemotePath(childPath));
  return child === parent || child.startsWith(`${parent}/`);
}

function relativeRemotePath(parentPath: string, childPath: string): string {
  const parent = stripTrailingSlash(normalizeRemotePath(parentPath));
  const child = stripTrailingSlash(normalizeRemotePath(childPath));

  if (child === parent) {
    return '';
  }

  return child.slice(parent.length + 1);
}

function stripTrailingSlash(inputPath: string): string {
  return inputPath.length > 1 ? inputPath.replace(/\/+$/, '') : inputPath;
}
