/**
 * Safe read-only X-Ray refresh & consistency check runners for sidecar HTTP actions.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeWorkspacePath } from './tooling_xray.mjs';

const execFileAsync = promisify(execFile);
const ACTION_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 3500;
const WORKSPACE_MARKERS = ['.git', '.xray', 'Cargo.toml', 'package.json'];

function trimPreview(text) {
  const raw = String(text || '').trim();
  return raw.length > MAX_OUTPUT_CHARS ? `${raw.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : raw;
}

export function validateActionWorkspace(rawWorkspace, allowedWorkspaces = []) {
  const norm = normalizeWorkspacePath(rawWorkspace);
  if (!norm || !existsSync(norm)) {
    return { ok: false, error: 'Workspace directory does not exist', workspacePath: norm };
  }
  try {
    if (!statSync(norm).isDirectory()) {
      return { ok: false, error: 'Workspace path is not a directory', workspacePath: norm };
    }
  } catch {
    return { ok: false, error: 'Unable to inspect workspace directory', workspacePath: norm };
  }

  const resolved = resolve(norm);
  const normAllowed = allowedWorkspaces.map((w) => resolve(normalizeWorkspacePath(w))).filter(Boolean);
  const inAllowlist = normAllowed.some((w) =>
    process.platform === 'win32' ? w.toLowerCase() === resolved.toLowerCase() : w === resolved
  );
  const hasMarker = WORKSPACE_MARKERS.some((m) => existsSync(join(resolved, m)));

  if (!inAllowlist && !hasMarker) {
    return { ok: false, error: 'Workspace is neither active nor a recognized project root', workspacePath: resolved };
  }
  return { ok: true, workspacePath: resolved };
}

async function runProcessSafe(cmd, args, { cwd, timeoutMs = ACTION_TIMEOUT_MS, execRunner } = {}) {
  const started = Date.now();
  if (typeof execRunner === 'function') {
    const out = await execRunner(cmd, args, { cwd, timeout: timeoutMs });
    return {
      ok: Number(out?.exitCode ?? 0) === 0,
      exitCode: Number(out?.exitCode ?? 0),
      durationMs: Date.now() - started,
      stdoutPreview: trimPreview(out?.stdout),
      stderrPreview: trimPreview(out?.stderr),
      error: out?.error ? String(out.error) : '',
    };
  }

  try {
    const res = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      windowsHide: true,
    });
    return {
      ok: true,
      exitCode: 0,
      durationMs: Date.now() - started,
      stdoutPreview: trimPreview(res.stdout),
      stderrPreview: trimPreview(res.stderr),
      error: '',
    };
  } catch (err) {
    const code = typeof err?.code === 'number' ? err.code : 1;
    return {
      ok: false,
      exitCode: code,
      durationMs: Date.now() - started,
      stdoutPreview: trimPreview(err?.stdout),
      stderrPreview: trimPreview(err?.stderr),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runXrayRefresh({
  workspacePath,
  tooling,
  allowedWorkspaces = [],
  execRunner,
  homeDir = homedir(),
} = {}) {
  const checked = validateActionWorkspace(workspacePath, allowedWorkspaces);
  if (!checked.ok) {
    return { ok: false, status: 400, action: 'refresh', ...checked, stdoutPreview: '', stderrPreview: '' };
  }

  const entry = (tooling?.binaries || []).find((b) => b.id === 'xray-index');
  const exePath = entry?.exists && entry?.path ? entry.path : '';
  const xrayRun = join(homeDir, '.agents', 'bin', 'xray_run.py');

  let cmd = '';
  let args = [];
  if (exePath) {
    cmd = exePath;
    args = ['build', '--root', checked.workspacePath];
  } else if (existsSync(xrayRun)) {
    cmd = 'python';
    args = [xrayRun, 'xray-index', 'build', '--root', checked.workspacePath];
  } else {
    return {
      ok: false,
      status: 200,
      action: 'refresh',
      workspacePath: checked.workspacePath,
      error: 'xray-index binary not configured in ~/.agents/tooling.json',
      stdoutPreview: '',
      stderrPreview: '',
      durationMs: 0,
    };
  }

  const res = await runProcessSafe(cmd, args, { cwd: checked.workspacePath, execRunner });
  return { status: 200, action: 'refresh', workspacePath: checked.workspacePath, ...res };
}

export async function runXrayConsistencyCheck({
  workspacePath,
  allowedWorkspaces = [],
  execRunner,
  homeDir = homedir(),
} = {}) {
  const checked = validateActionWorkspace(workspacePath, allowedWorkspaces);
  if (!checked.ok) {
    return { ok: false, status: 400, action: 'check', ...checked, stdoutPreview: '', stderrPreview: '' };
  }

  const xrayRun = join(homeDir, '.agents', 'bin', 'xray_run.py');
  if (!existsSync(xrayRun)) {
    return {
      ok: false,
      status: 200,
      action: 'check',
      workspacePath: checked.workspacePath,
      error: 'Missing ~/.agents/bin/xray_run.py consistency runner',
      stdoutPreview: '',
      stderrPreview: '',
      durationMs: 0,
    };
  }

  const args = [xrayRun, 'check_consistency.py', '--repo-root', checked.workspacePath, '--include-polyglot'];
  const res = await runProcessSafe('python', args, { cwd: checked.workspacePath, execRunner });
  return { status: 200, action: 'check', workspacePath: checked.workspacePath, ...res };
}
