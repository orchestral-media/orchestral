// Naming follows HuggingFace task taxonomy for ecosystem familiarity.
// Zero runtime dependency on HuggingFace — no @huggingface/tasks, no HF token needed.

export type Capability =
  // text
  | 'text-generation'
  | 'summarization'
  | 'translation'
  // image
  | 'text-to-image'
  | 'image-to-image'
  | 'image-to-text'
  | 'image-segmentation'
  // video
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video'
  // audio
  | 'text-to-speech'
  | 'automatic-speech-recognition'
  | 'text-to-audio'
  | 'audio-to-audio'
  // embedding
  | 'embedding'
  // NOTE: the HF taxonomy splits `image-to-text` (caption / OCR) from
  // `image-text-to-text` (modern VLM image+text → text). This union folds both
  // onto `image-to-text` because provider APIs expose one shape for them
  // (image[] + text → text). Routing between caption-only and multimodal
  // models is a ModelTag / providerOptions concern, not a new capability.
  // host extension — literal members still autocomplete
  | (string & {})
