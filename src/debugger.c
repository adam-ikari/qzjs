/*
 * qzjs — Debug core implementation (step debugger)
 *
 * PAL-agnostic. Bridges the QuickJS-ng debugger engine patch
 * (JS_SetDebuggerHandler / JS_GetCallFrames / JS_GetFrameVariable) to the
 * stable qz_debug_* API. Owns the breakpoint table, step-mode state, and
 * the blocking pause logic (the on_dispatch hook).
 *
 * Threading: single-threaded. on_dispatch runs inline on the JS thread inside
 * JS_Eval. To pause it BLOCKS (calling cbs.on_stopped, which pumps the host's
 * protocol until a flow command arrives) then returns 0 to resume. It must
 * NEVER return non-zero (that would abort via JS_ThrowInterrupted).
 *
 * Compiled in only when QZ_DEBUG_SUPPORT is defined (QZ_BUILD_DEBUGGER=ON).
 */
#include "qz_internal.h"

#ifdef QZ_DEBUG_SUPPORT

#include "qzjs/qz_debug.h"
#include <quickjs.h>
#include <stdlib.h>
#include <string.h>

/* ================================================================
 * Internal state
 * ================================================================ */

enum qz_step_mode {
    STEP_NONE = 0,
    STEP_INTO,
    STEP_OVER,
    STEP_OUT,
};

typedef struct qz_bp {
    char *filename;   /* strdup'd; matched against JS_Eval filename atom string */
    int   line;
    char *condition;  /* strdup'd DAP condition expr; NULL = unconditional. Evaluated
                       * in the frame's locals sandbox (qz_debug_evaluate style);
                       * stops only if it evaluates truthy. */
    int   hit;        /* incremented each time this bp fires (for future use) */
} qz_bp_t;

struct qz_debug {
    qz_t *rt;
    qz_debug_cbs cbs;
    JSDebuggerHooks hooks;          /* installed on the JSRuntime */
    /* breakpoint table */
    qz_bp_t *bps;
    int bp_count;
    int bp_cap;
    /* step / pause state */
    int step_mode;              /* enum qz_step_mode */
    int step_frame_depth;       /* frame depth at step-over/out start */
    JSAtom step_filename;       /* last filename stepped (0 = none) */
    int step_line;              /* last line stepped (-1 = none) */
    int pause_requested;        /* set by qz_debug_pause / stop_on_entry */
    int stopped;                /* 1 while inside on_stopped (re-entrancy guard) */
    int last_stop_line;         /* line of the last stop (to skip re-hitting the
                                 * same breakpoint on immediate continue).
                                 * 0 = guard inactive. */
    int last_stop_depth;        /* call-frame count at the last stop — tells
                                 * "resume dispatches of the same statement"
                                 * (same depth, same file/line) apart from
                                 * "the stop frame advanced or returned" and
                                 * from "we are inside a callee" (deeper). */
    char *last_stop_file;       /* filename of the last stop (strdup'd; owns) */
    /* exception breakpoints (DAP setExceptionBreakpoints) */
    int exc_break_mode;         /* 0 = off, 1 = stop on every throw (filter "all") */
    char *exc_message;          /* message of the current "exception" stop;
                                 * owned; valid until the next throw-stop or detach */
    /* paused-frame snapshot for frame_id ↔ engine frame mapping */
    JSDebugFrame *frames;
    int frame_count;
    int frame_generation;       /* bumped each stop; invalidates stale ids */
};

/* Forward decl — defined below; used by qz_debug_attach. */
static int qz_debug_on_dispatch(JSContext *ctx, struct JSStackFrame *sf,
                                  const uint8_t *pc, void *opaque);

/* ================================================================
 * Helpers
 * ================================================================ */

/* Filename comparison: b->filename is a strdup'd string; compared against the
 * filename string resolved from the engine atom via JS_GetCallFrames. */
/* Find the breakpoint matching (filename, line), or NULL. */
static qz_bp_t *bp_find(qz_debug_t *dbg, const char *filename, int line)
{
    int i;
    for (i = 0; i < dbg->bp_count; i++) {
        qz_bp_t *bp = &dbg->bps[i];
        if (bp->line == line && bp->filename && filename &&
            strcmp(bp->filename, filename) == 0)
            return bp;
    }
    return NULL;
}

/* Evaluate a breakpoint condition in the current (top) frame's locals.
 * Runs BEFORE we stop, so it builds its own frame snapshot via JS_GetCallFrames
 * (not ensure_frames, which requires dbg->stopped). Returns 1 if true
 * (NULL/unconditional → true), 0 if false, -1 on eval error (stop so user sees
 * the error). */
static int bp_condition_true(qz_debug_t *dbg, qz_bp_t *bp)
{
    if (!bp->condition || bp->condition[0] == '\0')
        return 1;  /* unconditional */
    JSContext *ctx = qz_get_active_jsctx(dbg->rt);
    if (!ctx) return -1;

    /* Build a `locals` object from the top frame. */
    int n = 0;
    JSDebugFrame *frames = JS_GetCallFrames(ctx, &n);
    JSValue sandbox = JS_NewObject(ctx);
    if (frames && n > 0) {
        JSDebugFrame *f = &frames[0];
        int i;
        for (i = 0; i < f->arg_count + f->var_count; i++) {
            JSDebugVar *dv = &f->vars[i];
            if (!dv->name) continue;
            JSValue v = JS_GetFrameVariable(ctx, 0, i);
            if (!JS_IsException(v))
                JS_SetPropertyStr(ctx, sandbox, dv->name, v);
            else
                JS_FreeValue(ctx, v);
        }
    }
    if (frames) JS_FreeCallFrames(ctx, frames, n);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue prev = JS_GetPropertyStr(ctx, global, "locals");
    JS_SetPropertyStr(ctx, global, "locals", sandbox);
    JS_FreeValue(ctx, global);

    JSValue v = JS_Eval(ctx, bp->condition, strlen(bp->condition),
                        "<bpcond>", JS_EVAL_TYPE_GLOBAL);

    /* Restore previous `locals` (or delete). */
    global = JS_GetGlobalObject(ctx);
    if (JS_IsUndefined(prev)) {
        JSAtom a = JS_NewAtom(ctx, "locals");
        JS_DeleteProperty(ctx, global, a, 0);
        JS_FreeAtom(ctx, a);
    } else {
        JS_SetPropertyStr(ctx, global, "locals", prev);
    }
    JS_FreeValue(ctx, global);

    int truthy;
    if (JS_IsException(v)) {
        truthy = -1;  /* error — stop so the user sees it */
    } else {
        int b = JS_ToBool(ctx, v);  /* -1 on exception, else 0/1 */
        truthy = (b > 0) ? 1 : 0;
    }
    JS_FreeValue(ctx, v);
    return truthy;
}

/* ================================================================
 * The on_dispatch hook — the heart of the debugger
 * ================================================================ */

static int qz_debug_on_dispatch(JSContext *ctx, struct JSStackFrame *sf,
                                  const uint8_t *pc, void *opaque)
{
    qz_debug_t *dbg = (qz_debug_t *)opaque;
    int col = 0;
    /* on_dispatch receives pc pointing AT the opcode (SWITCH runs
     * DEBUGGER_CHECK before *pc++), but JS_PcToLine's pc_value -= 1 expects
     * the engine's one-past convention (the one every sf->cur_pc save inside
     * a handler follows). Without the +1 the reported line is the previous
     * source line whenever the opcode starts a line — which is exactly the
     * `debugger;` case, where the stop would highlight line N-1. */
    int line = JS_PcToLine(ctx, sf, pc + 1, &col);
    if (line < 0)
        return 0;  /* native or no debug info — can't debug this frame */

    /* Re-entrancy guard: if we're already paused (inside on_stopped, e.g.
     * because the DAP layer is pumping the PAL event loop and PAL-driven JS
     * re-entered on_dispatch), don't nest another stop. The PAL-driven JS runs
     * "in the background" of a pause and must not trigger breakpoints/steps. */
    if (dbg->stopped)
        return 0;

    /* Resolve the filename string for breakpoint matching / step tracking.
     * JS_PcToLine gave us the line; the filename comes from the top frame. */
    const char *filename = NULL;
    char *fn_alloc = NULL;
    int depth = 0;
    {
        int n = 0;
        JSDebugFrame *one = JS_GetCallFrames(ctx, &n);
        if (one && n > 0 && one[0].filename) {
            fn_alloc = strdup(one[0].filename);
            filename = fn_alloc;
        }
        if (one)
            JS_FreeCallFrames(ctx, one, n);
        depth = n;
    }

    /* Re-hit guard: after a stop at (file, line, depth), suppress
     * breakpoint re-fires on the dispatches that merely RESUME the same
     * statement — but only for as long as that really is the same visit.
     * (The original guard compared the line only and never expired, so a
     * breakpoint or logpoint on a loop line fired on the first pass and was
     * then suppressed on every later visit until some other stop happened at
     * a different line.)
     *
     *   deeper than the stop  → inside a callee: keep the guard — returning
     *                           to the stop statement must not re-trigger it;
     *   shallower             → the stop frame returned: fresh world, clear;
     *   same depth, other
     *   file/line             → the stop frame advanced past the statement: clear.
     *
     * The pop case is always observed here first: the caller dispatches its
     * own next opcode (one level shallower) before any new frame can be
     * created at the stop depth, so a recycled frame address cannot be
     * mistaken for the stop frame. */
    if (dbg->last_stop_line >= 1) {
        if (depth < dbg->last_stop_depth) {
            dbg->last_stop_line = 0;
        } else if (depth > dbg->last_stop_depth) {
            /* in a callee — guard stays */
        } else if (line != dbg->last_stop_line ||
                   (dbg->last_stop_file && filename &&
                    strcmp(filename, dbg->last_stop_file) != 0)) {
            dbg->last_stop_line = 0;
        }
    }

    const char *reason = NULL;

    /* `debugger;` statement: pause unconditionally when the OP_debugger opcode
     * is hit. (No re-hit guard needed: after continue, SWITCH's *pc++ advances
     * past OP_debugger, so it won't re-fire.) */
    if (JS_IsDebuggerOpcode(pc)) {
        reason = "breakpoint";
    }

    if (!reason && dbg->pause_requested) {
        dbg->pause_requested = 0;
        reason = "pause";
    } else if (!reason && dbg->step_mode == STEP_INTO) {
        if (dbg->step_line < 0 || dbg->step_filename == 0 ||
            line != dbg->step_line) {
            /* simplistic: stop at any line change. filename tracking via atom
             * is coarse (we compare line only here; full filename compare needs
             * the atom which we don't have on the hot path). Good enough for MVP. */
            reason = "step";
        }
    } else if (dbg->step_mode == STEP_OVER || dbg->step_mode == STEP_OUT) {
        /* Without cheap frame-depth on the hot path, treat over/out like into
         * for the MVP — stop at next line change. Phase 3 polish can add the
         * depth check. This is correct for the common single-frame case. */
        if (dbg->step_line < 0 || line != dbg->step_line)
            reason = "step";
    }

    if (!reason) {
        qz_bp_t *bp = bp_find(dbg, filename, line);
        if (bp) {
            /* skip re-hitting the same breakpoint immediately after continue */
            if (dbg->last_stop_line != line) {
                int c = bp_condition_true(dbg, bp);
                if (c != 0)  /* true (1) or error (-1) → stop */
                    reason = "breakpoint";
            }
        }
    }

    if (reason) {
        /* Record step position so the next step stops at a NEW line. */
        dbg->step_line = line;
        dbg->step_mode = STEP_NONE;
        dbg->last_stop_line = line;
        dbg->last_stop_depth = depth;
        free(dbg->last_stop_file);
        dbg->last_stop_file = fn_alloc ? strdup(fn_alloc) : NULL;
        dbg->stopped = 1;

        /* Free any previous paused-frame snapshot. */
        if (dbg->frames) {
            JS_FreeCallFrames(ctx, dbg->frames, dbg->frame_count);
            dbg->frames = NULL;
            dbg->frame_count = 0;
        }
        dbg->frame_generation++;

        if (dbg->cbs.on_stopped)
            dbg->cbs.on_stopped(dbg, reason, 1);

        dbg->stopped = 0;
        if (fn_alloc) free(fn_alloc);
        return 0;  /* resume */
    }

    if (fn_alloc) free(fn_alloc);
    return 0;
}

/* ================================================================
 * The on_throw hook — exception breakpoints
 * ================================================================ */

/* Called from JS_Throw (the engine's single throw funnel: OP_throw, all
 * JS_ThrowError* variants, host functions, async rejections) BEFORE the
 * exception enters the pending slot, with stack frames still intact.
 * The engine already suppresses restorations of already-thrown exceptions
 * (js_throw_restored) and build_backtrace re-stores, so one logical throw
 * notifies exactly once. Armed only while exc_break_mode is set (DAP filter
 * "all"); otherwise this is one NULL-checked branch per throw. */
static void qz_debug_on_throw(JSContext *ctx, JSValueConst exception,
                              void *opaque)
{
    qz_debug_t *dbg = (qz_debug_t *)opaque;
    if (!dbg->exc_break_mode || dbg->stopped)
        return;

    /* Claim the pause BEFORE running any JS: message conversion may call a
     * user toString() that itself throws — the re-entrant hook then sees
     * stopped==1 and returns instead of nesting. */
    dbg->stopped = 1;

    /* The stop consumes any armed step and pending pause (the next flow
     * command re-arms) and records this line, mirroring the on_dispatch stop
     * block. Frames are read eagerly for the line only — the paused snapshot
     * itself is fetched lazily during the pump, when the stack is still the
     * throw site. */
    dbg->step_mode = STEP_NONE;
    dbg->pause_requested = 0;
    {
        int n = 0;
        JSDebugFrame *fr = JS_GetCallFrames(ctx, &n);
        if (fr && n > 0)
            dbg->step_line = fr[0].line;
        JS_FreeCallFrames(ctx, fr, n);
    }

    free(dbg->exc_message);
    dbg->exc_message = NULL;
    {
        JSValue msgv = JS_ToString(ctx, exception);
        if (!JS_IsException(msgv)) {
            const char *s = JS_ToCString(ctx, msgv);
            if (s) {
                dbg->exc_message = strdup(s);
                JS_FreeCString(ctx, s);
            }
            JS_FreeValue(ctx, msgv);
        }
        /* Anything raised while stringifying (throwing toString, Symbol, OOM)
         * sits in the pending slot; drop it — JS_Throw stores the original
         * right after we return, and the pump must not see the stray. */
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    if (!dbg->exc_message)
        dbg->exc_message = strdup("<exception>");

    /* Invalidate any previous paused-frame snapshot; ensure_frames refetches
     * during the pump with the throw-site stack. */
    if (dbg->frames) {
        JS_FreeCallFrames(ctx, dbg->frames, dbg->frame_count);
        dbg->frames = NULL;
        dbg->frame_count = 0;
    }
    dbg->frame_generation++;

    if (dbg->cbs.on_stopped)
        dbg->cbs.on_stopped(dbg, "exception", 1);

    dbg->stopped = 0;
}

/* ================================================================
 * Public API
 * ================================================================ */

qz_debug_t *qz_debug_attach(qz_t *rt, const qz_debug_cbs *cbs)
{
    if (!rt || !cbs) return NULL;
    JSRuntime *jsrt = rt->jsrt;
    if (!jsrt) return NULL;

    struct qz_debug *dbg = calloc(1, sizeof(*dbg));
    if (!dbg) return NULL;
    dbg->rt = rt;
    dbg->cbs = *cbs;
    dbg->step_line = -1;

    dbg->hooks.on_dispatch = qz_debug_on_dispatch;
    dbg->hooks.on_throw = qz_debug_on_throw;
    dbg->hooks.opaque = dbg;
    JS_SetDebuggerHandler(jsrt, &dbg->hooks);

    rt->dbg_session = dbg;
    return dbg;
}

qz_t *qz_debug_get_runtime(qz_debug_t *dbg)
{
    return dbg ? dbg->rt : NULL;
}

void qz_debug_detach(qz_t *rt, qz_debug_t *dbg)
{
    if (!rt || !dbg) return;
    JSRuntime *jsrt = rt->jsrt;
    if (jsrt)
        JS_SetDebuggerHandler(jsrt, NULL);
    if (rt->dbg_session == dbg)
        rt->dbg_session = NULL;
    /* Free any cached paused-frame snapshot. Requires a live ctx — detach must
     * therefore run before context teardown (qz_thread_teardown ordering). */
    if (dbg->frames) {
        JSContext *ctx = qz_get_active_jsctx(rt);
        if (ctx)
            JS_FreeCallFrames(ctx, dbg->frames, dbg->frame_count);
        dbg->frames = NULL;
        dbg->frame_count = 0;
    }
    if (dbg->bps) {
        int i;
        for (i = 0; i < dbg->bp_count; i++) {
            free(dbg->bps[i].filename);
            free(dbg->bps[i].condition);
        }
        free(dbg->bps);
    }
    free(dbg->last_stop_file);
    free(dbg->exc_message);
    free(dbg);
}

int qz_debug_add_breakpoint(qz_debug_t *dbg, const char *filename,
                              int line, const char *condition)
{
    if (!dbg || !filename || line < 1) return -1;
    if (dbg->bp_count >= dbg->bp_cap) {
        int nc = dbg->bp_cap ? dbg->bp_cap * 2 : 8;
        qz_bp_t *nb = realloc(dbg->bps, sizeof(qz_bp_t) * nc);
        if (!nb) return -1;
        dbg->bps = nb;
        dbg->bp_cap = nc;
    }
    dbg->bps[dbg->bp_count].filename = strdup(filename);
    dbg->bps[dbg->bp_count].line = line;
    dbg->bps[dbg->bp_count].condition = (condition && condition[0]) ? strdup(condition) : NULL;
    dbg->bps[dbg->bp_count].hit = 0;
    dbg->bp_count++;
    return 0;
}

int qz_debug_remove_breakpoint(qz_debug_t *dbg, const char *filename, int line)
{
    if (!dbg || !filename) return -1;
    int i;
    for (i = 0; i < dbg->bp_count; i++) {
        if (dbg->bps[i].line == line &&
            dbg->bps[i].filename && strcmp(dbg->bps[i].filename, filename) == 0) {
            free(dbg->bps[i].filename);
            free(dbg->bps[i].condition);
            /* shift down */
            int j;
            for (j = i; j < dbg->bp_count - 1; j++)
                dbg->bps[j] = dbg->bps[j + 1];
            dbg->bp_count--;
            return 0;
        }
    }
    return -1;  /* not found */
}

void qz_debug_clear_breakpoints(qz_debug_t *dbg)
{
    if (!dbg) return;
    int i;
    for (i = 0; i < dbg->bp_count; i++) {
        free(dbg->bps[i].filename);
        free(dbg->bps[i].condition);
    }
    dbg->bp_count = 0;
}

void qz_debug_clear_breakpoints_in_file(qz_debug_t *dbg, const char *filename)
{
    if (!dbg || !filename) return;
    int i, j = 0;
    for (i = 0; i < dbg->bp_count; i++) {
        qz_bp_t *bp = &dbg->bps[i];
        if (bp->filename && strcmp(bp->filename, filename) == 0) {
            free(bp->filename);
            free(bp->condition);
        } else {
            dbg->bps[j++] = *bp;   /* keep other files' breakpoints */
        }
    }
    dbg->bp_count = j;
}

void qz_debug_continue(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->step_mode = STEP_NONE;
    dbg->step_line = -1;
}

void qz_debug_pause(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->pause_requested = 1;
}

void qz_debug_step_over(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->step_mode = STEP_OVER;
}
void qz_debug_step_into(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->step_mode = STEP_INTO;
}
void qz_debug_step_out(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->step_mode = STEP_OUT;
}
void qz_debug_stop_on_entry(qz_debug_t *dbg)
{
    if (!dbg) return;
    dbg->pause_requested = 1;
}

/* Exception breakpoints (DAP setExceptionBreakpoints). mode: 0 = off,
 * 1 = stop on every throw — the DAP "all" filter, caught and uncaught alike.
 * Uncaught-only detection is not implemented (would need catch-detection on
 * the unwind path); only "all" is advertised. */
void qz_debug_set_exception_break(qz_debug_t *dbg, int mode)
{
    if (!dbg) return;
    dbg->exc_break_mode = mode ? 1 : 0;
}

/* Message of the exception that caused the current (or most recent)
 * "exception" stop. Owned by dbg — valid until the next throw-stop or
 * detach. NULL when there is none. */
const char *qz_debug_last_exception(qz_debug_t *dbg)
{
    return dbg ? dbg->exc_message : NULL;
}

/* ================================================================
 * Introspection (only valid while paused)
 * ================================================================ */

/* Lazily fetch the paused-frame snapshot via the engine. */
static int ensure_frames(qz_debug_t *dbg)
{
    if (dbg->frames) return 0;
    if (!dbg->stopped) return -1;  /* not paused */
    JSContext *ctx = qz_get_active_jsctx(dbg->rt);
    if (!ctx) return -1;
    dbg->frames = JS_GetCallFrames(ctx, &dbg->frame_count);
    if (!dbg->frames) return -1;
    return 0;
}

int qz_debug_get_call_frames(qz_debug_t *dbg,
                               qz_debug_frame **out_frames, int *out_count)
{
    if (!dbg || !out_frames || !out_count) return -1;
    *out_frames = NULL;
    *out_count = 0;
    if (ensure_frames(dbg) < 0) return -1;

    qz_debug_frame *df = calloc(dbg->frame_count, sizeof(qz_debug_frame));
    if (!df) return -1;
    int i;
    for (i = 0; i < dbg->frame_count; i++) {
        JSDebugFrame *f = &dbg->frames[i];
        df[i].name = f->func_name ? strdup(f->func_name) : strdup("<anonymous>");
        df[i].source_path = f->filename ? strdup(f->filename) : NULL;
        df[i].line = f->line;
        df[i].column = f->col;
        /* frame id encodes index + generation so stale ids are detectable.
         * generation in high bits, index in low. */
        df[i].id = (dbg->frame_generation << 16) | (i & 0xffff);
    }
    *out_frames = df;
    *out_count = dbg->frame_count;
    return 0;
}

void qz_debug_free_frames(qz_debug_frame *frames, int count)
{
    if (!frames) return;
    int i;
    for (i = 0; i < count; i++) {
        free(frames[i].name);
        free(frames[i].source_path);
    }
    free(frames);
}

/* Decode a frame_id back to an engine frame index; -1 if stale/invalid. */
static int frame_id_to_index(qz_debug_t *dbg, int frame_id)
{
    int gen = (frame_id >> 16) & 0xffff;
    int idx = frame_id & 0xffff;
    if (gen != (dbg->frame_generation & 0xffff)) return -1;
    if (idx < 0 || idx >= dbg->frame_count) return -1;
    return idx;
}

int qz_debug_get_scopes(qz_debug_t *dbg, int frame_id,
                          qz_debug_scope **out_scopes, int *out_count)
{
    if (!dbg || !out_scopes || !out_count) return -1;
    *out_scopes = NULL;
    *out_count = 0;
    if (ensure_frames(dbg) < 0) return -1;
    int idx = frame_id_to_index(dbg, frame_id);
    if (idx < 0) return -1;

    /* MVP: one "Locals" scope per frame. variablesReference = frame_id
     * (re-used; the get_variables path decodes it the same way). */
    qz_debug_scope *s = calloc(1, sizeof(qz_debug_scope));
    if (!s) return -1;
    s->name = strdup("Locals");
    s->variables_reference = frame_id;
    s->expensive = 0;
    *out_scopes = s;
    *out_count = 1;
    return 0;
}

void qz_debug_free_scopes(qz_debug_scope *scopes, int count)
{
    if (!scopes) return;
    int i;
    for (i = 0; i < count; i++)
        free(scopes[i].name);
    free(scopes);
}

int qz_debug_get_variables(qz_debug_t *dbg, int variables_reference,
                             qz_debug_var **out_vars, int *out_count)
{
    if (!dbg || !out_vars || !out_count) return -1;
    *out_vars = NULL;
    *out_count = 0;
    if (ensure_frames(dbg) < 0) return -1;
    int idx = frame_id_to_index(dbg, variables_reference);
    if (idx < 0) return -1;

    JSContext *ctx = qz_get_active_jsctx(dbg->rt);
    if (!ctx) return -1;
    JSDebugFrame *f = &dbg->frames[idx];
    int n = f->arg_count + f->var_count;
    if (n <= 0) return 0;

    qz_debug_var *vars = calloc(n, sizeof(qz_debug_var));
    if (!vars) return -1;
    int i;
    for (i = 0; i < n; i++) {
        JSDebugVar *dv = &f->vars[i];
        vars[i].name = dv->name ? strdup(dv->name) : strdup("<unnamed>");
        JSValue v = JS_GetFrameVariable(ctx, idx, i);
        if (!JS_IsException(v)) {
            JSValue str = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
            if (!JS_IsException(str) && !JS_IsUndefined(str)) {
                const char *s = JS_ToCString(ctx, str);
                if (s) vars[i].value_json = strdup(s);
                JS_FreeCString(ctx, s);
            }
            JS_FreeValue(ctx, str);
            vars[i].type = strdup("object");  /* MVP: coarse type */
        }
        JS_FreeValue(ctx, v);
    }
    *out_vars = vars;
    *out_count = n;
    return 0;
}

void qz_debug_free_vars(qz_debug_var *vars, int count)
{
    if (!vars) return;
    int i;
    for (i = 0; i < count; i++) {
        free(vars[i].name);
        free(vars[i].value_json);
        free(vars[i].type);
    }
    free(vars);
}

int qz_debug_evaluate(qz_debug_t *dbg, int frame_id,
                        const char *expression,
                        char **out_value_json, char **out_error)
{
    if (!dbg || !expression) return -1;
    if (out_value_json) *out_value_json = NULL;
    if (out_error) *out_error = NULL;
    /* Evaluate in global scope. Watch expressions referencing frame LOCALS
     * fail with ReferenceError — true eval-in-frame needs engine support
     * QuickJS doesn't expose (a future engine-patch enhancement). Locals are
     * still visible in the Locals scope; evaluate works for globals and pure
     * expressions. As a convenience, the frame's locals are also exposed on a
     * `locals` object, so `locals.x` works in watch. */
    JSContext *ctx = qz_get_active_jsctx(dbg->rt);
    if (!ctx) return -1;

    if (ensure_frames(dbg) < 0) return -1;
    int idx = frame_id_to_index(dbg, frame_id);

    /* Build a `locals` object and install it as a global for the eval, then
     * restore. This lets watch expressions reference `locals.x`. */
    JSValue prev_locals = JS_UNDEFINED;
    int installed = 0;
    if (idx >= 0) {
        JSDebugFrame *f = &dbg->frames[idx];
        int n = f->arg_count + f->var_count;
        JSValue sandbox = JS_NewObject(ctx);
        int i;
        for (i = 0; i < n; i++) {
            JSDebugVar *dv = &f->vars[i];
            if (!dv->name) continue;
            JSValue v = JS_GetFrameVariable(ctx, idx, i);
            if (!JS_IsException(v)) {
                JS_SetPropertyStr(ctx, sandbox, dv->name, v);  /* takes ref */
            } else {
                JS_FreeValue(ctx, v);
            }
        }
        JSValue global = JS_GetGlobalObject(ctx);
        prev_locals = JS_GetPropertyStr(ctx, global, "locals");
        JS_SetPropertyStr(ctx, global, "locals", sandbox);
        JS_FreeValue(ctx, global);
        installed = 1;
    }

    JSValue v = JS_Eval(ctx, expression, strlen(expression), "<watch>",
                        JS_EVAL_TYPE_GLOBAL);

    /* Restore the previous `locals` global (or delete if none). */
    if (installed) {
        JSValue global = JS_GetGlobalObject(ctx);
        if (JS_IsUndefined(prev_locals)) {
            JSAtom a = JS_NewAtom(ctx, "locals");
            JS_DeleteProperty(ctx, global, a, 0);
            JS_FreeAtom(ctx, a);
        } else {
            JS_SetPropertyStr(ctx, global, "locals", prev_locals);
        }
        JS_FreeValue(ctx, global);
    }

    if (JS_IsException(v)) {
        JSValue exc = JS_GetException(ctx);
        JSValue msg = JS_ToString(ctx, exc);
        const char *s = JS_ToCString(ctx, msg);
        if (out_error && s) *out_error = strdup(s);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, msg);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, v);
        return -1;
    }
    JSValue str = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    if (!JS_IsException(str) && !JS_IsUndefined(str)) {
        const char *s = JS_ToCString(ctx, str);
        if (out_value_json && s) *out_value_json = strdup(s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, str);
    JS_FreeValue(ctx, v);
    return 0;
}

#endif /* QZ_DEBUG_SUPPORT */
