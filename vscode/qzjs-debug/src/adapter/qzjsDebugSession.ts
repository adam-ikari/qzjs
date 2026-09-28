import { DebugSession, InitializedEvent, TerminatedEvent, OutputEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { QzjsLaunchConfig } from './descriptorFactory';

/**
 * Unwrap a JSON-encoded value for display. qz_debug_evaluate JSONStringify's
 * its result, so strings arrive quoted ("x") — log output wants them plain.
 */
function unwrapForDisplay(v: unknown): string {
  if (typeof v !== 'string') return String(v);
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * Length of the longest suffix of `buf` that is a prefix of the frame marker
 * — i.e. how many tail bytes might be a "Content-Length:" split across two
 * chunks and must not be flushed as program output.
 */
function partialMarkerSuffix(buf: string): number {
  const marker = 'Content-Length:';
  for (let k = Math.min(marker.length - 1, buf.length); k > 0; k--) {
    if (buf.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

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
  /** logpoints per source path → line → logMessage (replaced per file,
   * mirroring the C breakpoint table's per-source scoping). */
  private readonly logpoints = new Map<string, Map<number, string>>();

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
    // The child multiplexes DAP frames and the program's raw stdout onto the
    // same stream: anything that isn't part of a frame is program output and
    // goes to the Debug Console. (The old parser only forwarded text that
    // happened to contain \r\n\r\n — plain program output was either held
    // until a frame arrived and then silently swallowed with the header, or
    // kept in the buffer forever if the child exited without another frame.)
    for (;;) {
      const idx = this.buffer.indexOf('Content-Length:');
      if (idx < 0) {
        // No frame start in sight — but the tail may be a marker split
        // across chunks; hold that much back and flush the rest.
        const hold = partialMarkerSuffix(this.buffer);
        const flushable = this.buffer.length - hold;
        if (flushable > 0) {
          this.sendEvent(new OutputEvent(this.buffer.slice(0, flushable), 'stdout'));
          this.buffer = this.buffer.slice(flushable);
        }
        return;
      }
      if (idx > 0) {
        // Program output sitting before the next frame.
        this.sendEvent(new OutputEvent(this.buffer.slice(0, idx), 'stdout'));
        this.buffer = this.buffer.slice(idx);
      }
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return; // header incomplete — wait for more
      const m = /^Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, headerEnd));
      if (!m) {
        this.sendEvent(new OutputEvent(this.buffer, 'stdout'));
        this.buffer = '';
        return;
      }
      const len = Number.parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return; // body incomplete
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      try {
        this.dispatchChildMessage(JSON.parse(body));
      } catch (err) {
        // Not a real frame after all (program printed something that looked
        // like a header) — surface it and rescan; the next marker realigns.
        this.sendEvent(
          new OutputEvent(
            `qzjs: dropped malformed DAP frame: ${String(err)}\n`,
            'stderr',
          ),
        );
      }
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
    // event: forward to VS Code — except a breakpoint stop that may be a
    // logpoint hit, which is intercepted, rendered and auto-continued.
    const ev = msg as DebugProtocol.Event;
    if (ev.event === 'stopped' && (ev.body as { reason?: string })?.reason === 'breakpoint') {
      void this.interceptStop(ev);
      return;
    }
    this.sendEvent(ev);
  }

  /**
   * A breakpoint stop may actually be a logpoint hit: the engine must stop
   * (it can't know about logpoints), and the adapter decides — emit the
   * interpolated message to the Debug Console and continue, never telling
   * the client we stopped. Any failure falls open: the stop is delivered
   * rather than silently lost.
   */
  private async interceptStop(ev: DebugProtocol.Event): Promise<void> {
    try {
      const st = await this.sendToChild('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      });
      const top = (
        st.body as { stackFrames?: { id: number; line: number; source?: { path?: string } }[] }
      )?.stackFrames?.[0];
      const srcPath = top?.source?.path;
      if (top && srcPath !== undefined) {
        const tpl = this.logpoints.get(srcPath)?.get(top.line);
        if (tpl !== undefined) {
          const text = await this.renderLogMessage(tpl, top.id);
          this.sendEvent(
            new OutputEvent(text.endsWith('\n') ? text : text + '\n', 'console'),
          );
          await this.sendToChild('continue', { threadId: 1 });
          return; // swallowed: the client never learns we stopped
        }
      }
    } catch {
      // fall through — fail open
    }
    this.sendEvent(ev);
  }

  /**
   * DAP logMessage template: literal text with `{expression}` holes, each
   * evaluated in the paused top frame through the normal evaluate path
   * (so `locals.x` works here just like in watch).
   */
  private async renderLogMessage(tpl: string, frameId: number): Promise<string> {
    const parts = tpl.split(/(\{[^{}]*\})/g);
    let out = '';
    for (const part of parts) {
      if (part.length >= 2 && part.startsWith('{') && part.endsWith('}')) {
        const r = await this.sendToChild('evaluate', {
          expression: part.slice(1, -1),
          frameId,
        });
        out += r.success
          ? unwrapForDisplay((r.body as { result?: unknown })?.result)
          : (r.message ?? 'undefined');
      } else {
        out += part;
      }
    }
    return out;
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
    response.body.supportsLogPoints = true;
    // DAP leaves hitCondition ("5", "%5", ">=100") to the adapter; the C
    // layer parses it at set time and gates the stop on the hit count.
    response.body.supportsHitConditionalBreakpoints = true;
    // Only the "all" filter is implemented (stop on every throw, caught or
    // not); uncaught-only needs catch-detection on the unwind path and is
    // deliberately not advertised so clients won't request it.
    response.body.exceptionBreakpointFilters = [
      { filter: 'all', label: 'All exceptions', default: false },
    ];
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
    const srcPath = args.source?.path;
    if (srcPath) {
      // Track logpoints for this source — per-file replace, mirroring the C
      // side's scoped table. A logpoint is registered with C like a normal
      // breakpoint (the engine must stop there); interceptStop decides later.
      const byLine = new Map<number, string>();
      for (const bp of args.breakpoints ?? []) {
        if (bp.logMessage && typeof bp.line === 'number' && bp.line >= 1) {
          byLine.set(bp.line, bp.logMessage);
        }
      }
      this.logpoints.set(srcPath, byLine);
    }
    this.sendToChild('setBreakpoints', {
      source: args.source,
      breakpoints: args.breakpoints ?? [],
    }).then(
      (r) => {
        if (srcPath) this.applyVerified(r, args.breakpoints ?? [], srcPath);
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

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    // Thin relay: the C layer arms/disarms the engine's throw hook (filter
    // "all") and echoes one verified entry per requested filter.
    this.relay(response, 'setExceptionBreakpoints', {
      filters: args.filters ?? [],
    });
  }

  /**
   * Override `verified` from the file system's point of view: a missing
   * source or a line past EOF can never fire, so report verified:false and
   * let VS Code render the (gray) unverified breakpoint. The C layer answers
   * "registered"; only the adapter sees the file. If the response doesn't
   * line up with the request 1:1 (C skipped entries), C's answer is kept.
   */
  private applyVerified(
    r: DebugProtocol.Response,
    requested: readonly DebugProtocol.SourceBreakpoint[],
    srcPath: string,
  ): void {
    const resp = (r.body as { breakpoints?: { verified?: boolean; line?: number }[] })
      ?.breakpoints;
    if (!Array.isArray(resp) || resp.length !== requested.length) return;
    let lineCount: number | null = null;
    try {
      lineCount = readFileSync(srcPath, 'utf8').split(/\r?\n/).length;
    } catch {
      lineCount = null; // missing / unreadable / not a file
    }
    resp.forEach((b, i) => {
      const reqLine = requested[i]?.line;
      const line = typeof reqLine === 'number' ? reqLine : b.line;
      // C's `false` is authoritative — it means the runtime refused to
      // register (e.g. an unparseable hitCondition), and a line-in-file
      // check cannot re-enable that. The adapter only ever narrows.
      if (b.verified === false) return;
      b.verified = lineCount !== null && typeof line === 'number' && line >= 1 && line <= lineCount;
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
