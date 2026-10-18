/** Veredicto de un intento contra el limitador. */
export interface LimiterVerdict {
  allowed: boolean;
  /** Segundos que faltan para que la ventana se reinicie (0 si pasa). */
  retryAfterSeconds: number;
}

/**
 * Limitador de ventana fija en memoria, pensado para frenar fuerza bruta en el
 * login. Suficiente con un solo proceso (la API y el worker viven juntos);
 * si algún día hay varias instancias, esto se muda a PostgreSQL.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(
    private readonly limit: number,
    windowMs = 60_000,
    maxKeys = 10_000,
  ) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Consume un intento con esta clave y dice si pasa. */
  hit(key: string, now = Date.now()): LimiterVerdict {
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1_000) };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Olvida los intentos de una clave (p. ej. tras un login correcto). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Poda barata cuando el mapa crece demasiado con ventanas ya vencidas. */
  private prune(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
