import { getConfig as loadConfig, type ConfigInput } from "./core/config.js";

/** Load strict service settings; schema validation and environment overrides live in core/config. */
export const getConfig: (root: string, env: NodeJS.ProcessEnv) => ConfigInput = loadConfig;

export { configValue, loadYaml, validateYaml, type ConfigInput as Config } from "./core/config.js";
