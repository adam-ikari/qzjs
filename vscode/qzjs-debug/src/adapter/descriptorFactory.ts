import * as vscode from 'vscode';
import * as path from 'node:path';
import { QzjsDebugSession } from './qzjsDebugSession';

/**
 * Inline debug adapter: the DebugAdapterSession runs inside the extension
 * host and talks DAP to VS Code via a duplex stream pair. The session then
 * spawns the user's runtimeExecutable with QZ_DEBUG=1 — the qzjs runtime
 * itself is the DAP server on the child's stdio, and the session relays
 * frames between VS Code and the child.
 */
export class QzjsDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  private session?: QzjsDebugSession;

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const cfg = _session.configuration as QzjsLaunchConfig;
    // Breakpoints are matched against the path the CLI eval'd the script with,
    // and VS Code sends them as the document's own (absolute) path — so the
    // child must be launched with that same absolute string. A relative
    // `program` would otherwise be resolved against the extension host's cwd,
    // which is not the workspace: resolve it against the workspace folder here.
    const ws = _session.workspaceFolder?.uri.fsPath;
    if (cfg.program && !path.isAbsolute(cfg.program) && ws) {
      cfg.program = path.resolve(ws, cfg.program);
    }
    this.session = new QzjsDebugSession(cfg);

    // The DebugSession subclass *is* the inline adapter; VS Code wraps it
    // in a duplex stream. Returning DebugAdapterInlineImplementation(this.session)
    // would also work; the session itself implements the debug adapter protocol.
    return new vscode.DebugAdapterInlineImplementation(this.session);
  }

  dispose() {
    this.session?.dispose();
  }
}

export interface QzjsLaunchConfig {
  type: string;
  request: string;
  name?: string;
  program: string;
  runtimeExecutable: string;
  runtimeArgs?: string[];
  env?: Record<string, string>;
  stopOnEntry?: boolean;
}
