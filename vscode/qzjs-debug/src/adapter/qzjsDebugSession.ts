import { DebugSession, InitializedEvent, TerminatedEvent, OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { QzjsLaunchConfig } from './descriptorFactory';

/**
 * Inline DAP session: relays VS Code DAP requests to the qzjs runtime's
 * stdio DAP server, and forwards events (stopped/terminated/output) back.
 *
 * The qzjs side implements: initialize, attach, setBreakpoints,
 * configurationDone, threads, stackTrace, scopes, variables, continue,
 * next, stepIn, stepOut, evaluate, disconnect. This session adds the
 * process spawn (QZ_DEBUG=1) and translates `launch` into `attach` (the
 * runtime has no `launch` handler — it is always already running when it
 * speaks DAP).
 */
export class QzjsDebugSession extends DebugSession {
  private cfg: QzjsLaunchConfig;
  private readonly pending = new Map<
    number,
    { resolve: (r: DebugProtocol.Response) => void; reject: (e: Error) => void }
  >();
  private child?: ChildProcess;
  private childSeq = 1;
  private buffer = '';
  private terminatedSent = false;

  constructor(cfg: QzjsLaunchConfig) {
    super();
    this.cfg = cfg;
    this.setDebuggerLinesStartAt1(true);
  }

  dispose(): void {
    this.killChild();
  }

  // ── child lifecycle ────────────────────────────────────────────────

  private killChild(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }

  private startChild(): void {
    const env = { ...process.env, QZ_DEBUG: '1', ...(this.cfg.env ?? {}) };
    // Absolute, so the path the CLI names the script with is byte-identical to
    // the path VS Code sends in setBreakpoints (bp_find matches exactly).
    const program = path.resolve(this.cfg.program);
    const args = [...(this.cfg.runtimeArgs ?? []), program];
    this.child = spawn(this.cfg.runtimeExecutable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.on('error', (err) => {
      // ENOENT / EACCES on the runtime binary: surface it, then end the
      // session instead of leaving VS Code waiting on a child that isn't there.
      this.sendEvent(
        new OutputEvent(
          `qzjs: cannot start ${this.cfg.runtimeExecutable}: ${err.message}\n`,
          'stderr',
        ),
      );
      this.markTerminated();
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onChildData(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) =>
      this.sendEvent(new OutputEvent(chunk, 'stderr')),
    );
    this.child.on('exit', () => {
      this.markTerminated();
    });
  }

  private markTerminated(): void {
    if (!this.terminatedSent) {
      this.terminatedSent = true;
      this.sendEvent(new TerminatedEvent());
    }
  }

  private onChildData(chunk: string): void {
    this.buffer += chunk;
    // DAP framing: Content-Length: N\r\n\r\n<body>
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // non-framed output (e.g. console.log before attach) — forward it
        this.sendEvent(new OutputEvent(this.buffer, 'stdout'));
        this.buffer = '';
        return;
      }
      const len = Number.parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) break; // wait for more
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      this.dispatchChildMessage(JSON.parse(body));
    }
  }

  private dispatchChildMessage(
    msg: DebugProtocol.Response | DebugProtocol.Event,
  ): void {
    if (msg.type === 'response') {
      const r = msg as DebugProtocol.Response;
      const entry = this.pending.get(r.request_seq);
      if (entry) {
        this.pending.delete(r.request_seq);
        entry.resolve(r);
      } else {
        // unsolicited response — surface as output for diagnosis
        this.sendEvent(new OutputEvent(`${JSON.stringify(r)}\n`, 'stderr'));
      }
      return;
    }
    // event: forward to VS Code
    const ev = msg as DebugProtocol.Event;
    this.sendEvent(ev);
  }

  private sendToChild(
    command: string,
    args?: object,
  ): Promise<DebugProtocol.Response> {    // Plain Promise: the extension host's Node may predate Promise.withResolvers.
    let resolve!: (r: DebugProtocol.Response) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<DebugProtocol.Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (!this.child?.stdin) {
      reject(new Error('child not running'));
      return promise;
    }
    const seq = ++this.childSeq;
    this.pending.set(seq, { resolve, reject });
    const body = JSON.stringify({
      type: 'request',
      seq,
      command,
      arguments: args ?? {},
    });
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    // safety: never hang forever on a stuck runtime
    setTimeout(() => {
      if (this.pending.has(seq)) {
        this.pending.delete(seq);
        reject(new Error(`qzjs DAP timeout on ${command}`));
      }
    }, 10_000);
    return promise;
  }

  // ── VS Code → session requests ─────────────────────────────────────

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsTerminateRequest = false;
    this.sendResponse(response);
    // The runtime is spawned lazily on attach/launch so the initialize
    // handshake reaches a live DAP server.
    this.startChild();
    this.sendToChild('initialize', {
      adapterID: 'qzjs',
      clientID: 'vscode',
      linesStartAt1: true,
      columnsStartAt1: true,
    }).then(
      () => this.sendEvent(new InitializedEvent()),
      (err: Error) => {
        this.sendEvent(
          new OutputEvent(`qzjs: DAP initialize failed: ${err.message}\n`, 'stderr'),
        );
        this.markTerminated();
      },
    );
  }

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: DebugProtocol.LaunchRequestArguments,
  ): void {
    // The runtime is already the DAP server (spawned in initialize);
    // qzjs implements `attach`, so translate.
    this.attachRequest(
      response as unknown as DebugProtocol.AttachResponse,
      args as DebugProtocol.AttachRequestArguments,
    );
  }

  /**
   * Forward one request to the child DAP server and answer VS Code with its
   * result — or with its failure as an error response. Every relayed request
   * goes through here so a dead/hung child can never turn into an unhandled
   * rejection in the extension host.
   */
  private relay(
    response: DebugProtocol.Response,
    command: string,
    args?: object,
  ): void {
    this.sendToChild(command, args).then(
      (r) => {
        response.body = r.body;
        this.sendResponse(response);
      },
      (err: Error) => {
        response.success = false;
        response.message = err.message;
        this.sendResponse(response);
      },
    );
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    _args: DebugProtocol.AttachRequestArguments,
  ): void {
    this.relay(response, 'attach');
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    this.relay(response, 'setBreakpoints', {
      source: args.source,
      breakpoints: args.breakpoints ?? [],
    });
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    this.relay(response, 'configurationDone');
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    this.relay(response, 'threads');
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    this.relay(response, 'stackTrace', args);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    this.relay(response, 'scopes', args);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    this.relay(response, 'variables', args);
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): void {
    this.relay(response, 'evaluate', args);
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments,
  ): void {
    this.relay(response, 'continue', args);
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments,
  ): void {
    this.relay(response, 'next', args);
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): void {
    this.relay(response, 'stepIn', args);
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): void {
    this.relay(response, 'stepOut', args);
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments,
  ): void {
    this.relay(response, 'pause', args);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    this.sendToChild('disconnect').catch(() => {
      /* child may already be gone */
    });
    this.killChild();
    this.sendResponse(response);
    this.markTerminated();
  }
}
