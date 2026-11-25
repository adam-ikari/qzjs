/* wasm2c harness — 无 wasm 运行时设备的交付形态：wasm → C → gcc -O3 → native.
 * 由 bench/aot-product/run_wasm2c.mjs 填充 TOKEN。 */
#include <stdio.h>
#include <time.h>
#include <stdint.h>
#include <math.h>
#include "%HDR%"

%IMPORT%
%TAILCALL%

static double now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1.0e6;
}
static double p50(double (*fn)(%TYPE%*, f64), %TYPE% *inst, f64 arg, int reps) {
  double ts[16]; int r, i;
  fn(inst, arg);
  for (r = 0; r < reps; r++) { double t0 = now_ms(); fn(inst, arg); ts[r] = now_ms() - t0; }
  for (r = 0; r < reps; r++) for (i = r + 1; i < reps; i++)
    if (ts[i] < ts[r]) { double x = ts[r]; ts[r] = ts[i]; ts[i] = x; }
  return ts[reps / 2];
}
int main(void) {
  wasm_rt_init();
  %TYPE% inst;
  %INIT%(&inst, NULL);
  printf("RESULT {");
  %ROWS%
  printf("}\n");
  %FREE%(&inst);
  wasm_rt_free();
  return 0;
}
