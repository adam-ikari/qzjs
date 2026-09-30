/*
 * qzjs — DAP (Debug Adapter Protocol) front-end
 *
 * PAL-agnostic, lives in libqzjs. Provides the DAP callback set that
 * qz_create installs when debugging is enabled (config field or QZ_DEBUG
 * env var). Speaks DAP base protocol over stdio so VS Code can attach.
 *
 * The host does NOT call a "serve" entry point: qz_create auto-attaches
 * this layer when debug is enabled, and the DAP stdin request loop runs
 * inside the on_stopped callback when a pause occurs.
 *
 * Compiled in only when QZ_BUILD_DEBUGGER=ON (QZ_DEBUG_SUPPORT).
 */
#ifndef QZ_DEBUG_DAP_H
#define QZ_DEBUG_DAP_H

#include <qzjs/qzjs.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef QZ_DEBUG_SUPPORT

typedef struct qz_dap_config {
    int  stop_on_entry;   /* default 1 (attach semantics: pause at entry) */
    FILE *in;             /* default stdin if NULL */
    FILE *out;            /* default stdout if NULL */
} qz_dap_config_t;

/* Attach the DAP protocol layer to a runtime. Called by qz_create when
 * debug is enabled (config.debug enable-bit or QZ_DEBUG env var); may also
 * be called directly by a host that wants DAP without the auto path.
 * Installs qz_debug_attach with the DAP callback set, sends the DAP
 * "initialized" event, and sets up entry-pause per stop_on_entry. Returns 0
 * on success, non-zero on error. Non-blocking — the DAP stdin request loop
 * runs later inside on_stopped when JS pauses. */
int qz_dap_attach(qz_t *rt, const qz_dap_config_t *cfg);

/* Detach the DAP layer (counterpart to qz_dap_attach). */
void qz_dap_detach(qz_t *rt);

/* Process the DAP configuration phase (initialize / setBreakpoints / attach /
 * configurationDone) before the program starts running. Called by the host
 * after qz_dap_attach. Returns 0 when configurationDone is received, 1 if
 * the client disconnected, -1 on EOF/error. After 0, the host evals/runs its
 * program; breakpoints are armed and the on_stopped request loop takes
 * over. */
int qz_dap_configure(qz_t *rt);

#endif /* QZ_DEBUG_SUPPORT */

#ifdef __cplusplus
}
#endif
#endif /* QZ_DEBUG_DAP_H */
