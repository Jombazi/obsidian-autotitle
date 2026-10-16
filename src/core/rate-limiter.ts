/**
 * RateLimiter
 *
 * Unified rate limiting system supporting both per-key and global rate limits.
 */

export interface RateLimitConfig {
  windowMs: number;
  maxOperations: number;
  /** Read at each refusal, so a debug toggle applies without rebuilding the limiter; refusals are logged only while it returns true */
  isDebugEnabled?: () => boolean;
}

interface TrackerData {
  timestamp: number;
  count: number;
}

export class RateLimiter {
  private windowMs: number;
  private maxOperations: number;
  private isDebugEnabled: () => boolean;

  // For per-key tracking (e.g., per-file rate limiting)
  private tracker = new Map<string, TrackerData>();

  /** When `tracker` was last swept for expired entries */
  private lastSweep = Date.now();

  // For global tracking (all operations combined)
  private globalTracker: TrackerData = { timestamp: Date.now(), count: 0 };

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxOperations = config.maxOperations;
    this.isDebugEnabled = config.isDebugEnabled ?? (() => false);
  }

  /**
   * Check rate limit for a specific key (e.g., file path)
   * Returns true if operation is allowed, false if rate limit exceeded
   */
  checkLimit(key: string, label?: string): boolean {
    const now = Date.now();
    // At most one sweep per window keeps the map to keys active in the last window, at a cost bounded by those keys; without it every path ever processed, one per intermediate name while a title is typed, stays for the session.
    if (now - this.lastSweep > this.windowMs) {
      this.purgeExpired(now);
    }
    const data = this.tracker.get(key);

    // Window expired or first operation for this key - reset and allow
    if (!data || now - data.timestamp > this.windowMs) {
      this.tracker.set(key, { timestamp: now, count: 1 });
      return true;
    }

    // Check if limit exceeded
    if (data.count >= this.maxOperations) {
      if (label && this.isDebugEnabled()) {
        console.debug(
          `Rate limit hit for ${label} - ${data.count} operations in ${now - data.timestamp}ms`
        );
      }
      return false;
    }

    // Increment counter and allow
    data.count++;
    return true;
  }

  /**
   * Check global rate limit (all operations combined)
   * Returns true if operation is allowed, false if rate limit exceeded
   */
  checkGlobalLimit(label?: string): boolean {
    const now = Date.now();

    // Window expired - reset and allow
    if (now - this.globalTracker.timestamp > this.windowMs) {
      this.globalTracker = { timestamp: now, count: 1 };
      return true;
    }

    // Check if limit exceeded
    if (this.globalTracker.count >= this.maxOperations) {
      if (label && this.isDebugEnabled()) {
        console.debug(
          `Global rate limit hit - ${this.globalTracker.count} operations in ${now - this.globalTracker.timestamp}ms`
        );
      }
      return false;
    }

    // Increment counter and allow
    this.globalTracker.count++;
    return true;
  }

  /**
   * Drop every per-key entry whose window has expired; an expired entry allows the next operation anyway, so dropping it changes no verdict
   * @param now - Current time in milliseconds
   */
  purgeExpired(now: number = Date.now()): void {
    for (const [key, data] of this.tracker) {
      if (now - data.timestamp > this.windowMs) {
        this.tracker.delete(key);
      }
    }
    this.lastSweep = now;
  }

  /**
   * Clear tracking data for a specific key (e.g., when file is deleted)
   */
  clearKey(key: string): void {
    this.tracker.delete(key);
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    this.tracker.clear();
    this.globalTracker = { timestamp: Date.now(), count: 0 };
  }
}
