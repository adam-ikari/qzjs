/* bench_scin.c — scin.ts 的 C 参考实现（gcc -O2，全部 double，同算法同实参）。
 *
 * 编译：gcc -O2 -o /tmp/bench_scin bench_scin.c -lm
 * 输出格式与 bench_scin.js / bench_scin.py 一致：`name ms= X val= Y`
 *
 * RNG 必须与原实现逐位一致：seed 用 double 并按 `2147483648` 取模，
 * 因为 JS 的 `seed * 1103515245` 在 double 下已丢低位精度。
 * 用 uint64 整数版会得到不同随机序列，校验值偏离。
 *
 * 取模用 `x - floor(x / 2147483648.0) * 2147483648.0` 而非 `fmod(x, …)`：
 * 两者对正数逐位相同（实测 2e5 轮零差异），但 fmod 走 libm 调用（C 侧 mcpi
 * 因此慢 10×），而 AOT 的 `f64.rem` 是单条 wasm 指令、V8 的 `%` 也是内联。
 * 用 fmod 会让 C 列在 mcpi/mcpiNum 上严重失真。
 */
#include <stdio.h>
#include <time.h>
#include <math.h>
#include <stdlib.h>

#define REPEAT 3

/* 参数屏障：阻止 gcc 把整个函数体内联到调用点后**常量折叠**掉。
 * 不加时 matmul/matmulNum/integrate 的循环上界是字面常量，gcc -O2 会把整段
 * 循环算成编译期常量（实测 main 里只剩一条 mulsd 结果），C 列因此虚快 5-10×。
 * AOT 侧 `n` 是运行期实参，必须让 C 侧同样在运行期才可见。 */
#define KEEP_IMM(x) do { __asm__ __volatile__("" : "+r"(x)); } while (0)
#define KEEP_FP(x)  do { __asm__ __volatile__("" : "+x"(x)); } while (0)

/* 与 JS `%` / wasm f64.rem 对等的取模（正数下与 fmod 逐位相同，见文件头注释）。 */
static inline double MODRND(double x) {
    return x - floor(x / 2147483648.0) * 2147483648.0;
}

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static double integrate(long n) {
    KEEP_IMM(n);
    double h = 1.0 / (double)n;
    double s = 0.0;
    for (long i = 0; i <= n; i++) {
        double x = (double)i * h;
        double f = 4.0 / (1.0 + x * x);
        double w = (i == 0 || i == n) ? 1.0 : ((i % 2 == 1) ? 4.0 : 2.0);
        s = s + w * f;
    }
    return (s * h) / 3.0;
}

static double matmul(long n) {
    KEEP_IMM(n);
    long nn = n * n;
    double *A = malloc(sizeof(double) * (size_t)nn);
    double *B = malloc(sizeof(double) * (size_t)nn);
    double *C = malloc(sizeof(double) * (size_t)nn);
    for (long i = 0; i < nn; i++) {
        A[i] = (double)((i % 7) - 3);
        B[i] = (double)((i % 5) - 2);
        C[i] = 0.0;
    }
    for (long i = 0; i < n; i++) {
        for (long k = 0; k < n; k++) {
            double a = A[i * n + k];
            for (long j = 0; j < n; j++) {
                C[i * n + j] = C[i * n + j] + a * B[k * n + j];
            }
        }
    }
    double s = 0.0;
    for (long i = 0; i < nn; i++) s = s + C[i];
    free(A); free(B); free(C);
    return s;
}

static double nbody(long steps) {
    KEEP_IMM(steps);
    const int N = 32;
    double px[32], py[32], vx[32], vy[32], m[32];
    double seed = 12345.0;
    #define RND() (seed = MODRND(seed * 1103515245.0 + 12345.0), seed / 2147483648.0)
    for (int i = 0; i < N; i++) {
        px[i] = RND() * 2 - 1; py[i] = RND() * 2 - 1;
        vx[i] = 0.0; vy[i] = 0.0;
        m[i] = 0.5 + RND();
    }
    #undef RND
    double dt = 0.002, eps2 = 1e-6;
    for (long s = 0; s < steps; s++) {
        for (int i = 0; i < N; i++) {
            double ax = 0.0, ay = 0.0;
            for (int j = 0; j < N; j++) {
                if (i == j) continue;
                double dx = px[j] - px[i];
                double dy = py[j] - py[i];
                double r2 = dx * dx + dy * dy + eps2;
                double inv = m[j] / (r2 * sqrt(r2));
                ax = ax + dx * inv;
                ay = ay + dy * inv;
            }
            vx[i] = vx[i] + ax * dt;
            vy[i] = vy[i] + ay * dt;
        }
        for (int i = 0; i < N; i++) {
            px[i] = px[i] + vx[i] * dt;
            py[i] = py[i] + vy[i] * dt;
        }
    }
    double ke = 0.0;
    for (int i = 0; i < N; i++) ke = ke + 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
    return ke;
}

static long sieve(long limit) {
    KEEP_IMM(limit);
    char *c = malloc((size_t)limit + 1);
    for (long i = 0; i <= limit; i++) c[i] = 1;
    c[0] = 0; c[1] = 0;
    for (long i = 2; i * i <= limit; i++) {
        if (!c[i]) continue;
        for (long j = i * i; j <= limit; j += i) c[j] = 0;
    }
    long n = 0;
    for (long i = 2; i <= limit; i++) if (c[i]) n++;
    free(c);
    return n;
}

static double lorenz(long steps) {
    KEEP_IMM(steps);
    double x = 0.1, y = 0.0, z = 20.0;
    const double dt = 0.001, sigma = 10, rho = 28, beta = 8.0 / 3.0;
    for (long i = 0; i < steps; i++) {
        double dx1 = sigma * (y - x), dy1 = x * (rho - z) - y, dz1 = x * y - beta * z;
        double x2 = x + dx1 * dt / 2, y2 = y + dy1 * dt / 2, z2 = z + dz1 * dt / 2;
        double dx2 = sigma * (y2 - x2), dy2 = x2 * (rho - z2) - y2, dz2 = x2 * y2 - beta * z2;
        double x3 = x + dx2 * dt / 2, y3 = y + dy2 * dt / 2, z3 = z + dz2 * dt / 2;
        double dx3 = sigma * (y3 - x3), dy3 = x3 * (rho - z3) - y3, dz3 = x3 * y3 - beta * z3;
        double x4 = x + dx3 * dt, y4 = y + dy3 * dt, z4 = z + dz3 * dt;
        double dx4 = sigma * (y4 - x4), dy4 = x4 * (rho - z4) - y4, dz4 = x4 * y4 - beta * z4;
        x = x + (dx1 + 2 * dx2 + 2 * dx3 + dx4) * dt / 6;
        y = y + (dy1 + 2 * dy2 + 2 * dy3 + dy4) * dt / 6;
        z = z + (dz1 + 2 * dz2 + 2 * dz3 + dz4) * dt / 6;
    }
    return z;
}

static double mcpi(long n) {
    KEEP_IMM(n);
    double seed = 987654321.0;
    long inside = 0;
    for (long i = 0; i < n; i++) {
        seed = MODRND(seed * 1103515245.0 + 12345.0);
        double a = seed / 2147483648.0;
        seed = MODRND(seed * 1103515245.0 + 12345.0);
        double b = seed / 2147483648.0;
        if (a * a + b * b <= 1) inside++;
    }
    return (4.0 * (double)inside) / (double)n;
}

static double mandel(long w, long h) {
    double acc = 0;
    for (long py = 0; py < h; py++) {
        double ci = ((double)py / (double)h) * 2.4 - 1.2;
        for (long px = 0; px < w; px++) {
            double cr = ((double)px / (double)w) * 3.2 - 2.1;
            double zr = 0, zi = 0;
            long it = 0;
            while (it < 100 && zr * zr + zi * zi <= 4) {
                double t = zr * zr - zi * zi + cr;
                zi = 2 * zr * zi + ci;
                zr = t;
                it++;
            }
            acc = acc + (double)it;
        }
    }
    return acc;
}

static double nbodyNum(long steps) {
    KEEP_IMM(steps);
    double x = 0.5;
    for (long s = 0; s < steps; s++) {
        for (long i = 0; i < 64; i++) {
            for (long j = 0; j < 64; j++) {
                if (i == j) continue;
                double dx = (double)(i - j) * 0.01 + x * 0.0001;
                x = x + dx / (1 + dx * dx);
            }
        }
    }
    return x;
}

static double mcpiNum(long n) {
    KEEP_IMM(n);
    double seed = 987654321.0;
    long inside = 0;
    for (long i = 0; i < n; i++) {
        seed = MODRND(seed * 1103515245.0 + 12345.0);
        double a = seed / 2147483648.0;
        seed = MODRND(seed * 1103515245.0 + 12345.0);
        double b = seed / 2147483648.0;
        if (a * a + b * b <= 1) inside++;
    }
    return (4.0 * (double)inside) / (double)n;
}

static long sieveNum(long limit) {
    KEEP_IMM(limit);
    long n = 0;
    for (long i = 2; i <= limit; i++) {
        long isP = 1;
        for (long d = 2; d * d <= i; d++) if (i % d == 0) { isP = 0; break; }
        if (isP == 1) n++;
    }
    return n;
}

static double matmulNum(long n) {
    KEEP_IMM(n);
    double acc = 0;
    for (long i = 0; i < n; i++) {
        for (long k = 0; k < n; k++) {
            double a = (double)((i * 7 + k) % 11 - 5);
            for (long j = 0; j < n; j++) {
                double b = (double)((k * 5 + j) % 13 - 6);
                acc = acc + a * b * 0.000001;
            }
        }
    }
    return acc;
}

/* 名字 / 参数个数 / 实参 / 函数。num 版为标量对照，与 TS 的 `*Num` 同名。 */
typedef struct { const char *name; int argc; long a, b; int kind; } Case;

int main(void) {
    Case cases[] = {
        {"integrate", 1, 100000, 0, 0},
        {"matmul",    1,    120, 0, 1},
        {"nbody",     1,     60, 0, 2},
        {"sieve",     1, 200000, 0, 3},
        {"lorenz",    1,  20000, 0, 4},
        {"mcpi",      1, 500000, 0, 5},
        {"mandel",    2,    300, 200, 6},
        {"nbodyNum",  1,     60, 0, 7},
        {"mcpiNum",   1, 500000, 0, 8},
        {"sieveNum",  1,   3000, 0, 9},
        {"matmulNum", 1,    120, 0, 10},
    };
    int n = (int)(sizeof(cases) / sizeof(cases[0]));
    for (int ci = 0; ci < n; ci++) {
        Case c = cases[ci];
        double best = 1e300, val = 0;
        for (int r = 0; r < REPEAT; r++) {
            double t = now_ms();
            switch (c.kind) {
                case 0:  val = integrate(c.a); break;
                case 1:  val = matmul(c.a); break;
                case 2:  val = nbody(c.a); break;
                case 3:  val = (double)sieve(c.a); break;
                case 4:  val = lorenz(c.a); break;
                case 5:  val = mcpi(c.a); break;
                case 6:  val = mandel(c.a, c.b); break;
                case 7:  val = nbodyNum(c.a); break;
                case 8:  val = mcpiNum(c.a); break;
                case 9:  val = (double)sieveNum(c.a); break;
                case 10: val = matmulNum(c.a); break;
            }
            double d = now_ms() - t;
            if (d < best) best = d;
        }
        /* 整数结果不带小数（与 JS 的 typeof val === "number" 分支一致：仍打印小数形式，
         * 但 sieve/sieveNum 在 JS 侧是 number 整数 → toFixed(6)。这里统一 %.6f。 */
        printf("%s ms= %.2f val= %.6f\n", c.name, best, val);
    }
    return 0;
}
