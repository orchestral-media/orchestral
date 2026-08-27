// @orchestral/adapters-ai-sdk
//
// Vercel AI SDK model instance → `ModelCapability` envelope, one function per
// capability. A leaf: depends on `@orchestral/core` and `ai`; nothing in
// `@orchestral/*` depends on it.
// DESIGN: adapters-ai-sdk-leaf

export type { AdapterOptions } from './envelope'
export { fromImageModel, type ImageModelInstance } from './image'
export { fromLanguageModel, type LanguageModelInstance } from './language'
export { fromSpeechModel, type SpeechModelInstance } from './speech'
export {
  fromTranscriptionModel,
  type AudioSource,
  type TranscriptionAdapterOptions,
  type TranscriptionModelInstance,
} from './transcription'
export {
  fromVisionModel,
  type ImageSource,
  type VisionAdapterOptions,
} from './vision'
