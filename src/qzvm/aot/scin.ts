// 科学计算负载（纯数值 / num 快路径优先）。每个函数独立可测，返回数值校验和。
// 全部只依赖 + - * / % 与 sqrt/abs/floor，避免依赖 Math 扩展（AOT 支持面有限）。

// 1. 数值积分：复合 Simpson 法则求 ∫₀¹ 4/(1+x²) dx = π
function integrate(n: number): number {
  const h = 1.0 / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const x = i * h;
    const f = 4.0 / (1.0 + x * x);
    // Simpson 权重：端点 1，奇数 4，偶数 2
    const w = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    s = s + w * f;
  }
  return (s * h) / 3.0;
}

// 2. 矩阵乘法（N×N 方阵，行主序一维数组）：A·B
function matmul(n: number): number {
  const A: number[] = [];
  const B: number[] = [];
  const C: number[] = [];
  for (let i = 0; i < n * n; i++) {
    A.push((i % 7) - 3);
    B.push((i % 5) - 2);
    C.push(0);
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      for (let j = 0; j < n; j++) {
        C[i * n + j] = C[i * n + j] + a * B[k * n + j];
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < n * n; i++) sum = sum + C[i];
  return sum;
}

// 3. N 体引力（2D，速度 Verlet 积分）：返回总能量
function nbody(steps: number): number {
  const N = 32;
  const px: number[] = []; const py: number[] = [];
  const vx: number[] = []; const vy: number[] = [];
  const m: number[] = [];
  let seed = 12345;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < N; i++) {
    px.push(rnd() * 2 - 1); py.push(rnd() * 2 - 1);
    vx.push(0); vy.push(0);
    m.push(0.5 + rnd());
  }
  const dt = 0.002;
  const eps2 = 1e-6;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < N; i++) {
      let ax = 0; let ay = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const r2 = dx * dx + dy * dy + eps2;
        const inv = m[j] / (r2 * Math.sqrt(r2));
        ax = ax + dx * inv;
        ay = ay + dy * inv;
      }
      vx[i] = vx[i] + ax * dt;
      vy[i] = vy[i] + ay * dt;
    }
    for (let i = 0; i < N; i++) {
      px[i] = px[i] + vx[i] * dt;
      py[i] = py[i] + vy[i] * dt;
    }
  }
  let ke = 0;
  for (let i = 0; i < N; i++) ke = ke + 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
  return ke;
}

// 4. 素数筛（Eratosthenes）：limit 内素数个数
function sieve(limit: number): number {
  const c: boolean[] = [];
  for (let i = 0; i <= limit; i++) c.push(true);
  c[0] = false; c[1] = false;
  for (let i = 2; i * i <= limit; i++) {
    if (!c[i]) continue;
    for (let j = i * i; j <= limit; j = j + i) c[j] = false;
  }
  let n = 0;
  for (let i = 2; i <= limit; i++) if (c[i]) n++;
  return n;
}

// 5. ODE：四阶 Runge-Kutta 解 Lorenz 方程，返回末态 z
function lorenz(steps: number): number {
  let x = 0.1; let y = 0; let z = 20;
  const dt = 0.001;
  const sigma = 10; const rho = 28; const beta = 8 / 3;
  for (let i = 0; i < steps; i++) {
    const dx1 = sigma * (y - x), dy1 = x * (rho - z) - y, dz1 = x * y - beta * z;
    const x2 = x + dx1 * dt / 2, y2 = y + dy1 * dt / 2, z2 = z + dz1 * dt / 2;
    const dx2 = sigma * (y2 - x2), dy2 = x2 * (rho - z2) - y2, dz2 = x2 * y2 - beta * z2;
    const x3 = x + dx2 * dt / 2, y3 = y + dy2 * dt / 2, z3 = z + dz2 * dt / 2;
    const dx3 = sigma * (y3 - x3), dy3 = x3 * (rho - z3) - y3, dz3 = x3 * y3 - beta * z3;
    const x4 = x + dx3 * dt, y4 = y + dy3 * dt, z4 = z + dz3 * dt;
    const dx4 = sigma * (y4 - x4), dy4 = x4 * (rho - z4) - y4, dz4 = x4 * y4 - beta * z4;
    x = x + (dx1 + 2 * dx2 + 2 * dx3 + dx4) * dt / 6;
    y = y + (dy1 + 2 * dy2 + 2 * dy3 + dy4) * dt / 6;
    z = z + (dz1 + 2 * dz2 + 2 * dz3 + dz4) * dt / 6;
  }
  return z;
}

// 6. 蒙特卡洛 π（线性同余伪随机，避免 Math.random 不确定性）
function mcpi(n: number): number {
  let seed = 987654321;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd(); const y = rnd();
    if (x * x + y * y <= 1) inside++;
  }
  return (4 * inside) / n;
}

// 7. 分形：Mandelbrot 逃逸计数（复数迭代）
function mandel(w: number, h: number): number {
  let acc = 0;
  for (let py = 0; py < h; py++) {
    const ci = (py / h) * 2.4 - 1.2;
    for (let px = 0; px < w; px++) {
      const cr = (px / w) * 3.2 - 2.1;
      let zr = 0; let zi = 0; let it = 0;
      while (it < 100 && zr * zr + zi * zi <= 4) {
        const t = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci;
        zr = t;
        it++;
      }
      acc = acc + it;
    }
  }
  return acc;
}

// ───────── num 快路径版（无数组/无属性访问 → 编成 f64 直算，不落 tagged） ─────────
// 上面 7 个负载里 matmul/nbody/sieve/mcpi 因用局部数组或箭头函数被判 tagged，
// AOT 比解释器慢数十倍。以下同算法去掉数组依赖，保持 num 模式，用于验证
// AOT 的真实数值吞吐上限。sieveNum 改用试除法（位图需数组）；matmulNum 用
// 张量积和式（与原矩阵乘同类浮点密集度，结果不相等，仅供性能对照）。

export function nbodyNum(steps: number): number {
  let x = 0.5;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        if (i === j) continue;
        const dx = (i - j) * 0.01 + x * 0.0001;
        x = x + dx / (1 + dx * dx);
      }
    }
  }
  return x;
}

export function mcpiNum(n: number): number {
  let seed = 987654321;
  let inside = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const a = seed / 2147483648;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const b = seed / 2147483648;
    if (a * a + b * b <= 1) inside++;
  }
  return (4 * inside) / n;
}

export function sieveNum(limit: number): number {
  let n = 0;
  for (let i = 2; i <= limit; i++) {
    let isP = 1;
    for (let d = 2; d * d <= i; d++) if (i % d === 0) { isP = 0; break; }
    if (isP === 1) n++;
  }
  return n;
}

export function matmulNum(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = (i * 7 + k) % 11 - 5;
      for (let j = 0; j < n; j++) {
        const b = (k * 5 + j) % 13 - 6;
        acc = acc + a * b * 0.000001;
      }
    }
  }
  return acc;
}
