/**
 * Pi 集成域：PiRuntimeAdapter（DEV212）。
 * 所有 Pi API 调用收敛于此，Gateway / Channel 不直接 import Pi SDK。
 */
export { PiRuntimeAdapter } from "./adapter";
export type { CreateRuntimeOptions, ResumeRuntimeOptions } from "./adapter";
