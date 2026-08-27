// @orchestral/patterns — first-party Pattern catalog.

// ── First-party Pattern factories ────────────────────────────────────────
export {
  TEXT_TO_IMAGE_PATTERN_ID,
  TextToImagePrimaryInputSchema,
  TextToImageOutputSchema,
  createTextToImagePattern,
  textToImage,
  type TextToImageInput,
  type TextToImageOutput,
  type ImageGenerationParams,
} from './atomic/text-to-image'

export {
  IMAGE_TO_IMAGE_PATTERN_ID,
  ImageToImagePrimaryInputSchema,
  ImageToImageOutputSchema,
  createImageToImagePattern,
  imageToImage,
  type ImageToImagePatternInit,
  type ImageToImageInput,
  type ImageToImageOutput,
} from './atomic/image-to-image'

export {
  IMAGE_TO_TEXT_PATTERN_ID,
  ImageToTextPrimaryInputSchema,
  ImageToTextOutputSchema,
  createImageToTextPattern,
  imageToText,
  type ImageToTextPatternInit,
  type ImageToTextInput,
  type ImageToTextOutput,
} from './atomic/image-to-text'

export {
  TEXT_TO_VIDEO_PATTERN_ID,
  TextToVideoPrimaryInputSchema,
  TextToVideoOutputSchema,
  createTextToVideoPattern,
  type TextToVideoPatternInit,
  type TextToVideoInput,
  type TextToVideoOutput,
} from './atomic/text-to-video'

export {
  IMAGE_TO_VIDEO_PATTERN_ID,
  ImageToVideoPrimaryInputSchema,
  ImageToVideoOutputSchema,
  createImageToVideoPattern,
  imageToVideo,
  type ImageToVideoPatternInit,
  type ImageToVideoInput,
  type ImageToVideoOutput,
} from './atomic/image-to-video'

export {
  VIDEO_TO_VIDEO_PATTERN_ID,
  VideoToVideoPrimaryInputSchema,
  VideoToVideoOutputSchema,
  createVideoToVideoPattern,
  type VideoToVideoPatternInit,
  type VideoToVideoInput,
  type VideoToVideoOutput,
} from './atomic/video-to-video'

export {
  TEXT_TO_SPEECH_PATTERN_ID,
  TextToSpeechPrimaryInputSchema,
  TextToSpeechOutputSchema,
  createTextToSpeechPattern,
  textToSpeech,
  type TextToSpeechPatternInit,
  type TextToSpeechInput,
  type TextToSpeechOutput,
} from './atomic/text-to-speech'

export {
  TEXT_TO_AUDIO_PATTERN_ID,
  TextToAudioPrimaryInputSchema,
  TextToAudioOutputSchema,
  createTextToAudioPattern,
  textToAudio,
  type TextToAudioPatternInit,
  type TextToAudioInput,
  type TextToAudioOutput,
} from './atomic/text-to-audio'

export {
  AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID,
  AutomaticSpeechRecognitionPrimaryInputSchema,
  AutomaticSpeechRecognitionOutputSchema,
  createAutomaticSpeechRecognitionPattern,
  automaticSpeechRecognition,
  type AutomaticSpeechRecognitionPatternInit,
  type AutomaticSpeechRecognitionInput,
  type AutomaticSpeechRecognitionOutput,
  type AsrTranscriptionParams,
} from './atomic/automatic-speech-recognition'

export {
  TEXT_GENERATION_PATTERN_ID,
  TextGenerationPrimaryInputSchema,
  TextGenerationOutputSchema,
  createTextGenerationPattern,
  textGeneration,
  type TextGenerationPatternInit,
  type TextGenerationInput,
  type TextGenerationOutput,
} from './atomic/text-generation'

export {
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  ImageToImageViaCaptionInputSchema,
  ImageToImageViaCaptionOutputSchema,
  createImageToImageViaCaptionPattern,
  type ImageToImageViaCaptionInput,
  type ImageToImageViaCaptionOutput,
} from './atomic/image-to-image-via-caption'

// ── First-party meta pipelines ───────────────────────────────────────────
// Agent-kind patterns are NOT here: they live in the optional @orchestral/agent
// package. This catalog is atomic + meta only.
export {
  SCRIPT2VIDEO_PATTERN_ID,
  ScriptToVideoInputSchema,
  ScriptToVideoOutputSchema,
  createScript2VideoMeta,
  script2videoMeta,
  CharacterInSceneSchema,
  type ScriptToVideoInput,
  type ScriptToVideoOutput,
  type ScriptToVideoMetaDeps,
  type ScriptToVideoPromptOverrides,
  type CharacterInScene,
} from './meta/script2video'

export {
  IMAGE_BEST_OF_N_PATTERN_ID,
  ImageBestOfNInputSchema,
  ImageBestOfNOutputSchema,
  createImageBestOfNMeta,
  imageBestOfNMeta,
  type ImageBestOfNInput,
  type ImageBestOfNOutput,
  type ImageBestOfNMetaInit,
  type ImageBestOfNPromptOverrides,
} from './meta/image-best-of-n'

export {
  STORYBOARD_PATTERN_ID,
  StoryboardInputSchema,
  StoryboardOutputSchema,
  ShotBriefSchema,
  PanelSchema,
  createStoryboardMeta,
  type StoryboardInput,
  type StoryboardOutput,
  type StoryboardMetaInit,
  type StoryboardPromptOverrides,
  type ShotBrief,
  type StoryboardPanel,
} from './meta/storyboard'

export {
  PRODUCT_AD_SHORT_PATTERN_ID,
  ProductAdShortInputSchema,
  ProductAdShortOutputSchema,
  createProductAdShortMeta,
  type ProductAdShortInput,
  type ProductAdShortOutput,
  type ProductAdShortMetaDeps,
  type ProductAdShortPromptOverrides,
} from './meta/product-ad-short'

export {
  PRODUCT_PHOTO_PACK_PATTERN_ID,
  ProductPhotoPackInputSchema,
  ProductPhotoPackOutputSchema,
  createProductPhotoPackMeta,
  type ProductPhotoPackInput,
  type ProductPhotoPackOutput,
  type ProductPhotoPackMetaInit,
  type ProductPhotoPackPromptOverrides,
} from './meta/product-photo-pack'

export {
  UGC_TESTIMONIAL_PATTERN_ID,
  UgcTestimonialInputSchema,
  UgcTestimonialOutputSchema,
  createUgcTestimonialMeta,
  type UgcTestimonialInput,
  type UgcTestimonialOutput,
  type UgcTestimonialMetaDeps,
  type UgcTestimonialPromptOverrides,
} from './meta/ugc-testimonial'

export {
  EXPLAINER_SHORT_PATTERN_ID,
  ExplainerShortInputSchema,
  ExplainerShortOutputSchema,
  createExplainerShortMeta,
  type ExplainerShortInput,
  type ExplainerShortOutput,
  type ExplainerShortMetaDeps,
  type ExplainerShortPromptOverrides,
} from './meta/explainer-short'

// ── The plan interpreter ─────────────────────────────────────────────────
// A meta whose compose is a list of steps rather than a function body. The
// contract half — the wire schema, the three ref regexes and `validatePlan` —
// is in @orchestral/core; this is the interpreter that walks it. `meta_plan` is
// the shipped one-shot (its input IS the DAG); `planToMeta` is what a
// session-scoped or persisted plan package calls on a JSON literal.
export {
  PLAN_PATTERN_ID,
  PLAN_TOOL_DESCRIPTION,
  createPlanMeta,
  planToMeta,
  runPlan,
  type PlanMetaPattern,
  type PlanToMetaOptions,
  type RunPlanOptions,
} from './meta/plan'

// ── The shipped id catalog ───────────────────────────────────────────────
// Which ids this package ships, as data, grouped by declared kind. For a
// consumer that needs the whole catalog (an agent's tool list, a host
// registering a subset) this is the one place to read it — the alternative is
// the hand-copied literal list @orchestral/agent used to carry, which drifted.
export { FIRST_PARTY_PATTERN_IDS } from './pattern-ids'

// ── Meta prompt-override defaults ─────────────────────────────────────────
// Each meta inlines its system prompts as module constants. These frozen
// `*_DEFAULT_PROMPTS` objects expose those defaults keyed by the same names a
// consumer passes to the factory's `prompts` override map — so a consumer can
// tweak tone / house style / localization for one step while spreading the
// rest of the defaults, without forking the package. The raw prompt constants
// stay internal — tests import them by relative path.
export { SCRIPT2VIDEO_DEFAULT_PROMPTS } from './meta/script2video'
export { STORYBOARD_DEFAULT_PROMPTS } from './meta/storyboard'
export { EXPLAINER_SHORT_DEFAULT_PROMPTS } from './meta/explainer-short'
export { UGC_TESTIMONIAL_DEFAULT_PROMPTS } from './meta/ugc-testimonial'
export { PRODUCT_AD_SHORT_DEFAULT_PROMPTS } from './meta/product-ad-short'
export { PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS } from './meta/product-photo-pack'
export { IMAGE_BEST_OF_N_DEFAULT_PROMPTS } from './meta/image-best-of-n'

// ── Shared meta authoring surface ────────────────────────────────────────
// The host-op contract every deliverable meta Picks from, plus every helper
// the shipped metas use in their compose(). This is the full set an author
// needs to copy one of the exemplar metas into their own package and have it
// compile against `@orchestral/patterns` alone — the exemplars import exactly
// these names, and examples/long-form-video is the proof: six metas and an
// agent that used to live in this repo's packages compile there against this
// barrel and nothing else. Exported so a consumer can also build one shared
// deps object typed against the full op set.
//
// Stability: these follow the package's 0.x policy (see CHANGELOG) — the
// signatures are settled and covered by the frozen public-surface snapshot,
// but a minor release may still break them before 1.0.
export {
  assetIdByLabel,
  firstAsset,
  firstAssetId,
  labelAsset,
  labelledAssetShape,
  parseJsonWithSchema,
  resolvePrompts,
  styleTag,
  sumCosts,
  toJsonSchemaCached,
  type LabelledAsset,
  type MetaCommonDeps,
} from './meta/_shared/meta-utils'
