/*
 * qzjs — Debug core API (step debugger)
 *
 * PAL-agnostic. Provides breakpoint/step/pause and call-frame/local
 * introspection on top of the QuickJS-ng debugger engine patch
 * (deps/quickjs-ng-debugger.patch). The DAP protocol front-end
 * (qz_debug_dap.h) builds on this; hosts may also drive it directly.
 *
 * Compiled in only when QZ_BUILD_DEBUGGER=ON (which defines
 * QZ_DEBUG_SUPPORT). Otherwise this header's functions are absent.
 */
#ifndef QZ_DEBUG_H
#define QZ_DEBUG_H

#include <qzjs/qzjs.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef QZ_DEBUG_SUPPORT

/* Opaque debug session. */
typedef struct qz_debug qz_debug_t;

/* Callbacks the host registers. All are invoked from within the paused
 * interrupt handler (same thread as JS). */
typedef struct qz_debug_cbs {
    /* The session has stopped (breakpoint / step / pause / entry). The host
     * pumps its protocol until qz_debug_continue / step_* is called, at
     * which point this returns and JS resumes. reason is one of:
     *   "breakpoint", "step", "pause", "entry". */
    void (*on_stopped)(qz_debug_t *dbg, const char *reason, int thread_id);
    /* The debuggee finished (the JS eval that was being driven returned). */
    void (*on_terminated)(qz_debug_t *dbg);
    /* A console output line was produced by JS. Optional (may be NULL). */
    void (*on_output)(qz_debug_t *dbg, const char *category, const char *text);
} qz_debug_cbs;

/* Attach a debugger to an existing runtime. Installs the engine debugger
 * hooks + interrupt handler. Must be called before JS runs. Returns the
 * session handle or NULL on error. */
qz_debug_t *qz_debug_attach(qz_t *rt, const qz_debug_cbs *cbs);

/* Return the runtime a debug session is attached to. Lets callback
 * implementations (e.g. the DAP layer) reach their per-runtime state
 * without a process-wide global. */
qz_t *qz_debug_get_runtime(qz_debug_t *dbg);

/* Detach and free the session. JS resumes normally afterwards. */
void qz_debug_detach(qz_t *rt, qz_debug_t *dbg);

/* Breakpoint table. filename is matched against the filename atom used in
 * JS_Eval (the host must eval with the real source path). */
int  qz_debug_add_breakpoint(qz_debug_t *dbg, const char *filename,
                               int line, const char *condition);
int  qz_debug_remove_breakpoint(qz_debug_t *dbg, const char *filename, int line);
void qz_debug_clear_breakpoints(qz_debug_t *dbg);
/* Remove only the breakpoints registered for `filename`, keeping every other
 * file's breakpoints. DAP setBreakpoints is per-source: a request replaces
 * just the named source's breakpoints (qz_debug_clear_breakpoints would wipe
 * the other files too). */
void qz_debug_clear_breakpoints_in_file(qz_debug_t *dbg, const char *filename);

/* Flow control. Called by the host while inside on_stopped (i.e. from within
 * the paused interrupt handler). They set the step mode and return, causing
 * on_stopped to return, causing the interrupt handler to return 0, causing
 * JS to resume. */
void qz_debug_continue(qz_debug_t *dbg);
void qz_debug_pause(qz_debug_t *dbg);
void qz_debug_step_over(qz_debug_t *dbg);
void qz_debug_step_into(qz_debug_t *dbg);
void qz_debug_step_out(qz_debug_t *dbg);

/* Pause immediately at the next dispatch (used for "stop on entry"). */
void qz_debug_stop_on_entry(qz_debug_t *dbg);

typedef struct qz_debug_var {
    char *name;
    char *value_json;   /* JSON string of the value; NULL if unreadable. Caller frees. */
    char *type;         /* typeof string, or NULL. Caller frees. */
    int   variables_reference; /* 0 = leaf; >0 = expandable. */
    int   indexed_variables;
} qz_debug_var;

typedef struct qz_debug_frame {
    char *name;        /* function name */
    char *source_path; /* filename given to JS_Eval */
    int   line;
    int   column;
    int   id;          /* stable id for scopes/variables/evaluate */
} qz_debug_frame;

int  qz_debug_get_call_frames(qz_debug_t *dbg,
                                qz_debug_frame **out_frames, int *out_count);
void qz_debug_free_frames(qz_debug_frame *frames, int count);

typedef struct qz_debug_scope {
    char *name;        /* "Locals", "Arguments", "Global" */
    int   variables_reference;
    int   expensive;
} qz_debug_scope;

int  qz_debug_get_scopes(qz_debug_t *dbg, int frame_id,
                           qz_debug_scope **out_scopes, int *out_count);
void qz_debug_free_scopes(qz_debug_scope *scopes, int count);

int  qz_debug_get_variables(qz_debug_t *dbg, int variables_reference,
                              qz_debug_var **out_vars, int *out_count);
void qz_debug_free_vars(qz_debug_var *vars, int count);

int  qz_debug_evaluate(qz_debug_t *dbg, int frame_id,
                         const char *expression,
                         char **out_value_json, char **out_error);

#endif /* QZ_DEBUG_SUPPORT */

#ifdef __cplusplus
}
#endif
#endif /* QZ_DEBUG_H */
