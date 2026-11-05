export function sum(n: number): number { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }
export function greet(name: string): string { return "hi " + name; }
export function pick(a: number, b: number): number { return a > b ? a : b; }
export function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
export function arrSum(n: number): number { const a: number[] = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (const v of a) s += v; return s; }
