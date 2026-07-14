/**
 * Domain/UI types layered on top of the wire DTOs. Wire shapes live in `./api`.
 * Engine, state-machine, and capability types are added by their slices (FE §4/§7).
 */
export type { ReviewMode, Rating, ReasonTag, UiLanguage, Timing } from './api';

/** WebGPU capability classification (FE §4.3). */
export type CapabilityStatus =
  | 'ok'
  | 'needs_https'
  | 'no_webgpu'
  | 'no_adapter'
  | 'device_init_failed'
  | 'oom';
