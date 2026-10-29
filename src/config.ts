import { getConfig as loadConfig, type ConfigInput } from "./core/config.js";

/** Compatibility view for existing partial, mutable service settings; validation lives in core/config. */
export const getConfig: (root: string, env: NodeJS.ProcessEnv) => ConfigInput = loadConfig;

export { configValue, loadYaml, validateYaml, type ConfigInput as Config } from "./core/config.js";
