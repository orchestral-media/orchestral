// @orchestral/adapters-ai-sdk
//
// Vercel AI SDK model instance → `ModelCapability` envelope, one function per
// capability. A leaf: depends on `@orchestral/core` and `ai`; nothing in
// `@orchestral/*` depends on it.

export type { AdapterOptions } from './envelope'
export { fromImageModel, type ImageModelInstance } from './image'
export { fromSpeechModel, type SpeechModelInstance } from './speech'
export {
  fromTranscriptionModel,
  type AudioSource,
  type TranscriptionAdapterOptions,
  type TranscriptionModelInstance,
} from './transcription'
