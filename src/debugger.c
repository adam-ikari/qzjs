/*
 * qzjs — Debug core implementation (step debugger)
 *
 * PAL-agnostic. Bridges the QuickJS-ng debugger engine patch
 * (JS_SetDebuggerHandler / JS_GetCallFrames / JS_GetFrameVariable) to the
 * stable qz_debug_* API. Owns the breakpoint table, step-mode state, and
 * the blocking pause logic (the on_dispatch hook).
 *
 * Threading: single-threaded. on_dispatch runs inline on the JS thread inside
 * JS_Eval. To pause it BLOCKS (calling cbs.on_stopped, which drives the host's
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

/* DAP hitCondition operators, parsed once at set time (hit_condition_parse).
 * hit_op < 0 means no hitCondition — the breakpoint is always a candidate. */
enum {
    HIT_EQ,   /* "N" | "==N" — stop on exactly the Nth hit (VS Code: "only break
               * on the fifth hit") */
    HIT_MOD,  /* "%N" — stop every Nth hit */
    HIT_GT, HIT_GE, HIT_LT, HIT_LE, HIT_NE,
};

typedef struct qz_bp {
    char *filename;   /* strdup'd; matched against JS_Eval filename atom string */
    int   line;
    char *condition;  /* strdup'd DAP condition expr; NULL = unconditional. Evaluated
                       * in the frame's locals sandbox (qz_debug_evaluate style);
                       * stops only if it evaluates truthy. */
    int   hit;        /* times execution reached this line as a stop candidate
                       * (the same-statement re-hit guard already filtered) */
    int   hit_op;     /* enum above; -1 = no hitCondition */
    int   hit_n;      /* hitCondition operand */
    /* Visit tracking for hit counting: one "visit" = one arrival at the
     * line. A statement compiles to several opcodes that all map to its
     * line, and without a stop in between the re-hit guard never arms — so
     * hits are edge-triggered: count when the visit starts, stay silent
     * while still inside it. Transitions mirror the stop guard below. */
    char *reach_file; /* strdup'd while inside the current visit; NULL = idle */
    int   reach_line;
    int   reach_depth;
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
    /* expandable-value slots for the DAP variablesReference hierarchy: each
     * non-leaf value (object/array local, hover/evaluate result) is DupValue'd
     * here and exposed as a reference id. Freed whenever frame_generation is
     * bumped (refs are only valid within their stop), like the snapshot. */
    JSValue *var_slots;         /* [0..var_slot_count) or NULL; JS_UNDEFINED = free */
    int var_slot_count;
};

/* Forward decl — defined below; used by qz_debug_attach. */
static int qz_debug_on_dispatch(JSContext *ctx, struct JSStackFrame *sf,
                                  const uint8_t *pc, void *opaque);
/* Defined below (variable-slot helpers); called from the stop paths. */
static void var_slots_free(struct qz_debug *dbg, JSContext *ctx);

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

/* Parse a DAP hitCondition into op/operand. DAP leaves the expression to the
 * adapter; VS Code's de-facto forms (its "Hit count" menu) are:
 *   "N" | "==N"     stop on exactly the Nth hit
 *   "%N"            stop every Nth hit
 *   ">N" ">=N" "<N" "<=N" "!=N"   relational against the hit count
 * Surrounding whitespace is ignored; anything else (unknown operator, missing
 * or non-decimal operand, trailing junk, negative N, "%0") is rejected so the
 * caller can answer verified:false with a message instead of silently
 * dropping the breakpoint. Returns 0 on success, -1 on parse error. */
static int hit_condition_parse(const char *s, int *out_op, int *out_n)
{
    const char *p = s;
    char *end;
    int op = HIT_EQ, n;

    while (*p == ' ' || *p == '\t') p++;
    if (*p == '%') { op = HIT_MOD; p++; }
    else if (p[0] == '>' && p[1] == '=') { op = HIT_GE; p += 2; }
    else if (p[0] == '<' && p[1] == '=') { op = HIT_LE; p += 2; }
    else if (p[0] == '=' && p[1] == '=') { op = HIT_EQ; p += 2; }
    else if (p[0] == '!' && p[1] == '=') { op = HIT_NE; p += 2; }
    else if (*p == '>') { op = HIT_GT; p++; }
    else if (*p == '<') { op = HIT_LT; p++; }
    /* bare number → HIT_EQ */
    while (*p == ' ' || *p == '\t') p++;
    n = (int)strtol(p, &end, 10);
    if (end == p) return -1;                 /* no digits */
    while (*end == ' ' || *end == '\t') end++;
    if (*end != '\0') return -1;             /* trailing junk */
    if (n < 0) return -1;
    if (op == HIT_MOD && n == 0) return -1;  /* %0 would divide by zero */
    *out_op = op;
    *out_n = n;
    return 0;
}

/* Should this reach of the breakpoint be considered for stopping, per its
 * hitCondition? Called after bp->hit has been incremented for the reach;
 * no hitCondition → always. */
static int bp_hit_true(const qz_bp_t *bp)
{
    int h = bp->hit;
    if (bp->hit_op < 0) return 1;
    switch (bp->hit_op) {
    case HIT_EQ:  return h == bp->hit_n;
    case HIT_MOD: return bp->hit_n > 0 && (h % bp->hit_n) == 0;
    case HIT_GT:  return h > bp->hit_n;
    case HIT_GE:  return h >= bp->hit_n;
    case HIT_LT:  return h < bp->hit_n;
    case HIT_LE:  return h <= bp->hit_n;
    case HIT_NE:  return h != bp->hit_n;
    }
    return 1;
}

/* Advance every breakpoint's visit state for this dispatch, using the same
 * transition rules as the stop guard: leaving the statement (same depth,
 * other line/file) or returning out of its frame ends the visit; entering a
 * callee does NOT — the call is part of the statement being visited, and
 * returning to it must not re-count. Called unconditionally so a stop for a
 * step/pause/other breakpoint elsewhere cannot strand stale visit state. */
static void bps_visit_advance(qz_debug_t *dbg, int line, int depth,
                              const char *filename)
{
    int i;
    for (i = 0; i < dbg->bp_count; i++) {
        qz_bp_t *bp = &dbg->bps[i];
        if (!bp->reach_file) continue;  /* idle */
        if (depth < bp->reach_depth ||
            (depth == bp->reach_depth &&
             (line != bp->reach_line ||
              (filename && strcmp(filename, bp->reach_file) != 0)))) {
            free(bp->reach_file);
            bp->reach_file = NULL;
        }
    }
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
     * because the DAP layer is driving the PAL event loop and PAL-driven JS
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

    /* Breakpoint visit tracking — edge-trigger the hit counts (see
     * bps_visit_advance) before any stop decision reads them. */
    bps_visit_advance(dbg, line, depth, filename);

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
                if (!bp->reach_file) {  /* fresh arrival — one count per visit
                                         * (adjacent opcodes mapping to the
                                         * same line are ONE visit) */
                    bp->reach_line = line;
                    bp->reach_depth = depth;
                    bp->reach_file = strdup(filename ? filename : "");
                    bp->hit++;
                    if (bp_hit_true(bp)) { /* hitCondition gate (unset → always) */
                        int c = bp_condition_true(dbg, bp);
                        if (c != 0)  /* true (1) or error (-1) → stop */
                            reason = "breakpoint";
                    }
                }
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
        var_slots_free(dbg, ctx);   /* refs die with the snapshot */
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
     * itself is fetched lazily during the loop, when the stack is still the
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
         * right after we return, and the loop must not see the stray. */
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    if (!dbg->exc_message)
        dbg->exc_message = strdup("<exception>");

    /* Invalidate any previous paused-frame snapshot; ensure_frames refetches
     * during the loop with the throw-site stack. */
    if (dbg->frames) {
        JS_FreeCallFrames(ctx, dbg->frames, dbg->frame_count);
        dbg->frames = NULL;
        dbg->frame_count = 0;
    }
    var_slots_free(dbg, ctx);   /* refs die with the snapshot */
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
    if (dbg->frames || dbg->var_slots) {
        JSContext *ctx = qz_get_active_jsctx(rt);
        if (ctx) {
            JS_FreeCallFrames(ctx, dbg->frames, dbg->frame_count);
            var_slots_free(dbg, ctx);
        }
        dbg->frames = NULL;
        dbg->frame_count = 0;
    }
    if (dbg->bps) {
        int i;
        for (i = 0; i < dbg->bp_count; i++) {
            free(dbg->bps[i].filename);
            free(dbg->bps[i].condition);
            free(dbg->bps[i].reach_file);
        }
        free(dbg->bps);
    }
    free(dbg->last_stop_file);
    free(dbg->exc_message);
    free(dbg);
}

int qz_debug_add_breakpoint(qz_debug_t *dbg, const char *filename,
                              int line, const char *condition,
                              const char *hit_condition)
{
    int hit_op = -1, hit_n = 0;

    if (!dbg || !filename || line < 1) return -1;
    if (hit_condition && hit_condition[0]) {
        if (hit_condition_parse(hit_condition, &hit_op, &hit_n) < 0)
            return -2;  /* invalid hitCondition — nothing registered; the
                         * caller reports verified:false + message */
    }
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
    dbg->bps[dbg->bp_count].hit = 0;   /* fresh registration → count restarts */
    dbg->bps[dbg->bp_count].hit_op = hit_op;
    dbg->bps[dbg->bp_count].hit_n = hit_n;
    dbg->bps[dbg->bp_count].reach_file = NULL;
    dbg->bps[dbg->bp_count].reach_line = 0;
    dbg->bps[dbg->bp_count].reach_depth = 0;
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
            free(dbg->bps[i].reach_file);
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
        free(dbg->bps[i].reach_file);
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
            free(bp->reach_file);
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

/* ================================================================
 * Expandable-value slots (DAP variablesReference hierarchy)
 * ================================================================
 *
 * Each non-leaf value (object/array local, hover/evaluate result) is
 * DupValue'd into a slot and exposed as an expandable variablesReference.
 * Slot ids share the frame-id 32-bit space:
 *
 *   id = (frame_generation << 16) | (QZ_VAR_SLOT_BASE + slot)
 *
 * QZ_VAR_SLOT_BASE keeps the low half >= 0x1000, where a frame index
 * (call stacks never come close to 4096) can never land: frame_id_to_index
 * therefore rejects slot ids, and var_slot_get rejects frame ids. The
 * generation half kills ids from earlier stops exactly like stale frame
 * ids — a reference is only valid during the stop that produced it, and
 * the slots are freed whenever frame_generation is bumped. */

#define QZ_VAR_SLOT_BASE 0x1000
#define QZ_VAR_SLOT_MAX  0x1000   /* low half stays < 0x2000 */
#define QZ_VAR_CHILD_MAX 100      /* children listed per level (paging not yet used) */

static void var_slots_free(qz_debug_t *dbg, JSContext *ctx)
{
    int i;
    if (!dbg->var_slots) return;
    for (i = 0; i < dbg->var_slot_count; i++)
        JS_FreeValue(ctx, dbg->var_slots[i]);
    free(dbg->var_slots);
    dbg->var_slots = NULL;
    dbg->var_slot_count = 0;
}

/* Store v in a slot and return its reference id; 0 when v is not expandable
 * (leaves never need children) or the table is full. */
static int var_slot_add(qz_debug_t *dbg, JSContext *ctx, JSValueConst v)
{
    int i;
    if (!JS_IsObject(v) || JS_IsFunction(ctx, v))
        return 0;
    for (i = 0; i < dbg->var_slot_count; i++) {
        if (JS_IsUndefined(dbg->var_slots[i])) {
            dbg->var_slots[i] = JS_DupValue(ctx, v);
            return (dbg->frame_generation << 16) | (QZ_VAR_SLOT_BASE + i);
        }
    }
    if (dbg->var_slot_count >= QZ_VAR_SLOT_MAX)
        return 0;
    {
        JSValue *ns = realloc(dbg->var_slots,
                              (size_t)(dbg->var_slot_count + 1) * sizeof(JSValue));
        if (!ns) return 0;
        dbg->var_slots = ns;
        ns[dbg->var_slot_count] = JS_DupValue(ctx, v);
        return (dbg->frame_generation << 16) |
               (QZ_VAR_SLOT_BASE + dbg->var_slot_count++);
    }
}

/* Decode a slot id back to its value; JS_UNDEFINED if stale/invalid. */
static JSValue var_slot_get(qz_debug_t *dbg, int ref)
{
    int gen = (ref >> 16) & 0xffff;
    int low = ref & 0xffff;
    int slot;
    if (gen != (dbg->frame_generation & 0xffff)) return JS_UNDEFINED;
    if (low < QZ_VAR_SLOT_BASE || low >= QZ_VAR_SLOT_BASE + QZ_VAR_SLOT_MAX)
        return JS_UNDEFINED;
    slot = low - QZ_VAR_SLOT_BASE;
    if (slot >= dbg->var_slot_count) return JS_UNDEFINED;
    return dbg->var_slots[slot];
}

/* Coarse DAP type for a value (mirrors JS typeof, array/function distinct). */
static const char *debug_var_type(JSContext *ctx, JSValueConst v)
{
    if (JS_IsArray(v)) return "array";
    if (JS_IsFunction(ctx, v)) return "function";
    if (JS_IsString(v)) return "string";
    if (JS_IsNumber(v)) return "number";
    if (JS_IsBool(v)) return "boolean";
    if (JS_IsNull(v)) return "null";
    if (JS_IsUndefined(v) || JS_IsUninitialized(v)) return "undefined";
    if (JS_IsSymbol(v)) return "symbol";
    if (JS_IsBigInt(v)) return "bigint";
    return "object";
}

/* Bound to max bytes without splitting a UTF-8 sequence; append "…". */
static char *bounded_dup(const char *s, size_t max)
{
    size_t len = strlen(s);
    size_t cut;
    char *out;
    if (len <= max) return strdup(s);
    cut = max;
    while (cut > 0 && ((unsigned char)s[cut] & 0xc0) == 0x80) cut--;
    out = malloc(cut + 4);  /* "…" is 3 bytes + NUL */
    if (!out) return NULL;
    memcpy(out, s, cut);
    memcpy(out + cut, "\xe2\x80\xa6", 3);
    out[cut + 3] = '\0';
    return out;
}

/* Value shown in the DAP `value` field: bounded JSON-ish text. The old code
 * emitted unbounded JSON.stringify and nothing (NULL → "undefined") on
 * cycles; here every failure path falls back to a guarded ToString and, at
 * worst, the caller's literal. Strings are JSON-encoded (quoted + escaped)
 * to match the previous stringify behavior. */
static char *debug_var_preview(JSContext *ctx, JSValueConst v)
{
    JSValue str;
    const char *s;
    char *out = NULL;

    if (JS_IsObject(v)) {
        str = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsException(str) || JS_IsUndefined(str)) {
            /* cycle / throwing toJSON / function → guarded ToString */
            if (JS_IsException(str))
                JS_FreeValue(ctx, JS_GetException(ctx));
            else
                JS_FreeValue(ctx, str);
            str = JS_ToString(ctx, v);
        }
    } else if (JS_IsString(v)) {
        str = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    } else {
        str = JS_ToString(ctx, v);  /* Symbol throws → handled below */
    }
    if (JS_IsException(str)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return NULL;
    }
    s = JS_ToCString(ctx, str);
    if (s) {
        out = bounded_dup(s, 200);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, str);
    return out;
}

/* Enumerate one level of an object's own enumerable string-keyed properties
 * into a fresh array. Getters / Proxy traps may run JS (the world is frozen
 * but JS still executes) and may throw — that surfaces as rc<0 and an empty
 * DAP array rather than a half-built one. Prototype-chain properties are
 * deliberately excluded (own only), and the listing is capped so one click
 * can't ask the loop for a megabyte of JSON. */
static int collect_children(qz_debug_t *dbg, JSContext *ctx, JSValueConst obj,
                            qz_debug_var **out_vars, int *out_count)
{
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0, i, show;
    qz_debug_var *vars;
    int extra;

    *out_vars = NULL;
    *out_count = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return -1;
    }
    show = len > QZ_VAR_CHILD_MAX ? QZ_VAR_CHILD_MAX : len;
    extra = len > show;
    vars = calloc((size_t)show + extra, sizeof(qz_debug_var));
    if (!vars) {
        JS_FreePropertyEnum(ctx, tab, len);
        return -1;
    }
    for (i = 0; i < show; i++) {
        const char *nm = JS_AtomToCString(ctx, tab[i].atom);
        JSValue pv;
        if (!nm) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            continue;   /* name stays NULL → DAP prints "" */
        }
        vars[i].name = strdup(nm);
        JS_FreeCString(ctx, nm);
        pv = JS_GetProperty(ctx, obj, tab[i].atom);
        if (JS_IsException(pv)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            vars[i].value_json = strdup("<error>");
            vars[i].type = strdup("error");
            continue;
        }
        vars[i].value_json = debug_var_preview(ctx, pv);
        vars[i].type = strdup(debug_var_type(ctx, pv));
        vars[i].variables_reference = var_slot_add(dbg, ctx, pv);
        JS_FreeValue(ctx, pv);
    }
    if (extra) {
        char buf[64];
        snprintf(buf, sizeof(buf), "%u more", len - show);
        vars[show].name = strdup("<...>");
        vars[show].value_json = strdup(buf);
        vars[show].type = strdup("object");
    }
    JS_FreePropertyEnum(ctx, tab, len);
    *out_vars = vars;
    *out_count = (int)(show + extra);
    return 0;
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
    JSContext *ctx;
    int idx;

    if (!dbg || !out_vars || !out_count) return -1;
    *out_vars = NULL;
    *out_count = 0;
    if (ensure_frames(dbg) < 0) return -1;

    ctx = qz_get_active_jsctx(dbg->rt);
    if (!ctx) return -1;

    /* Frame scope: the Locals of one frame (variables_reference == frame_id). */
    idx = frame_id_to_index(dbg, variables_reference);
    if (idx >= 0) {
        JSDebugFrame *f = &dbg->frames[idx];
        int n = f->arg_count + f->var_count;
        qz_debug_var *vars;
        int i;
        if (n <= 0) return 0;
        vars = calloc(n, sizeof(qz_debug_var));
        if (!vars) return -1;
        for (i = 0; i < n; i++) {
            JSDebugVar *dv = &f->vars[i];
            JSValue v;
            vars[i].name = dv->name ? strdup(dv->name) : strdup("<unnamed>");
            v = JS_GetFrameVariable(ctx, idx, i);
            if (!JS_IsException(v)) {
                vars[i].value_json = debug_var_preview(ctx, v);
                vars[i].type = strdup(debug_var_type(ctx, v));
                vars[i].variables_reference = var_slot_add(dbg, ctx, v);
            }
            JS_FreeValue(ctx, v);
        }
        *out_vars = vars;
        *out_count = n;
        return 0;
    }

    /* Not a frame scope — try an expandable-value slot. Its generation half
     * only matches during the stop that created it; stale ids from earlier
     * stops miss here exactly like stale frame ids. */
    {
        JSValue obj = var_slot_get(dbg, variables_reference);
        if (!JS_IsUndefined(obj))
            return collect_children(dbg, ctx, obj, out_vars, out_count);
    }
    return -1;
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
                        char **out_value_json, char **out_error,
                        int *out_variables_reference)
{
    if (!dbg || !expression) return -1;
    if (out_value_json) *out_value_json = NULL;
    if (out_error) *out_error = NULL;
    if (out_variables_reference) *out_variables_reference = 0;
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
    /* Object results become expandable (hover/watch can drill in); the slot
     * dies with the next stop, like every other reference. */
    if (out_variables_reference)
        *out_variables_reference = var_slot_add(dbg, ctx, v);
    if (out_value_json)
        *out_value_json = debug_var_preview(ctx, v);
    JS_FreeValue(ctx, v);
    return 0;
}

#endif /* QZ_DEBUG_SUPPORT */
