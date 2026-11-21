#!/usr/bin/env python3
"""bench_scin.py — scin.ts 的 CPython 参考实现（同算法、同实参、同校验值）。

只做三件事：相同算法、相同浮点语义（全程 double，JS/Python/C 都是 IEEE-754 binary64）、
相同输出格式（`name ms= X val= Y`，与 bench_scin.js 的 parse() 对齐）。

注意 `seed` 必须走 float：JS 的 `seed * 1103515245` 在 float64 下已丢精度，
若用 Python int（任意精度）会算出不同序列，校验值随之偏离。
"""
import sys
import time

REPEAT = 3


# ── 自然写法（对应 scin.ts 前 7 个） ──────────────────────────────────────

def integrate(n):
    h = 1.0 / n
    s = 0.0
    for i in range(n + 1):
        x = i * h
        f = 4.0 / (1.0 + x * x)
        w = 1 if (i == 0 or i == n) else (4 if i % 2 == 1 else 2)
        s = s + w * f
    return (s * h) / 3.0


def matmul(n):
    A = []
    B = []
    C = []
    for i in range(n * n):
        A.append((i % 7) - 3)
        B.append((i % 5) - 2)
        C.append(0.0)
    for i in range(n):
        for k in range(n):
            a = A[i * n + k]
            for j in range(n):
                C[i * n + j] = C[i * n + j] + a * B[k * n + j]
    s = 0.0
    for i in range(n * n):
        s = s + C[i]
    return s


def nbody(steps):
    N = 32
    px = []; py = []; vx = []; vy = []; m = []
    seed = 12345.0

    def rnd():
        nonlocal seed
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0
        return seed / 2147483648.0

    for _ in range(N):
        px.append(rnd() * 2 - 1); py.append(rnd() * 2 - 1)
        vx.append(0.0); vy.append(0.0)
        m.append(0.5 + rnd())
    dt = 0.002
    eps2 = 1e-6
    for _s in range(steps):
        for i in range(N):
            ax = 0.0; ay = 0.0
            for j in range(N):
                if i == j:
                    continue
                dx = px[j] - px[i]
                dy = py[j] - py[i]
                r2 = dx * dx + dy * dy + eps2
                inv = m[j] / (r2 * (r2 ** 0.5))
                ax = ax + dx * inv
                ay = ay + dy * inv
            vx[i] = vx[i] + ax * dt
            vy[i] = vy[i] + ay * dt
        for i in range(N):
            px[i] = px[i] + vx[i] * dt
            py[i] = py[i] + vy[i] * dt
    ke = 0.0
    for i in range(N):
        ke = ke + 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i])
    return ke


def sieve(limit):
    c = [True] * (limit + 1)
    c[0] = False
    c[1] = False
    i = 2
    while i * i <= limit:
        if c[i]:
            j = i * i
            while j <= limit:
                c[j] = False
                j = j + i
        i += 1
    n = 0
    for i in range(2, limit + 1):
        if c[i]:
            n += 1
    return n


def lorenz(steps):
    x = 0.1; y = 0.0; z = 20.0
    dt = 0.001
    sigma = 10.0; rho = 28.0; beta = 8.0 / 3.0
    for _ in range(steps):
        dx1 = sigma * (y - x); dy1 = x * (rho - z) - y; dz1 = x * y - beta * z
        x2 = x + dx1 * dt / 2; y2 = y + dy1 * dt / 2; z2 = z + dz1 * dt / 2
        dx2 = sigma * (y2 - x2); dy2 = x2 * (rho - z2) - y2; dz2 = x2 * y2 - beta * z2
        x3 = x + dx2 * dt / 2; y3 = y + dy2 * dt / 2; z3 = z + dz2 * dt / 2
        dx3 = sigma * (y3 - x3); dy3 = x3 * (rho - z3) - y3; dz3 = x3 * y3 - beta * z3
        x4 = x + dx3 * dt; y4 = y + dy3 * dt; z4 = z + dz3 * dt
        dx4 = sigma * (y4 - x4); dy4 = x4 * (rho - z4) - y4; dz4 = x4 * y4 - beta * z4
        x = x + (dx1 + 2 * dx2 + 2 * dx3 + dx4) * dt / 6
        y = y + (dy1 + 2 * dy2 + 2 * dy3 + dy4) * dt / 6
        z = z + (dz1 + 2 * dz2 + 2 * dz3 + dz4) * dt / 6
    return z


def mcpi(n):
    seed = 987654321.0
    inside = 0
    for _ in range(n):
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0
        a = seed / 2147483648.0
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0
        b = seed / 2147483648.0
        if a * a + b * b <= 1:
            inside += 1
    return (4 * inside) / n


def mandel(w, h):
    acc = 0
    for py in range(h):
        ci = (py / h) * 2.4 - 1.2
        for px in range(w):
            cr = (px / w) * 3.2 - 2.1
            zr = 0.0; zi = 0.0; it = 0
            while it < 100 and zr * zr + zi * zi <= 4:
                t = zr * zr - zi * zi + cr
                zi = 2 * zr * zi + ci
                zr = t
                it += 1
            acc = acc + it
    return acc


# ── num 快路径版（标量对照） ──────────────────────────────────────────────

def nbodyNum(steps):
    x = 0.5
    for _s in range(steps):
        for i in range(64):
            for j in range(64):
                if i == j:
                    continue
                dx = (i - j) * 0.01 + x * 0.0001
                x = x + dx / (1 + dx * dx)
    return x


def mcpiNum(n):
    seed = 987654321.0
    inside = 0
    for _ in range(n):
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0
        a = seed / 2147483648.0
        seed = (seed * 1103515245.0 + 12345.0) % 2147483648.0
        b = seed / 2147483648.0
        if a * a + b * b <= 1:
            inside += 1
    return (4 * inside) / n


def sieveNum(limit):
    n = 0
    for i in range(2, limit + 1):
        isP = 1
        d = 2
        while d * d <= i:
            if i % d == 0:
                isP = 0
                break
            d += 1
        if isP == 1:
            n += 1
    return n


def matmulNum(n):
    acc = 0.0
    for i in range(n):
        for k in range(n):
            a = (i * 7 + k) % 11 - 5
            for j in range(n):
                b = (k * 5 + j) % 13 - 6
                acc = acc + a * b * 0.000001
    return acc


CASES = [
    ("integrate", (100000,), integrate),
    ("matmul", (120,), matmul),
    ("nbody", (60,), nbody),
    ("sieve", (200000,), sieve),
    ("lorenz", (20000,), lorenz),
    ("mcpi", (500000,), mcpi),
    ("mandel", (300, 200), mandel),
    ("nbodyNum", (60,), nbodyNum),
    ("mcpiNum", (500000,), mcpiNum),
    ("sieveNum", (3000,), sieveNum),
    ("matmulNum", (120,), matmulNum),
]


def main():
    for name, args, fn in CASES:
        best = float("inf")
        val = None
        for _ in range(REPEAT):
            t = time.perf_counter()
            val = fn(*args)
            d = (time.perf_counter() - t) * 1000.0
            if d < best:
                best = d
        shown = f"{val:.6f}" if isinstance(val, float) else str(val)
        print(f"{name} ms= {best:.2f} val= {shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
