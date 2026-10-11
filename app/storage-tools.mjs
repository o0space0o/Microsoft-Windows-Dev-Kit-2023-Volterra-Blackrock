import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const maximumCount = (1n << 64n) - 1n;
const count = value => {
  if (typeof value !== 'bigint' || value < 0n || value > maximumCount) throw new Error('The filesystem returned unsupported capacity readings.');
  return value.toString();
};

export function storageQuery(message) {
  return typeof message === 'string' && /^(?:(?:show|list) )?storage$/i.test(message.trim()) ? {} : null;
}

export async function collectStorage(directory, { filesystem = fs } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute workspace folder is required.');
  const workspace = await filesystem.realpath(directory);
  const before = await filesystem.stat(workspace, { bigint: true });
  if (!before.isDirectory()) throw new Error('The workspace is not a directory.');
  const capacity = await filesystem.statfs(workspace, { bigint: true });
  const after = await filesystem.stat(workspace, { bigint: true });
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || await filesystem.realpath(directory) !== workspace) {
    throw new Error('The workspace changed during the capacity query. Refresh the reading.');
  }
  return { version: 1, kind: 'storage', observedAt: new Date().toISOString(), requestedWorkspace: directory, workspace,
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch },
    blocks: { size: count(capacity.bsize), total: count(capacity.blocks), free: count(capacity.bfree), available: count(capacity.bavail) } };
}

export async function inspectStorage(directory, collect = collectStorage) {
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute workspace folder is required.');
    const raw = await collect(directory);
    if (raw?.version !== 1 || raw.kind !== 'storage' || raw.requestedWorkspace !== directory
      || typeof raw.workspace !== 'string' || !path.isAbsolute(raw.workspace) || raw.workspace.length > 4096
      || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || !raw.system
      || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string')
      || !raw.blocks || ['size', 'total', 'free', 'available'].some(key => typeof raw.blocks[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(raw.blocks[key]))) {
      throw new Error('The storage collector returned unsupported evidence.');
    }
    const blocks = Object.fromEntries(Object.entries(raw.blocks).filter(([key]) => ['size', 'total', 'free', 'available'].includes(key)).map(([key, value]) => [key, BigInt(value)]));
    if (Object.values(blocks).some(value => value > maximumCount) || blocks.size === 0n || blocks.total === 0n || blocks.free > blocks.total || blocks.available > blocks.free) {
      throw new Error('The filesystem returned inconsistent capacity readings.');
    }
    return { status: 'passed', observedAt: raw.observedAt, workspace: text(raw.workspace, 4096),
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 64)])),
      environment: 'Current OS session; VM or physical identity unverified', source: 'Node filesystem capacity API', scope: 'Workspace filesystem',
      totalBytes: (blocks.size * blocks.total).toString(), usedBytes: (blocks.size * (blocks.total - blocks.free)).toString(),
      freeBytes: (blocks.size * blocks.free).toString(), availableBytes: (blocks.size * blocks.available).toString() };
  } catch (error) {
    return { status: 'blocked', error: { stage: 'Workspace storage capacity', message: text(error?.message || 'The capacity query did not succeed.') } };
  }
}

function capacityText(value) {
  const gibibyte = 1n << 30n;
  const hundredths = (BigInt(value) * 100n + gibibyte / 2n) / gibibyte;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} GiB (${value} bytes)`;
}

export function storageReport(result) {
  if (result.status !== 'passed') return `Storage capacity is blocked. ${result.error.stage}: ${result.error.message}`;
  return [`Live storage capacity · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Workspace: ${result.workspace}\nScope: Filesystem containing this workspace. Physical disk, partition and recovery verification remain pending.`,
    `Total capacity: ${capacityText(result.totalBytes)}.\nUsed capacity: ${capacityText(result.usedBytes)}.\nFree capacity: ${capacityText(result.freeBytes)}.\nAvailable capacity: ${capacityText(result.availableBytes)}.`,
    'Use the available capacity reading when planning workspace writes. This query does not write files or change storage settings.'].join('\n\n');
}
