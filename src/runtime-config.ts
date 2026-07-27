import type { PreferenceKey } from "./config.js";
import type { WandConfig } from "./types.js";

export const DEPLOYMENT_CONFIG_KEYS = ["host", "port", "https", "shell"] as const satisfies readonly (keyof WandConfig)[];
export type DeploymentConfigKey = (typeof DEPLOYMENT_CONFIG_KEYS)[number];

function cloneConfig(config: WandConfig): WandConfig {
  return structuredClone(config);
}

/** Keeps the active process configuration separate from values persisted for the next restart. */
export class RuntimeConfigState {
  private desiredConfig: WandConfig;

  constructor(readonly activeConfig: WandConfig) {
    this.desiredConfig = cloneConfig(activeConfig);
  }

  desiredSnapshot(): WandConfig {
    return cloneConfig(this.desiredConfig);
  }

  createCandidate(): WandConfig {
    return this.desiredSnapshot();
  }

  commit(candidate: WandConfig, hotPreferenceKeys: Iterable<PreferenceKey>): void {
    this.desiredConfig = cloneConfig(candidate);
    for (const key of hotPreferenceKeys) {
      (this.activeConfig as unknown as Record<string, unknown>)[key] = cloneConfigValue(candidate[key]);
    }
  }

  hasPendingRestart(candidate: WandConfig = this.desiredConfig): boolean {
    return DEPLOYMENT_CONFIG_KEYS.some((key) => candidate[key] !== this.activeConfig[key]);
  }

  activeDeployment(): Pick<WandConfig, DeploymentConfigKey> {
    return {
      host: this.activeConfig.host,
      port: this.activeConfig.port,
      https: this.activeConfig.https,
      shell: this.activeConfig.shell,
    };
  }

  desiredDeployment(candidate: WandConfig = this.desiredConfig): Pick<WandConfig, DeploymentConfigKey> {
    return {
      host: candidate.host,
      port: candidate.port,
      https: candidate.https,
      shell: candidate.shell,
    };
  }
}

function cloneConfigValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return structuredClone(value);
}
