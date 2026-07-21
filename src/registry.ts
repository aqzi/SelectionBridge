import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PointerSnapshot } from './pointer';

export const REGISTRY_SCHEMA_VERSION = 1;

export interface RegistryWorkspaceFolder {
  name: string;
  uri: string;
  path?: string;
  index: number;
}

export interface RegistryEntry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  id: string;
  port: number;
  token: string;
  pid: number;
  workspaceName?: string;
  workspaceFolders: RegistryWorkspaceFolder[];
  activeDocumentUri?: string;
  activeDocumentPath?: string;
  lastPointerKind: PointerSnapshot['kind'];
  lastSelectionCapturedAt: string;
  createdAt: string;
  updatedAt: string;
  vscodeSessionId?: string;
}

export function getPointerHome(): string {
  return (
    process.env.SELECTION_BRIDGE_HOME ||
    process.env.THIS_POINTER_HOME ||
    path.join(os.homedir(), '.selection-bridge')
  );
}

export function getInstancesDir(): string {
  return path.join(getPointerHome(), 'instances');
}

export function getInstanceFilePath(instanceId: string): string {
  return path.join(getInstancesDir(), `${instanceId}.json`);
}

export function ensureRegistryDirectory(): void {
  const home = getPointerHome();
  const instances = getInstancesDir();
  fs.mkdirSync(instances, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(home, 0o700);
    fs.chmodSync(instances, 0o700);
  } catch {
    // Best effort only. Existing permissions may be controlled by the host OS.
  }
}

export class RegistryWriter {
  private instanceFilePath: string;

  public constructor(private readonly instanceId: string) {
    ensureRegistryDirectory();
    this.instanceFilePath = getInstanceFilePath(instanceId);
  }

  public write(entry: RegistryEntry): void {
    ensureRegistryDirectory();

    const tempPath = path.join(
      getInstancesDir(),
      `${this.instanceId}.${process.pid}.${Date.now()}.tmp`
    );
    const json = `${JSON.stringify(entry, null, 2)}\n`;

    fs.writeFileSync(tempPath, json, { mode: 0o600 });
    fs.renameSync(tempPath, this.instanceFilePath);

    try {
      fs.chmodSync(this.instanceFilePath, 0o600);
    } catch {
      // Best effort only. Atomic rename is the important part.
    }
  }

  public dispose(): void {
    try {
      fs.unlinkSync(this.instanceFilePath);
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}

export function cleanupStaleRegistryFiles(maxAgeMs: number): void {
  ensureRegistryDirectory();

  const now = Date.now();
  for (const fileName of fs.readdirSync(getInstancesDir())) {
    if (!fileName.endsWith('.json')) {
      continue;
    }

    const filePath = path.join(getInstancesDir(), fileName);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RegistryEntry>;
      const updatedAt = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : Number.NaN;
      if (!Number.isFinite(updatedAt) || now - updatedAt > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch {
      fs.unlinkSync(filePath);
    }
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
