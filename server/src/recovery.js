export const HEALTH_STATES = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  RECOVERING: "RECOVERING",
  SAFE_MODE: "SAFE_MODE"
});

export class HealthController {
  constructor({ enabled = true, cleanupExpired }) {
    this.enabled = enabled;
    this.cleanupExpired = cleanupExpired;
    this.state = HEALTH_STATES.HEALTHY;
    this.metrics = {
      requestFailures: 0,
      authenticationFailures: 0,
      serverErrors: 0,
      requestTimeouts: 0,
      recoveryAttempts: 0,
      recoverySuccesses: 0,
      recoveryFailures: 0
    };
    this.failureTimes = [];
    this.lastRecovery = null;
    this.codeRepairPending = false;
  }

  recordAuthenticationFailure() {
    this.metrics.authenticationFailures += 1;
  }

  recordRequestFailure() {
    this.metrics.requestFailures += 1;
    this.state = this.state === HEALTH_STATES.SAFE_MODE
      ? this.state
      : HEALTH_STATES.DEGRADED;
  }

  recordServerError() {
    this.metrics.serverErrors += 1;
    this.failureTimes.push(Date.now());
    this.failureTimes = this.failureTimes.filter(time => Date.now() - time < 60_000);
    if (this.failureTimes.length >= 5) this.state = HEALTH_STATES.SAFE_MODE;
    else this.state = HEALTH_STATES.DEGRADED;
  }

  recordTimeout() {
    this.metrics.requestTimeouts += 1;
    this.recordRequestFailure();
  }

  async recover(action) {
    if (!this.enabled) return { ok: false, error: "Automatic recovery is disabled." };
    if (this.state === HEALTH_STATES.SAFE_MODE) {
      return { ok: false, error: "Recovery is blocked while in safe mode." };
    }
    if (action !== "cleanup_expired") {
      return { ok: false, error: "Unknown recovery action." };
    }

    this.state = HEALTH_STATES.RECOVERING;
    this.metrics.recoveryAttempts += 1;
    try {
      const removed = await this.cleanupExpired();
      this.metrics.recoverySuccesses += 1;
      this.state = HEALTH_STATES.HEALTHY;
      this.lastRecovery = { action, ok: true, removed, at: new Date().toISOString() };
      return { ok: true, removed };
    } catch {
      this.metrics.recoveryFailures += 1;
      this.state = HEALTH_STATES.DEGRADED;
      this.lastRecovery = { action, ok: false, at: new Date().toISOString() };
      return { ok: false, error: "Recovery action failed." };
    }
  }

  status({ studioConnected, lastHeartbeat, pending, queued }) {
    return {
      state: this.state,
      studioConnected,
      lastHeartbeat,
      pending,
      queued,
      memoryUsageBytes: process.memoryUsage().heapUsed,
      metrics: { ...this.metrics },
      lastRecovery: this.lastRecovery,
      automaticRecoveryEnabled: this.enabled,
      safeMode: this.state === HEALTH_STATES.SAFE_MODE,
      codeRepairPending: this.codeRepairPending
    };
  }
}
